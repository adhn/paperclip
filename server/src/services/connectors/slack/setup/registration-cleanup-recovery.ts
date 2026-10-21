import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { secretRecoveryIdentitySchema, type SecretRecoveryIdentity } from "../../../secret-recovery-identity-schema.js";
import { resolvePaperclipInstanceRoot } from "../../../../home-paths.js";
import { localEncryptedProvider } from "../../../../secrets/local-encrypted-provider.js";
import { ensureDurableDirectory, syncDirectory } from "../../../../lib/durable-directory.js";
const uuid = z.string().uuid();
const intentSchema = z.object({ schema: z.literal(1), kind: z.literal("registration-cleanup-intent"), family: z.literal("slack.registration.staged-cleanup"), operationId: uuid, companyId: uuid, endpointId: uuid,
  actorUserId: z.string().min(1), actorSessionId: z.string().nullable(),
  originalEndpoint: z.record(z.string(), z.unknown()), originalConnection: z.record(z.string(), z.unknown()),
  originalRegistration: z.record(z.string(), z.unknown()),
  targets: z.record(uuid, z.object({ key: z.enum(["botToken", "signingSecret"]), identity: secretRecoveryIdentitySchema, tokenOperationId: uuid }).strict()),
  nextSecretIds: z.record(z.string(), uuid),
}).strict().superRefine((intent, context) => {
  if (intent.originalEndpoint.id !== intent.endpointId || intent.originalEndpoint.companyId !== intent.companyId ||
      !uuid.safeParse(intent.originalConnection.id).success || intent.originalEndpoint.connectionId !== intent.originalConnection.id || intent.originalConnection.companyId !== intent.companyId) context.addIssue({ code: "custom", message: "Exact original cleanup endpoint and connection required" });
  const refs = intent.originalRegistration.secretIds;
  const original = refs && typeof refs === "object" && !Array.isArray(refs) ? refs as Record<string, unknown> : {};
  const keys = new Set<string>(), operations = new Set<string>();
  const expected = { ...original };
  for (const [id, target] of Object.entries(intent.targets)) {
    if (id !== target.identity.secretId || original[target.key] !== id || Object.values(original).filter(value => value === id).length !== 1 || keys.has(target.key) || operations.has(target.tokenOperationId)) context.addIssue({ code: "custom", message: "Exact independent original staged target required" });
    keys.add(target.key); operations.add(target.tokenOperationId); delete expected[target.key];
  }
  for (const key of ["botToken", "signingSecret"]) {
    if (original[key] !== undefined && !Object.values(intent.targets).some(target => target.key === key))
      context.addIssue({ code: "custom", message: "Every original staged credential requires its own cleanup target" });
  }
  if (!Object.keys(intent.targets).length || intent.originalRegistration.companyId !== intent.companyId || intent.originalRegistration.endpointId !== intent.endpointId ||
      intent.originalRegistration.status !== "configured" || exact(expected) !== exact(intent.nextSecretIds)) context.addIssue({ code: "custom", message: "Exact configured registration transition required" });
});
const entrySchema = z.object({ schema: z.literal(1), kind: z.literal("registration-cleanup-state"), intent: intentSchema, acknowledgedRemovalIds: z.array(uuid) }).strict()
  .refine(entry => new Set(entry.acknowledgedRemovalIds).size === entry.acknowledgedRemovalIds.length && entry.acknowledgedRemovalIds.every(id => id in entry.intent.targets), "Only independently returned original removals may be acknowledged");
