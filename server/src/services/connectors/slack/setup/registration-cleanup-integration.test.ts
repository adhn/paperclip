import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, chatEndpoints, chatSlackRegistrations, companySecrets, companySecretVersions, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../../__tests__/helpers/embedded-postgres.js";
import * as secretModule from "../../../secrets.js";
import { chatCredentialMutationLease } from "../../../chat-credential-mutation-lease.js";
import { createSlackCompletion } from "./completion.js";
import { registrationCleanupRecovery, registrationCleanupRecoveryPath } from "./registration-cleanup-recovery.js";
import { slackInstallRecoveryPath } from "./install-recovery.js";
import type { SlackRegistrationStore } from "./registration.js";
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("actual configured registration staged cleanup", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined, root: string;
  const previousHome = process.env.PAPERCLIP_HOME, previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "registration-cleanup-sql-")); process.env.PAPERCLIP_HOME = root; process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key");
    if (externalUrl) db = createDb(externalUrl); else { database = await startEmbeddedPostgresTestDatabase("registration-cleanup-sql-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(failure: "none" | "first" | "second" | "remove-reply" = "none") {
    const companyId = randomUUID(), actor = { userId: `cleanup-${randomUUID()}`, sessionId: "fixture", bypassPermissionCheck: true };
    await db.insert(companies).values({ id: companyId, name: "Staged cleanup", issuePrefix: `S${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Cleanup fixture", adapterType: "claude_local" }).returning();
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Cleanup fixture", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app.id, name: "Cleanup fixture", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, assignedAgentId: agent.id, provider: "slack", publicId: randomUUID(), status: "active", setup: {} }).returning();
    const originalFactory = secretModule.secretService, vault = originalFactory(db);
    const ids: Record<string, string> = {};
    for (const key of ["botToken", "signingSecret", "clientSecret"]) ids[key] = (await vault.create(companyId, { name: `${key}-${randomUUID()}`, key: `cleanup.${randomUUID()}`, provider: "local_encrypted", value: `original-${key}` }, { userId: actor.userId })).id;
    const [row] = await db.insert(chatSlackRegistrations).values({ endpointId: endpoint.id, companyId, requestId: randomUUID(), status: "configured", manifest: {}, manifestHash: "fixture", callbackUri: "https://fixture.invalid/callback", appId: "AFIXTURE", clientId: "123.456", secretIds: ids, createdByUserId: actor.userId }).returning();
    let calls = 0;
    const remove = vi.fn(async (id: string) => {
      calls += 1;
      if (failure === "first" && calls === 1 || failure === "second" && calls === 2) throw new Error("original staged removal failure");
      const result = await vault.remove(id);
      if (failure === "remove-reply" && calls === 1) throw new Error("lost completed staged removal reply");
      return result;
    });
    vi.spyOn(secretModule, "secretService").mockImplementation(((database: Parameters<typeof secretModule.secretService>[0]) => {
      const actual = originalFactory(database);
      return { ...actual, remove: database === db ? remove : actual.remove };
    }) as typeof secretModule.secretService);
    const api = vi.fn(), withLease = chatCredentialMutationLease(db);
    const store = { db, endpoint: async () => { const [saved] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)); return { endpoint: saved, connection, agentName: agent.name }; },
      registration: async () => (await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpoint.id)))[0],
      options: { withLock: async (_id: string, action: Parameters<typeof withLease>[1]) => withLease(endpoint, action) }, api } as unknown as SlackRegistrationStore;
    const completion = createSlackCompletion(store), recovery = registrationCleanupRecovery(companyId, endpoint.id);
    const resume = () => withLease(endpoint, lease => completion.resumeLocked(endpoint.id, actor, lease));
    return { companyId, actor, endpoint, row, ids, remove, api, recovery, resume };
  }
  it("publishes prospective intent before any actual removal", async () => {
    const f = await fixture(), rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to) === registrationCleanupRecoveryPath(f.companyId, f.endpoint.id)) throw new Error("prospective publication failed"); return rename(from, to); });
    await expect(f.resume()).rejects.toThrow("prospective publication failed"); expect(f.remove).not.toHaveBeenCalled();
    const [saved] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id)); expect(saved.secretIds).toEqual(f.ids);
    expect((await fs.readdir(path.dirname(registrationCleanupRecoveryPath(f.companyId, f.endpoint.id)))).some(name => name.endsWith(".tmp"))).toBe(true);
  });
  it("removes actual staged secrets, preserves client credential, acknowledges refs, then clears", async () => {
    const f = await fixture(); await f.resume();
    expect(f.remove.mock.calls.map(([id]) => id)).toEqual([f.ids.botToken, f.ids.signingSecret]);
    const [saved] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id)); expect(saved.secretIds).toEqual({ clientSecret: f.ids.clientSecret });
    for (const id of [f.ids.botToken, f.ids.signingSecret]) {
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, id))).toEqual([]);
      expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, id))).toEqual([]);
    }
    const [client] = await db.select().from(companySecrets).where(eq(companySecrets.id, f.ids.clientSecret)); expect(client.status).toBe("active");
    expect(await f.recovery.read()).toBeNull(); expect(f.api).not.toHaveBeenCalled();
  });
  for (const failure of ["first", "second", "remove-reply"] as const) {
    it(`retains exact partial facts after ${failure} removal uncertainty and refuses resume`, async () => {
      const f = await fixture(failure); await expect(f.resume()).rejects.toThrow();
      const retained = await f.recovery.read(); expect(retained?.acknowledgedRemovalIds).toEqual(failure === "second" ? [f.ids.botToken] : []);
      if (failure === "second" || failure === "remove-reply") expect(await db.select().from(companySecrets).where(eq(companySecrets.id, f.ids.botToken))).toEqual([]);
      const [saved] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id)); expect(saved.secretIds).toEqual(f.ids);
      const calls = f.remove.mock.calls.length;
      await expect(f.resume()).rejects.toThrow(); expect(f.remove).toHaveBeenCalledTimes(calls);
      expect(await f.recovery.read()).toEqual(retained); expect(f.api).not.toHaveBeenCalled();
    });
  }
  it("holds every removal acknowledgment on lost registration SQL commit reply", async () => {
    const f = await fixture(), transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => (async () => { await transaction(action); throw new Error("lost registration COMMIT reply"); })()) as typeof db.transaction);
    await expect(f.resume()).rejects.toThrow("lost registration COMMIT reply");
    expect((await f.recovery.read())?.acknowledgedRemovalIds).toEqual([f.ids.botToken, f.ids.signingSecret]);
    const [saved] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id)); expect(saved.secretIds).toEqual({ clientSecret: f.ids.clientSecret });
    const calls = f.remove.mock.calls.length; await expect(f.resume()).rejects.toThrow(); expect(f.remove).toHaveBeenCalledTimes(calls);
  });
  for (const change of ["missing", "version"] as const) {
    it(`refuses a ${change} second target before removal without a fabricated acknowledgment`, async () => {
      const f = await fixture(), rename = fs.rename.bind(fs); let changed = false;
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (!changed && String(to) === registrationCleanupRecoveryPath(f.companyId, f.endpoint.id)) {
          changed = true;
          if (change === "missing") await db.delete(companySecrets).where(eq(companySecrets.id, f.ids.signingSecret));
          else {
            const [original] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, f.ids.signingSecret));
            await db.insert(companySecretVersions).values({ ...original, id: randomUUID(), version: 2 });
            await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, f.ids.signingSecret));
          }
        }
      });
      await expect(f.resume()).rejects.toThrow(); expect(f.remove).toHaveBeenCalledExactlyOnceWith(f.ids.botToken);
      const retained = await f.recovery.read(); expect(retained?.acknowledgedRemovalIds).toEqual([f.ids.botToken]);
      expect(retained?.intent.targets[f.ids.signingSecret].identity.version).toBe(1);
      await expect(f.resume()).rejects.toThrow(); expect(f.remove).toHaveBeenCalledOnce();
    });
  }
  it("refuses foreign customer-install occupancy before prospective cleanup publication", async () => {
    const f = await fixture(), file = slackInstallRecoveryPath(f.companyId, f.endpoint.id);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "unknown retained foreign family");
    await expect(f.resume()).rejects.toThrow(); expect(f.remove).not.toHaveBeenCalled();
    expect(await f.recovery.read()).toBeNull();
    const [saved] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id)); expect(saved.secretIds).toEqual(f.ids);
  });
  for (const mutation of ["endpoint-control", "registration-between-removals"] as const) it(`holds exact cleanup after ${mutation} changes`, async () => {
    const f = await fixture(), rename = fs.rename.bind(fs); let publications = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to) !== registrationCleanupRecoveryPath(f.companyId, f.endpoint.id)) return;
      publications += 1;
      if (mutation === "endpoint-control" && publications === 1)
        await db.update(chatEndpoints).set({ allowDirectMessages: !f.endpoint.allowDirectMessages }).where(eq(chatEndpoints.id, f.endpoint.id));
      if (mutation === "registration-between-removals" && publications === 2)
        await db.update(chatSlackRegistrations).set({ requestId: randomUUID() }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
    });
    await expect(f.resume()).rejects.toThrow();
    expect(f.remove.mock.calls.map(([id]) => id)).toEqual(mutation === "endpoint-control" ? [] : [f.ids.botToken]);
    const held = await f.recovery.read();
    expect(held?.acknowledgedRemovalIds).toEqual(mutation === "endpoint-control" ? [] : [f.ids.botToken]);
    expect(held?.intent.originalRegistration.requestId).toBe(f.row.requestId);
    const [signing] = await db.select().from(companySecrets).where(eq(companySecrets.id, f.ids.signingSecret)); expect(signing.status).toBe("active");
    const calls = f.remove.mock.calls.length; await expect(f.resume()).rejects.toThrow(); expect(f.remove).toHaveBeenCalledTimes(calls);
    expect(await f.recovery.read()).toEqual(held);
  });

});
