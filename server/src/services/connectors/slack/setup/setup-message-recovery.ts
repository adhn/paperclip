import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { secretRecoveryIdentitySchema } from "../../../secret-recovery-identity-schema.js";
import { resolvePaperclipInstanceRoot } from "../../../../home-paths.js";
import { localEncryptedProvider } from "../../../../secrets/local-encrypted-provider.js";
import { ensureDurableDirectory, syncDirectory } from "../../../../lib/durable-directory.js";
const uuid = z.string().uuid(), messageKindSchema = z.enum(["welcome", "verification"]);
const intentSchema = z.object({ schema: z.literal(1), kind: z.literal("setup-message-intent"), operationId: uuid, companyId: uuid, endpointId: uuid,
  messageKind: messageKindSchema, actorUserId: z.string().min(1), actorSessionId: z.string().nullable(),
  originalEndpoint: z.record(z.string(), z.unknown()), originalConnection: z.record(z.string(), z.unknown()), originalRegistration: z.record(z.string(), z.unknown()), originalAccount: z.record(z.string(), z.unknown()),
  runtimeTokenIdentity: secretRecoveryIdentitySchema, tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  params: z.object({ channel: z.string().min(1), text: z.string().min(1), unfurl_links: z.literal("false"), unfurl_media: z.literal("false") }).strict(),
  directApiAuthority: z.object({ apiBaseUrl: z.literal("https://slack.com/api/"), method: z.literal("chat.postMessage") }).strict(),
}).strict().superRefine((intent, context) => {
  const refs = Array.isArray(intent.originalConnection.credentialSecretRefs)
    ? intent.originalConnection.credentialSecretRefs.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)) : [];
  const selected = refs.filter(ref => ref.configPath === "credentials.botToken");
  if (selected.length !== 1 || selected[0].secretId !== intent.runtimeTokenIdentity.secretId ||
      (selected[0].versionSelector === undefined ? "latest" : selected[0].versionSelector) !== "latest" || intent.runtimeTokenIdentity.authority.parent.companyId !== intent.companyId)
    context.addIssue({ code: "custom", message: "Exact current runtime bot credential reference required" });
  if (intent.originalEndpoint.id !== intent.endpointId || intent.originalEndpoint.companyId !== intent.companyId ||
      !uuid.safeParse(intent.originalConnection.id).success || intent.originalEndpoint.connectionId !== intent.originalConnection.id || intent.originalConnection.companyId !== intent.companyId ||
      intent.originalRegistration.endpointId !== intent.endpointId || intent.originalRegistration.companyId !== intent.companyId ||
      intent.params.channel !== (intent.originalAccount.dmChannelId ?? intent.originalAccount.externalUserId) ||
      intent.originalAccount.paperclipUserId !== intent.actorUserId || intent.originalAccount.status !== "linked" ||
      (intent.originalAccount[intent.messageKind === "welcome" ? "welcomeStatus" : "verificationStatus"] ?? "pending") !== "pending" ||
      exact((intent.originalEndpoint.setup as Record<string, unknown> | undefined)?.slackAccount) !== exact(intent.originalAccount)) context.addIssue({ code: "custom", message: "Exact original setup message owner and destination required" });
});
const rawSchema = z.object({ status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string()), bodyBase64: z.string().max(1_400_000) }).strict();
const decodedSchema = z.object({ channel: z.string().regex(/^D[A-Z0-9]+$/), ts: z.string().regex(/^\d+\.\d+$/) }).strict();
const rawEntrySchema = z.object({ schema: z.literal(1), kind: z.literal("setup-message-raw"), intent: intentSchema, raw: rawSchema }).strict();
const resultFields = { schema: z.literal(1), intent: intentSchema, raw: rawSchema, decoded: decodedSchema };
function validResult(value: { intent: SetupMessageIntent; raw: SetupMessageRawResponse; decoded: z.infer<typeof decodedSchema> }) {
  if (value.raw.status < 200 || value.raw.status >= 300) return false;
  try {
    const body = JSON.parse(Buffer.from(value.raw.bodyBase64, "base64").toString("utf8"));
    return body?.ok === true && body.channel === value.decoded.channel && body.ts === value.decoded.ts &&
      (value.intent.originalAccount.dmChannelId == null || value.intent.originalAccount.dmChannelId === value.decoded.channel);
  } catch { return false; }
}
const resultSchema = z.object({ ...resultFields, kind: z.literal("setup-message-result") }).strict().refine(validResult, "Exact successful message raw response required");
const settledSchema = z.object({ ...resultFields, kind: z.literal("setup-message-settled") }).strict().refine(validResult, "Exact successful message raw response required");
const entrySchema = z.union([intentSchema, rawEntrySchema, resultSchema, settledSchema]);
export type SetupMessageKind = z.infer<typeof messageKindSchema>;
export type SetupMessageIntent = z.infer<typeof intentSchema>;
export type SetupMessageRawResponse = z.infer<typeof rawSchema>;
export type SetupMessageResult = z.infer<typeof resultSchema>;
export type SetupMessageEntry = z.infer<typeof entrySchema>;
export const setupMessageHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const setupMessageRecoveryRootPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-setup-message-recovery");
export const setupMessageRecoveryPath = (companyId: string, endpointId: string, kind: SetupMessageKind) => path.join(setupMessageRecoveryRootPath(), uuid.parse(companyId), `${uuid.parse(endpointId)}-${messageKindSchema.parse(kind)}.json`);
export const setupMessagePending = () => Object.assign(new Error("Slack setup message requires exact recovery inspection"), { code: "slack_setup_message_recovery_pending" });
const original = (entry: SetupMessageEntry) => entry.kind === "setup-message-intent" ? entry : entry.intent;
const exact = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
type DirectorySnapshot = { names: string[]; dev: number; ino: number };
async function directoryIdentity(directory: string) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw setupMessagePending();
  return { dev: info.dev, ino: info.ino };
}
async function flushObserved(directory: string, observed: DirectorySnapshot) {
  await syncDirectory(directory);
  const current = await directoryIdentity(directory);
  if (current.dev !== observed.dev || current.ino !== observed.ino) throw setupMessagePending();
}
async function files(directory: string): Promise<DirectorySnapshot | null> {
  let identity;
  try { identity = await directoryIdentity(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const names = await fs.readdir(directory);
  if (names.some(name => !/^[0-9a-f-]{36}-(welcome|verification)\.json$/i.test(name) || !uuid.safeParse(name.slice(0, 36)).success)) throw setupMessagePending();
  const current = await directoryIdentity(directory);
  if (identity.dev !== current.dev || identity.ino !== current.ino) throw setupMessagePending();
  return { names, ...identity };
}
async function fileEntry(file: string): Promise<SetupMessageEntry | null> {
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw setupMessagePending(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return entrySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material: JSON.parse(await fs.readFile(file, "utf8")), externalRef: null })));
}
async function inventory(companyId: string): Promise<SetupMessageEntry[]> {
  uuid.parse(companyId);
  const directory = path.join(setupMessageRecoveryRootPath(), companyId);
  const names = await files(directory);
  if (names === null) return [];
  const entries: SetupMessageEntry[] = [];
  for (const name of names.names) {
    const entry = await fileEntry(path.join(directory, name));
    if (!entry || original(entry).companyId !== companyId || `${original(entry).endpointId}-${original(entry).messageKind}.json` !== name) throw setupMessagePending();
    entries.push(entry);
  }
  await flushObserved(directory, names);
  return entries;
}
export function setupMessageRecovery(companyId: string, endpointId: string, messageKind: SetupMessageKind) {
  const file = setupMessageRecoveryPath(companyId, endpointId, messageKind), directory = path.dirname(file);
  async function read() {
    const names = await files(directory);
    const entry = await fileEntry(file);
    if (!entry && names?.names.includes(path.basename(file))) throw setupMessagePending();
    if (!entry && names !== null) await flushObserved(directory, names);
    if (entry && names === null) throw setupMessagePending();
    if (entry && names !== null) {
      const current = await directoryIdentity(directory);
      if (current.dev !== names.dev || current.ino !== names.ino) throw setupMessagePending();
    }
    if (entry && (original(entry).companyId !== companyId || original(entry).endpointId !== endpointId || original(entry).messageKind !== messageKind)) throw setupMessagePending();
    return entry;
  }
  async function publish(input: SetupMessageEntry) {
    const entry = entrySchema.parse(input);
    const encrypted = await localEncryptedProvider.createVersion({ value: JSON.stringify(entry) });
    await ensureDurableDirectory(directory);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let failed = false, failure: unknown;
    try { await handle.writeFile(JSON.stringify(encrypted.material)); await handle.sync(); }
    catch (error) { failed = true; failure = error; }
    try { await handle.close(); } catch (error) { failure = failed ? new AggregateError([failure, error], "Setup message write and close failed") : error; failed = true; }
    if (failed) throw failure; // Keep preparation occupancy; never infer non-effect.
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  }
  return {
    read,
    begin: async (input: SetupMessageIntent) => {
      const intent = intentSchema.parse(input);
      if (intent.companyId !== companyId || intent.endpointId !== endpointId || intent.messageKind !== messageKind || await read()) throw setupMessagePending();
      await publish(intent);
    },
    recordRaw: async (input: { intent: SetupMessageIntent; raw: SetupMessageRawResponse }) => {
      const entry = rawEntrySchema.parse({ schema: 1, kind: "setup-message-raw", ...input }), retained = await read();
      if (!retained || exact(original(retained)) !== exact(entry.intent) || retained.kind !== "setup-message-intent" && exact(retained) !== exact(entry)) throw setupMessagePending();
      await publish(entry); return entry;
    },
    recordResult: async (input: { intent: SetupMessageIntent; raw: SetupMessageRawResponse; decoded: z.infer<typeof decodedSchema> }): Promise<SetupMessageResult> => {
      const result = resultSchema.parse({ schema: 1, kind: "setup-message-result", ...input }), retained = await read();
      if (!retained || retained.kind === "setup-message-intent" || exact(original(retained)) !== exact(result.intent) || exact(retained.raw) !== exact(result.raw) ||
          retained.kind !== "setup-message-raw" && exact(retained) !== exact(result)) throw setupMessagePending();
      await publish(result); return result;
    },
    recordSettlementReturned: async (input: SetupMessageResult) => {
      const result = resultSchema.parse(input), retained = await read();
      const settled = settledSchema.parse({ ...result, kind: "setup-message-settled" });
      if (!retained || exact(retained) !== exact(result) && exact(retained) !== exact(settled)) throw setupMessagePending();
      if (retained.kind !== "setup-message-settled") await publish(settled);
      return settled;
    },
  };
}
export async function assertNoPendingSetupMessageForActor(companyId: string, userId: string) {
  if ((await inventory(companyId)).some(entry => entry.kind !== "setup-message-settled" && original(entry).actorUserId === userId)) throw setupMessagePending();
}
export async function assertNoPendingSetupMessageForEndpoint(companyId: string, endpointId: string) {
  uuid.parse(endpointId); if ((await inventory(companyId)).some(entry => entry.kind !== "setup-message-settled" && original(entry).endpointId === endpointId)) throw setupMessagePending();
}
export async function assertNoPendingSetupMessageForSecret(companyId: string, secretId: string) {
  uuid.parse(secretId); if ((await inventory(companyId)).some(entry => entry.kind !== "setup-message-settled" && original(entry).runtimeTokenIdentity.secretId === secretId)) throw setupMessagePending();
}
/** Strict local message occupancy only; settled is no physical cleanup proof. */
export async function inspectPending(): Promise<"none" | "present" | "unknown"> {
  const root = setupMessageRecoveryRootPath();
  try {
    let info;
    try { info = await fs.lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none"; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) return "unknown";
    const companies = await fs.readdir(root);
    let pending = false;
    for (const companyId of companies) {
      if (!uuid.safeParse(companyId).success) return "unknown";
      const directory = path.join(root, companyId), observed = await directoryIdentity(directory);
      const entries = await inventory(companyId);
      const after = await directoryIdentity(directory);
      if (after.dev !== observed.dev || after.ino !== observed.ino) return "unknown";
      if (entries.some(entry => entry.kind !== "setup-message-settled")) pending = true;
    }
    await syncDirectory(root);
    const current = await fs.lstat(root);
    if (current.dev !== info.dev || current.ino !== info.ino || !current.isDirectory() || current.isSymbolicLink()) return "unknown";
    return pending ? "present" : "none";
  } catch { return "unknown"; }
}

/** Retained original authority remains occupied even after mutable SQL references change. */
export async function assertNoPendingSetupMessageForDefinition(companyId: string, definitionId: string) {
  uuid.parse(definitionId);
  if ((await inventory(companyId)).some(entry => entry.kind !== "setup-message-settled" && original(entry).runtimeTokenIdentity.authority.definition?.id === definitionId)) throw setupMessagePending();
}
