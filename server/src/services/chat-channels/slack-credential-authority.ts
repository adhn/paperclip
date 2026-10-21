import { readSecretRecoveryIdentity } from "../secret-recovery-identity.js";
import type { Db } from "@paperclipai/db";
import type { EndpointRecord } from "./runtime-types.js";

/** Exact local credential predecessor; no physical custody or outcome receipt. */
export async function readSlackCredentialAuthority(db: Db, record: EndpointRecord) {
  const refs = record.credentialSecretRefs;
  if (!Array.isArray(refs) || refs.filter(ref => ref.configPath === "credentials.botToken").length !== 1 ||
      new Set(refs.map(ref => ref.configPath)).size !== refs.length ||
      refs.some(ref => typeof ref.secretId !== "string" || !ref.configPath.startsWith("credentials.")))
    throw new Error("Slack credential references require exact inspection");
  const identities = [];
  for (const ref of refs) {
    if (ref.versionSelector !== undefined && ref.versionSelector !== "latest") throw new Error("Slack credential version requires exact inspection");
    identities.push(await readSecretRecoveryIdentity(db, record.endpoint.companyId, ref.secretId));
  }
  return structuredClone({ refs, identities,
    connection: { id: record.connection.id, companyId: record.connection.companyId,
      applicationId: record.connection.applicationId, status: record.connection.status,
      enabled: record.connection.enabled, config: record.connection.config },
    endpoint: { id: record.endpoint.id, companyId: record.endpoint.companyId, connectionId: record.endpoint.connectionId,
      provider: record.endpoint.provider, status: record.endpoint.status, assignedAgentId: record.endpoint.assignedAgentId,
      providerAccountId: record.endpoint.providerAccountId, botExternalId: record.endpoint.botExternalId,
      capabilities: record.endpoint.capabilities, concurrencyPolicy: record.endpoint.concurrencyPolicy },
  });
}
