import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admissionScopes, admissionAttempts, admissionLegacyDecisions, admissionLegacyHolds, admissionScheduler, agents, companies, createDb,
  environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { bootstrapHeldExecutionAdmission } from "../services/execution-admission-bootstrap.js";
import { legacyHoldFingerprint, legacyHoldIsReconciled, legacyReconciliationService, type LegacyDecision } from "../services/execution-legacy-reconciliation.js";
import { executionAdmissionService } from "../services/execution-admission.js";
import { capacityFingerprint } from "../services/execution-capacity-policy.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";

describe("present-day legacy decisions on disposable PostgreSQL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let worker: ReturnType<typeof configureAgentLifecycle> | undefined;
  const key = randomBytes(32);
  // Synthetic-only verifier: tests service binding, not real evidence issuance.
  const syntheticEvidence = async ({ decision, inventoryHash }: { decision: LegacyDecision; inventoryHash: string }) =>
    ({ decisionHash: capacityFingerprint(decision), inventoryHash, expiresAt: Math.min(decision.expiresAt, Date.now() + 60_000) });
  const clients: ReturnType<typeof createDb>[] = [];
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("legacy-decisions-"); db = createDb(temporary.connectionString); }, 120000);
  afterAll(async () => { await worker?.stop(); await db.$client.end(); for (const client of clients) await client.$client.end(); await temporary.cleanup(); });
  beforeEach(async () => { await worker?.stop(); worker = undefined; await db.execute(sql`truncate execution_admission_legacy_decisions,
    execution_admission_legacy_holds, execution_admission_bootstraps, execution_admission_scheduler, execution_admission_epochs, environment_leases, heartbeat_runs, agents, companies cascade`); });
  async function seed(includeSibling = false) {
    const [company] = await db.insert(companies).values({ name: "synthetic clone", issuePrefix: randomUUID().slice(0, 7) }).returning();
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "A", adapterType: "codex_local", status: "idle", lifecycleState: "ready" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "cancelled", startedAt: new Date() }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, environmentId: environment.id,
      heartbeatRunId: run.id, provider: "ssh", status: "expired", releasedAt: new Date(), metadata: { agentId: agent.id } }).returning();
    if (includeSibling) await db.insert(environmentLeases).values({ companyId: company.id, environmentId: environment.id, heartbeatRunId: run.id, provider: "ssh", status: "expired", releasedAt: new Date(), metadata: { agentId: agent.id } });
    const policy = { version: 1, mode: "held", instance: "fixture", pendingLimit: 4, legacyOwners: [{ companyId: company.id,
      agentId: agent.id, environmentId: environment.id, runner: "original-codex", providerAccount: "original-account", workspace: "original-workspace", session: "original-session", credential: "original-credential" }] };
    // Separate connection models a held restart. Do not replace its capacity service.
    const client = createDb(temporary.connectionString); clients.push(client);
    const bootstrap = await bootstrapHeldExecutionAdmission(client, policy);
    const [hold] = await db.select().from(admissionLegacyHolds).where(eq(admissionLegacyHolds.source, `lease:${lease.id}`));
    const now = Date.now();
    const decision: LegacyDecision = { kind: "present-day-legacy-reconciliation-v1", action: "reconcile", source: hold.source,
      sequence: 1, previousHash: null, holdHash: legacyHoldFingerprint(hold), companyId: company.id, agentId: agent.id,
      runId: run.id, leaseId: lease.id, environmentId: environment.id, scopes: hold.scopes, epoch: bootstrap.epoch,
      policyHash: hold.policyHash, observedAt: now - 100, expiresAt: now + 600000, routeRevocationHash: "1".repeat(64),
      retiredIncarnationHash: "2".repeat(64), wholePodStopHash: "3".repeat(64), restoration: { workspace: "4".repeat(64), session: "5".repeat(64), credential: "6".repeat(64) }, operatorApprovalHash: "7".repeat(64) };
    const service = legacyReconciliationService(db, { epoch: bootstrap.epoch, policyHash: hold.policyHash, proofKey: key, verifyEvidence: syntheticEvidence });
    return { company, agent, run, lease, hold, bootstrap, decision, service };
  }
  const envelope = (decision: LegacyDecision) => ({ decision, signature: createHmac("sha256", key).update(capacityFingerprint(decision)).digest("hex") });
  it("uses supported lifecycle processing without rewriting original receipt/run/lease/hold", async () => {
    const f = await seed();
    worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete",
      runHost: async agent => await agentExecutionsHaveStopped(db, [agent.id]) ? "complete" : "pending" });
    await createAgentLifecycle(db).pauseAgent(f.agent.id);
    await worker.process(f.agent.id);
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].lifecycleState).toBe("pausing");
    expect(await agentExecutionsHaveStopped(db, [f.agent.id])).toBe(false);
    await f.service.append(envelope(f.decision));
    expect(await agentExecutionsHaveStopped(db, [f.agent.id])).toBe(true);
    await expect.poll(async () => {
      await worker!.process(f.agent.id);
      return (await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].lifecycleState;
    }, { timeout: 15000, interval: 500 }).toBe("paused");
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].lifecycleHolds).toEqual(["manual"]);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
    expect((await db.select().from(admissionLegacyHolds).where(eq(admissionLegacyHolds.source, f.hold.source)))[0]).toEqual(f.hold);
  });
  it.each(["companyId", "agentId", "runId", "leaseId", "environmentId", "epoch", "holdHash", "policyHash", "scopes", "expiry", "partial"])("rejects mismatched or incomplete %s evidence", async field => {
    const f = await seed(); const d = structuredClone(f.decision);
    if (["companyId", "agentId", "runId", "leaseId", "environmentId", "epoch"].includes(field)) (d as any)[field] = randomUUID();
    if (["holdHash", "policyHash"].includes(field)) (d as any)[field] = "f".repeat(64);
    if (field === "scopes") d.scopes = ["fresh-bypass"];
    if (field === "expiry") d.expiresAt = Date.now() - 1;
    if (field === "partial") delete (d.restoration as any).credential;
    await expect(f.service.append(envelope(d))).rejects.toThrow();
    expect(await legacyHoldIsReconciled(db, f.hold, f.bootstrap.epoch)).toBe(false);
  });
  it("rejects forged signature, duplicate replay and stale decision CAS", async () => {
    const f = await seed();
    await expect(f.service.append({ decision: f.decision, signature: "f".repeat(64) })).rejects.toThrow("legacy_proof_unauthenticated");
    await f.service.append(envelope(f.decision));
    await expect(f.service.append(envelope(f.decision))).rejects.toThrow("legacy_decision_cas");
    expect(await db.select().from(admissionLegacyDecisions)).toHaveLength(1);
  });
  it("retains immutable decision/revocation history and restores the hold immediately", async () => {
    const f = await seed(); const one = await f.service.append(envelope(f.decision));
    expect(await legacyHoldIsReconciled(db, f.hold, f.bootstrap.epoch)).toBe(true);
    await f.service.append(envelope({ ...f.decision, sequence: 2, previousHash: one.decisionHash, action: "revoke" }));
    expect(await legacyHoldIsReconciled(db, f.hold, f.bootstrap.epoch)).toBe(false);
    expect(await db.select().from(admissionLegacyDecisions)).toHaveLength(2);
    await expect(db.update(admissionLegacyDecisions).set({ decisionHash: "a".repeat(64) })).rejects.toThrow();
    await expect(db.delete(admissionLegacyDecisions)).rejects.toThrow();
  });
  it("keeps accepted facts durable while rejecting stale epoch, undrain and expired new evidence", async () => {
    const f = await seed(); await f.service.append(envelope(f.decision));
    expect(await legacyHoldIsReconciled(db, f.hold, randomUUID())).toBe(false);
    expect(await legacyHoldIsReconciled(db, f.hold, f.bootstrap.epoch, f.decision.expiresAt + 7200000)).toBe(true);
    await db.update(admissionScheduler).set({ draining: false });
    await expect(f.service.append(envelope({ ...f.decision, sequence: 2, previousHash: capacityFingerprint(f.decision) }))).rejects.toThrow("legacy_requires_current_drain");
  });
  it("does not reconcile a sibling lease or shared hold with one exact decision", async () => {
    const f = await seed(true); await f.service.append(envelope(f.decision));
    expect(await legacyHoldIsReconciled(db, f.hold, f.bootstrap.epoch)).toBe(true);
    const holds = await db.select().from(admissionLegacyHolds);
    const sibling = holds.find(hold => hold.runId === f.run.id && hold.source !== f.hold.source)!;
    expect(sibling.scopes).toEqual(f.hold.scopes);
    expect(await legacyHoldIsReconciled(db, sibling, f.bootstrap.epoch)).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [f.agent.id])).toBe(false);
  });
  it("keeps synthetic shared Codex work blocked until every original hold has its own reviewed decision", async () => {
    const f = await seed(true);
    const holds = await db.select().from(admissionLegacyHolds);
    expect(holds).toHaveLength(2);
    const [b] = await db.insert(agents).values({ companyId: f.company.id, name: "synthetic B", adapterType: "codex_local" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: b.id, status: "queued" }).returning();
    await db.insert(admissionScopes).values(f.hold.scopes.map(key => ({ key, capacity: 1 })));
    const admission = executionAdmissionService(db, f.bootstrap.epoch);
    const attempt = await admission.registerRun({ companyId: f.company.id, runId: run.id, scopes: f.hold.scopes });
    await f.service.append(envelope(f.decision));
    await db.update(admissionScheduler).set({ draining: false, evaluationExemptionUntil: new Date(Date.now() + 60000) });
    const native: Parameters<typeof admission.claimNext>[0] = async (tx, value) => (await tx.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, value.id)).returning())[0];
    expect(await admission.claimNext(native)).toBeNull();
    expect((await db.select().from(admissionAttempts).where(eq(admissionAttempts.id, attempt.id)))[0].waitReason).toBe("legacy_occupancy_unreconciled");
    await db.update(admissionScheduler).set({ draining: true });
    const sibling = holds.find(h => h.source !== f.hold.source)!;
    await f.service.append(envelope({ ...f.decision, source: sibling.source, leaseId: sibling.source.slice(6), holdHash: legacyHoldFingerprint(sibling) }));
    await db.update(admissionScheduler).set({ draining: false });
    expect((await admission.claimNext(native))?.reservation.id).toBe(attempt.id);
    expect(await db.select().from(admissionLegacyHolds)).toEqual(holds);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
  });
  it("refuses signing-key-only installation and unbound independent review", async () => {
    const f = await seed();
    expect(() => legacyReconciliationService(db, { epoch: f.bootstrap.epoch,
      policyHash: f.hold.policyHash, proofKey: key } as any)).toThrow("legacy_independent_evidence_verifier_required");
    const service = legacyReconciliationService(db, { epoch: f.bootstrap.epoch,
      policyHash: f.hold.policyHash, proofKey: key, verifyEvidence: async () =>
        ({ decisionHash: capacityFingerprint(f.decision), inventoryHash: "0".repeat(64), expiresAt: Date.now() + 1000 }) });
    await expect(service.append(envelope(f.decision))).rejects.toThrow("legacy_independent_evidence_review_mismatch");
    expect(await db.select().from(admissionLegacyDecisions)).toHaveLength(0);
  });
  it("rechecks freshness after slow independent evidence verification", async () => {
    const f = await seed(); let current = f.decision.observedAt + 100;
    const service = legacyReconciliationService(db, { epoch: f.bootstrap.epoch,
      policyHash: f.hold.policyHash, proofKey: key, now: () => current,
      verifyEvidence: async input => { current = f.decision.expiresAt;
        return syntheticEvidence(input); } });
    await expect(service.append(envelope(f.decision))).rejects.toThrow("legacy_evidence_expired_during_review");
    expect(await db.select().from(admissionLegacyDecisions)).toHaveLength(0);
  });
  it("rejects independently expired review even while decision remains fresh", async () => {
    const f = await seed(); let current = f.decision.observedAt + 100;
    const evidenceExpiry = current + 1000;
    const service = legacyReconciliationService(db, { epoch: f.bootstrap.epoch,
      policyHash: f.hold.policyHash, proofKey: key, now: () => current,
      verifyEvidence: async input => { current = evidenceExpiry;
        return { decisionHash: capacityFingerprint(input.decision), inventoryHash: input.inventoryHash, expiresAt: evidenceExpiry }; } });
    expect(current).toBeLessThan(f.decision.expiresAt);
    await expect(service.append(envelope(f.decision))).rejects.toThrow("legacy_evidence_expired_during_review");
    expect(current).toBeLessThan(f.decision.expiresAt);
    expect(await db.select().from(admissionLegacyDecisions)).toHaveLength(0);
  });
  it.each([Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects unbounded independent review expiry %s", async expiresAt => {
    const f = await seed();
    const service = legacyReconciliationService(db, { epoch: f.bootstrap.epoch,
      policyHash: f.hold.policyHash, proofKey: key, verifyEvidence: async input =>
        ({ decisionHash: capacityFingerprint(input.decision), inventoryHash: input.inventoryHash, expiresAt }) });
    await expect(service.append(envelope(f.decision))).rejects.toThrow("legacy_evidence_expired_during_review");
    expect(await db.select().from(admissionLegacyDecisions)).toHaveLength(0);
  });
  it("supplies every authoritative shared hold and rolls back when evidence is unavailable", async () => {
    const f = await seed(true);
    let observed: string[] = [];
    const service = legacyReconciliationService(db, { epoch: f.bootstrap.epoch,
      policyHash: f.hold.policyHash, proofKey: key, verifyEvidence: async input => {
        observed = input.holds.map(hold => hold.source);
        expect(input.inventoryHash).toBe(capacityFingerprint(input.holds.map(hold =>
          ({ source: hold.source, holdHash: legacyHoldFingerprint(hold) })).sort((a, b) => a.source.localeCompare(b.source))));
        throw Error("independent_route_retirement_state_evidence_unavailable");
      } });
    await expect(service.append(envelope(f.decision))).rejects.toThrow("independent_route_retirement_state_evidence_unavailable");
    expect(observed.sort()).toEqual((await db.select().from(admissionLegacyHolds)).map(hold => hold.source).sort());
    expect(observed).toHaveLength(2);
    expect(await db.select().from(admissionLegacyDecisions)).toHaveLength(0);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
  });
  it("restores a Paperclip-only synthetic database/files/config clone, rehearses manual migration and held restart rollback", async () => {
    const f = await seed();
    const { mkdtemp, writeFile, readFile, cp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, dirname, resolve } = await import("node:path");
    const { createRequire } = await import("node:module");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
    const binaryRoot = resolve(dirname(dirname(require.resolve("embedded-postgres"))), "../@embedded-postgres/linux-x64/native/bin");
    const root = await mkdtemp(join(tmpdir(), "paperclip-restored-clone-"));
    const cloneName = `pc_clone_${randomUUID().replaceAll("-", "")}`;
    const cloneUrl = new URL(temporary.connectionString); cloneUrl.pathname = `/${cloneName}`;
    let clone: ReturnType<typeof createDb> | undefined;
    try {
      await writeFile(join(root, "workspace.bin"), Buffer.from([0, 1, 255, 37]));
      await writeFile(join(root, "session.json"), '{"synthetic":"session"}');
      await writeFile(join(root, "credential.json"), '{"synthetic":"no-provider-secret"}');
      await writeFile(join(root, "policy.json"), '{"mode":"held","timers":false,"dispatch":false}');
      await exec(process.env.PAPERCLIP_CLONE_PG_DUMP ?? join(binaryRoot, "pg_dump"), ["--format=custom", "--no-owner", "--file", join(root, "paperclip.dump"), temporary.connectionString]);
      await cp(root, `${root}-recovery`, { recursive: true });
      await db.execute(sql.raw(`CREATE DATABASE "${cloneName}"`));
      await exec(process.env.PAPERCLIP_CLONE_PG_RESTORE ?? join(binaryRoot, "pg_restore"), ["--no-owner", "--dbname", cloneUrl.href, join(root, "paperclip.dump")]);
      clone = createDb(cloneUrl.href);
      await exec(process.env.PAPERCLIP_CLONE_PG_DUMP ?? join(binaryRoot, "pg_dump"), ["--format=custom", "--no-owner", "--file", join(root, "pre-upgrade-clone.dump"), cloneUrl.href]);
      expect((await clone.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
      expect((await clone.select().from(admissionLegacyHolds).where(eq(admissionLegacyHolds.source, f.hold.source)))[0]).toEqual(f.hold);
      const migration = await readFile(new URL("../../../packages/db/src/migrations/0345_legacy_present_day_decisions.sql", import.meta.url), "utf8");
      const statements = migration.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
      // Actual generated migration SQL on the restored clone, never the source.
      await clone.execute(sql`drop table execution_admission_legacy_decisions`);
      await clone.execute(sql`drop function execution_admission_legacy_decisions_immutable()`);
      await expect(clone.transaction(async tx => {
        for (const statement of statements) await tx.execute(sql.raw(statement));
        throw Error("injected restored-clone migration interruption");
      })).rejects.toThrow("injected restored-clone migration interruption");
      expect((await clone.execute(sql`select to_regclass('public.execution_admission_legacy_decisions') as name`))[0].name).toBeNull();
      await clone.transaction(async tx => { for (const statement of statements) await tx.execute(sql.raw(statement)); });
      const policy = { version: 1, mode: "held", instance: "fixture", pendingLimit: 4, legacyOwners: [{ companyId: f.company.id,
        agentId: f.agent.id, environmentId: f.lease.environmentId, runner: "original-codex", providerAccount: "original-account", workspace: "original-workspace", session: "original-session", credential: "original-credential" }] };
      const restarted = await bootstrapHeldExecutionAdmission(clone, policy);
      expect(restarted.mode).toBe("held");
      await expect(restarted.admission.assertRunReady(f.company.id, f.run.id)).rejects.toThrow("capacity_bootstrap_held");
      expect((await clone.select().from(admissionLegacyHolds).where(eq(admissionLegacyHolds.source, f.hold.source)))[0]).toEqual(f.hold);
      expect(await clone.select().from(admissionLegacyDecisions)).toHaveLength(0);
      // Diverge the upgraded clone through the supported present-day path, then
      // destroy it. Rollback must restore the entire coordinated DB checkpoint;
      // an old application image must never reuse the upgraded database in place.
      const cloneService = legacyReconciliationService(clone, { epoch: restarted.epoch,
        policyHash: f.hold.policyHash, proofKey: key, verifyEvidence: syntheticEvidence });
      await cloneService.append(envelope({ ...f.decision, epoch: restarted.epoch }));
      expect(await clone.select().from(admissionLegacyDecisions)).toHaveLength(1);
      await clone.$client.end(); clone = undefined;
      await db.execute(sql.raw(`DROP DATABASE "${cloneName}" WITH (FORCE)`));
      await db.execute(sql.raw(`CREATE DATABASE "${cloneName}"`));
      await exec(process.env.PAPERCLIP_CLONE_PG_RESTORE ?? join(binaryRoot, "pg_restore"), ["--no-owner", "--dbname", cloneUrl.href, join(root, "pre-upgrade-clone.dump")]);
      clone = createDb(cloneUrl.href);
      expect(await clone.select().from(admissionLegacyDecisions)).toHaveLength(0);
      expect((await clone.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
      expect((await clone.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
      expect((await clone.select().from(admissionLegacyHolds).where(eq(admissionLegacyHolds.source, f.hold.source)))[0]).toEqual(f.hold);
      const rollbackRestart = await bootstrapHeldExecutionAdmission(clone, policy);
      expect(rollbackRestart.epoch).not.toBe(restarted.epoch);
      expect(rollbackRestart.mode).toBe("held");
      await expect(rollbackRestart.admission.assertRunReady(f.company.id, f.run.id)).rejects.toThrow("capacity_bootstrap_held");
      expect(await agentExecutionsHaveStopped(clone, [f.agent.id])).toBe(false);
      // Recover source state/config from the coordinated immutable checkpoint.
      await writeFile(join(root, "credential.json"), "new synthetic divergent token");
      await cp(`${root}-recovery/credential.json`, join(root, "credential.json"));
      for (const file of ["workspace.bin", "session.json", "credential.json", "policy.json"])
        expect(await readFile(join(root, file))).toEqual(await readFile(join(`${root}-recovery`, file)));
      expect((await db.select().from(admissionScheduler))[0].epoch).toBe(f.bootstrap.epoch);
    } finally {
      await clone?.$client.end();
      await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`));
      await rm(root, { recursive: true, force: true }); await rm(`${root}-recovery`, { recursive: true, force: true });
    }
  }, 120000);

});
