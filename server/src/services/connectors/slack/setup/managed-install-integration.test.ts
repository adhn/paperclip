import { AsyncResource } from "node:async_hooks";
import { assertSlackSetupNewUse } from "./new-use-guard.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { readSecretRecoveryIdentity } from "../../../secret-recovery-identity.js";
import { setupMessageRecovery } from "./setup-message-recovery.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, chatActions, chatEndpoints, chatSlackManagerGrants, chatSlackRegistrations, toolApplications, toolConnections, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../../__tests__/helpers/embedded-postgres.js";
import { writeConnectionCredential } from "../../../connection-credentials.js";
import { secretService } from "../../../secrets.js";
import { createSlackRegistrationStore, type SlackSetupOptions } from "./registration.js";
import { createSlackManagerGrants } from "./manager-grants.js";
import { createCustomerOwnedSetup } from "./customer-owned.js";
import { createManagedSlackSetup } from "./managed.js";
import { createSlackCompletion } from "./completion.js";
import { managedInstallRecovery, managedInstallHash, assertManagedInstallCompletionAllowed } from "./managed-install-recovery.js";
vi.mock("../../../access.js", () => ({ accessService: () => ({ hasPermission: async () => true }) }));
vi.mock("../../../instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableChatConnectors: true }), getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("actual managed installation durable dispatch integration", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let root: string;
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-install-sql-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key"); process.env.PAPERCLIP_HOME = root;
    if (externalUrl) db = createDb(externalUrl);
    else { database = await startEmbeddedPostgresTestDatabase("managed-install-sql-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await database?.cleanup();
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(actualCompletion = false) {
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
  it("retains original/prepared action and distinct request IDs before one dispatch and clears after acknowledged completion", async () => {
    const f = await fixture();
    await f.managed.provision(f.endpoint.id, f.actor, f.input);
    expect(f.api).toHaveBeenCalledOnce(); expect(f.resumeLocked).toHaveBeenCalledOnce();
    expect(await f.recovery.read()).toBeNull();
    expect(await f.vault.getById(f.secretIds.botToken)).toBeNull();
    expect(await f.vault.getById(f.secretIds.signingSecret)).toBeNull();
    expect(await f.vault.resolveSecretValue(f.companyId, f.runtime.botSecretId, "latest")).toBe("xoxb-managed-exact-result");
    const [action] = await db.select().from(chatActions).where(eq(chatActions.endpointId, f.endpoint.id));
    expect(action.status).toBe("processed");
  });
  it("runs actual completion auth/link/message SQL while deferring staged cleanup until its separate owner", async () => {
    const f = await fixture(true);
    await f.managed.provision(f.endpoint.id, f.actor, f.input);
    expect(f.api.mock.calls.map(call => call[0])).toEqual(["apps.managedInstall", "auth.test", "bots.info", "users.info", "chat.postMessage", "chat.postMessage"]);
    expect(f.options.configure).toHaveBeenCalledOnce();
    expect(f.options.linkInstaller).toHaveBeenCalledOnce();
    await assertMessagesSettled(f);
    const saved = await f.store.registration(f.endpoint.id);
    expect(saved).toMatchObject({ status: "configured" });
    expect(saved?.secretIds.botToken).toBeUndefined(); expect(saved?.secretIds.signingSecret).toBeUndefined();
    expect(saved?.secretIds.clientSecret).toBe(f.secretIds.clientSecret);
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
    expect(endpoint.setup.slackAccount).toMatchObject({ status: "linked", welcomeStatus: "sent", verificationStatus: "sent" });
    expect(await f.vault.getById(f.secretIds.botToken)).toBeNull();
    expect(await f.vault.getById(f.secretIds.signingSecret)).toBeNull();
    expect(await f.vault.resolveSecretValue(f.companyId, f.runtime.botSecretId, "latest")).toBe("xoxb-managed-exact-result");
    expect(await f.recovery.read()).toBeNull();
  });
  it("joins a completion callback acquiring company lock while retaining endpoint lease and original hold", async () => {
    const f = await fixture(true), callback = new AsyncResource("managed-completion-independent-callback");
    const configure = vi.mocked(f.options.configure), original = configure.getMockImplementation()!;
    let leaseHeld = false, joined = false;
    f.options.withLock = async (_id, work) => {
      leaseHeld = true;
      try { return await work({ assertOwned: async () => { expect(leaseHeld).toBe(true); } }); }
      finally { leaseHeld = false; }
    };
    configure.mockImplementation(async (...args) => {
      expect(leaseHeld).toBe(true);
      await callback.runInAsyncScope(() => withAccountHomeSecretMutationLock(undefined, f.companyId, async () => {
        expect(leaseHeld).toBe(true);
        expect(await f.recovery.read()).toMatchObject({ kind: "managed-install-result" });
        await expect(assertSlackSetupNewUse({ companyId: f.companyId, endpointId: f.endpoint.id, actorUserId: f.actor.userId })).rejects.toThrow();
        joined = true;
      }));
      await original(...args);
    });
    try {
      await f.managed.provision(f.endpoint.id, f.actor, f.input);
      expect(joined).toBe(true); expect(leaseHeld).toBe(false);
      await assertMessagesSettled(f); expect(await f.recovery.read()).toBeNull();
    } finally { callback.emitDestroy(); }
  }, 40_000);

  it("never dispatches when original intent publication fails", async () => {
    const f = await fixture(), rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to).endsWith(`${f.endpoint.id}.json`)) throw new Error("intent publication failed"); return rename(from, to); });
    await expect(f.managed.provision(f.endpoint.id, f.actor, f.input)).rejects.toThrow();
    expect(f.api).not.toHaveBeenCalled(); expect(f.resumeLocked).not.toHaveBeenCalled();
  });
  it("retains the exact result without saving or overwriting a reconnect action changed during dispatch", async () => {
    const f = await fixture(); f.mode.fail = "action-changed";
    await expect(f.managed.provision(f.endpoint.id, f.actor, f.input)).rejects.toThrow();
    expect(f.api).toHaveBeenCalledOnce();
    expect(await f.recovery.read()).toMatchObject({ kind: "managed-install-result" });
    expect(await f.vault.resolveSecretValue(f.companyId, f.secretIds.botToken, "latest")).toBe("original-botToken");
    expect(f.resumeLocked).not.toHaveBeenCalled();
    const [action] = await db.select().from(chatActions).where(eq(chatActions.endpointId, f.endpoint.id));
    expect(action).toMatchObject({ status: "processing", payload: { originalControlCancelled: true } });
    await expect(f.managed.provision(f.endpoint.id, f.actor, f.input)).rejects.toThrow();
    expect(f.api).toHaveBeenCalledOnce();
  });
  it.each(["transport", "raw"] as const)("preserves original %s failure before independent failure-audit error without replay", async kind => {
    const f = await fixture(), dispatchError = new Error("original installation outcome unknown"), auditError = new Error("independent failure audit unavailable");
    const raw = { status: 200, headers: { "x-fixture": "original-raw" }, bodyBase64: Buffer.from("invalid original response").toString("base64") };
    f.api.mockImplementation(async (_method, _fields, _bearer, _requiredScopes, observe) => {
      expect((await f.recovery.read())?.kind).toBe("managed-install-intent");
      if (kind === "raw") { expect(observe).toBeTypeOf("function"); await observe!(raw); }
      throw dispatchError;
    });
    const audit = f.store.audit.bind(f.store);
    const auditSpy = vi.spyOn(f.store, "audit").mockImplementation(async (...args) => {
      if (args[2] === "installation_failed") throw auditError;
      return audit(...args);
    });
    const failure = await f.managed.provision(f.endpoint.id, f.actor, f.input).then(() => undefined, error => error);
    expect(failure).toMatchObject({ code: "slack_managed_install_recovery_pending" });
    expect(failure.cause).toBeInstanceOf(AggregateError); expect(failure.cause.errors).toEqual([dispatchError, auditError]);
    expect(auditSpy.mock.calls.filter(args => args[2] === "installation_failed")).toHaveLength(1);
    const retained = await f.recovery.read(); expect(retained?.kind).toBe(kind === "raw" ? "managed-install-raw" : "managed-install-intent");
    expect((await f.store.registration(f.endpoint.id))?.status).toBe("install");
    expect(await f.vault.resolveSecretValue(f.companyId, f.secretIds.botToken, "latest")).toBe("original-botToken");
    await expect(f.managed.provision(f.endpoint.id, f.actor, f.input)).rejects.toThrow();
    expect(f.api).toHaveBeenCalledOnce(); expect(await f.recovery.read()).toEqual(retained); expect(f.resumeLocked).not.toHaveBeenCalled();
  });
  for (const failure of ["transport", "decode", "sql-rollback", "sql-ack", "completion"] as const) {
    it(`retains ${failure} uncertainty and refuses automatic repeated installation`, async () => {
      const f = await fixture(); f.mode.fail = failure;
      if (failure.startsWith("sql-")) {
        const transaction = db.transaction.bind(db); let injected = false;
        vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => (async () => {
          const settling = !injected && (await f.recovery.read())?.kind === "managed-install-result";
          if (settling) injected = true;
          if (settling && failure === "sql-rollback") return transaction(async tx => { await action(tx); throw new Error("credential settlement rollback"); });
          const value = await transaction(action);
          if (settling && failure === "sql-ack") throw new Error("credential commit acknowledgement lost");
          return value;
        })()) as typeof db.transaction);
      }
      await f.managed.provision(f.endpoint.id, f.actor, f.input).catch(() => undefined);
      const retained = await f.recovery.read();
      expect(retained?.kind).toBe(failure === "transport" ? "managed-install-intent" : failure === "decode" ? "managed-install-raw" : "managed-install-result");
      await expect(f.managed.provision(f.endpoint.id, f.actor, f.input)).rejects.toThrow();
      expect(f.api).toHaveBeenCalledOnce(); expect(await f.recovery.read()).toEqual(retained);
      const saved = await f.store.registration(f.endpoint.id);
      if (failure === "sql-ack") {
        expect(saved?.status).toBe("credentials_saved");
        expect(await f.vault.resolveSecretValue(f.companyId, f.secretIds.botToken, "latest")).toBe("xoxb-managed-exact-result");
      }
      if (failure === "sql-rollback") expect(await f.vault.resolveSecretValue(f.companyId, f.secretIds.botToken, "latest")).toBe("original-botToken");
      await expect(f.vault.remove(f.secretIds.botToken)).rejects.toMatchObject({ status: 409 });
    });
  }
});
