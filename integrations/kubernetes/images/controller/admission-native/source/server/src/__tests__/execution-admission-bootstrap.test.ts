import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admissionAttempts, admissionBootstraps, admissionEpochs, admissionLegacyHolds, admissionRunnerEpochs,
  admissionScheduler, admissionScopes, agents, companies, createDb, environmentLeases, environments, heartbeatRuns,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { bootstrapHeldExecutionAdmission, bootstrapProductionAdmission, loadAdmissionBootstrapPolicy,
  parseAdmissionBootstrapPolicy, loadProductionAdmissionPolicy, requireAdmissionMigrations, type AdmissionBootstrapPolicy } from "../services/execution-admission-bootstrap.js";
import { executionCapacity, guardCapacityExecution } from "../services/execution-capacity-context.js";
import { capacityScopeKey } from "../services/execution-capacity-policy.js";
import { executionAdmissionService } from "../services/execution-admission.js";

const emptyPolicy = (): AdmissionBootstrapPolicy => ({ version: 1, mode: "held", instance: "fixture-instance", pendingLimit: 4, legacyOwners: [] });
describe("mandatory held admission bootstrap", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const clients: ReturnType<typeof createDb>[] = [];
  function client() { const value = createDb(temporary.connectionString); clients.push(value); return value; }
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("admission-bootstrap-"); db = client(); }, 120_000);
  afterAll(async () => { await Promise.all(clients.map(c => c.$client.end())); await temporary?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`truncate execution_admission_legacy_holds, execution_admission_bootstraps,
      execution_admission_restorations, execution_admission_commands, execution_admission_runner_epochs,
      execution_admission_attempts, execution_admission_projects, execution_admission_scopes,
      execution_admission_scheduler, execution_admission_epochs, environment_leases, heartbeat_runs cascade`);
  });
  async function seed() {
    const [company] = await db.insert(companies).values({ name: "legacy", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh" }).returning();
    const [a] = await db.insert(agents).values({ companyId: company.id, name: "historical A", adapterType: "codex_local",
      status: "paused", lifecycleState: "pausing", defaultEnvironmentId: environment.id }).returning();
    const [b] = await db.insert(agents).values({ companyId: company.id, name: "B", adapterType: "codex_local", defaultEnvironmentId: environment.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: a.id, status: "cancelled" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, heartbeatRunId: run.id,
      environmentId: environment.id, status: "expired", provider: "ssh", releasedAt: new Date(), metadata: { agentId: a.id } }).returning();
    const owner = { companyId: company.id, agentId: a.id, environmentId: environment.id, runner: "physical-codex",
      providerAccount: "codex-account", credential: "codex-refresh-family", session: "codex-sessions", workspace: "codex-workspaces" };
    return { company, environment, a, b, run, lease, policy: { ...emptyPolicy(), legacyOwners: [owner] }, owner };
  }
  it.each([undefined, "relative.json"])("rejects missing/untrusted policy path %s", async path => {
    const c = client();
    await expect(bootstrapProductionAdmission(c, path)).rejects.toThrow("admission_bootstrap_policy_required");
    expect(() => executionCapacity(c)).toThrow("capacity_bootstrap_required");
    await expect(guardCapacityExecution(c, { companyId: randomUUID() })).rejects.toThrow("capacity_bootstrap_required");
    expect(await db.select().from(admissionScheduler)).toHaveLength(0);
  });
  it.each([{}, { ...emptyPolicy(), mode: "active" }, { ...emptyPolicy(), startsHeld: false },
    { ...emptyPolicy(), pendingLimit: 5 }, { ...emptyPolicy(), legacyOwners: [{ runner: "bad" }] }])("rejects malformed or enabling policy %#", value => {
    expect(() => parseAdmissionBootstrapPolicy(value)).toThrow("invalid_admission_bootstrap_policy");
  });
  it("rejects a policy placed in writable /tmp", async () => {
    const { writeFile, unlink } = await import("node:fs/promises");
    const path = `/tmp/admission-policy-${randomUUID()}.json`;
    await writeFile(path, JSON.stringify(emptyPolicy()));
    try { await expect(loadAdmissionBootstrapPolicy(path)).rejects.toThrow("admission_bootstrap_policy_unprotected"); }
    finally { await unlink(path); }
  });
  it("rejects an agent-writable alias even when it points to a protected policy", async () => {
    const { symlink, unlink } = await import("node:fs/promises");
    const path = `/tmp/admission-alias-${randomUUID()}.json`;
    await symlink("/etc/paperclip-admission-fixture/policy.json", path);
    try { await expect(loadAdmissionBootstrapPolicy(path)).rejects.toThrow("admission_bootstrap_policy_unprotected"); }
    finally { await unlink(path); }
  });
  it("loads a protected projected configuration file without an agent-writable fallback", async () => {
    expect(await loadAdmissionBootstrapPolicy("/etc/paperclip-admission-fixture/policy.json")).toEqual(emptyPolicy());
  });
  it("rehearses migration failure rollback and successful upgrade with legacy state intact", async () => {
    const f = await seed();
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0344_volatile_colossus.sql", import.meta.url), "utf8");
    const statements = migration.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
    const decisionMigration = await readFile(new URL("../../../packages/db/src/migrations/0345_legacy_present_day_decisions.sql", import.meta.url), "utf8");
    const decisionStatements = decisionMigration.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
    await db.execute(sql`drop table execution_admission_legacy_decisions`);
    await db.execute(sql`drop function execution_admission_legacy_decisions_immutable()`);
    await db.execute(sql`drop table execution_admission_legacy_holds, execution_admission_bootstraps`);
    try {
      await expect(db.transaction(async tx => {
        await tx.execute(sql.raw(statements[0]));
        throw Error("injected migration interruption");
      })).rejects.toThrow("injected migration interruption");
      const absent = await db.execute(sql`select to_regclass('public.execution_admission_bootstraps') as table_name`);
      expect(absent[0].table_name).toBeNull();
      await db.transaction(async tx => { for (const statement of statements) await tx.execute(sql.raw(statement)); });
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
      const boot = await bootstrapHeldExecutionAdmission(client(), f.policy);
      expect(boot.legacyHolds).toBe(1);
    } finally {
      // Keep fixture teardown valid even if a rehearsal assertion fails.
      const present = await db.execute(sql`select to_regclass('public.execution_admission_bootstraps') as table_name`);
      if (!present[0].table_name) await db.transaction(async tx => { for (const statement of statements) await tx.execute(sql.raw(statement)); });
      await db.transaction(async tx => { for (const statement of decisionStatements) await tx.execute(sql.raw(statement)); });
    }
  });
  it.each([
    { databaseUrl: undefined, autoApply: "false", error: "admission_bootstrap_requires_external_database" },
    { databaseUrl: "postgres://fixture", autoApply: undefined, error: "admission_bootstrap_requires_manual_migration" },
    { databaseUrl: "postgres://fixture", autoApply: "true", error: "admission_bootstrap_requires_manual_migration" },
  ])("rejects production database/migration fallback %#", async input => {
    await expect(loadProductionAdmissionPolicy(input)).rejects.toThrow(input.error);
  });
  it("refuses an absent migration ledger without repairing it or applying schema", async () => {
    await requireAdmissionMigrations(temporary.connectionString);
    const schemas = await db.execute(sql`select table_schema from information_schema.tables
      where table_name = '__drizzle_migrations' order by table_schema`);
    const schema = String(schemas[0].table_schema);
    const original = sql`${sql.identifier(schema)}.${sql.identifier("__drizzle_migrations")}`;
    const saved = sql`${sql.identifier(schema)}.${sql.identifier("__drizzle_migrations_bootstrap_saved")}`;
    const before = await db.execute(sql`select * from ${original} order by id`);
    await db.execute(sql`alter table ${original} rename to __drizzle_migrations_bootstrap_saved`);
    try {
      await expect(requireAdmissionMigrations(temporary.connectionString)).rejects.toThrow("admission_bootstrap_schema_not_current");
      expect(await db.execute(sql`select * from ${saved} order by id`)).toEqual(before);
      expect(await db.execute(sql`select table_name from information_schema.tables where table_name = '__drizzle_migrations'`)).toHaveLength(0);
    } finally { await db.execute(sql`alter table ${saved} rename to __drizzle_migrations`); }
  });
  it("captures expired A as shared occupancy without changing its historical lease/run/lifecycle", async () => {
    const f = await seed();
    const boot = await bootstrapHeldExecutionAdmission(client(), f.policy);
    const [hold] = await db.select().from(admissionLegacyHolds);
    expect(hold).toMatchObject({ source: `lease:${f.lease.id}`, companyId: f.company.id, agentId: f.a.id, runId: f.run.id });
    expect(hold.scopes).toContain(capacityScopeKey("credential", f.owner.credential));
    expect(hold.scopes).toContain(capacityScopeKey("runner", f.owner.runner));
    expect(hold.scopes).toHaveLength(5);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
    expect((await db.select().from(agents).where(eq(agents.id, f.a.id)))[0]).toEqual(f.a);
    expect(boot.legacyHolds).toBe(1);
    expect(await db.select().from(admissionRunnerEpochs)).toHaveLength(0);
  });
  it("blocks B on shared scopes even if someone clears every ordinary drain", async () => {
    const f = await seed();
    const boot = await bootstrapHeldExecutionAdmission(client(), f.policy);
    const [bRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.b.id, status: "queued" }).returning();
    const shared = capacityScopeKey("credential", f.owner.credential);
    await db.insert(admissionScopes).values({ key: shared, capacity: 1 });
    const raw = executionAdmissionService(client(), boot.epoch);
    const attempt = await raw.registerRun({ companyId: f.company.id, runId: bRun.id, scopes: [shared] });
    await db.update(admissionScheduler).set({ draining: false, evaluationExemptionUntil: new Date(Date.now() + 60_000) });
    await db.update(admissionScopes).set({ draining: false });
    expect(await raw.claimNext(async () => { throw Error("must not claim B"); })).toBeNull();
    expect((await db.select().from(admissionAttempts).where(eq(admissionAttempts.id, attempt.id)))[0].waitReason)
      .toBe("legacy_occupancy_unreconciled");
    expect(await boot.admission.claimNext(async () => { throw Error("held bootstrap"); })).toBeNull();
  });
  it("uses an instance-wide hold for unmapped leases and lease-less native work", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.b.id, status: "succeeded" });
    await bootstrapHeldExecutionAdmission(client(), emptyPolicy());
    const holds = await db.select().from(admissionLegacyHolds);
    expect(holds).toHaveLength(2);
    expect(holds.every(h => JSON.stringify(h.scopes) === JSON.stringify([capacityScopeKey("instance", "fixture-instance")]))).toBe(true);
  });
  it("does not trust conflicting lease metadata to assign an account", async () => {
    const f = await seed();
    await db.update(environmentLeases).set({ metadata: { agentId: f.b.id } }).where(eq(environmentLeases.id, f.lease.id));
    await bootstrapHeldExecutionAdmission(client(), f.policy);
    expect((await db.select().from(admissionLegacyHolds))[0]).toMatchObject({ agentId: null,
      scopes: [capacityScopeKey("instance", "fixture-instance")] });
  });
  it("keeps holds byte-identical across restart, fences old controller and records policy/epoch history", async () => {
    const f = await seed();
    const one = await bootstrapHeldExecutionAdmission(client(), f.policy);
    const before = await db.select().from(admissionLegacyHolds);
    const two = await bootstrapHeldExecutionAdmission(client(), f.policy);
    expect(two.epoch).not.toBe(one.epoch);
    expect(await db.select().from(admissionLegacyHolds)).toEqual(before);
    expect(await db.select().from(admissionBootstraps)).toHaveLength(2);
    await expect(one.admission.queuedAgents()).resolves.toBeDefined(); // read-only inventory is allowed
    await expect(one.admission.cancel(f.company.id, randomUUID())).rejects.toThrow("stale_admission_controller");
    expect((await db.select().from(admissionScheduler))[0]).toMatchObject({ epoch: two.epoch, draining: true });
  });
  it("retains previous uncertain ownership on restart without issuing remote acknowledgement", async () => {
    const f = await seed();
    const one = await bootstrapHeldExecutionAdmission(client(), f.policy);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.b.id, status: "queued" }).returning();
    const scope = capacityScopeKey("instance", "fixture-instance");
    await db.insert(admissionScopes).values({ key: scope, capacity: 1 });
    const raw = executionAdmissionService(client(), one.epoch);
    const attempt = await raw.registerRun({ companyId: f.company.id, runId: run.id, scopes: [scope] });
    await db.update(admissionAttempts).set({ state: "starting", ownerEpoch: one.epoch, token: randomUUID() }).where(eq(admissionAttempts.id, attempt.id));
    const before = (await db.select().from(admissionAttempts).where(eq(admissionAttempts.id, attempt.id)))[0];
    await bootstrapHeldExecutionAdmission(client(), f.policy);
    expect((await db.select().from(admissionAttempts).where(eq(admissionAttempts.id, attempt.id)))[0])
      .toMatchObject({ state: "uncertain", ownerEpoch: one.epoch, token: before.token, contract: before.contract });
    expect(await db.select().from(admissionRunnerEpochs)).toHaveLength(0);
  });
  it.each(["mapping", "native", "instance"])("fails closed and rolls back on %s drift", async drift => {
    const f = await seed();
    await bootstrapHeldExecutionAdmission(client(), f.policy);
    const before = (await db.select().from(admissionScheduler))[0];
    const changed = structuredClone(f.policy);
    if (drift === "mapping") changed.legacyOwners[0].credential = "new-key-bypass";
    if (drift === "instance") changed.instance = "new-instance-bypass";
    if (drift === "native") await db.update(environmentLeases).set({ cleanupStatus: "success" }).where(eq(environmentLeases.id, f.lease.id));
    const c = client();
    await expect(bootstrapHeldExecutionAdmission(c, changed)).rejects.toThrow(drift === "instance" ? "admission_bootstrap_instance_changed" : "admission_legacy_hold_drift");
    expect(() => executionCapacity(c)).toThrow("capacity_bootstrap_required");
    expect((await db.select().from(admissionScheduler))[0]).toEqual(before);
    expect(await db.select().from(admissionEpochs)).toHaveLength(1);
    expect(await db.select().from(admissionLegacyHolds)).toHaveLength(1);
  });
  it("rejects a second install on one handle before changing durable ownership", async () => {
    const c = client();
    await bootstrapHeldExecutionAdmission(c, emptyPolicy());
    const before = (await db.select().from(admissionScheduler))[0];
    await expect(bootstrapHeldExecutionAdmission(c, emptyPolicy())).rejects.toThrow("capacity_already_installed");
    expect((await db.select().from(admissionScheduler))[0]).toEqual(before);
  });
  it("refuses unknown previous owners and undrained schedulers", async () => {
    const epoch = randomUUID();
    await db.insert(admissionEpochs).values({ epoch });
    await db.insert(admissionScheduler).values({ epoch, pendingLimit: 4, draining: false });
    await expect(bootstrapHeldExecutionAdmission(client(), emptyPolicy())).rejects.toThrow("admission_bootstrap_requires_drain");
    await db.update(admissionScheduler).set({ draining: true });
    await expect(bootstrapHeldExecutionAdmission(client(), emptyPolicy())).rejects.toThrow("admission_bootstrap_unknown_previous_owner");
    expect(await db.select().from(admissionBootstraps)).toHaveLength(0);
  });
  it("never provides command, lease-launch, run or auxiliary setup authority in held mode", async () => {
    const boot = await bootstrapHeldExecutionAdmission(client(), emptyPolicy());
    const owner = { companyId: randomUUID(), attemptId: randomUUID(), token: randomUUID() };
    await expect(boot.admission.assertRunReady(owner.companyId, randomUUID())).rejects.toThrow("capacity_bootstrap_held");
    await expect(boot.admission.assertOperationReady(owner)).rejects.toThrow("capacity_bootstrap_held");
    await expect(boot.admission.journalCommand({ ...owner, leaseId: randomUUID(), commandHash: "a".repeat(64) })).rejects.toThrow("capacity_bootstrap_held");
    expect(() => boot.admission.journalLaunch({ ...owner, leaseId: randomUUID(), invocationId: randomUUID() })).toThrow("capacity_bootstrap_held");
    await expect(boot.admission.acknowledgeRunnerEpoch({ companyId: owner.companyId, agentId: randomUUID(), fenceRoot: "/fake", epoch: boot.epoch }))
      .rejects.toThrow("capacity_bootstrap_held");
  });
  it("rolls back partial hold inventory if a later hold conflicts", async () => {
    const f = await seed();
    await bootstrapHeldExecutionAdmission(client(), f.policy);
    const [extra] = await db.insert(environmentLeases).values({ companyId: f.company.id, provider: "ssh", status: "active" }).returning();
    await db.update(admissionLegacyHolds).set({ evidenceHash: "f".repeat(64) });
    await expect(bootstrapHeldExecutionAdmission(client(), f.policy)).rejects.toThrow("admission_legacy_hold_drift");
    expect(await db.select().from(admissionLegacyHolds).where(eq(admissionLegacyHolds.source, `lease:${extra.id}`))).toHaveLength(0);
    expect(await db.select().from(admissionEpochs)).toHaveLength(1);
  });
});
