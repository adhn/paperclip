import { and, eq } from "drizzle-orm";
import { companySecrets, companySecretVersions, companySecretProviderConfigs, userSecretDefinitions, type Db } from "@paperclipai/db";

import type { SecretRecoveryIdentity } from "./secret-recovery-identity-schema.js";
export type { SecretRecoveryIdentity } from "./secret-recovery-identity-schema.js";

/** One local SQL snapshot for exact predecessor comparison. This is neither a
 * committed effect receipt nor proof of external provider/key/session custody. */
export async function readSecretRecoveryIdentity(db: Db, companyId: string, secretId: string): Promise<SecretRecoveryIdentity> {
  const [found] = await db.select({ parent: companySecrets, version: companySecretVersions,
    providerConfig: companySecretProviderConfigs, definition: userSecretDefinitions,
  }).from(companySecrets).innerJoin(companySecretVersions, and(
    eq(companySecretVersions.secretId, companySecrets.id), eq(companySecretVersions.version, companySecrets.latestVersion),
  )).leftJoin(companySecretProviderConfigs, eq(companySecretProviderConfigs.id, companySecrets.providerConfigId))
    .leftJoin(userSecretDefinitions, eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId))
    .where(and(eq(companySecrets.id, secretId), eq(companySecrets.companyId, companyId)));
  if (!found) throw new Error("credentials_unavailable");
  const parent = Object.fromEntries(Object.entries(found.parent)
    .filter(([key]) => key !== "lastResolvedAt" && key !== "updatedAt"));
  const config = found.providerConfig;
  if ((found.parent.providerConfigId && !config) || (found.parent.userSecretDefinitionId && !found.definition)) {
    throw new Error("credentials_unavailable");
  }
  return JSON.parse(JSON.stringify({ secretId, versionId: found.version.id, version: found.version.version,
    authority: { parent, version: found.version, definition: found.definition ?? null,
      providerConfig: config ? { id: config.id, companyId: config.companyId, provider: config.provider,
        status: config.status, config: config.config, disabledAt: config.disabledAt } : null },
  })) as SecretRecoveryIdentity;
}
