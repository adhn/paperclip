import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as durable from "../lib/durable-directory.js";

const settings = vi.hoisted(() => ({ root: "" }));
vi.mock("./idle-local-work.js", () => ({ idleQuotaRecoveryPath: () => settings.root }));
// Keep these filesystem lifecycle tests independent of actual master-key custody.
vi.mock("../secrets/local-encrypted-provider.js", () => ({
  localEncryptedProvider: {
    createVersion: async ({ value }: { value: string }) => ({ material: { fixture: value } }),
    resolveVersion: async ({ material }: { material: { fixture: string } }) => material.fixture,
  },
}));
import { assertNoPendingQuotaCredentialForSecret, quotaCredentialRecovery, quotaCredentialRecoveryPath } from "./quota-credential-recovery.js";

const company = "00000000-0000-4000-8000-000000000001";
const grant = "00000000-0000-4000-8000-000000000002";
const secret = "00000000-0000-4000-8000-000000000004";
const originalOwnerIdentity = {
  connection: { id: "00000000-0000-4000-8000-000000000003", companyId: company, provider: "codex", status: "active", authConfig: { mode: "oauth" } },
  grant: { id: grant, companyId: company, connectionId: "00000000-0000-4000-8000-000000000003", status: "active", credentialSecretId: secret, scopes: ["quota:read"] },
};
const originalSecretIdentity = { secretId: secret, versionId: "00000000-0000-4000-8000-000000000006", version: 3,
  authority: { parent: { provider: "local_encrypted", latestVersion: 3 },
    version: { material: { ciphertext: "original-fixture", scheme: "fixture" } }, definition: null, providerConfig: null } };
const typedIntent = () => ({ schema: 1 as const, kind: "exchange-intent" as const, companyId: company, grantId: grant,
  connectionId: "00000000-0000-4000-8000-000000000003", secretId: secret,
  operationId: "00000000-0000-4000-8000-000000000005", baseHash: "0".repeat(64), originalSecretIdentity, originalOwnerIdentity });
async function setup() {
  settings.root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-quota-recovery-"));
  const file = quotaCredentialRecoveryPath(company, grant);
  const directory = path.dirname(file);
  await fs.mkdir(directory);
  return { file, directory, recovery: quotaCredentialRecovery(company, grant) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  if (settings.root) await fs.rm(settings.root, { recursive: true, force: true });
});

