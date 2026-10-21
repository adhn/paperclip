import { randomUUID } from "node:crypto";
import { executionAdmissionService } from "../execution-admission.js";
import { admissionAttempts, admissionEpochs, admissionScheduler, admissionScopes, issueComments, completionContracts, nativeRunResults, workAssessments, statusDecisions, issueThreadInteractions } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunDispatch } from "../../modules/run-dispatch/index.js";
import type { createWakeQueue } from "../../modules/wake-queue/index.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatQueue, type HeartbeatQueueDependencies } from "./queue.js";

type Run = typeof heartbeatRuns.$inferSelect;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  const preparation = createHeartbeatRunPreparation(db);
  return {
    ...preparation,
    ...state,
    getAgent: vi.fn<HeartbeatQueueDependencies["getAgent"]>(async () => { throw new Error("Unexpected agent lookup"); }),
    options: {},
    setRunStatus: vi.fn<HeartbeatQueueDependencies["setRunStatus"]>(async (id, status, patch) =>
      db.update(heartbeatRuns).set({ ...patch, status }).where(eq(heartbeatRuns.id, id)).returning().then(rows => rows[0] ?? null)),
    setWakeupStatus: vi.fn<HeartbeatQueueDependencies["setWakeupStatus"]>(async () => undefined),
    appendRunEvent: vi.fn<HeartbeatQueueDependencies["appendRunEvent"]>(async () => undefined),
    finalizeAgentStatus: vi.fn(async () => undefined),
    getAgentInvokability: vi.fn<HeartbeatQueueDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    getWorktreeExecutionCutoff: vi.fn(async () => null),
    applyRunDispatchPostCommitEffects: vi.fn(),
    issuesSvc: {
      getDependencyReadiness: vi.fn<HeartbeatQueueDependencies["issuesSvc"]["getDependencyReadiness"]>(),
      listDependencyReadiness: vi.fn(async () => new Map()),
    },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    instanceSettings: { getExperimental: vi.fn<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>() },
    runDispatch: createRunDispatch(db),
    wakeQueue: {
      createAdmissionTransactionScope: vi.fn<ReturnType<typeof createWakeQueue>["createAdmissionTransactionScope"]>(),
      admitWakeBehindIssueExecution: vi.fn<ReturnType<typeof createWakeQueue>["admitWakeBehindIssueExecution"]>(),
    },
    activeRunExecutions: new Set<string>(),
    activeRunExecutionPromises: new Set<Promise<void>>(),
    activeWakeupPromises: new Set<Promise<unknown>>(),
    liveRunExecutions: { has: vi.fn(() => false) },
    isHeartbeatRunTerminalStatus: (status: string | null | undefined) => ["succeeded", "failed", "cancelled", "timed_out"].includes(status ?? ""),
    isSameTaskScope: (left: string | null, right: string | null) => left === right,
    runTaskKey: (run: Run) => typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null,
    filterZombieCoalesceTarget: <T extends { id: string; status: string }>(run: T | null) => run,
    getSchedulingSuppression: vi.fn(async () => ({ suppressed: false, reason: null } as Awaited<ReturnType<HeartbeatQueueDependencies["getSchedulingSuppression"]>>)),
    executeRun: vi.fn(async () => undefined),
    applyWakeQueuePostCommitEffects: vi.fn(async () => undefined),
    releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
    publishRunLifecyclePluginEvent: vi.fn(),
    cancelRunInternal: vi.fn(async () => undefined),
    cancelActiveForAgentInternal: vi.fn(async () => undefined),
    resumeExecutionWaitComments: vi.fn(async () => undefined),
    resumeQueuedCommentInterrupt: vi.fn(async () => undefined),
    resumeSavedLegacyComments: vi.fn(async () => undefined),
    formatIssueIdentifierLink: (_identifier: string | null, fallback: string) => fallback,
    sweepPendingCleanupLeases: vi.fn<HeartbeatQueueDependencies["sweepPendingCleanupLeases"]>(),
  } satisfies HeartbeatQueueDependencies;
}
function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected queue database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

