import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { capacityWorkspaceContract, capacityAgentContract, capacityEnvironmentContract, capacityFingerprint, trustedCapacityPolicy, type TrustedCapacityBinding } from "../services/execution-capacity-policy.js";
import { guardCapacityExecution, guardCapacityWorkspaceConfiguration, guardCapacityResolvedExecutionConfig, installExecutionCapacity } from "../services/execution-capacity-context.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admissionAttempts, admissionCommands, admissionRunnerEpochs, admissionEpochs, admissionProjects, admissionScheduler, admissionScopes,
  agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { executionAdmissionService } from "../services/execution-admission.js";

describe("candidate native admission transaction", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let other: ReturnType<typeof createDb>;
  let epoch: string;
  let service: ReturnType<typeof executionAdmissionService>;
  const policyClients: ReturnType<typeof createDb>[] = [];
  let probeEnvironment: typeof import("../services/environment-probe.js").probeEnvironment;
  let agentEnvironmentTestService: typeof import("../services/agent-environment-test.js").agentEnvironmentTestService;
  let agentHarnessVerificationService: typeof import("../services/agent-harness-verification.js").agentHarnessVerificationService;
  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error("PostgreSQL required: " + support.reason);
    temporary = await startEmbeddedPostgresTestDatabase("execution-admission-");
    db = createDb(temporary.connectionString);
    other = createDb(temporary.connectionString);
    // Cold assembled-service imports belong to bounded fixture setup, not the
    // guard's 15-second behavior deadline. The narrow suite has no warm graph.
    const [probe, tests, verification] = await Promise.all([
      import("../services/environment-probe.js"), import("../services/agent-environment-test.js"),
      import("../services/agent-harness-verification.js"),
    ]);
    probeEnvironment = probe.probeEnvironment;
    agentEnvironmentTestService = tests.agentEnvironmentTestService;
    agentHarnessVerificationService = verification.agentHarnessVerificationService;
  }, 120_000);
  afterAll(async () => { await Promise.all(policyClients.map(client => client.$client.end())); await db?.$client.end(); await other?.$client.end(); await temporary?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`truncate execution_protected_authority_requests, execution_protected_command_journals, execution_protected_authority_pins, execution_admission_legacy_decisions, execution_admission_bootstraps, execution_admission_legacy_holds, execution_admission_restorations, execution_admission_commands, execution_admission_runner_epochs, execution_admission_attempts, execution_admission_projects,
      execution_admission_scopes, execution_admission_scheduler, execution_admission_epochs`);
    epoch = randomUUID();
    await db.insert(admissionEpochs).values({ epoch });
    await db.insert(admissionScheduler).values({ epoch, pendingLimit: 20, draining: false,
      evaluationExemptionUntil: new Date(Date.now() + 60_000) });
    await db.insert(admissionScopes).values([{ key: "runner:codex", capacity: 1 }, { key: "account:codex", capacity: 1 }]);
    service = executionAdmissionService(db, epoch);
  });
  async function seed() {
    const [company] = await db.insert(companies).values({ name: "admission", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "fixture", adapterType: "codex_local" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "fixture" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "fixture", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "queued" }).returning();
    const attempt = await service.registerRun({ companyId: company.id, runId: run.id, scopes: ["runner:codex", "account:codex"] });
    return { company, agent, project, issue, run, attempt };
  }
  const readAttempt = async (id: string) => (await db.select().from(admissionAttempts).where(eq(admissionAttempts.id, id)))[0];
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0];
  const nativeClaim: Parameters<typeof service.claimNext>[0] = async (tx, run) => {
    // Database-only contract stand-in. Assembled queue branches are a remaining
    // integration gate; this is not represented as running heartbeat acceptance.
    if (run.issueId) await tx.select().from(issues).where(eq(issues.id, run.issueId)).for("update");
    const [claimed] = await tx.update(heartbeatRuns).set({ status: "running" }).where(and(
      eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued"),
    )).returning();
    return claimed ?? null;
  };
  it("commits a native run and reservation together across two independent clients", async () => {
    const a = await seed(), b = await seed();
    const rival = executionAdmissionService(other, epoch);
    const outcomes = await Promise.all([service.claimNext(nativeClaim), rival.claimNext(nativeClaim)]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const attempts = await db.select().from(admissionAttempts);
    expect(attempts.filter(a => a.state === "reserved")).toHaveLength(1);
    const statuses = [(await readRun(a.run.id)).status, (await readRun(b.run.id)).status];
    expect(statuses.sort()).toEqual(["queued", "running"]);
  });
  it("rolls back native partial writes and fairness when a claim throws", async () => {
    const a = await seed();
    await expect(service.claimNext(async (tx, run) => { await nativeClaim(tx, run); throw Error("claim fault"); })).rejects.toThrow("claim fault");
    expect((await readRun(a.run.id)).status).toBe("queued");
    expect(await readAttempt(a.attempt.id)).toMatchObject({ state: "queued", token: null, grantOrder: null });
    expect((await db.select().from(admissionScheduler))[0].sequence).toBe(0n);
    expect((await service.claimNext(nativeClaim))?.reservation.grantOrder).toBe(1n);
  });
  it("rolls back a deferred claim savepoint and proceeds to an eligible project", async () => {
    const a = await seed(), b = await seed();
    const result = await service.claimNext(async (tx, run) => {
      const claimed = await nativeClaim(tx, run);
      return run.id === a.run.id ? null : claimed;
    });
    expect(result?.run.id).toBe(b.run.id);
    expect((await readRun(a.run.id)).status).toBe("queued");
    expect(await readAttempt(a.attempt.id)).toMatchObject({ state: "queued", waitReason: "native_ineligible" });
  });
  it("rejects a callback returning a sibling identity and rolls back", async () => {
    const a = await seed(), b = await seed();
    await expect(service.claimNext(async (tx, run) => { await nativeClaim(tx, run); return b.run; })).rejects.toThrow("native_claim_binding_changed");
    expect((await readRun(a.run.id)).status).toBe("queued");
    expect((await readAttempt(a.attempt.id)).state).toBe("queued");
  });
  it("does not release terminal native runs or lower-limit occupancy", async () => {
    const a = await seed();
    await service.claimNext(nativeClaim);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, a.run.id));
    const b = await seed();
    await db.update(admissionScopes).set({ capacity: 0 });
    expect(await service.claimNext(nativeClaim)).toBeNull();
    expect((await readAttempt(a.attempt.id)).state).toBe("reserved");
    expect((await readRun(b.run.id)).status).toBe("queued");
  });
  it("keeps cancelled reservations occupied and blocks their launch", async () => {
    const a = await seed();
    const granted = (await service.claimNext(nativeClaim))!;
    await service.cancel(a.company.id, a.attempt.id);
    expect((await readAttempt(a.attempt.id)).state).toBe("stopping");
    await expect(service.journalLaunch({ companyId: a.company.id, attemptId: a.attempt.id,
      token: granted.reservation.token!, leaseId: randomUUID(), invocationId: randomUUID() })).rejects.toThrow("admission_launch_consumed");
    await seed();
    expect(await service.claimNext(nativeClaim)).toBeNull();
  });
  it("cancels queued metadata without invoking native claim", async () => {
    const a = await seed();
    await service.cancel(a.company.id, a.attempt.id);
    expect(await service.claimNext(async () => { throw Error("must not claim"); })).toBeNull();
    expect((await readRun(a.run.id)).status).toBe("queued"); // Native cancellation belongs to the coordinator.
  });
  it.each(["drain", "backup", "cooldown", "scope-drain"])("retains a visible %s wait without calling native claim", async gate => {
    const a = await seed();
    if (gate === "drain") await db.update(admissionScheduler).set({ draining: true });
    if (gate === "backup") await db.update(admissionScheduler).set({ evaluationExemptionUntil: null, recoveryPoint: new Date(Date.now() - 3_600_001) });
    if (gate === "cooldown") await db.update(admissionScopes).set({ notBefore: new Date(Date.now() + 60_000) });
    if (gate === "scope-drain") await db.update(admissionScopes).set({ draining: true });
    expect(await service.claimNext(async () => { throw Error("must not claim"); })).toBeNull();
    expect((await readAttempt(a.attempt.id)).waitReason).toBeTruthy();
  });
  it("rejects wrong companies and changed identities; stable registration is idempotent", async () => {
    const a = await seed(), b = await seed();
    await expect(service.registerRun({ companyId: b.company.id, runId: a.run.id, scopes: ["runner:codex"] })).rejects.toThrow("native_run_not_queued");
    await expect(service.registerRun({ companyId: a.company.id, runId: a.run.id, scopes: ["runner:codex"] })).rejects.toThrow("admission_identity_changed");
    expect((await service.registerRun({ companyId: a.company.id, runId: a.run.id, scopes: ["account:codex", "runner:codex"] })).id).toBe(a.attempt.id);
    await expect(service.cancel(b.company.id, a.attempt.id)).rejects.toThrow("unknown_admission_attempt");
  });
  it("journals one exact lease binding before returning launch authority", async () => {
    const a = await seed();
    const granted = (await service.claimNext(nativeClaim))!;
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: a.company.id, heartbeatRunId: a.run.id,
      environmentId: environment.id, provider: "ssh", status: "active", metadata: { agentId: a.agent.id } }).returning();
    const input = { companyId: a.company.id, attemptId: a.attempt.id, token: granted.reservation.token!, leaseId: lease.id, invocationId: randomUUID() };
    await expect(service.journalLaunch({ ...input, token: randomUUID() })).rejects.toThrow("admission_ownership");
    await expect(service.journalLaunch({ ...input, leaseId: randomUUID() })).rejects.toThrow("admission_lease_binding_changed");
    const binding = await service.journalLaunch(input);
    expect(binding).toEqual({ epoch, companyId: a.company.id, agentId: a.agent.id, runId: a.run.id,
      attemptId: a.attempt.id, environmentId: environment.id, leaseId: lease.id, invocationId: input.invocationId });
    expect(await readAttempt(a.attempt.id)).toMatchObject({ state: "starting", binding });
    await expect(service.journalLaunch(input)).rejects.toThrow("admission_launch_consumed");
  });
  it("takeover retains uncertain slots, rejects old writers and prevents epoch reuse", async () => {
    const a = await seed();
    await service.claimNext(nativeClaim);
    const next = randomUUID();
    await service.takeover(next);
    expect(await readAttempt(a.attempt.id)).toMatchObject({ state: "uncertain", ownerEpoch: epoch });
    await expect(service.cancel(a.company.id, a.attempt.id)).rejects.toThrow("stale_admission_controller");
    const successor = executionAdmissionService(other, next);
    await expect(successor.takeover(epoch)).rejects.toThrow();
    expect((await db.select().from(admissionScheduler))[0]).toMatchObject({ epoch: next, draining: true });
    expect((await successor.cancel(a.company.id, a.attempt.id)).state).toBe("uncertain");
  });
  it("new projects enter at the grant frontier without overtaking older waiters", async () => {
    await seed();
    const b = await seed();
    await service.claimNext(nativeClaim);
    const c = await seed();
    const fairness = await db.select().from(admissionProjects);
    expect(fairness.find(p => p.companyId === b.company.id)?.lastGrant).toBe(0n);
    expect(fairness.find(p => p.companyId === c.company.id)?.lastGrant).toBe(1n);
    // Retained first slot remains occupied. No synthetic release for fairness.
    await db.update(admissionScopes).set({ capacity: 2 });
    expect((await service.claimNext(nativeClaim))?.run.id).toBe(b.run.id);
  });
  it("holds changed native identity instead of reinterpreting queued scopes", async () => {
    const a = await seed();
    const [replacement] = await db.insert(agents).values({ companyId: a.company.id, name: "replacement", adapterType: "codex_local" }).returning();
    await db.update(heartbeatRuns).set({ agentId: replacement.id }).where(eq(heartbeatRuns.id, a.run.id));
    expect(await service.claimNext(async () => { throw Error("must not claim"); })).toBeNull();
    expect(await readAttempt(a.attempt.id)).toMatchObject({ agentId: a.agent.id, state: "queued", waitReason: "native_identity_changed" });
  });
  it("retains the queue ceiling and unresolved FK references", async () => {
    const a = await seed();
    await db.update(admissionScheduler).set({ pendingLimit: 1 });
    await expect(seed()).rejects.toThrow("admission_queue_full");
    await service.claimNext(nativeClaim);
    await expect(db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, a.run.id))).rejects.toThrow();
    expect((await readAttempt(a.attempt.id)).state).toBe("reserved");
  });
  it("serializes grant against queued cancellation without returning capacity after grant", async () => {
    const a = await seed();
    const rival = executionAdmissionService(other, epoch);
    await Promise.all([service.claimNext(nativeClaim), rival.cancel(a.company.id, a.attempt.id)]);
    const attempt = await readAttempt(a.attempt.id);
    expect(["cancelled", "stopping"]).toContain(attempt.state);
    if (attempt.state === "stopping") {
      expect((await readRun(a.run.id)).status).toBe("running");
      await seed();
      expect(await service.claimNext(nativeClaim)).toBeNull();
    } else expect((await readRun(a.run.id)).status).toBe("queued");
  });
  it("rejects a native run pointing to another company's agent", async () => {
    const a = await seed(), b = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: a.company.id, agentId: b.agent.id, status: "queued" }).returning();
    await expect(service.registerRun({ companyId: a.company.id, runId: run.id, scopes: ["runner:codex"] })).rejects.toThrow("native_agent_company_mismatch");
  });
  async function trustedFixture() {
    const f = await seed();
    await db.delete(admissionAttempts).where(eq(admissionAttempts.id, f.attempt.id));
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh", config: { host: "runner", port: 2222 } }).returning();
    const [agent] = await db.update(agents).set({ defaultEnvironmentId: environment.id, adapterConfig: { engine: "cli" } }).where(eq(agents.id, f.agent.id)).returning();
    const binding: TrustedCapacityBinding = { companyId: f.company.id, agentId: agent.id,
      environmentId: environment.id, adapterType: agent.adapterType, instance: "fixture-instance", instanceCapacity: 2, runner: "physical-runner",
      providerAccount: "subscription-owner", workspace: "workspace-volume", session: "session-home",
      credential: "credential-store", fenceRoot: "/runner/admission", runnerCapacity: 1, accountCapacity: 1,
      workspaceConfigurations: [capacityFingerprint({})],
      agentFingerprint: capacityFingerprint(capacityAgentContract(agent)),
      environmentFingerprint: capacityFingerprint(capacityEnvironmentContract(environment)) };
    const policy = trustedCapacityPolicy([binding]);
    const trustedDb = createDb(temporary.connectionString);
    policyClients.push(trustedDb);
    const trusted = executionAdmissionService(trustedDb, epoch, policy);
    return { ...f, agent, environment, binding, policy, trusted };
  }
  it("automatically registers every trusted scope and rejects caller scope selection", async () => {
    const f = await trustedFixture();
    await expect(f.trusted.registerRun({ companyId: f.company.id, runId: f.run.id, scopes: ["runner:codex"] }))
      .rejects.toThrow("caller_capacity_scopes_forbidden");
    const attempt = await f.trusted.registerRun({ companyId: f.company.id, runId: f.run.id });
    expect(attempt.scopes).toHaveLength(7);
    expect(attempt.scopes.map(k => k.split(":")[0]).sort()).toEqual(["account", "contract", "credential", "instance", "runner", "session", "workspace"]);
    expect(await db.select().from(admissionScopes).where(inArray(admissionScopes.key, attempt.scopes))).toHaveLength(7);
  });
  it("snapshots host policy and rejects configuration drift before a native claim", async () => {
    const f = await trustedFixture();
    f.binding.runner = "caller-mutated";
    const attempt = await f.trusted.registerRun({ companyId: f.company.id, runId: f.run.id });
    await db.update(environments).set({ config: { host: "different" } }).where(eq(environments.id, f.environment.id));
    expect(await f.trusted.claimNext(nativeClaim)).toBeNull();
    expect(await readAttempt(attempt.id)).toMatchObject({ state: "queued", waitReason: "capacity_configuration_changed" });
    expect((await readRun(f.run.id)).status).toBe("queued");
  });
  it("checks native ownership and selected environment before any workspace command", async () => {
    const f = await trustedFixture();
    await expect(f.trusted.assertRunReady(f.company.id, f.run.id)).rejects.toThrow("capacity_reservation_required");
    await f.trusted.registerRun({ companyId: f.company.id, runId: f.run.id });
    await f.trusted.claimNext(nativeClaim);
    await expect(f.trusted.assertRunReady(f.company.id, f.run.id, randomUUID())).rejects.toThrow("capacity_identity_changed");
    await expect(f.trusted.assertRunReady(f.company.id, f.run.id, f.environment.id)).resolves.toMatchObject({ runner: "physical-runner" });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(f.trusted.assertRunReady(f.company.id, f.run.id)).rejects.toThrow("capacity_native_run_stopped");
  });
  it("does not reset scope drain, cooldown or limits during automatic registration", async () => {
    const f = await trustedFixture();
    const attempt = await f.trusted.registerRun({ companyId: f.company.id, runId: f.run.id });
    const key = attempt.scopes.find(s => s.startsWith("runner:"))!;
    await db.update(admissionScopes).set({ draining: true, capacity: 0 }).where(eq(admissionScopes.key, key));
    await expect(f.trusted.registerRun({ companyId: f.company.id, runId: f.run.id })).rejects.toThrow("capacity_policy_conflict");
    expect((await db.select().from(admissionScopes).where(eq(admissionScopes.key, key)))[0]).toMatchObject({ capacity: 0, draining: true });
  });
  it("shares resource scopes across host aliases and rejects conflicting capacities", async () => {
    const f = await trustedFixture();
    const alias = { ...f.binding, agentId: randomUUID(), environmentId: randomUUID() };
    expect(() => trustedCapacityPolicy([f.binding, { ...alias, runnerCapacity: 2 }])).toThrow("conflicting_capacity_limit");
    expect(() => trustedCapacityPolicy([f.binding, f.binding])).toThrow("duplicate_capacity_agent");
  });
  it("holds setup/probe/lifecycle operations without a durable reservation", async () => {
    const f = await trustedFixture();
    const isolated = createDb(temporary.connectionString);
    try {
      executionAdmissionService(isolated, epoch, f.policy);
      await expect(guardCapacityExecution(isolated, { companyId: f.company.id })).rejects.toThrow("Waiting for execution capacity");
      await expect(guardCapacityExecution(isolated, { companyId: f.company.id, runId: f.run.id })).rejects.toThrow("capacity_reservation_required");
      expect(() => installExecutionCapacity(isolated, f.trusted)).toThrow("capacity_already_installed");
    } finally { await isolated.$client.end(); }
  });

  it("rejects substituted setup targets and task config overrides despite a valid saved ID", async () => {
    const f = await trustedFixture();
    await f.trusted.registerRun({ companyId: f.company.id, runId: f.run.id });
    await f.trusted.claimNext(nativeClaim);
    const isolated = createDb(temporary.connectionString);
    try {
      executionAdmissionService(isolated, epoch, f.policy);
      await expect(guardCapacityExecution(isolated, { companyId: f.company.id, runId: f.run.id,
        environmentId: f.environment.id, environment: { ...f.environment, config: { host: "substituted" } } }))
        .rejects.toThrow("Execution configuration changed");
      await expect(guardCapacityWorkspaceConfiguration(isolated, { companyId: f.company.id, runId: f.run.id,
        configuration: { env: { CODEX_HOME: "/other-owner" } } })).rejects.toThrow("Workspace configuration needs a new capacity decision");
      await expect(guardCapacityWorkspaceConfiguration(isolated, { companyId: f.company.id, runId: f.run.id,
        configuration: {} })).resolves.toBeUndefined();
    } finally { await isolated.$client.end(); }
  });
  it("holds actual environment probe and adapter-test entry points before target setup", async () => {
    const f = await trustedFixture();
    const isolated = createDb(temporary.connectionString);
    try {
      executionAdmissionService(isolated, epoch, f.policy);
      await expect(probeEnvironment(isolated, f.environment as unknown as Parameters<typeof probeEnvironment>[1], { companyId: f.company.id }))
        .rejects.toThrow("Waiting for execution capacity");
      await expect(agentEnvironmentTestService(isolated).resolveAdapterTestExecutionContext({ companyId: f.company.id,
        agentId: f.agent.id, adapterType: f.agent.adapterType, environmentId: f.environment.id }))
        .rejects.toThrow("Waiting for execution capacity");
      const verification = agentHarnessVerificationService(isolated, {} as Parameters<typeof agentHarnessVerificationService>[1]);
      await expect(verification.verify(f.agent as unknown as Parameters<typeof verification.verify>[0])).resolves.toBe("pending");
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.run.id)))).toHaveLength(0);
    } finally { await isolated.$client.end(); }
  });

  it("charges shared account and state identities across distinct companies and runner aliases", async () => {
    const a = await trustedFixture(), b = await trustedFixture();
    const client = createDb(temporary.connectionString);
    policyClients.push(client);
    const shared = executionAdmissionService(client, epoch, trustedCapacityPolicy([
      a.binding, { ...b.binding, runner: "another-runner" },
    ]));
    const first = await shared.registerRun({ companyId: a.company.id, runId: a.run.id });
    const second = await shared.registerRun({ companyId: b.company.id, runId: b.run.id });
    expect(first.scopes.filter(key => second.scopes.includes(key))).toHaveLength(5);
    expect((await shared.claimNext(nativeClaim))?.run.id).toBe(a.run.id);
    expect(await shared.claimNext(nativeClaim)).toBeNull();
    expect((await readAttempt(second.id)).waitReason).toMatch(/^capacity:account:/);
    expect((await readRun(b.run.id)).status).toBe("queued");
  });

  it("checks task environment sources and rejects paid API bindings before executable preparation", async () => {
    const f = await trustedFixture();
    const contract = capacityWorkspaceContract({ sourceWorkspaceConfig: {} });
    const client = createDb(temporary.connectionString);
    policyClients.push(client);
    const trusted = executionAdmissionService(client, epoch, trustedCapacityPolicy([
      { ...f.binding, workspaceConfigurations: [capacityFingerprint(contract)] },
    ]));
    await trusted.registerRun({ companyId: f.company.id, runId: f.run.id });
    await trusted.claimNext(nativeClaim);
    await expect(guardCapacityWorkspaceConfiguration(client, { companyId: f.company.id, runId: f.run.id,
      configuration: capacityWorkspaceContract({ sourceWorkspaceConfig: {}, projectEnv: { CODEX_HOME: "/other" } }) }))
      .rejects.toThrow("Workspace configuration needs a new capacity decision");
    await expect(guardCapacityWorkspaceConfiguration(client, { companyId: f.company.id, runId: f.run.id,
      configuration: capacityWorkspaceContract({ sourceWorkspaceConfig: {}, aiBinding: { mode: "direct" } }) }))
      .rejects.toThrow("This AI connection needs trusted capacity admission");
    await expect(guardCapacityResolvedExecutionConfig(client, { companyId: f.company.id, runId: f.run.id,
      configuration: { env: { OPENAI_API_KEY: "synthetic-fixture-key" } } }))
      .rejects.toThrow("This credential needs trusted capacity admission");
    await expect(guardCapacityWorkspaceConfiguration(client, { companyId: f.company.id, runId: f.run.id,
      configuration: contract })).resolves.toBeUndefined();
  });

  it("holds managed account routing before its usage probes even when raw config was pinned", async () => {
    const f = await trustedFixture();
    const [agent] = await db.update(agents).set({ runtimeConfig: { aiConnection: { mode: "router", connectionId: randomUUID() } } })
      .where(eq(agents.id, f.agent.id)).returning();
    const client = createDb(temporary.connectionString);
    policyClients.push(client);
    const trusted = executionAdmissionService(client, epoch, trustedCapacityPolicy([
      { ...f.binding, agentFingerprint: capacityFingerprint(capacityAgentContract(agent)) },
    ]));
    await expect(trusted.registerRun({ companyId: f.company.id, runId: f.run.id })).rejects.toThrow("capacity_configuration_changed");
    expect((await readRun(f.run.id)).status).toBe("queued");
    expect(await db.select().from(admissionAttempts).where(eq(admissionAttempts.runId, f.run.id))).toHaveLength(0);
  });

  async function operationFixture() {
    const f = await trustedFixture();
    const operation = await f.trusted.registerOperation({ companyId: f.company.id, agentId: f.agent.id,
      environmentId: f.environment.id, kind: "lifecycle", key: "verify:0" });
    const reservation = (await f.trusted.claimOperation(f.company.id, operation.id))!;
    const owner = { companyId: f.company.id, attemptId: operation.id, token: reservation.token! };
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.company.id,
      environmentId: f.environment.id, provider: "ssh", status: "active",
      metadata: { agentId: f.agent.id, admissionOperationId: operation.id, admissionAttemptId: operation.id } }).returning();
    return { ...f, operation, reservation, owner, lease };
  }
  it("reserves auxiliary work durably without inserting a heartbeat run", async () => {
    const f = await operationFixture();
    expect(f.reservation).toMatchObject({ runId: null, operationKind: "lifecycle", state: "reserved" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(1);
    expect((await readRun(f.run.id)).status).toBe("queued");
    await expect(f.trusted.assertOperationReady({ ...f.owner, environmentId: f.environment.id }))
      .resolves.toMatchObject({ agentId: f.agent.id });
    expect(await f.trusted.claimOperation(f.company.id, f.operation.id)).toBeNull();
    await f.trusted.registerRun({ companyId: f.company.id, runId: f.run.id });
    expect(await f.trusted.claimNext(nativeClaim)).toBeNull();
    await expect(f.trusted.assertOperationReady({ ...f.owner, companyId: randomUUID() })).rejects.toThrow("admission_ownership");
  });
  it("journals distinct helpers and holds capacity for every missing stop or restoration", async () => {
    const f = await operationFixture();
    const launch = { ...f.owner, leaseId: f.lease.id, commandHash: "a".repeat(64) };
    await expect(f.trusted.journalCommand(launch)).rejects.toThrow("capacity_runner_epoch_unacknowledged");
    await f.trusted.acknowledgeRunnerEpoch({ companyId: f.company.id, agentId: f.agent.id,
      epoch, fenceRoot: f.binding.fenceRoot! });
    const first = await f.trusted.journalCommand(launch);
    await expect(f.trusted.journalCommand(launch)).rejects.toThrow("admission_command_pending");
    await f.trusted.recordCommandStopped({ ...f.owner, ...first, stopped: true });
    const second = await f.trusted.journalCommand(launch);
    expect(first.binding.attemptId).not.toBe(second.binding.attemptId);
    expect(first.binding.invocationId).not.toBe(second.binding.invocationId);
    expect(first.binding.runId).toBe(f.operation.id);
    await f.trusted.cancel(f.company.id, f.operation.id);
    await expect(f.trusted.journalCommand(launch)).rejects.toThrow("admission_launch_consumed");
    await expect(f.trusted.beginRestoration(f.owner)).rejects.toThrow("admission_process_stop_unverified");
    await f.trusted.recordCommandStopped({ ...f.owner, ...first, stopped: true });
    await expect(f.trusted.beginRestoration(f.owner)).rejects.toThrow("admission_process_stop_unverified");
    await expect(f.trusted.recordCommandStopped({ ...f.owner, binding: { ...second.binding, leaseId: randomUUID() }, stopped: true }))
      .rejects.toThrow("admission_stop_binding_changed");
    await f.trusted.recordCommandStopped({ ...f.owner, ...second, stopped: true });
    await f.trusted.beginRestoration(f.owner);
    await f.trusted.recordRestoration({ ...f.owner, kind: "workspace", success: true });
    await f.trusted.recordRestoration({ ...f.owner, kind: "session", success: true });
    await f.trusted.recordRestoration({ ...f.owner, kind: "credential", success: false });
    await expect(f.trusted.releaseCapacity(f.owner)).rejects.toThrow("admission_restoration_unverified");
    expect((await readAttempt(f.operation.id)).state).toBe("stopping");
    await f.trusted.recordRestoration({ ...f.owner, kind: "credential", success: true });
    await f.trusted.releaseCapacity(f.owner);
    expect((await readAttempt(f.operation.id)).state).toBe("released");
    expect(await db.select().from(admissionCommands).where(eq(admissionCommands.attemptId, f.operation.id))).toHaveLength(2);
  });
  it("retains lost-launch and partial-restoration occupancy across controller takeover", async () => {
    const f = await operationFixture();
    await f.trusted.acknowledgeRunnerEpoch({ companyId: f.company.id, agentId: f.agent.id, epoch, fenceRoot: f.binding.fenceRoot! });
    await f.trusted.journalCommand({ ...f.owner, leaseId: f.lease.id, commandHash: "b".repeat(64) });
    const next = randomUUID();
    await f.trusted.takeover(next);
    expect((await readAttempt(f.operation.id)).state).toBe("uncertain");
    await expect(f.trusted.releaseCapacity(f.owner)).rejects.toThrow("stale_admission_controller");
    const client = createDb(temporary.connectionString);
    policyClients.push(client);
    const successor = executionAdmissionService(client, next, f.policy);
    await expect(successor.beginRestoration(f.owner)).rejects.toThrow("admission_ownership");
    expect((await db.select().from(admissionCommands).where(eq(admissionCommands.attemptId, f.operation.id)))[0].stopped).toBe(false);
  });

  it("adopts cleanup only after remote epoch acknowledgement and never rewrites old command authority", async () => {
    const f = await operationFixture();
    await f.trusted.acknowledgeRunnerEpoch({ companyId: f.company.id, agentId: f.agent.id, epoch, fenceRoot: f.binding.fenceRoot! });
    const command = await f.trusted.journalCommand({ ...f.owner, leaseId: f.lease.id, commandHash: "c".repeat(64) });
    const next = randomUUID();
    await f.trusted.takeover(next);
    const client = createDb(temporary.connectionString); policyClients.push(client);
    const successor = executionAdmissionService(client, next, f.policy);
    await expect(successor.adoptReservation(f.company.id, f.operation.id)).rejects.toThrow("capacity_runner_epoch_unacknowledged");
    await successor.acknowledgeRunnerEpoch({ companyId: f.company.id, agentId: f.agent.id, epoch: next, fenceRoot: f.binding.fenceRoot! });
    const adopted = await successor.adoptReservation(f.company.id, f.operation.id);
    const owner = { companyId: f.company.id, attemptId: adopted.id, token: adopted.token! };
    expect(adopted).toMatchObject({ state: "stopping", ownerEpoch: next });
    expect(adopted.token).not.toBe(f.owner.token);
    await expect(successor.journalCommand({ ...owner, leaseId: f.lease.id, commandHash: "d".repeat(64) })).rejects.toThrow("admission_launch_consumed");
    await expect(successor.beginRestoration(owner)).rejects.toThrow("admission_process_stop_unverified");
    await successor.recordCommandStopped({ ...owner, binding: command.binding, stopped: true });
    await successor.beginRestoration(owner);
    for (const kind of ["workspace", "session", "credential"] as const) await successor.recordRestoration({ ...owner, kind, success: true });
    await successor.releaseCapacity(owner);
    const [retained] = await db.select().from(admissionCommands).where(eq(admissionCommands.attemptId, adopted.id));
    expect(retained.binding).toEqual(command.binding);
    expect(retained.binding.epoch).toBe(epoch);
    expect((await readAttempt(adopted.id)).state).toBe("released");
  });
  it("deduplicates completed lifecycle verification by its exact operation and version", async () => {
    const f = await operationFixture();
    await f.trusted.beginRestoration(f.owner);
    for (const kind of ["workspace", "session", "credential"] as const) await f.trusted.recordRestoration({ ...f.owner, kind, success: true });
    await f.trusted.recordOperationResult({ ...f.owner, result: "complete" });
    await f.trusted.releaseCapacity(f.owner);
    const input = { companyId: f.company.id, agentId: f.agent.id, environmentId: f.environment.id, kind: "lifecycle" as const, key: "verify:0" };
    expect(await f.trusted.registerOperation(input)).toMatchObject({ id: f.operation.id, state: "released", operationResult: "complete" });
    await db.update(agents).set({ lifecycleVersion: 1 }).where(eq(agents.id, f.agent.id));
    await expect(f.trusted.registerOperation(input)).rejects.toThrow("capacity_lifecycle_changed");
    expect((await f.trusted.registerOperation({ ...input, key: "verify:1" })).id).not.toBe(f.operation.id);
  });
  it("requires all successful restoration obligations even after a controller adoption", async () => {
    const f = await operationFixture();
    const id = await f.trusted.requireRestoration({ ...f.owner, kind: "credential", descriptor: { operation: "synthetic" } });
    await f.trusted.finishRestoration({ ...f.owner, id, kind: "credential", success: false });
    const next = randomUUID(); await f.trusted.takeover(next);
    const client = createDb(temporary.connectionString); policyClients.push(client);
    const successor = executionAdmissionService(client, next, f.policy);
    await successor.acknowledgeRunnerEpoch({ companyId: f.company.id, agentId: f.agent.id, epoch: next, fenceRoot: f.binding.fenceRoot! });
    const adopted = await successor.adoptReservation(f.company.id, f.operation.id);
    const owner = { companyId: f.company.id, attemptId: adopted.id, token: adopted.token! };
    await successor.beginRestoration(owner);
    await expect(successor.recordRestoration({ ...owner, kind: "credential", success: true })).rejects.toThrow("admission_restoration_unverified");
    await expect(successor.releaseCapacity(owner)).rejects.toThrow("admission_restoration_unverified");
    expect((await readAttempt(adopted.id)).state).toBe("stopping");
  });

  it("retains an absent auxiliary caller without letting expired readiness strand native work", async () => {
    const f = await trustedFixture();
    const operation = await f.trusted.registerOperation({ companyId: f.company.id, agentId: f.agent.id,
      environmentId: f.environment.id, kind: "probe", key: "fair-probe" });
    await f.trusted.registerRun({ companyId: f.company.id, runId: f.run.id });
    await f.trusted.prepareRun(f.company.id, f.run.id, true);
    await db.update(admissionAttempts).set({ eligibleUntil: new Date(Date.now() + 60_000) }).where(eq(admissionAttempts.id, operation.id));
    expect(await f.trusted.claimTransaction(f.run, tx => nativeClaim(tx, f.run))).toBeNull();
    expect((await readRun(f.run.id)).status).toBe("queued");
    await db.update(admissionAttempts).set({ eligibleUntil: new Date(0) }).where(eq(admissionAttempts.id, operation.id));
    expect(await f.trusted.claimTransaction(f.run, tx => nativeClaim(tx, f.run))).toMatchObject({ id: f.run.id, status: "running" });
    expect((await readAttempt(operation.id)).state).toBe("queued");
  });

  it("keeps lifecycle stop pending through state restoration and accepts only its settled exact lease", async () => {
    const f = await operationFixture();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await agentExecutionsHaveStopped(db, [f.agent.id])).toBe(false);
    await f.trusted.cancel(f.company.id, f.operation.id);
    await f.trusted.beginRestoration(f.owner);
    for (const kind of ["workspace", "session"] as const) await f.trusted.recordRestoration({ ...f.owner, kind, success: true });
    expect(await agentExecutionsHaveStopped(db, [f.agent.id])).toBe(false);
    await f.trusted.recordRestoration({ ...f.owner, kind: "credential", success: true });
    await f.trusted.releaseCapacity(f.owner);
    expect(await agentExecutionsHaveStopped(db, [f.agent.id])).toBe(true);
    await db.insert(environmentLeases).values({ companyId: f.company.id, environmentId: f.environment.id,
      provider: "ssh", status: "active", metadata: { agentId: f.agent.id } });
    expect(await agentExecutionsHaveStopped(db, [f.agent.id])).toBe(false);
  });

  it("cannot save a lifecycle result after cancellation has won over finalization", async () => {
    const f = await operationFixture();
    await f.trusted.beginRestoration(f.owner);
    await f.trusted.cancel(f.company.id, f.operation.id);
    await expect(f.trusted.recordOperationResult({ ...f.owner, result: "complete" })).rejects.toThrow("capacity_operation_result_not_admitted");
    for (const kind of ["workspace", "session", "credential"] as const) await f.trusted.recordRestoration({ ...f.owner, kind, success: true });
    await f.trusted.releaseCapacity(f.owner);
    expect((await readAttempt(f.operation.id)).operationResult).toBeNull();
  });

  it("permits known in-flight service siblings but blocks an unresolved command after host context loss", async () => {
    const f = await operationFixture();
    await f.trusted.acknowledgeRunnerEpoch({ companyId: f.company.id, agentId: f.agent.id, epoch, fenceRoot: f.binding.fenceRoot! });
    const input = { ...f.owner, leaseId: f.lease.id, commandHash: "1".repeat(64) };
    const service = await f.trusted.journalCommand(input);
    const provider = await f.trusted.journalCommand({ ...input, concurrentWith: [service.binding.attemptId] });
    await expect(f.trusted.journalCommand({ ...input, concurrentWith: [provider.binding.attemptId] })).rejects.toThrow("admission_command_pending");
    await expect(f.trusted.beginRestoration(f.owner)).rejects.toThrow("admission_process_stop_unverified");
    await f.trusted.recordCommandStopped({ ...f.owner, binding: provider.binding, stopped: true });
    await expect(f.trusted.beginRestoration(f.owner)).rejects.toThrow("admission_process_stop_unverified");
    await f.trusted.recordCommandStopped({ ...f.owner, binding: service.binding, stopped: true });
    await f.trusted.beginRestoration(f.owner);
  });

  it("enumerates only current-owner stopping reservations and rejects a stale sweep after takeover", async () => {
    const f = await operationFixture();
    expect(await f.trusted.stoppingReservations()).toEqual([]);
    await f.trusted.beginRestoration(f.owner);
    expect((await f.trusted.stoppingReservations()).map(row => row.id)).toEqual([f.operation.id]);
    const next = randomUUID();
    await f.trusted.takeover(next);
    await expect(f.trusted.stoppingReservations()).rejects.toThrow("stale_admission_controller");
    const client = createDb(temporary.connectionString); policyClients.push(client);
    const successor = executionAdmissionService(client, next, f.policy);
    expect(await successor.stoppingReservations()).toEqual([]);
    expect((await readAttempt(f.operation.id)).state).toBe("uncertain");
  });

  it("serializes local restoration apply with controller takeover and rejects stale writers", async () => {
    const f = await operationFixture();
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const applying = f.trusted.mutateRestoration(f.owner, async () => { entered(); await gate; return "saved"; });
    await started;
    const next = randomUUID();
    const takeover = service.takeover(next);
    try {
      expect((await db.select().from(admissionScheduler))[0].epoch).toBe(epoch);
    } finally { finish(); }
    expect(await applying).toBe("saved");
    await takeover;
    let mutated = false;
    await expect(f.trusted.mutateRestoration(f.owner, async () => { mutated = true; })).rejects.toThrow("stale_admission_controller");
    expect(mutated).toBe(false);
  });

});
