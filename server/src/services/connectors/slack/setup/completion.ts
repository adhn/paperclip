import { assertNoPendingManagerRefreshForActor } from "./manager-refresh-recovery.js";
import { assertNoPendingManagerRevokeForActor } from "./manager-revoke-recovery.js";
import { assertNoPendingSetupMessageForEndpoint, setupMessageRecovery, setupMessageHash, setupMessagePending, type SetupMessageIntent } from "./setup-message-recovery.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { readSecretRecoveryIdentity } from "../../../secret-recovery-identity.js";
import { registrationCleanupRecovery, registrationCleanupPending, assertNoPendingRegistrationCleanupForEndpoint, withRegistrationCleanup, type RegistrationCleanupIntent } from "./registration-cleanup-recovery.js";
import { assertNoPendingManagedInstallForEndpoint } from "./managed-install-recovery.js";
import { assertNoPendingManagerClaimForEndpoint } from "./manager-claim-recovery.js";
import { randomUUID } from "node:crypto";
import { assertNoPendingStagedCleanupForEndpoint } from "./staged-cleanup-recovery.js";
import { assertManagedInstallCompletionAllowed } from "./managed-install-recovery.js";
import { assertNoPendingSlackInstall } from "./install-recovery.js";
import { notifyChatVerificationWork } from "../../../chat-work-notifications.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations } from "@paperclipai/db";
import { SLACK_CHAT_BOT_SCOPES, SLACK_BOT_TOOL_SCOPES, type SlackAccountState } from "@paperclipai/shared";
import { conflict, forbidden } from "../../../../errors.js";
import { logger } from "../../../../middleware/logger.js";
import { secretService } from "../../../secrets.js";
import type { CredentialMutationLeaseGuard } from "../../../chat-credential-mutation-lease.js";
import { object, providerFailure, type Registration, type SlackSetupActor, type SlackRegistrationStore } from "./registration.js";
export function createSlackCompletion(store: SlackRegistrationStore) {
  const { db, options, endpoint, registration, assertOrigins, api, readSecret, audit, setFailure } = store;
  const vault = secretService(db);
  async function saveAccount(row: Registration, account: SlackAccountState, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    await endpoint(row.endpointId, actor);
    await db.transaction(async tx => {
      await lease.assertOwned(tx);
      const saved = (await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, row.endpointId), eq(chatEndpoints.companyId, row.companyId))).for("update"))[0];
      const registrationNow = (await tx.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, row.endpointId)))[0];
      if (!saved || saved.status === "archived" || registrationNow?.status === "removed" || registrationNow?.requestId !== row.requestId) throw conflict("Slack setup changed");
      await notifyChatVerificationWork(tx);
      await tx.update(chatEndpoints).set({ setup: { ...saved.setup, slackAccount: account }, updatedAt: new Date() }).where(eq(chatEndpoints.id, row.endpointId));
      await lease.assertOwned(tx);
    });
  }
  async function linkAccount(row: Registration, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    const current = await endpoint(row.endpointId, actor);
    const account = current.endpoint.setup.slackAccount;
    if (!account) throw providerFailure("slack_install_account_missing");
    if (account.status === "linked") return;
    const token = row.secretIds.botToken ? await readSecret(row, "botToken") : await options.runtimeBotToken(row.endpointId);
    const user = object((await api("users.info", { user: account.externalUserId }, token)).user);
    if (user.id !== account.externalUserId || user.team_id !== row.workspaceId || user.is_bot !== false || user.is_app_user === true || user.deleted !== false) throw providerFailure("slack_install_account_missing");
    await endpoint(row.endpointId, actor);
    await options.linkInstaller(row.endpointId, user, { ...actor, userId: account.paperclipUserId }, lease);
    await saveAccount(row, { ...account, status: "linked" }, actor, lease);
    try { await audit(row, actor, "account_linked"); }
    catch { logger.warn({ endpointId: row.endpointId, appId: row.appId }, "Slack account activity could not be recorded"); }
  }
  async function sendSetupMessage(row: Registration, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard, kind: "welcome" | "verification") {
    return withAccountHomeSecretMutationLock(undefined, row.companyId, async () => {
      await assertNoPendingRegistrationCleanupForEndpoint(row.companyId, row.endpointId);
      await assertNoPendingStagedCleanupForEndpoint(row.companyId, row.endpointId);
      await assertNoPendingManagerClaimForEndpoint(row.companyId, row.endpointId);
      await assertNoPendingManagerRefreshForActor(row.companyId, actor.userId);
      await assertNoPendingManagerRevokeForActor(row.companyId, actor.userId);
      await assertManagedInstallCompletionAllowed(row.companyId, row.endpointId);
      await assertNoPendingSlackInstall(row.companyId, row.endpointId);
      const current = await endpoint(row.endpointId, actor);
      const account = current.endpoint.setup.slackAccount;
      if (!account || account.status !== "linked") return;
      if (kind === "verification" && (!current.endpoint.setup.webhookVerifiedAt || account.welcomeStatus === "pending")) return;
      if (kind === "verification" && account.welcomeStatus !== "sent") throw setupMessagePending();
      const field = kind === "welcome" ? "welcomeStatus" : "verificationStatus";
      const status = account[field] ?? "pending";
      const recovery = setupMessageRecovery(row.companyId, row.endpointId, kind);
      const retained = await recovery.read();
      if (retained) {
        if (retained.kind !== "setup-message-settled" || status !== "sent" || retained.intent.originalAccount.externalUserId !== account.externalUserId ||
            retained.intent.originalAccount.paperclipUserId !== account.paperclipUserId || account.dmChannelId !== retained.decoded.channel || !options.runtimeBotCredential) throw setupMessagePending();
        const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
        for (const key of ["id", "companyId", "connectionId", "provider", "publicId", "assignedAgentId", "providerAccountId", "botExternalId"] as const) if (!same(current.endpoint[key], retained.intent.originalEndpoint[key])) throw setupMessagePending();
        if (!same(current.endpoint.setup.runtimeGeneration, (retained.intent.originalEndpoint.setup as Record<string, unknown> | undefined)?.runtimeGeneration)) throw setupMessagePending();
        for (const key of ["id", "companyId", "applicationId", "transport", "config", "credentialSecretRefs"] as const) if (!same(current.connection[key], retained.intent.originalConnection[key])) throw setupMessagePending();
        const registrationCurrent = await registration(row.endpointId);
        if (!registrationCurrent) throw setupMessagePending();
        for (const key of ["companyId", "endpointId", "requestId", "appId", "manifestHash", "managerGrantId", "workspaceId", "botUserId", "callbackUri"] as const) if (!same(registrationCurrent[key], retained.intent.originalRegistration[key])) throw setupMessagePending();
        const currentCredential = await options.runtimeBotCredential(row.endpointId);
        if (!same(currentCredential.identity, retained.intent.runtimeTokenIdentity) || setupMessageHash(currentCredential.value) !== retained.intent.tokenHash) throw setupMessagePending();
        return; // Exact retained original receipt, never a new post or backfill.
      }
      if (status !== "pending") throw setupMessagePending();
      if (!options.runtimeBotCredential) throw setupMessagePending();
      const credential = await options.runtimeBotCredential(row.endpointId);
      const params = { channel: account.dmChannelId ?? account.externalUserId,
        text: kind === "verification" ? "Your Slack connection is working! Now ask me a question about your Paperclip instance."
          : `Hi, I’m ${current.agentName}. Your Slack account is connected to Paperclip.`, unfurl_links: "false" as const, unfurl_media: "false" as const };
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
      const registrationNow = await registration(row.endpointId);
      if (!registrationNow || registrationNow.status !== "configured") throw setupMessagePending();
      const intent: SetupMessageIntent = { schema: 1, kind: "setup-message-intent", operationId: randomUUID(), companyId: row.companyId, endpointId: row.endpointId,
        messageKind: kind, actorUserId: actor.userId, actorSessionId: actor.sessionId ?? null, originalEndpoint: normalize(current.endpoint), originalConnection: normalize(current.connection),
        originalRegistration: normalize(registrationNow), originalAccount: normalize(account), runtimeTokenIdentity: credential.identity, tokenHash: setupMessageHash(credential.value), params,
        directApiAuthority: { apiBaseUrl: "https://slack.com/api/", method: "chat.postMessage" } };
      await lease.assertOwned();
      await recovery.begin(intent);
      await saveAccount(row, { ...account, [field]: "sending" }, actor, lease);
      let savingOutcome = false;
      try {
        const latest = await endpoint(row.endpointId, actor);
        const latestAccount = latest.endpoint.setup.slackAccount;
        const exact = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
        if (exact(normalize(latest.connection)) !== exact(intent.originalConnection) || !latestAccount || latestAccount[field] !== "sending" ||
            latestAccount.externalUserId !== account.externalUserId || latestAccount.paperclipUserId !== account.paperclipUserId ||
            latest.endpoint.setup.runtimeGeneration !== current.endpoint.setup.runtimeGeneration || !await options.canWelcome(row.endpointId, account)) throw setupMessagePending();
        const actual = await options.runtimeBotCredential(row.endpointId);
        if (exact(actual.identity) !== exact(intent.runtimeTokenIdentity) || setupMessageHash(actual.value) !== intent.tokenHash) throw setupMessagePending();
        await lease.assertOwned();
        let raw: import("../../../paperclip-cloud-connector.js").ConnectorRawResponse | undefined;
        const sent = await api("chat.postMessage", params, actual.value, undefined, async response => { await recovery.recordRaw({ intent, raw: response }); raw = response; });
        if (!raw) throw setupMessagePending();
        const result = await recovery.recordResult({ intent, raw, decoded: { channel: String(sent.channel ?? ""), ts: String(sent.ts ?? "") } });
        savingOutcome = true;
        await saveAccount(row, { ...account, [field]: "sent", dmChannelId: result.decoded.channel }, actor, lease);
        await recovery.recordSettlementReturned(result);
      } catch (error) {
        // An attempted SQL settlement may already have committed. Never rewrite
        // it from token/message equality or drop the independent raw result.
        let cause = error;
        if (!savingOutcome) {
          try { await saveAccount(row, { ...account, [field]: "uncertain" }, actor, lease); }
          catch (cleanupError) { cause = new AggregateError([error, cleanupError], "Setup message outcome and uncertainty persistence failed"); }
        }
        throw Object.assign(setupMessagePending(), { cause });
      }
      try { await audit(row, actor, `${kind}_sent`); }
      catch { logger.warn({ endpointId: row.endpointId, appId: row.appId }, "Slack setup message activity could not be recorded"); }
    });
  }
  async function welcome(row: Registration, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    await sendSetupMessage(row, actor, lease, "welcome");
    await sendSetupMessage(row, actor, lease, "verification");
  }
  async function notifyVerified(endpointId: string) {
    return options.withLock(endpointId, async lease => {
      const row = await registration(endpointId);
      if (!row || row.status !== "configured") return;
      await assertNoPendingSetupMessageForEndpoint(row.companyId, endpointId);
      await assertNoPendingRegistrationCleanupForEndpoint(row.companyId, endpointId);
      await assertNoPendingManagerClaimForEndpoint(row.companyId, endpointId);
      await assertNoPendingStagedCleanupForEndpoint(row.companyId, endpointId);
    await assertManagedInstallCompletionAllowed(row.companyId, endpointId);
    await assertNoPendingSlackInstall(row.companyId, endpointId);
      const [saved] = await db.select({ setup: chatEndpoints.setup, status: chatEndpoints.status }).from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
      const account = saved?.setup.slackAccount;
      if (!account || !["verifying", "active"].includes(saved.status)) return;
      await sendSetupMessage(row, { userId: account.paperclipUserId, sessionId: null, bypassPermissionCheck: false }, lease, "verification");
    });
  }
  function pendingVerificationMessages(limit: number) {
    return db.select({ endpointId: chatEndpoints.id }).from(chatEndpoints)
      .innerJoin(chatSlackRegistrations, and(eq(chatSlackRegistrations.endpointId, chatEndpoints.id), eq(chatSlackRegistrations.companyId, chatEndpoints.companyId)))
      .where(and(eq(chatSlackRegistrations.status, "configured"), inArray(chatEndpoints.status, ["verifying", "active"]),
        sql`${chatEndpoints.setup}->'slackAccount'->>'status' = 'linked'`,
        sql`${chatEndpoints.setup}->>'webhookVerifiedAt' is not null`,
        sql`coalesce(${chatEndpoints.setup}->'slackAccount'->>'welcomeStatus', '') not in ('pending', 'sending')`,
        sql`${chatEndpoints.setup}->'slackAccount'->>'verificationStatus' in ('pending', 'sending')`)).limit(limit);
  }
  async function nextVerificationMessageAt(): Promise<number | null> {
    return (await pendingVerificationMessages(1)).length ? Date.now() : null;
  }
  async function processPendingVerificationMessages(limit = 25) {
    for (const row of await pendingVerificationMessages(limit)) {
      try { await notifyVerified(row.endpointId); }
      catch { logger.warn({ endpointId: row.endpointId }, "Slack verification message could not be processed"); }
    }
  }
  async function resumeLocked(endpointId: string, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard, internal?: { deferStagedCleanup?: boolean }) {
    const current = await endpoint(endpointId, actor);
    const row = await registration(endpointId);
    if (!row || row.status === "removed") throw conflict("Slack registration is unavailable");
    await assertNoPendingStagedCleanupForEndpoint(row.companyId, endpointId);
    await assertManagedInstallCompletionAllowed(row.companyId, endpointId, internal?.deferStagedCleanup === true);
    await assertNoPendingSlackInstall(row.companyId, endpointId);
    if (row.status === "configured") { if (!internal?.deferStagedCleanup) await cleanupStaged(endpointId, actor, lease); await welcome(row, actor, lease); return; }
    if (row.status !== "credentials_saved") throw conflict("Install this Slack app before connecting it");
    try {
      assertOrigins(row, current.endpoint.publicId);
      const botToken = await readSecret(row, "botToken");
      const auth = await api("auth.test", {}, botToken, row.managerGrantId ? [...SLACK_CHAT_BOT_SCOPES, ...SLACK_BOT_TOOL_SCOPES] : undefined);
      if (auth.team_id !== row.workspaceId || row.botUserId && auth.user_id !== row.botUserId || typeof auth.user_id !== "string" || !/^[UW][A-Z0-9]+$/.test(auth.user_id)) throw providerFailure("slack_install_identity_mismatch");
      if (row.managerGrantId) {
        if (typeof auth.bot_id !== "string" || !/^B[A-Z0-9]+$/.test(auth.bot_id)) throw providerFailure("slack_install_identity_mismatch");
        const bot = object((await api("bots.info", { bot: auth.bot_id }, botToken)).bot);
        if (bot.id !== auth.bot_id || bot.app_id !== row.appId || bot.user_id !== auth.user_id || bot.deleted !== false) throw providerFailure("slack_install_identity_mismatch");
      }
      if (!row.botUserId) {
        if (!row.managerGrantId) throw providerFailure("slack_install_identity_mismatch");
        await lease.assertOwned();
        await db.update(chatSlackRegistrations).set({ botUserId: auth.user_id }).where(eq(chatSlackRegistrations.endpointId, endpointId));
      }
      await options.configure(endpointId, { botToken, signingSecret: row.secretIds.signingSecret
        ? await readSecret(row, "signingSecret") : await options.runtimeSigningSecret(endpointId) }, actor, {
          assertOwned: async database => {
            await lease.assertOwned(database);
            await endpoint(endpointId, actor);
            assertOrigins(row, current.endpoint.publicId);
          },
        });
      await linkAccount(row, actor, lease);
    } catch (error) {
      const code = object(object(error).details).code;
      const safeCode = code === "slack_configuration_token_invalid" ? "slack_install_token_invalid" : code === "slack_install_account_missing" ? code : code === "chat_identity_link_conflict" || code === "chat_identity_already_linked" ? "slack_install_account_conflict" : code === "slack_install_identity_mismatch" || code === "chat_bot_identity_changed"
        ? "slack_install_identity_mismatch" : (code === "chat_provider_permissions_missing" || code === "slack_install_scopes_missing" || code === "slack_setup_permission_denied") ? "slack_install_scopes_missing"
        : code === "chat_bot_identity_in_use" ? "slack_bot_already_connected" : "slack_configuration_incomplete";
      await setFailure(row, "credentials_saved", safeCode, lease);
      await audit(row, actor, "configuration_failed", safeCode);
      return;
    }
    await lease.assertOwned();
    await db.transaction(async tx => {
      await notifyChatVerificationWork(tx);
      await tx.update(chatSlackRegistrations).set({ status: "configured", errorCode: null, updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
    });
    // Runtime now owns a separate vaulted copy. Keep the registration IDs until
    // deletion succeeds so cleanup itself is retryable.
    if (!internal?.deferStagedCleanup) await cleanupStaged(endpointId, actor, lease);
    try { await audit(row, actor, "installation_completed"); }
    catch { logger.warn({ endpointId, appId: row.appId }, "Slack installation activity could not be recorded"); }
    await welcome(row, actor, lease);
  }
  async function cleanupStaged(endpointId: string, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    const selected = await endpoint(endpointId, actor);
    return withAccountHomeSecretMutationLock(undefined, selected.endpoint.companyId, async () => {
      const current = await endpoint(endpointId, actor);
      const row = await registration(endpointId);
      if (!row || row.status !== "configured") return;
      await assertNoPendingSetupMessageForEndpoint(row.companyId, endpointId);
      await assertNoPendingRegistrationCleanupForEndpoint(row.companyId, endpointId);
      await assertNoPendingStagedCleanupForEndpoint(row.companyId, endpointId);
      await assertNoPendingManagedInstallForEndpoint(row.companyId, endpointId);
      await assertNoPendingManagerClaimForEndpoint(row.companyId, endpointId);
      await assertNoPendingSlackInstall(row.companyId, endpointId);
      const targets: RegistrationCleanupIntent["targets"] = {}, nextSecretIds = { ...row.secretIds };
      for (const key of ["botToken", "signingSecret"] as const) if (nextSecretIds[key]) {
        const id = nextSecretIds[key];
        targets[id] = { key, identity: await readSecretRecoveryIdentity(db, row.companyId, id), tokenOperationId: randomUUID() };
        delete nextSecretIds[key];
      }
      if (!Object.keys(targets).length) return;
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
      const exact = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
      const intent: RegistrationCleanupIntent = { schema: 1, kind: "registration-cleanup-intent", family: "slack.registration.staged-cleanup", operationId: randomUUID(), companyId: row.companyId, endpointId,
        actorUserId: actor.userId, actorSessionId: actor.sessionId ?? null, originalEndpoint: normalize(current.endpoint), originalConnection: normalize(current.connection), originalRegistration: normalize(row), targets, nextSecretIds };
      await assertNoPendingManagerRefreshForActor(row.companyId, actor.userId);
      await assertNoPendingManagerRevokeForActor(row.companyId, actor.userId);
      await lease.assertOwned();
      const recovery = registrationCleanupRecovery(row.companyId, endpointId);
      await recovery.begin(intent);
      const started = await recovery.read();
      if (!started) throw registrationCleanupPending();
      const assertOriginal = async () => {
        const control = await endpoint(endpointId, actor);
        const registrationNow = await registration(endpointId);
        if (exact(normalize(control.endpoint)) !== exact(intent.originalEndpoint) || exact(normalize(control.connection)) !== exact(intent.originalConnection) || exact(normalize(registrationNow ?? null)) !== exact(intent.originalRegistration)) throw registrationCleanupPending();
        await assertNoPendingManagerRefreshForActor(row.companyId, actor.userId);
        await assertNoPendingManagerRevokeForActor(row.companyId, actor.userId);
      };
      await withRegistrationCleanup(started, async () => {
        for (const [id, target] of Object.entries(targets)) {
          await assertOriginal();
          await lease.assertOwned();
          if (exact(await readSecretRecoveryIdentity(db, row.companyId, id)) !== exact(target.identity)) throw registrationCleanupPending();
          const removed = await vault.remove(id);
          if (!removed || removed.id !== id) throw registrationCleanupPending();
          await recovery.recordRemovalReturned({ intent, secretId: id });
        }
        await assertOriginal();
        await db.transaction(async tx => {
          await lease.assertOwned(tx);
          const [latest] = await tx.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpointId)).for("update");
          if (exact(normalize(latest ?? null)) !== exact(intent.originalRegistration)) throw registrationCleanupPending();
          await tx.update(chatSlackRegistrations).set({ secretIds: nextSecretIds }).where(eq(chatSlackRegistrations.endpointId, endpointId));
        });
        const completed = await recovery.read();
        if (!completed) throw registrationCleanupPending();
        await recovery.clear(completed);
      });
    });
  }
  return { resumeLocked, notifyVerified, processPendingVerificationMessages, nextVerificationMessageAt };
}
