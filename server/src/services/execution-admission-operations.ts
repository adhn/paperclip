import { scheduleCapacityProgress } from "./execution-capacity-context.js";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { admissionAttempts, admissionCommands, admissionProjects, admissionRestorations, admissionRunnerEpochs, admissionScopes, agents, environmentLeases, heartbeatRuns,
  type admissionScheduler, type Db, type AdmissionLaunchBinding } from "@paperclipai/db";
import { capacityFingerprint, type trustedCapacityPolicy } from "./execution-capacity-policy.js";
import { readRunCancellation } from "./run-cancellation.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Attempt = typeof admissionAttempts.$inferSelect;
type Owner = { companyId: string; attemptId: string; token: string };
type Restoration = "workspace" | "session" | "credential";
type Dependencies = {
  db: Db; epoch: string; startsHeld?: boolean; policy?: ReturnType<typeof trustedCapacityPolicy>;
  locked<T>(body: (tx: Tx, scheduler: typeof admissionScheduler.$inferSelect, now: Date) => Promise<T>): Promise<T>;
  owned(tx: Tx, companyId: string, attemptId: string, token: string): Promise<Attempt>;
  claim(companyId: string, operationId: string): Promise<{ reservation: Attempt } | null>;
};
const occupied = ["reserved", "starting", "stopping", "uncertain"] as const;