export type RegistrationCleanupIntent = z.infer<typeof intentSchema>;
export type RegistrationCleanupEntry = z.infer<typeof entrySchema>;
const exact = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const registrationCleanupHash = (value: unknown) => createHash("sha256").update(exact(value)).digest("hex");
export const registrationCleanupRecoveryRootPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-registration-cleanup-recovery");
export const registrationCleanupRecoveryPath = (companyId: string, endpointId: string) => path.join(registrationCleanupRecoveryRootPath(), uuid.parse(companyId), `${uuid.parse(endpointId)}.json`);
export const registrationCleanupPending = () => Object.assign(new Error("Slack registration cleanup requires exact recovery inspection"), { code: "slack_staged_cleanup_recovery_pending" });
type DirectorySnapshot = { names: string[]; dev: number; ino: number };
async function directoryIdentity(directory: string) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw registrationCleanupPending();
  return { dev: info.dev, ino: info.ino };
}
async function flushObserved(directory: string, observed: DirectorySnapshot) {
  await syncDirectory(directory);
  const current = await directoryIdentity(directory);
  if (current.dev !== observed.dev || current.ino !== observed.ino) throw registrationCleanupPending();
}
async function files(directory: string): Promise<DirectorySnapshot | null> {
  let identity;
  try { identity = await directoryIdentity(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const names = await fs.readdir(directory);
  if (names.some(name => !name.endsWith(".json") || !uuid.safeParse(name.slice(0, -5)).success)) throw registrationCleanupPending();
  const current = await directoryIdentity(directory);
  if (identity.dev !== current.dev || identity.ino !== current.ino) throw registrationCleanupPending();
  return { names, ...identity };
}
async function fileEntry(file: string): Promise<RegistrationCleanupEntry | null> {
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw registrationCleanupPending(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return entrySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material: JSON.parse(await fs.readFile(file, "utf8")), externalRef: null })));
}
async function inventory(companyId: string): Promise<RegistrationCleanupEntry[]> {
  uuid.parse(companyId);
  const directory = path.join(registrationCleanupRecoveryRootPath(), companyId);
  const names = await files(directory);
  if (names === null) return [];
  const entries: RegistrationCleanupEntry[] = [];
  for (const name of names.names) {
    const entry = await fileEntry(path.join(directory, name));
    if (!entry || entry.intent.companyId !== companyId || `${entry.intent.endpointId}.json` !== name) throw registrationCleanupPending();
    entries.push(entry);
  }
  await flushObserved(directory, names);
  return entries;
}
export function registrationCleanupRecovery(companyId: string, endpointId: string) {
  const file = registrationCleanupRecoveryPath(companyId, endpointId), directory = path.dirname(file);
  async function read() {
    const names = await files(directory);
    const entry = await fileEntry(file);
    if (!entry && names?.names.includes(path.basename(file))) throw registrationCleanupPending();
    if (!entry && names !== null) await flushObserved(directory, names);
    if (entry && names === null) throw registrationCleanupPending();
    if (entry && names !== null) {
      const current = await directoryIdentity(directory);
      if (current.dev !== names.dev || current.ino !== names.ino) throw registrationCleanupPending();
    }
    if (entry && (entry.intent.companyId !== companyId || entry.intent.endpointId !== endpointId)) throw registrationCleanupPending();
    return entry;
  }
  async function publish(input: RegistrationCleanupEntry) {
    const entry = entrySchema.parse(input);
    const encrypted = await localEncryptedProvider.createVersion({ value: JSON.stringify(entry) });
    await ensureDurableDirectory(directory);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let failed = false, failure: unknown;
    try { await handle.writeFile(JSON.stringify(encrypted.material)); await handle.sync(); }
    catch (error) { failed = true; failure = error; }
    try { await handle.close(); } catch (error) { failure = failed ? new AggregateError([failure, error], "Registration cleanup write and close failed") : error; failed = true; }
    if (failed) throw failure; // Keep preparation occupancy; never infer non-effect.
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  }
  return {
    read,
    begin: async (input: RegistrationCleanupIntent) => {
      const intent = intentSchema.parse(input);
      if (intent.companyId !== companyId || intent.endpointId !== endpointId || await read()) throw registrationCleanupPending();
      const entry: RegistrationCleanupEntry = { schema: 1, kind: "registration-cleanup-state", intent, acknowledgedRemovalIds: [] };
      await publish(entry); return entry;
    },
    recordRemovalReturned: async ({ intent, secretId }: { intent: RegistrationCleanupIntent; secretId: string }) => {
      uuid.parse(secretId); const retained = await read();
      if (!retained || exact(retained.intent) !== exact(intentSchema.parse(intent)) || !(secretId in retained.intent.targets) || retained.acknowledgedRemovalIds.includes(secretId)) throw registrationCleanupPending();
      const entry = { ...retained, acknowledgedRemovalIds: [...retained.acknowledgedRemovalIds, secretId] };
      await publish(entry);
      const scope = cleanup.getStore();
      if (scope?.active && exact(scope.entry.intent) === exact(entry.intent)) scope.entry = entry;
      return entry;
    },
    clear: async (input: RegistrationCleanupEntry) => {
      const entry = entrySchema.parse(input), retained = await read();
      if (entry.acknowledgedRemovalIds.length !== Object.keys(entry.intent.targets).length || retained && exact(retained) !== exact(entry)) throw registrationCleanupPending();
      const observed = await files(directory); if (observed === null) throw registrationCleanupPending();
      await fs.rm(file, { force: true }); await flushObserved(directory, observed);
    },
  };
}
export async function assertNoPendingRegistrationCleanupForActor(companyId: string, actorUserId: string) {
  if ((await inventory(companyId)).some(entry => entry.intent.actorUserId === actorUserId)) throw registrationCleanupPending();
}
export async function assertNoPendingRegistrationCleanupForEndpoint(companyId: string, endpointId: string) {
  uuid.parse(endpointId); if ((await inventory(companyId)).some(entry => entry.intent.endpointId === endpointId)) throw registrationCleanupPending();
}
export async function assertNoPendingRegistrationCleanupForSecret(companyId: string, secretId: string) {
  uuid.parse(secretId); if ((await inventory(companyId)).some(entry => secretId in entry.intent.targets)) throw registrationCleanupPending();
}
const cleanup = new AsyncLocalStorage<{ active: boolean; entry: RegistrationCleanupEntry }>();
export async function withRegistrationCleanup<T>(input: RegistrationCleanupEntry, action: () => Promise<T>): Promise<T> {
  const entry = entrySchema.parse(input), retained = await registrationCleanupRecovery(entry.intent.companyId, entry.intent.endpointId).read();
  if (!retained || exact(retained) !== exact(entry) || entry.acknowledgedRemovalIds.length) throw registrationCleanupPending();
  const directory = path.dirname(registrationCleanupRecoveryPath(entry.intent.companyId, entry.intent.endpointId));
  const observed = await files(directory); if (observed === null) throw registrationCleanupPending(); await flushObserved(directory, observed);
  const scope = { active: true, entry };
  try { return await cleanup.run(scope, action); } finally { scope.active = false; }
}
/** Conditional global guard: unmatched secrets remain outside this family.
 * A matching original target requires its active exact prospective owner. */
