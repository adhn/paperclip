import { assertStagedCleanupParentRemovalAllowed, stagedCleanupHash } from "./staged-cleanup-recovery.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { secretRecoveryIdentitySchema } from "../../../secret-recovery-identity-schema.js";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolvePaperclipInstanceRoot } from "../../../../home-paths.js";
import { localEncryptedProvider } from "../../../../secrets/local-encrypted-provider.js";
import { ensureDurableDirectory, syncDirectory } from "../../../../lib/durable-directory.js";
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const record = z.record(z.string(), z.unknown());
const secretSchema = z.object({ identity: secretRecoveryIdentitySchema, valueHash: hash }).strict();
const authoritySchema = z.object({ method: z.literal("apps.managedInstall"), apiBaseUrl: z.literal("https://slack.com/api/"),
  managerAppId: z.string().regex(/^A[A-Z0-9]+$/), workspaceId: z.string().regex(/^T[A-Z0-9]+$/), slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/) }).strict();
const intentSchema = z.object({ schema: z.literal(1), kind: z.literal("managed-install-intent"), family: z.literal("slack.apps.managedInstall"),
  operationId: uuid, companyId: uuid, endpointId: uuid, actorUserId: z.string().min(1), actorSessionId: z.string().nullable(),
  originalEndpoint: record, originalConnection: record, originalRegistration: record,
  preparedEndpoint: record.nullable(), preparedRegistration: record.nullable(), originalAction: record.nullable(), preparedAction: record.nullable(),
  originalManagerGrant: record, originalManagerSecrets: z.record(uuid, secretSchema), originalRegistrationSecrets: z.record(uuid, secretSchema),
  requestId: uuid, requestedRequestId: uuid, reconnectKey: z.string().min(1).nullable(), appId: z.string().regex(/^A[A-Z0-9]+$/), manifestHash: hash,
  params: z.object({ app_id: z.string(), team_id: z.string() }).strict(), directApiAuthority: authoritySchema,
}).strict().superRefine((intent, context) => {
  const fail = () => context.addIssue({ code: "custom", message: "Exact original managed installation authority required" });
  const grant = intent.originalManagerGrant, registration = intent.originalRegistration;
  if (!uuid.safeParse(grant.id).success || grant.companyId !== intent.companyId || grant.userId !== intent.actorUserId ||
      grant.managerAppId !== intent.directApiAuthority.managerAppId || grant.workspaceId !== intent.directApiAuthority.workspaceId || grant.slackUserId !== intent.directApiAuthority.slackUserId ||
      intent.params.app_id !== intent.appId || intent.params.team_id !== grant.workspaceId ||
      intent.originalEndpoint.id !== intent.endpointId || intent.originalEndpoint.companyId !== intent.companyId ||
      intent.originalConnection.companyId !== intent.companyId || !uuid.safeParse(intent.originalConnection.id).success || intent.originalEndpoint.connectionId !== intent.originalConnection.id ||
      registration.endpointId !== intent.endpointId || registration.companyId !== intent.companyId || registration.requestId !== intent.requestId ||
      registration.managerGrantId !== grant.id || registration.appId !== intent.appId || registration.manifestHash !== intent.manifestHash) fail();
  for (const prepared of [intent.preparedEndpoint, intent.preparedRegistration]) {
    if (prepared && (prepared.companyId !== intent.companyId || (prepared.endpointId ?? prepared.id) !== intent.endpointId)) fail();
  }
  for (const action of [intent.originalAction, intent.preparedAction]) if (action &&
      (action.companyId !== intent.companyId || action.endpointId !== intent.endpointId || action.providerActionId !== intent.reconnectKey)) fail();
  const validateSecrets = (ids: unknown[], descriptors: Record<string, z.infer<typeof secretSchema>>) => {
    const unique = new Set<string>();
    for (const id of ids) { if (!uuid.safeParse(id).success) fail(); else unique.add(id as string); }
    if (unique.size !== Object.keys(descriptors).length) fail();
    for (const id of unique) if (descriptors[id]?.identity.secretId !== id) fail();
  };
  validateSecrets([grant.accessSecretId, grant.refreshSecretId].filter(id => id !== null), intent.originalManagerSecrets);
  const refs = registration.secretIds;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) fail();
  else validateSecrets(Object.values(refs), intent.originalRegistrationSecrets);
});
const rawSchema = z.object({ status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string()), bodyBase64: z.string().max(1_400_000) }).strict();
const decodedSchema = z.object({ appId: z.string(), teamId: z.string(), botToken: z.string().startsWith("xoxb-") }).strict();
const rawEntrySchema = z.object({ schema: z.literal(1), kind: z.literal("managed-install-raw"), intent: intentSchema, raw: rawSchema }).strict();
const resultSchema = z.object({ schema: z.literal(1), kind: z.literal("managed-install-result"), intent: intentSchema, raw: rawSchema, decoded: decodedSchema }).strict()
  .refine(({ intent, raw, decoded }) => {
    try {
      const body = JSON.parse(Buffer.from(raw.bodyBase64, "base64").toString("utf8"));
      return raw.status >= 200 && raw.status < 300 && body.ok === true && body.app_id === intent.params.app_id && body.team_id === intent.params.team_id &&
        decoded.appId === body.app_id && decoded.teamId === body.team_id && decoded.botToken === body.api_access_tokens?.bot_access_token;
    } catch { return false; }
  }, "Exact structurally decoded original managed installation result required");
