import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, aiProviderDefaults, companies, companyMemberships, companySecrets, connectionGrants, connectionGrantMembers, createDb, toolConnections, toolConnectionInstalls } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as codexAdapter from "@paperclipai/adapter-codex-local/server";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { quotaCredentialRecovery, quotaCredentialHash, quotaCredentialRecoveryPath, type QuotaExchangeIntent } from "../services/quota-credential-recovery.js";
import { readQuotaOwnerIdentity } from "../services/quota-owner-identity.js";
import { readSecretRecoveryIdentity } from "../services/secret-recovery-identity.js";
import type { AiCredentialUseContext } from "../services/ai-credential-use-context.js";
vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("current AI credential use authorization", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined, root: string;
  const previousHome = process.env.PAPERCLIP_HOME, previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-current-use-")); process.env.PAPERCLIP_HOME = root; process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key");
    if (externalUrl) db = createDb(externalUrl); else { database = await startEmbeddedPostgresTestDatabase("ai-current-use-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(kind: "key" | "shared" | "quota" | "none" = "key") {
    const companyId = randomUUID(), agentId = randomUUID(), owner = `owner-${randomUUID()}`, viewer = `viewer-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Current AI use", issuePrefix: `U${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Current user", adapterType: "claude_local" });
    await db.insert(companyMemberships).values([owner, viewer].map(principalId => ({ companyId, principalId, principalType: "user" as const, status: "active", membershipRole: "member" })));
    const service = aiConnectionService(db), original = kind === "quota" ? JSON.stringify({ tokens: { account_id: owner, access_token: "original-access", refresh_token: "single-use" } }) : "original-key";
    const saved = await service.save(companyId, owner, kind === "quota"
      ? { provider: "openai", method: "subscription", ownership: "personal", name: "Quota", loginSessionId: "fixture", agentIds: [], allAgents: true }
      : kind === "none" ? { provider: "anthropic", method: "api_key", ownership: "personal", name: "No auth", agentIds: [], allAgents: true, routing: { kind: "local", protocol: "messages", baseUrl: "http://127.0.0.1:9000/v1", auth: "none", models: [] } }
      : { provider: "anthropic", method: "api_key", ownership: kind === "shared" ? "shared" : "personal", name: "Key", apiKey: "fixture", agentIds: [], allAgents: true }, kind === "none" ? "" : original);
    const [row] = await db.select({ connection: toolConnections, grant: connectionGrants }).from(toolConnections).innerJoin(connectionGrants, eq(connectionGrants.connectionId, toolConnections.id)).where(eq(toolConnections.id, saved.connectionId));
    const selection = { companyId, userId: owner, agentId, adapterType: kind === "quota" ? "codex_local" : "claude_local", binding: { provider: kind === "quota" ? "openai" : "anthropic", method: kind === "quota" ? "subscription" : "api_key", mode: kind === "shared" ? "shared" : "delegated", connectionId: saved.connectionId, grantId: saved.grantId } } as const;
    const agentContext: AiCredentialUseContext = { kind: "agent", selection };
    const revokeMember = (userId: string) => db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
    return { companyId, agentId, owner, viewer, service, saved, row, original, selection, agentContext, revokeMember };
  }
  it("requires explicit caller context instead of trusting the row owner", async () => {
    const f = await fixture();
    await expect(f.service.runtimeCredential(f.row, undefined as unknown as AiCredentialUseContext)).rejects.toMatchObject({ status: 403 });
    expect(await f.service.runtimeCredential(f.row, { kind: "user", userId: f.owner })).toBe(f.original);
  });
  it("refuses membership removed after selection", async () => {
    const f = await fixture(); await f.revokeMember(f.owner);
    await expect(f.service.runtimeCredential(f.row, f.agentContext)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.runtimeCredential(f.row, { kind: "user", userId: f.owner })).rejects.toMatchObject({ status: 403 });
  });
  it("refuses current shared audience removal even while requester remains a member", async () => {
    const f = await fixture("shared");
    expect(await f.service.runtimeCredential(f.row, { kind: "user", userId: f.viewer })).toBe(f.original);
    await db.insert(connectionGrantMembers).values({ companyId: f.companyId, grantId: f.saved.grantId, subjectType: "user", subjectId: f.owner });
    await expect(f.service.runtimeCredential(f.row, { kind: "user", userId: f.viewer })).rejects.toMatchObject({ status: 403 });
  });
  it("refuses agent installation removal after original selection", async () => {
    const f = await fixture(); await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.saved.connectionId));
    await expect(f.service.runtimeCredential(f.row, f.agentContext)).rejects.toMatchObject({ status: 403 });
  });
  it("refuses changed responsible-user default rather than retargeting credential release", async () => {
    const f = await fixture();
    const context: AiCredentialUseContext = { kind: "agent", selection: { ...f.selection, binding: { provider: "anthropic", method: "api_key", mode: "responsible_user" } } };
    const other = await f.service.save(f.companyId, f.owner, { provider: "anthropic", method: "api_key", ownership: "personal", name: "New default", apiKey: "fixture", agentIds: [], allAgents: true }, "new-default-key");
    await db.update(aiProviderDefaults).set({ grantId: other.grantId }).where(and(eq(aiProviderDefaults.companyId, f.companyId), eq(aiProviderDefaults.userId, f.owner)));
    await expect(f.service.runtimeCredential(f.row, context)).rejects.toMatchObject({ status: 403 });
  });
  it("routes no-auth preparation through current authorization before creating a provider home", async () => {
    const f = await fixture("none"), external = new AsyncResource("independent-noauth-prepare");
    const lock = codexAdapter.withAccountHomeSecretMutationLock;
    let preparing!: ReturnType<typeof prepareManagedAiRuntime>;
    let result: Awaited<ReturnType<typeof prepareManagedAiRuntime>> | undefined;
    const provider = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider must not be used"));
    try {
      await lock(undefined, f.companyId, async () => {
        const entered = vi.spyOn(codexAdapter, "withAccountHomeSecretMutationLock");
        preparing = external.runInAsyncScope(() => prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: f.agentId, responsibleUserId: f.owner, adapterType: "claude_local", binding: f.selection.binding, config: {} }));
        void preparing.catch(() => undefined);
        await vi.waitFor(() => expect(entered).toHaveBeenCalled(), { timeout: 2000 });
        await f.revokeMember(f.owner);
      });
      await expect(preparing).rejects.toMatchObject({ status: 403 });
      expect((await fs.readdir(os.tmpdir())).filter(name => name.startsWith(`paperclip-ai-${f.companyId}-${f.saved.grantId}-`))).toEqual([]);
      expect(provider).not.toHaveBeenCalled();
    } finally { result = await preparing?.catch(() => undefined); if (result) await result.cleanup(); external.emitDestroy(); }
  });
  it("rechecks permission after durable fresh OAuth intent and refuses provider dispatch", async () => {
    const f = await fixture("quota"), rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { await rename(from, to); if (String(to) === quotaCredentialRecoveryPath(f.companyId, f.saved.grantId)) await f.revokeMember(f.owner); });
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider must not be used"));
    await expect(f.service.refreshQuotaCredential(f.row, f.original, new AbortController().signal, { kind: "user", userId: f.owner })).rejects.toMatchObject({ status: 403 });
    expect(request).not.toHaveBeenCalled();
    expect(await quotaCredentialRecovery(f.companyId, f.saved.grantId).read()).toMatchObject({ kind: "exchange-intent" });
  });
  it("commits exact historical result preservation before denying current caller release", async () => {
    const f = await fixture("quota"), ref = f.row.grant.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
    const journal = quotaCredentialRecovery(f.companyId, f.saved.grantId);
    const intent: QuotaExchangeIntent = { schema: 1, kind: "exchange-intent", operationId: randomUUID(), companyId: f.companyId, grantId: f.saved.grantId, connectionId: f.saved.connectionId, secretId: ref.secretId, baseHash: quotaCredentialHash(f.original), originalSecretIdentity: await readSecretRecoveryIdentity(db, f.companyId, ref.secretId), originalOwnerIdentity: await readQuotaOwnerIdentity(db, f.companyId, f.saved.grantId) };
    await journal.beginExchange(intent); await journal.completeExchange({ ...intent, kind: "exchange-result", intent, value: "exact-historical-replacement" });
    await f.revokeMember(f.owner);
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no historical reexchange"));
    await expect(f.service.runtimeCredential(f.row, { kind: "user", userId: f.owner })).rejects.toMatchObject({ status: 403 });
    expect(await f.service.credential(f.row)).toBe("exact-historical-replacement");
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId)); expect(secret.latestVersion).toBe(2);
    expect(await journal.read()).toBeNull(); expect(request).not.toHaveBeenCalled();
  });
});
