import { assertNoPendingSetupMessageForEndpoint } from "./connectors/slack/setup/setup-message-recovery.js";
import { assertNoPendingRegistrationCleanupForEndpoint } from "./connectors/slack/setup/registration-cleanup-recovery.js";
import { assertNoPendingStagedCleanupForEndpoint } from "./connectors/slack/setup/staged-cleanup-recovery.js";
import { assertNoPendingManagedInstallForEndpoint } from "./connectors/slack/setup/managed-install-recovery.js";
import { assertNoPendingManagerClaimForEndpoint } from "./connectors/slack/setup/manager-claim-recovery.js";
import { conflict } from "../errors.js";
import { assertNoPendingSlackInstall } from "./connectors/slack/setup/install-recovery.js";
import { and, eq, like } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, toolOauthStates, type Db } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import type { CredentialMutationLeaseGuard } from "./chat-credential-mutation-lease.js";

// Keep generic connection removal independent of the registration service's
// authorization graph; access routes already load tool-access through the barrel.
export async function removeSlackRegistration(db: Db, endpointId: string, lease: CredentialMutationLeaseGuard) {
  await lease.assertOwned();
  const vault = secretService(db);
  const [row] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpointId));
  const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
  const companyId = row?.companyId ?? endpoint?.companyId;
  if (companyId) {
    try { await assertNoPendingSetupMessageForEndpoint(companyId, endpointId); await assertNoPendingRegistrationCleanupForEndpoint(companyId, endpointId); await assertNoPendingStagedCleanupForEndpoint(companyId, endpointId); await assertNoPendingManagedInstallForEndpoint(companyId, endpointId); await assertNoPendingManagerClaimForEndpoint(companyId, endpointId); await assertNoPendingSlackInstall(companyId, endpointId); }
    catch { throw conflict("Slack installation recovery requires inspection before cleanup.", { code: "slack_install_recovery_pending" }); }
  }
  if (endpoint) await db.delete(toolOauthStates).where(and(eq(toolOauthStates.connectionId, endpoint.connectionId), like(toolOauthStates.state, "slack-manager.%")));
  if (!row) return;
  await lease.assertOwned();
  await db.update(chatSlackRegistrations).set({ status: "removed", updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
  const [current] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
  if (current) await db.delete(toolOauthStates).where(and(eq(toolOauthStates.connectionId, current.connectionId), like(toolOauthStates.state, "slack-install.%")));
  for (const id of Object.values(row.secretIds)) { await lease.assertOwned(); await vault.remove(id); }
  await lease.assertOwned();
  await db.update(chatSlackRegistrations).set({ secretIds: {} }).where(eq(chatSlackRegistrations.endpointId, endpointId));
}