export async function assertRegistrationCleanupSecretRemovalAllowed(companyId: string, secretId: string, currentIdentity: SecretRecoveryIdentity) {
  uuid.parse(secretId);
  const identity = secretRecoveryIdentitySchema.parse(currentIdentity);
  if (identity.secretId !== secretId) throw registrationCleanupPending();
  let matched = false;
  for (const entry of await inventory(companyId)) {
    if (!(secretId in entry.intent.targets)) continue;
    matched = true;
    const scope = cleanup.getStore();
    if (!scope?.active || exact(scope.entry.intent) !== exact(entry.intent) ||
        entry.acknowledgedRemovalIds.includes(secretId) || exact(scope.entry) !== exact(entry) ||
        exact(identity) !== exact(entry.intent.targets[secretId].identity)) throw registrationCleanupPending();
  }
  const scope = cleanup.getStore();
  if (scope?.active && scope.entry.intent.companyId === companyId && secretId in scope.entry.intent.targets && !matched) throw registrationCleanupPending();
}

/** Retained original authority remains occupied even after mutable SQL references change. */
export async function assertNoPendingRegistrationCleanupForDefinition(companyId: string, definitionId: string) {
  uuid.parse(definitionId);
  const scope = cleanup.getStore();
  if (scope?.active) {
    const active = scope.entry.intent;
    if (active.companyId === companyId && Object.values(active.targets).some(role => role?.identity.authority.definition?.id === definitionId)) throw registrationCleanupPending();
  }
  if ((await inventory(companyId)).some(entry => Object.values(entry.intent.targets).some(role => role.identity.authority.definition?.id === definitionId))) throw registrationCleanupPending();
}
