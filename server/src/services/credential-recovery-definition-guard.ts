import { assertNoPendingQuotaCredentialForDefinition } from "./quota-credential-recovery.js";
import { assertNoPendingSlackInstallForDefinition } from "./connectors/slack/setup/install-recovery.js";
import { assertNoPendingManagerRefreshForDefinition } from "./connectors/slack/setup/manager-refresh-recovery.js";
import { assertNoPendingManagerClaimForDefinition } from "./connectors/slack/setup/manager-claim-recovery.js";
import { assertNoPendingManagerRevokeForDefinition } from "./connectors/slack/setup/manager-revoke-recovery.js";
import { assertNoPendingManagedInstallForDefinition } from "./connectors/slack/setup/managed-install-recovery.js";
import { assertNoPendingStagedCleanupForDefinition } from "./connectors/slack/setup/staged-cleanup-recovery.js";
import { assertNoPendingRegistrationCleanupForDefinition } from "./connectors/slack/setup/registration-cleanup-recovery.js";
import { assertNoPendingSetupMessageForDefinition } from "./connectors/slack/setup/setup-message-recovery.js";

/** Prospective local mutation gate. The caller holds the company credential
 * mutation lock. Retained originals, rather than mutable FK references, decide
 * occupancy; this does not establish a physical effect or retirement receipt. */
export async function assertCredentialRecoveryDefinitionMutationAllowed(companyId: string, definitionId: string) {
  await assertNoPendingQuotaCredentialForDefinition(companyId, definitionId);
  await assertNoPendingSlackInstallForDefinition(companyId, definitionId);
  await assertNoPendingManagerRefreshForDefinition(companyId, definitionId);
  await assertNoPendingManagerClaimForDefinition(companyId, definitionId);
  await assertNoPendingManagerRevokeForDefinition(companyId, definitionId);
  await assertNoPendingManagedInstallForDefinition(companyId, definitionId);
  await assertNoPendingStagedCleanupForDefinition(companyId, definitionId);
  await assertNoPendingRegistrationCleanupForDefinition(companyId, definitionId);
  await assertNoPendingSetupMessageForDefinition(companyId, definitionId);
}
