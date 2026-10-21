import { quotaOwnerIdentitySchema } from "./quota-owner-identity-schema.js";
import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { secretRecoveryIdentitySchema, type SecretRecoveryIdentity } from "./secret-recovery-identity-schema.js";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { ensureDurableDirectory, syncDirectory } from "../lib/durable-directory.js";
import { idleQuotaRecoveryPath } from "./idle-local-work.js";

const identitySchema = z.object({
  companyId: z.string().uuid(), grantId: z.string().uuid(), connectionId: z.string().uuid(), secretId: z.string().uuid(),
  baseHash: z.string().length(64),
});
const recoverySchema = identitySchema.extend({ value: z.string().min(1) }).strict();
const exchangeIntentSchema = identitySchema.extend({
  schema: z.literal(1), kind: z.literal("exchange-intent"), operationId: z.string().uuid(),
  originalSecretIdentity: secretRecoveryIdentitySchema, originalOwnerIdentity: quotaOwnerIdentitySchema,
}).strict().refine(entry => entry.originalSecretIdentity.secretId === entry.secretId &&
  entry.originalOwnerIdentity.connection.id === entry.connectionId && entry.originalOwnerIdentity.connection.companyId === entry.companyId &&
  entry.originalOwnerIdentity.grant.id === entry.grantId && entry.originalOwnerIdentity.grant.connectionId === entry.connectionId && entry.originalOwnerIdentity.grant.companyId === entry.companyId,
  "Exchange intent must retain its original secret identity");
const exchangeResultSchema = identitySchema.extend({
  schema: z.literal(1), kind: z.literal("exchange-result"), operationId: z.string().uuid(),
  intent: exchangeIntentSchema, originalSecretIdentity: secretRecoveryIdentitySchema, originalOwnerIdentity: quotaOwnerIdentitySchema, value: z.string().min(1),
}).strict().refine(entry => ["companyId", "grantId", "connectionId", "secretId", "baseHash", "operationId", "originalSecretIdentity", "originalOwnerIdentity"]
  .every(key => isDeepStrictEqual(entry[key as keyof typeof entry], entry.intent[key as keyof typeof entry.intent])),
"Exchange result must retain its exact original intent");
const entrySchema = z.union([exchangeIntentSchema, exchangeResultSchema, recoverySchema]);
export type QuotaExchangeIntent = z.infer<typeof exchangeIntentSchema>;
export type QuotaExchangeResult = z.infer<typeof exchangeResultSchema>;
export type QuotaCredentialRecoveryEntry = z.infer<typeof entrySchema>;
export const isQuotaExchangeIntent = (entry: QuotaCredentialRecoveryEntry): entry is QuotaExchangeIntent =>
  "kind" in entry && entry.kind === "exchange-intent";
export const isQuotaExchangeResult = (entry: QuotaCredentialRecoveryEntry): entry is QuotaExchangeResult =>
  "kind" in entry && entry.kind === "exchange-result";
export const quotaCredentialHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const quotaCredentialRecoveryPath = (companyId: string, grantId: string) =>
  path.join(idleQuotaRecoveryPath(), z.string().uuid().parse(companyId), `${z.string().uuid().parse(grantId)}.json`);

/** Enumerate retained original identities rather than relying on mutable SQL
 * references. Caller holds the company credential mutation lock. This is local
 * fail-closed inspection; it does not establish physical storage custody. */
