import { trustedCapacityPolicy, capacityFingerprint, capacityAgentContract, capacityEnvironmentContract } from "../services/execution-capacity-policy.js";
import { environments } from "@paperclipai/db";
import { executionAdmissionService } from "../services/execution-admission.js";
import { admissionAttempts, admissionEpochs, admissionScheduler, admissionScopes } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Queued-run claim isolation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queued-run claim isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat queued-run claim isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-queued-run-claim-isolation-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    // Executed runs write to many company-scoped tables; clear them all.
    await db.execute(sql`truncate execution_protected_authority_requests, execution_protected_command_journals, execution_protected_authority_pins, execution_admission_legacy_decisions, execution_admission_bootstraps, execution_admission_legacy_holds, execution_admission_restorations, execution_admission_commands, execution_admission_runner_epochs, execution_admission_attempts, execution_admission_projects,
      execution_admission_scopes, execution_admission_scheduler, execution_admission_epochs`);
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Claim Isolation Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claim Isolation Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function insertQueuedRun(
    companyId: string,
    agentId: string,
    wake: Partial<typeof agentWakeupRequests.$inferInsert>,
    createdAt: Date,
  ) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      runId,
      ...wake,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      createdAt,
    });

    return { runId, wakeupRequestId };
  }

  // A queued-comment interrupt wake whose receipt cannot be verified. The run
  // identity check rejects it with a 403 every time the run is claimed.
  function insertUnverifiableInterruptRun(companyId: string, agentId: string, createdAt = new Date(Date.now() - 60_000)) {
    return insertQueuedRun(companyId, agentId, {
      reason: "issue_commented",
      idempotencyKey: `queued-comment-interrupt:${randomUUID()}`,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    }, createdAt);
  }

  // A system wake with no issue in a company without members. Its responsible
  // user cannot be resolved yet (422), but a user added later would fix that.
  function insertUnresolvableOwnerRun(companyId: string, agentId: string, createdAt = new Date(Date.now() - 60_000)) {
    return insertQueuedRun(companyId, agentId, {
      source: "automation",
      triggerDetail: "system",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_test",
    }, createdAt);
  }

  // A manual wake from a user. It resolves its identity from the receipt, so it
  // can always be claimed.
  function insertClaimableRun(companyId: string, agentId: string, createdAt = new Date()) {
    return insertQueuedRun(companyId, agentId, {
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: { manualUserWake: true },
    }, createdAt);
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} = ${runId}`)
      .then((rows) => rows[0] ?? null);
  }

  it("cancels a queued run whose claim is rejected instead of failing recovery", async () => {
    const { companyId, agentId } = await insertAgent();
    const { runId, wakeupRequestId } = await insertUnverifiableInterruptRun(companyId, agentId);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    expect(await runStatus(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "queued_run_claim_rejected",
      error: "Cancelled because the queued run cannot be claimed: Queued-message interrupt authority is unavailable",
    });
    const wakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.id} = ${wakeupRequestId}`)
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({ status: "cancelled" });

    // Recovery runs again on the next cycle and on every restart. The run must
    // stay settled instead of failing the claim loop again.
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    expect(await runStatus(runId)).toMatchObject({ status: "cancelled" });
  });

  it("claims the agent's next queued run after a rejected one", async () => {
    const { companyId, agentId } = await insertAgent();
    const { runId: rejectedRunId } = await insertUnverifiableInterruptRun(companyId, agentId);
    const { runId: healthyRunId } = await insertClaimableRun(companyId, agentId);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(rejectedRunId)).toMatchObject({
      status: "cancelled",
      errorCode: "queued_run_claim_rejected",
    });
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    expect(await runStatus(healthyRunId)).toMatchObject({ status: "succeeded" });
  });

  it("keeps a recoverable rejection queued without blocking the runs behind it", async () => {
    const { companyId, agentId } = await insertAgent();
    const { runId: deferredRunId } = await insertUnresolvableOwnerRun(companyId, agentId);
    const { runId: healthyRunId } = await insertClaimableRun(companyId, agentId);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(deferredRunId)).toMatchObject({ status: "queued", errorCode: null });
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    expect(await runStatus(healthyRunId)).toMatchObject({ status: "succeeded" });
  });

  it("keeps processing other agents' queued runs after one agent's run is rejected", async () => {
    const first = await insertAgent();
    const second = await insertAgent();
    const { runId: rejectedRunId } = await insertUnverifiableInterruptRun(first.companyId, first.agentId);
    const { runId: healthyRunId } = await insertClaimableRun(second.companyId, second.agentId);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(rejectedRunId)).toMatchObject({ status: "cancelled" });
    expect(await runStatus(healthyRunId)).toMatchObject({ status: "succeeded" });
  });
  async function withAdmission(capacity: number) {
    const { companyId, agentId } = await insertAgent();
    const { runId } = await insertClaimableRun(companyId, agentId);
    const epoch = randomUUID();
    await db.insert(admissionEpochs).values({ epoch });
    await db.insert(admissionScheduler).values({ epoch, pendingLimit: 20, draining: false,
      evaluationExemptionUntil: new Date(Date.now() + 60_000) });
    await db.insert(admissionScopes).values({ key: "runner:assembled-test", capacity });
    const service = executionAdmissionService(db, epoch);
    const attempt = await service.registerRun({ companyId, runId, scopes: ["runner:assembled-test"] });
    heartbeat = heartbeatService(db, { executionAdmission: service });
    return { companyId, agentId, runId, attempt };
  }
  it("assembled scheduler reserves before adapter execution and retains capacity after terminal completion", async () => {
    const f = await withAdmission(1);
    let dispatchedReservation: string | undefined;
    mockAdapterExecute.mockImplementationOnce(async () => {
      const [attempt] = await db.select().from(admissionAttempts).where(sql`${admissionAttempts.id} = ${f.attempt.id}`);
      dispatchedReservation = attempt.state;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Admission claim test", provider: "test", model: "test-model" };
    });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    expect(dispatchedReservation).toBe("reserved");
    expect((await runStatus(f.runId))?.status).toBe("succeeded");
    const [held] = await db.select().from(admissionAttempts).where(sql`${admissionAttempts.id} = ${f.attempt.id}`);
    expect(held).toMatchObject({ state: "reserved", grantOrder: 1n });
  });
  it("assembled recovery leaves excess demand queued without executing an adapter", async () => {
    const f = await withAdmission(0);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect((await runStatus(f.runId))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [waiting] = await db.select().from(admissionAttempts).where(sql`${admissionAttempts.id} = ${f.attempt.id}`);
    expect(waiting).toMatchObject({ state: "queued", waitReason: "capacity:runner:assembled-test", token: null });
  });

  it("assembled scheduler automatically registers trusted scopes and visibly queues at zero runner capacity", async () => {
    const { companyId, agentId } = await insertAgent();
    const { runId } = await insertClaimableRun(companyId, agentId);
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh", config: { host: "never-contacted" } }).returning();
    const [agent] = await db.update(agents).set({ defaultEnvironmentId: environment.id, adapterConfig: { engine: "cli" } }).where(sql`${agents.id} = ${agentId}`).returning();
    const epoch = randomUUID();
    await db.insert(admissionEpochs).values({ epoch });
    await db.insert(admissionScheduler).values({ epoch, pendingLimit: 20, draining: false,
      evaluationExemptionUntil: new Date(Date.now() + 60_000) });
    const trustedDb = createDb(tempDb!.connectionString);
    try {
      executionAdmissionService(trustedDb, epoch, trustedCapacityPolicy([{
        companyId, agentId, environmentId: environment.id, adapterType: agent.adapterType,
        instance: "assembled", instanceCapacity: 1, runner: "assembled", runnerCapacity: 0,
        providerAccount: "assembled", accountCapacity: 1, workspace: "assembled", session: "assembled", credential: "assembled",
        agentFingerprint: capacityFingerprint(capacityAgentContract(agent)),
        environmentFingerprint: capacityFingerprint(capacityEnvironmentContract(environment)),
        workspaceConfigurations: [capacityFingerprint({})],
      }]));
      heartbeat = heartbeatService(trustedDb);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      const [attempt] = await db.select().from(admissionAttempts).where(sql`${admissionAttempts.runId} = ${runId}`);
      expect(attempt.scopes).toHaveLength(7);
      expect(attempt.state).toBe("queued");
      const [run] = await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.id} = ${runId}`);
      expect(run.status).toBe("queued");
      expect(run.resultJson).toMatchObject({ executionCapacity: { state: "waiting", reason: expect.stringMatching(/^capacity:runner:/) } });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await trustedDb.$client.end();
      heartbeat = heartbeatService(db);
    }
  });

  it.each(["permanent", "retained"])("globally preflights companies past an older %s rejection", async rejection => {
    const a = await insertAgent(), b = await insertAgent();
    const rejected = rejection === "permanent"
      ? await insertUnverifiableInterruptRun(a.companyId, a.agentId)
      : await insertUnresolvableOwnerRun(a.companyId, a.agentId);
    const healthy = await insertClaimableRun(b.companyId, b.agentId);
    const epoch = randomUUID();
    await db.insert(admissionEpochs).values({ epoch });
    await db.insert(admissionScheduler).values({ epoch, pendingLimit: 20, draining: false,
      evaluationExemptionUntil: new Date(Date.now() + 60_000) });
    await db.insert(admissionScopes).values({ key: "runner:fair", capacity: 1 });
    const service = executionAdmissionService(db, epoch);
    await service.registerRun({ companyId: a.companyId, runId: rejected.runId, scopes: ["runner:fair"] });
    await service.registerRun({ companyId: b.companyId, runId: healthy.runId, scopes: ["runner:fair"] });
    heartbeat = heartbeatService(db, { executionAdmission: service });
    // Enter through B's real scheduler path; the older A was accepted earlier
    // but cannot resolve its queued-message authority. No fake claim or grant.
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect((await runStatus(rejected.runId))?.status).toBe(rejection === "permanent" ? "cancelled" : "queued");
    expect((await runStatus(healthy.runId))?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    const reservations = await db.select().from(admissionAttempts);
    expect(reservations.find(r => r.runId === rejected.runId)).toMatchObject({ state: rejection === "permanent" ? "cancelled" : "queued", token: null });
    expect(reservations.find(r => r.runId === healthy.runId)).toMatchObject({ state: "reserved", grantOrder: 1n });
  });

});