/** Host service only. No public receipt submission or expiry-based release. */
export function admissionOperationMethods({ db, epoch, policy, startsHeld, locked, owned, claim }: Dependencies) {
  return {
    async stoppingReservations() {
      return locked(tx => tx.select().from(admissionAttempts).where(and(
        eq(admissionAttempts.ownerEpoch, epoch), eq(admissionAttempts.state, "stopping"))));
    },
    async agentOperations(agentIds: string[]) {
      return locked(tx => tx.select().from(admissionAttempts).where(and(inArray(admissionAttempts.agentId, agentIds),
        isNull(admissionAttempts.runId), inArray(admissionAttempts.state, ["queued", ...occupied]))));
    },
    async commandsForAttempt(companyId: string, attemptId: string) {
      return locked(async tx => {
        const [attempt] = await tx.select().from(admissionAttempts).where(and(eq(admissionAttempts.companyId, companyId),
          eq(admissionAttempts.id, attemptId)));
        if (!attempt) throw new Error("admission_ownership");
        const commands = await tx.select().from(admissionCommands).where(and(eq(admissionCommands.attemptId, attemptId),
          eq(admissionCommands.stopped, false)));
        return { attempt, commands };
      });
    },
    async adoptReservation(companyId: string, attemptId: string) {
      return locked(async (tx, _scheduler, now) => {
        const [attempt] = await tx.select().from(admissionAttempts).where(and(eq(admissionAttempts.companyId, companyId),
          eq(admissionAttempts.id, attemptId))).for("update");
        if (!attempt || attempt.state !== "uncertain" || attempt.ownerEpoch === epoch || !policy)
          throw new Error("admission_reconciliation_required");
        const { binding } = policy.forCleanup(attempt.contract);
        if (capacityFingerprint(attempt.contract) !== capacityFingerprint(binding)) throw new Error("capacity_identity_changed");
        const [ack] = await tx.select().from(admissionRunnerEpochs).where(eq(admissionRunnerEpochs.runner, binding.runner));
        if (ack?.epoch !== epoch || ack.fenceRoot !== binding.fenceRoot) throw new Error("capacity_runner_epoch_unacknowledged");
        // Takeover fences starts remotely before the new host adopts cleanup.
        // Original child bindings retain their launch epoch; never rewrite them.
        const [adopted] = await tx.update(admissionAttempts).set({ ownerEpoch: epoch, token: randomUUID(), state: "stopping",
          restoration: {}, updatedAt: now }).where(eq(admissionAttempts.id, attempt.id)).returning();
        return adopted;
      });
    },
    async assertCleanupReady(input: Owner) {
      return locked(async tx => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (attempt.state !== "stopping" || !policy) throw new Error("admission_not_restoring");
        return policy.forCleanup(attempt.contract).binding;
      });
    },
    async commandsForRun(companyId: string, runId: string) {
      return locked(async tx => {
        const attempts = await tx.select().from(admissionAttempts).where(and(eq(admissionAttempts.companyId, companyId),
          eq(admissionAttempts.runId, runId), inArray(admissionAttempts.state, [...occupied])));
        const results = [];
        for (const attempt of attempts) {
          const commands = await tx.select().from(admissionCommands).where(and(
            eq(admissionCommands.attemptId, attempt.id), eq(admissionCommands.stopped, false)));
          results.push({ attempt, commands });
        }
        return results;
      });
    },
    async requireRestoration(input: Owner & { kind: Restoration; descriptor: Record<string, unknown> }) {
      return locked(async (tx, _scheduler, now) => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (!["reserved", "starting", "stopping"].includes(attempt.state)) throw new Error("admission_launch_consumed");
        const [obligation] = await tx.insert(admissionRestorations).values({ attemptId: attempt.id,
          kind: input.kind, descriptor: input.descriptor }).returning();
        await tx.update(admissionAttempts).set({ restoration: { ...attempt.restoration, [input.kind]: false }, updatedAt: now })
          .where(eq(admissionAttempts.id, attempt.id));
        return obligation.id;
      });
    },
    async mutateRestoration<T>(input: Owner, body: () => Promise<T>) {
      // Short local filesystem critical section, inside its destination lock.
      // Takeover and local apply cannot interleave across this authority check.
      return locked(async tx => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (!["reserved", "starting", "stopping"].includes(attempt.state)) throw new Error("admission_not_restoring");
        return body();
      });
    },
    async restorationObligations(input: Owner) {
      return locked(async tx => {
        await owned(tx, input.companyId, input.attemptId, input.token);
        return tx.select().from(admissionRestorations).where(eq(admissionRestorations.attemptId, input.attemptId));
      });
    },
    async checkpointRestoration(input: Owner & { id: string; kind: Restoration; descriptor: Record<string, unknown> }) {
      return locked(async (tx, _scheduler, now) => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (!["reserved", "starting", "stopping"].includes(attempt.state)) throw new Error("admission_not_restoring");
        const [updated] = await tx.update(admissionRestorations).set({ descriptor: input.descriptor,
          status: "pending", updatedAt: now }).where(and(eq(admissionRestorations.id, input.id),
          eq(admissionRestorations.attemptId, attempt.id), eq(admissionRestorations.kind, input.kind))).returning();
        if (!updated) throw new Error("admission_restoration_binding_changed");
        await tx.update(admissionAttempts).set({ restoration: { ...attempt.restoration, [input.kind]: false }, updatedAt: now })
          .where(eq(admissionAttempts.id, attempt.id));
      });
    },
    async finishRestoration(input: Owner & { id: string; kind: Restoration; success: boolean }) {
      return locked(async (tx, _scheduler, now) => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (!["reserved", "starting", "stopping"].includes(attempt.state)) throw new Error("admission_not_restoring");
        const [obligation] = await tx.select().from(admissionRestorations).where(and(
          eq(admissionRestorations.id, input.id), eq(admissionRestorations.attemptId, attempt.id),
          eq(admissionRestorations.kind, input.kind))).for("update");
        if (!obligation) throw new Error("admission_restoration_binding_changed");
        await tx.update(admissionRestorations).set({ status: input.success ? "success" : "failed", updatedAt: now })
          .where(eq(admissionRestorations.id, obligation.id));
      });
    },
    async acknowledgeRunnerEpoch(input: { companyId: string; agentId: string; fenceRoot: string; epoch: string }) {
      if (startsHeld) throw new Error("capacity_bootstrap_held");
      return locked(async tx => {
        if (!policy || input.epoch !== epoch) throw new Error("stale_admission_controller");
        const { binding } = await policy.resolve(tx, input.companyId, input.agentId);
        if (!binding.fenceRoot || input.fenceRoot !== binding.fenceRoot) throw new Error("capacity_runner_root_unattested");
        await tx.insert(admissionRunnerEpochs).values({ runner: binding.runner, fenceRoot: input.fenceRoot, epoch })
          .onConflictDoUpdate({ target: admissionRunnerEpochs.runner,
            set: { fenceRoot: input.fenceRoot, epoch, acknowledgedAt: new Date() } });
      });
    },
    async registerOperation(input: { companyId: string; agentId?: string; environmentId: string;
      kind: "probe" | "adapter_test" | "lifecycle"; key: string }) {
      if (!policy) throw new Error("trusted_capacity_policy_required");
      if (!input.key.trim() || input.key.length > 512) throw new Error("invalid_operation_key");
      return locked(async (tx, scheduler) => {
        const agentId = input.agentId ?? policy.agentForEnvironment(input.companyId, input.environmentId);
        const resolved = await policy.resolve(tx, input.companyId, agentId);
        if (resolved.binding.environmentId !== input.environmentId) throw new Error("capacity_identity_changed");
        if (input.kind === "lifecycle") {
          const [agent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, input.companyId)));
          if (input.key !== `${agent.lifecycleOperation?.id ?? "verify"}:${agent.lifecycleVersion}`)
            throw new Error("capacity_lifecycle_changed");
        }
        const [existing] = await tx.select().from(admissionAttempts).where(and(
          eq(admissionAttempts.companyId, input.companyId), eq(admissionAttempts.agentId, agentId),
          eq(admissionAttempts.operationKind, input.kind), eq(admissionAttempts.operationKey, input.key),
          or(inArray(admissionAttempts.state, ["queued", ...occupied]),
            and(eq(admissionAttempts.operationKind, "lifecycle"), eq(admissionAttempts.operationResult, "complete"),
              eq(admissionAttempts.state, "released")))));
        if (existing) {
          if (capacityFingerprint(existing.contract) !== capacityFingerprint(resolved.binding))
            throw new Error("capacity_identity_changed");
          return existing;
        }
        const [pending] = await tx.select({ count: count() }).from(admissionAttempts).where(eq(admissionAttempts.state, "queued"));
        if (pending.count >= scheduler.pendingLimit) throw new Error("admission_queue_full");
        for (const scope of resolved.scopes) {
          await tx.insert(admissionScopes).values(scope).onConflictDoNothing();
          const [stored] = await tx.select().from(admissionScopes).where(eq(admissionScopes.key, scope.key));
          if (stored.capacity !== scope.capacity) throw new Error("capacity_policy_conflict");
        }
        await tx.insert(admissionProjects).values({ companyId: input.companyId, projectKey: "company",
          lastGrant: scheduler.sequence }).onConflictDoNothing();
        const [operation] = await tx.insert(admissionAttempts).values({ companyId: input.companyId, agentId,
          projectKey: "company", operationKind: input.kind, operationKey: input.key,
          contract: resolved.binding as unknown as Record<string, unknown>, scopes: resolved.scopes.map(s => s.key),
        }).returning();
        return operation;
      });
    },
    async claimOperation(companyId: string, operationId: string) {
      await locked(async (tx, _scheduler, now) => {
        await tx.update(admissionAttempts).set({ eligibleUntil: new Date(now.getTime() + 5_000) }).where(and(
          eq(admissionAttempts.companyId, companyId), eq(admissionAttempts.id, operationId),
          isNull(admissionAttempts.runId), eq(admissionAttempts.state, "queued")));
      });
      const grant = await claim(companyId, operationId);
      if (!grant) scheduleCapacityProgress(db);
      return grant?.reservation ?? null;
    },
    async assertOperationReady(input: Owner & { environmentId?: string }) {
      if (startsHeld) throw new Error("capacity_bootstrap_held");
      return locked(async tx => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (attempt.runId || !["reserved", "starting"].includes(attempt.state) || !policy)
          throw new Error("capacity_operation_not_admitted");
        const resolved = await policy.resolve(tx, attempt.companyId, attempt.agentId);
        if (capacityFingerprint(attempt.contract) !== capacityFingerprint(resolved.binding) ||
            (input.environmentId && resolved.binding.environmentId !== input.environmentId))
          throw new Error("capacity_identity_changed");
        return resolved.binding;
      });
    },
    async journalCommand(input: Owner & { leaseId: string; commandHash: string; restoration?: Restoration; concurrentWith?: readonly string[] }) {
      if (startsHeld) throw new Error("capacity_bootstrap_held");
      if (!/^[a-f0-9]{64}$/.test(input.commandHash)) throw new Error("invalid_command_hash");
      return locked(async (tx, _scheduler, now) => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (!(input.restoration ? ["reserved", "starting", "stopping"] : ["reserved", "starting"]).includes(attempt.state))
          throw new Error("admission_launch_consumed");
        const unfinished = await tx.select({ id: admissionCommands.id }).from(admissionCommands).where(and(
          eq(admissionCommands.attemptId, attempt.id), eq(admissionCommands.stopped, false)));
        if (unfinished.some(command => !input.concurrentWith?.includes(command.id))) throw new Error("admission_command_pending");
        if (attempt.operationKind === "lifecycle" && !input.restoration) {
          const [agent] = await tx.select().from(agents).where(and(eq(agents.id, attempt.agentId),
            eq(agents.companyId, attempt.companyId))).for("update", { noWait: true });
          if (!agent || attempt.operationKey !== `${agent.lifecycleOperation?.id ?? "verify"}:${agent.lifecycleVersion}`)
            throw new Error("capacity_lifecycle_changed");
        }
        if (attempt.runId && !input.restoration) {
          const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, attempt.runId),
            eq(heartbeatRuns.companyId, attempt.companyId))).for("update", { noWait: true });
          if (!run || run.status !== "running" || run.agentId !== attempt.agentId || readRunCancellation(run.resultJson))
            throw new Error("capacity_native_run_stopped");
        }
        if (!policy) throw new Error("trusted_capacity_policy_required");
        const resolved = input.restoration ? policy.forCleanup(attempt.contract)
          : await policy.resolve(tx, attempt.companyId, attempt.agentId);
        if (capacityFingerprint(attempt.contract) !== capacityFingerprint(resolved.binding) ||
            JSON.stringify(resolved.scopes.map(s => s.key)) !== JSON.stringify(attempt.scopes))
          throw new Error("capacity_identity_changed");
        const root = resolved.binding.fenceRoot;
        if (!root || !root.startsWith("/") || root === "/" || root.split("/").slice(1).some(s => !s || s === "." || s === ".."))
          throw new Error("capacity_runner_root_unattested");
        const [ack] = await tx.select().from(admissionRunnerEpochs).where(eq(admissionRunnerEpochs.runner, resolved.binding.runner));
        if (ack?.epoch !== epoch || ack.fenceRoot !== root) throw new Error("capacity_runner_epoch_unacknowledged");
        const [lease] = await tx.select().from(environmentLeases).where(and(
          eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, attempt.companyId))).for("update");
        if (!lease || lease.provider !== "ssh" || lease.status !== "active" || lease.releasedAt ||
            lease.environmentId !== resolved.binding.environmentId || lease.heartbeatRunId !== attempt.runId ||
            lease.metadata?.agentId !== attempt.agentId ||
            (!attempt.runId && lease.metadata?.admissionOperationId !== attempt.id))
          throw new Error("admission_lease_binding_changed");
        const commandId = randomUUID();
        // Wire runId is the native run ID or the durable operation ID. An
        // operation does not create a heartbeat row or acquire issue authority.
        const binding: AdmissionLaunchBinding = { epoch, companyId: attempt.companyId, agentId: attempt.agentId,
          runId: attempt.runId ?? attempt.id, attemptId: commandId, environmentId: lease.environmentId!,
          leaseId: lease.id, invocationId: randomUUID() };
        await tx.insert(admissionCommands).values({ id: commandId, attemptId: attempt.id,
          binding, fenceRoot: root, commandHash: input.commandHash });
        await tx.update(admissionAttempts).set({ state: input.restoration ? "stopping" : "starting",
          restoration: input.restoration ? { ...attempt.restoration, [input.restoration]: false } : {}, updatedAt: now,
        }).where(eq(admissionAttempts.id, attempt.id));
        return { fenceRoot: root, binding };
      });
    },
    async recordCommandStopped(input: Owner & { binding: AdmissionLaunchBinding; stopped: true }) {
      return locked(async tx => {
        await owned(tx, input.companyId, input.attemptId, input.token);
        const [command] = await tx.select().from(admissionCommands).where(and(
          eq(admissionCommands.id, input.binding.attemptId), eq(admissionCommands.attemptId, input.attemptId))).for("update");
        if (!command || input.stopped !== true || capacityFingerprint(command.binding) !== capacityFingerprint(input.binding))
          throw new Error("admission_stop_binding_changed");
        await tx.update(admissionCommands).set({ stopped: true }).where(eq(admissionCommands.id, command.id));
      });
    },
    async beginRestoration(input: Owner) {
      return locked(async (tx, _scheduler, now) => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (!["reserved", "starting", "stopping"].includes(attempt.state)) throw new Error("admission_not_settleable");
        const [pending] = await tx.select({ count: count() }).from(admissionCommands).where(and(
          eq(admissionCommands.attemptId, attempt.id), eq(admissionCommands.stopped, false)));
        if (pending.count) throw new Error("admission_process_stop_unverified");
        await tx.update(admissionAttempts).set({ state: "stopping", updatedAt: now }).where(eq(admissionAttempts.id, attempt.id));
      });
    },
    async recordRestoration(input: Owner & { kind: Restoration; success: boolean }) {
      return locked(async (tx, _scheduler, now) => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (attempt.state !== "stopping") throw new Error("admission_not_restoring");
        const [pending] = await tx.select({ count: count() }).from(admissionCommands).where(and(
          eq(admissionCommands.attemptId, attempt.id), eq(admissionCommands.stopped, false)));
        if (pending.count) throw new Error("admission_process_stop_unverified");
        const [unrestored] = await tx.select({ count: count() }).from(admissionRestorations).where(and(
          eq(admissionRestorations.attemptId, attempt.id), eq(admissionRestorations.kind, input.kind),
          ne(admissionRestorations.status, "success")));
        if (input.success && unrestored.count) throw new Error("admission_restoration_unverified");
        await tx.update(admissionAttempts).set({ restoration: { ...attempt.restoration, [input.kind]: input.success }, updatedAt: now })
          .where(eq(admissionAttempts.id, attempt.id));
      });
    },
    async recordOperationResult(input: Owner & { result: "complete" }) {
      return locked(async (tx, _scheduler, now) => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (attempt.operationKind !== "lifecycle" || !["reserved", "starting", "stopping"].includes(attempt.state) ||
            attempt.waitReason === "cancel_requested")
          throw new Error("capacity_operation_result_not_admitted");
        const [agent] = await tx.select().from(agents).where(and(eq(agents.id, attempt.agentId),
          eq(agents.companyId, attempt.companyId))).for("update", { noWait: true });
        if (!agent || attempt.operationKey !== `${agent.lifecycleOperation?.id ?? "verify"}:${agent.lifecycleVersion}`)
          throw new Error("capacity_lifecycle_changed");
        await tx.update(admissionAttempts).set({ operationResult: input.result, updatedAt: now })
          .where(eq(admissionAttempts.id, attempt.id));
      });
    },
    async releaseCapacity(input: Owner) {
      return locked(async (tx, _scheduler, now) => {
        const attempt = await owned(tx, input.companyId, input.attemptId, input.token);
        if (attempt.state === "released") return;
        if (attempt.state !== "stopping" || !["workspace", "session", "credential"].every(k =>
          attempt.restoration[k as Restoration] === true)) throw new Error("admission_restoration_unverified");
        const [pending] = await tx.select({ count: count() }).from(admissionCommands).where(and(
          eq(admissionCommands.attemptId, attempt.id), eq(admissionCommands.stopped, false)));
        if (pending.count) throw new Error("admission_process_stop_unverified");
        const [unrestored] = await tx.select({ count: count() }).from(admissionRestorations).where(and(
          eq(admissionRestorations.attemptId, attempt.id), ne(admissionRestorations.status, "success")));
        if (unrestored.count) throw new Error("admission_restoration_unverified");
        // Legacy final-invocation authority cannot be discharged by child
        // receipts; it must be explicitly reconciled rather than forgotten.
        if (attempt.binding) throw new Error("admission_legacy_launch_unreconciled");
        await tx.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: now, updatedAt: now })
          .where(and(eq(environmentLeases.companyId, attempt.companyId),
            sql`${environmentLeases.metadata}->>'admissionAttemptId' = ${attempt.id}`));
        await tx.update(admissionAttempts).set({ state: "released", updatedAt: now,
          operationResult: attempt.operationKind === "lifecycle" ? attempt.operationResult : null,
        }).where(eq(admissionAttempts.id, attempt.id));
      });
    },
  };
}
