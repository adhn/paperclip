import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildSshSpawnTarget, syncDirectoryToSsh, syncDirectoryFromSsh, withSshCommandJournal, type SshCommandPayload, type SshLaunchAuthorization } from "@paperclipai/adapter-utils/ssh";
import { protectedExecutionTransport, type ProtectedGateway } from "../services/protected-execution-transport.js";

const owner = { companyId: randomUUID(), attemptId: randomUUID(), token: randomUUID() };
const authorization: SshLaunchAuthorization = { fenceRoot: "/protected", binding: {
  epoch: randomUUID(), companyId: owner.companyId, agentId: randomUUID(), runId: randomUUID(), attemptId: randomUUID(),
  environmentId: randomUUID(), leaseId: randomUUID(), invocationId: randomUUID(),
} };
const claim = { id: "01234567-0123-0123-0123-0123456789ab", bindingHash: "a".repeat(64) };
const physical = { pool: "pool", uid: "pod-uid", container: "container-id", node: "node", storage: "storage-incarnation" };
const payload: SshCommandPayload = { command: "python3", args: ["-c", "print('body')"], env: { HOME: "/attempt" }, cwd: "/attempt" };
const spec = { host: "retired-host", port: 22, username: "untrusted", privateKey: null, knownHosts: null,
  strictHostKeyChecking: true, remoteWorkspacePath: "/attempt", remoteCwd: "/attempt" };
function fixture() {
  const events: string[] = [];
  let nonce = 0;
  const request = (op: string) => ({ body: { op, value: { storage: physical.storage, invocation: authorization.binding.invocationId }, nonce: "challenge-" + ++nonce, expires: 1 }, mac: "request-mac" });
  const journal = {
    prepareCommand: vi.fn(async () => { events.push("commit"); return { contract: { storage: physical.storage, invocation: authorization.binding.invocationId }, request: request("authorizeInvocation") }; }),
    acceptAck: vi.fn(async (reply: { body: Record<string, unknown>; mac: string }) => { events.push("verify-and-durable-pin"); return reply; }),
    commandPhysical: vi.fn(async () => physical),
    claimStdin: vi.fn(async () => { events.push("native-stdin-claim"); return claim; }),
    inspectCommand: vi.fn(async () => { events.push("inspect-commit"); return request("stopAndInspect"); }),
  };
  const gateway: ProtectedGateway = {
    executable: "/usr/libexec/paperclip-protected-gateway",
    exchange: vi.fn(async sent => {
      events.push("exchange");
      const stopping = sent.body.op === "stopAndInspect";
      return { body: { nonce: sent.body.nonce, pool: physical.pool, result: { status: stopping ? "stopped" : "started", physical,
        observation: stopping ? { status: "confirmed_stopped", physical, evidence: { independent: "fixture-runtime-only" } } : null } }, mac: "ack-mac" };
    }),
    verifyRetirement: vi.fn(async () => { events.push("independent-stable-retirement"); return "synthetic-retirement-proof"; }),
    attach: vi.fn(async () => { events.push("attach"); return { handle: "exact-stream-handle", cleanup: vi.fn(async () => {}) }; }),
  };
  const transport = protectedExecutionTransport({ journal: journal as unknown as Parameters<typeof protectedExecutionTransport>[0]["journal"], gateway });
  return { transport, journal, gateway, events };
}

