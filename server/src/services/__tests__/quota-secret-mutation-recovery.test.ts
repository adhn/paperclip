import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, companySecrets, companySecretVersions, connectionGrants, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { aiConnectionService } from "../ai-connections.js";
import { secretService } from "../secrets.js";
import { readSecretRecoveryIdentity } from "../secret-recovery-identity.js";
import { readQuotaOwnerIdentity } from "../quota-owner-identity.js";
import { quotaCredentialHash, quotaCredentialRecovery, quotaCredentialRecoveryPath, assertNoPendingQuotaCredentialForDefinition, withQuotaCredentialSettlement, type QuotaExchangeIntent } from "../quota-credential-recovery.js";
const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("quota original secret mutation authority", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined, root: string;
  const oldHome = process.env.PAPERCLIP_HOME, oldKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "quota-secret-mutation-")); process.env.PAPERCLIP_HOME = root; process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(root, "master.key");
    if (externalUrl) db = createDb(externalUrl); else { database = await startEmbeddedPostgresTestDatabase("quota-secret-mutation-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => {
    await database?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (oldKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = oldKey;
    await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(typed = true, complete = true) {
    const companyId = randomUUID(), owner = `quota-${randomUUID()}`, current = "original-single-use-token", value = "independently-returned-replacement";
    await db.insert(companies).values({ id: companyId, name: "Quota mutation", issuePrefix: `Q${companyId.slice(0, 7)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", membershipRole: "member", status: "active" });
    const service = aiConnectionService(db);
    const saved = await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: "Quota", loginSessionId: "fixture", agentIds: [], allAgents: true }, current);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.grantId));
    const secretId = grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")!.secretId;
    const predecessor = await readSecretRecoveryIdentity(db, companyId, secretId), recovery = quotaCredentialRecovery(companyId, saved.grantId);
    const identity = { companyId, grantId: saved.grantId, connectionId: saved.connectionId, secretId, baseHash: quotaCredentialHash(current) };
    if (typed) {
      const intent: QuotaExchangeIntent = { ...identity, schema: 1, kind: "exchange-intent", operationId: randomUUID(), originalSecretIdentity: predecessor, originalOwnerIdentity: await readQuotaOwnerIdentity(db, companyId, saved.grantId) };
      await recovery.beginExchange(intent); if (complete) await recovery.completeExchange({ ...intent, kind: "exchange-result", intent, value });
    } else await recovery.write({ ...identity, value });
    const result = (await recovery.read())!;
    return { companyId, owner, current, value, saved, secretId, predecessor, recovery, result, vault: secretService(db) };
  }
  for (const mutation of ["rotate", "metadata", "user-status"] as const) it(`refuses generic ${mutation} after mutable grant refs are severed`, async () => {
    const f = await fixture(); await db.update(connectionGrants).set({ credentialSecretRefs: [] }).where(eq(connectionGrants.id, f.saved.grantId));
    const action = mutation === "rotate" ? () => f.vault.rotate(f.secretId, { value: f.value, preserveAiSessionEpoch: true })
      : mutation === "metadata" ? () => f.vault.update(f.secretId, { description: "relabel original" })
      : () => f.vault.updateCurrentUserSecretValue(f.companyId, f.owner, f.secretId, { status: "disabled" });
    await expect(action()).rejects.toMatchObject({ details: { code: "secret_credential_recovery_pending" } });
    expect(await readSecretRecoveryIdentity(db, f.companyId, f.secretId)).toEqual(f.predecessor);
    expect(await f.recovery.read()).toEqual(f.result);
  });
  it("unknown original intent never grants mutation or settlement authority", async () => {
    const f = await fixture(true, false); let calls = 0;
    await expect(f.vault.rotate(f.secretId, { value: f.value })).rejects.toThrow();
    await expect(withQuotaCredentialSettlement(f.result, f.predecessor, f.current, async () => { calls += 1; })).rejects.toThrow();
    expect(calls).toBe(0); expect(await readSecretRecoveryIdentity(db, f.companyId, f.secretId)).toEqual(f.predecessor);
  });
  for (const typed of [true, false]) it(`permits only exact ${typed ? "typed original" : "historical actual predecessor"} result settlement`, async () => {
    const f = await fixture(typed);
    await withQuotaCredentialSettlement(f.result, f.predecessor, f.current, () => f.vault.rotate(f.secretId, { value: f.value }));
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, f.secretId)); expect(secret.latestVersion).toBe(2);
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, f.secretId))).toHaveLength(2);
    expect(await f.recovery.read()).toEqual(f.result); // Rotation alone is never a COMMIT receipt or permission to clear.
    await expect(f.vault.rotate(f.secretId, { value: f.value })).rejects.toMatchObject({ details: { code: "secret_credential_recovery_pending" } });
  });
  it("rejects wrong result value, metadata and removal even inside the exact active scope", async () => {
    const f = await fixture();
    await withQuotaCredentialSettlement(f.result, f.predecessor, f.current, async () => {
      await expect(f.vault.rotate(f.secretId, { value: "different" })).rejects.toThrow();
      await expect(f.vault.update(f.secretId, { status: "disabled" })).rejects.toThrow();
      await expect(f.vault.remove(f.secretId)).rejects.toThrow();
    });
    expect(await readSecretRecoveryIdentity(db, f.companyId, f.secretId)).toEqual(f.predecessor);
  });
  it("refuses wrong original predecessor and wrong current-value hash before running the action", async () => {
    const f = await fixture(); let calls = 0;
    const action = async () => { calls += 1; };
    await expect(withQuotaCredentialSettlement(f.result, { ...f.predecessor, versionId: randomUUID() }, f.current, action)).rejects.toThrow();
    await expect(withQuotaCredentialSettlement(f.result, f.predecessor, "wrong-current", action)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("retains active original definition authority after its journal disappears", async () => {
    const f = await fixture();
    const definitionId = f.predecessor.authority.definition?.id;
    expect(typeof definitionId).toBe("string");
    await withQuotaCredentialSettlement(f.result, f.predecessor, f.current, async () => {
      await fs.rm(path.dirname(quotaCredentialRecoveryPath(f.companyId, f.saved.grantId)), { recursive: true });
      await expect(assertNoPendingQuotaCredentialForDefinition(f.companyId, definitionId as string)).rejects.toThrow();
      await assertNoPendingQuotaCredentialForDefinition(f.companyId, randomUUID());
    });
  });
  it("expires authority inherited by a detached asynchronous continuation", async () => {
    const f = await fixture(); let release!: () => void, detached!: Promise<unknown>;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await withQuotaCredentialSettlement(f.result, f.predecessor, f.current, async () => {
      detached = gate.then(() => f.vault.rotate(f.secretId, { value: f.value }));
    });
    release(); await expect(detached).rejects.toMatchObject({ details: { code: "secret_credential_recovery_pending" } });
    expect(await readSecretRecoveryIdentity(db, f.companyId, f.secretId)).toEqual(f.predecessor);
  });
  for (const mutation of ["definition-key", "definition-status", "definition-remove"] as const) it(`retains original ${mutation} authority despite severed mutable refs`, async () => {
    const f = await fixture(), definitionId = String(f.predecessor.authority.definition!.id);
    await db.update(connectionGrants).set({ credentialSecretRefs: [] }).where(eq(connectionGrants.id, f.saved.grantId));
    const action = mutation === "definition-remove" ? () => f.vault.removeUserSecretDefinition(f.companyId, definitionId)
      : () => f.vault.updateUserSecretDefinition(f.companyId, definitionId, mutation === "definition-key" ? { key: `changed_${randomUUID()}` } : { status: "disabled" });
    await expect(action()).rejects.toThrow();
    expect(await readSecretRecoveryIdentity(db, f.companyId, f.secretId)).toEqual(f.predecessor);
    expect(await f.recovery.read()).toEqual(f.result);
  });
  it("holds company-wide definition mutation when legacy result lacks original definition authority", async () => {
    const f = await fixture(false);
    const unrelated = await f.vault.createUserSecretDefinition(f.companyId, { key: `unrelated_${randomUUID()}`, name: "Unrelated definition", provider: "local_encrypted" });
    await expect(f.vault.updateUserSecretDefinition(f.companyId, unrelated.id, { name: "Would relabel unknown original" })).rejects.toThrow();
    await expect(f.vault.removeUserSecretDefinition(f.companyId, unrelated.id)).rejects.toThrow();
    expect(await f.recovery.read()).toEqual(f.result);
  });

});
