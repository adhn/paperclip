import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { and, eq, inArray, sql } from "drizzle-orm";
import { admissionAttempts, admissionCommands, admissionScheduler, admissionScopes, admissionLegacyHolds, environmentLeases, heartbeatRuns,
  protectedAuthorityPins, protectedAuthorityRequests, protectedCommandJournals, type Db } from "@paperclipai/db";
import type { trustedCapacityPolicy } from "./execution-capacity-policy.js";
import { legacyHoldIsReconciled } from "./execution-legacy-reconciliation.js";
import { readRunCancellation } from "./run-cancellation.js";

// This protocol has fixed ASCII keys, UTF-8 string values and safe integers.
// Do not reuse locale-dependent capacityFingerprint as a wire signature format.
export function protectedCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(protectedCanonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => {
      if (!/^[\x20-\x7e]+$/.test(k)) throw Error("protected_protocol_non_ascii_key");
      return `${JSON.stringify(k)}:${protectedCanonical((value as Record<string, unknown>)[k])}`;
    }).join(",")}}`;
  }
  throw Error("protected_protocol_invalid_value");
}
export const protectedHash = (value: unknown) => createHash("sha256").update(protectedCanonical(value)).digest("hex");
export function protectedSign(key: Buffer, domain: string, value: unknown) {
  return createHmac("sha256", key).update(domain).update("\0").update(protectedCanonical(value)).digest("hex");
}
function authenticate(key: Buffer, domain: string, value: unknown, mac: unknown) {
  if (typeof mac !== "string" || !/^[a-f0-9]{64}$/.test(mac) ||
      !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(protectedSign(key, domain, value), "hex")))
    throw Error("protected_ack_authentication_failed");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("protected_protocol_invalid_value");
  return value as Record<string, unknown>;
}
export interface ProtectedPayload { command: string; args: string[]; env: Record<string, string>; cwd: string | null }
export interface ProtectedPolicy {
  version: 1; instance: string; pool: string; runtimeAuthority: string;
  templates: Record<string, { image: string; entrypoint: string }>;
  families: Record<"runner" | "account" | "workspace" | "session" | "credential", string>[];
}
export interface ProtectedTarget { storage: string; pvcUid: string; pvcName: string; image: string; template: string }
export type ProtectedEnvelope = { body: Record<string, unknown>; mac: string };
export type ProtectedPhysical = Record<"pool" | "uid" | "container" | "node" | "storage", string>;
export type ProtectedStdinClaim = { id: string; bindingHash: string };
export type ProtectedStdinPins = Record<"instance" | "pool" | "policy" | "epoch" | "authorityIncarnation" | "historyDomain" | "historyIncarnation", string> & { historyFloor: number };
export interface ProtectedStdinVerification {
  version: 1; operation: "consumeStdin" | "claimStreamTicket"; operationId: string; challenge: string;
  requestHash: string; bindingHash: string; binding: Record<string, unknown>; pins: ProtectedStdinPins;
}
export interface ProtectedStdinAuthority {
  gatewayIdentity: string; streamIdentity: string; historyDomain: string; historyIncarnation: string; historyFloor: number;
  verificationKey: Buffer;
  verificationDeadlineMs?: number;
  /** Must contact independently current runtime/start + physical storage/history
   * authorities and durably consume this exact operationId before signing its
   * reply. Duplicate/ambiguous external intents refuse; issuing a fresh challenge
   * for an old intent cannot recover a rolled-back native database. Recovery
   * needs a separately reviewed exact-intent inspection/reconciliation protocol.
   * No production backend is implemented by this interface or its HTTPS client.
   * The native service independently authenticates the complete returned proof. */
  verifyAndPin(request: ProtectedStdinVerification): Promise<ProtectedEnvelope>;
}
export interface ProtectedCreateReview {
  version: 1; cluster: string; namespaceUid: string; webhook: string;
  reviewUid: string; podUid: string; namespace: string; name: string; objectHash: string;
  contract: Record<string, unknown>; target: ProtectedTarget;
}
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Owner = { companyId: string; attemptId: string; token: string };
type StdinValue = { owner: Owner; commandId: string; invocation: string; physical: ProtectedPhysical; ackNonce: string };
type PinIdentity = Pick<typeof protectedAuthorityPins.$inferInsert, "instance" | "policy" | "pool" | "incarnation">;

/** Explicit inactive host integration. No public receipt endpoint or production
 * installer. DB commits precede every returned request/grant. Native command
 * ownership already covers run/setup/probe/transfer commands, without a new
 * queue. This service does not grant admission, assert stop, restore, or release.
 */
export function protectedExecutionJournal(db: Db, input: {
  epoch: string; policy: ProtectedPolicy; capacity: ReturnType<typeof trustedCapacityPolicy>;
  requestKey: Buffer; ackKey: Buffer; grantKey: Buffer;
  target(binding: Record<string, unknown>, attemptId: string): ProtectedTarget;
  // Host-installed authenticated online admission seam. No public route, cache,
  // supervisor key or caller JSON can supply the peer identity/storage proof.
  createAuthority?: {
    cluster: string; namespaceUid: string; webhook: string; namespace: string;
    attestStorage(tx: Transaction, review: ProtectedCreateReview): Promise<boolean>;
  };
  stdinAuthority?: ProtectedStdinAuthority;
  now?: () => number;
}) {
  input = { ...input, policy: structuredClone(input.policy), requestKey: Buffer.from(input.requestKey),
    ackKey: Buffer.from(input.ackKey), grantKey: Buffer.from(input.grantKey),
    createAuthority: input.createAuthority ? { ...input.createAuthority } : undefined,
    stdinAuthority: input.stdinAuthority ? { ...input.stdinAuthority, verificationKey: Buffer.from(input.stdinAuthority.verificationKey) } : undefined };
  const { policy } = input;
  const now = input.now ?? Date.now;
  if ([input.requestKey, input.ackKey, input.grantKey].some(key => key.length < 32) ||
      new Set([input.requestKey, input.ackKey, input.grantKey].map(k => k.toString("hex"))).size !== 3)
    throw Error("protected_independent_keys_required");
  const policyHash = protectedHash(policy);
  if (input.stdinAuthority && (input.stdinAuthority.verificationKey.length < 32 ||
      [input.requestKey, input.ackKey, input.grantKey].some(k => k.equals(input.stdinAuthority!.verificationKey)) ||
      !input.stdinAuthority.gatewayIdentity || !input.stdinAuthority.streamIdentity ||
      input.stdinAuthority.gatewayIdentity === input.stdinAuthority.streamIdentity ||
      !input.stdinAuthority.historyDomain || !input.stdinAuthority.historyIncarnation ||
      !Number.isSafeInteger(input.stdinAuthority.historyFloor) || input.stdinAuthority.historyFloor < 1 ||
      !Number.isSafeInteger(input.stdinAuthority.verificationDeadlineMs ?? 3000) ||
      (input.stdinAuthority.verificationDeadlineMs ?? 3000) < 1 || (input.stdinAuthority.verificationDeadlineMs ?? 3000) > 5000))
    throw Error("protected_stdin_independent_authority_required");
  async function locked<T>(body: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>) {
    return db.transaction(async tx => {
      const [scheduler] = await tx.select().from(admissionScheduler).where(eq(admissionScheduler.singleton, true)).for("update");
      if (!scheduler || scheduler.epoch !== input.epoch) throw Error("stale_admission_controller");
      return body(tx);
    });
  }
  function checkedWatermark(value: unknown) {
    const result = object(value);
    if (Object.keys(result).sort().join(",") !== "hash,sequence" || !Number.isSafeInteger(result.sequence) ||
        (result.sequence as number) < 0 || typeof result.hash !== "string" || !/^[a-f0-9]{64}$/.test(result.hash))
      throw Error("protected_invalid_ledger_watermark");
    return { sequence: result.sequence as number, hash: result.hash };
  }
  async function durableWatermark(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], incarnation: string) {
    const rows = await tx.select({ receipt: protectedAuthorityRequests.receipt }).from(protectedAuthorityRequests)
      .where(eq(protectedAuthorityRequests.pool, policy.pool));
    let floor = { sequence: 0, hash: protectedHash([]) };
    for (const row of rows) {
      if (!row.receipt) continue;
      const receipt = row.receipt as unknown as ProtectedEnvelope;
      authenticate(input.ackKey, "ack", receipt.body, receipt.mac);
      if (receipt.body.incarnation !== incarnation) throw Error("protected_ack_identity_mismatch");
      const value = checkedWatermark(receipt.body.ledgerWatermark);
      if (value.sequence === floor.sequence && value.hash !== floor.hash) throw Error("protected_ledger_history_conflict");
      if (value.sequence > floor.sequence) floor = value;
    }
    return floor;
  }
  async function requestIn(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], op: string, value: Record<string, unknown>) {
    const [pin] = await tx.select().from(protectedAuthorityPins).where(eq(protectedAuthorityPins.pool, policy.pool)).for("update");
    if (!pin || pin.policy !== policyHash || pin.instance !== policy.instance) throw Error("protected_pin_identity_changed");
    const body = { op, value, nonce: randomUUID(), expires: Math.floor(now() / 1000) + 30, highWater: await durableWatermark(tx, pin.incarnation) };
    await tx.insert(protectedAuthorityRequests).values({ nonce: body.nonce, pool: pin.pool, pinRevision: pin.revision,
      request: body, requestHash: protectedHash(body), expiresAt: new Date(body.expires * 1000) });
    return { body, mac: protectedSign(input.requestKey, "request", body) };
  }
  async function validateStdin(tx: Transaction, value: StdinValue) {
    const exact = object(value.physical);
    if (Object.keys(exact).sort().join(",") !== "container,node,pool,storage,uid" ||
        Object.values(exact).some(v => typeof v !== "string" || !v.length || v.length > 512 || /[\x00-\x1f]/.test(v)) ||
        exact.pool !== policy.pool) throw Error("protected_stdin_physical_mismatch");
    const [scheduler] = await tx.select().from(admissionScheduler).where(eq(admissionScheduler.singleton, true));
    if (scheduler.draining) throw Error("admission_draining");
    const [journal] = await tx.select().from(protectedCommandJournals)
      .where(eq(protectedCommandJournals.commandId, value.commandId)).for("update");
    if (!journal || journal.pool !== policy.pool || protectedHash(journal.contract) !== journal.contractHash)
      throw Error("protected_command_unknown");
    const original = object(journal.contract.owner);
    const [attempt] = await tx.select().from(admissionAttempts).where(eq(admissionAttempts.id, String(original.attempt))).for("update");
    if (!attempt || attempt.companyId !== original.company || attempt.agentId !== original.agent || attempt.ownerEpoch !== input.epoch ||
        attempt.companyId !== value.owner.companyId || attempt.id !== value.owner.attemptId || attempt.token !== value.owner.token ||
        !["reserved", "starting"].includes(attempt.state)) throw Error("admission_ownership");
    const resolved = input.capacity.forCleanup(attempt.contract);
    if (protectedHash(attempt.scopes) !== protectedHash(resolved.scopes.map(s => s.key))) throw Error("protected_stdin_scope_mismatch");
    const scopes = await tx.select().from(admissionScopes).where(inArray(admissionScopes.key, attempt.scopes)).for("update");
    if (scopes.length !== attempt.scopes.length || scopes.some(s => s.draining || s.capacity < 1 || (s.notBefore && s.notBefore.getTime() > now())))
      throw Error("protected_stdin_scope_held");
    const occupied = await tx.select().from(admissionAttempts).where(inArray(admissionAttempts.state, ["reserved", "starting", "stopping", "uncertain"]));
    if (scopes.some(scope => occupied.filter(candidate => candidate.scopes.includes(scope.key)).length > scope.capacity))
      throw Error("protected_stdin_scope_overcommitted");
    const holds = await tx.select().from(admissionLegacyHolds)
      .where(sql`${admissionLegacyHolds.scopes} && ARRAY[${sql.join(attempt.scopes.map(key => sql`${key}`), sql`, `)}]::text[]`);
    for (const hold of holds) if (!await legacyHoldIsReconciled(tx as unknown as Db, hold, input.epoch, now()))
      throw Error("legacy_occupancy_unreconciled");
    const [command] = await tx.select().from(admissionCommands).where(eq(admissionCommands.id, value.commandId)).for("update");
    if (!command || command.attemptId !== attempt.id || command.stopped || command.binding.epoch !== input.epoch ||
        command.binding.companyId !== attempt.companyId || command.binding.agentId !== attempt.agentId ||
        command.binding.runId !== (attempt.runId ?? attempt.id) || command.binding.invocationId !== value.invocation ||
        journal.contract.invocation !== value.invocation || journal.contract.journalHash !== protectedHash({ id: command.id,
          attemptId: command.attemptId, binding: command.binding, commandHash: command.commandHash, fenceRoot: command.fenceRoot }))
      throw Error("protected_committed_command_mismatch");
    const family = { runner: resolved.binding.runner, account: resolved.binding.providerAccount,
      workspace: resolved.binding.workspace, session: resolved.binding.session, credential: resolved.binding.credential };
    if (!policy.families.some(f => protectedHash(f) === protectedHash(family))) throw Error("protected_scope_family_changed");
    const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, command.binding.leaseId)).for("update");
    if (!lease || lease.companyId !== attempt.companyId || lease.environmentId !== resolved.binding.environmentId ||
        lease.environmentId !== command.binding.environmentId || lease.status !== "active" || lease.releasedAt ||
        lease.metadata?.agentId !== attempt.agentId || lease.heartbeatRunId !== attempt.runId ||
        (!attempt.runId && lease.metadata?.admissionOperationId !== attempt.id)) throw Error("protected_committed_lease_mismatch");
    const owner = { company: attempt.companyId, agent: attempt.agentId, nativeKind: attempt.runId ? "run" : "operation",
      nativeId: attempt.runId ?? attempt.id, environment: lease.environmentId!, lease: lease.id, attempt: attempt.id, ...family };
    if (protectedHash(original) !== protectedHash(owner)) throw Error("protected_stdin_owner_mismatch");
    if (attempt.runId) {
      const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, attempt.runId)).for("update");
      if (!run || run.companyId !== attempt.companyId || run.agentId !== attempt.agentId || run.status !== "running" || readRunCancellation(run.resultJson))
        throw Error("capacity_native_run_stopped");
    }
    const [pin] = await tx.select().from(protectedAuthorityPins).where(eq(protectedAuthorityPins.pool, policy.pool)).for("update");
    if (!pin || pin.instance !== policy.instance || pin.policy !== policyHash || pin.epoch !== input.epoch ||
        journal.contract.epoch !== pin.epoch || journal.contract.generation !== pin.generation)
      throw Error("protected_epoch_unacknowledged");
    const [accepted] = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, value.ackNonce)).for("update");
    if (!accepted || accepted.pool !== policy.pool || !accepted.receipt || accepted.requestHash !== protectedHash(accepted.request) ||
        !["authorizeInvocation", "inspect"].includes(String(accepted.request.op)) ||
        protectedHash(accepted.request.value) !== journal.contractHash || accepted.expiresAt.getTime() <= now() ||
        pin.revision !== accepted.pinRevision + 1) throw Error("protected_stdin_current_ack_required");
    const ack = accepted.receipt as unknown as ProtectedEnvelope;
    authenticate(input.ackKey, "ack", ack.body, ack.mac);
    if (ack.body.nonce !== accepted.nonce || ack.body.requestHash !== accepted.requestHash ||
        ack.body.incarnation !== pin.incarnation || ack.body.instance !== pin.instance || ack.body.policy !== pin.policy ||
        ack.body.pool !== pin.pool || ack.body.epoch !== pin.epoch || ack.body.generation !== pin.generation)
      throw Error("protected_stdin_current_ack_required");
    const result = object(ack.body.result);
    if (result.status !== "started" || protectedHash(result.physical) !== protectedHash(exact))
      throw Error("protected_stdin_physical_mismatch");
    if (accepted.request.op === "inspect") {
      const observed = object(result.observation);
      if (observed.status !== "running" || protectedHash(observed.physical) !== protectedHash(exact))
        throw Error("protected_stdin_current_ack_required");
    }
    const grant = object(object(journal.contract.journalGrant).body);
    authenticate(input.grantKey, "native-journal-grant-v1", grant, object(journal.contract.journalGrant).mac);
    const target = input.target(resolved.binding as unknown as Record<string, unknown>, attempt.id);
    if (protectedHash(grant.target) !== protectedHash(target) || exact.storage !== target.storage)
      throw Error("protected_stdin_physical_mismatch");
    const history = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.pool, policy.pool));
    const { journalGrant, ...contract } = journal.contract;
    const consumed = history.find(row => row.request.op === "consumePodCreate" && row.request.commandId === command.id &&
      object(row.request.value).podUid === exact.uid && protectedHash(object(row.request.value).contract) === protectedHash(contract));
    if (!consumed || consumed.requestHash !== protectedHash(consumed.request)) throw Error("protected_stdin_create_consumption_missing");
    const binding = { version: 1, commandId: command.id, journalHash: journal.contractHash, owner,
      ownerTokenHash: protectedHash(value.owner), invocation: value.invocation,
      physical: exact, instance: pin.instance, policy: pin.policy, epoch: pin.epoch, generation: pin.generation,
      authorityIncarnation: pin.incarnation, ackNonce: accepted.nonce, ackHash: protectedHash(ack), createHash: consumed.requestHash };
    return { binding, pin, history, command };
  }
  function fields(value: unknown, keys: string) {
    const result = object(value);
    if (Object.keys(result).sort().join(",") !== keys.split(" ").sort().join(",")) throw Error("protected_stdin_invalid_request");
    return result;
  }
  function identifier(value: unknown): asserts value is string {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)) throw Error("protected_stdin_invalid_identity");
  }
  function nonceFor(domain: string, id: string) {
    const hex = protectedHash({ domain, id }).slice(0, 32);
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function authorityFor(peer: string, role: "gateway" | "stream") {
    const authority = input.stdinAuthority;
    if (!authority) throw Error("protected_stdin_current_authority_missing");
    if (peer !== (role === "gateway" ? authority.gatewayIdentity : authority.streamIdentity)) throw Error("protected_stdin_peer_refused");
    return authority;
  }
  async function validateAttach(tx: Transaction, raw: unknown) {
    const request = fields(raw, "version pins attach");
    if (request.version !== 1) throw Error("protected_stdin_invalid_request");
    const attach = fields(request.attach, "commandId invocation physical stdin claim");
    identifier(attach.commandId); identifier(attach.invocation);
    if (attach.stdin !== "exclusive") throw Error("protected_stdin_exclusive_required");
    const claim = fields(attach.claim, "id bindingHash"); identifier(claim.id);
    if (typeof claim.bindingHash !== "string" || !/^[a-f0-9]{64}$/.test(claim.bindingHash)) throw Error("protected_stdin_claim_mismatch");
    const [original] = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, claim.id)).for("update");
    if (!original || original.pool !== policy.pool || original.request.op !== "claimStdin" || original.requestHash !== protectedHash(original.request) ||
        protectedHash(original.request.value) !== claim.bindingHash) throw Error("protected_stdin_claim_mismatch");
    const retained = object(original.request.value);
    const retainedOwner = object(retained.owner);
    const [attempt] = await tx.select().from(admissionAttempts).where(eq(admissionAttempts.id, String(retainedOwner.attempt))).for("update");
    if (!attempt || !attempt.token || retained.ownerTokenHash !== protectedHash({ companyId: attempt.companyId, attemptId: attempt.id, token: attempt.token }))
      throw Error("protected_stdin_owner_mismatch");
    const checked = await validateStdin(tx, { owner: { companyId: attempt.companyId, attemptId: attempt.id, token: attempt.token },
      commandId: attach.commandId, invocation: attach.invocation, physical: attach.physical as ProtectedPhysical, ackNonce: String(retained.ackNonce) });
    if (protectedHash(checked.binding) !== claim.bindingHash) throw Error("protected_stdin_claim_mismatch");
    const authority = input.stdinAuthority!;
    const expected: ProtectedStdinPins = { instance: checked.pin.instance, pool: checked.pin.pool, policy: checked.pin.policy,
      epoch: checked.pin.epoch!, authorityIncarnation: checked.pin.incarnation, historyDomain: authority.historyDomain,
      historyIncarnation: authority.historyIncarnation, historyFloor: authority.historyFloor };
    if (protectedHash(request.pins) !== protectedHash(expected)) throw Error("protected_stdin_pins_changed");
    return { ...checked, expected, attach, claim, request };
  }
  async function currentProof(operation: ProtectedStdinVerification["operation"], operationId: string, request: Record<string, unknown>,
    checked: Awaited<ReturnType<typeof validateAttach>>) {
    const authority = input.stdinAuthority!;
    const sent: ProtectedStdinVerification = { version: 1, operation, operationId, challenge: randomUUID(),
      requestHash: protectedHash(request), bindingHash: protectedHash(checked.binding), binding: structuredClone(checked.binding), pins: checked.expected };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reply: ProtectedEnvelope;
    try {
      reply = await Promise.race([
        Promise.resolve().then(() => authority.verifyAndPin(structuredClone(sent))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("protected_stdin_current_authority_timeout")), authority.verificationDeadlineMs ?? 3000);
        }),
      ]);
    } finally { clearTimeout(timer); }
    // Timeout rolls back local state and releases native locks. It cannot cancel
    // a remote durable intent: late resolution stays uncertain, never retries or
    // appends a local ticket. The independent authority must retain that intent.
    const proof = structuredClone(reply);
    authenticate(authority.verificationKey, "protected-stdin-current-v1", proof.body, proof.mac);
    const body = fields(proof.body, "version operationId challenge requestHash bindingHash pins historyRevision runtimeStartHash storageHash historyHash expires");
    if (body.version !== 1 || body.operationId !== sent.operationId || body.challenge !== sent.challenge || body.requestHash !== sent.requestHash ||
        body.bindingHash !== sent.bindingHash || protectedHash(body.pins) !== protectedHash(sent.pins) ||
        !Number.isSafeInteger(body.historyRevision) || (body.historyRevision as number) < checked.expected.historyFloor ||
        !Number.isSafeInteger(body.expires) || (body.expires as number) <= now() || (body.expires as number) > now() + 30_000 ||
        [body.runtimeStartHash, body.storageHash, body.historyHash].some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))
      throw Error("protected_stdin_current_proof_refused");
    for (const row of checked.history) {
      if (!["consumeStdin", "claimStreamTicket"].includes(String(row.request.op))) continue;
      if (row.requestHash !== protectedHash(row.request)) throw Error("protected_stdin_history_conflict");
      const previous = object(row.request.proof) as unknown as ProtectedEnvelope;
      authenticate(authority.verificationKey, "protected-stdin-current-v1", previous.body, previous.mac);
      const previousPins = object(previous.body.pins);
      if (previousPins.historyDomain !== sent.pins.historyDomain || previousPins.historyIncarnation !== sent.pins.historyIncarnation ||
          !Number.isSafeInteger(previous.body.historyRevision) || (previous.body.historyRevision as number) >= (body.historyRevision as number))
        throw Error("protected_stdin_history_rollback");
    }
    return proof;
  }
  return {
    async registerHeldPin(identity: PinIdentity) {
      identity = structuredClone(identity);
      if (identity.pool !== policy.pool || identity.instance !== policy.instance || identity.policy !== policyHash || !identity.incarnation)
        throw Error("protected_pin_identity_changed");
      await locked(async tx => {
        const [scheduler] = await tx.select().from(admissionScheduler).where(eq(admissionScheduler.singleton, true));
        if (!scheduler.draining) throw Error("protected_pin_registration_requires_drain");
        await tx.insert(protectedAuthorityPins).values(identity).onConflictDoNothing();
        const [pin] = await tx.select().from(protectedAuthorityPins).where(eq(protectedAuthorityPins.pool, policy.pool));
        for (const key of ["pool", "instance", "policy", "incarnation"] as const)
          if (pin[key] !== identity[key]) throw Error("protected_pin_identity_changed");
      });
    },
    async epochRequest(expectedGeneration: number) {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw Error("protected_invalid_generation");
      return locked(tx => requestIn(tx, "acknowledgeEpoch", { expectedGeneration, epoch: input.epoch }));
    },
    async acceptAck(envelope: ProtectedEnvelope): Promise<ProtectedEnvelope> {
      envelope = structuredClone(envelope);
      authenticate(input.ackKey, "ack", envelope.body, envelope.mac);
      const body = envelope.body;
      if (typeof body.nonce !== "string") throw Error("protected_ack_challenge_mismatch");
      return locked(async tx => {
        const [request] = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, body.nonce as string)).for("update");
        if (!request || request.requestHash !== body.requestHash || request.pool !== policy.pool)
          throw Error("protected_ack_challenge_mismatch");
        // Local permanent CREATE/writer records are never remote challenges.
        // An authority key cannot turn them into ACKs or advance their pins.
        if (!["acknowledgeEpoch", "authorizeInvocation", "inspect", "stopAndInspect"].includes(String(request.request.op)))
          throw Error("protected_ack_local_record");
        const [pin] = await tx.select().from(protectedAuthorityPins).where(eq(protectedAuthorityPins.pool, request.pool)).for("update");
        // A duplicate response is inspectable, but cannot roll a newer pin back.
        if (request.receipt) {
          if (protectedHash(request.receipt) !== protectedHash(envelope) || pin.epoch !== body.epoch || pin.generation !== body.generation)
            throw Error("protected_ack_replay_conflict");
          return request.receipt as unknown as ProtectedEnvelope;
        }
        if (request.expiresAt.getTime() <= now() || pin.revision !== request.pinRevision)
          throw Error("protected_ack_stale_challenge");
        for (const key of ["instance", "policy", "pool", "incarnation"] as const)
          if (body[key] !== pin[key]) throw Error("protected_ack_identity_mismatch");
        const watermark = checkedWatermark(body.ledgerWatermark);
        const floor = await durableWatermark(tx, pin.incarnation);
        if (watermark.sequence < floor.sequence || (watermark.sequence === floor.sequence && watermark.hash !== floor.hash))
          throw Error("protected_ledger_high_water_rollback");
        const generation = body.generation;
        if (!Number.isSafeInteger(generation) || (generation as number) < pin.generation)
          throw Error("protected_ack_rollback");
        const value = object(request.request.value);
        if (request.request.op === "acknowledgeEpoch") {
          if (body.epoch !== input.epoch || generation !== (value.expectedGeneration as number) + 1 ||
              generation !== pin.generation + 1 || protectedHash(body.result) !== protectedHash({ status: "acknowledged" }))
            throw Error("protected_ack_epoch_mismatch");
        } else if (body.epoch !== pin.epoch || generation !== pin.generation || body.epoch !== value.epoch || generation !== value.generation) {
          throw Error("protected_ack_epoch_mismatch");
        }
        await tx.update(protectedAuthorityPins).set({ epoch: body.epoch as string, generation: generation as number,
          revision: pin.revision + 1 }).where(eq(protectedAuthorityPins.pool, pin.pool));
        await tx.update(protectedAuthorityRequests).set({ receipt: envelope }).where(eq(protectedAuthorityRequests.nonce, request.nonce));
        return envelope;
      });
    },
    async prepareCommand(owner: Owner, commandId: string, payload: ProtectedPayload) {
      // Clone before any await. The transport cannot mutate an already-journalled
      // command. This is the same native command hash used by every SSH path.
      owner = { ...owner };
      payload = structuredClone(payload);
      const nativeHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      if (typeof payload.command !== "string" || !payload.command || payload.command.includes("\0") ||
          !Array.isArray(payload.args) || payload.args.some(a => typeof a !== "string" || a.includes("\0")) ||
          (payload.cwd !== null && (typeof payload.cwd !== "string" || !payload.cwd.startsWith("/"))) ||
          Object.entries(payload.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string" || v.includes("\0")) ||
          Buffer.byteLength(JSON.stringify(payload)) > 48000) throw Error("protected_invalid_command_payload");
      const contract = await locked(async tx => {
        const [scheduler] = await tx.select().from(admissionScheduler).where(eq(admissionScheduler.singleton, true));
        if (scheduler.draining) throw Error("admission_draining");
        const [attempt] = await tx.select().from(admissionAttempts).where(and(eq(admissionAttempts.id, owner.attemptId),
          eq(admissionAttempts.companyId, owner.companyId))).for("update");
        if (!attempt || attempt.token !== owner.token || attempt.ownerEpoch !== input.epoch || !["reserved", "starting"].includes(attempt.state))
          throw Error("admission_ownership");
        const [command] = await tx.select().from(admissionCommands).where(and(eq(admissionCommands.id, commandId),
          eq(admissionCommands.attemptId, attempt.id))).for("update");
        if (!command || command.stopped || command.commandHash !== nativeHash) throw Error("protected_committed_command_mismatch");
        const { binding } = input.capacity.forCleanup(attempt.contract);
        if (attempt.runId) {
          const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, attempt.runId), eq(heartbeatRuns.companyId, owner.companyId)));
          if (!run || run.agentId !== attempt.agentId || run.status !== "running" || readRunCancellation(run.resultJson))
            throw Error("capacity_native_run_stopped");
        }
        const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, command.binding.leaseId));
        if (!lease || lease.companyId !== attempt.companyId || lease.environmentId !== binding.environmentId ||
            lease.status !== "active" || lease.releasedAt || lease.metadata?.agentId !== attempt.agentId ||
            lease.heartbeatRunId !== attempt.runId || (!attempt.runId && lease.metadata?.admissionOperationId !== attempt.id) || command.binding.epoch !== input.epoch ||
            command.binding.companyId !== attempt.companyId || command.binding.agentId !== attempt.agentId ||
            command.binding.runId !== (attempt.runId ?? attempt.id) || command.binding.environmentId !== lease.environmentId)
          throw Error("protected_committed_lease_mismatch");
        const [pin] = await tx.select().from(protectedAuthorityPins).where(eq(protectedAuthorityPins.pool, policy.pool)).for("update");
        if (!pin || pin.epoch !== input.epoch || pin.policy !== policyHash || pin.instance !== policy.instance || pin.generation < 1)
          throw Error("protected_epoch_unacknowledged");
        const family = { runner: binding.runner, account: binding.providerAccount, workspace: binding.workspace,
          session: binding.session, credential: binding.credential };
        if (!policy.families.some(f => protectedHash(f) === protectedHash(family))) throw Error("protected_scope_family_changed");
        const target = structuredClone(input.target(binding as unknown as Record<string, unknown>, attempt.id));
        if (!policy.templates[target.template] || !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(target.image) ||
            !target.storage || !target.pvcUid || !target.pvcName || policy.templates[target.template].image !== target.image) throw Error("protected_target_unattested");
        // Fixed provider entrypoint decodes this payload INSIDE the untrusted Pod.
        // No shell/profile/provider code executes in the controller/supervisor.
        const argv = [Buffer.from(JSON.stringify(payload)).toString("base64")];
        const value = { version: 1, instance: policy.instance, policy: policyHash, epoch: pin.epoch, generation: pin.generation,
          owner: { company: attempt.companyId, agent: attempt.agentId, nativeKind: attempt.runId ? "run" : "operation",
            nativeId: attempt.runId ?? attempt.id, environment: lease.environmentId!, lease: lease.id, attempt: attempt.id, ...family },
          invocation: command.binding.invocationId, commandHash: protectedHash(argv),
          journalHash: protectedHash({ id: command.id, attemptId: command.attemptId, binding: command.binding,
            commandHash: command.commandHash, fenceRoot: command.fenceRoot }), storage: target.storage, template: target.template, argv };
        const [prior] = await tx.select().from(protectedCommandJournals).where(eq(protectedCommandJournals.commandId, command.id));
        if (prior) {
          const { journalGrant: previousGrant, ...previousValue } = prior.contract;
          if (protectedHash(previousValue) !== protectedHash(value) ||
              protectedHash(object(object(previousGrant).body).target) !== protectedHash(target))
            throw Error("protected_command_identity_changed");
          return prior.contract;
        }
        const body = { contract: value, target, expires: Math.floor(now() / 1000) + 30 };
        const complete = { ...value, journalGrant: { body, mac: protectedSign(input.grantKey, "native-journal-grant-v1", body) } };
        await tx.insert(protectedCommandJournals).values({ commandId: command.id, pool: policy.pool,
          contract: complete, contractHash: protectedHash(complete) });
        return complete;
      });
      // Only committed rows reach the transport or independent workload guard.
      const request = await locked(async tx => {
        const [scheduler] = await tx.select().from(admissionScheduler).where(eq(admissionScheduler.singleton, true));
        if (scheduler.draining) throw Error("admission_draining");
        const [command] = await tx.select().from(admissionCommands).where(eq(admissionCommands.id, commandId));
        if (!command || command.stopped) throw Error("protected_committed_command_mismatch");
        const [attempt] = await tx.select().from(admissionAttempts).where(eq(admissionAttempts.id, owner.attemptId));
        if (!attempt || attempt.companyId !== owner.companyId || attempt.token !== owner.token || attempt.ownerEpoch !== input.epoch ||
            !["reserved", "starting"].includes(attempt.state)) throw Error("admission_ownership");
        if (attempt.runId) {
          const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, attempt.runId));
          if (!run || run.status !== "running" || readRunCancellation(run.resultJson)) throw Error("capacity_native_run_stopped");
        }
        const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, command.binding.leaseId));
        if (!lease || lease.status !== "active" || lease.releasedAt) throw Error("protected_committed_lease_mismatch");
        const priorRequests = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.pool, policy.pool));
        const dispatched = priorRequests.some(row => row.request.op === "authorizeInvocation" &&
          protectedHash(row.request.value) === protectedHash(contract));
        return requestIn(tx, dispatched ? "inspect" : "authorizeInvocation", contract);
      });
      return { contract, request };
    },
    async consumePodCreate(review: ProtectedCreateReview, authenticatedWebhook: string) {
      review = structuredClone(review);
      const authority = input.createAuthority;
      if (!authority || authenticatedWebhook !== authority.webhook ||
          review.version !== 1 || review.cluster !== authority.cluster || review.namespaceUid !== authority.namespaceUid ||
          review.webhook !== authority.webhook || review.namespace !== authority.namespace ||
          !/^[a-f0-9]{64}$/.test(review.objectHash) || !review.name || !review.reviewUid || !review.podUid ||
          Object.keys(review).sort().join(",") !== "cluster,contract,name,namespace,namespaceUid,objectHash,podUid,reviewUid,target,version,webhook")
        throw Error("protected_create_authority_mismatch");
      return locked(async tx => {
        const [scheduler] = await tx.select().from(admissionScheduler).where(eq(admissionScheduler.singleton, true));
        if (scheduler.draining) throw Error("admission_draining");
        const owner = object(review.contract.owner);
        const [attempt] = await tx.select().from(admissionAttempts).where(eq(admissionAttempts.id, String(owner.attempt))).for("update");
        if (!attempt || attempt.companyId !== owner.company || attempt.agentId !== owner.agent ||
            attempt.ownerEpoch !== input.epoch || !["reserved", "starting"].includes(attempt.state)) throw Error("admission_ownership");
        const resolved = input.capacity.forCleanup(attempt.contract);
        if (protectedHash(attempt.scopes) !== protectedHash(resolved.scopes.map(s => s.key))) throw Error("protected_create_scope_mismatch");
        const scopes = await tx.select().from(admissionScopes).where(inArray(admissionScopes.key, attempt.scopes)).for("update");
        if (scopes.length !== attempt.scopes.length || scopes.some(s => s.draining || s.capacity < 1 || (s.notBefore && s.notBefore.getTime() > now())))
          throw Error("protected_create_scope_held");
        const occupied = await tx.select().from(admissionAttempts).where(inArray(admissionAttempts.state, ["reserved", "starting", "stopping", "uncertain"]));
        if (scopes.some(scope => occupied.filter(candidate => candidate.scopes.includes(scope.key)).length > scope.capacity))
          throw Error("protected_create_scope_overcommitted");
        const holds = await tx.select().from(admissionLegacyHolds)
          .where(sql`${admissionLegacyHolds.scopes} && ARRAY[${sql.join(attempt.scopes.map(key => sql`${key}`), sql`, `)}]::text[]`);
        for (const hold of holds) if (!await legacyHoldIsReconciled(tx as unknown as Db, hold, input.epoch, now()))
          throw Error("legacy_occupancy_unreconciled");
        const commands = await tx.select().from(admissionCommands).where(eq(admissionCommands.attemptId, attempt.id)).for("update");
        const command = commands.find(c => c.binding.invocationId === review.contract.invocation);
        if (!command || command.stopped) throw Error("protected_committed_command_mismatch");
        const [journal] = await tx.select().from(protectedCommandJournals).where(eq(protectedCommandJournals.commandId, command.id));
        if (!journal || journal.pool !== policy.pool) throw Error("protected_command_unknown");
        if (journal.contract.journalHash !== protectedHash({ id: command.id, attemptId: command.attemptId, binding: command.binding,
          commandHash: command.commandHash, fenceRoot: command.fenceRoot })) throw Error("protected_create_journal_changed");
        const { journalGrant, ...contract } = journal.contract;
        if (protectedHash(journal.contract) !== journal.contractHash) throw Error("protected_create_journal_changed");
        const grant = object(object(journalGrant).body);
        authenticate(input.grantKey, "native-journal-grant-v1", grant, object(journalGrant).mac);
        if (!Number.isSafeInteger(grant.expires) || (grant.expires as number) * 1000 <= now()) throw Error("protected_create_grant_expired");
        const target = grant.target;
        if (protectedHash(contract) !== protectedHash(review.contract) || protectedHash(target) !== protectedHash(review.target) ||
            protectedHash(input.target(resolved.binding as unknown as Record<string, unknown>, attempt.id)) !== protectedHash(target))
          throw Error("protected_create_journal_changed");
        const [pin] = await tx.select().from(protectedAuthorityPins).where(eq(protectedAuthorityPins.pool, policy.pool)).for("update");
        if (!pin || pin.instance !== policy.instance || pin.policy !== policyHash || pin.epoch !== input.epoch ||
            contract.epoch !== pin.epoch || contract.generation !== pin.generation) throw Error("protected_epoch_unacknowledged");
        const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, command.binding.leaseId)).for("update");
        if (!lease || lease.status !== "active" || lease.releasedAt || lease.companyId !== attempt.companyId ||
            lease.environmentId !== resolved.binding.environmentId || lease.metadata?.agentId !== attempt.agentId ||
            lease.heartbeatRunId !== attempt.runId || (!attempt.runId && lease.metadata?.admissionOperationId !== attempt.id))
          throw Error("protected_committed_lease_mismatch");
        if (attempt.runId) {
          const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, attempt.runId));
          if (!run || run.companyId !== attempt.companyId || run.agentId !== attempt.agentId || run.status !== "running" || readRunCancellation(run.resultJson))
            throw Error("capacity_native_run_stopped");
        }
        // Dedicated deterministic UUID in existing durable request history. Never
        // expire/delete/unconsume after timeout, failed persistence or Pod loss.
        // Even an identical authenticated review is denied on retry.
        const hex = protectedHash({ domain: "native-pod-create-consume-v1", commandId: command.id }).slice(0, 32);
        const nonce = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
        const [prior] = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, nonce));
        if (prior) throw Error("protected_create_permit_consumed");
        const history = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.pool, policy.pool));
        if (history.some(row => row.request.op === "consumePodCreate" &&
          (object(row.request.value).podUid === review.podUid || object(row.request.value).reviewUid === review.reviewUid)))
          throw Error("protected_create_review_identity_reused");
        if (!await authority.attestStorage(tx, structuredClone(review))) throw Error("protected_create_storage_unattested");
        const body = { op: "consumePodCreate", value: review, commandId: command.id, consumedAt: now() };
        await tx.insert(protectedAuthorityRequests).values({ nonce, pool: policy.pool, pinRevision: pin.revision,
          request: body, requestHash: protectedHash(body), expiresAt: new Date("9999-12-31T00:00:00.000Z") });
        return { consumed: true as const, bindingHash: protectedHash(review) };
      });
    },
    /** Permanent native one-writer claim. No expiry/disconnect/restart may
     * release it. The gateway still needs its own independent enforcing backend;
     * this database transaction neither attaches a stream nor replays a body. */
    async claimStdin(value: StdinValue): Promise<ProtectedStdinClaim> {
      value = structuredClone(value);
      return locked(async tx => {
        const { binding, pin, history, command } = await validateStdin(tx, value);
        const hex = protectedHash({ domain: "native-stdin-claim-v1", commandId: command.id }).slice(0, 32);
        const nonce = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
        if (history.some(row => row.nonce === nonce)) throw Error("protected_stdin_already_claimed");
        const body = { op: "claimStdin", value: binding, claimedAt: now() };
        await tx.insert(protectedAuthorityRequests).values({ nonce, pool: pin.pool, pinRevision: pin.revision, request: body,
          requestHash: protectedHash(body), expiresAt: new Date("9999-12-31T00:00:00.000Z") });
        return { id: nonce, bindingHash: protectedHash(binding) };
      });
    },
    /** Gateway-only consumption of the already committed native writer claim.
     * The permanent record survives response loss/restart; no stream side effect
     * occurs here. An unavailable independent authority is always a refusal. */
    async consumeStdin(raw: unknown, peerIdentity: string) {
      authorityFor(peerIdentity, "gateway");
      const value = structuredClone(object(raw));
      return locked(async tx => {
        const checked = await validateAttach(tx, value);
        const ticket = nonceFor("native-stdin-consume-v1", checked.claim.id as string);
        if (checked.history.some(row => row.nonce === ticket)) throw Error("protected_stdin_already_consumed");
        const proof = await currentProof("consumeStdin", ticket, value, checked);
        // Independent verification is bounded but can consume ACK lifetime.
        // Recheck current native state and exact original pins before commit.
        await validateAttach(tx, value);
        if ((proof.body.expires as number) <= now()) throw Error("protected_stdin_current_proof_expired");
        const receipt = { version: 1 as const, status: "committed" as const, requestHash: protectedHash(value),
          pins: checked.expected, claim: checked.claim, ticket, historyRevision: proof.body.historyRevision as number };
        const body = { op: "consumeStdin", value: { attach: value, receipt,
          gatewayIdentity: peerIdentity, streamIdentity: input.stdinAuthority!.streamIdentity }, proof, consumedAt: now() };
        await tx.insert(protectedAuthorityRequests).values({ nonce: ticket, pool: policy.pool, pinRevision: checked.pin.revision,
          request: body, requestHash: protectedHash(body), expiresAt: new Date("9999-12-31T00:00:00.000Z") });
        return receipt;
      });
    },
    /** Stream-service-only one-use consumption. It authorizes attaching to the
     * exact existing stream only; never Pod creation, command execution or replay. */
    async claimStreamTicket(raw: unknown, peerIdentity: string) {
      authorityFor(peerIdentity, "stream");
      const value = structuredClone(fields(raw, "version receipt attach streamIncarnation"));
      if (value.version !== 1) throw Error("protected_stdin_invalid_request");
      identifier(value.streamIncarnation);
      const receipt = fields(value.receipt, "version status requestHash pins claim ticket historyRevision");
      identifier(receipt.ticket);
      return locked(async tx => {
        const checked = await validateAttach(tx, value.attach);
        const [ticket] = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, receipt.ticket as string)).for("update");
        if (!ticket || ticket.pool !== policy.pool || ticket.request.op !== "consumeStdin" || ticket.requestHash !== protectedHash(ticket.request))
          throw Error("protected_stdin_ticket_unknown");
        const retained = object(ticket.request.value);
        if (protectedHash(retained.receipt) !== protectedHash(receipt) || protectedHash(retained.attach) !== protectedHash(value.attach) ||
            retained.gatewayIdentity !== input.stdinAuthority!.gatewayIdentity || retained.streamIdentity !== peerIdentity)
          throw Error("protected_stdin_ticket_binding_mismatch");
        const consumptionId = nonceFor("native-stream-ticket-use-v1", receipt.ticket as string);
        if (checked.history.some(row => row.nonce === consumptionId)) throw Error("protected_stdin_stream_already_claimed");
        const proof = await currentProof("claimStreamTicket", consumptionId, value, checked);
        await validateAttach(tx, value.attach);
        if ((proof.body.expires as number) <= now()) throw Error("protected_stdin_current_proof_expired");
        const result = { version: 1 as const, status: "committed" as const, receiptHash: protectedHash(receipt), attachHash: protectedHash(value.attach),
          streamIncarnation: value.streamIncarnation, consumptionId, physical: checked.attach.physical, claim: checked.claim,
          pins: checked.expected, historyRevision: proof.body.historyRevision as number };
        const body = { op: "claimStreamTicket", value: { ticket: receipt.ticket, result,
          streamIdentity: peerIdentity }, proof, consumedAt: now() };
        await tx.insert(protectedAuthorityRequests).values({ nonce: consumptionId, pool: policy.pool, pinRevision: checked.pin.revision,
          request: body, requestHash: protectedHash(body), expiresAt: new Date("9999-12-31T00:00:00.000Z") });
        return result;
      });
    },
    /** Read immutable consumption after response loss. This returns historical
     * facts only, never a fresh grant, reset, writer reacquisition or body replay. */
    async inspectStdinTicket(raw: unknown, peerIdentity: string) {
      const authority = input.stdinAuthority;
      if (!authority || ![authority.gatewayIdentity, authority.streamIdentity].includes(peerIdentity)) throw Error("protected_stdin_peer_refused");
      const value = structuredClone(fields(raw, "ticket requestHash")); identifier(value.ticket);
      return locked(async tx => {
        const [ticket] = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, value.ticket as string));
        if (!ticket || ticket.pool !== policy.pool || ticket.request.op !== "consumeStdin" || ticket.requestHash !== protectedHash(ticket.request))
          throw Error("protected_stdin_ticket_unknown");
        const retained = object(ticket.request.value);
        const receipt = object(retained.receipt);
        if (receipt.requestHash !== value.requestHash || retained.gatewayIdentity !== authority.gatewayIdentity || retained.streamIdentity !== authority.streamIdentity)
          throw Error("protected_stdin_ticket_binding_mismatch");
        const [stream] = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce,
          nonceFor("native-stream-ticket-use-v1", value.ticket as string)));
        if (stream && (stream.request.op !== "claimStreamTicket" || stream.pool !== policy.pool || stream.requestHash !== protectedHash(stream.request)))
          throw Error("protected_stdin_history_conflict");
        return { version: 1 as const, status: stream ? "stream-claimed" : "consumed", receipt,
          streamConsumption: stream ? object(stream.request.value).result : null };
      });
    },
    async commandPhysical(commandId: string) {
      return locked(async tx => {
        const [journal] = await tx.select().from(protectedCommandJournals).where(eq(protectedCommandJournals.commandId, commandId));
        if (!journal || journal.pool !== policy.pool) throw Error("protected_command_unknown");
        const requests = await tx.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.pool, policy.pool));
        for (const row of requests) {
          if (!["authorizeInvocation", "inspect"].includes(row.request.op as string) || !row.receipt ||
              protectedHash(row.request.value) !== journal.contractHash) continue;
          const receipt = row.receipt as unknown as ProtectedEnvelope;
          authenticate(input.ackKey, "ack", receipt.body, receipt.mac);
          const result = object(receipt.body.result);
          if (result.status === "started") return structuredClone(object(result.physical));
        }
        return null;
      });
    },
    async inspectCommand(commandId: string, stop = false) {
      return locked(async tx => {
        const [journal] = await tx.select().from(protectedCommandJournals).where(eq(protectedCommandJournals.commandId, commandId));
        if (!journal || journal.pool !== policy.pool) throw Error("protected_command_unknown");
        // Inspection never creates a new authorize request or replays argv.
        return requestIn(tx, stop ? "stopAndInspect" : "inspect", journal.contract);
      });
    },
  };
}

/** Explicit host-only mTLS endpoint factory. It never binds a listener, installs
 * policy, grants capacity or accepts a peer identity from request JSON. The host
 * must configure network exposure and the independently current storage backend.
 * No production bootstrap calls this factory. */
export function protectedCreateEndpoint(options: {
  journal: Pick<ReturnType<typeof protectedExecutionJournal>, "consumePodCreate">;
  key: Buffer; certificate: Buffer; webhookCA: Buffer; webhookFingerprint: string; webhookIdentity: string;
}) {
  const { journal, webhookFingerprint, webhookIdentity } = options;
  if (!/^[a-f0-9]{64}$/.test(webhookFingerprint) || !webhookIdentity) throw Error("protected_create_endpoint_identity_required");
  const server = createServer({ key: Buffer.from(options.key), cert: Buffer.from(options.certificate),
    ca: Buffer.from(options.webhookCA), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" }, (request, response) => {
    const socket = request.socket as TLSSocket;
    const peer = socket.getPeerCertificate();
    const deny = () => { if (!response.destroyed && !response.writableEnded) { response.writeHead(403); response.end(); } };
    if (!socket.authorized || !peer.raw || createHash("sha256").update(peer.raw).digest("hex") !== webhookFingerprint ||
        request.method !== "POST" || request.url !== "/consume-pod-create" || request.headers["content-type"] !== "application/json") {
      deny(); request.resume(); return;
    }
    const chunks: Buffer[] = []; let bytes = 0;
    request.setTimeout(3000, () => request.destroy());
    request.on("error", () => { /* Ambiguous outcome never restores permission. */ });
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262144) { deny(); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      void (async () => {
        try {
          // consumePodCreate snapshots and validates before awaiting its lock.
          const result = await journal.consumePodCreate(JSON.parse(Buffer.concat(chunks).toString("utf8")), webhookIdentity);
          // The transaction has committed even if this response cannot arrive.
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(protectedCanonical(result));
        } catch { deny(); }
      })();
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return server;
}

/** Inactive role-separated endpoint factory. No listener/bootstrap caller.
 * Peer identity derives only from pinned authenticated certificate bytes. */
export function protectedStdinEndpoint(options: {
  journal: Pick<ReturnType<typeof protectedExecutionJournal>, "consumeStdin" | "claimStreamTicket" | "inspectStdinTicket">;
  key: Buffer; certificate: Buffer; clientCA: Buffer;
  gatewayFingerprint: string; gatewayIdentity: string; streamFingerprint: string; streamIdentity: string;
}) {
  const { journal, gatewayFingerprint, gatewayIdentity, streamFingerprint, streamIdentity } = options;
  if (![gatewayFingerprint, streamFingerprint].every(f => /^[a-f0-9]{64}$/.test(f)) || gatewayFingerprint === streamFingerprint ||
      !gatewayIdentity || !streamIdentity || gatewayIdentity === streamIdentity) throw Error("protected_stdin_distinct_peer_identities_required");
  const server = createServer({ key: Buffer.from(options.key), cert: Buffer.from(options.certificate), ca: Buffer.from(options.clientCA),
    requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" }, (request, response) => {
    const socket = request.socket as TLSSocket;
    const peer = socket.getPeerCertificate();
    const fingerprint = peer.raw ? createHash("sha256").update(peer.raw).digest("hex") : "";
    const role = fingerprint === gatewayFingerprint ? "gateway" : fingerprint === streamFingerprint ? "stream" : null;
    const identity = role === "gateway" ? gatewayIdentity : streamIdentity;
    const route = request.url;
    const deny = () => { if (!response.destroyed && !response.writableEnded) { response.writeHead(403); response.end(); } };
    if (!socket.authorized || !role || request.method !== "POST" || request.headers["content-type"] !== "application/json" ||
        !(route === "/v1/stdin/inspect" || (role === "gateway" && route === "/v1/stdin/consume") ||
          (role === "stream" && route === "/v1/stdin/claim-stream"))) { deny(); request.resume(); return; }
    const deadline = setTimeout(() => request.destroy(), 5000);
    const clear = () => clearTimeout(deadline);
    response.once("finish", clear); response.once("close", clear);
    const chunks: Buffer[] = []; let bytes = 0;
    request.on("error", () => { /* Uncertain commit remains permanently charged. */ });
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16384) { deny(); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      void (async () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          const value = JSON.parse(text);
          // Canonical-only bodies reject duplicate keys and ambiguity; both fixed
          // clients emit this wire format. Never use requester peer/audience fields.
          if (text !== protectedCanonical(value)) throw Error("protected_stdin_noncanonical_request");
          const result = route === "/v1/stdin/consume" ? await journal.consumeStdin(value, identity) :
            route === "/v1/stdin/claim-stream" ? await journal.claimStreamTicket(value, identity) : await journal.inspectStdinTicket(value, identity);
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(protectedCanonical(result));
        } catch { deny(); }
      })();
    });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  return server;
}
