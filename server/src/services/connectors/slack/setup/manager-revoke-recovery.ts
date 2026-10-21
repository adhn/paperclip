import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { secretRecoveryIdentitySchema } from "../../../secret-recovery-identity-schema.js";
import { connectorRecoveryAuthoritySchema } from "../../../connector-recovery-authority.js";
import { resolvePaperclipInstanceRoot } from "../../../../home-paths.js";
import { localEncryptedProvider } from "../../../../secrets/local-encrypted-provider.js";
import { ensureDurableDirectory, syncDirectory } from "../../../../lib/durable-directory.js";
const uuid = z.string().uuid();
const predecessorSchema = z.object({ identity: secretRecoveryIdentitySchema, valueHash: z.string().regex(/^[a-f0-9]{64}$/), tokenOperationId: uuid }).strict();
const intentSchema = z.object({ schema: z.literal(1), kind: z.literal("manager-revoke-intent"), operationId: uuid,
  companyId: uuid, grantId: uuid, actorUserId: z.string().min(1), actorSessionId: z.string().nullable(), originalGrant: z.record(z.string(), z.unknown()),
  originalRevision: z.number().int().nonnegative(), deniedRevision: z.number().int().positive(), clientMode: z.enum(["claim", "code"]),
  clientAuthority: connectorRecoveryAuthoritySchema, access: predecessorSchema.nullable(), refresh: predecessorSchema.nullable(),
}).strict().superRefine((intent, context) => {
  const grant = intent.originalGrant;
  if (grant.id !== intent.grantId || grant.companyId !== intent.companyId || grant.userId !== intent.actorUserId || grant.revision !== intent.originalRevision ||
      intent.deniedRevision !== intent.originalRevision + 1 || (!intent.access && !intent.refresh) ||
      (intent.access?.identity.secretId ?? null) !== grant.accessSecretId || (intent.refresh?.identity.secretId ?? null) !== grant.refreshSecretId ||
      intent.access && intent.refresh && (intent.access.identity.secretId === intent.refresh.identity.secretId || intent.access.tokenOperationId === intent.refresh.tokenOperationId) ||
      (intent.clientMode === "claim") !== (intent.clientAuthority.kind === "hosted-sealed") ||
      intent.clientAuthority.kind === "development-direct-oauth" && intent.clientAuthority.appId !== grant.managerAppId) context.addIssue({ code: "custom", message: "Exact independent original revoke roles and owner required" });
});
const rawSchema = z.object({ status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string()), bodyBase64: z.string().max(1_400_000) }).strict();
const rawOutcomeSchema = z.object({ kind: z.literal("raw"), raw: rawSchema }).strict();
const completedOutcomeSchema = z.object({ kind: z.literal("client-completed"), raw: rawSchema,
  acceptance: z.enum(["hosted-broker-accepted", "development-api-ok"]) }).strict();
