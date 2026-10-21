import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, companySecretVersions, chatSlackManagerGrants, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../../__tests__/helpers/embedded-postgres.js";
import { writeConnectionCredential } from "../../../connection-credentials.js";
import { secretService } from "../../../secrets.js";
import { createSlackManagerGrants } from "./manager-grants.js";
import { managerRevokeRecovery, managerRevokeRecoveryPath } from "./manager-revoke-recovery.js";
import type { SlackRegistrationStore } from "./registration.js";
import type { ConnectorRawResponseObserver } from "../../../paperclip-cloud-connector.js";
import type { ConnectorRecoveryAuthority } from "../../../connector-recovery-authority.js";
vi.mock("../../../instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableChatConnectors: true }), getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("actual manager revoke original token journals", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined, root: string;
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-revoke-journal-sql-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key"); process.env.PAPERCLIP_HOME = root;
    if (externalUrl) db = createDb(externalUrl); else { database = await startEmbeddedPostgresTestDatabase("manager-revoke-journal-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await database?.cleanup();
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(empty = false) {
    const companyId = randomUUID(), actor = { userId: `revoke-${randomUUID()}`, sessionId: "original-session", bypassPermissionCheck: true };
    await db.insert(companies).values({ id: companyId, name: "Revoke journal", issuePrefix: `R${companyId.slice(0, 7)}` });
    const refs = [];
    if (!empty) for (const role of ["access", "refresh"]) refs.push(await writeConnectionCredential(db, { companyId, ownerUserId: actor.userId, actor: { userId: actor.userId }, connectionName: "Revoke fixture", configPath: role, label: role, definitionKey: `revoke.${randomUUID()}`, value: `fixture-original-${role}` }));
    const [grant] = await db.insert(chatSlackManagerGrants).values({ companyId, userId: actor.userId, slackUserId: "UORIGINAL", workspaceId: "TORIGINAL", workspaceName: "Original", managerAppId: "AMANAGER", accessSecretId: refs[0]?.secret.id ?? null, refreshSecretId: refs[1]?.secret.id ?? null }).returning();
    const recovery = managerRevokeRecovery(companyId, grant.id);
    const mode = { failRole: -1, failAfterRaw: false, afterRaw: null as (() => Promise<void>) | null, authority: { schema: 1, kind: "hosted-sealed", baseUrl: "https://broker.fixture.invalid", instanceId: "fixture", environment: "staging", signingKeySha256: "c".repeat(64), sealingKeySha256: "d".repeat(64) } as ConnectorRecoveryAuthority | undefined };
    const revoke = vi.fn(async (input: { token: string }, observe?: ConnectorRawResponseObserver) => {
      const index = revoke.mock.calls.length - 1, role = index === 0 ? "access" : "refresh";
      const [current] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, grant.id));
      expect(current).toMatchObject({ status: "revoked", revision: grant.revision + 1 });
      const retained = await recovery.read();
      expect(retained).toMatchObject({ kind: "manager-revoke-state", intent: { companyId, grantId: grant.id, originalRevision: grant.revision, deniedRevision: grant.revision + 1 } });
      expect(retained!.intent.access!.identity.secretId).toBe(refs[0].secret.id);
      expect(retained!.intent.refresh!.identity.secretId).toBe(refs[1].secret.id);
      expect(retained!.intent.access!.tokenOperationId).not.toBe(retained!.intent.refresh!.tokenOperationId);
      expect(input.token).toBe(`fixture-original-${role}`);
      if (mode.failRole === index && !mode.failAfterRaw) throw new Error("fixture revoke transport unknown");
      const raw = { status: 204, headers: { "x-original-role": role }, bodyBase64: "" };
      expect(observe).toBeTypeOf("function"); await observe!(raw);
      expect((await recovery.read())!.outcomes[role]).toEqual({ kind: "raw", raw });
      for (const ref of refs) expect((await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secret.id)))[0]).toBeDefined();
      await mode.afterRaw?.();
      if (mode.failRole === index) throw new Error("fixture revoke client response uncertain");
    });
    const broker = { get recoveryAuthority() { return mode.authority; }, revoke, getSlackManagerAppId: vi.fn(async () => "AMANAGER"), refresh: vi.fn(), claim: vi.fn(), startAuthorization: vi.fn() };
    const store = { db, endpoint: vi.fn(), registration: vi.fn(), origin: (value: string) => value,
      options: { managed: { enabled: true, broker }, publicOrigin: () => "https://fixture.invalid", webhookOrigin: () => "https://fixture.invalid" } } as unknown as SlackRegistrationStore;
    const restart = () => createSlackManagerGrants(store), service = restart();
    return { companyId, actor, refs, grant, recovery, mode, revoke, broker, service, restart };
  }
  async function noReplay(f: Awaited<ReturnType<typeof fixture>>) {
    const retained = await f.recovery.read(), calls = f.revoke.mock.calls.length;
    await expect(f.restart().revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.revoke).toHaveBeenCalledTimes(calls); expect(await f.recovery.read()).toEqual(retained);
  }
  it("publishes original intent before SQL deny and refuses dispatch when publication fails", async () => {
    const f = await fixture(), rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to) === managerRevokeRecoveryPath(f.companyId, f.grant.id)) throw new Error("fixture intent publish failed"); return rename(from, to); });
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.revoke).not.toHaveBeenCalled();
    expect((await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id)))[0]).toMatchObject({ status: f.grant.status, revision: f.grant.revision });
  });
  for (const failRole of [0, 1]) for (const failAfterRaw of [false, true]) it(`retains independent outcomes when role ${failRole} fails ${failAfterRaw ? "after raw" : "during transport"}`, async () => {
    const f = await fixture(); f.mode.failRole = failRole; f.mode.failAfterRaw = failAfterRaw;
    const failure = await f.service.revoke(f.grant.id, f.companyId, f.actor).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(failure.cause.errors.some((error: Error) => /fixture revoke/.test(error.message))).toBe(true);
    expect(f.revoke).toHaveBeenCalledTimes(2);
    const entry = (await f.recovery.read())!;
    const failed = failRole === 0 ? "access" : "refresh", other = failRole === 0 ? "refresh" : "access";
    expect(entry.outcomes[failed]).toEqual(failAfterRaw ? expect.objectContaining({ kind: "raw" }) : null);
    expect(entry.outcomes[other]).toMatchObject({ kind: "client-completed", acceptance: "hosted-broker-accepted" });
    for (const ref of f.refs) expect((await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secret.id)))[0]).toMatchObject({ status: "active", latestVersion: 1 });
    await expect(secretService(db).rotate(f.refs[0].secret.id, { value: "must-not-replace" })).rejects.toThrow();
    await expect(secretService(db).remove(f.refs[0].secret.id)).rejects.toThrow();
    await noReplay(f);
  });
  it.each(["rollback", "lost-reply"] as const)("retains prospective intent and dispatches zero after deny %s", async failure => {
    const f = await fixture(), transaction = db.transaction.bind(db); let injected = false;
    vi.spyOn(db, "transaction").mockImplementation(async (work, config) => {
      let denied = false;
      const result = await transaction(async tx => {
        const value = await work(tx);
        const [current] = await tx.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
        if (!injected && current?.status === "revoked") { denied = true; injected = true; if (failure === "rollback") throw new Error("fixture deny rollback"); }
        return value;
      }, config);
      if (denied) throw new Error("fixture deny acknowledgement lost"); return result;
    });
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(injected).toBe(true); expect(f.revoke).not.toHaveBeenCalled();
    expect((await f.recovery.read())!.outcomes).toEqual({ access: null, refresh: null });
    await noReplay(f);
  });
  it("retains both client completions when acknowledged cleanup SQL rolls back", async () => {
    const f = await fixture(), transaction = db.transaction.bind(db); let injected = false;
    vi.spyOn(db, "transaction").mockImplementation((work, config) => transaction(async tx => {
      const value = await work(tx);
      const [current] = await tx.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
      if (!injected && current?.status === "revoked" && current.accessSecretId === null) { injected = true; throw new Error("fixture cleanup rollback"); }
      return value;
    }, config));
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(injected).toBe(true); expect(f.revoke).toHaveBeenCalledTimes(2);
    for (const outcome of Object.values((await f.recovery.read())!.outcomes)) expect(outcome).toMatchObject({ kind: "client-completed" });
    for (const ref of f.refs) expect((await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secret.id)))[0]).toBeDefined();
    await noReplay(f);
  });
  it("retains lost cleanup COMMIT reply even when original refs and secrets are absent", async () => {
    const f = await fixture(), transaction = db.transaction.bind(db); let injected = false;
    vi.spyOn(db, "transaction").mockImplementation(async (work, config) => {
      let cleaned = false;
      const result = await transaction(async tx => { const value = await work(tx); const [current] = await tx.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
        if (!injected && current?.status === "revoked" && current.accessSecretId === null) { injected = true; cleaned = true; } return value; }, config);
      if (cleaned) throw new Error("fixture cleanup acknowledgement lost"); return result;
    });
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(injected).toBe(true);
    expect((await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id)))[0]).toMatchObject({ accessSecretId: null, refreshSecretId: null });
    expect(await f.recovery.read()).not.toBeNull(); await noReplay(f);
  });
  it("deletes exact original secrets only after both durable completions and clears after acknowledged cleanup", async () => {
    const f = await fixture(), transaction = db.transaction.bind(db); let sawCleanup = false;
    vi.spyOn(db, "transaction").mockImplementation((work, config) => transaction(async tx => {
      const value = await work(tx); const [current] = await tx.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
      if (current?.status === "revoked" && current.accessSecretId === null) { sawCleanup = true; for (const outcome of Object.values((await f.recovery.read())!.outcomes)) expect(outcome).toMatchObject({ kind: "client-completed" }); }
      return value;
    }, config));
    await f.service.revoke(f.grant.id, f.companyId, f.actor);
    expect(sawCleanup).toBe(true); expect(f.revoke).toHaveBeenCalledTimes(2); expect(await f.recovery.read()).toBeNull();
    for (const ref of f.refs) { expect(await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secret.id))).toEqual([]); expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, ref.secret.id))).toEqual([]); }
  });
  it("does not dispatch any provider call when original grant has no credential refs", async () => {
    const f = await fixture(true); await f.service.revoke(f.grant.id, f.companyId, f.actor);
    expect(f.revoke).not.toHaveBeenCalled(); expect(await f.recovery.read()).toBeNull();
  });
  it("refuses changed broker authority between original publication and provider dispatch", async () => {
    const f = await fixture(), rename = fs.rename.bind(fs); let changed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!changed && String(to) === managerRevokeRecoveryPath(f.companyId, f.grant.id)) {
        changed = true; f.mode.authority = { ...f.mode.authority!, instanceId: "changed-instance" } as ConnectorRecoveryAuthority;
      }
    });
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(changed).toBe(true); expect(f.revoke).not.toHaveBeenCalled();
    expect((await f.recovery.read())!.outcomes).toEqual({ access: null, refresh: null }); await noReplay(f);
  });
  it("rechecks broker authority before the independent second token", async () => {
    const f = await fixture(); f.mode.afterRaw = async () => { f.mode.authority = { ...f.mode.authority!, instanceId: "changed-instance" } as ConnectorRecoveryAuthority; };
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.revoke).toHaveBeenCalledOnce();
    const entry = (await f.recovery.read())!;
    expect(entry.outcomes.access).toMatchObject({ kind: "client-completed" }); expect(entry.outcomes.refresh).toBeNull(); await noReplay(f);
  });
  it("refuses cleanup after same-value secret version replacement following both provider calls", async () => {
    const f = await fixture(); let replaced = false;
    f.mode.afterRaw = async () => {
      if (f.revoke.mock.calls.length !== 2) return;
      const [version] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, f.refs[0].secret.id));
      await db.insert(companySecretVersions).values({ ...version, id: randomUUID(), version: 2 });
      await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, f.refs[0].secret.id)); replaced = true;
    };
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(replaced).toBe(true); expect(f.revoke).toHaveBeenCalledTimes(2);
    for (const outcome of Object.values((await f.recovery.read())!.outcomes)) expect(outcome).toMatchObject({ kind: "client-completed" });
    expect((await db.select().from(companySecrets).where(eq(companySecrets.id, f.refs[0].secret.id)))[0]).toMatchObject({ latestVersion: 2, status: "active" }); await noReplay(f);
  });
  it("preserves publication uncertainty when raw result persistence fails and refuses restart replay", async () => {
    const f = await fixture(), rename = fs.rename.bind(fs); let publications = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === managerRevokeRecoveryPath(f.companyId, f.grant.id) && ++publications === 2) throw new Error("fixture raw publication failed");
      return rename(from, to);
    });
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.revoke).toHaveBeenCalledTimes(2);
    await expect(f.recovery.read()).rejects.toThrow();
    const calls = f.revoke.mock.calls.length;
    await expect(f.restart().revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.revoke).toHaveBeenCalledTimes(calls);
    for (const ref of f.refs) expect((await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secret.id)))[0]).toBeDefined();
  });

  it("refuses a known development app mismatch before journal or provider submission", async () => {
    const f = await fixture();
    f.mode.authority = { schema: 1, kind: "development-direct-oauth", apiBaseUrl: "https://slack.com/api/", appId: "AOTHER", clientId: "123.456",
      clientSecretSha256: "e".repeat(64), callbackUri: "https://fixture.invalid/callback" };
    Object.assign(f.broker, { authorizationMode: "code" });
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow();
    expect(f.revoke).not.toHaveBeenCalled(); expect(await f.recovery.read()).toBeNull();
    expect((await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id)))[0]).toEqual(f.grant);
  });

  it("refuses a missing broker authority before provider dispatch", async () => {
    const f = await fixture(); f.mode.authority = undefined;
    await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toThrow(); expect(f.revoke).not.toHaveBeenCalled();
  });
});