describe("heartbeat queue module boundary", () => {
  it("constructs without querying, dispatching, or registering background work", () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    createHeartbeatQueue(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
    expect(deps.activeRunExecutionPromises.size).toBe(0);
    expect(deps.activeWakeupPromises.size).toBe(0);
  });

  it.each(["startNextQueuedRunForAgent", "resumeQueuedRuns"] as const)("honors suppression before %s reads or resumes work", async (operation) => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    const queue = createHeartbeatQueue(database.db, deps);
    await queue[operation]("agent");
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.resumeExecutionWaitComments).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("tracks pending wakes across instances and clears each rejected wake", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    let rejectFirst!: (reason: Error) => void;
    let rejectSecond!: (reason: Error) => void;
    deps.getAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    deps.getAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSecond = reject; }));
    const first = createHeartbeatQueue(database.db, deps).trackWakeup("first");
    const second = createHeartbeatQueue(database.db, deps).trackWakeup("second");
    const firstCheck = expect(first).rejects.toThrow("first lookup failed");
    const secondCheck = expect(second).rejects.toThrow("second lookup failed");
    expect(deps.activeWakeupPromises).toEqual(new Set([first, second]));
    rejectFirst(new Error("first lookup failed"));
    await firstCheck;
    await Promise.resolve();
    expect(deps.activeWakeupPromises).toEqual(new Set([second]));
    rejectSecond(new Error("second lookup failed"));
    await secondCheck;
    await Promise.resolve();
    expect(deps.activeWakeupPromises.size).toBe(0);
    expect(deps.activeRunExecutionPromises.size).toBe(0);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("uses the same policy limits for dispatch and execution", () => {
    const database = guardedDatabase();
    const queue = createHeartbeatQueue(database.db, callbacks(database.db));
    const agent = { adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 20, maxDailyRuns: 3.8 } } } as unknown as typeof agents.$inferSelect;
    expect(queue.parseHeartbeatPolicy(agent)).toMatchObject({ maxConcurrentRuns: 1, maxDailyRuns: 3 });
    expect(queue.parseHeartbeatPolicy({ ...agent, adapterConfig: { provider: "codex" } })).toMatchObject({ maxConcurrentRuns: 20, maxDailyRuns: 3 });
    expect(database.access).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping queue module database tests: ${support.reason}`);
describe.skipIf(!support.supported)("heartbeat queue database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let other: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queue-module");
    db = createDb(database.connectionString);
    other = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await other?.$client.end();
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate execution_protected_authority_requests, execution_protected_command_journals, execution_protected_authority_pins, execution_admission_legacy_decisions, execution_admission_bootstraps, execution_admission_legacy_holds, execution_admission_restorations, execution_admission_commands, execution_admission_runner_epochs, execution_admission_attempts, execution_admission_projects,
      execution_admission_scopes, execution_admission_scheduler, execution_admission_epochs`);
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture(status = "running") {
    const [company] = await db.insert(companies).values({ name: "Queue module", issuePrefix: "QM" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Queue task", status: "todo", assigneeAgentId: agent.id }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "claimed", claimedAt: new Date() }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status, invocationSource: "assignment", wakeupRequestId: wake.id, startedAt: status === "running" ? new Date() : null, contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: run.id, executionAgentNameKey: agent.name, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    return { company, agent, issue, wake, run };
  }

  it.each(["claimed", "cancelled"] as const)("releases a running claim while preserving a %s wake", async (wakeStatus) => {
    const { run, issue, wake } = await fixture();
    await db.update(agentWakeupRequests).set({ status: wakeStatus }).where(eq(agentWakeupRequests.id, wake.id));
    await createHeartbeatQueue(db, callbacks(db)).releaseRunClaimedJustBeforeSuppression(run.id);
    const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [releasedIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    const [releasedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(released).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null });
    expect(releasedIssue).toMatchObject({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    expect(releasedWake.status).toBe(wakeStatus === "cancelled" ? "cancelled" : "queued");
    if (wakeStatus === "claimed") expect(releasedWake.claimedAt).toBeNull();
  });

  it("preserves a newer execution owner when releasing an old claim", async () => {
    const { run, issue, agent, company } = await fixture();
    const [newOwner] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", invocationSource: "assignment" }).returning();
    await db.update(issues).set({ executionRunId: newOwner.id }).where(eq(issues.id, issue.id));
    await createHeartbeatQueue(db, callbacks(db)).releaseRunClaimedJustBeforeSuppression(run.id);
    const [current] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(current.executionRunId).toBe(newOwner.id);
  });

  it("cancels at the daily run cap before claiming or dispatching", async () => {
    const { run, agent } = await fixture("queued");
    const cappedAgent = { ...agent, runtimeConfig: { heartbeat: { maxDailyRuns: 0 } } };
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(cappedAgent);
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun(run)).toBeNull();
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "heartbeat.daily_run_limit" });
    expect(deps.setWakeupStatus).toHaveBeenCalledWith(run.wakeupRequestId, "skipped", expect.any(Object));
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(cancelled, { suppressImmediateRecovery: true });
    expect(deps.treeControlSvc.getActivePauseHoldGate).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });
  async function admissionFixture(mode: "ordinary" | "comment" | "automation" | "review" = "ordinary") {
    const seeded = await fixture("queued");
    const epoch = randomUUID();
    await db.insert(admissionEpochs).values({ epoch });
    await db.insert(admissionScheduler).values({ epoch, pendingLimit: 20, draining: false,
      evaluationExemptionUntil: new Date(Date.now() + 60_000) });
    await db.insert(admissionScopes).values({ key: "runner:test", capacity: 1 });
    const [comment] = await db.insert(issueComments).values({ companyId: seeded.company.id,
      issueId: seeded.issue.id, authorUserId: "board-user", body: "queued input" }).returning();
    const [run] = await db.update(heartbeatRuns).set({ issueId: seeded.issue.id, scopeKind: "issue",
      invocationSource: mode === "automation" ? "automation" : "on_demand",
      contextSnapshot: { issueId: seeded.issue.id, ...(mode === "comment" ? { wakeCommentIds: [comment.id] } : {}) },
    }).where(eq(heartbeatRuns.id, seeded.run.id)).returning();
    await db.update(agentWakeupRequests).set({ status: "queued", runId: run.id,
      payload: mode === "comment" ? { _paperclipWakeContext: { wakeCommentIds: [comment.id] } } : null,
    }).where(eq(agentWakeupRequests.id, seeded.wake.id));
    if (mode === "review") {
      const companyId = seeded.company.id, issueId = seeded.issue.id;
      const [worker] = await db.insert(agents).values({ companyId, name: "source worker", status: "idle", adapterType: "process" }).returning();
      const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture", risk: "low",
        completionAuthority: "agent", incompleteCriteriaPolicy: "block", createdByActorType: "user", createdByActorId: "board-user",
        contractJson: {}, canonicalSha256: randomUUID() }).returning();
      const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: worker.id,
        nativeIssueId: issueId, status: "succeeded", runtimeMode: "native",
        completionContractId: contract.id, completionContractSha256: contract.canonicalSha256 }).returning();
      const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId: source.id,
        completionContractId: contract.id, serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() }).returning();
      const [assessment] = await db.insert(workAssessments).values({ companyId, issueId, runId: source.id,
        contractId: contract.id, resultId: result.id, triggerKind: "native_result", triggerActorCompanyId: companyId,
        priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "fixture", assessmentJson: {}, inputDigest: randomUUID() }).returning();
      const [reviewIssue] = await db.update(issues).set({ status: "in_review", assigneeAgentId: worker.id,
        executionRunId: null }).where(eq(issues.id, issueId)).returning();
      const [decision] = await db.insert(statusDecisions).values({ companyId, issueId, runId: source.id,
        assessmentId: assessment.id, decisionVersion: 1, policyVersion: "fixture", fromStatus: "in_progress", toStatus: "in_review",
        reasonCode: "explicit_review", decisionJson: { projectedStatusVersion: reviewIssue.statusVersion },
        decisionDigest: randomUUID(), applicationState: "applied" }).returning();
      const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId,
        kind: "request_confirmation", sourceRunId: source.id, addresseeAgentId: seeded.agent.id,
        payload: { version: 1, prompt: "Review", target: { type: "custom", key: "native_completion_review", revisionId: decision.id } } }).returning();
      await db.update(issues).set({ lastStatusDecisionId: decision.id }).where(eq(issues.id, issueId));
      const [reviewRun] = await db.update(heartbeatRuns).set({ contextSnapshot: { issueId,
        wakeReason: "native_completion_review", nativeReviewInteractionId: interaction.id, nativeReviewDecisionId: decision.id },
      }).where(eq(heartbeatRuns.id, run.id)).returning();
      Object.assign(run, reviewRun);
    }
    const service = executionAdmissionService(db, epoch);
    const attempt = await service.registerRun({ companyId: run.companyId, runId: run.id, scopes: ["runner:test"] });
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(seeded.agent);
    deps.resolveResponsibleUserIdForRun = vi.fn(async () => "board-user");
    deps.options = { executionAdmission: service } as typeof deps.options;
    const queue = createHeartbeatQueue(db, deps);
    return { ...seeded, run, comment, service, attempt, deps, queue, epoch };
  }
  async function readClaim(f: Awaited<ReturnType<typeof admissionFixture>>) {
    return {
      run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0],
      wake: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id)))[0],
      issue: (await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0],
      attempt: (await db.select().from(admissionAttempts).where(eq(admissionAttempts.id, f.attempt.id)))[0],
    };
  }
  it.each(["ordinary", "comment", "automation", "review"] as const)("atomically claims the actual %s branch and publishes after reservation commit", async mode => {
    const f = await admissionFixture(mode);
    let observed: Awaited<ReturnType<typeof readClaim>> | undefined;
    f.deps.publishRunLifecyclePluginEvent.mockImplementation(() => {
      // Schedule a root-client read at the publication boundary, outside the
      // claim transaction. The returned promise is awaited below.
      observation = readClaim(f).then(value => { observed = value; });
    });
    let observation: Promise<void> | undefined;
    expect((await f.queue.claimQueuedRun(f.run))?.id).toBe(f.run.id);
    await observation;
    expect(observed?.run.status).toBe("running");
    expect(observed?.wake.status).toBe("claimed");
    expect(observed?.issue.executionRunId).toBe(f.run.id);
    expect(observed?.attempt).toMatchObject({ state: "reserved", ownerEpoch: f.epoch, grantOrder: 1n });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
  it.each(["ordinary", "comment", "automation", "review"] as const)("leaves the actual %s branch queued when capacity is zero", async mode => {
    const f = await admissionFixture(mode);
    await db.update(admissionScopes).set({ capacity: 0 });
    expect(await f.queue.claimQueuedRun(f.run)).toBeNull();
    const state = await readClaim(f);
    expect(state.run.status).toBe("queued");
    expect(state.wake.status).toBe("queued");
    expect(state.attempt).toMatchObject({ state: "queued", token: null, waitReason: "capacity:runner:test" });
    expect(f.deps.publishRunLifecyclePluginEvent).not.toHaveBeenCalled();
  });
  it("commits discarded-comment cancellation without granting capacity or advancing fairness", async () => {
    const f = await admissionFixture("comment");
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, f.comment.id));
    expect(await f.queue.claimQueuedRun(f.run)).toBeNull();
    const state = await readClaim(f);
    expect(state.run).toMatchObject({ status: "cancelled", errorCode: "queued_comment_discarded" });
    expect(state.wake.status).toBe("cancelled");
    expect(state.issue.executionRunId).toBeNull();
    expect(state.attempt).toMatchObject({ state: "cancelled", token: null, grantOrder: null });
    expect((await db.select().from(admissionScheduler))[0].sequence).toBe(0n);
    expect(f.deps.publishRunLifecyclePluginEvent).toHaveBeenCalledOnce();
  });
  it("rolls back run/wake/issue writes when reservation commit fails", async () => {
    const f = await admissionFixture("comment");
    await db.execute(sql`alter table execution_admission_attempts add constraint injected_grant_failure check (state <> 'reserved')`);
    try {
      await expect(f.queue.claimQueuedRun(f.run)).rejects.toThrow();
      const state = await readClaim(f);
      expect(state.run.status).toBe("queued");
      expect(state.wake.status).toBe("queued");
      expect(state.attempt).toMatchObject({ state: "queued", token: null });
      expect((await db.select().from(admissionScheduler))[0].sequence).toBe(0n);
      expect(f.deps.publishRunLifecyclePluginEvent).not.toHaveBeenCalled();
      expect(f.deps.appendRunEvent).not.toHaveBeenCalled();
    } finally { await db.execute(sql`alter table execution_admission_attempts drop constraint injected_grant_failure`); }
  });
  it("preserves native cancellation that wins before the claim", async () => {
    const f = await admissionFixture();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(await f.queue.claimQueuedRun(f.run)).toBeNull();
    const state = await readClaim(f);
    expect(state.run.status).toBe("cancelled");
    expect(state.wake.status).toBe("cancelled");
    expect(state.attempt.state).toBe("cancelled");
    expect(f.deps.publishRunLifecyclePluginEvent).not.toHaveBeenCalled();
  });
  it("defers rather than claiming a cancelled wake under a stale queued run", async () => {
    const f = await admissionFixture();
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(await f.queue.claimQueuedRun(f.run)).toBeNull();
    const state = await readClaim(f);
    expect(state.run.status).toBe("queued");
    expect(state.wake.status).toBe("cancelled");
    expect(state.attempt.state).toBe("queued");
  });
  it("rechecks a pause committed during preflight before claiming", async () => {
    const f = await admissionFixture();
    f.deps.resolveResponsibleUserIdForRun = vi.fn(async () => {
      await db.update(agents).set({ status: "paused", updatedAt: new Date(Date.now() + 1000) }).where(eq(agents.id, f.agent.id));
      return "board-user";
    });
    expect(await createHeartbeatQueue(db, f.deps).claimQueuedRun(f.run)).toBeNull();
    expect((await readClaim(f)).attempt.state).toBe("queued");
    expect((await readClaim(f)).run.status).toBe("queued");
  });
  it("fails closed without a registered trusted scope set", async () => {
    const f = await admissionFixture();
    await db.delete(admissionAttempts).where(eq(admissionAttempts.id, f.attempt.id));
    expect(await f.queue.claimQueuedRun(f.run)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].status).toBe("queued");
    expect(f.deps.publishRunLifecyclePluginEvent).not.toHaveBeenCalled();
  });

  it("claims through the native scheduler entry point before dispatch", async () => {
    const f = await admissionFixture();
    expect((await f.queue.startNextQueuedRunForAgent(f.agent.id)).map(r => r.id)).toEqual([f.run.id]);
    expect(f.deps.executeRun).toHaveBeenCalledExactlyOnceWith(f.run.id);
    expect((await readClaim(f)).attempt.state).toBe("reserved");
  });
  it("serializes competing actual native claims across independent database clients", async () => {
    const f = await admissionFixture("comment");
    const rivalDeps = callbacks(other);
    rivalDeps.getAgent.mockResolvedValue(f.agent);
    rivalDeps.resolveResponsibleUserIdForRun = vi.fn(async () => "board-user");
    rivalDeps.options = { executionAdmission: executionAdmissionService(other, f.epoch) };
    const rival = createHeartbeatQueue(other, rivalDeps);
    const results = await Promise.all([f.queue.claimQueuedRun(f.run), rival.claimQueuedRun(f.run)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readClaim(f)).attempt).toMatchObject({ state: "reserved", grantOrder: 1n });
    expect(f.deps.publishRunLifecyclePluginEvent.mock.calls.length + rivalDeps.publishRunLifecyclePluginEvent.mock.calls.length).toBe(1);
  });
  it("honors native cancellation committed while waiting for the scheduler lock", async () => {
    const f = await admissionFixture();
    let release!: () => void, locked!: () => void, prepared!: () => void;
    const unlock = new Promise<void>(resolve => { release = resolve; });
    const schedulerLocked = new Promise<void>(resolve => { locked = resolve; });
    const preflightDone = new Promise<void>(resolve => { prepared = resolve; });
    const blocker = other.transaction(async tx => {
      await tx.select().from(admissionScheduler).for("update");
      locked();
      await unlock;
    });
    await schedulerLocked;
    f.deps.resolveResponsibleUserIdForRun = vi.fn(async () => { prepared(); return "board-user"; });
    const claim = createHeartbeatQueue(db, f.deps).claimQueuedRun(f.run);
    try {
      await preflightDone;
      await db.transaction(async tx => {
        await tx.select().from(issues).where(eq(issues.id, f.issue.id)).for("update");
        await tx.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, f.wake.id));
        await tx.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
      });
    } finally { release(); await blocker; }
    expect(await claim).toBeNull();
    expect((await readClaim(f)).attempt).toMatchObject({ state: "cancelled", token: null });
    expect(f.deps.publishRunLifecyclePluginEvent).not.toHaveBeenCalled();
  });
  it("preserves native review eligibility rather than granting a stale review", async () => {
    const f = await admissionFixture("review");
    await db.update(issues).set({ lastStatusDecisionId: null }).where(eq(issues.id, f.issue.id));
    expect(await f.queue.claimQueuedRun(f.run)).toBeNull();
    expect((await readClaim(f)).attempt.state).toBe("queued");
    expect((await readClaim(f)).run).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed" });
    expect((await readClaim(f)).attempt.token).toBeNull();
  });

  it("defers without a grant when a native issue lock is contended", async () => {
    const f = await admissionFixture();
    let release!: () => void, locked!: () => void;
    const unlock = new Promise<void>(resolve => { release = resolve; });
    const issueLocked = new Promise<void>(resolve => { locked = resolve; });
    let blocker: Promise<unknown> | undefined;
    f.deps.resolveResponsibleUserIdForRun = vi.fn(async () => {
      // The existing staleness preflight takes the issue lock itself. Introduce
      // contention after that check, at the reservation/claim boundary.
      blocker = other.transaction(async tx => {
        await tx.select().from(issues).where(eq(issues.id, f.issue.id)).for("update");
        locked();
        await unlock;
      });
      await issueLocked;
      return "board-user";
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const claim = createHeartbeatQueue(db, f.deps).claimQueuedRun(f.run);
    try {
      expect(await Promise.race([claim, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("claim waited on native issue lock")), 5000);
      })])).toBeNull();
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await blocker;
      await claim;
    }
    expect((await readClaim(f)).attempt).toMatchObject({ state: "queued", token: null });
    expect((await readClaim(f)).run.status).toBe("queued");
    expect(f.deps.publishRunLifecyclePluginEvent).not.toHaveBeenCalled();
  });

});
