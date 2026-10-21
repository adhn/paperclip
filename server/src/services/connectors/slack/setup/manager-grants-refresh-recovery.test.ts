import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, chatSlackManagerGrants, createDb } from "@paperclipai/db";
import { SLACK_MANAGER_SCOPES } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../../__tests__/helpers/embedded-postgres.js";
import { writeConnectionCredential } from "../../../connection-credentials.js";
import { createSlackManagerGrants } from "./manager-grants.js";
import { managerRefreshRecovery } from "./manager-refresh-recovery.js";
import type { SlackRegistrationStore } from "./registration.js";
import type { ConnectorRecoveryAuthority } from "../../../connector-recovery-authority.js";
import type { ConnectorRawResponseObserver } from "../../../paperclip-cloud-connector.js";
const permissions = vi.hoisted(() => ({ allowed: true }));
vi.mock("../../../access.js", () => ({ accessService: () => ({ hasPermission: async () => permissions.allowed }) }));
vi.mock("../../../instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableChatConnectors: true }), getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("actual manager refresh original recovery", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let root: string;
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-refresh-sql-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key"); process.env.PAPERCLIP_HOME = root;
    if (externalUrl) db = createDb(externalUrl);
    else { database = await startEmbeddedPostgresTestDatabase("manager-refresh-sql-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterEach(() => { vi.restoreAllMocks(); permissions.allowed = true; });
  afterAll(async () => {
    await database?.cleanup();
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const companyId = randomUUID(), actor = { userId: `owner-${randomUUID()}`, sessionId: "fixture", bypassPermissionCheck: true };
    await db.insert(companies).values({ id: companyId, name: "Refresh original", issuePrefix: `R${companyId.slice(0, 7)}` });
    const refs = [];
    for (const key of ["access", "refresh"]) refs.push(await writeConnectionCredential(db, { companyId, ownerUserId: actor.userId, actor: { userId: actor.userId }, connectionName: "Refresh", configPath: key, label: key, definitionKey: `refresh.${randomUUID()}`, value: `original-${key}` }));
    const [grant] = await db.insert(chatSlackManagerGrants).values({ companyId, userId: actor.userId, slackUserId: "UORIGINAL", workspaceId: "TORIGINAL", workspaceName: "Original", managerAppId: "AMANAGER", accessSecretId: refs[0].secret.id, refreshSecretId: refs[1].secret.id, expiresAt: new Date(Date.now() - 1000) }).returning();
    const credentials = { v: 1 as const, provider: "slack" as const, profile: "slack.manager", instanceId: "fixture", environment: "staging" as const, subject: actor.userId, companyId,
      accessToken: "replacement-access", refreshToken: "replacement-refresh", tokenType: "user", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshTokenExpiresAt: null, scopes: [...SLACK_MANAGER_SCOPES] };
    const state = { decodeFails: false };
    const refresh = vi.fn(async (_input: unknown, observe?: ConnectorRawResponseObserver) => {
      const [denied] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, grant.id));
      expect(denied).toMatchObject({ status: "reauthorize", revision: 1 });
      expect(await managerRefreshRecovery(companyId, grant.id).read()).toMatchObject({ kind: "manager-refresh-intent" });
      await observe?.({ status: 200, headers: {}, bodyBase64: Buffer.from('{"sealed":"original"}').toString("base64") });
      expect(await managerRefreshRecovery(companyId, grant.id).read()).toMatchObject({ kind: "manager-refresh-raw" });
      if (state.decodeFails) throw new Error("sealed decode failed after original response");
      return credentials;
    });
    const broker = { recoveryAuthority: { schema: 1, kind: "hosted-sealed", baseUrl: "https://broker.fixture.invalid", instanceId: "fixture", environment: "staging", signingKeySha256: "c".repeat(64), sealingKeySha256: "d".repeat(64) } as ConnectorRecoveryAuthority | undefined, authorizationMode: "claim" as "claim" | "code", getSlackManagerAppId: vi.fn(async () => "AMANAGER"), refresh };
    const managed = { enabled: true, broker };
    const makeService = () => createSlackManagerGrants({ db, origin: (value: string) => value, options: { managed, publicOrigin: () => "https://fixture.invalid", webhookOrigin: () => "https://fixture.invalid" } } as unknown as SlackRegistrationStore);
    return { companyId, actor, refs, grant, state, refresh, broker, makeService, credentials, managed };
  }
  it("refuses missing local client authority before any fresh broker probe or SQL claim", async () => {
    const f = await fixture(); f.broker.recoveryAuthority = undefined;
    const sql = vi.spyOn(db, "transaction");
    await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled(); expect(f.broker.getSlackManagerAppId).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
  });
  for (const stage of ["begin", "claim"] as const) {
    it(`refuses provider dispatch after ${stage} failure and retains original uncertainty`, async () => {
      const f = await fixture();
      if (stage === "begin") {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to).endsWith(`${f.grant.id}.json`)) throw new Error("intent publication failed"); return rename(from, to); });
      } else {
        const transaction = db.transaction.bind(db); let calls = 0;
        vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => {
          calls += 1;
          return calls === 2 ? transaction(async tx => { await action(tx); throw new Error("claim rollback"); }) : transaction(action);
        }) as typeof db.transaction);
      }
      await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
      expect(f.refresh).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
      expect(f.refresh).not.toHaveBeenCalled();
    });
  }
  it("refuses refresh dispatch if access is lost after the durable deny claim", async () => {
    const f = await fixture(); const transaction = db.transaction.bind(db); let calls = 0;
    vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => {
      calls += 1; const claimed = calls === 2;
      return (async () => { const result = await transaction(action); if (claimed) permissions.allowed = false; return result; })();
    }) as typeof db.transaction);
    await expect(f.makeService().token(f.grant.id, f.companyId, { ...f.actor, bypassPermissionCheck: false })).rejects.toMatchObject({ status: 403 });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(await managerRefreshRecovery(f.companyId, f.grant.id).read()).toMatchObject({ kind: "manager-refresh-intent" });
    const [held] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
    expect(held).toMatchObject({ status: "reauthorize", revision: 1 });
  });
  it("holds raw output on decode failure and never redispatches refresh", async () => {
    const f = await fixture(); f.state.decodeFails = true;
    await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow("sealed decode failed");
    expect(await managerRefreshRecovery(f.companyId, f.grant.id).read()).toMatchObject({ kind: "manager-refresh-raw" });
    f.broker.getSlackManagerAppId.mockClear();
    await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.refresh).toHaveBeenCalledOnce(); expect(f.broker.getSlackManagerAppId).not.toHaveBeenCalled();
  });
  for (const lostCommit of [false, true]) {
    it(`${lostCommit ? "holds original result after lost COMMIT reply" : "settles unchanged original predecessor SQL-only after rollback"}`, async () => {
      const f = await fixture(); const transaction = db.transaction.bind(db); let calls = 0;
      vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => {
        calls += 1;
        if (calls !== 3) return transaction(action);
        return (async () => {
          expect(await managerRefreshRecovery(f.companyId, f.grant.id).read()).toMatchObject({ kind: "manager-refresh-result" });
          if (!lostCommit) return transaction(async tx => { await action(tx); throw new Error("SQL result rollback"); });
          await transaction(action); throw new Error("lost COMMIT reply");
        })();
      }) as typeof db.transaction);
      await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
      expect(await managerRefreshRecovery(f.companyId, f.grant.id).read()).toMatchObject({ kind: "manager-refresh-result" });
      vi.restoreAllMocks(); f.broker.getSlackManagerAppId.mockClear();
      if (lostCommit) {
        await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
        expect(await managerRefreshRecovery(f.companyId, f.grant.id).read()).toMatchObject({ kind: "manager-refresh-result" });
      } else {
        expect((await f.makeService().token(f.grant.id, f.companyId, f.actor)).token).toBe("replacement-access");
        expect(await managerRefreshRecovery(f.companyId, f.grant.id).read()).toBeNull();
      }
      expect(f.refresh).toHaveBeenCalledOnce(); expect(f.broker.getSlackManagerAppId).not.toHaveBeenCalled();
      for (const ref of f.refs) {
        const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secret.id)); expect(secret.latestVersion).toBe(2);
      }
    });
  }
  for (const changed of ["mode", "absent", "authority", "missing-authority"] as const) {
    it(`holds retained decoded result when current broker is ${changed} without provider or SQL settlement`, async () => {
      const f = await fixture(); const transaction = db.transaction.bind(db); let calls = 0;
      vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => { calls += 1; return calls === 3 ? Promise.reject(new Error("result SQL failure")) : transaction(action); }) as typeof db.transaction);
      await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
      vi.restoreAllMocks();
      const retained = await managerRefreshRecovery(f.companyId, f.grant.id).read();
      if (changed === "mode") f.broker.authorizationMode = "code";
      else if (changed === "absent") f.managed.enabled = false;
      else if (changed === "missing-authority") f.broker.recoveryAuthority = undefined;
      else f.broker.recoveryAuthority = { kind: "hosted-sealed", schema: 1, baseUrl: "https://changed.fixture.invalid", instanceId: "fixture", environment: "staging", signingKeySha256: "c".repeat(64), sealingKeySha256: "d".repeat(64) };
      f.broker.getSlackManagerAppId.mockClear();
      const sql = vi.spyOn(db, "transaction");
      await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
      expect(f.broker.getSlackManagerAppId).not.toHaveBeenCalled();
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(await managerRefreshRecovery(f.companyId, f.grant.id).read()).toEqual(retained);
    });
  }
  for (const changed of ["mode", "authority"] as const) it(`holds original intent without refresh if broker ${changed} changes after deny claim`, async () => {
    const f = await fixture(); const transaction = db.transaction.bind(db); let calls = 0;
    vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => {
      calls += 1; const claimed = calls === 2;
      return (async () => { const result = await transaction(action); if (claimed) {
        if (changed === "mode") f.broker.authorizationMode = "code";
        else f.broker.recoveryAuthority = { schema: 1, kind: "hosted-sealed", baseUrl: "https://changed.fixture.invalid", instanceId: "fixture", environment: "staging", signingKeySha256: "c".repeat(64), sealingKeySha256: "d".repeat(64) };
      } return result; })();
    }) as typeof db.transaction);
    await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(await managerRefreshRecovery(f.companyId, f.grant.id).read()).toMatchObject({ kind: "manager-refresh-intent", clientMode: "claim" });
  });
  it("refuses changed exact predecessor after retained result without broker replay", async () => {
    const f = await fixture(); const transaction = db.transaction.bind(db); let calls = 0;
    vi.spyOn(db, "transaction").mockImplementation(((action: Parameters<typeof db.transaction>[0]) => { calls += 1; return calls === 3 ? Promise.reject(new Error("result SQL failure")) : transaction(action); }) as typeof db.transaction);
    await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    vi.restoreAllMocks();
    await db.update(companySecrets).set({ providerMetadata: { fixture: "changed-original-authority" } }).where(eq(companySecrets.id, f.refs[0].secret.id));
    await expect(f.makeService().token(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(await managerRefreshRecovery(f.companyId, f.grant.id).read()).toMatchObject({ kind: "manager-refresh-result" });
  });
});
