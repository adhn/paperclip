import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { admissionAttempts, admissionCommands, admissionRestorations, environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { legacyLeaseIsReconciled } from "./execution-legacy-reconciliation.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  if (!agentIds.length) return true;
  const reservations = await db.select().from(admissionAttempts).where(inArray(admissionAttempts.agentId, agentIds));
  if (reservations.some(a => !["released", "cancelled"].includes(a.state))) return false;
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  const reconciledLeases = new Set<string>();
  for (const lease of leases) {
    const run = runs.find(run => run.id === lease.heartbeatRunId && run.companyId === lease.companyId);
    if (run && await legacyLeaseIsReconciled(db, lease, run.agentId)) reconciledLeases.add(lease.id);
  }
  if (leases.some(lease => !reconciledLeases.has(lease.id) && ( (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"))) return false;
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const settledLeases = new Set<string>();
  for (const reservation of reservations.filter(a => a.state === "released")) {
    const commands = await db.select().from(admissionCommands).where(eq(admissionCommands.attemptId, reservation.id));
    const unrestored = await db.select({ id: admissionRestorations.id }).from(admissionRestorations).where(and(
      eq(admissionRestorations.attemptId, reservation.id), ne(admissionRestorations.status, "success")));
    if (reservation.binding || commands.some(command => !command.stopped) || unrestored.length ||
        !["workspace", "session", "credential"].every(k => reservation.restoration[k as "workspace"] === true)) continue;
    for (const lease of leases) if (lease.companyId === reservation.companyId && lease.heartbeatRunId === reservation.runId &&
        lease.metadata?.admissionAttemptId === reservation.id && lease.metadata?.agentId === reservation.agentId &&
        lease.releasedAt && lease.cleanupStatus === "success") settledLeases.add(lease.id);
  }
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return false;
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return false;
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return false;
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(lease => hasRemoteTerminationReceipt(lease) || settledLeases.has(lease.id) || reconciledLeases.has(lease.id))) return false;
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return false;
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return false;
  }
  return true;
}