const outcomeSchema = z.union([rawOutcomeSchema, completedOutcomeSchema]).nullable();
const entrySchema = z.object({ schema: z.literal(1), kind: z.literal("manager-revoke-state"), intent: intentSchema,
  outcomes: z.object({ access: outcomeSchema, refresh: outcomeSchema }).strict(),
}).strict().superRefine((entry, context) => {
  for (const role of ["access", "refresh"] as const) {
    const outcome = entry.outcomes[role];
    if (outcome && !entry.intent[role] || outcome?.kind === "client-completed" &&
        (outcome.acceptance !== (entry.intent.clientMode === "claim" ? "hosted-broker-accepted" : "development-api-ok") || !acceptedRaw(entry.intent, outcome.raw)))
      context.addIssue({ code: "custom", message: "Original role completion must match actual client acceptance" });
  }
});
export type ManagerRevokeIntent = z.infer<typeof intentSchema>;
export type ManagerRevokeEntry = z.infer<typeof entrySchema>;
export type ManagerRevokeRawResponse = z.infer<typeof rawSchema>;
export type ManagerRevokeRole = "access" | "refresh";
export const managerRevokeHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const managerRevokeRecoveryRootPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-manager-revoke-recovery");
export const managerRevokeRecoveryPath = (companyId: string, grantId: string) => path.join(managerRevokeRecoveryRootPath(), uuid.parse(companyId), `${uuid.parse(grantId)}.json`);
export const managerRevokePending = () => Object.assign(new Error("Slack manager revoke requires exact recovery inspection"), { code: "slack_manager_revoke_recovery_pending" });
const exact = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function acceptedRaw(intent: ManagerRevokeIntent, raw: ManagerRevokeRawResponse) {
  if (raw.status < 200 || raw.status >= 300) return false;
  if (intent.clientMode === "claim" && raw.status === 204) return true;
  try { const body = JSON.parse(Buffer.from(raw.bodyBase64, "base64").toString("utf8")); return intent.clientMode === "claim" || body?.ok === true; }
  catch { return false; }
}
function complete(entry: ManagerRevokeEntry) {
  return (["access", "refresh"] as const).every(role => !entry.intent[role] || entry.outcomes[role]?.kind === "client-completed");
}
type DirectorySnapshot = { names: string[]; dev: number; ino: number };
async function directoryIdentity(directory: string) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw managerRevokePending();
  return { dev: info.dev, ino: info.ino };
}
async function flushObserved(directory: string, observed: DirectorySnapshot) {
  await syncDirectory(directory);
  const current = await directoryIdentity(directory);
  if (current.dev !== observed.dev || current.ino !== observed.ino) throw managerRevokePending();
}
async function files(directory: string): Promise<DirectorySnapshot | null> {
  let identity;
  try { identity = await directoryIdentity(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const names = await fs.readdir(directory);
  if (names.some(name => !name.endsWith(".json") || !uuid.safeParse(name.slice(0, -5)).success)) throw managerRevokePending();
  const current = await directoryIdentity(directory);
  if (identity.dev !== current.dev || identity.ino !== current.ino) throw managerRevokePending();
  return { names, ...identity };
}
async function fileEntry(file: string): Promise<ManagerRevokeEntry | null> {
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw managerRevokePending(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return entrySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material: JSON.parse(await fs.readFile(file, "utf8")), externalRef: null })));
}
async function inventory(companyId: string): Promise<ManagerRevokeEntry[]> {
  uuid.parse(companyId);
  const directory = path.join(managerRevokeRecoveryRootPath(), companyId);
  const names = await files(directory);
  if (names === null) return [];
  const entries: ManagerRevokeEntry[] = [];
  for (const name of names.names) {
    const entry = await fileEntry(path.join(directory, name));
    if (!entry || entry.intent.companyId !== companyId || `${entry.intent.grantId}.json` !== name) throw managerRevokePending();
    entries.push(entry);
  }
  await flushObserved(directory, names);
  return entries;
}
export function managerRevokeRecovery(companyId: string, grantId: string) {
  const file = managerRevokeRecoveryPath(companyId, grantId), directory = path.dirname(file);
  async function read() {
    const names = await files(directory);
    const entry = await fileEntry(file);
    if (!entry && names?.names.includes(path.basename(file))) throw managerRevokePending();
    if (!entry && names !== null) await flushObserved(directory, names);
    if (entry && names === null) throw managerRevokePending();
    if (entry && names !== null) {
      const current = await directoryIdentity(directory);
      if (current.dev !== names.dev || current.ino !== names.ino) throw managerRevokePending();
    }
    if (entry && (entry.intent.companyId !== companyId || entry.intent.grantId !== grantId)) throw managerRevokePending();
    return entry;
  }
  async function publish(input: ManagerRevokeEntry) {
    const entry = entrySchema.parse(input);
    const encrypted = await localEncryptedProvider.createVersion({ value: JSON.stringify(entry) });
    await ensureDurableDirectory(directory);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let failed = false, failure: unknown;
    try { await handle.writeFile(JSON.stringify(encrypted.material)); await handle.sync(); }
    catch (error) { failed = true; failure = error; }
    try { await handle.close(); } catch (error) { failure = failed ? new AggregateError([failure, error], "Manager revoke write and close failed") : error; failed = true; }
    if (failed) throw failure; // Keep preparation occupancy; never infer non-effect.
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  }
  return {
    read,
    begin: async (input: ManagerRevokeIntent) => {
      const intent = intentSchema.parse(input);
      if (intent.companyId !== companyId || intent.grantId !== grantId || await read()) throw managerRevokePending();
      const entry: ManagerRevokeEntry = { schema: 1, kind: "manager-revoke-state", intent, outcomes: { access: null, refresh: null } };
      await publish(entry); return entry;
    },
    recordRaw: async ({ role, intent, raw }: { role: ManagerRevokeRole; intent: ManagerRevokeIntent; raw: ManagerRevokeRawResponse }) => {
      const retained = await read();
      if (!retained || exact(retained.intent) !== exact(intentSchema.parse(intent)) || !retained.intent[role]) throw managerRevokePending();
      const outcome = rawOutcomeSchema.parse({ kind: "raw", raw });
      if (retained.outcomes[role] && exact(retained.outcomes[role]) !== exact(outcome)) throw managerRevokePending();
      const entry = { ...retained, outcomes: { ...retained.outcomes, [role]: outcome } };
      await publish(entry); return entry;
    },
    recordClientCompletion: async ({ role, intent, raw }: { role: ManagerRevokeRole; intent: ManagerRevokeIntent; raw: ManagerRevokeRawResponse }) => {
      const retained = await read();
      if (!retained || exact(retained.intent) !== exact(intentSchema.parse(intent)) || !retained.intent[role] || !retained.outcomes[role] ||
          exact(retained.outcomes[role]!.raw) !== exact(rawSchema.parse(raw)) || !acceptedRaw(retained.intent, raw)) throw managerRevokePending();
      const outcome = completedOutcomeSchema.parse({ kind: "client-completed", raw, acceptance: retained.intent.clientMode === "claim" ? "hosted-broker-accepted" : "development-api-ok" });
      const entry = { ...retained, outcomes: { ...retained.outcomes, [role]: outcome } };
      await publish(entry); return entry;
    },
    clear: async (input: ManagerRevokeEntry) => {
      const entry = entrySchema.parse(input), retained = await read();
      if (!complete(entry) || retained && exact(retained) !== exact(entry)) throw managerRevokePending();
      const observed = await files(directory); if (observed === null) throw managerRevokePending();
      await fs.rm(file, { force: true }); await flushObserved(directory, observed);
    },
  };
}
export async function assertNoPendingManagerRevokeForActor(companyId: string, userId: string) {
  if ((await inventory(companyId)).some(entry => entry.intent.actorUserId === userId)) throw managerRevokePending();
}
export async function assertNoPendingManagerRevokeForGrant(companyId: string, grantId: string) {
  uuid.parse(grantId); if ((await inventory(companyId)).some(entry => entry.intent.grantId === grantId)) throw managerRevokePending();
}
export async function assertNoPendingManagerRevokeForSecret(companyId: string, secretId: string) {
  uuid.parse(secretId); if ((await inventory(companyId)).some(entry => [entry.intent.access, entry.intent.refresh].some(role => role?.identity.secretId === secretId))) throw managerRevokePending();
}
const cleanup = new AsyncLocalStorage<{ active: boolean; entry: ManagerRevokeEntry }>();
export async function withManagerRevokeCleanup<T>(input: ManagerRevokeEntry, action: () => Promise<T>): Promise<T> {
  const entry = entrySchema.parse(input), retained = await managerRevokeRecovery(entry.intent.companyId, entry.intent.grantId).read();
  if (!complete(entry) || !retained || exact(retained) !== exact(entry)) throw managerRevokePending();
  const directory = path.dirname(managerRevokeRecoveryPath(entry.intent.companyId, entry.intent.grantId));
  const observed = await files(directory); if (observed === null) throw managerRevokePending(); await flushObserved(directory, observed);
  const scope = { active: true, entry };
  try { return await cleanup.run(scope, action); } finally { scope.active = false; }
}
/** Removal only: root must separately compare current exact secret authority.
 * This grants no rotation, general update, provider replay or physical receipt. */
export async function assertManagerRevokeSecretRemovalAllowed(companyId: string, secretId: string) {
  uuid.parse(secretId);
  for (const entry of await inventory(companyId)) {
    if (![entry.intent.access, entry.intent.refresh].some(role => role?.identity.secretId === secretId)) continue;
    const scope = cleanup.getStore();
    if (!scope?.active || !complete(entry) || exact(scope.entry) !== exact(entry)) throw managerRevokePending();
  }
}

export async function assertNoPendingManagerRevokeForCompany(companyId: string) {
  if ((await inventory(companyId)).length) throw managerRevokePending();
}

/** Retained original authority remains occupied even after mutable SQL references change. */
export async function assertNoPendingManagerRevokeForDefinition(companyId: string, definitionId: string) {
  uuid.parse(definitionId);
  const scope = cleanup.getStore();
  if (scope?.active) {
    const active = scope.entry.intent;
    if (active.companyId === companyId && [active.access, active.refresh].some(role => role?.identity.authority.definition?.id === definitionId)) throw managerRevokePending();
  }
  if ((await inventory(companyId)).some(entry => [entry.intent.access, entry.intent.refresh].some(role => role?.identity.authority.definition?.id === definitionId))) throw managerRevokePending();
}
