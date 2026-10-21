import { AsyncResource } from "node:async_hooks";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, chatEndpoints, chatSlackManagerGrants, toolApplications, toolConnections, toolOauthStates, createDb } from "@paperclipai/db";
import { SLACK_MANAGER_SCOPES } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../../__tests__/helpers/embedded-postgres.js";
import { writeConnectionCredential } from "../../../connection-credentials.js";
import { secretService } from "../../../secrets.js";
import { createSlackManagerGrants } from "./manager-grants.js";
import { managerClaimRecovery, managerClaimHash } from "./manager-claim-recovery.js";
import type { SlackRegistrationStore } from "./registration.js";
import type { ConnectorRecoveryAuthority } from "../../../connector-recovery-authority.js";
import type { ConnectorRawResponseObserver } from "../../../paperclip-cloud-connector.js";
const permissions = vi.hoisted(() => ({ allowed: true }));
const lockProbe = vi.hoisted(() => ({ entered: null as (() => void) | null, pause: null as Promise<void> | null }));
vi.mock("@paperclipai/adapter-codex-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-codex-local/server")>();
  return { ...actual, withAccountHomeSecretMutationLock: async <T>(env: NodeJS.ProcessEnv | undefined, companyId: string, action: () => Promise<T>) => {
    const pause = lockProbe.pause;
    lockProbe.entered?.();
    if (pause) await pause;
    return actual.withAccountHomeSecretMutationLock(env, companyId, action);
  } };
});
vi.mock("../../../access.js", () => ({ accessService: () => ({ hasPermission: async () => permissions.allowed }) }));
vi.mock("../../../instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableChatConnectors: true }), getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("actual manager claim original recovery", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let root: string;
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-claim-sql-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key"); process.env.PAPERCLIP_HOME = root;
    if (externalUrl) db = createDb(externalUrl);
    else { database = await startEmbeddedPostgresTestDatabase("manager-claim-sql-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterEach(() => { vi.restoreAllMocks(); permissions.allowed = true; lockProbe.entered = null; lockProbe.pause = null; });
  afterAll(async () => {
    await database?.cleanup();
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const companyId = randomUUID(), actor = { userId: `claim-${randomUUID()}`, sessionId: "original-session", bypassPermissionCheck: false };
    await db.insert(companies).values({ id: companyId, name: "Claim original", issuePrefix: `C${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Claim fixture", adapterType: "claude_local" }).returning();
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Claim fixture", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app.id, name: "Claim fixture", uid: randomUUID(), transport: "rest_api" }).returning();
    const [originalEndpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, assignedAgentId: agent.id, provider: "slack", publicId: randomUUID(), status: "active", setup: { slackSetupMethod: "managed", runtimeGeneration: 0, slackManagerError: "slack_manager_reauthorize" } }).returning();
    const refs = [];
    for (const key of ["access", "refresh"]) refs.push(await writeConnectionCredential(db, { companyId, ownerUserId: actor.userId, actor: { userId: actor.userId }, connectionName: "Claim", configPath: key, label: key, definitionKey: `claim.${randomUUID()}`, value: `original-${key}` }));
    const [grant] = await db.insert(chatSlackManagerGrants).values({ companyId, userId: actor.userId, slackUserId: "UORIGINAL", workspaceId: "TORIGINAL", workspaceName: "Original", managerAppId: "AMANAGER", accessSecretId: refs[0].secret.id, refreshSecretId: refs[1].secret.id, expiresAt: new Date(Date.now() + 3_600_000) }).returning();
    const registration = { managerGrantId: grant.id, requestId: null, status: "ready" };
    const credentials = { v: 1 as const, provider: "slack" as const, profile: "slack.manager", instanceId: "fixture", environment: "staging" as const, subject: actor.userId, companyId,
      accessToken: "replacement-access", refreshToken: "replacement-refresh", tokenType: "user", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshTokenExpiresAt: null, scopes: [...SLACK_MANAGER_SCOPES],
      slackManager: { appId: "AMANAGER", workspaceId: "TORIGINAL", workspaceName: "Original", userId: "UORIGINAL" } };
    const mode = { failure: "" };
    const recovery = managerClaimRecovery(companyId, originalEndpoint.id);
    const claim = vi.fn(async (input: { redemptionId: string }, observe?: ConnectorRawResponseObserver) => {
      const retained = await recovery.read();
      expect(retained).toMatchObject({ kind: "manager-claim-intent", redemptionId: input.redemptionId, actorUserId: actor.userId, stateHash: managerClaimHash(state),
        originalEndpoint: { id: originalEndpoint.id }, originalOauthState: { createdByActorId: actor.userId } });
      expect((retained as { originalSecrets: unknown }).originalSecrets).toEqual(expect.objectContaining({ [refs[0].secret.id]: expect.any(Object), [refs[1].secret.id]: expect.any(Object) }));
      expect(await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).toHaveLength(0);
      if (mode.failure === "transport") throw new Error("unknown broker result");
      const raw = { status: 200, headers: { "x-fixture": "exact" }, bodyBase64: Buffer.from(mode.failure === "decode" ? "malformed sealed bytes" : '{"sealed":"fixture"}').toString("base64") };
      expect(observe).toBeTypeOf("function");
      await observe!(raw);
      expect(await recovery.read()).toMatchObject({ kind: "manager-claim-raw", raw });
      if (mode.failure === "decode") throw new Error("unseal failed");
      return credentials;
    });
    const broker = { recoveryAuthority: { schema: 1, kind: "hosted-sealed", baseUrl: "https://broker.fixture.invalid", instanceId: "fixture", environment: "staging", signingKeySha256: "c".repeat(64), sealingKeySha256: "d".repeat(64) } as ConnectorRecoveryAuthority,
      authorizationMode: "claim", claim, refresh: vi.fn(), revoke: vi.fn(),
      getSlackManagerAppId: vi.fn(async () => "AMANAGER"), startAuthorization: vi.fn(async (input: { returnState: string }) => ({ authorizationUrl: `https://fixture.invalid/?state=${input.returnState}` })) };
    const api = vi.fn(async () => ({ ok: true }));
    const service = createSlackManagerGrants({ db, api, origin: (value: string) => value,
      endpoint: async () => { if (!permissions.allowed) throw Object.assign(new Error("permission removed"), { status: 403 }); const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, originalEndpoint.id)); return { endpoint, connection }; },
      registration: async () => registration,
      options: { managed: { enabled: true, broker }, publicOrigin: () => "https://fixture.invalid", webhookOrigin: () => "https://fixture.invalid", withLock: async (_id: string, work: (lease: { assertOwned(): Promise<void> }) => Promise<unknown>) => work({ assertOwned: async () => {} }) } } as unknown as SlackRegistrationStore);
    await service.authorize(originalEndpoint.id, actor);
    const state = broker.startAuthorization.mock.calls[0][0].returnState;
    return { companyId, actor, originalEndpoint, grant, refs, mode, claim, broker, service, state, recovery, credentials, api };
  }
  it("publishes durable original intent before state deletion and never dispatches if publication fails", async () => {
    const f = await fixture(); const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to).endsWith(`${f.originalEndpoint.id}.json`)) throw new Error("claim intent publication failed"); return rename(from, to); });
    await expect(f.service.complete(f.state, "original-claim", null, f.actor)).rejects.toThrow();
    expect(f.claim).not.toHaveBeenCalled();
    expect(await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, f.state))).toHaveLength(1);
  });
  it("retains decoded result before actual credential SQL and clears only after endpoint finalization", async () => {
    const f = await fixture(); const transaction = db.transaction.bind(db); let sawSavedResult = false;
    vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => transaction(async tx => {
      if (f.claim.mock.calls.length) { expect(await f.recovery.read()).toMatchObject({ kind: "manager-claim-result", credentials: f.credentials }); sawSavedResult = true; }
      return action(tx);
    })) as typeof db.transaction);
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith(`${f.originalEndpoint.id}.json`)) {
        const [finalized] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.originalEndpoint.id));
        expect(finalized.setup.slackManagerError).toBeUndefined();
      }
      return remove(...args);
    });
    await f.service.complete(f.state, "original-claim", null, f.actor);
    expect(f.claim).toHaveBeenCalledOnce(); expect(sawSavedResult).toBe(true);
    expect(await f.recovery.read()).toBeNull();
    const [saved] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
    expect(saved).toMatchObject({ status: "active", revision: 1 });
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.originalEndpoint.id));
    expect(endpoint.setup.slackManagerError).toBeUndefined();
  });
  for (const failure of ["transport", "decode", "sql-ack"] as const) {
    it(`retains ${failure} uncertainty and refuses subsequent completion/authorize/token/revoke`, async () => {
      const f = await fixture(); f.mode.failure = failure;
      if (failure === "sql-ack") {
        const transaction = db.transaction.bind(db); let injected = false;
        vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => (async () => {
          const result = await transaction(action);
          if (f.claim.mock.calls.length && !injected) { injected = true; throw new Error("lost successful SQL acknowledgement"); }
          return result;
        })()) as typeof db.transaction);
      }
      await f.service.complete(f.state, "original-claim", null, f.actor).catch(() => undefined);
      const retained = await f.recovery.read();
      expect(retained?.kind).toBe(failure === "transport" ? "manager-claim-intent" : failure === "decode" ? "manager-claim-raw" : "manager-claim-result");
      f.broker.getSlackManagerAppId.mockClear();
      await expect(f.service.complete(f.state, "original-claim", null, f.actor)).rejects.toThrow();
      await expect(f.service.authorize(f.originalEndpoint.id, f.actor)).rejects.toThrow();
      await expect(f.service.token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
      await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
      expect(f.claim).toHaveBeenCalledOnce(); expect(f.broker.refresh).not.toHaveBeenCalled(); expect(f.broker.revoke).not.toHaveBeenCalled();
      expect(await f.recovery.read()).toEqual(retained);
      if (failure === "sql-ack") {
        const [saved] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
        expect(saved).toMatchObject({ status: "active", revision: 1 });
        expect(saved.accessSecretId).toBe(f.refs[0].secret.id);
        const material = await secretService(db).resolveUserSecretValue(f.companyId,
          { definitionId: f.refs[0].definitionId!, responsibleUserId: f.actor.userId },
          { consumerType: "system", consumerId: `slack-manager:${f.grant.id}`, actorType: "user", actorId: f.actor.userId, responsibleUserId: f.actor.userId });
        expect(material?.value).toBe("replacement-access");
      }
    });
  }
  it.each(["permission", "endpoint-generation"])("rechecks %s after durable begin before claim dispatch", async change => {
    const f = await fixture(); const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to).endsWith(`${f.originalEndpoint.id}.json`)) {
        if (change === "permission") permissions.allowed = false;
        else await db.update(chatEndpoints).set({ setup: { ...f.originalEndpoint.setup, runtimeGeneration: 1 } }).where(eq(chatEndpoints.id, f.originalEndpoint.id));
      }
    });
    await f.service.complete(f.state, "original-claim", null, f.actor).catch(() => undefined);
    expect(f.claim).not.toHaveBeenCalled();
    expect(await f.recovery.read()).toMatchObject({ kind: "manager-claim-intent" });
  });
  for (const operation of ["token", "request", "authorize"] as const) {
    it(`refuses queued ${operation} when a claim becomes occupied before company lock admission`, async () => {
      const f = await fixture(); f.mode.failure = "transport";
      // This resource is created outside the held lock's ALS context, so the
      // queued call cannot inherit its reentrant ownership capability.
      const external = new AsyncResource("independent-manager-request");
      let queued!: Promise<{ value?: unknown; error?: unknown }>;
      try {
        await withAccountHomeSecretMutationLock(undefined, f.companyId, async () => {
          let reached!: () => void;
          const atLock = new Promise<void>((resolve) => { reached = resolve; });
          lockProbe.entered = reached;
          queued = external.runInAsyncScope(() => {
            const task = operation === "token" ? f.service.token(f.grant.id, f.companyId, f.actor)
              : operation === "request" ? f.service.request(f.grant.id, f.companyId, f.actor, "apps.managedInstall", { app_id: "AFIXTURE" })
              : f.service.authorize(f.originalEndpoint.id, f.actor);
            return task.then(value => ({ value }), error => ({ error }));
          });
          await atLock;
          lockProbe.entered = null;
          await f.service.complete(f.state, "original-claim", null, f.actor).catch(() => undefined);
          expect(await f.recovery.read()).toMatchObject({ kind: "manager-claim-intent" });
          f.broker.getSlackManagerAppId.mockClear(); f.broker.startAuthorization.mockClear();
        });
        const result = await queued;
        expect(result).toHaveProperty("error");
        expect(result).not.toHaveProperty("value");
        expect(f.broker.getSlackManagerAppId).not.toHaveBeenCalled();
        expect(f.broker.startAuthorization).not.toHaveBeenCalled();
        expect(f.broker.refresh).not.toHaveBeenCalled(); expect(f.api).not.toHaveBeenCalled();
        expect(f.claim).toHaveBeenCalledOnce();
      } finally { lockProbe.entered = null; external.emitDestroy(); }
    });
  }
  it("serializes an external queued token without joining it from the company-lock-owning request", async () => {
    const f = await fixture();
    const requestContext = new AsyncResource("independent-manager-api"), tokenContext = new AsyncResource("independent-manager-token");
    let requestTask!: Promise<{ value?: unknown; error?: unknown }>, tokenTask!: Promise<{ value?: unknown; error?: unknown }>;
    let releaseToken!: () => void, cancelToken!: (error: Error) => void;
    const tokenGate = new Promise<void>((resolve, reject) => { releaseToken = resolve; cancelToken = reject; });
    let completedRequest = false;
    try {
      await withAccountHomeSecretMutationLock(undefined, f.companyId, async () => {
        let requestReached!: () => void;
        const requestAtLock = new Promise<void>((resolve) => { requestReached = resolve; });
        lockProbe.entered = requestReached;
        requestTask = requestContext.runInAsyncScope(() => f.service.request(f.grant.id, f.companyId, f.actor, "apps.managedInstall", { app_id: "AFIXTURE" }).then(value => ({ value }), error => ({ error })));
        await requestAtLock;
        let tokenReached!: () => void;
        const tokenAtLock = new Promise<void>((resolve) => { tokenReached = resolve; });
        lockProbe.entered = tokenReached; lockProbe.pause = tokenGate;
        tokenTask = tokenContext.runInAsyncScope(() => f.service.token(f.grant.id, f.companyId, f.actor).then(value => ({ value }), error => ({ error })));
        await tokenAtLock;
        // The request is queued first; the external token's actual lock entry
        // remains gated. Its promise must not be joined by that owning request.
        lockProbe.entered = null; lockProbe.pause = null;
      });
      await vi.waitFor(() => expect(f.api).toHaveBeenCalledOnce(), { timeout: 2000 });
      expect(await requestTask).toEqual({ value: { ok: true } });
      completedRequest = true; releaseToken();
      expect(await tokenTask).toMatchObject({ value: { token: "original-access" } });
      expect(f.broker.refresh).not.toHaveBeenCalled(); expect(f.claim).not.toHaveBeenCalled();
    } finally {
      lockProbe.entered = null; lockProbe.pause = null;
      // If the regression returns, reject only our test admission gate. This
      // releases an old map-based cycle without pretending a real task settled.
      if (completedRequest) releaseToken(); else cancelToken(new Error("fixture admission gate canceled after failed progress assertion"));
      await Promise.allSettled([requestTask, tokenTask].filter(Boolean));
      requestContext.emitDestroy(); tokenContext.emitDestroy();
    }
  });
  it("preserves acknowledged endpoint finalization when cleanup unlink flush fails", async () => {
    const f = await fixture(); const remove = fs.rm.bind(fs), open = fs.open.bind(fs);
    const directory = path.dirname((await import("./manager-claim-recovery.js")).managerClaimRecoveryPath(f.companyId, f.originalEndpoint.id));
    let unlinked = false, failFlush = true;
    const cleanupFailure = new Error("original cleanup directory flush failed");
    vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
      await remove(...args);
      if (String(args[0]).endsWith(`${f.originalEndpoint.id}.json`)) unlinked = true;
    });
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (unlinked && failFlush && String(args[0]) === directory) handle.sync = async () => { throw cleanupFailure; };
      return handle;
    });
    await expect(f.service.complete(f.state, "original-claim", null, f.actor)).rejects.toMatchObject({ code: "slack_manager_claim_recovery_pending", cause: cleanupFailure });
    expect(unlinked).toBe(true); expect(f.claim).toHaveBeenCalledOnce();
    const [saved] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
    expect(saved).toMatchObject({ status: "active", revision: 1 });
    const [finalized] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.originalEndpoint.id));
    expect(finalized.setup.slackManagerError).toBeUndefined();
    await expect(f.recovery.read()).rejects.toThrow("original cleanup directory flush failed");
    f.broker.getSlackManagerAppId.mockClear();
    await expect(f.service.token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.broker.getSlackManagerAppId).not.toHaveBeenCalled(); expect(f.broker.refresh).not.toHaveBeenCalled();
    failFlush = false;
    expect(await f.recovery.read()).toBeNull();
    expect(f.claim).toHaveBeenCalledOnce();
  });
  it("blocks original credential deletion while a claim intent remains occupied", async () => {
    const f = await fixture(); f.mode.failure = "transport";
    await f.service.complete(f.state, "original-claim", null, f.actor).catch(() => undefined);
    await expect(secretService(db).remove(f.refs[0].secret.id)).rejects.toMatchObject({ status: 409 });
    expect(await secretService(db).getById(f.refs[0].secret.id)).not.toBeNull();
    expect(await f.recovery.read()).toMatchObject({ kind: "manager-claim-intent" });
  });
});