const entrySchema = z.union([intentSchema, rawEntrySchema, resultSchema]);
export type ManagedInstallIntent = z.infer<typeof intentSchema>;
export type ManagedInstallResult = z.infer<typeof resultSchema>;
export type ManagedInstallRawResponse = z.infer<typeof rawSchema>;
export type ManagedInstallEntry = z.infer<typeof entrySchema>;
export const managedInstallHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const managedInstallRecoveryRootPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-managed-install-recovery");
export const managedInstallRecoveryPath = (companyId: string, endpointId: string) => path.join(managedInstallRecoveryRootPath(), uuid.parse(companyId), `${uuid.parse(endpointId)}.json`);
export const managedInstallPending = () => Object.assign(new Error("Slack managed installation requires exact recovery inspection"), { code: "slack_managed_install_recovery_pending" });
const original = (entry: ManagedInstallEntry) => entry.kind === "managed-install-intent" ? entry : entry.intent;
const exact = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
type DirectorySnapshot = { names: string[]; dev: number; ino: number };
async function directoryIdentity(directory: string) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw managedInstallPending();
  return { dev: info.dev, ino: info.ino };
}
async function flushObserved(directory: string, observed: DirectorySnapshot) {
  await syncDirectory(directory);
  const current = await directoryIdentity(directory);
  if (current.dev !== observed.dev || current.ino !== observed.ino) throw managedInstallPending();
}
async function files(directory: string): Promise<DirectorySnapshot | null> {
  let identity;
  try { identity = await directoryIdentity(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const names = await fs.readdir(directory);
  if (names.some(name => !name.endsWith(".json") || !uuid.safeParse(name.slice(0, -5)).success)) throw managedInstallPending();
  const current = await directoryIdentity(directory);
  if (identity.dev !== current.dev || identity.ino !== current.ino) throw managedInstallPending();
  return { names, ...identity };
}
async function fileEntry(file: string): Promise<ManagedInstallEntry | null> {
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw managedInstallPending(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return entrySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material: JSON.parse(await fs.readFile(file, "utf8")), externalRef: null })));
}
async function inventory(companyId: string): Promise<ManagedInstallEntry[]> {
  uuid.parse(companyId);
  const directory = path.join(managedInstallRecoveryRootPath(), companyId);
  const names = await files(directory);
  if (names === null) return [];
  const entries: ManagedInstallEntry[] = [];
  for (const name of names.names) {
    const entry = await fileEntry(path.join(directory, name));
    if (!entry || original(entry).companyId !== companyId || `${original(entry).endpointId}.json` !== name) throw managedInstallPending();
    entries.push(entry);
  }
  await flushObserved(directory, names);
  return entries;
}
export function managedInstallRecovery(companyId: string, endpointId: string) {
  const file = managedInstallRecoveryPath(companyId, endpointId), directory = path.dirname(file);
  async function read() {
    const names = await files(directory);
    const entry = await fileEntry(file);
    if (!entry && names?.names.includes(path.basename(file))) throw managedInstallPending();
    if (!entry && names !== null) await flushObserved(directory, names);
    if (entry && names === null) throw managedInstallPending();
    if (entry && names !== null) {
      const current = await directoryIdentity(directory);
      if (current.dev !== names.dev || current.ino !== names.ino) throw managedInstallPending();
    }
    if (entry && (original(entry).companyId !== companyId || original(entry).endpointId !== endpointId)) throw managedInstallPending();
    return entry;
  }
  async function publish(input: ManagedInstallEntry) {
    const entry = entrySchema.parse(input);
    const encrypted = await localEncryptedProvider.createVersion({ value: JSON.stringify(entry) });
    await ensureDurableDirectory(directory);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let failed = false, failure: unknown;
    try { await handle.writeFile(JSON.stringify(encrypted.material)); await handle.sync(); }
    catch (error) { failed = true; failure = error; }
    try { await handle.close(); } catch (error) { failure = failed ? new AggregateError([failure, error], "Managed install write and close failed") : error; failed = true; }
    if (failed) throw failure; // Keep preparation occupancy; never infer non-effect.
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  }
  return {
    read,
    begin: async (input: ManagedInstallIntent) => {
      const intent = intentSchema.parse(input);
      if (intent.companyId !== companyId || intent.endpointId !== endpointId || await read()) throw managedInstallPending();
      await publish(intent);
    },
    recordRaw: async (input: { intent: ManagedInstallIntent; raw: z.infer<typeof rawSchema> }) => {
      const entry = rawEntrySchema.parse({ schema: 1, kind: "managed-install-raw", ...input });
      const retained = await read();
      if (!retained || exact(original(retained)) !== exact(entry.intent) || retained.kind !== "managed-install-intent" && exact(retained) !== exact(entry)) throw managedInstallPending();
      await publish(entry);
    },
    recordResult: async (input: { intent: ManagedInstallIntent; raw: z.infer<typeof rawSchema>; decoded: z.infer<typeof decodedSchema> }): Promise<ManagedInstallResult> => {
      const result = resultSchema.parse({ schema: 1, kind: "managed-install-result", ...input });
      const retained = await read();
      if (!retained || retained.kind === "managed-install-intent" || exact(retained.intent) !== exact(result.intent) || exact(retained.raw) !== exact(result.raw) || retained.kind === "managed-install-result" && exact(retained) !== exact(result)) throw managedInstallPending();
      await publish(result);
      return result;
    },
    clear: async (input: ManagedInstallResult) => {
      const result = resultSchema.parse(input), retained = await read();
      if (retained && (retained.kind !== "managed-install-result" || exact(retained) !== exact(result))) throw managedInstallPending();
      const observed = await files(directory);
      if (observed === null) throw managedInstallPending();
      await fs.rm(file, { force: true });
      await flushObserved(directory, observed);
    },
  };
}
export async function assertNoPendingManagedInstallForActor(companyId: string, actorUserId: string) {
  if ((await inventory(companyId)).some(entry => original(entry).actorUserId === actorUserId)) throw managedInstallPending();
}
export async function assertNoPendingManagedInstallForEndpoint(companyId: string, endpointId: string) {
  uuid.parse(endpointId);
  if ((await inventory(companyId)).some(entry => original(entry).endpointId === endpointId)) throw managedInstallPending();
}
export async function assertNoPendingManagedInstallForGrant(companyId: string, grantId: string) {
  uuid.parse(grantId);
  if ((await inventory(companyId)).some(entry => original(entry).originalManagerGrant.id === grantId)) throw managedInstallPending();
}
const occupies = (intent: ManagedInstallIntent, id: string) => id in intent.originalManagerSecrets || id in intent.originalRegistrationSecrets;
export async function assertNoPendingManagedInstallForSecret(companyId: string, secretId: string) {
  uuid.parse(secretId);
  if ((await inventory(companyId)).some(entry => occupies(original(entry), secretId))) throw managedInstallPending();
}
const settlement = new AsyncLocalStorage<{ active: boolean; result: ManagedInstallResult }>();
/** Local originating-result capability, never an independent outcome receipt. */
export async function withManagedInstallSettlement<T>(input: ManagedInstallResult, action: () => Promise<T>): Promise<T> {
  const result = resultSchema.parse(input), retained = await managedInstallRecovery(result.intent.companyId, result.intent.endpointId).read();
  if (!retained || retained.kind !== "managed-install-result" || exact(retained) !== exact(result)) throw managedInstallPending();
  const directory = path.dirname(managedInstallRecoveryPath(result.intent.companyId, result.intent.endpointId));
  const observed = await files(directory);
  if (observed === null) throw managedInstallPending();
  await flushObserved(directory, observed);
  const scope = { active: true, result };
  try { return await settlement.run(scope, action); } finally { scope.active = false; }
}
export async function assertManagedInstallSecretMutationAllowed(companyId: string, secretId: string, value?: string) {
  uuid.parse(secretId);
  for (const entry of await inventory(companyId)) {
    const intent = original(entry);
    if (!occupies(intent, secretId)) continue;
    const scope = settlement.getStore();
    const ids = intent.originalRegistration.secretIds as Record<string, unknown>;
    if (!scope?.active || entry.kind !== "managed-install-result" || exact(scope.result) !== exact(entry) ||
        secretId in intent.originalManagerSecrets || ids.botToken !== secretId ||
        Object.entries(ids).some(([role, id]) => role !== "botToken" && id === secretId) ||
        typeof value !== "string" || value !== entry.decoded.botToken) throw managedInstallPending();
  }
}

