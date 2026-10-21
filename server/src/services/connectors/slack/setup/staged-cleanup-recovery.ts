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
const intentSchema = z.object({ schema: z.literal(1), kind: z.literal("staged-cleanup-intent"), operationId: uuid, companyId: uuid, endpointId: uuid,
  actorUserId: z.string().min(1), actorSessionId: z.string().nullable(), parentManagedOperationId: uuid, parentResultHash: z.string().regex(/^[a-f0-9]{64}$/),
  originalEndpoint: z.record(z.string(), z.unknown()), originalConnection: z.record(z.string(), z.unknown()),
  originalRegistration: z.record(z.string(), z.unknown()),
  targets: z.record(uuid, z.object({ key: z.enum(["botToken", "signingSecret"]), identity: secretRecoveryIdentitySchema, tokenOperationId: uuid }).strict()),
  nextSecretIds: z.record(z.string(), uuid),
}).strict().superRefine((intent, context) => {
  const refs = intent.originalRegistration.secretIds;
  const original = refs && typeof refs === "object" && !Array.isArray(refs) ? refs as Record<string, unknown> : {};
  const keys = new Set<string>(), operations = new Set<string>();
  const expected = { ...original };
  for (const [id, target] of Object.entries(intent.targets)) {
    if (id !== target.identity.secretId || original[target.key] !== id || Object.values(original).filter(value => value === id).length !== 1 || keys.has(target.key) || operations.has(target.tokenOperationId)) context.addIssue({ code: "custom", message: "Exact independent original staged target required" });
    keys.add(target.key); operations.add(target.tokenOperationId); delete expected[target.key];
  }
  if (intent.originalEndpoint.id !== intent.endpointId || intent.originalEndpoint.companyId !== intent.companyId ||
      intent.originalEndpoint.connectionId !== intent.originalConnection.id || intent.originalConnection.companyId !== intent.companyId ||
      !Object.keys(intent.targets).length || intent.originalRegistration.companyId !== intent.companyId || intent.originalRegistration.endpointId !== intent.endpointId ||
      intent.originalRegistration.status !== "configured" || exact(expected) !== exact(intent.nextSecretIds)) context.addIssue({ code: "custom", message: "Exact configured registration transition required" });
});
const entrySchema = z.object({ schema: z.literal(1), kind: z.literal("staged-cleanup-state"), intent: intentSchema, acknowledgedRemovalIds: z.array(uuid) }).strict()
  .refine(entry => new Set(entry.acknowledgedRemovalIds).size === entry.acknowledgedRemovalIds.length && entry.acknowledgedRemovalIds.every(id => id in entry.intent.targets), "Only independently returned original removals may be acknowledged");
