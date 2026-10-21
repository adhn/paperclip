import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { readSecretRecoveryIdentity } from "../../../secret-recovery-identity.js";
import { setupMessageRecovery } from "./setup-message-recovery.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companySecrets, companySecretVersions, chatActions, chatEndpoints, chatSlackManagerGrants, chatSlackRegistrations, toolApplications, toolConnections, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../../__tests__/helpers/embedded-postgres.js";
import { writeConnectionCredential } from "../../../connection-credentials.js";
import { secretService } from "../../../secrets.js";
import { createSlackRegistrationStore, type SlackSetupOptions } from "./registration.js";
import { createSlackManagerGrants } from "./manager-grants.js";
import { createCustomerOwnedSetup } from "./customer-owned.js";
import { createManagedSlackSetup } from "./managed.js";
import { createSlackCompletion } from "./completion.js";
import { stagedCleanupRecovery, stagedCleanupRecoveryPath, assertStagedCleanupParentRemovalAllowed } from "./staged-cleanup-recovery.js";
import { managedInstallRecoveryPath, managedInstallRecovery, managedInstallHash, assertManagedInstallCompletionAllowed } from "./managed-install-recovery.js";
const authority = vi.hoisted(() => ({ deniedUsers: new Set<string>(), enabled: true }));
vi.mock("../../../access.js", () => ({ accessService: () => ({ hasPermission: async (_company: string, _type: string, user: string) => !authority.deniedUsers.has(user) }) }));
vi.mock("../../../instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableChatConnectors: authority.enabled }), getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("actual staged cleanup durable custody integration", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let root: string;
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "staged-cleanup-sql-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key"); process.env.PAPERCLIP_HOME = root;
    if (externalUrl) db = createDb(externalUrl);
    else { database = await startEmbeddedPostgresTestDatabase("staged-cleanup-sql-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterEach(() => { vi.restoreAllMocks(); authority.deniedUsers.clear(); authority.enabled = true; });
  afterAll(async () => {
    await database?.cleanup();
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(actualCompletion = true) {
    const companyId = randomUUID(), actor = { userId: `managed-${randomUUID()}`, sessionId: "original-session", bypassPermissionCheck: false };
    const workspaceId = `T${companyId.replaceAll("-", "").toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Managed original", issuePrefix: `I${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Managed fixture", adapterType: "claude_local" }).returning();
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Managed fixture", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app.id, name: "Managed fixture", uid: randomUUID(), transport: "rest_api" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, assignedAgentId: agent.id, provider: "slack", publicId: randomUUID(), status: "attention", setup: { slackSetupMethod: "managed", runtimeGeneration: 0 } }).returning();
    const refs = [];
    for (const key of ["access", "refresh"]) refs.push(await writeConnectionCredential(db, { companyId, ownerUserId: actor.userId, actor: { userId: actor.userId }, connectionName: "Managed", configPath: key, label: key, definitionKey: `managed.${randomUUID()}`, value: `original-${key}` }));
    const [grant] = await db.insert(chatSlackManagerGrants).values({ companyId, userId: actor.userId, slackUserId: "UORIGINAL", workspaceId: workspaceId, workspaceName: "Original", managerAppId: "AMANAGER", accessSecretId: refs[0].secret.id, refreshSecretId: refs[1].secret.id, expiresAt: new Date("2099-01-01") }).returning();
    const vault = secretService(db), secretIds: Record<string, string> = {};
    for (const key of ["botToken", "clientSecret", "signingSecret"]) secretIds[key] = (await vault.create(companyId, { name: `${key}-${randomUUID()}`, provider: "local_encrypted", value: `original-${key}` })).id;
    const manifest = { settings: { event_subscriptions: { request_url: `https://fixture.invalid/api/chat-webhooks/${endpoint.publicId}/slack` } }, oauth_config: { scopes: { bot: ["chat:write"] } } };
    const [registration] = await db.insert(chatSlackRegistrations).values({ companyId, endpointId: endpoint.id, managerGrantId: grant.id, requestId: randomUUID(), status: "configured", manifest,
      manifestHash: managedInstallHash(JSON.stringify(manifest)), callbackUri: "https://fixture.invalid/api/chat-slack/oauth/callback", appId: "ACHILD", clientId: "123.456", secretIds, workspaceId: grant.workspaceId, createdByUserId: actor.userId }).returning();
    const recovery = managedInstallRecovery(companyId, endpoint.id), mode = { fail: "" }, runtime = { botSecretId: "" };
    const decoded = { ok: true, app_id: "ACHILD", team_id: workspaceId, api_access_tokens: { bot_access_token: "xoxb-managed-exact-result" } };
    const broker = { recoveryAuthority: { schema: 1, kind: "hosted-sealed", baseUrl: "https://broker.fixture.invalid", instanceId: "fixture", environment: "staging", signingKeySha256: "c".repeat(64), sealingKeySha256: "d".repeat(64) }, getSlackManagerAppId: vi.fn(async () => "AMANAGER") };
    const options = { managed: { enabled: true, broker }, publicOrigin: () => "https://fixture.invalid", webhookOrigin: () => "https://fixture.invalid",
      withLock: async (_id: string, work: (lease: { assertOwned(): Promise<void> }) => Promise<unknown>) => work({ assertOwned: async () => {} }) } as unknown as SlackSetupOptions;
    // Application callbacks model configure/link acknowledgements with actual
    // encrypted storage; they do not establish native runtime/provider acceptance.
    options.configure = vi.fn(async (_id, credentials) => {
      runtime.botSecretId = (await vault.create(companyId, { name: `runtime-bot-${randomUUID()}`, provider: "local_encrypted", value: credentials.botToken })).id;
      await db.update(toolConnections).set({ credentialSecretRefs: [{ configPath: "credentials.botToken", secretId: runtime.botSecretId, versionSelector: "latest" }] }).where(eq(toolConnections.id, connection.id));
      const [current] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
      await db.update(chatEndpoints).set({ status: "verifying", providerAccountId: workspaceId, botExternalId: "UCHILD",
        setup: { ...current.setup, webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, endpoint.id));
    });
    options.linkInstaller = vi.fn(async () => {});
    options.canWelcome = vi.fn(async () => true);
    options.runtimeBotToken = async () => vault.resolveSecretValue(companyId, runtime.botSecretId, "latest");
    options.runtimeBotCredential = async () => withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      const [current] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));
      const selected = current.credentialSecretRefs.filter(ref => ref.configPath === "credentials.botToken");
      expect(selected).toHaveLength(1); expect(selected[0].versionSelector ?? "latest").toBe("latest");
      expect(selected[0].secretId).toBe(runtime.botSecretId);
      const identity = await readSecretRecoveryIdentity(db, companyId, selected[0].secretId);
      const value = await vault.resolveSecretValue(companyId, selected[0].secretId, "latest");
      expect(await readSecretRecoveryIdentity(db, companyId, selected[0].secretId)).toEqual(identity);
      return { identity, value };
    });
    const store = createSlackRegistrationStore(db, options);
    const api = vi.fn(async (method: string, fields: unknown, _token?: string, _scopes?: readonly string[], observe?: (raw: { status: number; headers: Record<string, string>; bodyBase64: string }) => Promise<void>) => {
      if (actualCompletion && method !== "apps.managedInstall") {
        if (method === "auth.test") return { ok: true, team_id: workspaceId, user_id: "UCHILD", bot_id: "BCHILD" };
        if (method === "bots.info") return { ok: true, bot: { id: "BCHILD", app_id: "ACHILD", user_id: "UCHILD", deleted: false } };
        if (method === "users.info") return { ok: true, user: { id: "UORIGINAL", team_id: workspaceId, is_bot: false, is_app_user: false, deleted: false } };
        if (method === "chat.postMessage") {
          const messageKind = String((fields as { text?: string }).text).startsWith("Your Slack") ? "verification" : "welcome";
          const response = { ok: true, channel: "DFIXTURE", ts: messageKind === "welcome" ? "123.456" : "123.457" };
          const held = await setupMessageRecovery(companyId, endpoint.id, messageKind).read();
          expect(held).toMatchObject({ kind: "setup-message-intent", messageKind, runtimeTokenIdentity: { secretId: runtime.botSecretId } });
          expect(observe).toBeTypeOf("function");
          await observe!({ status: 200, headers: { "x-fixture-message": messageKind }, bodyBase64: Buffer.from(JSON.stringify(response)).toString("base64") });
          expect(await setupMessageRecovery(companyId, endpoint.id, messageKind).read()).toMatchObject({ kind: "setup-message-raw" });
          return response;
        }
        throw new Error(`unexpected actual completion method ${method}`);
      }
      expect(method).toBe("apps.managedInstall"); expect(fields).toEqual({ app_id: "ACHILD", team_id: workspaceId });
      const held = await recovery.read();
      expect(held).toMatchObject({ kind: "managed-install-intent", originalRegistration: { status: "configured", requestId: registration.requestId }, requestedRequestId: input.requestId,
        preparedRegistration: { status: "install" }, preparedAction: { status: "processing" } });
      if (mode.fail === "transport") throw new Error("unknown managed installation result");
      const raw = { status: 200, headers: {}, bodyBase64: Buffer.from(mode.fail === "decode" ? "invalid JSON" : JSON.stringify(decoded)).toString("base64") };
      expect(observe).toBeTypeOf("function"); await observe!(raw);
      expect(await recovery.read()).toMatchObject({ kind: "managed-install-raw", raw });
      if (mode.fail === "decode") throw new Error("invalid managed installation result");
      if (mode.fail === "action-changed") await db.update(chatActions).set({ payload: { originalControlCancelled: true } }).where(eq(chatActions.endpointId, endpoint.id));
      return decoded;
    });
    store.api = api;
    // Synthetic application completion barrier: it proves local ordering only,
    // never native runtime configuration, provider readiness or physical cleanup.
    const resumeLocked = vi.fn(async () => {
      await assertManagedInstallCompletionAllowed(companyId, endpoint.id);
      expect(await recovery.read()).toMatchObject({ kind: "managed-install-result" });
      const current = await store.registration(endpoint.id);
      expect(current?.status).toBe("credentials_saved");
      if (mode.fail === "completion") throw new Error("completion acknowledgement unknown");
      runtime.botSecretId = (await vault.create(companyId, { name: `synthetic-runtime-bot-${randomUUID()}`, provider: "local_encrypted", value: "xoxb-managed-exact-result" })).id;
      await db.update(chatSlackRegistrations).set({ status: "configured" }).where(eq(chatSlackRegistrations.endpointId, endpoint.id));
    });
    const manager = createSlackManagerGrants(store);
    const completion = actualCompletion ? createSlackCompletion(store) : { resumeLocked } as unknown as ReturnType<typeof createSlackCompletion>;
    const managed = createManagedSlackSetup(store, manager, createCustomerOwnedSetup(store), completion, vi.fn());
    const input = { grantId: grant.id, requestId: randomUUID(), reconnect: true };
    return { companyId, actor, endpoint, registration, grant, secretIds, recovery, mode, store, api, resumeLocked, managed, input, vault, runtime, options };
  }
  async function assertMessagesSettled(f: Awaited<ReturnType<typeof fixture>>) {
    for (const messageKind of ["welcome", "verification"] as const) {
      const receipt = await setupMessageRecovery(f.companyId, f.endpoint.id, messageKind).read();
      const ts = messageKind === "welcome" ? "123.456" : "123.457";
      expect(receipt).toMatchObject({ kind: "setup-message-settled", decoded: { channel: "DFIXTURE", ts },
        intent: { messageKind, runtimeTokenIdentity: { secretId: f.runtime.botSecretId },
          originalConnection: { credentialSecretRefs: [{ configPath: "credentials.botToken", secretId: f.runtime.botSecretId, versionSelector: "latest" }] } } });
      if (!receipt || receipt.kind !== "setup-message-settled") throw new Error("Expected retained original message receipt");
      expect(JSON.parse(Buffer.from(receipt.raw.bodyBase64, "base64").toString("utf8"))).toEqual({ ok: true, channel: "DFIXTURE", ts });
      expect(receipt.raw.headers["x-fixture-message"]).toBe(messageKind);
    }
  }
  function causeSummary(error: unknown, depth = 0): unknown {
    if (depth > 6 || !error || typeof error !== "object") return { thrownType: typeof error };
    const value = error as { name?: string; message?: string; code?: string; details?: { code?: string }; cause?: unknown; errors?: unknown[] };
    // First line contains the operation/error, never Drizzle's separate params
    // line. Redact known fixture credential forms before exposing diagnostics.
    const message = String(value.message ?? "").split("\n")[0].replace(/(?:xoxb-|original-|fixture-original-)[A-Za-z0-9_-]+/g, "[fixture credential]").slice(0, 240);
    return { name: value.name, message, code: value.code, detailCode: value.details?.code,
      cause: value.cause ? causeSummary(value.cause, depth + 1) : undefined,
      errors: value.errors?.map(item => causeSummary(item, depth + 1)) };
  }
  async function failAt(f: Awaited<ReturnType<typeof fixture>>, stage: () => boolean, label: string) {
    const error = await f.managed.provision(f.endpoint.id, f.actor, f.input).then(() => null, failure => failure);
    expect(error).toBeInstanceOf(Error);
    if (!stage()) {
      const registration = await f.store.registration(f.endpoint.id);
      const parent = await f.recovery.read();
      const cleanup = await stagedCleanupRecovery(f.companyId, f.endpoint.id).read();
      throw new Error(JSON.stringify({ expectedStage: label, apiMethods: f.api.mock.calls.map(call => call[0]), registrationStatus: registration?.status,
        registrationError: registration?.errorCode, parentKind: parent?.kind, cleanupAckCount: cleanup?.acknowledgedRemovalIds.length, error: causeSummary(error) }));
    }
  }
  async function noReplay(f: Awaited<ReturnType<typeof fixture>>) {
    const calls = f.api.mock.calls.length;
    await expect(f.managed.provision(f.endpoint.id, f.actor, f.input)).rejects.toThrow();
    expect(f.api).toHaveBeenCalledTimes(calls);
  }
  it("removes independently acknowledged original targets only after durable cleanup intent", async () => {
    const f = await fixture(), remove = db.delete.bind(db); let sawBot = false, sawSigning = false;
    vi.spyOn(db, "delete").mockImplementation(((table: unknown) => {
      const builder = remove(table as never);
      if (table !== companySecrets) return builder;
      const where = builder.where.bind(builder);
      builder.where = ((...args: Parameters<typeof where>) => {
        const query = where(...args), then = query.then.bind(query);
        query.then = ((yes: any, no: any) => then(async value => {
          const cleanup = await stagedCleanupRecovery(f.companyId, f.endpoint.id).read();
          expect(cleanup).not.toBeNull(); expect(await f.recovery.read()).toMatchObject({ kind: "managed-install-result" });
          if (!sawBot) { sawBot = true; expect(cleanup!.acknowledgedRemovalIds).toEqual([]); }
          else { sawSigning = true; expect(cleanup!.acknowledgedRemovalIds).toEqual([f.secretIds.botToken]); }
          return value;
        }).then(yes, no)) as typeof query.then;
        return query;
      }) as typeof builder.where;
      return builder;
    }) as typeof db.delete);
    await f.managed.provision(f.endpoint.id, f.actor, f.input);
    expect(sawBot).toBe(true); expect(sawSigning).toBe(true);
    await assertMessagesSettled(f);
    expect(await f.recovery.read()).toBeNull(); expect(await stagedCleanupRecovery(f.companyId, f.endpoint.id).read()).toBeNull();
    expect((await f.store.registration(f.endpoint.id))!.secretIds).toEqual({ clientSecret: f.secretIds.clientSecret });
    expect(await f.vault.resolveSecretValue(f.companyId, f.runtime.botSecretId, "latest")).toBe("xoxb-managed-exact-result");
  });
  it.each(["permission", "feature", "archived-connection"] as const)("refuses staged deletion when %s changes after application completion", async change => {
    const f = await fixture(false), originalCompletion = f.resumeLocked.getMockImplementation()!;
    f.resumeLocked.mockImplementationOnce(async () => {
      await originalCompletion();
      if (change === "permission") authority.deniedUsers.add(f.actor.userId);
      else if (change === "feature") authority.enabled = false;
      else await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, f.endpoint.connectionId));
    });
    const deletion = vi.spyOn(db, "delete");
    await expect(f.managed.provision(f.endpoint.id, f.actor, f.input)).rejects.toThrow();
    expect(f.resumeLocked).toHaveBeenCalledOnce();
    expect(deletion.mock.calls.filter(([table]) => table === companySecrets)).toHaveLength(0);
    expect(await f.vault.getById(f.secretIds.botToken)).toMatchObject({ status: "active" });
    expect(await f.vault.getById(f.secretIds.signingSecret)).toMatchObject({ status: "active" });
    expect(await stagedCleanupRecovery(f.companyId, f.endpoint.id).read()).toBeNull();
    expect(await f.recovery.read()).toMatchObject({ kind: "managed-install-result" });
    await noReplay(f);
  });
  it.each(["permission", "control"] as const)("retains the first exact removal acknowledgement when %s changes between removals", async change => {
    const f = await fixture(false), rename = fs.rename.bind(fs); let changed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!changed && String(to) === stagedCleanupRecoveryPath(f.companyId, f.endpoint.id)) {
        const state = await stagedCleanupRecovery(f.companyId, f.endpoint.id).read();
        if (state?.acknowledgedRemovalIds.includes(f.secretIds.botToken)) {
          changed = true;
          if (change === "permission") authority.deniedUsers.add(f.actor.userId);
          else {
            const [current] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
            await db.update(chatEndpoints).set({ setup: { ...current.setup, runtimeGeneration: 99 } }).where(eq(chatEndpoints.id, f.endpoint.id));
          }
        }
      }
    });
    await failAt(f, () => changed, "control changed after first independent removal acknowledgement");
    const retained = await stagedCleanupRecovery(f.companyId, f.endpoint.id).read();
    expect(retained!.acknowledgedRemovalIds).toEqual([f.secretIds.botToken]);
    expect(retained!.intent.originalEndpoint.id).toBe(f.endpoint.id);
    expect(retained!.intent.originalConnection.id).toBe(f.endpoint.connectionId);
    expect(await f.vault.getById(f.secretIds.botToken)).toBeNull();
    expect(await f.vault.getById(f.secretIds.signingSecret)).toMatchObject({ status: "active" });
    expect(await f.recovery.read()).toMatchObject({ kind: "managed-install-result" });
    await noReplay(f);
  });
  it("retains original intent after first removal SQL reply is lost without inferring missing-row success", async () => {
    const f = await fixture(), remove = db.delete.bind(db); let lost = false;
    vi.spyOn(db, "delete").mockImplementation(((table: unknown) => {
      const builder = remove(table as never); if (table !== companySecrets) return builder;
      const where = builder.where.bind(builder);
      builder.where = ((...args: Parameters<typeof where>) => {
        const query = where(...args), then = query.then.bind(query);
        query.then = ((yes: any, no: any) => then(value => { if (!lost) { lost = true; throw new Error("fixture removal acknowledgement lost"); } return value; }).then(yes, no)) as typeof query.then;
        return query;
      }) as typeof builder.where; return builder;
    }) as typeof db.delete);
    await failAt(f, () => lost, "removal SQL reply lost");
    expect(lost).toBe(true); expect(await f.vault.getById(f.secretIds.botToken)).toBeNull();
    expect(await f.vault.getById(f.secretIds.signingSecret)).not.toBeNull();
    const cleanup = await stagedCleanupRecovery(f.companyId, f.endpoint.id).read();
    expect(cleanup!.acknowledgedRemovalIds).toEqual([]); expect(await f.recovery.read()).toMatchObject({ kind: "managed-install-result" });
    await noReplay(f);
  });
  it("retains first independent removal acknowledgement when second removal fails before deletion", async () => {
    const f = await fixture(), remove = db.delete.bind(db); let count = 0;
    vi.spyOn(db, "delete").mockImplementation(((table: unknown) => {
      if (table === companySecrets && ++count === 2) throw new Error("fixture second deletion failed");
      return remove(table as never);
    }) as typeof db.delete);
    await failAt(f, () => count === 2, "second actual deletion");
    expect((await stagedCleanupRecovery(f.companyId, f.endpoint.id).read())!.acknowledgedRemovalIds).toEqual([f.secretIds.botToken]);
    expect(await f.vault.getById(f.secretIds.botToken)).toBeNull();
    expect(await f.vault.getById(f.secretIds.signingSecret)).toMatchObject({ status: "deleted" });
    await noReplay(f);
  });
  it("retains full removal facts when exact registration update COMMIT reply is lost", async () => {
    const f = await fixture(), transaction = db.transaction.bind(db); let lost = false;
    vi.spyOn(db, "transaction").mockImplementation(async (work, config) => {
      let cleanupCommit = false;
      const result = await transaction(async tx => {
        const value = await work(tx);
        const [registration] = await tx.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
        const cleanup = await stagedCleanupRecovery(f.companyId, f.endpoint.id).read();
        if (!lost && cleanup?.acknowledgedRemovalIds.length === 2 && !registration.secretIds.botToken) { lost = true; cleanupCommit = true; }
        return value;
      }, config);
      if (cleanupCommit) throw new Error("fixture registration acknowledgement lost"); return result;
    });
    await failAt(f, () => lost, "registration SQL acknowledgement lost");
    expect(lost).toBe(true); expect((await f.store.registration(f.endpoint.id))!.secretIds).toEqual({ clientSecret: f.secretIds.clientSecret });
    expect((await stagedCleanupRecovery(f.companyId, f.endpoint.id).read())!.acknowledgedRemovalIds).toHaveLength(2);
    expect(await f.recovery.read()).toMatchObject({ kind: "managed-install-result" }); await noReplay(f);
  });
  it("retains cleanup custody if parent result clear fails after acknowledged registration cleanup", async () => {
    const f = await fixture(), rm = fs.rm.bind(fs); let parentClearReached = false;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === managedInstallRecoveryPath(f.companyId, f.endpoint.id)) { parentClearReached = true; throw new Error("fixture parent clear failed"); } return rm(target, options);
    });
    await failAt(f, () => parentClearReached, "parent exact result clear");
    expect((await stagedCleanupRecovery(f.companyId, f.endpoint.id).read())!.acknowledgedRemovalIds).toHaveLength(2);
    expect(await f.recovery.read()).toMatchObject({ kind: "managed-install-result" }); await noReplay(f);
  });
  it.each(["missing", "same-value-version"] as const)("refuses a %s target after cleanup intent without acknowledging removal", async change => {
    const f = await fixture(), rename = fs.rename.bind(fs); let changed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!changed && String(to) === stagedCleanupRecoveryPath(f.companyId, f.endpoint.id)) {
        changed = true;
        if (change === "missing") await db.delete(companySecrets).where(eq(companySecrets.id, f.secretIds.botToken));
        else {
          const [parent] = await db.select().from(companySecrets).where(eq(companySecrets.id, f.secretIds.botToken));
          const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, f.secretIds.botToken));
          const original = versions.find(version => version.version === parent.latestVersion)!;
          await db.insert(companySecretVersions).values({ ...original, id: randomUUID(), version: parent.latestVersion + 1 });
          await db.update(companySecrets).set({ latestVersion: parent.latestVersion + 1 }).where(eq(companySecrets.id, parent.id));
        }
      }
    });
    await failAt(f, () => changed, `post-publication target ${change}`);
    expect(changed).toBe(true); expect((await stagedCleanupRecovery(f.companyId, f.endpoint.id).read())!.acknowledgedRemovalIds).toEqual([]);
    expect(await f.vault.getById(f.secretIds.signingSecret)).not.toBeNull(); expect(await f.recovery.read()).toMatchObject({ kind: "managed-install-result" });
    await noReplay(f);
  });

  it("does not accept another parent or another target as a deletion bypass", async () => {
    const f = await fixture(), rename = fs.rename.bind(fs); let stopped = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!stopped && String(to) === stagedCleanupRecoveryPath(f.companyId, f.endpoint.id)) { stopped = true; throw new Error("fixture stop after cleanup publication"); }
    });
    await failAt(f, () => stopped, "cleanup publication before scope");
    expect(stopped).toBe(true);
    const cleanup = (await stagedCleanupRecovery(f.companyId, f.endpoint.id).read())!;
    await expect(assertStagedCleanupParentRemovalAllowed(f.companyId, f.secretIds.botToken, randomUUID(), cleanup.intent.parentResultHash)).rejects.toThrow();
    await expect(assertStagedCleanupParentRemovalAllowed(f.companyId, f.secretIds.clientSecret, cleanup.intent.parentManagedOperationId, cleanup.intent.parentResultHash)).rejects.toThrow();
    await expect(f.vault.remove(f.secretIds.botToken)).rejects.toThrow(); await noReplay(f);
  });
});
