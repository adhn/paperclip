import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, toolApplications, toolConnections, chatEndpoints } from "@paperclipai/db";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { secretService } from "../secrets.js";
import { chatChannelService } from "../chat-channels.js";
import type { ChatSdkRuntime } from "../chat-sdk-runtime.js";
import { setupMessageRecoveryPath } from "../connectors/slack/setup/setup-message-recovery.js";
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Fixture did not reach ${label}`)), 5_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
(support.supported ? describe : describe.skip)("actual Slack service runtime credential admission", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined, root: string;
  const services: ReturnType<typeof chatChannelService>[] = [];
  const oldHome = process.env.PAPERCLIP_HOME, oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "slack-runtime-authority-")); process.env.PAPERCLIP_HOME = root; process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key");
    if (externalUrl) db = createDb(externalUrl); else { database = await startEmbeddedPostgresTestDatabase("slack-runtime-authority-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => {
    await Promise.all(services.map(service => service.shutdown())); await database?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (oldKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = oldKey;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Slack runtime authority", issuePrefix: `R${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Runtime fixture", adapterType: "claude_local" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Runtime fixture", type: "chat" }).returning();
    const vault = secretService(db), token = "original-runtime-token";
    const secret = await vault.create(companyId, { name: randomUUID(), key: `runtime.${randomUUID()}`, provider: "local_encrypted", value: token });
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Runtime fixture", uid: randomUUID(), connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true, credentialSecretRefs: [{ configPath: "credentials.botToken", secretId: secret.id, versionSelector: "latest" }] }).returning();
    await vault.createBinding({ companyId, secretId: secret.id, targetType: "tool_connection", targetId: connection.id,
      configPath: "credentials.botToken", versionSelector: "latest", required: true });
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, assignedAgentId: agent.id, provider: "slack", status: "active", publicId: randomUUID(), setup: {} }).returning();
    const external = new AsyncResource("external-admitted-runtime-callback");
    let onReplace: (() => Promise<void>) | undefined, onRemove: (() => Promise<void>) | undefined, onInitialize: (() => Promise<void>) | undefined, onGet: (() => void) | undefined;
    const instances: { initialize: ReturnType<typeof vi.fn>; handleWebhook: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn>; acceptsProviderScope: () => boolean }[] = [];
    const entries = new Map<string, typeof instances[number]>();
    const runtime = {
      get: (id: string) => { onGet?.(); return entries.get(id) ?? null; },
      replaceEndpoint: vi.fn(async (options: { endpointId: string }) => {
        await onReplace?.();
        const instance = { initialize: vi.fn(async () => { await onInitialize?.(); }), handleWebhook: vi.fn(async () => new Response("fixture SDK boundary", { status: 418 })), shutdown: vi.fn(async () => undefined), acceptsProviderScope: () => false };
        instances.push(instance); entries.set(options.endpointId, instance); return instance;
      }),
      removeEndpoint: vi.fn(async (id: string) => { await onRemove?.(); const instance = entries.get(id); entries.delete(id); await instance?.shutdown(); return Boolean(instance); }),
      isInsideEndpointCallback: () => false, fenceEndpointAdmission: vi.fn(),
      shutdown: async () => { await Promise.all([...entries.values()].map(instance => instance.shutdown())); entries.clear(); },
    };
    const service = chatChannelService(db, { runtime: runtime as unknown as ChatSdkRuntime, heartbeat: { cancelRun: vi.fn(), wakeup: vi.fn() }, publicBaseUrl: "https://fixture.invalid", fetch: vi.fn(async () => { throw new Error("unexpected external fetch"); }) as typeof fetch });
    services.push(service);
    const request = () => service.handleWebhook(endpoint.publicId, "slack", new Request("https://fixture.invalid/webhook", { method: "POST", headers: { "content-type": "text/plain" }, body: "fixture" }));
    const rotate = () => external.runInAsyncScope(() => vault.rotate(secret.id, { value: token }));
    return { companyId, endpoint, connection, secret, service, runtime, instances, request, rotate, external,
      replace: (hook: () => Promise<void>) => { onReplace = hook; }, remove: (hook: () => Promise<void>) => { onRemove = hook; }, initialize: (hook: () => Promise<void>) => { onInitialize = hook; }, observeGet: (hook: () => void) => { onGet = hook; } };
  }
  it("joins replacement callbacks outside the original company credential lock", async () => {
    const f = await fixture(); let acquired = false;
    f.replace(() => bounded(f.external.runInAsyncScope(() => withAccountHomeSecretMutationLock(undefined, f.companyId, async () => { acquired = true; })), "unlocked replacement callback"));
    expect((await f.request()).status).toBe(418); expect(acquired).toBe(true); expect(f.instances[0].initialize).toHaveBeenCalledOnce();
  });
  for (const change of ["hold", "same-value-version", "connection-disabled"] as const) it(`refuses initialization after ${change} changes during replacement and joins cleanup unlocked`, async () => {
    const f = await fixture(); let cleanupAcquired = false;
    f.replace(async () => {
      if (change === "same-value-version") await f.rotate();
      else if (change === "connection-disabled") await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connection.id));
      else { const file = setupMessageRecoveryPath(f.companyId, f.endpoint.id, "welcome"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "unknown retained original"); }
    });
    f.remove(() => bounded(f.external.runInAsyncScope(() => withAccountHomeSecretMutationLock(undefined, f.companyId, async () => { cleanupAcquired = true; })), "unlocked cleanup callback"));
    await expect(f.request()).rejects.toThrow(); expect(f.instances).toHaveLength(1);
    expect(f.instances[0].initialize).not.toHaveBeenCalled(); expect(f.instances[0].handleWebhook).not.toHaveBeenCalled();
    expect(f.runtime.removeEndpoint).toHaveBeenCalledOnce(); expect(cleanupAcquired).toBe(true);
  });
  it("invalidates a cached instance after same-ref same-value secret rotation before any old-instance reuse", async () => {
    const f = await fixture(); await f.request(); await f.rotate();
    await expect(f.request()).rejects.toThrow("credential authority changed");
    expect(f.instances[0].handleWebhook).toHaveBeenCalledOnce(); expect(f.instances[0].shutdown).toHaveBeenCalledOnce();
    expect((await f.request()).status).toBe(418); expect(f.instances).toHaveLength(2); expect(f.instances[1].initialize).toHaveBeenCalledOnce();
  });
  for (const change of ["connection-config", "assigned-agent"] as const) it(`refuses cached old runtime after actual ${change} authority changes`, async () => {
    const f = await fixture(); await f.request();
    if (change === "connection-config") await db.update(toolConnections).set({ config: { changedLocalRoute: true } }).where(eq(toolConnections.id, f.connection.id));
    else {
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Changed runtime authority", adapterType: "claude_local" }).returning();
      await db.update(chatEndpoints).set({ assignedAgentId: agent.id }).where(eq(chatEndpoints.id, f.endpoint.id));
    }
    await expect(f.request()).rejects.toThrow();
    expect(f.instances[0].handleWebhook).toHaveBeenCalledOnce(); expect(f.instances[0].shutdown).toHaveBeenCalledOnce();
    expect((await f.request()).status).toBe(418); expect(f.instances).toHaveLength(2);
  });
  it("refuses stale initial controls changed by an actual predecessor retirement join before construction", async () => {
    const f = await fixture(); await f.runtime.replaceEndpoint({ endpointId: f.endpoint.id });
    f.remove(() => f.external.runInAsyncScope(() => withAccountHomeSecretMutationLock(undefined, f.companyId, async () => {
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Retirement changed assignment", adapterType: "claude_local" }).returning();
      await db.update(chatEndpoints).set({ assignedAgentId: agent.id }).where(eq(chatEndpoints.id, f.endpoint.id));
    })));
    await expect(f.request()).rejects.toThrow();
    expect(f.runtime.removeEndpoint).toHaveBeenCalledOnce(); expect(f.instances[0].shutdown).toHaveBeenCalledOnce();
    expect(f.runtime.replaceEndpoint).toHaveBeenCalledOnce(); expect(f.instances).toHaveLength(1);
    expect(f.instances[0].initialize).not.toHaveBeenCalled(); expect(f.instances[0].handleWebhook).not.toHaveBeenCalled();
  });
  it("refuses initiating caller before old-instance use when rotation queued during initialize precedes final admission", async () => {
    const f = await fixture(); let rotation: Promise<unknown> | undefined;
    f.initialize(async () => { rotation = f.rotate(); });
    await expect(f.request()).rejects.toThrow(); await rotation;
    expect(f.instances).toHaveLength(1); expect(f.instances[0].initialize).toHaveBeenCalledOnce();
    expect(f.instances[0].handleWebhook).not.toHaveBeenCalled(); expect(f.instances[0].shutdown).toHaveBeenCalledOnce();
  });
  it("rechecks a completed pending initialization through current cached credential authority", async () => {
    const f = await fixture(), initialized = deferred(), pendingObserved = deferred(); let inInitialize = false, rotation: Promise<unknown> | undefined;
    f.observeGet(() => { if (inInitialize) pendingObserved.resolve(); });
    f.initialize(async () => { inInitialize = true; initialized.resolve(); await bounded(pendingObserved.promise, "second caller pending initialization"); rotation = f.rotate(); });
    const first = f.request(); const firstOutcome = first.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason })); await bounded(initialized.promise, "first initialization");
    const second = f.request();
    const outcomes = await Promise.allSettled([firstOutcome, second]); await rotation;
    expect(outcomes[0].status).toBe("fulfilled");
    if (outcomes[0].status === "fulfilled") expect(outcomes[0].value.status).toBe("rejected");
    expect(outcomes[1].status).toBe("rejected"); expect(f.instances).toHaveLength(1);
    expect(f.instances[0].initialize).toHaveBeenCalledOnce(); expect(f.instances[0].handleWebhook).not.toHaveBeenCalled();
    expect(f.instances[0].shutdown).toHaveBeenCalledOnce();
  });
});
