import { assertNoPendingSetupMessageForActor } from "./setup-message-recovery.js";
import { assertNoPendingRegistrationCleanupForActor } from "./registration-cleanup-recovery.js";
import { stagedCleanupRecovery, stagedCleanupHash, assertNoPendingStagedCleanupForActor, withStagedCleanup, type StagedCleanupIntent } from "./staged-cleanup-recovery.js";
import { secretService } from "../../../secrets.js";
import { readSecretRecoveryIdentity } from "../../../secret-recovery-identity.js";
import { randomUUID } from "node:crypto";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { managedInstallRecovery, managedInstallHash, managedInstallPending, assertNoPendingManagedInstallForActor, assertNoPendingManagedInstallForEndpoint, withManagedInstallSettlement, type ManagedInstallIntent } from "./managed-install-recovery.js";
import { and, eq } from "drizzle-orm";
import { chatActions, chatSlackRegistrations } from "@paperclipai/db";
import { type SlackManagedProvisionInput, type SlackManagedResult } from "@paperclipai/shared";
import { conflict } from "../../../../errors.js";
import type { createCustomerOwnedSetup } from "./customer-owned.js";
import type { createSlackManagerGrants } from "./manager-grants.js";
import type { createSlackCompletion } from "./completion.js";
import { object, providerFailure, type SlackRegistrationStore, type SlackSetupActor } from "./registration.js";

