import { assertSlackSetupNewUse } from "./new-use-guard.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { isProvisionedSlackSetup } from "@paperclipai/shared";
import { createSlackManagerGrants } from "./manager-grants.js";
import { createManagedSlackSetup } from "./managed.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assertNoPendingSlackInstall, slackInstallRecovery, type SlackInstallIntent, type SlackInstallResult, withSlackInstallResultSettlement, slackInstallCredentialHash } from "./install-recovery.js";
import { and, eq, gt, like } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, companies, toolOauthStates, type Db } from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound } from "../../../../errors.js";
import { removeSlackRegistration } from "../../../chat-slack-registration-cleanup.js";
import type { CredentialMutationLeaseGuard } from "../../../chat-credential-mutation-lease.js";
import { object, providerFailure, createSlackRegistrationStore, type SlackSetupOptions, type SlackSetupActor, type Registration } from "./registration.js";
import { createCustomerOwnedSetup } from "./customer-owned.js";
import { createSlackCompletion } from "./completion.js";
const prefix = "slack-install.";
export function slackChatRegistrationService(db: Db, options: SlackSetupOptions) {
  const store = createSlackRegistrationStore(db, options);
  const { endpoint, registration, assertOrigins, callbackUri, audit, api, readSecret, readSecretIdentity, setFailure, saveSecrets } = store;
  const provisioner = createCustomerOwnedSetup(store);
  const { create } = provisioner;
  const completion = createSlackCompletion(store);
  const { resumeLocked, notifyVerified, processPendingVerificationMessages, nextVerificationMessageAt } = completion;
  const managerGrants = createSlackManagerGrants(store);
  const managed = createManagedSlackSetup(store, managerGrants, provisioner, completion, install);
  async function install(endpointId: string, actor: SlackSetupActor) {
    return options.withLock(endpointId, async lease => {
      const selected = await endpoint(endpointId, actor);
      return withAccountHomeSecretMutationLock(undefined, selected.endpoint.companyId, async () => {
      const current = await endpoint(endpointId, actor);
      await assertSlackSetupNewUse({ companyId: current.endpoint.companyId, endpointId, actorUserId: actor.userId });
      const row = await registration(endpointId);
      if (!row?.appId || !row.clientId || row.status === "removed") throw conflict("Create this Slack app before installing it");
      if (row.errorCode === "slack_manifest_update_pending") throw conflict("Finish configuring the saved Slack app before installing it");
      if (!isProvisionedSlackSetup(current.endpoint.setup.slackSetupMethod) || current.endpoint.status === "paused") throw conflict("Resume this connection before installing it");
      if (row.managerGrantId) await managerGrants.token(row.managerGrantId, row.companyId, actor);
      assertOrigins(row, current.endpoint.publicId);
      const state = `${prefix}${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const scopes = object(object(row.manifest.oauth_config).scopes).bot as string[];
      await assertSlackSetupNewUse({ companyId: row.companyId, endpointId, actorUserId: actor.userId });
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        await tx.delete(toolOauthStates).where(and(eq(toolOauthStates.connectionId, current.connection.id), like(toolOauthStates.state, `${prefix}%`)));
        await tx.insert(toolOauthStates).values({ state, companyId: row.companyId, connectionId: current.connection.id,
          codeVerifier: JSON.stringify({ endpointId, requestId: row.requestId, appId: row.appId, callbackUri: row.callbackUri,
            endpointStatus: current.endpoint.status, runtimeGeneration: object(current.endpoint.setup).runtimeGeneration ?? 0 }),
          createdByActorType: "user", createdByActorId: actor.userId, createdBySessionId: actor.sessionId,
          requestedScopes: scopes, expiresAt });
        await tx.update(chatSlackRegistrations).set({ errorCode: row.managerGrantId ? row.errorCode : null, updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
      });
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.search = new URLSearchParams({ client_id: row.clientId, scope: scopes.join(","), state, redirect_uri: row.callbackUri,
        ...(row.workspaceId ? { team: row.workspaceId } : {}) }).toString();
      await audit(row, actor, "installation_started");
      return { authorizationUrl: url.toString(), expiresAt: expiresAt.toISOString() };
      });
    });
  }
  async function expiredReturn(state: string, actor: SlackSetupActor) {
    if (!/^slack-install\.[A-Za-z0-9_-]{43}$/.test(state)) return null;
    const [attempt] = await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state));
    if (!attempt || attempt.expiresAt.getTime() > Date.now() || attempt.createdByActorId !== actor.userId || attempt.createdBySessionId !== actor.sessionId) return null;
    const binding = object(JSON.parse(attempt.codeVerifier));
    const current = await endpoint(String(binding.endpointId), actor);
    return options.withLock(current.endpoint.id, async lease => withAccountHomeSecretMutationLock(undefined, current.endpoint.companyId, async () => {
      const latest = await endpoint(current.endpoint.id, actor);
      await assertSlackSetupNewUse({ companyId: latest.endpoint.companyId, endpointId: current.endpoint.id, actorUserId: actor.userId });
      const row = await registration(current.endpoint.id);
      if (!row || row.status === "removed" || row.requestId !== binding.requestId || row.companyId !== attempt.companyId || latest.connection.id !== attempt.connectionId
        || !isProvisionedSlackSetup(latest.endpoint.setup.slackSetupMethod) || row.appId !== binding.appId || row.callbackUri !== binding.callbackUri) return null;
      assertOrigins(row, latest.endpoint.publicId);
      await assertSlackSetupNewUse({ companyId: row.companyId, endpointId: row.endpointId, actorUserId: actor.userId });
      await lease.assertOwned();
      await db.delete(toolOauthStates).where(eq(toolOauthStates.state, state));
      await setFailure(row, row.status, "slack_install_expired", lease);
      await audit(row, actor, "installation_failed", "slack_install_expired");
      return returnPath(row.endpointId);
    }));
  }
  async function pending(state: string, actor: SlackSetupActor) {
    if (!/^slack-install\.[A-Za-z0-9_-]{43}$/.test(state)) throw badRequest("Invalid Slack authorization state");
    const [attempt] = await db.select().from(toolOauthStates).where(and(eq(toolOauthStates.state, state), gt(toolOauthStates.expiresAt, new Date())));
    if (!attempt || attempt.createdByActorId !== actor.userId || attempt.createdBySessionId !== actor.sessionId)
      throw forbidden("Slack authorization expired or belongs to another session. Resume setup and install again.");
    const binding = object(JSON.parse(attempt.codeVerifier));
    const current = await endpoint(String(binding.endpointId), actor);
    const row = await registration(current.endpoint.id);
    if (!row || row.status === "removed" || !isProvisionedSlackSetup(current.endpoint.setup.slackSetupMethod)
      || current.endpoint.status === "paused"
      || current.endpoint.status === "revoked" && binding.endpointStatus !== "revoked"
      || binding.runtimeGeneration !== (object(current.endpoint.setup).runtimeGeneration ?? 0)
      || row.requestId !== binding.requestId || row.appId !== binding.appId || row.callbackUri !== binding.callbackUri
      || row.callbackUri !== callbackUri() || attempt.companyId !== row.companyId || attempt.connectionId !== current.connection.id)
      throw conflict("Slack setup changed. Resume the saved connection and install again.");
    await assertNoPendingSlackInstall(row.companyId, row.endpointId);
    assertOrigins(row, current.endpoint.publicId);
    return { attempt, current, row };
  }
  const same = (left: unknown, right: unknown) => JSON.stringify(left, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value) === JSON.stringify(right, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  function assertBinding(intent: SlackInstallIntent, row: Registration, current: Awaited<ReturnType<typeof endpoint>>, actor: SlackSetupActor) {
    if (intent.actorUserId !== actor.userId || intent.companyId !== row.companyId || intent.endpointId !== row.endpointId ||
        intent.endpointId !== current.endpoint.id || intent.companyId !== current.endpoint.companyId ||
        intent.connectionId !== current.connection.id || intent.requestId !== row.requestId || intent.appId !== row.appId ||
        intent.clientId !== row.clientId || intent.callbackUri !== row.callbackUri || row.callbackUri !== callbackUri() ||
        intent.runtimeGeneration !== (object(current.endpoint.setup).runtimeGeneration ?? 0) ||
        intent.managerGrantId !== (row.managerGrantId ?? null) || row.status === "removed") throw conflict("Slack installation requires exact recovery inspection");
    assertOrigins(row, current.endpoint.publicId);
  }
  async function validateResult(result: Record<string, unknown>, row: Registration, current: Awaited<ReturnType<typeof endpoint>>, intent: SlackInstallIntent, actor: SlackSetupActor) {
        const teamId = object(result.team).id;
        const installerId = object(result.authed_user).id;
        if (result.app_id !== row.appId || result.token_type !== "bot" || typeof result.access_token !== "string" || !result.access_token.startsWith("xoxb-")
          || typeof teamId !== "string" || !/^T[A-Z0-9]+$/.test(teamId) || typeof result.bot_user_id !== "string" || !/^[UW][A-Z0-9]+$/.test(result.bot_user_id)
          || row.workspaceId && row.workspaceId !== teamId || row.botUserId && row.botUserId !== result.bot_user_id)
          throw providerFailure("slack_install_identity_mismatch");
        const granted = new Set(String(result.scope ?? "").split(","));
        if ((intent.requestedScopes ?? []).some(scope => !granted.has(scope))) throw providerFailure("slack_install_scopes_missing");
        if (current.endpoint.providerAccountId && current.endpoint.providerAccountId !== teamId
          || current.endpoint.botExternalId && current.endpoint.botExternalId !== result.bot_user_id)
          throw providerFailure("slack_install_identity_mismatch");
        if (typeof installerId !== "string" || !/^[UW][A-Z0-9]+$/.test(installerId) || installerId === result.bot_user_id) throw providerFailure("slack_install_account_missing");
        if (row.managerGrantId) {
          const grant = await managerGrants.get(row.managerGrantId, row.companyId, actor);
          if (grant.status !== "active" || installerId !== grant.slackUserId || teamId !== grant.workspaceId) throw providerFailure("slack_install_identity_mismatch");
        }
    return { teamId: teamId as string, botUserId: result.bot_user_id as string, installerId: installerId as string, botToken: result.access_token as string };
  }
  async function assertSecretPredecessors(intent: SlackInstallIntent, row: Registration) {
    if (!same(row.secretIds, intent.secretIds)) throw conflict("Slack credential predecessor changed");
    for (const key of Object.keys(intent.secretIds)) {
      if (!same(await readSecretIdentity(row, key), intent.originalSecretIdentities[key])) throw conflict("Slack credential authority predecessor changed");
    }
  }
  async function persistResult(receipt: SlackInstallResult, row: Registration, current: Awaited<ReturnType<typeof endpoint>>, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard, onAttempt: () => void) {
    const intent = receipt.intent;
    assertBinding(intent, row, current, actor);
    const raw = object(JSON.parse(Buffer.from(receipt.raw.bodyBase64, "base64").toString("utf8")));
    if (receipt.raw.status < 200 || receipt.raw.status >= 300 || raw.ok !== true) throw conflict("Slack installation requires exact recovery inspection");
    const result = await validateResult(raw, row, current, intent, actor);
    await assertSecretPredecessors(intent, row);
    if (slackInstallCredentialHash(await readSecret(row, "clientSecret")) !== intent.originalClientSecretHash) throw conflict("Slack credential predecessor changed");
    const botToken = row.secretIds.botToken ? await readSecret(row, "botToken") : null;
    const account = object(object(current.endpoint.setup).slackAccount);
    // Equality of current values cannot prove an independently committed SQL
    // outcome. A possibly committed save stays occupied for owner inspection.
    if (row.status === "credentials_saved" || row.status === "configured") throw conflict("Slack installation requires exact recovery inspection");
    if ((botToken === null ? null : slackInstallCredentialHash(botToken)) !== intent.originalBotTokenHash ||
        row.workspaceId !== intent.originalWorkspaceId || row.botUserId !== intent.originalBotUserId ||
        (current.endpoint.providerAccountId ?? null) !== intent.originalProviderAccountId ||
        (current.endpoint.botExternalId ?? null) !== intent.originalBotExternalId || !same(account, intent.originalAccount)) throw conflict("Slack credential predecessor changed");
    await lease.assertOwned();
    await withSlackInstallResultSettlement(receipt, () => {
      onAttempt();
      return saveSecrets(row, { botToken: result.botToken }, actor, lease,
        { status: "credentials_saved", workspaceId: result.teamId, botUserId: result.botUserId, errorCode: null },
        { externalUserId: result.installerId, paperclipUserId: actor.userId, status: "pending", welcomeStatus: "pending" });
    });
  }
  async function complete(state: string, code: string | null, error: string | null, actor: SlackSetupActor) {
    const before = await pending(state, actor);
    return options.withLock(before.row.endpointId, async lease => {
      const outcome = await withAccountHomeSecretMutationLock(undefined, before.row.companyId, async () => {
        const { row, attempt, current } = await pending(state, actor);
        await assertSlackSetupNewUse({ companyId: row.companyId, endpointId: row.endpointId, actorUserId: actor.userId });
        if (error || !code || code.length > 4096) {
          const [claimed] = await db.delete(toolOauthStates).where(and(eq(toolOauthStates.state, state), gt(toolOauthStates.expiresAt, new Date()))).returning();
          if (!claimed) throw conflict("This Slack authorization was already used");
          const failureCode = error === "access_denied" ? "slack_install_declined" : "slack_install_failed";
          await setFailure(row, row.status, failureCode, lease);
          await audit(row, actor, "installation_failed", failureCode);
          return { endpointId: row.endpointId, readyForCompletion: false };
        }
        if (row.managerGrantId) await managerGrants.token(row.managerGrantId, row.companyId, actor);
        await assertSlackSetupNewUse({ companyId: row.companyId, endpointId: row.endpointId, actorUserId: actor.userId });
        const recovery = slackInstallRecovery(row.companyId, row.endpointId);
        const originalClientSecret = await readSecret(row, "clientSecret");
        const originalBotToken = row.secretIds.botToken ? await readSecret(row, "botToken") : null;
        const originalSecretIdentities = Object.fromEntries(await Promise.all(Object.keys(row.secretIds).map(async key => [key, await readSecretIdentity(row, key)] as const)));
        const intent: SlackInstallIntent = {
          schema: 1, kind: "slack-install-intent", operationId: randomUUID(),
          companyId: row.companyId, endpointId: row.endpointId, connectionId: current.connection.id,
          requestId: row.requestId, state, appId: row.appId!, clientId: row.clientId!, callbackUri: row.callbackUri,
          runtimeGeneration: Number(object(current.endpoint.setup).runtimeGeneration ?? 0),
          actorUserId: actor.userId, actorSessionId: actor.sessionId,
          requestedScopes: attempt.requestedScopes ?? [], codeHash: createHash("sha256").update(code).digest("hex"),
          secretIds: { ...row.secretIds }, originalSecretIdentities, originalClientSecretHash: slackInstallCredentialHash(originalClientSecret),
          originalBotTokenHash: originalBotToken === null ? null : slackInstallCredentialHash(originalBotToken),
          managerGrantId: row.managerGrantId ?? null, originalWorkspaceId: row.workspaceId ?? null, originalBotUserId: row.botUserId ?? null,
          originalProviderAccountId: current.endpoint.providerAccountId ?? null, originalBotExternalId: current.endpoint.botExternalId ?? null,
          originalAccount: { ...object(object(current.endpoint.setup).slackAccount) },
        };
        await assertSlackSetupNewUse({ companyId: row.companyId, endpointId: row.endpointId, actorUserId: actor.userId });
        await lease.assertOwned();
        await recovery.beginExchange(intent);
        const [claimed] = await db.delete(toolOauthStates).where(and(eq(toolOauthStates.state, state), gt(toolOauthStates.expiresAt, new Date()))).returning();
        if (!claimed) throw conflict("This Slack authorization was already used");
        let retainedResult: SlackInstallResult | undefined;
        let saveAttempted = false;
        try {
          await assertSecretPredecessors(intent, row);
          const clientSecret = await readSecret(row, "clientSecret");
          const currentBotToken = row.secretIds.botToken ? await readSecret(row, "botToken") : null;
          if (slackInstallCredentialHash(clientSecret) !== intent.originalClientSecretHash ||
              (currentBotToken === null ? null : slackInstallCredentialHash(currentBotToken)) !== intent.originalBotTokenHash) throw conflict("Slack credential predecessor changed");
          await lease.assertOwned();
          await api("oauth.v2.access", { code, client_id: row.clientId!, client_secret: clientSecret, redirect_uri: row.callbackUri }, undefined, undefined, async raw => {
            retainedResult = { schema: 1, kind: "slack-install-result", intent, raw };
            await recovery.completeExchange(retainedResult);
          });
          if (!retainedResult) throw conflict("Slack installation result was not retained");
          await persistResult(retainedResult, row, current, actor, lease, () => { saveAttempted = true; });
        } catch (failure) {
          const code = object(object(failure).details).code;
          const safeCode = typeof code === "string" && code.startsWith("slack_install_") ? code : "slack_install_failed";
          // Once SQL settlement was attempted, its response may have been lost
          // after commit. Never overwrite that possibly committed status with the
          // stale pre-exchange row; exact result remains occupied for inspection.
          if (!saveAttempted) await setFailure(row, row.status, safeCode, lease);
          await audit(row, actor, saveAttempted ? "installation_uncertain" : "installation_failed", safeCode);
          return { endpointId: row.endpointId, readyForCompletion: false };
        }
        // Credential SQL commit was acknowledged. Cleanup failure must not reset
        // that known saved state to the old pre-exchange registration status.
        await recovery.clear(retainedResult!);
        return { endpointId: row.endpointId, readyForCompletion: true };
      });
      // Runtime invalidation joins callbacks which may acquire this company's
      // credential lock. Preserve the endpoint lease, but release that lock
      // after acknowledged exchange settlement before prospective completion.
      if (outcome.readyForCompletion) await resumeLocked(outcome.endpointId, actor, lease);
      return outcome.endpointId;
    });
  }
  const cleanup = (endpointId: string, lease: CredentialMutationLeaseGuard) => removeSlackRegistration(db, endpointId, lease);
  async function returnPath(endpointId: string) {
    const [row] = await db.select({ prefix: companies.issuePrefix }).from(chatEndpoints)
      .innerJoin(companies, eq(companies.id, chatEndpoints.companyId)).where(eq(chatEndpoints.id, endpointId));
    if (!row) throw notFound("Slack connection not found");
    return `/${encodeURIComponent(row.prefix)}/apps/chat/connect?provider=slack&resume=${encodeURIComponent(endpointId)}`;
  }
  return { create, managerGrants, managed, install, pending, expiredReturn, complete, cleanup, returnPath, registration, notifyVerified, processPendingVerificationMessages, nextVerificationMessageAt,
    close: store.close,
    resume: (endpointId: string, actor: SlackSetupActor) => options.withLock(endpointId, async lease => {
      const authorized = await endpoint(endpointId, actor);
      await withAccountHomeSecretMutationLock(undefined, authorized.endpoint.companyId, async () => {
        const recovery = slackInstallRecovery(authorized.endpoint.companyId, endpointId);
        const retained = await recovery.read();
        if (!retained) return;
        if (retained.kind !== "slack-install-result") throw conflict("Slack installation requires exact recovery inspection");
        const current = await endpoint(endpointId, actor);
        const row = await registration(endpointId);
        if (!row) throw conflict("Slack installation requires exact recovery inspection");
        let saveAttempted = false;
        try { await persistResult(retained, row, current, actor, lease, () => { saveAttempted = true; }); }
        catch (error) {
          if (saveAttempted) await audit(row, actor, "installation_uncertain", "slack_install_failed");
          throw error;
        }
        await recovery.clear(retained);
      });
      const row = await registration(endpointId);
      if (row?.managerGrantId) await managerGrants.token(row.managerGrantId, row.companyId, actor);
      return resumeLocked(endpointId, actor, lease);
    }) };
}
