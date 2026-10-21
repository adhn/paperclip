import { assertNoPendingSetupMessageForActor } from "./setup-message-recovery.js";
import { assertNoPendingRegistrationCleanupForActor } from "./registration-cleanup-recovery.js";
import { assertNoPendingStagedCleanupForActor } from "./staged-cleanup-recovery.js";
import { managedInstallRecovery, managedInstallPending, assertNoPendingManagedInstallForActor, type ManagedInstallIntent } from "./managed-install-recovery.js";
import { managerRevokeRecovery, managerRevokeHash, managerRevokePending, assertNoPendingManagerRevokeForActor, withManagerRevokeCleanup, type ManagerRevokeIntent, type ManagerRevokeRole } from "./manager-revoke-recovery.js";
import { managerClaimRecovery, managerClaimHash, managerClaimPending, assertNoPendingManagerClaimForActor, withManagerClaimSettlement, type ManagerClaimIntent, type ManagerClaimResult } from "./manager-claim-recovery.js";
import { connectorRecoveryAuthoritySchema, sameConnectorRecoveryAuthority } from "../../../connector-recovery-authority.js";
import type { CredentialMutationLeaseGuard } from "../../../chat-credential-mutation-lease.js";
import { readSecretRecoveryIdentity } from "../../../secret-recovery-identity.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { managerRefreshRecovery, managerRefreshHash, managerRefreshPending, assertNoPendingManagerRefreshForActor, assertManagerRefreshSaveAllowed, withManagerRefreshSettlement, type ManagerRefreshIntent, type ManagerRefreshResult } from "./manager-refresh-recovery.js";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, like, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, chatSlackManagerGrants, chatSlackRegistrations, companySecrets, toolOauthStates } from "@paperclipai/db";
import { SLACK_MANAGER_SCOPES, type SlackSetupOptions as SetupChoices } from "@paperclipai/shared";
import { conflict, forbidden } from "../../../../errors.js";
import { getCloudRuntimeIdentity } from "../../../cloud-runtime-identity.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv, type SealedConnectorCredentials } from "../../../paperclip-cloud-connector.js";
import { instanceSettingsService } from "../../../instance-settings.js";
import { accessService } from "../../../access.js";
import { secretService } from "../../../secrets.js";
import { writeConnectionCredential } from "../../../connection-credentials.js";
import { logActivity } from "../../../activity-log.js";
import { object, providerFailure, type SlackRegistrationStore, type SlackSetupActor } from "./registration.js";
import { developmentSlackManager, type SlackManagerClient } from "./development-manager.js";

