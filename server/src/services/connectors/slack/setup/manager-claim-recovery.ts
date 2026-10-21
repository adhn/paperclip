import { AsyncLocalStorage } from "node:async_hooks";
import { connectorRecoveryAuthoritySchema } from "../../../connector-recovery-authority.js";
import { secretRecoveryIdentitySchema } from "../../../secret-recovery-identity-schema.js";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SLACK_MANAGER_SCOPES } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../../../../home-paths.js";
import { localEncryptedProvider } from "../../../../secrets/local-encrypted-provider.js";
import { ensureDurableDirectory, syncDirectory } from "../../../../lib/durable-directory.js";
import type { SealedConnectorCredentials } from "../../../paperclip-cloud-connector.js";
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const originalSecretSchema = z.object({ identity: secretRecoveryIdentitySchema, valueHash: hash }).strict();
const intentSchema = z.object({ schema: z.literal(1), kind: z.literal("manager-claim-intent"),
  family: z.enum(["slack.manager.claim.hosted", "slack.manager.oauth.development"]), clientMode: z.enum(["claim", "code"]),
  operationId: uuid, redemptionId: uuid, companyId: uuid, endpointId: uuid,
  managerAppId: z.string().regex(/^A[A-Z0-9]+$/),
  originalConnection: z.record(z.string(), z.unknown()),
  actorUserId: z.string().min(1), actorSessionId: z.string().nullable(), stateHash: hash, codeHash: hash,
  originalEndpoint: z.record(z.string(), z.unknown()), originalRegistration: z.record(z.string(), z.unknown()).nullable(),
  originalOauthState: z.record(z.string(), z.unknown()), originalGrants: z.array(z.record(z.string(), z.unknown())),
  originalSecrets: z.record(uuid, originalSecretSchema), originalClientAuthority: connectorRecoveryAuthoritySchema,
}).strict().superRefine((value, context) => {
  if ((value.clientMode === "claim") !== (value.family === "slack.manager.claim.hosted") ||
      (value.clientMode === "claim") !== (value.originalClientAuthority.kind === "hosted-sealed")) context.addIssue({ code: "custom", message: "Original claim family and client mode disagree" });
  if (value.originalClientAuthority.kind === "development-direct-oauth" && value.originalClientAuthority.appId !== value.managerAppId) context.addIssue({ code: "custom", message: "Original manager app authority mismatch" });
  if (!uuid.safeParse(value.originalConnection.id).success || value.originalConnection.id !== value.originalEndpoint.connectionId ||
      value.originalOauthState.connectionId !== value.originalConnection.id || value.originalConnection.companyId !== value.companyId) context.addIssue({ code: "custom", message: "Exact original connection required" });
  const ids = new Set<string>();
  for (const grant of value.originalGrants) {
    if (!uuid.safeParse(grant.id).success || grant.companyId !== value.companyId || grant.userId !== value.actorUserId) context.addIssue({ code: "custom", message: "Original grant owner identity required" });
    for (const key of ["accessSecretId", "refreshSecretId"]) {
      const id = grant[key];
      if (id === null) continue;
      if (!uuid.safeParse(id).success) context.addIssue({ code: "custom", message: "Original grant references must be explicit" });
      else ids.add(id as string);
    }
  }
  if (ids.size !== Object.keys(value.originalSecrets).length || [...ids].some(id => value.originalSecrets[id]?.identity.secretId !== id)) context.addIssue({ code: "custom", message: "Every original grant credential requires exact authority" });
  if (value.originalEndpoint.id !== value.endpointId || value.originalEndpoint.companyId !== value.companyId ||
      value.originalOauthState.companyId !== value.companyId || value.originalOauthState.createdByActorId !== value.actorUserId ||
      value.originalOauthState.createdBySessionId !== value.actorSessionId || typeof value.originalOauthState.state !== "string" ||
      managerClaimHash(value.originalOauthState.state) !== value.stateHash) context.addIssue({ code: "custom", message: "Exact original endpoint and OAuth owner required" });
});
const rawSchema = z.object({ status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string()), bodyBase64: z.string().max(1_400_000) }).strict();
const credentialsSchema = z.object({ v: z.literal(1), accessToken: z.string().min(1), refreshToken: z.string().min(1), tokenType: z.literal("user"),
  accessTokenExpiresAt: z.string(), refreshTokenExpiresAt: z.string().nullable(), scopes: z.array(z.string()), subject: z.string(), companyId: z.string(), instanceId: z.string(),
  environment: z.enum(["production", "staging", "test", "development"]), provider: z.literal("slack"), profile: z.literal("slack.manager"),
  appSlug: z.string().optional(), slackManager: z.object({ appId: z.string(), workspaceId: z.string(), workspaceName: z.string(), userId: z.string() }).optional(),
}).strict();
const rawEntrySchema = z.object({ schema: z.literal(1), kind: z.literal("manager-claim-raw"), intent: intentSchema, raw: rawSchema }).strict();
const resultSchema = z.object({ schema: z.literal(1), kind: z.literal("manager-claim-result"), intent: intentSchema, raw: rawSchema, credentials: credentialsSchema }).strict()
  .refine(({ intent, raw, credentials }) => raw.status >= 200 && raw.status < 300 && credentials.companyId === intent.companyId && credentials.subject === intent.actorUserId,
    "Exact structurally decoded claim result required");
