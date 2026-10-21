import { legacyHoldIsReconciled } from "./execution-legacy-reconciliation.js";
import { installExecutionCapacity, scheduleCapacityProgress } from "./execution-capacity-context.js";
import { admissionOperationMethods } from "./execution-admission-operations.js";
import type { trustedCapacityPolicy } from "./execution-capacity-policy.js";
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import {
  admissionAttempts, admissionEpochs, admissionLegacyHolds, admissionProjects, admissionScheduler,
  admissionScopes, agents, environmentLeases, heartbeatRuns, issues, type Db,
} from "@paperclipai/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Attempt = typeof admissionAttempts.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
const occupied = ["reserved", "starting", "stopping", "uncertain"] as const;
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class NativeClaimDeferred extends Error {}

/** Candidate host-only boundary. Injected into queue tests; no production activation.
 * All writers take scheduler first, then native issue -> wake -> run locks.
 * The native claim callback must contain database work only, preserve existing
 * eligibility/checkout authority, and defer notifications until this commits.
 * Auxiliary identities, command journals and restoration share this ownership
 * boundary; explicit trusted host installation remains required.
 */
export function executionAdmissionService(db: Db, epoch: string, policy?: ReturnType<typeof trustedCapacityPolicy>, options: { startsHeld?: boolean } = {}) {
  const startsHeld = options.startsHeld === true;
  if (!canonicalUuid.test(epoch)) throw new Error("invalid_admission_epoch");
  async function locked<T>(body: (tx: Transaction, scheduler: typeof admissionScheduler.$inferSelect, now: Date) => Promise<T>) {
    return db.transaction(async tx => {
      const [scheduler] = await tx.select().from(admissionScheduler).for("update");
      if (!scheduler || scheduler.epoch !== epoch) throw new Error("stale_admission_controller");
      const [clock] = await tx.select({ now: sql<Date>`clock_timestamp()` }).from(admissionScheduler);
      return body(tx, scheduler, new Date(clock.now));
    });
  }
  async function owned(tx: Transaction, companyId: string, attemptId: string, token: string) {
    const [attempt] = await tx.select().from(admissionAttempts).where(and(
      eq(admissionAttempts.companyId, companyId), eq(admissionAttempts.id, attemptId),
    )).for("update");
    if (!attempt || attempt.ownerEpoch !== epoch || attempt.token !== token) throw new Error("admission_ownership");
    return attempt;
  }
  async function wait(tx: Transaction, attempt: Attempt, reason: string) {
    await tx.update(admissionAttempts).set({ waitReason: reason, updatedAt: new Date() })
      .where(eq(admissionAttempts.id, attempt.id));
  }
  async function claimNext(claimNative: (tx: Transaction, run: Run) => Promise<Run | null>,
    requested?: { companyId: string; runId?: string; operationId?: string }) {
    return locked(async (tx, scheduler, now) => {
      if (startsHeld || scheduler.draining) {
        await tx.update(admissionAttempts).set({ waitReason: "instance_draining" }).where(eq(admissionAttempts.state, "queued"));
        return null;
      }
      const exempt = scheduler.evaluationExemptionUntil && scheduler.evaluationExemptionUntil > now;
      const fresh = scheduler.recoveryPoint && scheduler.recoveryPoint <= now &&
        now.getTime() - scheduler.recoveryPoint.getTime() < 3_600_000;
      if (!exempt && !fresh) {
        await tx.update(admissionAttempts).set({ waitReason: "backup_stale_or_unknown" }).where(eq(admissionAttempts.state, "queued"));
        return null;
      }
      const candidates = await tx.select({ attempt: admissionAttempts }).from(admissionAttempts)
        .innerJoin(admissionProjects, and(eq(admissionProjects.companyId, admissionAttempts.companyId),
          eq(admissionProjects.projectKey, admissionAttempts.projectKey)))
        .where(eq(admissionAttempts.state, "queued"))
        .orderBy(asc(admissionProjects.lastGrant), asc(admissionAttempts.enqueueOrder));
      for (const { attempt } of candidates) {
        if (attempt.runId) {
          const [native] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, attempt.runId), eq(heartbeatRuns.companyId, attempt.companyId)));
          if (!native || native.status !== "queued") {
            await tx.update(admissionAttempts).set({ state: native?.status === "running" ? "uncertain" : "cancelled",
              waitReason: "native_run_not_queued", updatedAt: now }).where(eq(admissionAttempts.id, attempt.id));
            continue;
          }
        }
        if (policy) {
          try {
            const resolved = await policy.resolve(tx, attempt.companyId, attempt.agentId);
            if (JSON.stringify(resolved.scopes.map(s => s.key)) !== JSON.stringify(attempt.scopes))
              throw new Error("capacity_identity_changed");
          } catch {
            await wait(tx, attempt, "capacity_configuration_changed");
            continue;
          }
        }
        const scopes = await tx.select().from(admissionScopes).where(inArray(admissionScopes.key, attempt.scopes))
          .orderBy(asc(admissionScopes.key)).for("update");
        let reason: string | null = scopes.length !== attempt.scopes.length ? "unknown_scope" : null;
        // A scope drain can be changed independently. Historical holds remain
        // an additional gate, including unknown occupancy at instance scope.
        const historical = await tx.select().from(admissionLegacyHolds)
          .where(sql`${admissionLegacyHolds.scopes} && ARRAY[${sql.join(attempt.scopes.map(key => sql`${key}`), sql`, `)}]::text[]`);
        let legacy = false;
        for (const hold of historical) {
          if (!await legacyHoldIsReconciled(tx as unknown as Db, hold, epoch, now.getTime())) { legacy = true; break; }
        }
        if (legacy) reason = "legacy_occupancy_unreconciled";
        for (const scope of legacy ? [] : scopes) {
          if (scope.draining) { reason = "scope_draining"; break; }
          if (scope.notBefore && scope.notBefore > now) { reason = "provider_cooldown"; break; }
          const [usage] = await tx.select({ count: count() }).from(admissionAttempts).where(and(
            inArray(admissionAttempts.state, [...occupied]), sql`${scope.key} = any(${admissionAttempts.scopes})`,
          ));
          if (usage.count >= scope.capacity) { reason = "capacity:" + scope.key; break; }
        }
        if (reason) { await wait(tx, attempt, reason); continue; }
        if (requested && attempt.runId && attempt.runId !== requested.runId &&
            (!attempt.eligibleUntil || attempt.eligibleUntil <= now)) {
          await wait(tx, attempt, "native_preflight_pending");
          continue;
        }
        if (!attempt.runId) {
          if (attempt.id !== requested?.operationId || attempt.companyId !== requested.companyId) {
            // An auxiliary caller owns its whole lifetime. A native queue scan
            // must never launch a probe on behalf of an absent caller.
            await wait(tx, attempt, "operation_ready");
            if (attempt.eligibleUntil && attempt.eligibleUntil > now) return null;
            continue;
          }
          const sequence = scheduler.sequence + 1n;
          await tx.update(admissionScheduler).set({ sequence });
          await tx.update(admissionProjects).set({ lastGrant: sequence }).where(and(
            eq(admissionProjects.companyId, attempt.companyId), eq(admissionProjects.projectKey, attempt.projectKey)));
          const [reservation] = await tx.update(admissionAttempts).set({ state: "reserved", ownerEpoch: epoch,
            token: randomUUID(), grantOrder: sequence, waitReason: null, updatedAt: now,
          }).where(eq(admissionAttempts.id, attempt.id)).returning();
          return { run: null, reservation };
        }
        const [run] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, attempt.runId), eq(heartbeatRuns.companyId, attempt.companyId),
        ));
        if (!run || run.status !== "queued") {
          await tx.update(admissionAttempts).set({ state: "cancelled", waitReason: "native_run_not_queued" })
            .where(eq(admissionAttempts.id, attempt.id));
          continue;
        }
        const [issue] = run.issueId ? await tx.select().from(issues).where(and(
          eq(issues.id, run.issueId), eq(issues.companyId, run.companyId),
        )) : [];
        if ((run.issueId && !issue) || run.agentId !== attempt.agentId || run.issueId !== attempt.issueId ||
            (issue?.projectId ?? "company") !== attempt.projectKey) {
          await wait(tx, attempt, "native_identity_changed");
          continue;
        }
        // A native queue caller may claim only its prepared run. It must not
        // consume a sibling's grant or jump the global fairness frontier.
        if (requested && (requested.runId !== run.id || requested.companyId !== run.companyId)) {
          await tx.update(admissionAttempts).set({ waitReason: "fair_queue_turn", updatedAt: now }).where(and(
            eq(admissionAttempts.companyId, requested.companyId), requested.runId
              ? eq(admissionAttempts.runId, requested.runId) : eq(admissionAttempts.id, requested.operationId!),
            eq(admissionAttempts.state, "queued"),
          ));
          return null;
        }
        let claimed: Run;
        try {
          claimed = await tx.transaction(async claimTx => {
            const result = await claimNative(claimTx, run);
            if (!result) throw new NativeClaimDeferred();
            const [persisted] = await claimTx.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, attempt.companyId),
            ));
            if (!persisted || result.id !== run.id || result.companyId !== run.companyId || result.agentId !== run.agentId ||
                (persisted.status !== "running" && !(requested && ["cancelled", "failed", "timed_out"].includes(persisted.status))) ||
                persisted.agentId !== attempt.agentId || persisted.issueId !== attempt.issueId) throw new Error("native_claim_binding_changed");
            const [currentIssue] = persisted.issueId ? await claimTx.select().from(issues).where(and(
              eq(issues.id, persisted.issueId), eq(issues.companyId, persisted.companyId),
            )) : [];
            if ((persisted.issueId && !currentIssue) || (currentIssue?.projectId ?? "company") !== attempt.projectKey)
              throw new Error("native_claim_binding_changed");
            return persisted;
          });
        } catch (error) {
          if (!(error instanceof NativeClaimDeferred)) throw error;
            await wait(tx, attempt, "native_ineligible");
            await tx.update(admissionAttempts).set({ eligibleUntil: null }).where(eq(admissionAttempts.id, attempt.id));
          continue;
        }
        // Native discard/close decisions commit without taking capacity or
        // advancing fairness. They are not null/deferred claims.
        if (claimed.status !== "running") {
          const [reservation] = await tx.update(admissionAttempts).set({ state: "cancelled",
            waitReason: "native_claim_terminal", updatedAt: now,
          }).where(eq(admissionAttempts.id, attempt.id)).returning();
          return { run: claimed, reservation };
        }
        if (policy) await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) - 'executionCapacity'` })
          .where(and(eq(heartbeatRuns.id, claimed.id), eq(heartbeatRuns.companyId, claimed.companyId)));
        const sequence = scheduler.sequence + 1n;
        await tx.update(admissionScheduler).set({ sequence });
        await tx.update(admissionProjects).set({ lastGrant: sequence }).where(and(
          eq(admissionProjects.companyId, attempt.companyId), eq(admissionProjects.projectKey, attempt.projectKey),
        ));
        const [reservation] = await tx.update(admissionAttempts).set({ state: "reserved", ownerEpoch: epoch,
          token: randomUUID(), grantOrder: sequence, waitReason: null, updatedAt: now,
        }).where(eq(admissionAttempts.id, attempt.id)).returning();
        return { run: claimed, reservation };
      }
      return null;
    });
  }
  const service = {
    ...admissionOperationMethods({ db, epoch, policy, startsHeld, locked, owned,
      claim: (companyId, operationId) => claimNext(async () => null, { companyId, operationId }),
    }),
    // Explicit host bootstrap/policy provisioning remains outside this service.
    // No automatic default policy or root initialization may clear old holds.
    async registerRun(input: { companyId: string; runId: string; scopes?: readonly string[] }) {
      const { companyId, runId } = input;
      const requestedScopes = input.scopes ? [...input.scopes] : undefined;
      if (policy && requestedScopes) throw new Error("caller_capacity_scopes_forbidden");
      return locked(async (tx, scheduler) => {
        const [run] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
        ));
        if (!run || run.status !== "queued") throw new Error("native_run_not_queued");
        const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(
          eq(agents.companyId, companyId), eq(agents.id, run.agentId),
        ));
        if (!agent) throw new Error("native_agent_company_mismatch");
        const resolved = policy ? await policy.resolve(tx, companyId, run.agentId) : null;
        const scopes = resolved ? resolved.scopes.map(s => s.key) : [...new Set(requestedScopes ?? [])].sort();
        if (!scopes.length || scopes.some(key => !key.trim())) throw new Error("invalid_admission_scopes");
        if (resolved) {
          // Never reset drain/cooldown/revision or raise an existing limit while
          // registering a new agent. Policy changes require an explicit drain.
          for (const scope of resolved.scopes) {
            await tx.insert(admissionScopes).values(scope).onConflictDoNothing();
            const [stored] = await tx.select().from(admissionScopes).where(eq(admissionScopes.key, scope.key));
            if (stored.capacity !== scope.capacity) throw new Error("capacity_policy_conflict");
          }
        }
        // Fairness uses the persisted issue relation, never a caller project ID.
        const [issue] = run.issueId ? await tx.select().from(issues).where(and(
          eq(issues.companyId, companyId), eq(issues.id, run.issueId),
        )) : [];
        if (run.issueId && !issue) throw new Error("native_issue_company_mismatch");
        const projectKey = issue?.projectId ?? "company";
        const [existing] = await tx.select().from(admissionAttempts).where(and(
          eq(admissionAttempts.runId, runId), inArray(admissionAttempts.state, ["queued", ...occupied]),
        ));
        if (existing) {
          if (existing.companyId !== companyId || existing.projectKey !== projectKey || existing.agentId !== run.agentId || existing.issueId !== run.issueId ||
              JSON.stringify(existing.scopes) !== JSON.stringify(scopes)) throw new Error("admission_identity_changed");
          return existing;
        }
        const [pending] = await tx.select({ count: count() }).from(admissionAttempts).where(eq(admissionAttempts.state, "queued"));
        if (pending.count >= scheduler.pendingLimit) throw new Error("admission_queue_full");
        const known = await tx.select().from(admissionScopes).where(inArray(admissionScopes.key, scopes));
        if (known.length !== scopes.length) throw new Error("unknown_admission_scope");
        await tx.insert(admissionProjects).values({ companyId, projectKey, lastGrant: scheduler.sequence }).onConflictDoNothing();
        const [attempt] = await tx.insert(admissionAttempts).values({ companyId, runId, agentId: run.agentId, issueId: run.issueId, projectKey, scopes,
          contract: resolved ? resolved.binding as unknown as Record<string, unknown> : null }).returning();
        return attempt;
      });
    },
    async prepareRun(companyId: string, runId: string, eligible: boolean) {
      if (eligible && policy) {
        try { await service.registerRun({ companyId, runId }); }
        catch (error) {
          if (!(error instanceof Error) || !["capacity_agent_unconfigured", "capacity_configuration_changed", "capacity_policy_conflict",
            "admission_identity_changed", "admission_queue_full", "native_run_not_queued"].includes(error.message)) throw error;
          eligible = false;
        }
      }
      if (eligible) scheduleCapacityProgress(db);
      await locked(async (tx, _scheduler, now) => {
        await tx.update(admissionAttempts).set({ eligibleUntil: eligible ? new Date(now.getTime() + 5_000) : null })
          .where(and(eq(admissionAttempts.companyId, companyId), eq(admissionAttempts.runId, runId), eq(admissionAttempts.state, "queued")));
      });
    },
    async queuedAgents() {
      const rows = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
        .leftJoin(admissionAttempts, and(eq(admissionAttempts.runId, heartbeatRuns.id), eq(admissionAttempts.state, "queued")))
        .leftJoin(admissionProjects, and(eq(admissionProjects.companyId, admissionAttempts.companyId),
          eq(admissionProjects.projectKey, admissionAttempts.projectKey)))
        .where(eq(heartbeatRuns.status, "queued"))
        .orderBy(sql`coalesce(${admissionProjects.lastGrant}, 0)`, asc(heartbeatRuns.createdAt));
      return [...new Set(rows.map(row => row.agentId))];
    },
    /** Select globally; a per-agent caller cannot leapfrog older projects.
     * Null native claims roll back their savepoint, including partial writes.
     * Exceptions roll back the whole grant and fairness cursor. No retry here.
     */
    async claimNext(claimNative: (tx: Transaction, run: Run) => Promise<Run | null>) {
      const grant = await claimNext(claimNative);
      return grant?.run ? { run: grant.run, reservation: grant.reservation } : null;
    },
    /** Host-injected native queue transaction; no registration or policy default.
     * The callback performs database work only. Deferred partial writes roll
     * back; native cancellation commits without a grant. Effects follow commit.
     */
    async claimTransaction<T>(run: Pick<Run, "id" | "companyId">, body: (tx: Transaction) => Promise<T>): Promise<T | null> {
      if (policy) {
        try { await service.registerRun({ companyId: run.companyId, runId: run.id }); }
        catch (error) {
          if (!(error instanceof Error) || !["capacity_agent_unconfigured", "capacity_configuration_changed",
            "capacity_policy_conflict", "admission_identity_changed", "admission_queue_full"].includes(error.message)) throw error;
          await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
            ${JSON.stringify({ executionCapacity: { state: "waiting", reason: error.message } })}::jsonb` })
            .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "queued")));
          return null;
        }
      }
      let value: T | null = null;
      const grant = await claimNext(async (tx, candidate) => {
        value = await body(tx);
        if (value == null) return null;
        const [persisted] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, candidate.id), eq(heartbeatRuns.companyId, candidate.companyId),
        ));
        return persisted && persisted.status !== "queued" ? persisted : null;
      }, { companyId: run.companyId, runId: run.id });
      if (!grant && policy) {
        const [attempt] = await db.select().from(admissionAttempts).where(and(
          eq(admissionAttempts.companyId, run.companyId), eq(admissionAttempts.runId, run.id), eq(admissionAttempts.state, "queued"),
        ));
        if (attempt) await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
          ${JSON.stringify({ executionCapacity: { state: "waiting", reason: attempt.waitReason ?? "native_ineligible" } })}::jsonb` })
          .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "queued")));
      }
      return grant ? value : null;
    },
    async assertRunReady(companyId: string, runId: string, environmentId?: string) {
      if (startsHeld) throw new Error("capacity_bootstrap_held");
      if (!policy) throw new Error("trusted_capacity_policy_required");
      return locked(async tx => {
        const [attempt] = await tx.select().from(admissionAttempts).where(and(
          eq(admissionAttempts.companyId, companyId), eq(admissionAttempts.runId, runId),
          inArray(admissionAttempts.state, ["reserved", "starting"]),
        ));
        if (!attempt || attempt.ownerEpoch !== epoch) throw new Error("capacity_reservation_required");
        const resolved = await policy.resolve(tx, companyId, attempt.agentId);
        if (JSON.stringify(resolved.scopes.map(s => s.key)) !== JSON.stringify(attempt.scopes) ||
            (environmentId !== undefined && environmentId !== resolved.binding.environmentId))
          throw new Error("capacity_identity_changed");
        const [run] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"),
        ));
        if (!run || run.agentId !== attempt.agentId) throw new Error("capacity_native_run_stopped");
        return resolved.binding;
      });
    },
    async runReservation(companyId: string, runId: string) {
      if (startsHeld) throw new Error("capacity_bootstrap_held");
      return locked(async tx => {
        const [attempt] = await tx.select().from(admissionAttempts).where(and(eq(admissionAttempts.companyId, companyId),
          eq(admissionAttempts.runId, runId), inArray(admissionAttempts.state, ["reserved", "starting"])));
        if (!attempt || attempt.ownerEpoch !== epoch || !attempt.token) throw new Error("capacity_reservation_required");
        return attempt;
      });
    },
    journalLaunch(input: { companyId: string; attemptId: string; token: string; leaseId: string; invocationId: string }) {
      if (startsHeld) throw new Error("capacity_bootstrap_held");
      const snapshot = { ...input };
      if (!canonicalUuid.test(snapshot.invocationId)) throw new Error("invalid_admission_invocation");
      return locked(async (tx, _scheduler, now) => {
        const attempt = await owned(tx, snapshot.companyId, snapshot.attemptId, snapshot.token);
        if (attempt.state !== "reserved" || !attempt.runId) throw new Error("admission_launch_consumed");
        const [run] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, attempt.runId), eq(heartbeatRuns.companyId, attempt.companyId),
        )).for("update");
        const [lease] = await tx.select().from(environmentLeases).where(and(
          eq(environmentLeases.id, snapshot.leaseId), eq(environmentLeases.companyId, attempt.companyId),
          eq(environmentLeases.heartbeatRunId, attempt.runId),
        )).for("update");
        if (!run || run.status !== "running" || run.agentId !== attempt.agentId || run.issueId !== attempt.issueId || !lease || lease.provider !== "ssh" ||
            lease.status !== "active" || lease.releasedAt || !lease.environmentId ||
            lease.metadata?.agentId !== run.agentId) throw new Error("admission_lease_binding_changed");
        if (policy) {
          const resolved = await policy.resolve(tx, attempt.companyId, attempt.agentId);
          if (lease.environmentId !== resolved.binding.environmentId ||
              JSON.stringify(resolved.scopes.map(s => s.key)) !== JSON.stringify(attempt.scopes))
            throw new Error("capacity_identity_changed");
        }
        const binding = { epoch, companyId: attempt.companyId, agentId: run.agentId, runId: run.id,
          attemptId: attempt.id, environmentId: lease.environmentId, leaseId: lease.id, invocationId: snapshot.invocationId };
        await tx.update(admissionAttempts).set({ state: "starting", binding, updatedAt: now }).where(eq(admissionAttempts.id, attempt.id));
        // The binding is returned only after commit. A lost response must not
        // replay launch. Transport still needs a canonical policy-owned root.
        return binding;
      });
    },
    cancel(companyId: string, attemptId: string) {
      return locked(async (tx, _scheduler, now) => {
        const [attempt] = await tx.select().from(admissionAttempts).where(and(
          eq(admissionAttempts.companyId, companyId), eq(admissionAttempts.id, attemptId),
        )).for("update");
        if (!attempt) throw new Error("unknown_admission_attempt");
        if (["released", "cancelled"].includes(attempt.state)) return attempt;
        const [result] = await tx.update(admissionAttempts).set({
          state: attempt.state === "queued" ? "cancelled" : attempt.state === "uncertain" ? "uncertain" : "stopping",
          waitReason: "cancel_requested", updatedAt: now,
        }).where(eq(admissionAttempts.id, attempt.id)).returning();
        return result;
      });
    },
    takeover(nextEpoch: string) {
      if (!canonicalUuid.test(nextEpoch)) throw new Error("invalid_admission_epoch");
      return locked(async (tx, _scheduler, now) => {
        // Unique durable history rejects ABA epoch reuse, not just current CAS.
        await tx.insert(admissionEpochs).values({ epoch: nextEpoch });
        await tx.update(admissionScheduler).set({ epoch: nextEpoch, draining: true });
        await tx.update(admissionAttempts).set({ state: "uncertain", updatedAt: now })
          .where(inArray(admissionAttempts.state, [...occupied]));
      });
    },
  };
  if (policy) installExecutionCapacity(db, service);
  return service;
}
