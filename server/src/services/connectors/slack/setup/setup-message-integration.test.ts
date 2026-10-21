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
import { setupMessageRecovery, setupMessageRecoveryPath } from "./setup-message-recovery.js";
import { createSlackSetupClient } from "./provider-client.js";
import { readSecretRecoveryIdentity } from "../../../secret-recovery-identity.js";
import type { SlackRegistrationStore } from "./registration.js";
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("actual setup message original custody", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined, root: string;
  const previousHome = process.env.PAPERCLIP_HOME, previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "setup-message-sql-")); process.env.PAPERCLIP_HOME = root; process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key");
    if (externalUrl) db = createDb(externalUrl); else { database = await startEmbeddedPostgresTestDatabase("setup-message-sql-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(kind: "welcome" | "verification" = "welcome", response = JSON.stringify({ ok: true, channel: "DFIXTURE", ts: "123.456" })) {
    const companyId = randomUUID(), actor = { userId: `message-${randomUUID()}`, sessionId: "fixture", bypassPermissionCheck: true };
    await db.insert(companies).values({ id: companyId, name: "Message fixture", issuePrefix: `M${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Message fixture", adapterType: "claude_local" }).returning();
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Message fixture", type: "chat" }).returning();
    const vault = secretModule.secretService(db);
    const secret = await vault.create(companyId, { name: randomUUID(), key: `runtime.${randomUUID()}`, provider: "local_encrypted", value: "original-runtime-token" }, { userId: actor.userId });
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app.id, name: "Message fixture", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel", credentialSecretRefs: [{ configPath: "credentials.botToken", secretId: secret.id, versionSelector: "latest" }] }).returning();
    const account = { status: "linked", externalUserId: "UFIXTURE", paperclipUserId: actor.userId, welcomeStatus: kind === "welcome" ? "pending" : "sent", verificationStatus: "pending", ...(kind === "verification" ? { dmChannelId: "DFIXTURE" } : {}) };
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, assignedAgentId: agent.id, provider: "slack", publicId: randomUUID(), status: "active", setup: { slackAccount: account, ...(kind === "verification" ? { webhookVerifiedAt: new Date().toISOString() } : {}) } as never }).returning();
    await db.insert(chatSlackRegistrations).values({ endpointId: endpoint.id, companyId, requestId: randomUUID(), status: "configured", manifest: {}, manifestHash: "fixture", callbackUri: "https://fixture.invalid/callback", appId: "AFIXTURE", clientId: "123.456", secretIds: {}, createdByUserId: actor.userId });
    const recovery = setupMessageRecovery(companyId, endpoint.id, kind);
    const fetch = vi.fn(async () => {
      const entry = await recovery.read(); expect(entry?.kind).toBe("setup-message-intent");
      const [saved] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
      expect(saved.setup.slackAccount?.[kind === "welcome" ? "welcomeStatus" : "verificationStatus"]).toBe("sending");
      return new Response(response, { status: 200, headers: { "content-type": "application/json" } });
    });
    const api = createSlackSetupClient(fetch as typeof globalThis.fetch), withLease = chatCredentialMutationLease(db);
    const canWelcome = vi.fn(async () => true);
    const runtimeBotCredential = vi.fn(async () => ({ value: "original-runtime-token", identity: await readSecretRecoveryIdentity(db, companyId, secret.id) }));
    const store = { db, endpoint: async () => ({ endpoint: (await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0], connection, agentName: agent.name }),
      registration: async () => (await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpoint.id)))[0],
      options: { withLock: async (_id: string, action: Parameters<typeof withLease>[1]) => withLease(endpoint, action), canWelcome, runtimeBotCredential }, api, audit: vi.fn(async () => undefined) } as unknown as SlackRegistrationStore;
    const completion = createSlackCompletion(store);
    const run = () => kind === "verification" ? completion.notifyVerified(endpoint.id) : withLease(endpoint, lease => completion.resumeLocked(endpoint.id, actor, lease));
    const savedAccount = async () => (await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)))[0].setup.slackAccount;
    return { companyId, actor, endpoint, secret, fetch, recovery, run, savedAccount, canWelcome, runtimeBotCredential };
  }
  for (const kind of ["welcome", "verification"] as const) it(`retains actual ${kind} raw/result and independently acknowledged SQL settlement`, async () => {
    const f = await fixture(kind); await f.run();
    expect(f.fetch).toHaveBeenCalledOnce(); const entry = await f.recovery.read();
    expect(entry?.kind).toBe("setup-message-settled");
    if (entry?.kind !== "setup-message-settled") throw new Error("missing settled receipt");
    expect(JSON.parse(Buffer.from(entry.raw.bodyBase64, "base64").toString())).toEqual({ ok: true, channel: "DFIXTURE", ts: "123.456" });
    expect(entry.decoded).toEqual({ channel: "DFIXTURE", ts: "123.456" });
    expect((await f.savedAccount())?.[kind === "welcome" ? "welcomeStatus" : "verificationStatus"]).toBe("sent");
    await f.run(); expect(f.fetch).toHaveBeenCalledOnce(); expect(await f.recovery.read()).toEqual(entry);
  });
  it("does not send when prospective durable publication fails", async () => {
    const f = await fixture(), rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to) === setupMessageRecoveryPath(f.companyId, f.endpoint.id, "welcome")) throw new Error("intent publication failed"); return rename(from, to); });
    await expect(f.run()).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled(); expect((await f.savedAccount())?.welcomeStatus).toBe("pending");
  });
  it("rechecks current welcome permission after prospective publication", async () => {
    const f = await fixture(); f.canWelcome.mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled(); expect((await f.recovery.read())?.kind).toBe("setup-message-intent");
  });
  for (const failure of ["transport", "malformed", "invalid-ts"] as const) it(`holds ${failure} uncertainty without replay or successful status`, async () => {
    const f = await fixture("welcome", failure === "malformed" ? "invalid JSON" : JSON.stringify({ ok: true, channel: "DFIXTURE", ts: "invalid" }));
    if (failure === "transport") f.fetch.mockRejectedValue(new Error("transport completion unknown"));
    await expect(f.run()).rejects.toThrow();
    const held = await f.recovery.read(); expect(held?.kind).toBe(failure === "transport" ? "setup-message-intent" : "setup-message-raw");
    expect((await f.savedAccount())?.welcomeStatus).toBe("uncertain");
    await expect(f.run()).rejects.toThrow(); expect(f.fetch).toHaveBeenCalledOnce(); expect(await f.recovery.read()).toEqual(held);
  });
  it("retains original transport failure before independent uncertainty SQL failure", async () => {
    const f = await fixture(), transportFailure = new Error("original transport completion unknown"), sqlFailure = new Error("uncertainty SQL save failed");
    f.fetch.mockRejectedValue(transportFailure);
    const transaction = db.transaction.bind(db); let count = 0;
    vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => {
      if (++count === 2) return Promise.reject(sqlFailure);
      return transaction(action);
    }) as typeof db.transaction);
    const failure = await f.run().then(() => undefined, error => error);
    expect(failure).toMatchObject({ code: "slack_setup_message_recovery_pending" });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(failure.cause.errors).toEqual([transportFailure, sqlFailure]);
    expect((await f.savedAccount())?.welcomeStatus).toBe("sending");
    const held = await f.recovery.read(); expect(held?.kind).toBe("setup-message-intent");
    await expect(f.run()).rejects.toThrow(); expect(f.fetch).toHaveBeenCalledOnce(); expect(await f.recovery.read()).toEqual(held);
  });
  it("holds exact result on lost final SQL reply without overwriting committed status", async () => {
    const f = await fixture(), transaction = db.transaction.bind(db); let count = 0;
    vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => (async () => { const result = await transaction(action); if (++count === 2) throw new Error("lost final SQL reply"); return result; })()) as typeof db.transaction);
    await expect(f.run()).rejects.toThrow(); expect((await f.recovery.read())?.kind).toBe("setup-message-result");
    expect((await f.savedAccount())?.welcomeStatus).toBe("sent");
    await expect(f.run()).rejects.toThrow(); expect(f.fetch).toHaveBeenCalledOnce(); expect((await f.recovery.read())?.kind).toBe("setup-message-result");
  });
  it("refuses historical sent status without inventing a receipt", async () => {
    const f = await fixture(), account = await f.savedAccount();
    await db.update(chatEndpoints).set({ setup: { slackAccount: { ...account!, welcomeStatus: "sent" } } }).where(eq(chatEndpoints.id, f.endpoint.id));
    await expect(f.run()).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled(); expect(await f.recovery.read()).toBeNull();
  });
  it("refuses a runtime version changed after intent before provider dispatch", async () => {
    const f = await fixture(), rename = fs.rename.bind(fs); let changed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!changed && String(to) === setupMessageRecoveryPath(f.companyId, f.endpoint.id, "welcome")) {
        changed = true; const [version] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, f.secret.id));
        await db.insert(companySecretVersions).values({ ...version, id: randomUUID(), version: 2 });
        await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, f.secret.id));
      }
    });
    await expect(f.run()).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled(); expect((await f.recovery.read())?.kind).toBe("setup-message-intent");
  });
  it("refuses absent current runtime identity before durable intent or dispatch", async () => {
    const f = await fixture(); f.runtimeBotCredential.mockRejectedValue(new Error("runtime identity unavailable"));
    await expect(f.run()).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled(); expect(await f.recovery.read()).toBeNull();
  });
  for (const change of ["endpoint-control", "runtime-version"] as const) it(`refuses settled receipt reuse after ${change} changes without reposting`, async () => {
    const f = await fixture(); await f.run();
    const receipt = await f.recovery.read(); expect(receipt?.kind).toBe("setup-message-settled");
    if (change === "endpoint-control") {
      const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "Changed assignment", adapterType: "claude_local" }).returning();
      await db.update(chatEndpoints).set({ assignedAgentId: other.id }).where(eq(chatEndpoints.id, f.endpoint.id));
    } else {
      const [original] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, f.secret.id));
      await db.insert(companySecretVersions).values({ ...original, id: randomUUID(), version: 2 });
      await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, f.secret.id));
    }
    await expect(f.run()).rejects.toMatchObject({ code: "slack_setup_message_recovery_pending" });
    expect(f.fetch).toHaveBeenCalledOnce(); expect(await f.recovery.read()).toEqual(receipt);
    expect((await f.savedAccount())?.welcomeStatus).toBe("sent");
  });

});