/** Managed provisioning ends at the same saved-credential boundary as child OAuth. */
export function createManagedSlackSetup(store: SlackRegistrationStore, grants: ReturnType<typeof createSlackManagerGrants>,
  provisioner: ReturnType<typeof createCustomerOwnedSetup>, completion: ReturnType<typeof createSlackCompletion>,
  installFallback: (endpointId: string, actor: SlackSetupActor) => Promise<{ authorizationUrl: string; expiresAt: string }>) {
  async function provision(endpointId: string, actor: SlackSetupActor, input: SlackManagedProvisionInput): Promise<SlackManagedResult> {
    const current = await store.endpoint(endpointId, actor);
    if (current.endpoint.setup.slackSetupMethod !== "managed") throw conflict("Resume the selected Slack setup method");
    await assertNoPendingSetupMessageForActor(current.endpoint.companyId, actor.userId);
    await assertNoPendingRegistrationCleanupForActor(current.endpoint.companyId, actor.userId);
    await assertNoPendingStagedCleanupForActor(current.endpoint.companyId, actor.userId);
    await assertNoPendingManagedInstallForActor(current.endpoint.companyId, actor.userId);
    await assertNoPendingManagedInstallForEndpoint(current.endpoint.companyId, endpointId);
    const authorized = await grants.token(input.grantId, current.endpoint.companyId, actor);
    await provisioner.create(endpointId, actor, { requestId: input.requestId, confirmedNoAppCreated: input.confirmedNoAppCreated,
      credentials: { configurationToken: authorized.token } }, { grantId: authorized.grant.id, workspaceId: authorized.grant.workspaceId, request: (method, fields) => grants.request(input.grantId, current.endpoint.companyId, actor, method, fields) });
    await store.options.withLock(endpointId, async lease => {
      const preparedOperation = await withAccountHomeSecretMutationLock(undefined, current.endpoint.companyId, async () => {
        await assertNoPendingSetupMessageForActor(current.endpoint.companyId, actor.userId);
        await assertNoPendingRegistrationCleanupForActor(current.endpoint.companyId, actor.userId);
        await assertNoPendingStagedCleanupForActor(current.endpoint.companyId, actor.userId);
        await assertNoPendingManagedInstallForActor(current.endpoint.companyId, actor.userId);
        await assertNoPendingManagedInstallForEndpoint(current.endpoint.companyId, endpointId);
        const latest = await store.endpoint(endpointId, actor);
        const row = await store.registration(endpointId);
        if (!row?.appId || row.status === "removed" || row.errorCode === "slack_manifest_update_pending") return { kind: "none" as const };
        if (row.managerGrantId !== authorized.grant.id || latest.endpoint.setup.slackSetupMethod !== "managed") throw conflict("Slack setup changed");
        store.assertOrigins(row, latest.endpoint.publicId);
        const reconnectKey = input.reconnect ? `slack_managed_reconnect:${actor.userId}:${input.requestId}` : null;
        const [previous] = reconnectKey ? await store.db.select().from(chatActions).where(and(eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, endpointId), eq(chatActions.providerActionId, reconnectKey))) : [];
        async function completeSaved(expectedAction?: Record<string, unknown> | null, deferStagedCleanup = false) {
          await completion.resumeLocked(endpointId, actor, lease, deferStagedCleanup ? { deferStagedCleanup: true } : undefined);
          if (reconnectKey && (await store.registration(endpointId))?.status === "configured") {
            await lease.assertOwned();
            await store.db.transaction(async tx => {
              const [action] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, row!.companyId), eq(chatActions.endpointId, endpointId), eq(chatActions.providerActionId, reconnectKey))).for("update");
              const exact = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
              if (expectedAction && exact(JSON.parse(JSON.stringify(action ?? null))) !== exact(expectedAction)) throw managedInstallPending();
              await lease.assertOwned(tx);
              await tx.update(chatActions).set({ status: "processed", updatedAt: new Date() }).where(and(eq(chatActions.companyId, row!.companyId), eq(chatActions.endpointId, endpointId), eq(chatActions.providerActionId, reconnectKey)));
            });
          }
        }
        if (previous && row.status === "configured" && !["revoked", "attention"].includes(latest.endpoint.status)) {
          return { kind: "complete" as const, completeSaved };
        }
        const needsReinstall = row.status === "configured" && (input.reconnect || ["revoked", "attention"].includes(latest.endpoint.status))
          || row.status === "credentials_saved" && ["slack_install_token_invalid", "slack_install_scopes_missing"].includes(row.errorCode ?? "");
        if (reconnectKey && !previous) {
          // Atomically bind an explicit reconnect to its durable installation intent.
          // Duplicate requests can return the saved connection without reinstalling.
          await store.db.transaction(async tx => {
            await lease.assertOwned(tx);
            await tx.insert(chatActions).values({ companyId: row.companyId, endpointId, kind: "slack_managed_reconnect", providerActionId: reconnectKey, status: "processing", payload: { grantId: row.managerGrantId, registrationRequestId: row.requestId } });
            if (needsReinstall) await tx.update(chatSlackRegistrations).set({ status: "install", errorCode: row.errorCode ?? "slack_install_failed", updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
          });
        }
        if ((row.status === "configured" || row.status === "credentials_saved") && !needsReinstall) {
          return { kind: "complete" as const, completeSaved };
        }
        // Keep reinstall intent durable even if this dispatch fails or the process exits.
        if (needsReinstall && (!reconnectKey || previous)) await store.setFailure(row, "install", row.errorCode ?? "slack_install_failed", lease);
        const prepared = await grants.prepareManagedInstall(input.grantId, row.companyId, actor);
        const grant = prepared.grant;
        const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
        const registrationSecrets: ManagedInstallIntent["originalRegistrationSecrets"] = {};
        for (const [key, id] of Object.entries(row.secretIds)) {
          registrationSecrets[id] = { identity: await store.readSecretIdentity(row, key), valueHash: managedInstallHash(await store.readSecret(row, key)) };
        }
        const preparedCurrent = await store.endpoint(endpointId, actor);
        const preparedRegistration = await store.registration(endpointId);
        const [preparedAction] = reconnectKey ? await store.db.select().from(chatActions).where(and(eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, endpointId), eq(chatActions.providerActionId, reconnectKey))) : [];
        const recovery = managedInstallRecovery(row.companyId, endpointId);
        const intent: ManagedInstallIntent = { schema: 1, kind: "managed-install-intent", family: "slack.apps.managedInstall", operationId: randomUUID(), companyId: row.companyId, endpointId,
          actorUserId: actor.userId, actorSessionId: actor.sessionId ?? null, originalEndpoint: normalize(latest.endpoint), originalConnection: normalize(latest.connection), originalRegistration: normalize(row),
          preparedEndpoint: normalize(preparedCurrent.endpoint), preparedRegistration: normalize(preparedRegistration ?? null), originalAction: normalize(previous ?? null), preparedAction: normalize(preparedAction ?? null),
          originalManagerGrant: normalize(grant), originalManagerSecrets: prepared.secrets, originalRegistrationSecrets: registrationSecrets, requestId: row.requestId, requestedRequestId: input.requestId,
          reconnectKey, appId: row.appId, manifestHash: row.manifestHash, params: { app_id: row.appId, team_id: grant.workspaceId },
          directApiAuthority: { method: "apps.managedInstall", apiBaseUrl: "https://slack.com/api/", managerAppId: grant.managerAppId, workspaceId: grant.workspaceId, slackUserId: grant.slackUserId } };
        await lease.assertOwned();
        await recovery.begin(intent);
        return { kind: "dispatch" as const, row, grant, intent, recovery, reconnectKey, completeSaved, normalize };
      });
      if (preparedOperation.kind === "none") return;
      if (preparedOperation.kind === "complete") { await preparedOperation.completeSaved(); return; }
      const { row, grant, intent, recovery, reconnectKey, completeSaved, normalize } = preparedOperation;
      let saveAttempted = false;
      try {
        await lease.assertOwned();
        const result = await grants.dispatchManagedInstall(intent, actor, lease);
        const botToken = result.decoded.botToken;
        const exact = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
        await withManagedInstallSettlement(result, async () => {
          await withAccountHomeSecretMutationLock(undefined, row.companyId, async () => {
            const beforeSave = await store.endpoint(endpointId, actor);
            if (exact(normalize(beforeSave.endpoint)) !== exact(intent.preparedEndpoint) || exact(normalize(beforeSave.connection)) !== exact(intent.originalConnection) ||
                exact(normalize(await store.registration(endpointId))) !== exact(intent.preparedRegistration) || exact(normalize(await grants.get(grant.id, row.companyId, actor))) !== exact(intent.originalManagerGrant)) throw managedInstallPending();
            if (reconnectKey) {
              const [action] = await store.db.select().from(chatActions).where(and(eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, endpointId), eq(chatActions.providerActionId, reconnectKey)));
              if (exact(normalize(action ?? null)) !== exact(intent.preparedAction)) throw managedInstallPending();
            }
            for (const [id, original] of Object.entries({ ...intent.originalManagerSecrets, ...intent.originalRegistrationSecrets })) {
              if (exact(await readSecretRecoveryIdentity(store.db, row.companyId, id)) !== exact(original.identity)) throw managedInstallPending();
            }
            saveAttempted = true;
            // The exact result remains held through credential persistence and
            // application completion. A lost acknowledgement never permits replay.
            await store.saveSecrets(row, { botToken }, actor, lease, { status: "credentials_saved", workspaceId: grant.workspaceId, errorCode: null },
              { externalUserId: grant.slackUserId, paperclipUserId: actor.userId, status: "pending", welcomeStatus: "pending" });
          });
          // Runtime invalidation may join admitted callbacks which themselves
          // acquire the company lock. Keep only the endpoint lease and exact
          // result capability while the actual completion joins them.
          await completeSaved(intent.preparedAction, true);
          await withAccountHomeSecretMutationLock(undefined, row.companyId, async () => {
            await lease.assertOwned();
            const cleanupControl = await store.endpoint(endpointId, actor);
            const finalized = await store.registration(endpointId);
            if (finalized?.status !== "configured") throw managedInstallPending();
            const targets: StagedCleanupIntent["targets"] = {};
            const nextSecretIds = { ...finalized.secretIds };
            for (const key of ["botToken", "signingSecret"] as const) if (nextSecretIds[key]) {
              const id = nextSecretIds[key];
              targets[id] = { key, identity: await readSecretRecoveryIdentity(store.db, row.companyId, id), tokenOperationId: randomUUID() };
              delete nextSecretIds[key];
            }
            if (!Object.keys(targets).length) { await recovery.clear(result); return; }
            const cleanup = stagedCleanupRecovery(row.companyId, endpointId);
            const cleanupIntent: StagedCleanupIntent = { schema: 1, kind: "staged-cleanup-intent", operationId: randomUUID(), companyId: row.companyId, endpointId,
              actorUserId: actor.userId, actorSessionId: actor.sessionId ?? null, parentManagedOperationId: intent.operationId, parentResultHash: stagedCleanupHash(result),
              originalEndpoint: normalize(cleanupControl.endpoint), originalConnection: normalize(cleanupControl.connection),
              originalRegistration: normalize(finalized), targets, nextSecretIds };
            await cleanup.begin(cleanupIntent);
            const started = await cleanup.read();
            if (!started) throw managedInstallPending();
            const assertOriginalCleanup = async () => {
              await lease.assertOwned();
              const control = await store.endpoint(endpointId, actor);
              const registrationNow = await store.registration(endpointId);
              if (exact(normalize(control.endpoint)) !== exact(cleanupIntent.originalEndpoint) ||
                  exact(normalize(control.connection)) !== exact(cleanupIntent.originalConnection) ||
                  exact(normalize(registrationNow ?? null)) !== exact(cleanupIntent.originalRegistration)) throw managedInstallPending();
            };
            await withStagedCleanup(started, async () => {
              for (const id of Object.keys(targets)) {
                await assertOriginalCleanup();
                if (exact(await readSecretRecoveryIdentity(store.db, row.companyId, id)) !== exact(targets[id].identity)) throw managedInstallPending();
                const removed = await secretService(store.db).remove(id);
                if (!removed || removed.id !== id) throw managedInstallPending();
                await cleanup.recordRemovalReturned({ intent: cleanupIntent, secretId: id });
              }
              await assertOriginalCleanup();
              await store.db.transaction(async tx => {
                await lease.assertOwned(tx);
                await assertOriginalCleanup();
                const [registrationNow] = await tx.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpointId)).for("update");
                if (exact(normalize(registrationNow ?? null)) !== exact(cleanupIntent.originalRegistration)) throw managedInstallPending();
                await tx.update(chatSlackRegistrations).set({ secretIds: nextSecretIds }).where(eq(chatSlackRegistrations.endpointId, endpointId));
              });
              const completedCleanup = await cleanup.read();
              if (!completedCleanup) throw managedInstallPending();
              await recovery.clear(result);
              await cleanup.clear(completedCleanup);
            });
          });
        });
      } catch (error) {
        const code = object(object(error).details).code;
        const safe = typeof code === "string" ? code : "slack_install_failed";
        // Any dispatch/result/SQL/final-reply uncertainty retains the original
        // family. In particular, never overwrite an independently saved result
        // using the stale pre-install registration or start OAuth fallback.
        let failure = error;
        if (!saveAttempted) {
          try { await store.audit(row, actor, "installation_failed", safe); }
          catch (auditError) { failure = new AggregateError([error, auditError], "Managed installation and failure audit both failed"); }
        }
        throw Object.assign(managedInstallPending(), { cause: failure });
      }
    });
    // OAuth's state/actor binding is ours; never trust a provider-supplied redirect.
    return {};
  }
  return { provision };
}
