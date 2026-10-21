import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolvePaperclipInstanceRoot } from "../../../../home-paths.js";
import { localEncryptedProvider } from "../../../../secrets/local-encrypted-provider.js";
import { ensureDurableDirectory, syncDirectory } from "../../../../lib/durable-directory.js";

const uuid = z.string().uuid();
const intentSchema = z.object({
  schema: z.literal(1), kind: z.literal("slack-install-intent"), operationId: uuid,
  companyId: uuid, endpointId: uuid, connectionId: uuid, requestId: uuid,
  state: z.string().regex(/^slack-install\.[A-Za-z0-9_-]{43}$/),
  appId: z.string().min(1), clientId: z.string().min(1), callbackUri: z.string().url(),
  runtimeGeneration: z.number().int().nonnegative(), actorUserId: z.string().min(1),
  actorSessionId: z.string().nullable(), requestedScopes: z.array(z.string()),
  codeHash: z.string().regex(/^[a-f0-9]{64}$/), secretIds: z.record(z.string(), uuid),
  originalBotTokenHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  originalClientSecretHash: z.string().regex(/^[a-f0-9]{64}$/), managerGrantId: uuid.nullable(),
  originalWorkspaceId: z.string().nullable(), originalBotUserId: z.string().nullable(),
  originalProviderAccountId: z.string().nullable(), originalBotExternalId: z.string().nullable(),
  originalAccount: z.record(z.string(), z.unknown()),
  originalSecretIdentities: z.record(z.string(), z.object({ secretId: uuid, versionId: uuid, version: z.number().int().positive(), authority: z.object({ parent: z.record(z.string(), z.unknown()), version: z.record(z.string(), z.unknown()), definition: z.record(z.string(), z.unknown()).nullable(), providerConfig: z.record(z.string(), z.unknown()).nullable() }).strict() }).strict()),
}).strict().refine(entry => Object.keys(entry.secretIds).length === Object.keys(entry.originalSecretIdentities).length &&
  Object.entries(entry.secretIds).every(([key, id]) => entry.originalSecretIdentities[key]?.secretId === id), "Every original credential requires its exact authority descriptor").refine(entry => Boolean(entry.secretIds.botToken) === (entry.originalBotTokenHash !== null),
  "Original bot credential identity and hash must agree");
const resultSchema = z.object({ schema: z.literal(1), kind: z.literal("slack-install-result"),
  intent: intentSchema, raw: z.object({ status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()), bodyBase64: z.string().max(1_400_000),
  }).strict(),
}).strict();
const entrySchema = z.union([intentSchema, resultSchema]);
export type SlackInstallIntent = z.infer<typeof intentSchema>;
export type SlackInstallRawResponse = z.infer<typeof resultSchema>["raw"];
export type SlackInstallResult = z.infer<typeof resultSchema>;
export type SlackInstallRecoveryEntry = z.infer<typeof entrySchema>;
export const slackInstallCredentialHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const slackInstallRecoveryRootPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-install-recovery");
export const slackInstallRecoveryPath = (companyId: string, endpointId: string) =>
  path.join(slackInstallRecoveryRootPath(), uuid.parse(companyId), `${uuid.parse(endpointId)}.json`);
const pending = () => Object.assign(new Error("Slack installation requires exact recovery inspection"), { code: "slack_install_recovery_pending" });
const original = (entry: SlackInstallRecoveryEntry) => entry.kind === "slack-install-intent" ? entry : entry.intent;
const exact = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

const settlement = new AsyncLocalStorage<{ active: boolean; result: SlackInstallResult }>();
function resultToken(result: SlackInstallResult): string | null {
  if (result.raw.status < 200 || result.raw.status >= 300) return null;
  try {
    const body = JSON.parse(Buffer.from(result.raw.bodyBase64, "base64").toString("utf8"));
    return body?.ok === true && body.app_id === result.intent.appId && body.token_type === "bot" &&
      typeof body.access_token === "string" && body.access_token.startsWith("xoxb-") ? body.access_token : null;
  } catch { return null; }
}

async function companyFiles(directory: string): Promise<string[] | null> {
  let info;
  try { info = await fs.lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw pending();
  // Once observed, failed enumeration is uncertainty, including a directory
  // disappearing after lstat. Only initial absence means no retained entries.
  const files = await fs.readdir(directory);
  // A partial publication has unknown ownership/outcome. Never silently skip it.
  if (files.some(name => !/^[0-9a-f-]{36}\.json$/i.test(name) || !uuid.safeParse(name.slice(0, -5)).success)) throw pending();
  return files;
}
async function readFileEntry(file: string): Promise<SlackInstallRecoveryEntry | null> {
  let info;
  try { info = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw pending();
  const material = JSON.parse(await fs.readFile(file, "utf8"));
  return entrySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material, externalRef: null })));
}
/** Caller holds original endpoint credential-mutation lock throughout this
 * local protocol and SQL settlement. No physical COMMIT/retirement claim. */