async function quotaEntries(companyId: string, secretId?: string): Promise<QuotaCredentialRecoveryEntry[]> {
  const found: QuotaCredentialRecoveryEntry[] = [];
  z.string().uuid().parse(companyId);
  if (secretId !== undefined) z.string().uuid().parse(secretId);
  const directory = path.join(idleQuotaRecoveryPath(), companyId);
  let entries: string[];
  let observed: { dev: number; ino: number };
  try {
    const stat = await fs.lstat(directory);
    observed = { dev: stat.dev, ino: stat.ino };
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("quota_credential_recovery_inspection_required");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
    throw error;
  }
  entries = await fs.readdir(directory);
  for (const name of entries) {
    const grantId = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!z.string().uuid().safeParse(grantId).success) throw new Error("quota_credential_recovery_inspection_required");
    const stat = await fs.lstat(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("quota_credential_recovery_inspection_required");
    const pending = await quotaCredentialRecovery(companyId, grantId).read();
    if (!pending) throw new Error("quota_credential_recovery_inspection_required");
    if (secretId === undefined || pending.secretId === secretId) found.push(pending);
  }
  await syncDirectory(directory);
  const current = await fs.lstat(directory);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== observed.dev || current.ino !== observed.ino)
    throw new Error("quota_credential_recovery_inspection_required");
  return found;
}
export async function assertNoPendingQuotaCredentialForSecret(companyId: string, secretId: string): Promise<void> {
  if ((await quotaEntries(companyId, secretId)).length) throw new Error("quota_credential_exchange_pending");
}
export async function assertNoPendingQuotaCredentialForDefinition(companyId: string, definitionId: string): Promise<void> {
  z.string().uuid().parse(definitionId);
  const scope = quotaSettlement.getStore();
  if (scope?.active && scope.entry.companyId === companyId &&
      ((!isQuotaExchangeIntent(scope.entry) && !isQuotaExchangeResult(scope.entry)) ||
       scope.predecessor.authority.definition?.id === definitionId)) throw new Error("quota_credential_exchange_pending");
  for (const entry of await quotaEntries(companyId)) {
    // Historical records have no independently retained definition mapping.
    if (!isQuotaExchangeIntent(entry) && !isQuotaExchangeResult(entry) ||
        (isQuotaExchangeIntent(entry) || isQuotaExchangeResult(entry)) && entry.originalSecretIdentity.authority.definition?.id === definitionId)
      throw new Error("quota_credential_exchange_pending");
  }
}
type SettlementScope = { entry: QuotaCredentialRecoveryEntry; predecessor: SecretRecoveryIdentity; active: boolean };
const quotaSettlement = new AsyncLocalStorage<SettlementScope>();
export async function withQuotaCredentialSettlement<T>(entry: QuotaCredentialRecoveryEntry, predecessor: SecretRecoveryIdentity, currentValue: string, action: () => Promise<T>): Promise<T> {
  const retained = await quotaCredentialRecovery(entry.companyId, entry.grantId).read();
  const identity = secretRecoveryIdentitySchema.parse(predecessor);
  if (isQuotaExchangeIntent(entry) || !retained || !isDeepStrictEqual(entrySchema.parse(entry), retained) ||
      entry.secretId !== identity.secretId || identity.authority.parent.companyId !== entry.companyId || quotaCredentialHash(currentValue) !== entry.baseHash ||
      isQuotaExchangeResult(entry) && !isDeepStrictEqual(identity, entry.originalSecretIdentity)) throw new Error("quota_credential_exchange_pending");
  const scope: SettlementScope = { entry: entrySchema.parse(entry), predecessor: identity, active: true };
  try { return await quotaSettlement.run(scope, action); } finally { scope.active = false; }
}
export async function assertQuotaCredentialSecretMutationAllowed(companyId: string, secretId: string, currentIdentity?: SecretRecoveryIdentity, nextValue?: string): Promise<void> {
  const entries = await quotaEntries(companyId, secretId), scope = quotaSettlement.getStore();
  if (!entries.length) {
    if (scope?.entry.companyId === companyId && scope.entry.secretId === secretId) throw new Error("quota_credential_exchange_pending");
    return;
  }
  for (const entry of entries) {
    if (!scope?.active || isQuotaExchangeIntent(entry) || !isDeepStrictEqual(entry, scope.entry) ||
        !currentIdentity || !isDeepStrictEqual(currentIdentity, scope.predecessor) || nextValue !== entry.value)
      throw new Error("quota_credential_exchange_pending");
  }
}

/** Called only while holding the company credential mutation lock. The local
 * encrypted provider uses the instance secrets master key, including when the
 * destination vault is remote. No plaintext token enters this journal. */