export type StagedCleanupIntent = z.infer<typeof intentSchema>;
export type StagedCleanupEntry = z.infer<typeof entrySchema>;
const exact = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const stagedCleanupHash = (value: unknown) => createHash("sha256").update(exact(value)).digest("hex");
export const stagedCleanupRecoveryRootPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-staged-cleanup-recovery");
export const stagedCleanupRecoveryPath = (companyId: string, endpointId: string) => path.join(stagedCleanupRecoveryRootPath(), uuid.parse(companyId), `${uuid.parse(endpointId)}.json`);
export const stagedCleanupPending = () => Object.assign(new Error("Slack staged cleanup requires exact recovery inspection"), { code: "slack_staged_cleanup_recovery_pending" });
type DirectorySnapshot = { names: string[]; dev: number; ino: number };
async function directoryIdentity(directory: string) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw stagedCleanupPending();
  return { dev: info.dev, ino: info.ino };
}
async function flushObserved(directory: string, observed: DirectorySnapshot) {
  await syncDirectory(directory);
  const current = await directoryIdentity(directory);
  if (current.dev !== observed.dev || current.ino !== observed.ino) throw stagedCleanupPending();
}
async function files(directory: string): Promise<DirectorySnapshot | null> {
  let identity;
  try { identity = await directoryIdentity(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const names = await fs.readdir(directory);
  if (names.some(name => !name.endsWith(".json") || !uuid.safeParse(name.slice(0, -5)).success)) throw stagedCleanupPending();
  const current = await directoryIdentity(directory);
  if (identity.dev !== current.dev || identity.ino !== current.ino) throw stagedCleanupPending();
  return { names, ...identity };
}
async function fileEntry(file: string): Promise<StagedCleanupEntry | null> {
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw stagedCleanupPending(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return entrySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material: JSON.parse(await fs.readFile(file, "utf8")), externalRef: null })));
}
async function inventory(companyId: string): Promise<StagedCleanupEntry[]> {
  uuid.parse(companyId);
  const directory = path.join(stagedCleanupRecoveryRootPath(), companyId);
  const names = await files(directory);
  if (names === null) return [];
  const entries: StagedCleanupEntry[] = [];
  for (const name of names.names) {
    const entry = await fileEntry(path.join(directory, name));
    if (!entry || entry.intent.companyId !== companyId || `${entry.intent.endpointId}.json` !== name) throw stagedCleanupPending();
    entries.push(entry);
  }
  await flushObserved(directory, names);
  return entries;
}
export function stagedCleanupRecovery(companyId: string, endpointId: string) {
  const file = stagedCleanupRecoveryPath(companyId, endpointId), directory = path.dirname(file);
  async function read() {
    const names = await files(directory);
    const entry = await fileEntry(file);
    if (!entry && names?.names.includes(path.basename(file))) throw stagedCleanupPending();
    if (!entry && names !== null) await flushObserved(directory, names);
    if (entry && names === null) throw stagedCleanupPending();
    if (entry && names !== null) {
      const current = await directoryIdentity(directory);
      if (current.dev !== names.dev || current.ino !== names.ino) throw stagedCleanupPending();
    }
    if (entry && (entry.intent.companyId !== companyId || entry.intent.endpointId !== endpointId)) throw stagedCleanupPending();
    return entry;
  }
  async function publish(input: StagedCleanupEntry) {
    const entry = entrySchema.parse(input);
    const encrypted = await localEncryptedProvider.createVersion({ value: JSON.stringify(entry) });
    await ensureDurableDirectory(directory);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let failed = false, failure: unknown;
    try { await handle.writeFile(JSON.stringify(encrypted.material)); await handle.sync(); }
    catch (error) { failed = true; failure = error; }
    try { await handle.close(); } catch (error) { failure = failed ? new AggregateError([failure, error], "Staged cleanup write and close failed") : error; failed = true; }
    if (failed) throw failure; // Keep preparation occupancy; never infer non-effect.
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  }
  return {
    read,
    begin: async (input: StagedCleanupIntent) => {
      const intent = intentSchema.parse(input);
      if (intent.companyId !== companyId || intent.endpointId !== endpointId || await read()) throw stagedCleanupPending();
      const entry: StagedCleanupEntry = { schema: 1, kind: "staged-cleanup-state", intent, acknowledgedRemovalIds: [] };
      await publish(entry); return entry;
    },
    recordRemovalReturned: async ({ intent, secretId }: { intent: StagedCleanupIntent; secretId: string }) => {
      uuid.parse(secretId); const retained = await read();
      if (!retained || exact(retained.intent) !== exact(intentSchema.parse(intent)) || !(secretId in retained.intent.targets) || retained.acknowledgedRemovalIds.includes(secretId)) throw stagedCleanupPending();
      const entry = { ...retained, acknowledgedRemovalIds: [...retained.acknowledgedRemovalIds, secretId] };
      await publish(entry);
      const scope = cleanup.getStore();
      if (scope?.active && exact(scope.entry.intent) === exact(entry.intent)) scope.entry = entry;
      return entry;
    },
    clear: async (input: StagedCleanupEntry) => {
      const entry = entrySchema.parse(input), retained = await read();
      if (entry.acknowledgedRemovalIds.length !== Object.keys(entry.intent.targets).length || retained && exact(retained) !== exact(entry)) throw stagedCleanupPending();
      const observed = await files(directory); if (observed === null) throw stagedCleanupPending();
      await fs.rm(file, { force: true }); await flushObserved(directory, observed);
    },
  };
}
export async function assertNoPendingStagedCleanupForActor(companyId: string, actorUserId: string) {
  if ((await inventory(companyId)).some(entry => entry.intent.actorUserId === actorUserId)) throw stagedCleanupPending();
}
export async function assertNoPendingStagedCleanupForEndpoint(companyId: string, endpointId: string) {
  uuid.parse(endpointId); if ((await inventory(companyId)).some(entry => entry.intent.endpointId === endpointId)) throw stagedCleanupPending();
}
export async function assertNoPendingStagedCleanupForSecret(companyId: string, secretId: string) {
  uuid.parse(secretId); if ((await inventory(companyId)).some(entry => secretId in entry.intent.targets)) throw stagedCleanupPending();
}
const cleanup = new AsyncLocalStorage<{ active: boolean; entry: StagedCleanupEntry }>();
export async function withStagedCleanup<T>(input: StagedCleanupEntry, action: () => Promise<T>): Promise<T> {
  const entry = entrySchema.parse(input), retained = await stagedCleanupRecovery(entry.intent.companyId, entry.intent.endpointId).read();
  if (!retained || exact(retained) !== exact(entry) || entry.acknowledgedRemovalIds.length) throw stagedCleanupPending();
  const directory = path.dirname(stagedCleanupRecoveryPath(entry.intent.companyId, entry.intent.endpointId));
  const observed = await files(directory); if (observed === null) throw stagedCleanupPending(); await flushObserved(directory, observed);
  const scope = { active: true, entry };
  try { return await cleanup.run(scope, action); } finally { scope.active = false; }
}
async function assertScope(companyId: string, secretId: string, parentOperationId?: string, parentResultHash?: string, identity?: SecretRecoveryIdentity) {
  uuid.parse(secretId);
  let matched = false;
  for (const entry of await inventory(companyId)) {
    if (!(secretId in entry.intent.targets)) continue;
    matched = true;
    const scope = cleanup.getStore();
    if (!scope?.active || exact(scope.entry.intent) !== exact(entry.intent) ||
        entry.acknowledgedRemovalIds.includes(secretId) || !scope.entry.acknowledgedRemovalIds.every(id => entry.acknowledgedRemovalIds.includes(id)) ||
        parentOperationId !== undefined && entry.intent.parentManagedOperationId !== parentOperationId ||
        parentResultHash !== undefined && entry.intent.parentResultHash !== parentResultHash ||
        identity !== undefined && exact(secretRecoveryIdentitySchema.parse(identity)) !== exact(entry.intent.targets[secretId].identity)) throw stagedCleanupPending();
  }
  const active = cleanup.getStore();
  if (!matched && (parentOperationId !== undefined || active?.active && active.entry.intent.companyId === companyId && secretId in active.entry.intent.targets)) throw stagedCleanupPending();
}
export async function assertStagedCleanupSecretRemovalAllowed(companyId: string, secretId: string, identity: SecretRecoveryIdentity) {
  await assertScope(companyId, secretId, undefined, undefined, secretRecoveryIdentitySchema.parse(identity));
}
export async function assertStagedCleanupParentRemovalAllowed(companyId: string, secretId: string, parentOperationId: string, parentResultHash: string) {
  await assertScope(companyId, secretId, uuid.parse(parentOperationId), parentResultHash);
}

/** Retained original authority remains occupied even after mutable SQL references change. */
export async function assertNoPendingStagedCleanupForDefinition(companyId: string, definitionId: string) {
  uuid.parse(definitionId);
  const scope = cleanup.getStore();
  if (scope?.active) {
    const active = scope.entry.intent;
    if (active.companyId === companyId && Object.values(active.targets).some(role => role?.identity.authority.definition?.id === definitionId)) throw stagedCleanupPending();
  }
  if ((await inventory(companyId)).some(entry => Object.values(entry.intent.targets).some(role => role.identity.authority.definition?.id === definitionId))) throw stagedCleanupPending();
}
