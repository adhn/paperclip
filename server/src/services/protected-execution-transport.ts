import path from "node:path";
import type { Db } from "@paperclipai/db";
import type { SshCommandPayload, SshLaunchAuthorization, SshSpawnTarget } from "@paperclipai/adapter-utils/ssh";
import type { ProtectedStdinClaim, protectedExecutionJournal } from "./protected-execution-journal.js";

type Journal = Pick<ReturnType<typeof protectedExecutionJournal>, "prepareCommand" | "acceptAck" | "inspectCommand" | "commandPhysical" | "claimStdin">;
type Envelope = Parameters<Journal["acceptAck"]>[0];
type Request = Awaited<ReturnType<Journal["inspectCommand"]>>;
type Owner = { companyId: string; attemptId: string; token: string };
type Physical = Record<"pool" | "uid" | "container" | "node" | "storage", string>;
export interface ProtectedGateway {
  /** Protected host configuration, never an adapter/model/environment field. */
  readonly executable: string;
  exchange(request: Request): Promise<Envelope>;
  /** Attach to an already-consumed exact invocation. This operation MUST NOT
   * authorize, recreate a Pod, execute the payload, or replay the body. The host
   * gateway must durably serialize stdin ownership for this exact command and
   * physical incarnation, including across gateway restart. A lost attach reply
   * retains that ownership; timeout/disconnect cannot grant a replacement writer.
   * The gateway must independently verify and consume the exact committed native
   * claim before opening stdin. Passing this object is not gateway enforcement. */
  attach(input: { commandId: string; invocation: string; physical: Physical; stdin: "exclusive"; claim: ProtectedStdinClaim }): Promise<{ handle: string; cleanup(): Promise<void> }>;
  /** Independent host authority excluding replacement sandboxes/stale kubelets.
   * Original-sandbox stop evidence alone cannot release native occupancy. The
   * implementation must durably commit its exact native receipt/high-water CAS
   * before returning; this transport does not mint or persist retirement proof. */
  verifyRetirement?(input: { commandId: string; contract: Record<string, unknown>; physical: Physical;
    observation: Record<string, unknown> }): Promise<string>;
}
export interface ProtectedCommandTransport {
  spawn(owner: Owner, authorization: SshLaunchAuthorization, payload: Readonly<SshCommandPayload>,
    recordStopped: () => Promise<void>): Promise<SshSpawnTarget>;
  stop(commandId: string, recordStopped: () => Promise<void>): Promise<void>;
  /** Inspect retained work without body replay; obtain its first writer only.
   * An existing/ambiguous writer claim holds: no safe reacquisition is provided. */
  recover(owner: Owner, commandId: string, recordStopped: () => Promise<void>): Promise<SshSpawnTarget>;
}
const transports = new WeakMap<Db, ProtectedCommandTransport>();
export function installedProtectedExecutionTransport(db: Db) { return transports.get(db); }
export function installProtectedExecutionTransport(db: Db, options: { journal: Journal; gateway: ProtectedGateway }) {
  if (transports.has(db)) throw Error("protected_transport_already_installed");
  const transport = protectedExecutionTransport(options);
  transports.set(db, transport);
  return transport;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("protected_invalid_response");
  return value as Record<string, unknown>;
}
function physical(value: unknown, pool: unknown, storage?: unknown): Physical {
  const p = record(value);
  const keys = ["pool", "uid", "container", "node", "storage"] as const;
  if (Object.keys(p).length !== keys.length || keys.some(key => typeof p[key] !== "string" || !(p[key] as string).length) ||
      p.pool !== pool || (storage !== undefined && p.storage !== storage)) throw Error("protected_physical_identity_mismatch");
  return { pool: p.pool as string, uid: p.uid as string, container: p.container as string, node: p.node as string, storage: p.storage as string };
}
function samePhysical(a: Physical, b: Physical) {
  return (Object.keys(a) as (keyof Physical)[]).every(key => a[key] === b[key]);
}

/** Inactive host-installed transport. No production gateway implementation or
 * installer exists. Every direct command/stream reaches the same native journal.
 * An uncertain exchange never retries authorization or falls back to old SSH.
 */