export function quotaCredentialRecovery(companyId: string, grantId: string) {
  const file = quotaCredentialRecoveryPath(companyId, grantId);
  const directory = path.dirname(file);
  async function removeDurably(target: string) {
    await fs.rm(target, { force: true });
    // A previous attempt may have unlinked successfully and failed its flush.
    // Missing file is therefore not proof that deletion is durable.
    try { await fs.stat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await syncDirectory(directory);
  }
  async function cleanupAfterFailure(target: string, original: unknown): Promise<never> {
    try { await removeDurably(target); }
    catch (cleanup) {
      // Preserve both failures in causal order, rather than replacing the
      // original preparation/publication failure with its cleanup failure.
      throw new AggregateError([original, cleanup], "Credential recovery write and cleanup failed");
    }
    throw original;
  }
  async function writeEncrypted(target: string, value: string) {
    const encrypted = await localEncryptedProvider.createVersion({ value });
    await ensureDurableDirectory(directory);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(encrypted.material)); await handle.sync(); }
      catch (original) {
        try { await handle.close(); }
        catch (close) {
          throw new AggregateError([original, close], "Credential recovery write and close failed");
        }
        throw original;
      }
      await handle.close();
      await fs.rename(temporary, target);
      await syncDirectory(directory);
    } catch (error) { return cleanupAfterFailure(temporary, error); }
  }
  async function read(): Promise<QuotaCredentialRecoveryEntry | null> {
    let companyInfo;
    try { companyInfo = await fs.lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!companyInfo.isDirectory() || companyInfo.isSymbolicLink()) throw new Error("quota_credential_recovery_inspection_required");
    async function assertCompanyUnchanged() {
      const current = await fs.lstat(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== companyInfo.dev || current.ino !== companyInfo.ino)
        throw new Error("quota_credential_recovery_inspection_required");
    }
    let fileInfo;
    try { fileInfo = await fs.lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A prior SQL-settled unlink may have failed its directory flush. New use
      // must finish that barrier even when there are no remaining file bytes.
      await assertCompanyUnchanged();
      await syncDirectory(directory);
      await assertCompanyUnchanged();
      return null;
    }
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1)
      throw new Error("quota_credential_recovery_inspection_required");
    const material = await fs.readFile(file, "utf8");
    await assertCompanyUnchanged();
    const pending = entrySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material: JSON.parse(material), externalRef: null })));
    if (pending.companyId !== companyId || pending.grantId !== grantId) throw new Error("credentials_unavailable");
    return pending;
  }
  return {
    // Verify encryption, storage, and fsync before exchanging a single-use token.
    prepare: async () => {
      const probe = `${file}.${randomUUID()}.probe`;
      try { await writeEncrypted(probe, "credential-recovery-probe"); }
      catch (error) { return cleanupAfterFailure(probe, error); }
      await removeDurably(probe);
    },
    read,
    beginExchange: async (input: QuotaExchangeIntent) => {
      const intent = exchangeIntentSchema.parse(input);
      if (intent.companyId !== companyId || intent.grantId !== grantId) throw new Error("credentials_unavailable");
      // The caller owns the company mutation lock. An existing exact intent is
      // inspection-only: even its original operation ID may never re-exchange.
      if (await read()) throw new Error("quota_credential_exchange_pending");
      await writeEncrypted(file, JSON.stringify(intent));
    },
    completeExchange: async (input: QuotaExchangeResult) => {
      const result = exchangeResultSchema.parse(input);
      const retained = await read();
      if (!retained || !(isQuotaExchangeIntent(retained) || isQuotaExchangeResult(retained)) ||
          !isDeepStrictEqual(isQuotaExchangeIntent(retained) ? retained : retained.intent, result.intent) ||
          (isQuotaExchangeResult(retained) && retained.value !== result.value)) {
        throw new Error("quota_credential_exchange_identity_mismatch");
      }
      await writeEncrypted(file, JSON.stringify(result));
    },
    // Historical result records retain their read/write format.
    write: async (input: z.infer<typeof recoverySchema>) => {
      const retained = await read();
      if (retained && (isQuotaExchangeIntent(retained) || isQuotaExchangeResult(retained))) {
        throw new Error("quota_credential_exchange_pending");
      }
      await writeEncrypted(file, JSON.stringify(recoverySchema.parse(input)));
    },
    clear: async (expected?: QuotaCredentialRecoveryEntry) => {
      const retained = await read();
      const selected = expected === undefined ? undefined : entrySchema.parse(expected);
      if (retained && (isQuotaExchangeIntent(retained) ||
          (isQuotaExchangeResult(retained) && !isDeepStrictEqual(retained, selected)))) {
        throw new Error("quota_credential_exchange_pending");
      }
      await removeDurably(file);
    },
  };
}