const entrySchema = z.union([intentSchema, rawEntrySchema, resultSchema]);
export type ManagerClaimIntent = z.infer<typeof intentSchema>;
export type ManagerClaimResult = z.infer<typeof resultSchema>;
export type ManagerClaimRawResponse = z.infer<typeof rawSchema>;
export type ManagerClaimEntry = z.infer<typeof entrySchema>;
export const managerClaimHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const managerClaimRecoveryRootPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-manager-claim-recovery");
export const managerClaimRecoveryPath = (companyId: string, endpointId: string) => path.join(managerClaimRecoveryRootPath(), uuid.parse(companyId), `${uuid.parse(endpointId)}.json`);
export const managerClaimPending = () => Object.assign(new Error("Slack manager claim requires exact recovery inspection"), { code: "slack_manager_claim_recovery_pending" });
const original = (entry: ManagerClaimEntry) => entry.kind === "manager-claim-intent" ? entry : entry.intent;
const exact = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
type DirectorySnapshot = { names: string[]; dev: number; ino: number };
async function directoryIdentity(directory: string) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw managerClaimPending();
  return { dev: info.dev, ino: info.ino };
}
async function flushObserved(directory: string, observed: DirectorySnapshot) {
  await syncDirectory(directory);
  const current = await directoryIdentity(directory);
  if (current.dev !== observed.dev || current.ino !== observed.ino) throw managerClaimPending();
}
async function files(directory: string): Promise<DirectorySnapshot | null> {
  let identity;
  try { identity = await directoryIdentity(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const names = await fs.readdir(directory);
  if (names.some(name => !name.endsWith(".json") || !uuid.safeParse(name.slice(0, -5)).success)) throw managerClaimPending();
  const current = await directoryIdentity(directory);
  if (identity.dev !== current.dev || identity.ino !== current.ino) throw managerClaimPending();
  return { names, ...identity };
}
async function fileEntry(file: string): Promise<ManagerClaimEntry | null> {
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw managerClaimPending(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return entrySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material: JSON.parse(await fs.readFile(file, "utf8")), externalRef: null })));
}
async function inventory(companyId: string): Promise<ManagerClaimEntry[]> {
  uuid.parse(companyId);
  const directory = path.join(managerClaimRecoveryRootPath(), companyId);
  const names = await files(directory);
  if (names === null) return [];
  const entries: ManagerClaimEntry[] = [];
  for (const name of names.names) {
    const entry = await fileEntry(path.join(directory, name));
    if (!entry || original(entry).companyId !== companyId || `${original(entry).endpointId}.json` !== name) throw managerClaimPending();
    entries.push(entry);
  }
  await flushObserved(directory, names);
  return entries;
}
export function managerClaimRecovery(companyId: string, endpointId: string) {
  const file = managerClaimRecoveryPath(companyId, endpointId), directory = path.dirname(file);
  async function read() {
    const names = await files(directory);
    const entry = await fileEntry(file);
    if (!entry && names?.names.includes(path.basename(file))) throw managerClaimPending();
    if (!entry && names !== null) await flushObserved(directory, names);
    if (entry && names === null) throw managerClaimPending();
    if (entry && names !== null) {
      const current = await directoryIdentity(directory);
      if (current.dev !== names.dev || current.ino !== names.ino) throw managerClaimPending();
    }
    if (entry && (original(entry).companyId !== companyId || original(entry).endpointId !== endpointId)) throw managerClaimPending();
    return entry;
  }
  async function publish(input: ManagerClaimEntry) {
    const entry = entrySchema.parse(input);
    const encrypted = await localEncryptedProvider.createVersion({ value: JSON.stringify(entry) });
    await ensureDurableDirectory(directory);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let failed = false, failure: unknown;
    try { await handle.writeFile(JSON.stringify(encrypted.material)); await handle.sync(); }
    catch (error) { failed = true; failure = error; }
    try { await handle.close(); } catch (error) { failure = failed ? new AggregateError([failure, error], "Manager claim write and close failed") : error; failed = true; }
    if (failed) throw failure; // Keep preparation occupancy; never infer non-effect.
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  }
  return {
    read,
    begin: async (input: ManagerClaimIntent) => {
      const intent = intentSchema.parse(input);
      if (intent.companyId !== companyId || intent.endpointId !== endpointId || await read()) throw managerClaimPending();
      await publish(intent);
    },
    recordRaw: async (input: { intent: ManagerClaimIntent; raw: z.infer<typeof rawSchema> }) => {
      const entry = rawEntrySchema.parse({ schema: 1, kind: "manager-claim-raw", ...input });
      const retained = await read();
      if (!retained || exact(original(retained)) !== exact(entry.intent) || retained.kind !== "manager-claim-intent" && exact(retained) !== exact(entry)) throw managerClaimPending();
      await publish(entry);
    },
    recordResult: async (input: { intent: ManagerClaimIntent; raw: z.infer<typeof rawSchema>; credentials: SealedConnectorCredentials }): Promise<ManagerClaimResult> => {
      const result = resultSchema.parse({ schema: 1, kind: "manager-claim-result", ...input });
      const retained = await read();
      if (!retained || retained.kind === "manager-claim-intent" || exact(retained.intent) !== exact(result.intent) || exact(retained.raw) !== exact(result.raw) || retained.kind === "manager-claim-result" && exact(retained) !== exact(result)) throw managerClaimPending();
      await publish(result);
      return result;
    },
    clear: async (input: ManagerClaimResult) => {
      const result = resultSchema.parse(input), retained = await read();
      if (retained && (retained.kind !== "manager-claim-result" || exact(retained) !== exact(result))) throw managerClaimPending();
      const observed = await files(directory);
      if (observed === null) throw managerClaimPending();
      await fs.rm(file, { force: true });
      await flushObserved(directory, observed);
    },
  };
}
export async function assertNoPendingManagerClaimForActor(companyId: string, userId: string) {
  if ((await inventory(companyId)).some(entry => original(entry).actorUserId === userId)) throw managerClaimPending();
}
export async function assertNoPendingManagerClaimForEndpoint(companyId: string, endpointId: string) {
  uuid.parse(endpointId);
  if ((await inventory(companyId)).some(entry => original(entry).endpointId === endpointId)) throw managerClaimPending();
}
export async function assertNoPendingManagerClaimForSecret(companyId: string, secretId: string) {
  uuid.parse(secretId);
  if ((await inventory(companyId)).some(entry => secretId in original(entry).originalSecrets)) throw managerClaimPending();
}

