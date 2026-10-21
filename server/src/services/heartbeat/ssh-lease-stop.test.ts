import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recordSshLeaseProcessStopped, sshLeaseStopReleaseMetadata } from "./ssh-lease-stop.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { agentExecutionsHaveStopped } from "../agent-execution-stop.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../agent-lifecycle.js";
import { createLifecycleDriver } from "../agent-lifecycle-driver.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("exact SSH lease termination", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("ssh-lease-stop-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  async function seed() {
    const [company] = await db.insert(companies).values({ name: "SSH termination", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh" }).returning();
    const siblings = [];
    for (const name of ["A", "B"]) {
      const [agent] = await db.insert(agents).values({ companyId: company.id, name, adapterType: "codex_local", status: "idle", lifecycleState: "ready" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", runtimeMode: "legacy" }).returning();
      const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, heartbeatRunId: run.id, environmentId: environment.id,
        status: "active", provider: "ssh", providerLeaseId: "ssh://node@shared:2222/work", leasePolicy: "ephemeral",
        metadata: { agentId: agent.id, preserved: name, driver: "ssh" } }).returning();
      const input = { companyId: company.id, runId: run.id, agentId: agent.id, leaseId: lease.id,
        environmentId: environment.id, providerLeaseId: lease.providerLeaseId, invocationId: randomUUID() };
      siblings.push({ agent, run, lease, input });
    }
    return siblings;
  }
  const read = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0];
  it("releases only the verified cancelled run and satisfies the lifecycle stop gate", async () => {
    const [a, b] = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, a.run.id));
    expect(await agentExecutionsHaveStopped(db, [a.agent.id])).toBe(false);
    await recordSshLeaseProcessStopped(db, a.input);
    expect(hasRemoteTerminationReceipt(await read(a.lease.id))).toBe(false); // release is a separate obligation
    await environmentRuntimeService(db).releaseRunLeases(a.run.id, "expired");
    const stopped = await read(a.lease.id);
    expect(stopped).toMatchObject({ cleanupStatus: "success", status: "expired", metadata: { preserved: "A", remoteExecutionTermination: {
      runId: a.run.id, leaseId: a.lease.id, sshInvocationId: a.input.invocationId, state: "stopped",
    } } });
    expect(hasRemoteTerminationReceipt(stopped)).toBe(true);
    expect(await agentExecutionsHaveStopped(db, [a.agent.id])).toBe(true);
    const commands = createAgentLifecycle(db);
    const driver = createLifecycleDriver(db, {} as never);
    const worker = configureAgentLifecycle(db, { ...driver,
      // Harness verification is an external provider boundary in this DB test.
      runHost: async agent => agent.lifecycleState === "verifying" ? "complete" : driver.runHost(agent),
    });
    try {
      await commands.pauseAgent(a.agent.id);
      await worker.process(a.agent.id);
      const current = async () => (await db.select().from(agents).where(eq(agents.id, a.agent.id)))[0];
      expect(await current()).toMatchObject({ lifecycleState: "paused" });
      await commands.resumeAgent(a.agent.id);
      await worker.process(a.agent.id);
      expect(await current()).toMatchObject({ lifecycleState: "ready", status: "idle" });
    } finally { await worker.stop(); }
    expect(await read(b.lease.id)).toMatchObject({ status: "active", cleanupStatus: null, releasedAt: null, metadata: { preserved: "B" } });
    expect((await read(b.lease.id)).metadata?.remoteExecutionTermination).toBeUndefined();
    expect(await agentExecutionsHaveStopped(db, [b.agent.id])).toBe(false);
  });
  it.each(["companyId", "runId", "agentId", "leaseId", "environmentId", "providerLeaseId", "invocationId"] as const)("rejects mismatched %s without granting stop authority", async field => {
    const [a, b] = await seed();
    await expect(recordSshLeaseProcessStopped(db, { ...a.input, [field]: field === "invocationId" ? "invalid" : field === "providerLeaseId" ? "ssh://wrong" : b.input[field] === a.input[field] ? randomUUID() : b.input[field] })).rejects.toThrow();
    expect((await read(a.lease.id)).metadata?.remoteExecutionTermination).toBeUndefined();
    expect((await read(b.lease.id)).metadata?.remoteExecutionTermination).toBeUndefined();
  });
  it("does not backfill historical leases or accept an expired shared target as proof", async () => {
    const [a] = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, a.run.id));
    await environmentRuntimeService(db).releaseRunLeases(a.run.id, "expired");
    expect(await read(a.lease.id)).toMatchObject({ status: "expired", cleanupStatus: "failed" });
    expect(await agentExecutionsHaveStopped(db, [a.agent.id])).toBe(false);
    await expect(recordSshLeaseProcessStopped(db, a.input)).rejects.toThrow();
  });
  it("rejects a receipt copied from a sibling sharing the exact target URI", async () => {
    const [a, b] = await seed();
    await recordSshLeaseProcessStopped(db, a.input);
    const stopped = await read(a.lease.id);
    expect(sshLeaseStopReleaseMetadata({ ...b.lease, metadata: stopped.metadata })).toEqual({ cleanupStatus: "failed" });
  });
});