describe("inactive protected command transport", () => {
  it("commits journal and authenticates durable pin before fixed-target attach", async () => {
    const f = fixture(), stopped = vi.fn(async () => {});
    const target = await f.transport.spawn(owner, authorization, payload, stopped);
    expect(f.events).toEqual(["commit", "exchange", "verify-and-durable-pin", "native-stdin-claim", "attach"]);
    expect(f.journal.prepareCommand).toHaveBeenCalledWith(owner, authorization.binding.attemptId, payload);
    expect(target.command).toBe(f.gateway.executable);
    expect(target.args).toEqual(["attach", "exact-stream-handle"]);
    expect(JSON.stringify(target.args)).not.toContain("print('body')");
    await target.stopRemote();
    expect(stopped).toHaveBeenCalledOnce();
    expect(f.journal.inspectCommand).toHaveBeenCalledWith(authorization.binding.attemptId, true);
    expect(f.events.at(-1)).toBe("independent-stable-retirement");
  });
  it("rejects a mismatched journal invocation before irreversible exchange", async () => {
    const f = fixture();
    f.journal.prepareCommand.mockResolvedValue({ contract: { storage: physical.storage, invocation: "wrong" },
      request: { body: { op: "authorizeInvocation", value: { storage: physical.storage, invocation: "wrong" }, nonce: "n", expires: 1 }, mac: "m" } });
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow("invocation_identity_mismatch");
    expect(f.gateway.exchange).not.toHaveBeenCalled();
    expect(f.gateway.attach).not.toHaveBeenCalled();
  });
  it("restart recovers only an inspected retained incarnation with exclusive stdin ownership", async () => {
    const f = fixture();
    f.journal.inspectCommand.mockImplementation(async () => ({ body: { op: "inspect", value: {
      storage: physical.storage, invocation: authorization.binding.invocationId }, nonce: "inspection", expires: 1 }, mac: "m" }));
    vi.mocked(f.gateway.exchange).mockImplementation(async sent => ({ body: { nonce: sent.body.nonce, pool: physical.pool,
      result: { status: "started", physical, observation: { status: "running", physical, evidence: {} } } }, mac: "m" }));
    const target = await f.transport.recover(owner, authorization.binding.attemptId, async () => {});
    expect(target.sshInvocationId).toBe(authorization.binding.invocationId);
    expect(f.journal.inspectCommand).toHaveBeenCalledWith(authorization.binding.attemptId, false);
    expect(f.journal.prepareCommand).not.toHaveBeenCalled();
    expect(f.gateway.attach).toHaveBeenCalledWith({ commandId: authorization.binding.attemptId,
      invocation: authorization.binding.invocationId, physical, stdin: "exclusive", claim });
  });
  it("recovery cannot learn a missing retained identity from the new ACK", async () => {
    const f = fixture();
    f.journal.commandPhysical.mockResolvedValue(null as never);
    await expect(f.transport.recover(owner, authorization.binding.attemptId, async () => {})).rejects.toThrow("physical_binding_missing");
    expect(f.gateway.exchange).not.toHaveBeenCalled();
    expect(f.gateway.attach).not.toHaveBeenCalled();
  });
  it.each(["uncertain", "stopped", "consumed", "stop_requested"])("restart %s is held without reauthorization", async status => {
    const f = fixture();
    f.journal.inspectCommand.mockImplementation(async () => ({ body: { op: "inspect", value: {
      storage: physical.storage, invocation: authorization.binding.invocationId }, nonce: "inspection", expires: 1 }, mac: "m" }));
    vi.mocked(f.gateway.exchange).mockImplementation(async sent => ({ body: { nonce: sent.body.nonce, pool: physical.pool,
      result: { status, physical, observation: { status: "running", physical, evidence: {} } } }, mac: "m" }));
    await expect(f.transport.recover(owner, authorization.binding.attemptId, async () => {})).rejects.toThrow("incarnation_unverified");
    expect(f.journal.prepareCommand).not.toHaveBeenCalled();
    expect(f.gateway.attach).not.toHaveBeenCalled();
  });
  it.each(["replacement", "stale-observation"])("restart rejects %s evidence", async mode => {
    const f = fixture();
    f.journal.inspectCommand.mockImplementation(async () => ({ body: { op: "inspect", value: {
      storage: physical.storage, invocation: authorization.binding.invocationId }, nonce: "inspection", expires: 1 }, mac: "m" }));
    const observed = mode === "replacement" ? { ...physical, container: "replacement-container" } : physical;
    vi.mocked(f.gateway.exchange).mockImplementation(async sent => ({ body: { nonce: sent.body.nonce, pool: physical.pool,
      result: { status: "started", physical: observed, observation: { status: "uncertain", physical: observed, evidence: {} } } }, mac: "m" }));
    await expect(f.transport.recover(owner, authorization.binding.attemptId, async () => {})).rejects.toThrow(mode === "replacement" ? "incarnation_unverified" : "current_observation_missing");
    expect(f.gateway.attach).not.toHaveBeenCalled();
  });
  it.each(["missing-binding", "replacement", "missing-observation"])("repeated spawn holds %s through the same recovery fence", async mode => {
    const f = fixture();
    f.journal.prepareCommand.mockResolvedValue({ contract: { storage: physical.storage, invocation: authorization.binding.invocationId },
      request: { body: { op: "inspect", value: { storage: physical.storage, invocation: authorization.binding.invocationId }, nonce: "n", expires: 1 }, mac: "m" } });
    if (mode === "missing-binding") f.journal.commandPhysical.mockResolvedValue(null as never);
    const observed = mode === "replacement" ? { ...physical, uid: "replacement-pod" } : physical;
    vi.mocked(f.gateway.exchange).mockImplementation(async sent => ({ body: { nonce: sent.body.nonce, pool: physical.pool,
      result: { status: "started", physical: observed, observation: mode === "missing-observation" ? null : { status: "running", physical: observed } } }, mac: "m" }));
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow();
    expect(f.gateway.attach).not.toHaveBeenCalled();
    if (mode === "missing-binding") expect(f.gateway.exchange).not.toHaveBeenCalled();
    else expect(f.gateway.exchange).toHaveBeenCalledOnce();
  });
  it("snapshots invocation and owner before asynchronous exchange callbacks can mutate caller input", async () => {
    const f = fixture(), supplied = structuredClone(authorization), suppliedOwner = { ...owner };
    const exchange = vi.mocked(f.gateway.exchange).getMockImplementation()!;
    vi.mocked(f.gateway.exchange).mockImplementation(async request => {
      supplied.binding.invocationId = "caller-replaced-invocation";
      suppliedOwner.token = "caller-replaced-token";
      return exchange(request);
    });
    const target = await f.transport.spawn(suppliedOwner, supplied, payload, async () => {});
    expect(target.sshInvocationId).toBe(authorization.binding.invocationId);
    expect(f.journal.claimStdin).toHaveBeenCalledWith(expect.objectContaining({ owner,
      invocation: authorization.binding.invocationId }));
    expect(f.gateway.attach).toHaveBeenCalledWith(expect.objectContaining({ invocation: authorization.binding.invocationId }));
  });
  it("requires a committed native writer claim before gateway attach", async () => {
    const f = fixture();
    await f.transport.spawn(owner, authorization, payload, async () => {});
    expect(f.journal.claimStdin).toHaveBeenCalledWith({ owner, commandId: authorization.binding.attemptId,
      invocation: authorization.binding.invocationId, physical, ackNonce: "challenge-1" });
    expect(f.events.indexOf("native-stdin-claim")).toBeLessThan(f.events.indexOf("attach"));
  });
  it("missing native claim authority has no preparation, exchange or attach side effect", async () => {
    const f = fixture();
    delete (f.journal as Partial<typeof f.journal>).claimStdin;
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow("stdin_claim_authority_missing");
    await expect(f.transport.recover(owner, authorization.binding.attemptId, async () => {})).rejects.toThrow("stdin_claim_authority_missing");
    expect(f.journal.prepareCommand).not.toHaveBeenCalled();
    expect(f.gateway.exchange).not.toHaveBeenCalled();
    expect(f.gateway.attach).not.toHaveBeenCalled();
  });
  it.each(["already_claimed", "ownership", "ambiguous_commit"])("native writer claim %s never reaches gateway attach", async failure => {
    const f = fixture();
    f.journal.claimStdin.mockRejectedValue(Error(failure));
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow(failure);
    expect(f.gateway.attach).not.toHaveBeenCalled();
  });
  it.each([{ id: "bad", bindingHash: "a".repeat(64) }, { id: claim.id, bindingHash: "bad" }])("rejects invalid committed claim ticket", async invalid => {
    const f = fixture(); f.journal.claimStdin.mockResolvedValue(invalid);
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow("stdin_claim_invalid");
    expect(f.gateway.attach).not.toHaveBeenCalled();
  });
  it("lost attach response cannot make the native writer claim reusable", async () => {
    const f = fixture();
    f.journal.claimStdin.mockResolvedValueOnce(claim).mockRejectedValue(Error("already_claimed"));
    vi.mocked(f.gateway.attach).mockRejectedValue(Error("lost_attach_response"));
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow("lost_attach_response");
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow("already_claimed");
    expect(f.gateway.attach).toHaveBeenCalledOnce();
  });
  it("failed signature/pin never attaches or records stopped", async () => {
    const f = fixture(), stopped = vi.fn(async () => {});
    f.journal.acceptAck.mockRejectedValue(Error("bad_signature_or_pin"));
    await expect(f.transport.spawn(owner, authorization, payload, stopped)).rejects.toThrow("bad_signature_or_pin");
    expect(f.gateway.attach).not.toHaveBeenCalled();
    await expect(f.transport.stop(authorization.binding.attemptId, stopped)).rejects.toThrow("bad_signature_or_pin");
    expect(stopped).not.toHaveBeenCalled();
  });
  it("mismatched signed challenge cannot attach", async () => {
    const f = fixture();
    vi.mocked(f.gateway.exchange).mockResolvedValue({ body: { nonce: "other-challenge" }, mac: "signed-other-ack" });
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow("challenge_mismatch");
    expect(f.gateway.attach).not.toHaveBeenCalled();
    expect(f.journal.acceptAck).not.toHaveBeenCalled();
  });
  it("ambiguous launch response never authorizes twice or attaches", async () => {
    const f = fixture();
    vi.mocked(f.gateway.exchange).mockRejectedValue(Error("disconnect_after_consumption"));
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow("disconnect_after_consumption");
    expect(f.journal.prepareCommand).toHaveBeenCalledOnce();
    expect(f.gateway.exchange).toHaveBeenCalledOnce();
    expect(f.gateway.attach).not.toHaveBeenCalled();
  });
  it.each(["uncertain", "stop_requested", "consumed", "running"])("%s cannot become a native stop fact", async status => {
    const f = fixture(), stopped = vi.fn(async () => {});
    vi.mocked(f.gateway.exchange).mockImplementation(async sent => ({ body: { nonce: sent.body.nonce, pool: physical.pool,
      result: { status, physical, observation: null } }, mac: "signed" }));
    await expect(f.transport.stop(authorization.binding.attemptId, stopped)).rejects.toThrow("stop_unverified");
    expect(stopped).not.toHaveBeenCalled();
  });
  it("wrong whole-Pod incarnation cannot satisfy an already-attached stop", async () => {
    const f = fixture(), stopped = vi.fn(async () => {});
    const target = await f.transport.spawn(owner, authorization, payload, stopped);
    const wrong = { ...physical, uid: "sibling-pod" };
    vi.mocked(f.gateway.exchange).mockImplementation(async sent => ({ body: { nonce: sent.body.nonce, pool: physical.pool,
      result: { status: "stopped", physical: wrong, observation: { status: "confirmed_stopped", physical: wrong, evidence: {} } } }, mac: "signed" }));
    await expect(target.stopRemote()).rejects.toThrow("physical_identity_mismatch");
    expect(stopped).not.toHaveBeenCalled();
  });
  it("original-sandbox evidence without independent stable retirement cannot record native stop", async () => {
    const f = fixture(), stopped = vi.fn(async () => {});
    delete f.gateway.verifyRetirement;
    await expect(f.transport.stop(authorization.binding.attemptId, stopped)).rejects.toThrow("stable_retirement_authority_missing");
    expect(stopped).not.toHaveBeenCalled();
  });
  it("independent retirement uncertainty preserves the held native command", async () => {
    const f = fixture(), stopped = vi.fn(async () => {});
    vi.mocked(f.gateway.verifyRetirement!).mockRejectedValue(Error("replacement_sandbox_not_excluded"));
    await expect(f.transport.stop(authorization.binding.attemptId, stopped)).rejects.toThrow("replacement_sandbox_not_excluded");
    expect(stopped).not.toHaveBeenCalled();
  });
  it("restart stop requires exact physical observation, independently of a host child", async () => {
    const f = fixture(), stopped = vi.fn(async () => {});
    await f.transport.stop(authorization.binding.attemptId, stopped);
    expect(stopped).toHaveBeenCalledOnce();
    expect(f.gateway.attach).not.toHaveBeenCalled();
    expect(f.journal.prepareCommand).not.toHaveBeenCalled();
  });
  it.each(["stream; launch body", "..", "--option", "a/b"])("rejects unsafe opaque attach handle %s", async handle => {
    const f = fixture(), cleanup = vi.fn(async () => {});
    vi.mocked(f.gateway.attach).mockResolvedValue({ handle, cleanup });
    await expect(f.transport.spawn(owner, authorization, payload, async () => {})).rejects.toThrow("invalid_attach_handle");
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("gateway executable is fixed host configuration, excluding shells and legacy SSH", () => {
    for (const executable of ["ssh", "/bin/sh", "/usr/bin/ssh", "/usr/bin/env", "/safe/../bin/gateway", "/safe/gateway;bad"])
      expect(() => protectedExecutionTransport({ journal: {} as never, gateway: { executable } as ProtectedGateway })).toThrow("fixed_gateway");
  });
  it("all journalled adapter commands receive full immutable payload before protected spawn", async () => {
    let seen: Readonly<SshCommandPayload> | undefined;
    const authorize = vi.fn(async (_spec: unknown, hash: string, _env: unknown, snapshot: Readonly<SshCommandPayload>) => {
      seen = snapshot;
      expect(hash).toBe(createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"));
      return authorization;
    });
    const spawnProtected = vi.fn(async () => ({ command: "/fixed-gateway", args: ["attach", "handle"],
      sshInvocationId: authorization.binding.invocationId, stopRemote: async () => {}, cleanup: async () => {} }));
    const input = { spec, command: "tar", args: ["-cf", "-", "."], env: { HOME: "/attempt" } };
    const pending = withSshCommandJournal({ authorize, spawnProtected, stopped: async () => {} }, () => buildSshSpawnTarget(input));
    input.args.push("caller-mutation");
    input.env.HOME = "/other";
    const target = await pending;
    expect(seen).toEqual({ command: "tar", args: ["-cf", "-", "."], env: { HOME: "/attempt" }, cwd: "/attempt" });
    expect(spawnProtected).toHaveBeenCalledWith(authorization, seen);
    expect(target.command).toBe("/fixed-gateway");
  });
  it("protected failure never falls through to old SSH auth or spawn target", async () => {
    await expect(withSshCommandJournal({ authorize: async () => authorization,
      spawnProtected: async () => { throw Error("protected_held"); }, stopped: async () => {} },
    () => buildSshSpawnTarget({ spec, command: "sh", args: ["-c", "provider-body"], env: {} }))).rejects.toThrow("protected_held");
  });  it("direct tar upload/download streams spawn the protected target, never hardcoded SSH", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "protected-stream-fixture-"));
    try {
      const source = path.join(root, "source"), target = path.join(root, "target"), archive = path.join(root, "source.tar"), received = path.join(root, "received.tar");
      await mkdir(source);
      await writeFile(path.join(source, "uncommitted"), "binary-safe-fixture");
      execFileSync("tar", ["-cf", archive, "-C", source, "."]);
      const payloads: Readonly<SshCommandPayload>[] = [];
      const journal = {
        authorize: async (_spec: unknown, hash: string, _env: unknown, command: Readonly<SshCommandPayload>) => {
          expect(hash).toBe(createHash("sha256").update(JSON.stringify(command)).digest("hex"));
          payloads.push(command);
          return authorization;
        },
        spawnProtected: async (_authorization: SshLaunchAuthorization, command: Readonly<SshCommandPayload>) => {
          const uploading = command.args.some(arg => arg.includes("tar -xf -"));
          const script = uploading
            ? "const fs=require('fs');const out=fs.createWriteStream(process.argv[1]);process.stdin.pipe(out)"
            : "process.stdout.write(require('fs').readFileSync(process.argv[1]))";
          return { command: process.execPath, args: ["-e", script, uploading ? received : archive],
            sshInvocationId: authorization.binding.invocationId, cleanup: async () => {}, stopRemote: async () => {} };
        },
        stopped: async () => {},
      };
      await withSshCommandJournal(journal, () => syncDirectoryToSsh({ spec, localDir: source, remoteDir: "/attempt/workspace" }));
      expect((await readFile(received)).includes(Buffer.from("binary-safe-fixture"))).toBe(true);
      await withSshCommandJournal(journal, () => syncDirectoryFromSsh({ spec, localDir: target, remoteDir: "/attempt/workspace" }));
      expect(await readFile(path.join(target, "uncommitted"), "utf8")).toBe("binary-safe-fixture");
      expect(payloads).toHaveLength(2);
      expect(payloads.every(command => command.command === "sh" && command.cwd === null)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
