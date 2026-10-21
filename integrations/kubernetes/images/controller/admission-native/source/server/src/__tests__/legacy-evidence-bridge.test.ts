import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { execFileSync, spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { legacyEvidenceBridge } from "../services/legacy-evidence-bridge.js";
import { legacyHoldFingerprint, type LegacyEvidenceVerifier } from "../services/execution-legacy-reconciliation.js";
import { capacityFingerprint } from "../services/execution-capacity-policy.js";

vi.mock("node:child_process", async original => ({ ...await original<object>(), spawn: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<object>(), lstatSync: vi.fn() }));

describe("protected host evidence bridge, synthetic child only", () => {
  const now = Date.now();
  const source = "lease:00000000-0000-4000-8000-000000000001";
  function input(): Parameters<LegacyEvidenceVerifier>[0] {
    const hold = { source, companyId: "company", agentId: "agent", runId: "run", environmentId: "environment",
      scopes: ["original-account", "original-workspace"], evidence: { original: true }, evidenceHash: "a".repeat(64), policyHash: "b".repeat(64) };
    const decision = { epoch: "original-epoch", expiresAt: now + 10000 };
    return { decision, holds: [hold], now,
      inventoryHash: capacityFingerprint([{ source, holdHash: legacyHoldFingerprint(hold as never) }]),
    } as unknown as Parameters<LegacyEvidenceVerifier>[0];
  }
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(lstatSync).mockImplementation((path) => ({ uid: 0, mode: 0o755,
      isSymbolicLink: () => false, isFile: () => String(path).endsWith(".py") || path === "/usr/bin/python3.11",
      isDirectory: () => !(String(path).endsWith(".py") || path === "/usr/bin/python3.11"),
    }) as never);
  });
  function child(change: (value: Record<string, unknown>) => Record<string, unknown> = value => value, code = 0) {
    const proc = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = vi.fn();
    const chunks: Buffer[] = [];
    proc.stdin = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      final(callback) {
        const sent = JSON.parse(Buffer.concat(chunks).toString());
        queueMicrotask(() => {
          const reply = change({ decisionHash: capacityFingerprint(sent.decision), inventoryHash: sent.inventoryHash,
            challenge: sent.challenge, expiresAt: now + 5000, operationalAcceptance: false });
          proc.stdout.write(JSON.stringify(reply)); proc.emit("close", code);
        });
        callback();
      } });
    vi.mocked(spawn).mockReturnValue(proc as never);
    return proc;
  }
  const bridge = () => legacyEvidenceBridge({ python: "/usr/bin/python3.11", moduleRoot: "/opt/protected-review" });
  it("uses a fixed isolated loader and exact full native inventory, without append/signing", async () => {
    child();
    const request = input();
    expect(await bridge()(request)).toEqual({ decisionHash: capacityFingerprint(request.decision),
      inventoryHash: request.inventoryHash, expiresAt: now + 5000 });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [python, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(python).toBe("/usr/bin/python3.11");
    expect(args).toEqual(["-I", "-B", "-c", expect.stringContaining("evidence_bridge.py"), "/opt/protected-review"]);
    expect(args![3]).toContain("exec(compile(open(");
    expect(args![3]).not.toContain("run_module");
    expect(args![3]).not.toContain("sys.path.insert");
    expect(options).toMatchObject({ cwd: "/opt/protected-review", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  });
  it("executes verified source instead of matching hostile project bytecode", async () => {
    child(); await bridge()(input());
    const args = vi.mocked(spawn).mock.calls[0]![1]! as string[];
    const root = mkdtempSync(join(tmpdir(), "pc-review-source-only-"));
    try {
      mkdirSync(join(root, "production"));
      const module = join(root, "legacy_review.py");
      writeFileSync(module, "marker = 'EVIL'\n");
      utimesSync(module, 1234567890, 1234567890);
      execFileSync("python3", ["-I", "-c", "import py_compile,sys;py_compile.compile(sys.argv[1],doraise=True)", module]);
      writeFileSync(module, "marker = 'GOOD'\n");
      utimesSync(module, 1234567890, 1234567890);
      writeFileSync(join(root, "production/evidence_bridge.py"), "from legacy_review import marker\nprint(marker)\n");
      // Characterize the real bypass: -B still reads a timestamp-matching pyc.
      expect(execFileSync("python3", ["-I", "-B", "-c", "import sys;sys.path.insert(0,sys.argv[1]);import legacy_review;print(legacy_review.marker)", root], { encoding: "utf8" }).trim()).toBe("EVIL");
      // The production loader has no project cache/import search or run_module.
      expect(execFileSync("python3", ["-I", "-B", "-c", args[3]!, root], { encoding: "utf8" }).trim()).toBe("GOOD");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["challenge", "inventoryHash", "decisionHash"])("refuses wrong %s from child", async field => {
    const proc = child(value => ({ ...value, [field]: "wrong" }));
    await expect(bridge()(input())).rejects.toThrow("legacy_bridge_review_held");
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
  it("refuses expired evidence and unsuccessful child without retry", async () => {
    child(value => ({ ...value, expiresAt: now - 1 }));
    await expect(bridge()(input())).rejects.toThrow("legacy_bridge_review_held");
    expect(spawn).toHaveBeenCalledTimes(1);
    child(value => value, 1);
    await expect(bridge()(input())).rejects.toThrow("legacy_bridge_review_held");
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("rejects unprotected executable custody before any child", async () => {
    vi.mocked(lstatSync).mockImplementation(() => ({ uid: 1000, mode: 0o777, isSymbolicLink: () => false }) as never);
    await expect(bridge()(input())).rejects.toThrow("legacy_bridge_protected_inputs_unavailable");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("holds unsupported source kinds and filtered/mismatched inventory before any child", async () => {
    const unsupported = input(); unsupported.holds[0]!.source = "run:original-unmapped";
    await expect(bridge()(unsupported)).rejects.toThrow("legacy_bridge_protected_inputs_unavailable");
    const changed = input(); changed.inventoryHash = "c".repeat(64);
    await expect(bridge()(changed)).rejects.toThrow("legacy_bridge_protected_inputs_unavailable");
    expect(spawn).not.toHaveBeenCalled();
  });
});