const settlement = new AsyncLocalStorage<{ active: boolean; result: ManagerClaimResult }>();
/** Only the originating acknowledged-save path may enter this local scope.
 * This capability is not an outcome receipt or permission to replay claim. */
export async function withManagerClaimSettlement<T>(input: ManagerClaimResult, action: () => Promise<T>): Promise<T> {
  const result = resultSchema.parse(input);
  const authority = result.intent.originalClientAuthority;
  if (!Number.isFinite(Date.parse(result.credentials.accessTokenExpiresAt)) || Date.parse(result.credentials.accessTokenExpiresAt) <= Date.now() ||
      SLACK_MANAGER_SCOPES.some(scope => !result.credentials.scopes.includes(scope)) ||
      (authority.kind === "hosted-sealed"
        ? result.credentials.instanceId !== authority.instanceId || result.credentials.environment !== authority.environment
        : result.credentials.instanceId !== "local-slack-qualification" || result.credentials.environment !== "development")) throw managerClaimPending();
  const retained = await managerClaimRecovery(result.intent.companyId, result.intent.endpointId).read();
  if (!retained || retained.kind !== "manager-claim-result" || exact(retained) !== exact(result)) throw managerClaimPending();
  const directory = path.dirname(managerClaimRecoveryPath(result.intent.companyId, result.intent.endpointId));
  const observed = await files(directory);
  if (observed === null) throw managerClaimPending();
  await flushObserved(directory, observed);
  const scope = { active: true, result };
  try { return await settlement.run(scope, action); }
  finally { scope.active = false; }
}
export async function assertManagerClaimSecretMutationAllowed(companyId: string, secretId: string, value?: string) {
  uuid.parse(secretId);
  for (const entry of await inventory(companyId)) {
    const intent = original(entry);
    if (!(secretId in intent.originalSecrets)) continue;
    const roles = new Set<string>();
    const targets = new Set<string>();
    let targetMatches = true;
    const identity = entry.kind === "manager-claim-result" ? entry.credentials.slackManager : undefined;
    for (const grant of intent.originalGrants) {
      if (grant.accessSecretId === secretId || grant.refreshSecretId === secretId) {
        targets.add(String(grant.id));
        if (!identity || identity.appId !== intent.managerAppId || grant.managerAppId !== identity.appId || grant.workspaceId !== identity.workspaceId || grant.slackUserId !== identity.userId) targetMatches = false;
      }
      if (grant.accessSecretId === secretId) roles.add("accessToken");
      if (grant.refreshSecretId === secretId) roles.add("refreshToken");
    }
    const scope = settlement.getStore();
    if (!scope?.active || entry.kind !== "manager-claim-result" || exact(scope.result) !== exact(entry) ||
        roles.size !== 1 || targets.size !== 1 || !targetMatches || typeof value !== "string") throw managerClaimPending();
    const role = [...roles][0] as "accessToken" | "refreshToken";
    if (value !== entry.credentials[role]) throw managerClaimPending();
  }
}

export async function assertNoPendingManagerClaimForCompany(companyId: string) {
  if ((await inventory(companyId)).length) throw managerClaimPending();
}

/** Retained original authority remains occupied even after mutable SQL references change. */
export async function assertNoPendingManagerClaimForDefinition(companyId: string, definitionId: string) {
  uuid.parse(definitionId);
  const scope = settlement.getStore();
  if (scope?.active) {
    const active = scope.result.intent;
    if (active.companyId === companyId && Object.values(active.originalSecrets).some(role => role?.identity.authority.definition?.id === definitionId)) throw managerClaimPending();
  }
  if ((await inventory(companyId)).some(entry => Object.values(original(entry).originalSecrets).some(role => role.identity.authority.definition?.id === definitionId))) throw managerClaimPending();
}
