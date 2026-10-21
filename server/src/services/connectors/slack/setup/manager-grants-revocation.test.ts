import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, companySecretVersions, chatSlackManagerGrants, toolApplications, toolConnections, toolOauthStates, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../../__tests__/helpers/embedded-postgres.js";
import { writeConnectionCredential } from "../../../connection-credentials.js";
import { secretService } from "../../../secrets.js";
import { SLACK_MANAGER_SCOPES } from "@paperclipai/shared";
import { managerClaimRecovery } from "./manager-claim-recovery.js";
import type { ConnectorRawResponseObserver } from "../../../paperclip-cloud-connector.js";
import { createSlackManagerGrants } from "./manager-grants.js";
import type { SlackRegistrationStore } from "./registration.js";
vi.mock("../../../instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableChatConnectors: true }), getGeneral: async () => ({ censorUsernameInLogs: false }) }) }));
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("actual manager grant revocation retention", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let root: string;
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-revocation-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key"); process.env.PAPERCLIP_HOME = root;
    if (externalUrl) db = createDb(externalUrl);
    else { database = await startEmbeddedPostgresTestDatabase("manager-revocation-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => {
    await database?.cleanup();
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(failureIndex: number | null) {
    const companyId = randomUUID();
    const actor = { userId: `manager-${randomUUID()}`, sessionId: "fixture", bypassPermissionCheck: true };
    await db.insert(companies).values({ id: companyId, name: "Manager retention", issuePrefix: `M${companyId.slice(0, 7)}` });
    const refs = [];
    for (const key of ["access", "refresh"]) {
      refs.push(await writeConnectionCredential(db, { companyId, ownerUserId: actor.userId, actor: { userId: actor.userId }, connectionName: "Manager fixture", configPath: key, label: key, definitionKey: `fixture.${randomUUID()}`, value: `${key}-original-value` }));
    }
    const [grant] = await db.insert(chatSlackManagerGrants).values({ companyId, userId: actor.userId, slackUserId: "UORIGINAL", workspaceId: "TORIGINAL", workspaceName: "Original", managerAppId: "AMANAGER", accessSecretId: refs[0].secret.id, refreshSecretId: refs[1].secret.id }).returning();
    const revoke = vi.fn(async (_input: unknown, observe?: ConnectorRawResponseObserver): Promise<void> => {
      // Independent SQL inspection proves deny committed before provider use.
      const [current] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, grant.id));
      expect(current.status).toBe("revoked");
      expect(observe).toBeTypeOf("function");
      await observe!({ status: 204, headers: {}, bodyBase64: "" });
      if (failureIndex === revoke.mock.calls.length - 1) throw new Error("provider revocation outcome unknown");
    });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Manager fixture", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Manager fixture", uid: randomUUID(), transport: "rest_api" }).returning();
    const endpoint = { id: randomUUID(), companyId, connectionId: connection.id, status: "active", setup: { slackSetupMethod: "managed", runtimeGeneration: 0 } };
    const registration = { managerGrantId: grant.id as string | null, requestId: null, status: "ready" };
    const broker = {
      recoveryAuthority: { schema: 1, kind: "hosted-sealed", baseUrl: "https://broker.fixture.invalid", instanceId: "fixture", environment: "staging", signingKeySha256: "c".repeat(64), sealingKeySha256: "d".repeat(64) },
      revoke, getSlackManagerAppId: vi.fn(async () => "AMANAGER"),
      startAuthorization: vi.fn(async (_input: { returnState: string }) => ({ authorizationUrl: "https://fixture.invalid/authorize" })),
      claim: vi.fn(async (_input: unknown, observe?: ConnectorRawResponseObserver) => {
        expect(await managerClaimRecovery(companyId, endpoint.id).read()).toMatchObject({ kind: "manager-claim-intent" });
        expect(observe).toBeTypeOf("function");
        await observe!({ status: 200, headers: {}, bodyBase64: Buffer.from('{"sealed":"original-response"}').toString("base64") });
        expect(await managerClaimRecovery(companyId, endpoint.id).read()).toMatchObject({ kind: "manager-claim-raw" });
        return { v: 1, provider: "slack", profile: "slack.manager", subject: actor.userId, companyId, instanceId: "fixture", environment: "staging",
          accessToken: "replacement-access", refreshToken: "replacement-refresh", tokenType: "user", scopes: [...SLACK_MANAGER_SCOPES], refreshTokenExpiresAt: null,
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), slackManager: { appId: "AMANAGER", workspaceId: "TORIGINAL", workspaceName: "Original", userId: "UORIGINAL" } };
      }),
    };
    const service = createSlackManagerGrants({ db, endpoint: async () => ({ endpoint, connection }), registration: async () => registration,
      origin: (value: string) => value, options: { managed: { enabled: true, broker }, publicOrigin: () => "https://fixture.invalid", webhookOrigin: () => "https://fixture.invalid", withLock: async (_id: string, work: (lease: { assertOwned(): Promise<void> }) => Promise<unknown>) => work({ assertOwned: async () => {} }) } } as unknown as SlackRegistrationStore);
    return { companyId, actor, refs, grant, revoke, service, broker, endpoint, registration };
  }
  for (const failureIndex of [0, 1]) {
    it(`retains both actual secret values when token ${failureIndex + 1} has an unknown outcome and refuses redispatch`, async () => {
      const f = await fixture(failureIndex);
      await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toMatchObject({ code: "slack_manager_revoke_recovery_pending" });
      const [saved] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
      expect(saved).toMatchObject({ status: "revoked", accessSecretId: f.refs[0].secret.id, refreshSecretId: f.refs[1].secret.id, revision: 1 });
      for (const [index, ref] of f.refs.entries()) {
        const value = await secretService(db).resolveUserSecretValue(f.companyId, { definitionId: ref.definitionId!, responsibleUserId: f.actor.userId }, { consumerType: "system", consumerId: `slack-manager:${f.grant.id}`, actorType: "user", actorId: f.actor.userId, responsibleUserId: f.actor.userId });
        expect(value?.value).toBe(index === 0 ? "access-original-value" : "refresh-original-value");
      }
      expect(f.revoke).toHaveBeenCalledTimes(2);
      f.revoke.mockClear();
      await expect(f.service.revoke(f.grant.id, f.companyId, f.actor)).rejects.toMatchObject({ code: "slack_manager_revoke_recovery_pending" });
      expect(f.revoke).not.toHaveBeenCalled();
    });
  }
  for (const knownGrant of [true, false]) {
    it(`refuses replacement of held credentials ${knownGrant ? "before claim" : "when identity is learned after claim"}`, async () => {
      const f = await fixture(0);
      // Historical denied refs predate the dedicated per-role revoke journal.
      // They must remain protected even when no new-format journal exists.
      await db.update(chatSlackManagerGrants).set({ status: "revoked", revision: 1 }).where(eq(chatSlackManagerGrants.id, f.grant.id));
      if (!knownGrant) f.registration.managerGrantId = null;
      await f.service.authorize(f.endpoint.id, f.actor);
      const state = f.broker.startAuthorization.mock.calls[0][0].returnState;
      if (knownGrant) {
        await expect(f.service.complete(state, "original-claim", null, f.actor)).rejects.toMatchObject({ details: { code: "slack_manager_cleanup_pending" } });
        expect(f.broker.claim).not.toHaveBeenCalled();
        expect(await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).toHaveLength(1);
      } else {
        await expect(f.service.complete(state, "original-claim", null, f.actor)).rejects.toMatchObject({ code: "slack_manager_claim_recovery_pending", cause: { status: 409, details: { code: "slack_manager_cleanup_pending" } } });
        expect(f.broker.claim).toHaveBeenCalledOnce();
        expect(await managerClaimRecovery(f.companyId, f.endpoint.id).read()).toMatchObject({ kind: "manager-claim-result", intent: { originalGrants: [expect.objectContaining({ id: f.grant.id, accessSecretId: f.refs[0].secret.id, refreshSecretId: f.refs[1].secret.id })] } });
        const retained = await managerClaimRecovery(f.companyId, f.endpoint.id).read();
        // The original state was consumed before the independent claim result.
        // Replaying that state is stale, while its retained result stays occupied.
        await expect(f.service.complete(state, "original-claim", null, f.actor)).rejects.toMatchObject({ status: 403 });
        expect(f.broker.claim).toHaveBeenCalledOnce(); expect(await managerClaimRecovery(f.companyId, f.endpoint.id).read()).toEqual(retained);
      }
      const [saved] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
      expect(saved).toMatchObject({ status: "revoked", revision: 1, accessSecretId: f.refs[0].secret.id, refreshSecretId: f.refs[1].secret.id });
      for (const ref of f.refs) {
        const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secret.id));
        expect(secret.status).toBe("active");
        expect(secret.latestVersion).toBe(1);
      }
    });
  }

  it("cleans up and clears original refs only after both provider revocations acknowledge", async () => {
    const f = await fixture(null);
    await f.service.revoke(f.grant.id, f.companyId, f.actor);
    expect(f.revoke).toHaveBeenCalledTimes(2);
    const [saved] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, f.grant.id));
    expect(saved).toMatchObject({ status: "revoked", accessSecretId: null, refreshSecretId: null });
    for (const ref of f.refs) {
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secret.id));
      expect(secret).toBeUndefined();
      expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, ref.secret.id))).toEqual([]);
    }
  });
});
