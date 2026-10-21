import { assertNoPendingManagerRevokeForDefinition } from "./manager-revoke-recovery.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const fixture = vi.hoisted(() => ({ root: "", failEncrypt: false }));
vi.mock("../../../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => fixture.root }));
vi.mock("../../../../secrets/local-encrypted-provider.js", () => ({ localEncryptedProvider: {
  createVersion: async ({ value }: { value: string }) => { if (fixture.failEncrypt) throw new Error("fixture encryption failed"); return { material: { fixture: Buffer.from(value).toString("base64") } }; },
  resolveVersion: async ({ material }: { material: { fixture: string } }) => Buffer.from(material.fixture, "base64").toString(),
} }));
import { managerRevokeRecovery, managerRevokeRecoveryPath, managerRevokeHash, assertNoPendingManagerRevokeForActor, assertNoPendingManagerRevokeForGrant, assertNoPendingManagerRevokeForSecret, withManagerRevokeCleanup, assertManagerRevokeSecretRemovalAllowed, type ManagerRevokeIntent } from "./manager-revoke-recovery.js";
const company = "00000000-0000-4000-8000-000000000001", grant = "00000000-0000-4000-8000-000000000002", access = "00000000-0000-4000-8000-000000000003", refresh = "00000000-0000-4000-8000-000000000004";
const predecessor = (id: string, operation: string) => ({ identity: { secretId: id, versionId: id, version: 1, authority: { parent: {}, version: {}, definition: null, providerConfig: null } }, valueHash: managerRevokeHash("fixture"), tokenOperationId: operation });
const intent: ManagerRevokeIntent = { schema: 1, kind: "manager-revoke-intent", operationId: "00000000-0000-4000-8000-000000000005", companyId: company, grantId: grant,
  actorUserId: "fixture-user", actorSessionId: "fixture-session", originalRevision: 1, deniedRevision: 2,
  originalGrant: { id: grant, companyId: company, userId: "fixture-user", revision: 1, managerAppId: "A123", accessSecretId: access, refreshSecretId: refresh },
  clientMode: "claim", clientAuthority: { schema: 1, kind: "hosted-sealed", baseUrl: "https://fixture.invalid", instanceId: "fixture", environment: "test", signingKeySha256: "a".repeat(64), sealingKeySha256: "b".repeat(64) },
  access: predecessor(access, "00000000-0000-4000-8000-000000000006"), refresh: predecessor(refresh, "00000000-0000-4000-8000-000000000007"),
};
const raw = { status: 204, headers: { "x-fixture": "retained" }, bodyBase64: "" };
const reopen = () => managerRevokeRecovery(company, grant);
const file = () => managerRevokeRecoveryPath(company, grant);
async function completed(original = intent) {
  await reopen().begin(original);
  let entry;
  for (const role of ["access", "refresh"] as const) if (original[role]) {
    const response = original.clientMode === "code" ? { ...raw, status: 200, bodyBase64: Buffer.from('{"ok":true}').toString("base64") } : raw;
    await reopen().recordRaw({ role, intent: original, raw: response });
    entry = await reopen().recordClientCompletion({ role, intent: original, raw: response });
  }
  return entry!;
}
beforeEach(async () => { fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-revoke-")); fixture.failEncrypt = false; });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.root, { recursive: true, force: true }); });
describe("manager per-token revoke evidence", () => {
  it("retains separate original roles and refuses restart or rewritten intents", async () => {
    const entry = await reopen().begin(intent);
    expect(await reopen().read()).toEqual(entry);
    await expect(reopen().begin(intent)).rejects.toThrow();
    await expect(reopen().begin({ ...intent, operationId: grant })).rejects.toThrow();
    await expect(assertNoPendingManagerRevokeForActor(company, intent.actorUserId)).rejects.toThrow();
    await expect(assertNoPendingManagerRevokeForGrant(company, grant)).rejects.toThrow();
    await expect(assertNoPendingManagerRevokeForSecret(company, access)).rejects.toThrow();
    await expect(assertNoPendingManagerRevokeForSecret(company, refresh)).rejects.toThrow();
  });
  it("preserves successful access independently of failed refresh and refuses clear or cleanup", async () => {
    await reopen().begin(intent);
    await reopen().recordRaw({ role: "access", intent, raw });
    await reopen().recordClientCompletion({ role: "access", intent, raw });
    const failed = { ...raw, status: 500, bodyBase64: Buffer.from("unknown").toString("base64") };
    const entry = await reopen().recordRaw({ role: "refresh", intent, raw: failed });
    expect(entry.outcomes.access).toMatchObject({ kind: "client-completed", acceptance: "hosted-broker-accepted" });
    expect(entry.outcomes.refresh).toEqual({ kind: "raw", raw: failed });
    await expect(reopen().recordClientCompletion({ role: "refresh", intent, raw: failed })).rejects.toThrow();
    await expect(reopen().recordRaw({ role: "refresh", intent, raw })).rejects.toThrow();
    await expect(reopen().clear(entry)).rejects.toThrow();
    const action = vi.fn(async () => {});
    await expect(withManagerRevokeCleanup(entry, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    expect(await reopen().read()).toEqual(entry);
  });
  it("requires retained exact raw before client completion and prevents success overwrite", async () => {
    await reopen().begin(intent);
    await expect(reopen().recordClientCompletion({ role: "access", intent, raw })).rejects.toThrow();
    await reopen().recordRaw({ role: "access", intent, raw });
    await expect(reopen().recordClientCompletion({ role: "access", intent, raw: { ...raw, status: 200 } })).rejects.toThrow();
    const entry = await reopen().recordClientCompletion({ role: "access", intent, raw });
    await expect(reopen().recordRaw({ role: "access", intent, raw })).rejects.toThrow();
    expect(await reopen().read()).toEqual(entry);
  });
  it("requires distinct original secret and per-token operation identities", async () => {
    await expect(reopen().begin({ ...intent, refresh: intent.access })).rejects.toThrow();
    await expect(reopen().begin({ ...intent, refresh: { ...intent.refresh!, tokenOperationId: intent.access!.tokenOperationId } })).rejects.toThrow();
    await expect(reopen().begin({ ...intent, deniedRevision: 9 })).rejects.toThrow();
    expect(await reopen().read()).toBeNull();
  });
  it("permits a single original nonnull role without inventing another", async () => {
    const original = { ...intent, refresh: null, originalGrant: { ...intent.originalGrant, refreshSecretId: null } };
    const entry = await completed(original);
    expect(entry.outcomes.refresh).toBeNull();
    await reopen().clear(entry);
    expect(await reopen().read()).toBeNull();
  });
  it("records development API-ok separately and refuses hosted 204 as development completion", async () => {
    const original = { ...intent, clientMode: "code" as const, clientAuthority: { schema: 1 as const, kind: "development-direct-oauth" as const, apiBaseUrl: "https://slack.com/api/" as const, appId: "A123", clientId: "123.456", clientSecretSha256: "c".repeat(64), callbackUri: "https://fixture.invalid/callback" } };
    await reopen().begin(original);
    await reopen().recordRaw({ role: "access", intent: original, raw });
    await expect(reopen().recordClientCompletion({ role: "access", intent: original, raw })).rejects.toThrow();
    // Preserve that failed role; the other independent role can complete.
    const response = { ...raw, status: 200, bodyBase64: Buffer.from('{"ok":true}').toString("base64") };
    await reopen().recordRaw({ role: "refresh", intent: original, raw: response });
    const entry = await reopen().recordClientCompletion({ role: "refresh", intent: original, raw: response });
    expect(entry.outcomes.refresh).toMatchObject({ acceptance: "development-api-ok" });
  });
  it("refuses a known development manager app different from original grant", async () => {
    const original = { ...intent, clientMode: "code" as const, clientAuthority: { schema: 1 as const, kind: "development-direct-oauth" as const,
      apiBaseUrl: "https://slack.com/api/" as const, appId: "AOTHER", clientId: "123.456", clientSecretSha256: "c".repeat(64), callbackUri: "https://fixture.invalid/callback" } };
    await expect(reopen().begin(original)).rejects.toThrow();
    expect(await reopen().read()).toBeNull();
  });

  it("retains raw when completion persistence fails", async () => {
    await reopen().begin(intent); const entry = await reopen().recordRaw({ role: "access", intent, raw });
    fixture.failEncrypt = true;
    await expect(reopen().recordClientCompletion({ role: "access", intent, raw })).rejects.toThrow("encryption failed");
    expect(await reopen().read()).toEqual(entry);
  });
  it("permits exact original removal only inside matching complete cleanup scope", async () => {
    const entry = await completed();
    await expect(assertManagerRevokeSecretRemovalAllowed(company, access)).rejects.toThrow();
    await withManagerRevokeCleanup(entry, async () => {
      await assertManagerRevokeSecretRemovalAllowed(company, access);
      await assertManagerRevokeSecretRemovalAllowed(company, refresh);
      await expect(assertNoPendingManagerRevokeForSecret(company, access)).rejects.toThrow();
    });
    await expect(assertManagerRevokeSecretRemovalAllowed(company, access)).rejects.toThrow();
    await expect(reopen().clear({ ...entry, intent: { ...entry.intent, actorSessionId: "different" } })).rejects.toThrow();
    await reopen().clear(entry);
    expect(await reopen().read()).toBeNull();
  });
  it.each(["return", "throw"] as const)("revokes detached cleanup permission after callback %s", async mode => {
    const entry = await completed(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); let detached!: Promise<unknown>;
    await withManagerRevokeCleanup(entry, async () => {
      detached = gate.then(() => assertManagerRevokeSecretRemovalAllowed(company, access)).catch(error => error);
      if (mode === "throw") throw new Error("fixture callback failed");
    }).catch(() => {});
    release(); expect(await detached).toBeInstanceOf(Error);
  });
  it.each(["symlink", "hardlink", "directory"] as const)("refuses static %s journal alias", async alias => {
    await reopen().begin(intent); const outside = path.join(fixture.root, "outside"); await fs.rename(file(), outside);
    if (alias === "symlink") await fs.symlink(outside, file()); else if (alias === "hardlink") await fs.link(outside, file()); else await fs.mkdir(file());
    await expect(reopen().read()).rejects.toThrow();
  });
  it("refuses temporary uncertainty even for unrelated actor scans", async () => {
    await reopen().begin(intent); await fs.writeFile(`${file()}.uncertain.tmp`, "fixture");
    await expect(assertNoPendingManagerRevokeForActor(company, "other")).rejects.toThrow();
  });
  it("refuses observed enumeration disappearance", async () => {
    await reopen().begin(intent); const realRead = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementationOnce(async (...args: Parameters<typeof fs.readdir>) => { await fs.rm(path.dirname(file()), { recursive: true }); return realRead(...args); });
    await expect(reopen().read()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains causal write-sync and close failures with temporary uncertainty", async () => {
    const realOpen = fs.open.bind(fs); const first = new Error("fixture sync"), second = new Error("fixture close");
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const close = handle.close.bind(handle); handle.sync = async () => { throw first; };
        handle.close = async () => { await close(); throw second; };
      }
      return handle;
    });
    expect((await reopen().begin(intent).catch(error => error)).errors).toEqual([first, second]);
    await expect(reopen().read()).rejects.toThrow();
  });
  it("refuses directory replacement during absent-file flush", async () => {
    await reopen().begin(intent); await fs.rm(file()); const realOpen = fs.open.bind(fs); let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === path.dirname(file()) && !replaced) {
        const sync = handle.sync.bind(handle); handle.sync = async () => {
          await sync(); replaced = true; await fs.rename(path.dirname(file()), path.join(fixture.root, "old-directory")); await fs.mkdir(path.dirname(file()));
        };
      }
      return handle;
    });
    await expect(reopen().read()).rejects.toThrow(); expect(replaced).toBe(true);
  });

  it("gates reuse after unlink succeeds but directory flush fails", async () => {
    const entry = await completed(); const realOpen = fs.open.bind(fs); let fail = true;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === path.dirname(file()) && fail) handle.sync = async () => { throw new Error("fixture directory sync failed"); };
      return handle;
    });
    await expect(reopen().clear(entry)).rejects.toThrow("directory sync failed");
    await expect(reopen().begin(intent)).rejects.toThrow("directory sync failed");
    fail = false; await reopen().begin(intent);
    expect((await reopen().read())?.intent).toEqual(intent);
  });
  it.each(["file", "directory"] as const)("retains active original definition occupancy after journal %s disappears", async missing => {
    const definition = "00000000-0000-4000-8000-000000000099", unrelated = "00000000-0000-4000-8000-000000000098", selected = structuredClone(intent);
    selected.access!.identity.authority.definition = { id: definition, key: "original" };
    const saved = await completed(selected);
    await withManagerRevokeCleanup(saved, async () => {
      await expect(assertNoPendingManagerRevokeForDefinition(company, definition)).rejects.toThrow();
      await assertNoPendingManagerRevokeForDefinition(company, unrelated);
      if (missing === "directory") await fs.rm(path.dirname(file()), { recursive: true }); else await fs.rm(file());
      await expect(assertNoPendingManagerRevokeForDefinition(company, definition)).rejects.toThrow();
      await assertNoPendingManagerRevokeForDefinition(company, unrelated);
    });
    // Scope expiry grants no permanent deny when retained original occupancy is absent.
    await assertNoPendingManagerRevokeForDefinition(company, definition);
  });

});