/** Only the originating exact result may finish its own application completion.
 * Generic resume and background entry points retain unconditional family guards. */
export async function assertManagedInstallCompletionAllowed(companyId: string, endpointId: string, requireActive = false) {
  uuid.parse(endpointId);
  let matched = false;
  for (const entry of await inventory(companyId)) {
    const intent = original(entry);
    if (intent.endpointId !== endpointId) continue;
    matched = true;
    const scope = settlement.getStore();
    if (!scope?.active || entry.kind !== "managed-install-result" ||
        scope.result.intent.companyId !== companyId || scope.result.intent.endpointId !== endpointId ||
        exact(scope.result) !== exact(entry)) throw managedInstallPending();
  }
  const scope = settlement.getStore();
  if (!matched && (requireActive || scope?.active && scope.result.intent.companyId === companyId && scope.result.intent.endpointId === endpointId)) throw managedInstallPending();
}

/** Parent authority and the distinct original cleanup must both be active. */
export async function assertManagedInstallSecretRemovalAllowed(companyId: string, secretId: string) {
  uuid.parse(secretId);
  for (const entry of await inventory(companyId)) {
    if (!occupies(original(entry), secretId)) continue;
    const scope = settlement.getStore();
    if (!scope?.active || entry.kind !== "managed-install-result" || exact(scope.result) !== exact(entry)) throw managedInstallPending();
    await assertStagedCleanupParentRemovalAllowed(companyId, secretId, entry.intent.operationId, stagedCleanupHash(entry));
  }
}

/** Retained original authority remains occupied even after mutable SQL references change. */
export async function assertNoPendingManagedInstallForDefinition(companyId: string, definitionId: string) {
  uuid.parse(definitionId);
  const scope = settlement.getStore();
  if (scope?.active) {
    const active = scope.result.intent;
    if (active.companyId === companyId && [...Object.values(active.originalManagerSecrets), ...Object.values(active.originalRegistrationSecrets)].some(role => role?.identity.authority.definition?.id === definitionId)) throw managedInstallPending();
  }
  if ((await inventory(companyId)).some(entry => [...Object.values(original(entry).originalManagerSecrets), ...Object.values(original(entry).originalRegistrationSecrets)].some(role => role.identity.authority.definition?.id === definitionId))) throw managedInstallPending();
}
