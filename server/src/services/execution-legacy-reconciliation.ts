import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { admissionAttempts, admissionLegacyDecisions, admissionLegacyHolds, admissionScheduler, environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { capacityFingerprint } from "./execution-capacity-policy.js";
import { scheduleAgentLifecycle } from "../modules/agent-lifecycle/index.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
const decisionSchema = z.object({
  kind: z.literal("present-day-legacy-reconciliation-v1"),
  action: z.enum(["reconcile", "revoke"]), source: z.string().min(1), sequence: z.number().int().positive().safe(),
  previousHash: hash.nullable(), holdHash: hash, companyId: id, agentId: id, runId: id, leaseId: id,
  environmentId: id, scopes: z.array(z.string().min(1)).min(1), policyHash: hash, epoch: id,
  observedAt: z.number().int(), expiresAt: z.number().int(),
  // These are content hashes of independent protected evidence artifacts, never
  // provider receipts. The host signer must verify each artifact before signing.
  routeRevocationHash: hash, retiredIncarnationHash: hash, wholePodStopHash: hash,
  restoration: z.object({ workspace: hash, session: hash, credential: hash }).strict(),
  operatorApprovalHash: hash,
}).strict();
export type LegacyDecision = z.infer<typeof decisionSchema>;
export type LegacyHold = typeof admissionLegacyHolds.$inferSelect;
export function legacyHoldFingerprint(hold: LegacyHold) {
  return capacityFingerprint({ source: hold.source, companyId: hold.companyId, agentId: hold.agentId,
    runId: hold.runId, environmentId: hold.environmentId, scopes: hold.scopes,
    evidence: hold.evidence, evidenceHash: hold.evidenceHash, policyHash: hold.policyHash });
}
function exact(hold: LegacyHold, decision: LegacyDecision, epoch: string, now: number) {
  return decision.source === hold.source && decision.holdHash === legacyHoldFingerprint(hold) &&
    decision.companyId === hold.companyId && decision.agentId === hold.agentId && decision.runId === hold.runId &&
    decision.environmentId === hold.environmentId && hold.source === `lease:${decision.leaseId}` &&
    decision.policyHash === hold.policyHash && decision.epoch === epoch &&
    JSON.stringify(decision.scopes) === JSON.stringify(hold.scopes) &&
    decision.observedAt <= now && decision.observedAt >= now - 3_600_000 && decision.expiresAt > now &&
    decision.expiresAt <= decision.observedAt + 3_600_000;
}
export async function legacyHoldIsReconciled(db: Db, hold: LegacyHold, epoch: string, _now = Date.now()) {
  const [latest] = await db.select().from(admissionLegacyDecisions).where(eq(admissionLegacyDecisions.source, hold.source))
    .orderBy(desc(admissionLegacyDecisions.sequence)).limit(1);
  // Evidence must be fresh when accepted. Accepted retirement/restoration facts
  // survive the observation window until explicit revocation or epoch/binding change.
  if (!latest || latest.decisionHash !== capacityFingerprint(latest.decision)) return false;
  const parsed = decisionSchema.safeParse(latest.decision);
  return parsed.success && parsed.data.action === "reconcile" && exact(hold, parsed.data, epoch, latest.createdAt.getTime());
}
export async function legacyLeaseIsReconciled(db: Db, lease: { id: string; companyId: string; heartbeatRunId: string | null;
  environmentId: string | null }, agentId: string, now = Date.now()) {
  const [scheduler] = await db.select().from(admissionScheduler);
  if (!scheduler) return false;
  const [hold] = await db.select().from(admissionLegacyHolds).where(and(eq(admissionLegacyHolds.source, `lease:${lease.id}`),
    eq(admissionLegacyHolds.companyId, lease.companyId), eq(admissionLegacyHolds.agentId, agentId)));
  return Boolean(hold && hold.runId === lease.heartbeatRunId && hold.environmentId === lease.environmentId &&
    await legacyHoldIsReconciled(db, hold, scheduler.epoch, now));
}
/** Host-only service: no HTTP route and no start/drain/receipt/lifecycle writes.
 * proofKey is separate from provider/runtime/control keys. An operational signer
 * needs independent route retirement, whole-incarnation stop, storage and review
 * verification. Synthetic signed artifacts do not establish those live facts.
 */
export type LegacyEvidenceReview = { decisionHash: string; inventoryHash: string; expiresAt: number };
/** Protected host verifier must authenticate independent evidence and operator review
 * against this COMPLETE locked native inventory. Never accept caller-supplied hold
 * lists, signing-key possession alone, fixture observers or provider assertions.
 * This hook is a mandatory integration boundary, not an operational signer.
 */
export type LegacyEvidenceVerifier = (input: { decision: LegacyDecision; holds: LegacyHold[];
  inventoryHash: string; now: number }) => Promise<LegacyEvidenceReview>;
export function legacyReconciliationService(db: Db, options: { epoch: string; policyHash: string; proofKey: Buffer;
  verifyEvidence: LegacyEvidenceVerifier; now?: () => number }) {
  if (typeof options.verifyEvidence !== "function") throw Error("legacy_independent_evidence_verifier_required");
  const verifyEvidence = options.verifyEvidence;
  if (options.proofKey.length < 32) throw Error("legacy_proof_key_too_short");
  const now = options.now ?? Date.now;
  const epoch = options.epoch;
  const policyHash = options.policyHash;
  const proofKey = Buffer.from(options.proofKey);
  return {
    async append(envelope: { decision: unknown; signature: string }) {
      const decision = decisionSchema.parse(envelope.decision);
      const digest = capacityFingerprint(decision);
      const expected = createHmac("sha256", proofKey).update(digest).digest();
      const received = /^[a-f0-9]{64}$/.test(envelope.signature) ? Buffer.from(envelope.signature, "hex") : Buffer.alloc(0);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw Error("legacy_proof_unauthenticated");
      const result = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(174510, 1)`);
        const [scheduler] = await tx.select().from(admissionScheduler).for("update");
        if (!scheduler || scheduler.epoch !== epoch || !scheduler.draining) throw Error("legacy_requires_current_drain");
        const [hold] = await tx.select().from(admissionLegacyHolds).where(eq(admissionLegacyHolds.source, decision.source)).for("update");
        if (!hold || decision.policyHash !== policyHash || !exact(hold, decision, epoch, now()))
          throw Error("legacy_evidence_binding_or_freshness");
        const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, decision.runId)).for("update");
        const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, decision.leaseId)).for("update");
        if (!run || run.companyId !== hold.companyId || run.agentId !== hold.agentId ||
            !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status) ||
            !lease || lease.companyId !== hold.companyId || lease.heartbeatRunId !== run.id || lease.environmentId !== hold.environmentId)
          throw Error("legacy_native_identity_or_activity_changed");
        const active = await tx.select().from(admissionAttempts);
        if (active.some(attempt => !["queued", "released", "cancelled"].includes(attempt.state) &&
            attempt.scopes.some(scope => hold.scopes.includes(scope)))) throw Error("legacy_active_shared_owner");
        // The same advisory/scheduler lock orders inventory against supported
        // bootstrap/reconciliation. Lock every hold, including other agents and
        // companies sharing account/state families. The verifier receives the
        // complete authoritative inventory; filtered caller evidence cannot clear B.
        const holds = await tx.select().from(admissionLegacyHolds).for("update");
        const inventoryHash = capacityFingerprint(holds.map(value => ({ source: value.source,
          holdHash: legacyHoldFingerprint(value) })).sort((a, b) => a.source.localeCompare(b.source)));
        const reviewed = await verifyEvidence({ decision: structuredClone(decision),
          holds: structuredClone(holds), inventoryHash, now: now() });
        if (reviewed?.decisionHash !== digest || reviewed?.inventoryHash !== inventoryHash)
          throw Error("legacy_independent_evidence_review_mismatch");
        const acceptedAt = now();
        // The decision can outlive its shortest-lived inventory/artifact. Never
        // turn an expired independent review into a durable reconciliation.
        if (!Number.isSafeInteger(reviewed.expiresAt) || reviewed.expiresAt <= acceptedAt ||
            reviewed.expiresAt > acceptedAt + 60_000 || reviewed.expiresAt > decision.expiresAt ||
            !exact(hold, decision, epoch, acceptedAt)) throw Error("legacy_evidence_expired_during_review");
        const [previous] = await tx.select().from(admissionLegacyDecisions).where(eq(admissionLegacyDecisions.source, hold.source))
          .orderBy(desc(admissionLegacyDecisions.sequence)).limit(1);
        if (decision.sequence !== Number(previous?.sequence ?? 0n) + 1 || decision.previousHash !== (previous?.decisionHash ?? null))
          throw Error("legacy_decision_cas");
        await tx.insert(admissionLegacyDecisions).values({ source: hold.source, sequence: BigInt(decision.sequence),
          decisionHash: digest, decision });
        return { decisionHash: digest, agentId: hold.agentId! };
      });
      // Supported coordinator entry point; a crash before scheduling is recovered
      // by its normal sweep. Manual lifecycle holds remain coordinator policy.
      await scheduleAgentLifecycle(db, result.agentId);
      return result;
    },
  };
}