export function protectedExecutionTransport({ journal, gateway }: { journal: Journal; gateway: ProtectedGateway }): ProtectedCommandTransport {
  const executable = gateway.executable; // snapshot trusted configuration once
  if (!path.posix.isAbsolute(executable) || path.posix.normalize(executable) !== executable ||
      !/^\/[A-Za-z0-9_./-]+$/.test(executable) ||
      ["sh", "bash", "zsh", "dash", "env", "ssh", "python", "python3", "node"].includes(path.posix.basename(executable)))
    throw Error("protected_fixed_gateway_required");
  async function exchange(request: Request) {
    const reply = await gateway.exchange(structuredClone(request));
    if (reply.body.nonce !== request.body.nonce) throw Error("protected_ack_challenge_mismatch");
    // Authenticity, committed challenge and durable independent high-water CAS
    // complete BEFORE any attach target or native stopped status is returned.
    return journal.acceptAck(reply);
  }
  async function stop(commandId: string, recordStopped: () => Promise<void>, expected?: Physical) {
    const request = await journal.inspectCommand(commandId, true);
    const reply = await exchange(request);
    const result = record(reply.body.result);
    if (result.status !== "stopped") throw Error("protected_whole_pod_stop_unverified");
    const exact = physical(result.physical, reply.body.pool, record(request.body.value).storage);
    const retainedPhysical = expected ?? await journal.commandPhysical(commandId);
    if (retainedPhysical && !samePhysical(physical(retainedPhysical, reply.body.pool, record(request.body.value).storage), exact))
      throw Error("protected_physical_identity_mismatch");
    if (expected && !samePhysical(expected, exact)) throw Error("protected_physical_identity_mismatch");
    const observation = record(result.observation);
    if (observation.status !== "confirmed_stopped" ||
        !samePhysical(exact, physical(observation.physical, reply.body.pool)) ||
        !observation.evidence || typeof observation.evidence !== "object" || Array.isArray(observation.evidence))
      throw Error("protected_whole_pod_stop_unverified");
    if (!gateway.verifyRetirement) throw Error("protected_stable_retirement_authority_missing");
    const retirement = await gateway.verifyRetirement({ commandId, contract: structuredClone(record(request.body.value)),
      physical: structuredClone(exact), observation: structuredClone(observation) });
    if (typeof retirement !== "string" || !retirement.trim() || retirement.length > 512 || /[\x00-\x1f]/.test(retirement))
      throw Error("protected_stable_retirement_unverified");
    await recordStopped();
  }
  function requireClaimAuthority() {
    if (typeof journal.claimStdin !== "function") throw Error("protected_stdin_claim_authority_missing");
  }
  async function attach(owner: Owner, commandId: string, invocation: string, exact: Physical, ackNonce: unknown, recordStopped: () => Promise<void>) {
    requireClaimAuthority();
    if (typeof ackNonce !== "string" || !ackNonce) throw Error("protected_stdin_ack_binding_missing");
    const claim = await journal.claimStdin({ owner: { ...owner }, commandId, invocation, physical: structuredClone(exact), ackNonce });
    if (!claim || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(claim.id) ||
        !/^[a-f0-9]{64}$/.test(claim.bindingHash)) throw Error("protected_stdin_claim_invalid");
    // The permanent claim commits before the first gateway attach side effect.
    // Failure/lost attach response must never clear the native one-writer record.
    const attached = await gateway.attach({ commandId, invocation, physical: structuredClone(exact), stdin: "exclusive", claim: { ...claim } });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(attached.handle)) {
      await attached.cleanup();
      throw Error("protected_invalid_attach_handle");
    }
    let stopping: Promise<void> | undefined;
    const stopRemote = () => stopping ??= stop(commandId, recordStopped, exact).catch(error => {
      stopping = undefined;
      throw error;
    });
    return { command: executable, args: ["attach", attached.handle], sshInvocationId: invocation,
      stopRemote, cleanup: async () => { try { await stopRemote(); } finally { await attached.cleanup(); } } };
  }
  async function recoverInspected(owner: Owner, commandId: string, request: Request, retained: Record<string, unknown> | null,
    recordStopped: () => Promise<void>) {
    if (!retained) throw Error("protected_recovery_physical_binding_missing");
    if (request.body.op !== "inspect") throw Error("protected_recovery_inspection_required");
    const contract = record(request.body.value);
    if (typeof contract.invocation !== "string" || !contract.invocation.length)
      throw Error("protected_invocation_identity_mismatch");
    const reply = await exchange(request);
    const exact = physical(retained, reply.body.pool, contract.storage);
    const result = record(reply.body.result);
    if (result.status !== "started" || !samePhysical(exact, physical(result.physical, reply.body.pool, contract.storage)))
      throw Error("protected_recovery_incarnation_unverified");
    const observation = record(result.observation);
    if (observation.status !== "running" || !samePhysical(exact, physical(observation.physical, reply.body.pool, contract.storage)))
      throw Error("protected_recovery_current_observation_missing");
    return attach(owner, commandId, contract.invocation, exact, reply.body.nonce, recordStopped);
  }
  return {
    stop,
    async recover(owner, commandId, recordStopped) {
      requireClaimAuthority();
      owner = { ...owner };
      // Read the independently accepted identity BEFORE accepting this inspection
      // ACK. A fresh ACK may not invent a replacement for a lost launch binding.
      const retained = await journal.commandPhysical(commandId);
      if (!retained) throw Error("protected_recovery_physical_binding_missing");
      const request = await journal.inspectCommand(commandId, false);
      return recoverInspected(owner, commandId, request, retained, recordStopped);
    },
    async spawn(owner, authorization, payload, recordStopped) {
      requireClaimAuthority();
      owner = { ...owner };
      // Clone before the first await; callback/caller mutation cannot replace a
      // payload after its native hash or protected committed journal is checked.
      const immutablePayload = structuredClone(payload);
      const commandId = authorization.binding.attemptId;
      const invocation = authorization.binding.invocationId;
      const prepared = await journal.prepareCommand({ ...owner }, commandId, immutablePayload);
      const contract = record(prepared.contract);
      // Reject an inconsistent journal before the exchange can consume/launch.
      if (contract.invocation !== invocation) throw Error("protected_invocation_identity_mismatch");
      // prepareCommand deliberately returns inspection for a previously prepared
      // command. Repeated spawn must follow the same recovery fence; a fresh ACK
      // cannot manufacture a replacement physical incarnation or another writer.
      if (prepared.request.body.op === "inspect")
        return recoverInspected(owner, commandId, prepared.request, await journal.commandPhysical(commandId), recordStopped);
      if (prepared.request.body.op !== "authorizeInvocation") throw Error("protected_launch_operation_invalid");
      const reply = await exchange(prepared.request);
      const result = record(reply.body.result);
      if (result.status !== "started") throw Error("protected_invocation_not_started");
      const exact = physical(result.physical, reply.body.pool, contract.storage);
      return attach(owner, commandId, invocation, exact, reply.body.nonce, recordStopped);
    },
  };
}
