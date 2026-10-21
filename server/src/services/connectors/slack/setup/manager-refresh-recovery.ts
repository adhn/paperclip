import { connectorRecoveryAuthoritySchema } from "../../../connector-recovery-authority.js";
import { secretRecoveryIdentitySchema } from "../../../secret-recovery-identity-schema.js";
import { AsyncLocalStorage } from "node:async_hooks";
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
const predecessor = z.object({ identity: secretRecoveryIdentitySchema, secretId: uuid, latestVersion: z.number().int().positive(), valueHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(value => value.identity.secretId === value.secretId && value.identity.version === value.latestVersion, "Exact original version identity required");
const intentSchema = z.object({ schema: z.literal(1), kind: z.literal("manager-refresh-intent"), family: z.literal("slack.manager.refresh"), operationId: uuid,
  companyId: uuid, grantId: uuid, ownerUserId: z.string().min(1), managerAppId: z.string().min(1), workspaceId: z.string().min(1), slackUserId: z.string().min(1),
  profile: z.literal("slack.manager"), clientAuthority: connectorRecoveryAuthoritySchema, clientMode: z.enum(["claim", "code"]), originalRevision: z.number().int().nonnegative(), claimedRevision: z.number().int().positive(),
  access: predecessor, refresh: predecessor,
}).strict().refine(value => value.claimedRevision === value.originalRevision + 1 && value.access.secretId !== value.refresh.secretId && (value.clientMode === "code") === (value.clientAuthority.kind === "development-direct-oauth") &&
  (value.clientAuthority.kind !== "development-direct-oauth" || value.managerAppId === value.clientAuthority.appId), "Exact independent predecessors and client authority required");
const rawSchema = z.object({ status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string()), bodyBase64: z.string().max(1_400_000) }).strict();
const credentialsSchema = z.object({ v: z.literal(1), accessToken: z.string().min(1), refreshToken: z.string().min(1), tokenType: z.literal("user"),
  accessTokenExpiresAt: z.string(), refreshTokenExpiresAt: z.string().nullable(), scopes: z.array(z.string()), subject: z.string(), companyId: z.string(), instanceId: z.string(),
  environment: z.enum(["production", "staging", "test", "development"]), provider: z.literal("slack"), profile: z.literal("slack.manager"),
  appSlug: z.string().optional(), slackManager: z.object({ appId: z.string(), workspaceId: z.string(), workspaceName: z.string(), userId: z.string() }).optional(),
}).strict();
const rawEntrySchema = z.object({ schema: z.literal(1), kind: z.literal("manager-refresh-raw"), intent: intentSchema, raw: rawSchema }).strict();
const resultSchema = z.object({ schema: z.literal(1), kind: z.literal("manager-refresh-result"), intent: intentSchema, raw: rawSchema, credentials: credentialsSchema }).strict()
  .refine(({ intent, raw, credentials }) => raw.status >= 200 && raw.status < 300 && credentials.companyId === intent.companyId && credentials.subject === intent.ownerUserId &&
    SLACK_MANAGER_SCOPES.every(scope => credentials.scopes.includes(scope)) && Number.isFinite(Date.parse(credentials.accessTokenExpiresAt)) &&
    (intent.clientAuthority.kind === "hosted-sealed" ? credentials.instanceId === intent.clientAuthority.instanceId && credentials.environment === intent.clientAuthority.environment :
      credentials.instanceId === "local-slack-qualification" && credentials.environment === "development") &&
    (!credentials.slackManager || credentials.slackManager.appId === intent.managerAppId && credentials.slackManager.workspaceId === intent.workspaceId && credentials.slackManager.userId === intent.slackUserId), "Exact validated manager result required");
const entrySchema = z.union([intentSchema, rawEntrySchema, resultSchema]);
export type ManagerRefreshIntent = z.infer<typeof intentSchema>;
export type ManagerRefreshResult = z.infer<typeof resultSchema>;
export type ManagerRefreshEntry = z.infer<typeof entrySchema>;
export const managerRefreshHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const managerRefreshRecoveryRootPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-manager-refresh-recovery");
export const managerRefreshRecoveryPath = (companyId: string, grantId: string) => path.join(managerRefreshRecoveryRootPath(), uuid.parse(companyId), `${uuid.parse(grantId)}.json`);
export const managerRefreshPending = () => Object.assign(new Error("Slack manager refresh requires exact recovery inspection"), { code: "slack_manager_refresh_recovery_pending" });
const original = (entry: ManagerRefreshEntry) => entry.kind === "manager-refresh-intent" ? entry : entry.intent;
const exact = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const settlement = new AsyncLocalStorage<{ active: boolean; result: ManagerRefreshResult }>();
async function files(directory: string): Promise<string[] | null> {
  try { const info = await fs.lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw managerRefreshPending(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const names = await fs.readdir(directory);
  if (names.some(name => !name.endsWith(".json") || !uuid.safeParse(name.slice(0, -5)).success)) throw managerRefreshPending();
  return names;
}
async function fileEntry(file: string): Promise<ManagerRefreshEntry | null> {
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw managerRefreshPending(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return entrySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material: JSON.parse(await fs.readFile(file, "utf8")), externalRef: null })));
}
async function inventory(companyId: string): Promise<ManagerRefreshEntry[]> {
  uuid.parse(companyId);
  const directory = path.join(managerRefreshRecoveryRootPath(), companyId);
  const names = await files(directory);
  if (names === null) return [];
  const entries: ManagerRefreshEntry[] = [];
  for (const name of names) {
    const entry = await fileEntry(path.join(directory, name));
    if (!entry || original(entry).companyId !== companyId || `${original(entry).grantId}.json` !== name) throw managerRefreshPending();
    entries.push(entry);
  }
  await syncDirectory(directory);
  return entries;
}
export function managerRefreshRecovery(companyId: string, grantId: string) {
  const file = managerRefreshRecoveryPath(companyId, grantId), directory = path.dirname(file);
  async function read() {
    const names = await files(directory);
    const entry = await fileEntry(file);
    if (!entry && names?.includes(path.basename(file))) throw managerRefreshPending();
    if (!entry && names !== null) await syncDirectory(directory);
    if (entry && (original(entry).companyId !== companyId || original(entry).grantId !== grantId)) throw managerRefreshPending();
    return entry;
  }
  async function publish(input: ManagerRefreshEntry) {
    const entry = entrySchema.parse(input);
    const encrypted = await localEncryptedProvider.createVersion({ value: JSON.stringify(entry) });
    await ensureDurableDirectory(directory);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let failed = false, failure: unknown;
    try { await handle.writeFile(JSON.stringify(encrypted.material)); await handle.sync(); }
    catch (error) { failed = true; failure = error; }
    try { await handle.close(); } catch (error) { failure = failed ? new AggregateError([failure, error], "Manager refresh write and close failed") : error; failed = true; }
    if (failed) throw failure; // Keep preparation occupancy; never infer non-effect.
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  }
  return {
    read,
    begin: async (input: ManagerRefreshIntent) => {
      const intent = intentSchema.parse(input);
      if (intent.companyId !== companyId || intent.grantId !== grantId || await read()) throw managerRefreshPending();
      await publish(intent);
    },
    recordRaw: async (input: { intent: ManagerRefreshIntent; raw: z.infer<typeof rawSchema> }) => {
      const entry = rawEntrySchema.parse({ schema: 1, kind: "manager-refresh-raw", ...input });
      const retained = await read();
      if (!retained || exact(original(retained)) !== exact(entry.intent) || retained.kind !== "manager-refresh-intent" && exact(retained) !== exact(entry)) throw managerRefreshPending();
      await publish(entry);
    },
    recordResult: async (input: { intent: ManagerRefreshIntent; raw: z.infer<typeof rawSchema>; credentials: SealedConnectorCredentials }): Promise<ManagerRefreshResult> => {
      const result = resultSchema.parse({ schema: 1, kind: "manager-refresh-result", ...input });
      const retained = await read();
      if (!retained || retained.kind === "manager-refresh-intent" || exact(retained.intent) !== exact(result.intent) || exact(retained.raw) !== exact(result.raw) || retained.kind === "manager-refresh-result" && exact(retained) !== exact(result)) throw managerRefreshPending();
      await publish(result);
      return result;
    },
    clear: async (input: ManagerRefreshResult) => {
      const result = resultSchema.parse(input), retained = await read();
      if (retained && (retained.kind !== "manager-refresh-result" || exact(retained) !== exact(result))) throw managerRefreshPending();
      await fs.rm(file, { force: true });
      const names = await files(directory);
      if (names !== null) await syncDirectory(directory);
    },
  };
}
export async function assertNoPendingManagerRefreshForActor(companyId: string, userId: string) {
  if ((await inventory(companyId)).some(entry => original(entry).ownerUserId === userId)) throw managerRefreshPending();
}
export async function withManagerRefreshSettlement<T>(input: ManagerRefreshResult, action: () => Promise<T>): Promise<T> {
  const result = resultSchema.parse(input), retained = await managerRefreshRecovery(result.intent.companyId, result.intent.grantId).read();
  if (!retained || retained.kind !== "manager-refresh-result" || exact(retained) !== exact(result) || Date.parse(result.credentials.accessTokenExpiresAt) <= Date.now()) throw managerRefreshPending();
  await syncDirectory(path.dirname(managerRefreshRecoveryPath(result.intent.companyId, result.intent.grantId)));
  const scope = { active: true, result };
  try { return await settlement.run(scope, action); } finally { scope.active = false; }
}
export async function assertManagerRefreshSaveAllowed(companyId: string, userId: string, grantId: string, credentials: SealedConnectorCredentials) {
  for (const entry of await inventory(companyId)) if (original(entry).ownerUserId === userId) {
    const scope = settlement.getStore();
    if (!scope?.active || entry.kind !== "manager-refresh-result" || exact(scope.result) !== exact(entry) || entry.intent.grantId !== grantId || exact(credentials) !== exact(entry.credentials)) throw managerRefreshPending();
  }
}
export async function assertManagerRefreshSecretMutationAllowed(companyId: string, secretId: string, value?: string) {
  uuid.parse(secretId);
  for (const entry of await inventory(companyId)) {
    const intent = original(entry);
    const which = intent.access.secretId === secretId ? "accessToken" : intent.refresh.secretId === secretId ? "refreshToken" : null;
    if (!which) continue;
    const scope = settlement.getStore();
    if (!scope?.active || entry.kind !== "manager-refresh-result" || exact(scope.result) !== exact(entry) || typeof value !== "string" || value !== entry.credentials[which]) throw managerRefreshPending();
  }
}

export async function assertNoPendingManagerRefreshForCompany(companyId: string) {
  if ((await inventory(companyId)).length) throw managerRefreshPending();
}

/** Retained original authority remains occupied even after mutable SQL references change. */
export async function assertNoPendingManagerRefreshForDefinition(companyId: string, definitionId: string) {
  uuid.parse(definitionId);
  const scope = settlement.getStore();
  if (scope?.active) {
    const active = scope.result.intent;
    if (active.companyId === companyId && [active.access, active.refresh].some(role => role?.identity.authority.definition?.id === definitionId)) throw managerRefreshPending();
  }
  if ((await inventory(companyId)).some(entry => [original(entry).access, original(entry).refresh].some(role => role.identity.authority.definition?.id === definitionId))) throw managerRefreshPending();
}