export const SLACK_MANAGER_STATE_PREFIX = "slack-manager.";
export function createSlackManagerGrants(store: SlackRegistrationStore) {
  const { db, options, endpoint, origin, api } = store;
  type Database = Parameters<typeof secretService>[0];
  function broker(): SlackManagerClient | null {
    if (options.managed) return options.managed.enabled ? options.managed.broker : null;
    if (!getCloudRuntimeIdentity()) {
      const development = developmentSlackManager(() => origin(options.publicOrigin()));
      if (development) return development;
    }
    // Open-source instances never contact a hosted service to discover this path.
    if (!getCloudRuntimeIdentity() || process.env.PAPERCLIP_SLACK_MANAGED_SETUP_ENABLED !== "true") return null;
    const config = paperclipCloudConnectorConfigFromEnv();
    return config ? createPaperclipCloudConnector({ config }) : null;
  }
  async function access(companyId: string, actor: SlackSetupActor, database: Database = db) {
    if (!(await instanceSettingsService(database as typeof db).getExperimental()).enableChatConnectors) throw forbidden("Chat connectors are disabled");
    if (!actor.bypassPermissionCheck && !await accessService(database as typeof db).hasPermission(companyId, "user", actor.userId, "tools:manage_connections")) throw forbidden("Missing permission: tools:manage_connections");
  }
  // Deployment intent is stable across broker outages and preview rollbacks.
  // A missing live profile pauses managed setup; it must not select token entry.
  function defaultMethod(): "managed" | "automatic" { return broker() ? "managed" : "automatic"; }
  async function available() {
    const client = broker();
    if (!client || !(await instanceSettingsService(db).getExperimental()).enableChatConnectors) return false;
    try { origin(options.publicOrigin()); origin(options.webhookOrigin()); return Boolean(await client.getSlackManagerAppId()); }
    catch { return false; }
  }
  async function requiredBroker() {
    if (!await available()) throw providerFailure("slack_managed_unavailable");
    return broker()!;
  }
  async function choices(companyId: string, actor: SlackSetupActor): Promise<SetupChoices> {
    await access(companyId, actor);
    const managedAvailable = await available();
    const managerAppId = managedAvailable ? await broker()!.getSlackManagerAppId() : null;
    const grants = managedAvailable && managerAppId ? await db.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.companyId, companyId), eq(chatSlackManagerGrants.userId, actor.userId), eq(chatSlackManagerGrants.status, "active"), eq(chatSlackManagerGrants.managerAppId, managerAppId))) : [];
    return { managedAvailable, defaultMethod: defaultMethod(), workspaces: grants.map(g => ({ grantId: g.id, workspaceId: g.workspaceId, workspaceName: g.workspaceName, userId: g.slackUserId })) };
  }
  const callbackUri = () => `${origin(options.publicOrigin())}/api/chat-slack/managed/oauth/callback`;
  async function authorize(endpointId: string, actor: SlackSetupActor) {
    const authorizedEndpoint = await endpoint(endpointId, actor);
    await assertNoPendingManagerClaimForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
    await assertNoPendingSetupMessageForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
    await assertNoPendingRegistrationCleanupForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
    await assertNoPendingStagedCleanupForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
    await assertNoPendingManagedInstallForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
    await assertNoPendingManagerRevokeForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
    return options.withLock(endpointId, lease => withAccountHomeSecretMutationLock(undefined, authorizedEndpoint.endpoint.companyId, async () => {
      await assertNoPendingManagerClaimForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
      await assertNoPendingSetupMessageForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
      await assertNoPendingRegistrationCleanupForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
      await assertNoPendingStagedCleanupForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
      await assertNoPendingManagedInstallForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
      await assertNoPendingManagerRevokeForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
      await assertNoPendingManagerRefreshForActor(authorizedEndpoint.endpoint.companyId, actor.userId);
      const client = await requiredBroker();
      const current = await endpoint(endpointId, actor);
      if (current.endpoint.setup.slackSetupMethod !== "managed") throw conflict("Resume the selected Slack setup method");
      const row = await store.registration(endpointId);
      const revisions = await db.select({ id: chatSlackManagerGrants.id, revision: chatSlackManagerGrants.revision }).from(chatSlackManagerGrants)
        .where(and(eq(chatSlackManagerGrants.companyId, current.endpoint.companyId), eq(chatSlackManagerGrants.userId, actor.userId)));
      const state = `${SLACK_MANAGER_STATE_PREFIX}${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      await lease.assertOwned();
      await db.insert(toolOauthStates).values({ state, companyId: current.endpoint.companyId, connectionId: current.connection.id,
        codeVerifier: JSON.stringify({ endpointId, revisions, authorizationMode: client.authorizationMode ?? "claim", requestId: row?.requestId ?? null, callbackUri: callbackUri(), webhookOrigin: origin(options.webhookOrigin()), runtimeGeneration: object(current.endpoint.setup).runtimeGeneration ?? 0 }),
        createdByActorType: "user", createdByActorId: actor.userId, createdBySessionId: actor.sessionId, requestedScopes: [...SLACK_MANAGER_SCOPES], expiresAt });
      try { return await client.startAuthorization({ profile: "slack.manager", subject: actor.userId, companyId: current.endpoint.companyId, returnUri: callbackUri(), returnState: state }); }
      catch { await db.delete(toolOauthStates).where(eq(toolOauthStates.state, state)); throw providerFailure("slack_manager_reauthorize"); }
    }));
  }
  async function pending(state: string, actor: SlackSetupActor, allowExpired = false) {
    if (!/^slack-manager\.[A-Za-z0-9_-]{43}$/.test(state)) throw forbidden("Invalid Slack authorization state");
    const [attempt] = await db.select().from(toolOauthStates).where(and(eq(toolOauthStates.state, state), ...(allowExpired ? [] : [gt(toolOauthStates.expiresAt, new Date())])));
    if (!attempt || attempt.createdByActorId !== actor.userId || attempt.createdBySessionId !== actor.sessionId) throw forbidden("Slack authorization expired or belongs to another session");
    const binding = object(JSON.parse(attempt.codeVerifier));
    const current = await endpoint(String(binding.endpointId), actor);
    const row = await store.registration(current.endpoint.id);
    await assertNoPendingManagerClaimForActor(current.endpoint.companyId, actor.userId);
    await assertNoPendingSetupMessageForActor(current.endpoint.companyId, actor.userId);
    await assertNoPendingRegistrationCleanupForActor(current.endpoint.companyId, actor.userId);
    await assertNoPendingStagedCleanupForActor(current.endpoint.companyId, actor.userId);
    await assertNoPendingManagedInstallForActor(current.endpoint.companyId, actor.userId);
    await assertNoPendingManagerRevokeForActor(current.endpoint.companyId, actor.userId);
    if (current.endpoint.setup.slackSetupMethod !== "managed" || current.connection.id !== attempt.connectionId || current.endpoint.companyId !== attempt.companyId
      || ["paused", "revoked"].includes(current.endpoint.status) || row?.status === "removed"
      || (binding.authorizationMode ?? "claim") !== (broker()?.authorizationMode ?? "claim")
      || (row?.requestId ?? null) !== binding.requestId || binding.callbackUri !== callbackUri() || binding.webhookOrigin !== origin(options.webhookOrigin())
      || binding.runtimeGeneration !== (object(current.endpoint.setup).runtimeGeneration ?? 0)) throw conflict("Slack setup changed. Resume authorization.");
    return { attempt, current, row, binding };
  }
  async function expiredReturn(state: string, actor: SlackSetupActor) {
    const { current, attempt } = await pending(state, actor, true);
    if (attempt.expiresAt.getTime() > Date.now()) return null;
    return options.withLock(current.endpoint.id, async lease => {
      const latest = await pending(state, actor, true);
      await lease.assertOwned();
      await db.delete(toolOauthStates).where(eq(toolOauthStates.state, state));
      await db.update(chatEndpoints).set({ setup: { ...latest.current.endpoint.setup, slackManagerError: "slack_install_expired" } }).where(eq(chatEndpoints.id, current.endpoint.id));
      return current.endpoint.id;
    });
  }
  const normalizedClaim = (value: unknown) => JSON.parse(JSON.stringify(value));
  const exactClaim = (left: unknown, right: unknown) => {
    const encode = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    return encode(left) === encode(right);
  };
  async function claimSnapshot(companyId: string, actor: SlackSetupActor, database: Database = db) {
    const grants = await database.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.companyId, companyId), eq(chatSlackManagerGrants.userId, actor.userId))).orderBy(chatSlackManagerGrants.id);
    const secrets: ManagerClaimIntent["originalSecrets"] = {};
    for (const grant of grants) for (const id of [grant.accessSecretId, grant.refreshSecretId]) if (id && !secrets[id]) {
      secrets[id] = { identity: await readSecretRecoveryIdentity(database as typeof db, companyId, id), valueHash: managerClaimHash(await secret(grant, id, database)) };
    }
    return { grants: normalizedClaim(grants), secrets };
  }
  async function assertClaimPredecessor(intent: ManagerClaimIntent, actor: SlackSetupActor) {
    const current = await endpoint(intent.endpointId, actor);
    const registration = await store.registration(intent.endpointId);
    const captured = await claimSnapshot(intent.companyId, actor);
    if (!exactClaim(normalizedClaim(current.endpoint), intent.originalEndpoint) || !exactClaim(normalizedClaim(current.connection), intent.originalConnection) ||
        !exactClaim(normalizedClaim(registration ?? null), intent.originalRegistration) || !exactClaim(captured.grants, intent.originalGrants) || !exactClaim(captured.secrets, intent.originalSecrets)) throw managerClaimPending();
    await access(intent.companyId, actor);
    const currentClient = broker();
    if (!currentClient || !sameConnectorRecoveryAuthority(currentClient.recoveryAuthority, intent.originalClientAuthority)) throw managerClaimPending();
  }
  async function complete(state: string, claimId: string | null, error: string | null, actor: SlackSetupActor, authorizationCode: string | null = null) {
    const before = await pending(state, actor);
    return options.withLock(before.current.endpoint.id, lease => withAccountHomeSecretMutationLock(undefined, before.current.endpoint.companyId, async () => {
      await assertNoPendingManagerRefreshForActor(before.current.endpoint.companyId, actor.userId);
      return completeLocked(state, claimId, error, actor, authorizationCode, lease);
    }));
  }
  async function completeLocked(state: string, claimId: string | null, error: string | null, actor: SlackSetupActor, authorizationCode: string | null, lease: CredentialMutationLeaseGuard) {
    const client = await requiredBroker();
    claimId = client.authorizationMode === "code" ? authorizationCode : claimId;
    {
      const { current, row, binding, attempt } = await pending(state, actor);
      if (row?.managerGrantId) {
        const original = await get(row.managerGrantId, current.endpoint.companyId, actor);
        if (original.status === "revoked" && (original.accessSecretId || original.refreshSecretId)) {
          throw conflict("Slack manager credential cleanup remains pending", { code: "slack_manager_cleanup_pending" });
        }
      }
      const recovery = managerClaimRecovery(current.endpoint.companyId, current.endpoint.id);
      let intent: ManagerClaimIntent | undefined;
      let retainedResult: ManagerClaimResult | undefined;
      let savingClaim = false;
      if (!error && claimId && claimId.length <= 4096) {
        const managerAppId = await client.getSlackManagerAppId();
        const originalClientAuthority = connectorRecoveryAuthoritySchema.parse(client.recoveryAuthority);
        const captured = await claimSnapshot(current.endpoint.companyId, actor);
        intent = { schema: 1, kind: "manager-claim-intent", family: client.authorizationMode === "code" ? "slack.manager.oauth.development" : "slack.manager.claim.hosted", clientMode: client.authorizationMode ?? "claim",
          operationId: randomUUID(), redemptionId: randomUUID(), companyId: current.endpoint.companyId, endpointId: current.endpoint.id, actorUserId: actor.userId, actorSessionId: actor.sessionId ?? null,
          managerAppId, stateHash: managerClaimHash(state), codeHash: managerClaimHash(claimId), originalEndpoint: normalizedClaim(current.endpoint), originalConnection: normalizedClaim(current.connection),
          originalRegistration: normalizedClaim(row ?? null), originalOauthState: normalizedClaim(attempt), originalGrants: captured.grants, originalSecrets: captured.secrets, originalClientAuthority };
        await lease.assertOwned();
        await recovery.begin(intent);
      }
      await lease.assertOwned();
      const [claimed] = await db.delete(toolOauthStates).where(and(eq(toolOauthStates.state, state), gt(toolOauthStates.expiresAt, new Date()))).returning();
      if (!claimed) throw conflict("Slack authorization was already used");
      async function outcome(code: string | null) {
        await lease.assertOwned();
        const latest = await endpoint(current.endpoint.id, actor);
        await db.update(chatEndpoints).set({ setup: { ...latest.endpoint.setup, slackManagerError: code ?? undefined } }).where(eq(chatEndpoints.id, current.endpoint.id));
        if (code) await logActivity(db, { companyId: current.endpoint.companyId, actorType: "user", actorId: actor.userId, action: "chat_slack.manager_authorization_failed", entityType: "chat_endpoint", entityId: current.endpoint.id, details: { code } });
        return current.endpoint.id;
      }
      if (error || !claimId || claimId.length > 4096) return outcome(error === "access_denied" ? "slack_install_declined" : "slack_manager_reauthorize");
      try {
      if (!intent || !exactClaim(normalizedClaim(claimed), intent.originalOauthState)) throw managerClaimPending();
      await assertClaimPredecessor(intent, actor);
      await lease.assertOwned();
      if (!sameConnectorRecoveryAuthority(client.recoveryAuthority, intent.originalClientAuthority)) throw managerClaimPending();
      let raw: import("../../../paperclip-cloud-connector.js").ConnectorRawResponse | undefined;
      const grant = await client.claim({ profile: "slack.manager", subject: actor.userId, companyId: current.endpoint.companyId, claimId, redemptionId: intent.redemptionId }, async response => {
        await recovery.recordRaw({ intent: intent!, raw: response }); raw = response;
      });
      if (!raw) throw managerClaimPending();
      retainedResult = await recovery.recordResult({ intent, raw, credentials: grant });
      const identity = grant.slackManager;
      if (!identity || identity.appId !== intent.managerAppId || !/^A[A-Z0-9]+$/.test(identity.appId) || !/^T[A-Z0-9]+$/.test(identity.workspaceId) || !/^[UW][A-Z0-9]+$/.test(identity.userId) || typeof identity.workspaceName !== "string" || !identity.workspaceName || identity.workspaceName.length > 255) throw providerFailure("slack_manager_reauthorize");
      if (row?.managerGrantId) {
        const existing = await get(row.managerGrantId, current.endpoint.companyId, actor);
        if (existing.managerAppId !== identity.appId || existing.workspaceId !== identity.workspaceId || existing.slackUserId !== identity.userId) throw providerFailure("slack_install_identity_mismatch");
      }
      await endpoint(current.endpoint.id, actor);
      await access(current.endpoint.companyId, actor);
      await assertClaimPredecessor(intent, actor);
      savingClaim = true;
      await withManagerClaimSettlement(retainedResult, () => db.transaction(async tx => {
        await lease.assertOwned(tx);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager:${current.endpoint.companyId}:${actor.userId}:${identity.appId}:${identity.workspaceId}`}, 0))`);
        const [existing] = await tx.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.companyId, current.endpoint.companyId), eq(chatSlackManagerGrants.userId, actor.userId), eq(chatSlackManagerGrants.managerAppId, identity.appId), eq(chatSlackManagerGrants.workspaceId, identity.workspaceId)));
        if (existing) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${existing.id}`}, 0))`);
          const [latest] = await tx.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, existing.id));
          const revision = Array.isArray(binding.revisions) ? binding.revisions.map(object).find(value => value.id === existing.id)?.revision : undefined;
          if (!latest || latest.revision !== revision) throw conflict("Workspace authorization changed. Start again.");
        }
        const original = await claimSnapshot(intent!.companyId, actor, tx);
        if (!exactClaim(original.grants, intent!.originalGrants) || !exactClaim(original.secrets, intent!.originalSecrets)) throw managerClaimPending();
        const [saved] = await tx.insert(chatSlackManagerGrants).values({ companyId: current.endpoint.companyId, userId: actor.userId, slackUserId: identity.userId, workspaceId: identity.workspaceId, workspaceName: identity.workspaceName, managerAppId: identity.appId })
          .onConflictDoUpdate({ target: [chatSlackManagerGrants.companyId, chatSlackManagerGrants.userId, chatSlackManagerGrants.managerAppId, chatSlackManagerGrants.workspaceId], set: { updatedAt: new Date() } }).returning();
        // A reauthorization must never change which Slack person this grant represents.
        if (saved.slackUserId !== identity.userId) throw conflict("Reconnect using the original Slack account");
        await access(current.endpoint.companyId, actor, tx);
        await save(tx, saved, grant, actor);
        if (row?.managerGrantId === saved.id) {
          await tx.update(chatSlackRegistrations).set({ errorCode: null, updatedAt: new Date() })
            .where(and(eq(chatSlackRegistrations.endpointId, current.endpoint.id), eq(chatSlackRegistrations.managerGrantId, saved.id), eq(chatSlackRegistrations.errorCode, "slack_manager_reauthorize")));
        }
      }));
      await logActivity(db, { companyId: current.endpoint.companyId, actorType: "user", actorId: actor.userId, action: "chat_slack.manager_authorized", entityType: "chat_endpoint", entityId: current.endpoint.id, details: { workspaceId: identity.workspaceId, managerAppId: identity.appId } });
      const finalized = await outcome(null);
      await recovery.clear(retainedResult);
      return finalized;
      } catch (error) {
        // Once settlement starts, SQL acknowledgement/reporting/cleanup may be
        // uncertain. Keep original evidence and never rewrite known saved state.
        if (savingClaim) throw Object.assign(managerClaimPending(), { cause: error });
        return outcome("slack_manager_reauthorize");
      }
    }
  }
  type Grant = typeof chatSlackManagerGrants.$inferSelect;
  async function get(id: string, companyId: string, actor: SlackSetupActor) {
    await access(companyId, actor);
    return readGrant(db, id, companyId, actor);
  }
  async function readGrant(database: Database, id: string, companyId: string, actor: SlackSetupActor) {
    await access(companyId, actor, database);
    const [grant] = await database.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.id, id), eq(chatSlackManagerGrants.companyId, companyId), eq(chatSlackManagerGrants.userId, actor.userId)));
    if (!grant) throw forbidden("This Slack workspace authorization belongs to another account");
    return grant;
  }
  async function save(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], row: Grant, credentials: SealedConnectorCredentials, actor: SlackSetupActor) {
    await assertManagerRefreshSaveAllowed(row.companyId, row.userId, row.id, credentials);
    if (row.status === "revoked" && (row.accessSecretId || row.refreshSecretId)) {
      throw conflict("Slack manager credential cleanup remains pending", { code: "slack_manager_cleanup_pending" });
    }
    if (credentials.tokenType !== "user" || !credentials.accessToken || !credentials.refreshToken || !credentials.accessTokenExpiresAt || !Number.isFinite(Date.parse(credentials.accessTokenExpiresAt)) || Date.parse(credentials.accessTokenExpiresAt) <= Date.now() || credentials.provider !== "slack" || credentials.profile !== "slack.manager" || credentials.subject !== row.userId || credentials.companyId !== row.companyId || SLACK_MANAGER_SCOPES.some(scope => !credentials.scopes.includes(scope))) throw providerFailure("slack_manager_reauthorize");
    const write = (key: string, value: string, secretId: string | null) => writeConnectionCredential(tx, { companyId: row.companyId, ownerUserId: row.userId, actor: { userId: actor.userId }, connectionName: "Slack workspace management", configPath: `slack_manager.${key}`, definitionKey: `slack_manager.${row.id}.${key}`, label: key, value, ...(secretId ? { existingRef: { secretId, configPath: `slack_manager.${key}` } } : {}) });
    const accessToken = await write("access_token", credentials.accessToken, row.accessSecretId);
    const refreshToken = credentials.refreshToken ? await write("refresh_token", credentials.refreshToken, row.refreshSecretId) : null;
    await tx.update(chatSlackManagerGrants).set({ accessSecretId: accessToken.secret.id, refreshSecretId: refreshToken?.secret.id ?? row.refreshSecretId, expiresAt: credentials.accessTokenExpiresAt ? new Date(credentials.accessTokenExpiresAt) : null, status: "active", revision: row.revision + 1, updatedAt: new Date() }).where(eq(chatSlackManagerGrants.id, row.id));
  }
  async function secret(row: Grant, id: string | null, database: Database = db) {
    if (!id) throw providerFailure("slack_manager_reauthorize");
    const [ref] = await database.select().from(companySecrets).where(and(eq(companySecrets.id, id), eq(companySecrets.companyId, row.companyId), eq(companySecrets.scope, "user"), eq(companySecrets.ownerUserId, row.userId)));
    if (!ref?.userSecretDefinitionId) throw providerFailure("slack_manager_reauthorize");
    // Owner-scoped system consumer; the durable grant is its authority, not a tool binding.
    const value = await secretService(database).resolveUserSecretValue(row.companyId, { definitionId: ref.userSecretDefinitionId, responsibleUserId: row.userId }, { consumerType: "system", consumerId: `slack-manager:${row.id}`, actorType: "user", actorId: row.userId, responsibleUserId: row.userId });
    if (!value) throw providerFailure("slack_manager_reauthorize");
    return value.value;
  }
  async function snapshot(row: Grant, database: Database) {
    if (!row.accessSecretId || !row.refreshSecretId) throw managerRefreshPending();
    const refs = await database.select().from(companySecrets).where(and(eq(companySecrets.companyId, row.companyId), sql`${companySecrets.id} in (${row.accessSecretId}, ${row.refreshSecretId})`));
    const access = refs.find(ref => ref.id === row.accessSecretId), refresh = refs.find(ref => ref.id === row.refreshSecretId);
    if (!access || !refresh || access.status !== "active" || refresh.status !== "active" || access.scope !== "user" || refresh.scope !== "user" || access.ownerUserId !== row.userId || refresh.ownerUserId !== row.userId) throw managerRefreshPending();
    const accessValue = await secret(row, row.accessSecretId, database), refreshValue = await secret(row, row.refreshSecretId, database);
    return { access: { identity: await readSecretRecoveryIdentity(database as typeof db, row.companyId, access.id), secretId: access.id, latestVersion: access.latestVersion, valueHash: managerRefreshHash(accessValue) },
      refresh: { identity: await readSecretRecoveryIdentity(database as typeof db, row.companyId, refresh.id), secretId: refresh.id, latestVersion: refresh.latestVersion, valueHash: managerRefreshHash(refreshValue) }, accessValue, refreshValue };
  }
  function matchesIdentity(row: Grant, intent: ManagerRefreshIntent) {
    return row.id === intent.grantId && row.companyId === intent.companyId && row.userId === intent.ownerUserId && row.managerAppId === intent.managerAppId && row.workspaceId === intent.workspaceId && row.slackUserId === intent.slackUserId && row.accessSecretId === intent.access.secretId && row.refreshSecretId === intent.refresh.secretId;
  }
  function exactPredecessor(captured: Awaited<ReturnType<typeof snapshot>>, intent: ManagerRefreshIntent) {
    return ["access", "refresh"].every(key => {
      const which = key as "access" | "refresh";
      const exact = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
      return exact(captured[which]) === exact(intent[which]);
    });
  }
  async function settleRefresh(result: ManagerRefreshResult, actor: SlackSetupActor) {
    const intent = result.intent;
    if (actor.userId !== intent.ownerUserId) throw managerRefreshPending();
    const settled = await withManagerRefreshSettlement(result, () => db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${intent.grantId}`}, 0))`);
      const current = await readGrant(tx, intent.grantId, intent.companyId, actor);
      if (!matchesIdentity(current, intent)) throw managerRefreshPending();
      const captured = await snapshot(current, tx);
      // Matching replacement bytes/versions are not an originating committed
      // receipt. A changed post-claim state remains inspection-only, including
      // a lost COMMIT reply: never rotate again, clear, or authorize new use.
      if (current.status !== "reauthorize" || current.revision !== intent.claimedRevision || !exactPredecessor(captured, intent)) throw managerRefreshPending();
      await save(tx, current, result.credentials, actor);
      return { grant: await readGrant(tx, current.id, current.companyId, actor), token: result.credentials.accessToken };
    }));
    await managerRefreshRecovery(intent.companyId, intent.grantId).clear(result);
    return settled;
  }
  async function token(id: string, companyId: string, actor: SlackSetupActor) {
    await access(companyId, actor);
    await assertNoPendingManagerClaimForActor(companyId, actor.userId);
    await assertNoPendingSetupMessageForActor(companyId, actor.userId);
    await assertNoPendingRegistrationCleanupForActor(companyId, actor.userId);
    await assertNoPendingStagedCleanupForActor(companyId, actor.userId);
    await assertNoPendingManagedInstallForActor(companyId, actor.userId);
    await assertNoPendingManagerRevokeForActor(companyId, actor.userId);
    return withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      await assertNoPendingManagerClaimForActor(companyId, actor.userId);
      await assertNoPendingSetupMessageForActor(companyId, actor.userId);
      await assertNoPendingRegistrationCleanupForActor(companyId, actor.userId);
      await assertNoPendingStagedCleanupForActor(companyId, actor.userId);
      await assertNoPendingManagedInstallForActor(companyId, actor.userId);
      await assertNoPendingManagerRevokeForActor(companyId, actor.userId);
      const recovery = managerRefreshRecovery(companyId, id);
      const retained = await recovery.read();
      if (retained) {
        if (retained.kind !== "manager-refresh-result") throw managerRefreshPending();
        const currentClient = broker();
        if (!currentClient || (currentClient.authorizationMode ?? "claim") !== retained.intent.clientMode || !sameConnectorRecoveryAuthority(currentClient.recoveryAuthority, retained.intent.clientAuthority)) throw managerRefreshPending();
        return settleRefresh(retained, actor);
      }
      await assertNoPendingManagerRefreshForActor(companyId, actor.userId);
      const client = broker();
      if (!client) throw managerRefreshPending();
      // Missing/unrecognized local authority is not permission to probe or use
      // an opaque client. Capture the exact client used for this dispatch.
      const clientAuthority = connectorRecoveryAuthoritySchema.parse(client.recoveryAuthority);
      if (!await available()) throw providerFailure("slack_managed_unavailable");
      const managerAppId = await client.getSlackManagerAppId();
      const prepared = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
        const grant = await readGrant(tx, id, companyId, actor);
        if (grant.managerAppId !== managerAppId || grant.status !== "active") throw providerFailure("slack_manager_reauthorize");
        if (!grant.expiresAt || grant.expiresAt.getTime() > Date.now() + 60_000) return { grant, token: await secret(grant, grant.accessSecretId, tx) };
        return { grant, captured: await snapshot(grant, tx) };
      });
      if ("token" in prepared) return { grant: prepared.grant, token: prepared.token! };
      const intent: ManagerRefreshIntent = { schema: 1, kind: "manager-refresh-intent", family: "slack.manager.refresh", operationId: randomUUID(), companyId, grantId: id,
        ownerUserId: actor.userId, managerAppId: prepared.grant.managerAppId, workspaceId: prepared.grant.workspaceId, slackUserId: prepared.grant.slackUserId,
        profile: "slack.manager", clientAuthority, clientMode: client.authorizationMode ?? "claim", originalRevision: prepared.grant.revision, claimedRevision: prepared.grant.revision + 1,
        access: prepared.captured.access, refresh: prepared.captured.refresh };
      await recovery.begin(intent);
      await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
        const current = await readGrant(tx, id, companyId, actor);
        if (!matchesIdentity(current, intent) || current.status !== "active" || current.revision !== intent.originalRevision || !exactPredecessor(await snapshot(current, tx), intent)) throw managerRefreshPending();
        await tx.update(chatSlackManagerGrants).set({ status: "reauthorize", revision: intent.claimedRevision, updatedAt: new Date() }).where(eq(chatSlackManagerGrants.id, id));
      });
      // Journal/claim I/O may have waited while access was revoked. Refuse
      // dispatch now while retaining the original durable uncertainty identity.
      await access(companyId, actor);
      const currentClient = broker();
      if (!currentClient || (currentClient.authorizationMode ?? "claim") !== intent.clientMode ||
          (client.authorizationMode ?? "claim") !== intent.clientMode ||
          !sameConnectorRecoveryAuthority(currentClient.recoveryAuthority, intent.clientAuthority) ||
          !sameConnectorRecoveryAuthority(client.recoveryAuthority, intent.clientAuthority)) throw managerRefreshPending();
      let raw: import("../../../paperclip-cloud-connector.js").ConnectorRawResponse | undefined;
      const credentials = await client.refresh({ profile: "slack.manager", subject: actor.userId, companyId, refreshToken: prepared.captured.refreshValue }, async response => {
        await recovery.recordRaw({ intent, raw: response });
        raw = response;
      });
      if (!raw) throw managerRefreshPending();
      const result = await recovery.recordResult({ intent, raw, credentials });
      return settleRefresh(result, actor);
    });
  }
  async function revoke(id: string, companyId: string, actor: SlackSetupActor) {
    return withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      await assertNoPendingManagerClaimForActor(companyId, actor.userId);
      await assertNoPendingSetupMessageForActor(companyId, actor.userId);
      await assertNoPendingRegistrationCleanupForActor(companyId, actor.userId);
      await assertNoPendingStagedCleanupForActor(companyId, actor.userId);
      await assertNoPendingManagedInstallForActor(companyId, actor.userId);
      await assertNoPendingManagerRevokeForActor(companyId, actor.userId);
      await assertNoPendingManagerRefreshForActor(companyId, actor.userId);
      return revokeLocked(id, companyId, actor);
    });
  }
  async function revokeLocked(id: string, companyId: string, actor: SlackSetupActor) {
    await access(companyId, actor);
    const recovery = managerRevokeRecovery(companyId, id);
    if (await recovery.read()) throw managerRevokePending();
    const original = await readGrant(db, id, companyId, actor);
    if (original.status === "revoked" && (original.accessSecretId || original.refreshSecretId)) throw managerRevokePending();
    if (!original.accessSecretId && !original.refreshSecretId) return;
    const client = broker();
    if (!client) throw managerRevokePending();
    const clientAuthority = connectorRecoveryAuthoritySchema.parse(client.recoveryAuthority);
    if (clientAuthority.kind === "development-direct-oauth" && clientAuthority.appId !== original.managerAppId) throw managerRevokePending();
    const tokens: Partial<Record<ManagerRevokeRole, string>> = {};
    const capture = async (role: ManagerRevokeRole) => {
      const secretId = role === "access" ? original.accessSecretId : original.refreshSecretId;
      if (!secretId) return null;
      const value = await secret(original, secretId);
      tokens[role] = value;
      return { identity: await readSecretRecoveryIdentity(db, companyId, secretId), valueHash: managerRevokeHash(value), tokenOperationId: randomUUID() };
    };
    const intent: ManagerRevokeIntent = { schema: 1, kind: "manager-revoke-intent", operationId: randomUUID(), companyId, grantId: id,
      actorUserId: actor.userId, actorSessionId: actor.sessionId ?? null, originalGrant: normalizedClaim(original), originalRevision: original.revision,
      deniedRevision: original.revision + 1, clientMode: client.authorizationMode ?? "claim", clientAuthority, access: await capture("access"), refresh: await capture("refresh") };
    await recovery.begin(intent);
    const assertSecrets = async (database: Database) => {
      for (const role of ["access", "refresh"] as const) if (intent[role]) {
        const descriptor = await readSecretRecoveryIdentity(database as typeof db, companyId, intent[role]!.identity.secretId);
        if (!exactClaim(descriptor, intent[role]!.identity)) throw managerRevokePending();
      }
    };
    // Only an acknowledged deny transaction admits these original dispatches.
    const denied = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
      const current = await readGrant(tx, id, companyId, actor);
      if (!exactClaim(normalizedClaim(current), intent.originalGrant)) throw managerRevokePending();
      await assertSecrets(tx);
      const [row] = await tx.update(chatSlackManagerGrants).set({ status: "revoked", revision: intent.deniedRevision, updatedAt: new Date() }).where(eq(chatSlackManagerGrants.id, id)).returning();
      await tx.delete(toolOauthStates).where(and(eq(toolOauthStates.companyId, companyId), eq(toolOauthStates.createdByActorId, actor.userId), like(toolOauthStates.state, `${SLACK_MANAGER_STATE_PREFIX}%`)));
      return row!;
    });
    const errors: unknown[] = [];
    for (const role of ["access", "refresh"] as const) if (intent[role]) {
      try {
        await access(companyId, actor);
        if (!exactClaim(normalizedClaim(await readGrant(db, id, companyId, actor)), normalizedClaim(denied))) throw managerRevokePending();
        await assertSecrets(db);
        const currentClient = broker();
        if (!currentClient || !sameConnectorRecoveryAuthority(currentClient.recoveryAuthority, intent.clientAuthority) || !sameConnectorRecoveryAuthority(client.recoveryAuthority, intent.clientAuthority)) throw managerRevokePending();
        let raw: import("../../../paperclip-cloud-connector.js").ConnectorRawResponse | undefined;
        await client.revoke({ subject: actor.userId, companyId, profile: "slack.manager", token: tokens[role]! }, async response => {
          await recovery.recordRaw({ role, intent, raw: response }); raw = response;
        });
        if (!raw) throw managerRevokePending();
        await recovery.recordClientCompletion({ role, intent, raw });
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw Object.assign(managerRevokePending(), { cause: new AggregateError(errors, "Original revoke client outcomes remain unresolved") });
    const completed = await recovery.read();
    if (!completed) throw managerRevokePending();
    await withManagerRevokeCleanup(completed, () => db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
      const current = await readGrant(tx, id, companyId, actor);
      if (!exactClaim(normalizedClaim(current), normalizedClaim(denied))) throw managerRevokePending();
      await assertSecrets(tx);
      for (const role of ["access", "refresh"] as const) if (intent[role]) {
        const originalIdentity = intent[role]!.identity;
        if (!exactClaim(await readSecretRecoveryIdentity(tx as typeof db, companyId, originalIdentity.secretId), originalIdentity)) throw managerRevokePending();
        const removed = await secretService(tx).remove(originalIdentity.secretId);
        if (!removed || removed.id !== originalIdentity.secretId) throw managerRevokePending();
      }
      await tx.update(chatSlackManagerGrants).set({ accessSecretId: null, refreshSecretId: null }).where(eq(chatSlackManagerGrants.id, id));
    }));
    await logActivity(db, { companyId, actorType: "user", actorId: actor.userId, action: "chat_slack.manager_revoked", entityType: "slack_manager_grant", entityId: id,
      details: { workspaceId: denied.workspaceId, clientCompleted: true, acceptance: intent.clientMode === "claim" ? "hosted-broker-accepted" : "development-api-ok" } });
    await recovery.clear(completed);
  }
  async function prepareManagedInstall(id: string, companyId: string, actor: SlackSetupActor) {
    return withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      const authorized = await token(id, companyId, actor);
      const captured = await snapshot(authorized.grant, db);
      return { grant: authorized.grant, secrets: {
        [captured.access.secretId]: { identity: captured.access.identity, valueHash: captured.access.valueHash },
        [captured.refresh.secretId]: { identity: captured.refresh.identity, valueHash: captured.refresh.valueHash },
      } };
    });
  }
  async function dispatchManagedInstall(intent: ManagedInstallIntent, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    return withAccountHomeSecretMutationLock(undefined, intent.companyId, async () => {
      if (actor.userId !== intent.actorUserId || (actor.sessionId ?? null) !== intent.actorSessionId) throw managedInstallPending();
      const recovery = managedInstallRecovery(intent.companyId, intent.endpointId);
      const retained = await recovery.read();
      if (!retained || retained.kind !== "managed-install-intent" || !exactClaim(retained, intent)) throw managedInstallPending();
      await assertNoPendingManagerClaimForActor(intent.companyId, actor.userId);
      await assertNoPendingSetupMessageForActor(intent.companyId, actor.userId);
      await assertNoPendingRegistrationCleanupForActor(intent.companyId, actor.userId);
      await assertNoPendingStagedCleanupForActor(intent.companyId, actor.userId);
      await assertNoPendingManagerRefreshForActor(intent.companyId, actor.userId);
      await assertNoPendingManagerRevokeForActor(intent.companyId, actor.userId);
      const assertOriginal = async (database: Database) => {
        await access(intent.companyId, actor, database);
        await lease.assertOwned(database as Parameters<typeof lease.assertOwned>[0]);
        const current = await endpoint(intent.endpointId, actor);
        const registration = await store.registration(intent.endpointId);
        if (!exactClaim(normalizedClaim(current.endpoint), intent.preparedEndpoint ?? intent.originalEndpoint) || !exactClaim(normalizedClaim(current.connection), intent.originalConnection) ||
            !exactClaim(normalizedClaim(registration ?? null), intent.preparedRegistration ?? intent.originalRegistration)) throw managedInstallPending();
        if (intent.reconnectKey) {
          const [action] = await database.select().from(chatActions).where(and(eq(chatActions.companyId, intent.companyId), eq(chatActions.endpointId, intent.endpointId), eq(chatActions.providerActionId, intent.reconnectKey)));
          if (!exactClaim(normalizedClaim(action ?? null), intent.preparedAction ?? intent.originalAction)) throw managedInstallPending();
        }
        const grant = await readGrant(database, String(intent.originalManagerGrant.id), intent.companyId, actor);
        if (grant.status !== "active" || !exactClaim(normalizedClaim(grant), intent.originalManagerGrant)) throw managedInstallPending();
        for (const [id, original] of Object.entries({ ...intent.originalManagerSecrets, ...intent.originalRegistrationSecrets })) {
          if (!exactClaim(await readSecretRecoveryIdentity(database as typeof db, intent.companyId, id), original.identity)) throw managedInstallPending();
        }
        return grant;
      };
      await assertOriginal(db);
      const result = await db.transaction(async tx => {
        const id = String(intent.originalManagerGrant.id);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-api:${intent.companyId}:${intent.directApiAuthority.managerAppId}:${intent.params.team_id}:apps.managedInstall`}, 0))`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
        const grant = await assertOriginal(tx);
        const peers = await tx.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.companyId, intent.companyId), eq(chatSlackManagerGrants.managerAppId, grant.managerAppId), eq(chatSlackManagerGrants.workspaceId, grant.workspaceId)));
        if (peers.some(peer => Date.parse(peer.rateLimits["apps.managedInstall"] ?? "") > Date.now())) throw providerFailure("slack_setup_rate_limited");
        let raw: import("../../../paperclip-cloud-connector.js").ConnectorRawResponse | undefined;
        const value = await api("apps.managedInstall", intent.params, await secret(grant, grant.accessSecretId, tx), undefined, async response => {
          await recovery.recordRaw({ intent, raw: response }); raw = response;
        });
        if (!raw) throw managedInstallPending();
        return recovery.recordResult({ intent, raw, decoded: { appId: String(value.app_id ?? ""), teamId: String(value.team_id ?? ""), botToken: String(object(value.api_access_tokens).bot_access_token ?? "") } });
      });
      return result;
    });
  }
  async function request(id: string, companyId: string, actor: SlackSetupActor, method: string, fields: Record<string, string> | FormData) {
    return withAccountHomeSecretMutationLock(undefined, companyId, async () => {
    await assertNoPendingManagerClaimForActor(companyId, actor.userId);
    await assertNoPendingSetupMessageForActor(companyId, actor.userId);
    await assertNoPendingRegistrationCleanupForActor(companyId, actor.userId);
    await assertNoPendingStagedCleanupForActor(companyId, actor.userId);
    await assertNoPendingManagedInstallForActor(companyId, actor.userId);
    await assertNoPendingManagerRevokeForActor(companyId, actor.userId);
    const authorized = await token(id, companyId, actor);
    const { grant } = authorized;
    // Slack shares a method budget across manager tokens in the same workspace.
    // Persist Retry-After across grants and process restarts; never retry a dispatch.
    const result = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-api:${companyId}:${grant.managerAppId}:${grant.workspaceId}:${method}`}, 0))`);
      // Serialize provider dispatch against refresh/revocation for this personal grant.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
      const peers = await tx.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.companyId, companyId), eq(chatSlackManagerGrants.managerAppId, grant.managerAppId), eq(chatSlackManagerGrants.workspaceId, grant.workspaceId))).orderBy(chatSlackManagerGrants.id);
      if (peers.some(peer => Date.parse(peer.rateLimits[method] ?? "") > Date.now())) return { error: providerFailure("slack_setup_rate_limited") };
      const current = await readGrant(tx, id, companyId, actor);
      if (current.status !== "active") return { error: providerFailure("slack_manager_reauthorize") };
      await assertNoPendingManagerClaimForActor(companyId, actor.userId);
      await assertNoPendingSetupMessageForActor(companyId, actor.userId);
      await assertNoPendingRegistrationCleanupForActor(companyId, actor.userId);
      await assertNoPendingStagedCleanupForActor(companyId, actor.userId);
      await assertNoPendingManagedInstallForActor(companyId, actor.userId);
      await assertNoPendingManagerRevokeForActor(companyId, actor.userId);
      await assertNoPendingManagerRefreshForActor(companyId, actor.userId);
      try { return { value: await api(method, fields, await secret(current, current.accessSecretId, tx)) }; }
      catch (error) {
        const details = object(object(error).details);
        if (details.code === "slack_setup_rate_limited") {
          const until = new Date(Date.now() + Math.min(Number(details.retryAfterSeconds) || 60, 86_400) * 1000).toISOString();
          for (const peer of peers) await tx.update(chatSlackManagerGrants).set({ rateLimits: sql`${chatSlackManagerGrants.rateLimits} || ${JSON.stringify({ [method]: until })}::jsonb` }).where(eq(chatSlackManagerGrants.id, peer.id));
        }
        if (details.code === "slack_configuration_token_invalid") {
          await tx.update(chatSlackManagerGrants).set({ status: "reauthorize", revision: current.revision + 1, updatedAt: new Date() }).where(eq(chatSlackManagerGrants.id, id));
          return { error: providerFailure("slack_manager_reauthorize") };
        }
        return { error };
      }
    });
    if ("error" in result) throw result.error;
    return result.value!;
    });
  }
  return { choices, defaultMethod, available, authorize, pending, expiredReturn, complete, get, token, revoke, request, prepareManagedInstall, dispatchManagedInstall };
}