describe("durable quota recovery deletion", () => {
  it("flushes deletion and retries the flush when the journal is already absent", async () => {
    const { file, directory, recovery } = await setup();
    await recovery.write({ companyId: company, grantId: grant,
      connectionId: "00000000-0000-4000-8000-000000000003", secretId: "00000000-0000-4000-8000-000000000004",
      baseHash: "0".repeat(64), value: "synthetic-recovery" });
    const original = durable.syncDirectory;
    const error = new Error("injected directory flush failure");
    const sync = vi.spyOn(durable, "syncDirectory").mockRejectedValueOnce(error);
    await expect(recovery.clear()).rejects.toBe(error);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    sync.mockImplementation(original);
    await recovery.clear();
    expect(sync.mock.calls).toEqual([[directory], [directory], [directory]]);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("does not manufacture a directory for a never-created journal", async () => {
    const { directory, recovery } = await setup();
    await fs.rmdir(directory);
    const sync = vi.spyOn(durable, "syncDirectory");
    await recovery.clear();
    expect(sync).not.toHaveBeenCalled();
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("durably removes its probe before preparation succeeds", async () => {
    const { directory, recovery } = await setup();
    const sync = vi.spyOn(durable, "syncDirectory");
    await recovery.prepare();
    // Publishing and deleting the probe each flush the company directory.
    expect(sync.mock.calls.filter(([name]) => name === directory)).toHaveLength(2);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("surfaces probe deletion flush failure after the probe is removed", async () => {
    const { directory, recovery } = await setup();
    const original = durable.syncDirectory;
    const error = new Error("probe deletion flush failed");
    let count = 0;
    vi.spyOn(durable, "syncDirectory").mockImplementation(async (name) => {
      if (name === directory && ++count === 2) throw error;
      return original(name);
    });
    await expect(recovery.prepare()).rejects.toBe(error);
    expect(await fs.readdir(directory)).toEqual([]);
    await recovery.prepare();
    expect(count).toBe(4);
  });

  it("retains the original probe publication error while cleaning up durably", async () => {
    const { directory, recovery } = await setup();
    const error = new Error("probe rename failed");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(error);
    const sync = vi.spyOn(durable, "syncDirectory");
    await expect(recovery.prepare()).rejects.toBe(error);
    expect(await fs.readdir(directory)).toEqual([]);
    // Cleanup flushes both the temporary entry and the possibly-published probe.
    expect(sync.mock.calls.filter(([name]) => name === directory)).toHaveLength(2);
    await recovery.prepare();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("retains file sync failure before close failure and closes once", async () => {
    const { directory, recovery } = await setup();
    const originalOpen = fs.open.bind(fs);
    const syncFailure = new Error("file sync failed");
    const closeFailure = new Error("file close failed");
    const closes = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "sync").mockRejectedValueOnce(syncFailure);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          closes();
          await close();
          throw closeFailure;
        });
      }
      return handle;
    });
    const error = await recovery.prepare().catch((failure) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([syncFailure, closeFailure]);
    expect(closes).toHaveBeenCalledOnce();
    expect(await fs.readdir(directory)).toEqual([]);
    vi.restoreAllMocks();
    await recovery.prepare();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("retains original and cleanup errors in causal order", async () => {
    const { directory, recovery } = await setup();
    const original = new Error("probe rename failed");
    const cleanup = new Error("cleanup flush failed");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(original);
    vi.spyOn(durable, "syncDirectory").mockRejectedValue(cleanup);
    const error = await recovery.prepare().catch((failure) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    // writeEncrypted cleanup is attempted before prepare's own probe cleanup.
    expect(error.errors[0]).toBeInstanceOf(AggregateError);
    expect(error.errors[0].errors).toEqual([original, cleanup]);
    expect(error.errors[1]).toBe(cleanup);
    expect(await fs.readdir(directory)).toEqual([]);
  });
});


describe("quota recovery original secret occupancy", () => {
  const secret = "00000000-0000-4000-8000-000000000004";
  it("retains a journal identity without any SQL grant reference", async () => {
    const { recovery } = await setup();
    await recovery.beginExchange({ schema: 1, kind: "exchange-intent", companyId: company, grantId: grant,
      connectionId: "00000000-0000-4000-8000-000000000003", secretId: secret,
      operationId: "00000000-0000-4000-8000-000000000005", baseHash: "0".repeat(64), originalSecretIdentity, originalOwnerIdentity });
    await expect(assertNoPendingQuotaCredentialForSecret(company, secret)).rejects.toThrow("quota_credential_exchange_pending");
    await expect(assertNoPendingQuotaCredentialForSecret(company, "00000000-0000-4000-8000-000000000006")).resolves.toBeUndefined();
    expect(await recovery.read()).toMatchObject({ secretId: secret, kind: "exchange-intent" });
  });
  it("refuses unknown retained temporary records instead of assuming absence", async () => {
    const { directory } = await setup();
    await fs.writeFile(path.join(directory, "uncertain.tmp"), "fixture");
    await expect(assertNoPendingQuotaCredentialForSecret(company, secret)).rejects.toThrow("inspection_required");
  });
  it("refuses disappearance after observing an existing journal directory", async () => {
    await setup();
    const failure = Object.assign(new Error("injected disappearance"), { code: "ENOENT" });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);
    await expect(assertNoPendingQuotaCredentialForSecret(company, secret)).rejects.toBe(failure);
  });
  it("refuses a symlink company directory", async () => {
    const { directory } = await setup();
    await fs.rmdir(directory);
    const other = path.join(settings.root, "other");
    await fs.mkdir(other);
    await fs.symlink(other, directory);
    await expect(assertNoPendingQuotaCredentialForSecret(company, secret)).rejects.toThrow("inspection_required");
  });
});


describe("typed quota exact original descriptor retention", () => {
  it("accepts semantic descriptor key order through completion and exact clear", async () => {
    const { recovery } = await setup();
    const intent = typedIntent();
    await recovery.beginExchange(intent);
    const reordered = { ...originalSecretIdentity, authority: {
      providerConfig: null, definition: null,
      version: { material: { scheme: "fixture", ciphertext: "original-fixture" } },
      parent: { latestVersion: 3, provider: "local_encrypted" },
    } };
    const reorderedIntent = { ...intent, originalSecretIdentity: reordered };
    const result = { ...reorderedIntent, kind: "exchange-result" as const, intent: reorderedIntent, value: "exact-result" };
    await recovery.completeExchange(result);
    expect(await recovery.read()).toEqual(result);
    await recovery.clear({ ...result, originalSecretIdentity, intent });
    expect(await recovery.read()).toBeNull();
  });
  it.each(["version", "material"])("refuses altered original %s at completion and clearing", async field => {
    const { recovery } = await setup();
    const intent = typedIntent();
    await recovery.beginExchange(intent);
    const changed = structuredClone(originalSecretIdentity);
    if (field === "version") changed.version = 4;
    else changed.authority.version.material.ciphertext = "different-original";
    const staleIntent = { ...intent, originalSecretIdentity: changed };
    const staleResult = { ...staleIntent, kind: "exchange-result" as const, intent: staleIntent, value: "exact-result" };
    await expect(recovery.completeExchange(staleResult)).rejects.toThrow();
    expect(await recovery.read()).toEqual(intent);
    const result = { ...intent, kind: "exchange-result" as const, intent, value: "exact-result" };
    await recovery.completeExchange(result);
    await expect(recovery.clear(staleResult)).rejects.toThrow();
    expect(await recovery.read()).toEqual(result);
  });
  it("retains unrecognized old typed records without backfill or new exchange", async () => {
    const { recovery, file } = await setup();
    const { originalSecretIdentity: _missing, ...oldTyped } = typedIntent();
    const bytes = JSON.stringify({ fixture: JSON.stringify(oldTyped) });
    await fs.writeFile(file, bytes);
    await expect(recovery.read()).rejects.toThrow();
    await expect(recovery.beginExchange(typedIntent())).rejects.toThrow();
    await expect(recovery.clear()).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
  });
});


describe("quota recovery checked absence and storage refusal", () => {
  it("repairs an unacknowledged deletion flush before read or fresh exchange can admit new use", async () => {
    const { file, recovery } = await setup();
    const intent = typedIntent();
    await recovery.beginExchange(intent);
    const result = { ...intent, kind: "exchange-result" as const, intent, value: "exact-result" };
    await recovery.completeExchange(result);
    const failure = new Error("deletion directory flush uncertain");
    const original = durable.syncDirectory;
    const sync = vi.spyOn(durable, "syncDirectory").mockRejectedValue(failure);
    await expect(recovery.clear(result)).rejects.toBe(failure);
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(recovery.read()).rejects.toBe(failure);
    await expect(recovery.beginExchange(typedIntent())).rejects.toBe(failure);
    sync.mockImplementation(original);
    expect(await recovery.read()).toBeNull();
    await recovery.beginExchange(typedIntent());
    expect(await recovery.read()).toEqual(intent);
  });
  it.each(["symlink", "hardlink", "directory"])("refuses static %s journal without reading its bytes", async kind => {
    const { file, directory, recovery } = await setup();
    const target = path.join(directory, "target");
    if (kind === "directory") await fs.mkdir(file);
    else {
      await fs.writeFile(target, "must not read");
      if (kind === "symlink") await fs.symlink(target, file); else await fs.link(target, file);
    }
    const read = vi.spyOn(fs, "readFile");
    await expect(recovery.read()).rejects.toThrow("inspection_required");
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses an actual FIFO journal before read so it cannot block on a writer", async () => {
    const { file, recovery } = await setup();
    execFileSync("mkfifo", [file]);
    expect((await fs.lstat(file)).isFIFO()).toBe(true);
    const read = vi.spyOn(fs, "readFile");
    await expect(recovery.read()).rejects.toThrow("inspection_required");
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses disappearance after observing the company directory", async () => {
    const { file, directory, recovery } = await setup();
    const stat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === file) await fs.rmdir(directory);
      return stat(...args);
    });
    await expect(recovery.read()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses symlink and non-directory company paths before reading", async () => {
    const { directory, recovery } = await setup();
    await fs.rmdir(directory);
    const target = path.join(settings.root, "other");
    await fs.mkdir(target);
    await fs.symlink(target, directory);
    const read = vi.spyOn(fs, "readFile");
    await expect(recovery.read()).rejects.toThrow("inspection_required");
    await fs.unlink(directory); await fs.writeFile(directory, "not a directory");
    await expect(recovery.read()).rejects.toThrow("inspection_required");
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects non-UUID path identities before any filesystem access", () => {
    const stat = vi.spyOn(fs, "lstat");
    expect(() => quotaCredentialRecovery("../other", grant)).toThrow();
    expect(() => quotaCredentialRecovery(company, "../other")).toThrow();
    expect(stat).not.toHaveBeenCalled();
  });
});


describe("quota exact connection and grant predecessor", () => {
  it("refuses changed owner facts at completion and clearing without erasing retained result", async () => {
    const { recovery } = await setup();
    const intent = typedIntent();
    await recovery.beginExchange(intent);
    const changed = { ...originalOwnerIdentity, grant: { ...originalOwnerIdentity.grant, scopes: ["different-authority"] } };
    const changedIntent = { ...intent, originalOwnerIdentity: changed };
    const changedResult = { ...changedIntent, kind: "exchange-result" as const, intent: changedIntent, value: "exact-result" };
    await expect(recovery.completeExchange(changedResult)).rejects.toThrow();
    expect(await recovery.read()).toEqual(intent);
    const result = { ...intent, kind: "exchange-result" as const, intent, value: "exact-result" };
    await recovery.completeExchange(result);
    await expect(recovery.clear(changedResult)).rejects.toThrow();
    expect(await recovery.read()).toEqual(result);
    const reorderedOwner = { grant: { ...originalOwnerIdentity.grant }, connection: { authConfig: { mode: "oauth" }, status: "active", provider: "codex", companyId: company, id: intent.connectionId } };
    await recovery.clear({ ...result, originalOwnerIdentity: reorderedOwner, intent: { ...intent, originalOwnerIdentity: reorderedOwner } });
    expect(await recovery.read()).toBeNull();
  });
  it("retains old typed records missing owner identity for inspection without backfill", async () => {
    const { recovery, file } = await setup();
    const { originalOwnerIdentity: _missing, ...oldTyped } = typedIntent();
    const bytes = JSON.stringify({ fixture: JSON.stringify(oldTyped) });
    await fs.writeFile(file, bytes);
    await expect(recovery.read()).rejects.toThrow();
    await expect(recovery.beginExchange(typedIntent())).rejects.toThrow();
    await expect(recovery.clear()).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
  });
});
