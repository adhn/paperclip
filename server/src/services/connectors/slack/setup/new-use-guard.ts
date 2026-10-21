import { assertNoPendingSlackInstall } from "./install-recovery.js";
import { assertNoPendingManagerClaimForEndpoint, assertNoPendingManagerClaimForActor, assertNoPendingManagerClaimForCompany } from "./manager-claim-recovery.js";
import { assertNoPendingManagerRefreshForActor, assertNoPendingManagerRefreshForCompany } from "./manager-refresh-recovery.js";
import { assertNoPendingManagerRevokeForActor, assertNoPendingManagerRevokeForCompany } from "./manager-revoke-recovery.js";
import { assertNoPendingManagedInstallForEndpoint, assertManagedInstallCompletionAllowed } from "./managed-install-recovery.js";
import { assertNoPendingStagedCleanupForEndpoint } from "./staged-cleanup-recovery.js";
import { assertNoPendingRegistrationCleanupForEndpoint } from "./registration-cleanup-recovery.js";
import { assertNoPendingSetupMessageForEndpoint } from "./setup-message-recovery.js";
export type SlackSetupUse = { companyId: string; endpointId: string; actorUserId?: string | null };
async function otherOriginalFamilies(input: SlackSetupUse) {
  const { companyId, endpointId, actorUserId } = input;
  await assertNoPendingSlackInstall(companyId, endpointId);
  await assertNoPendingManagerClaimForEndpoint(companyId, endpointId);
  await assertNoPendingStagedCleanupForEndpoint(companyId, endpointId);
  await assertNoPendingRegistrationCleanupForEndpoint(companyId, endpointId);
  await assertNoPendingSetupMessageForEndpoint(companyId, endpointId);
  if (actorUserId) {
    await assertNoPendingManagerClaimForActor(companyId, actorUserId);
    await assertNoPendingManagerRefreshForActor(companyId, actorUserId);
    await assertNoPendingManagerRevokeForActor(companyId, actorUserId);
  } else {
    // Missing trusted caller identity cannot narrow an unresolved manager hold.
    await assertNoPendingManagerClaimForCompany(companyId);
    await assertNoPendingManagerRefreshForCompany(companyId);
    await assertNoPendingManagerRevokeForCompany(companyId);
  }
}
/** Before a prospective operation, never inside an already admitted exchange. */
export async function assertSlackSetupNewUse(input: SlackSetupUse) {
  await otherOriginalFamilies(input);
  await assertNoPendingManagedInstallForEndpoint(input.companyId, input.endpointId);
}
/** The only exemption is the actual active exact originating managed result. */
export async function assertSlackSetupConfigurationUse(input: SlackSetupUse) {
  await otherOriginalFamilies(input);
  await assertManagedInstallCompletionAllowed(input.companyId, input.endpointId);
}