export function slackInstallRecovery(companyId: string, endpointId: string) {
  const file = slackInstallRecoveryPath(companyId, endpointId);
  const directory = path.dirname(file);
  async function read() {
    const files = await companyFiles(directory);
    const entry = await readFileEntry(file);
    if (!entry && files?.includes(path.basename(file))) throw pending();
    // A known SQL-settled result may have been unlinked before a failed flush.
    // New-use absence must finish that directory barrier, never infer no effect.
    if (!entry && files !== null) await syncDirectory(directory);
    if (entry && (original(entry).companyId !== companyId || original(entry).endpointId !== endpointId)) throw pending();
    return entry;
  }
  async function publish(entry: SlackInstallRecoveryEntry) {
    const material = await localEncryptedProvider.createVersion({ value: JSON.stringify(entrySchema.parse(entry)) });
    await ensureDurableDirectory(directory);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let failed = false;
    let failure: unknown;
    try { await handle.writeFile(JSON.stringify(material.material)); await handle.sync(); }
    catch (error) { failed = true; failure = error; }
    try { await handle.close(); }
    catch (error) { failure = failed ? new AggregateError([failure, error], "Slack recovery write and close failed") : error; failed = true; }
    // Failed preparation remains a private uncertainty marker. Do not delete
    // evidence or authorize another exchange merely because rename did not run.
    if (failed) throw failure;
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  }
  return {
    read,
    beginExchange: async (input: SlackInstallIntent) => {
      const intent = intentSchema.parse(input);
      if (intent.companyId !== companyId || intent.endpointId !== endpointId) throw pending();
      if (await read()) throw pending();
      await publish(intent);
    },
    completeExchange: async (input: SlackInstallResult) => {
      const result = resultSchema.parse(input);
      const retained = await read();
      if (!retained || exact(original(retained)) !== exact(result.intent) ||
          retained.kind === "slack-install-result" && exact(retained) !== exact(result)) throw pending();
      await publish(result);
    },
    clear: async (input: SlackInstallResult) => {
      const expected = resultSchema.parse(input);
      const retained = await read();
      if (retained && (retained.kind !== "slack-install-result" || exact(retained) !== exact(expected))) throw pending();
      // A lost deletion-fsync response must be repairable without a second effect.
      await fs.rm(file, { force: true });
      try { await fs.stat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      await syncDirectory(directory);
    },
  };
}
export async function assertNoPendingSlackInstall(companyId: string, endpointId: string) {
  if (await slackInstallRecovery(companyId, endpointId).read()) throw pending();
}
/** Inspect original secret identities independently of current SQL refs. */
export async function assertNoPendingSlackInstallForSecret(companyId: string, secretId: string) {
  uuid.parse(companyId); uuid.parse(secretId);
  const directory = path.join(slackInstallRecoveryRootPath(), companyId);
  const files = await companyFiles(directory);
  if (files === null) return;
  for (const name of files) {
    const entry = await readFileEntry(path.join(directory, name));
    if (!entry) throw pending();
    const intent = original(entry);
    if (intent.companyId !== companyId || `${intent.endpointId}.json` !== name) throw pending();
    if (Object.values(intent.secretIds).includes(secretId)) throw pending();
  }
  await syncDirectory(directory);
}

/** Narrow settlement capability, not a general recovery or credential bypass. */
export async function withSlackInstallResultSettlement<T>(input: SlackInstallResult, action: () => Promise<T>): Promise<T> {
  const result = resultSchema.parse(input);
  const retained = await slackInstallRecovery(result.intent.companyId, result.intent.endpointId).read();
  if (!retained || retained.kind !== "slack-install-result" || exact(retained) !== exact(result) || !resultToken(result)) throw pending();
  await syncDirectory(path.dirname(slackInstallRecoveryPath(result.intent.companyId, result.intent.endpointId)));
  const scope = { active: true, result };
  try { return await settlement.run(scope, action); }
  finally { scope.active = false; }
}
export async function assertSlackInstallSecretMutationAllowed(companyId: string, secretId: string, value?: string) {
  uuid.parse(companyId); uuid.parse(secretId);
  const directory = path.join(slackInstallRecoveryRootPath(), companyId);
  const files = await companyFiles(directory);
  if (files === null) return;
  const matches: SlackInstallRecoveryEntry[] = [];
  for (const name of files) {
    const entry = await readFileEntry(path.join(directory, name));
    if (!entry || original(entry).companyId !== companyId || `${original(entry).endpointId}.json` !== name) throw pending();
    if (Object.values(original(entry).secretIds).includes(secretId)) matches.push(entry);
  }
  await syncDirectory(directory);
  for (const entry of matches) {
    const scope = settlement.getStore();
    if (!scope?.active || entry.kind !== "slack-install-result" || exact(scope.result) !== exact(entry) ||
        entry.intent.secretIds.botToken !== secretId || typeof value !== "string" || resultToken(entry) !== value) throw pending();
  }
}

/** Inspect retained original definitions independently of mutable SQL refs. */
export async function assertNoPendingSlackInstallForDefinition(companyId: string, definitionId: string) {
  uuid.parse(companyId); uuid.parse(definitionId);
  const directory = path.join(slackInstallRecoveryRootPath(), companyId);
  const files = await companyFiles(directory);
  if (files === null) return;
  for (const name of files) {
    const entry = await readFileEntry(path.join(directory, name));
    if (!entry) throw pending();
    const intent = original(entry);
    if (intent.companyId !== companyId || `${intent.endpointId}.json` !== name) throw pending();
    if (Object.values(intent.originalSecretIdentities).some(identity => identity.authority.definition?.id === definitionId)) throw pending();
  }
  await syncDirectory(directory);
}
