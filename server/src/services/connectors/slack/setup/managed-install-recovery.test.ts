import { assertNoPendingManagedInstallForDefinition } from "./managed-install-recovery.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as durable from "../../../../lib/durable-directory.js";
const fixture = vi.hoisted(() => ({ root: "", failEncrypt: false }));
vi.mock("../../../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => fixture.root }));
// Reversible fixture envelope; this suite establishes local protocol behavior,
// independently of master-key/provider custody covered by other fixtures.
vi.mock("../../../../secrets/local-encrypted-provider.js", () => ({ localEncryptedProvider: {
  createVersion: async ({ value }: { value: string }) => { if (fixture.failEncrypt) throw new Error("encryption failed"); return { material: { fixture: Buffer.from(value).toString("base64") } }; },
  resolveVersion: async ({ material }: { material: { fixture: string } }) => Buffer.from(material.fixture, "base64").toString(),
} }));
import { managedInstallRecovery, managedInstallRecoveryPath, managedInstallHash, assertNoPendingManagedInstallForActor,
  assertNoPendingManagedInstallForEndpoint, assertNoPendingManagedInstallForGrant, assertNoPendingManagedInstallForSecret,
  withManagedInstallSettlement, assertManagedInstallSecretMutationAllowed, assertManagedInstallCompletionAllowed, type ManagedInstallIntent } from "./managed-install-recovery.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const company = id(1), endpoint = id(2), bot = id(3), access = id(4), refresh = id(5), grant = id(6), connection = id(7), request = id(8);
const descriptor = (secretId: string) => ({ identity: { secretId, versionId: id(20), version: 1,
  authority: { parent: { provider: "local_encrypted" }, version: { material: { fixture: "original" } }, definition: null, providerConfig: null } }, valueHash: managedInstallHash("original") });
const intent: ManagedInstallIntent = { schema: 1, kind: "managed-install-intent", family: "slack.apps.managedInstall", operationId: id(9), companyId: company, endpointId: endpoint,
  actorUserId: "installer", actorSessionId: "original-session", originalEndpoint: { id: endpoint, companyId: company, connectionId: connection, setup: { runtimeGeneration: 0 } },
  originalConnection: { id: connection, companyId: company, status: "active" },
  originalRegistration: { endpointId: endpoint, companyId: company, requestId: request, managerGrantId: grant, appId: "A123", manifestHash: managedInstallHash("original-manifest"), manifest: { original: true }, secretIds: { botToken: bot }, status: "configured" },
  preparedEndpoint: null, preparedRegistration: { endpointId: endpoint, companyId: company, status: "install" }, originalAction: null, preparedAction: null,
  originalManagerGrant: { id: grant, companyId: company, userId: "installer", managerAppId: "AMANAGER", workspaceId: "T123", slackUserId: "U123", accessSecretId: access, refreshSecretId: refresh, revision: 2 },
  originalManagerSecrets: { [access]: descriptor(access), [refresh]: descriptor(refresh) }, originalRegistrationSecrets: { [bot]: descriptor(bot) },
  requestId: request, requestedRequestId: id(10), reconnectKey: null, appId: "A123", manifestHash: managedInstallHash("original-manifest"), params: { app_id: "A123", team_id: "T123" },
  directApiAuthority: { method: "apps.managedInstall", apiBaseUrl: "https://slack.com/api/", managerAppId: "AMANAGER", workspaceId: "T123", slackUserId: "U123" },
};
const decoded = { appId: "A123", teamId: "T123", botToken: "xoxb-exact-original-result" };
const raw = { status: 200, headers: { "x-fixture": "exact" }, bodyBase64: Buffer.from(JSON.stringify({ ok: true, app_id: "A123", team_id: "T123", api_access_tokens: { bot_access_token: decoded.botToken } })).toString("base64") };
const reopen = () => managedInstallRecovery(company, endpoint);
const file = () => managedInstallRecoveryPath(company, endpoint);
async function result() { await reopen().begin(intent); await reopen().recordRaw({ intent, raw }); return reopen().recordResult({ intent, raw, decoded }); }
beforeEach(async () => { fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-install-")); fixture.failEncrypt = false; });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.root, { recursive: true, force: true }); });
describe("managed installation original recovery occupancy", () => {
  it("preserves original and prepared states and all independent occupancy guards after reopen", async () => {
    await reopen().begin(intent);
    expect(await reopen().read()).toEqual(intent);
    expect(intent.requestId).not.toBe(intent.requestedRequestId);
    await expect(reopen().begin(intent)).rejects.toThrow();
    await expect(reopen().begin({ ...intent, operationId: id(10) })).rejects.toThrow();
    await expect(assertNoPendingManagedInstallForActor(company, "installer")).rejects.toThrow();
    await expect(assertNoPendingManagedInstallForEndpoint(company, endpoint)).rejects.toThrow();
    await expect(assertNoPendingManagedInstallForGrant(company, grant)).rejects.toThrow();
    for (const secret of [bot, access, refresh]) await expect(assertNoPendingManagedInstallForSecret(company, secret)).rejects.toThrow();
    await assertNoPendingManagedInstallForSecret(company, id(99));
  });
  it("requires exact raw before decoded result and exact acknowledged clear", async () => {
    await reopen().begin(intent);
    await expect(reopen().recordResult({ intent, raw, decoded })).rejects.toThrow();
    await reopen().recordRaw({ intent, raw });
    await expect(reopen().recordRaw({ intent, raw: { ...raw, status: 201 } })).rejects.toThrow();
    const saved = await reopen().recordResult({ intent, raw, decoded });
    expect(await reopen().read()).toEqual(saved);
    await expect(reopen().clear({ ...saved, decoded: { ...decoded, botToken: "xoxb-other" } })).rejects.toThrow();
    await reopen().clear(saved);
    expect(await reopen().read()).toBeNull();
  });
  it.each(["app", "team", "token", "invalid-json", "status"])("retains raw when decoded %s cannot establish the original response", async fault => {
    await reopen().begin(intent);
    const body = { ok: true, app_id: fault === "app" ? "AOTHER" : decoded.appId, team_id: fault === "team" ? "TOTHER" : decoded.teamId, api_access_tokens: { bot_access_token: fault === "token" ? "xoxb-other" : decoded.botToken } };
    const originalRaw = { ...raw, status: fault === "status" ? 500 : 200, bodyBase64: fault === "invalid-json" ? Buffer.from([255, 0]).toString("base64") : Buffer.from(JSON.stringify(body)).toString("base64") };
    await reopen().recordRaw({ intent, raw: originalRaw });
    await expect(reopen().recordResult({ intent, raw: originalRaw, decoded })).rejects.toThrow();
    expect(await reopen().read()).toEqual({ schema: 1, kind: "managed-install-raw", intent, raw: originalRaw });
    await expect(reopen().begin(intent)).rejects.toThrow();
  });
  it("refuses incomplete original descriptors and changed direct authority/params", async () => {
    for (const input of [
      { ...intent, originalManagerSecrets: {} }, { ...intent, originalRegistrationSecrets: {} },
      { ...intent, params: { ...intent.params, team_id: "TOTHER" } },
      { ...intent, directApiAuthority: { ...intent.directApiAuthority, managerAppId: "AOTHER" } },
    ]) await expect(reopen().begin(input)).rejects.toThrow();
    expect(await reopen().read()).toBeNull();
  });
  it("permits only original bot exact value in active result scope and refuses detached descendants", async () => {
    const saved = await result();
    await expect(assertManagedInstallSecretMutationAllowed(company, bot, decoded.botToken)).rejects.toThrow();
    await expect(assertManagedInstallCompletionAllowed(company, endpoint)).rejects.toThrow();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let later!: Promise<void>;
    await withManagedInstallSettlement(saved, async () => {
      await assertManagedInstallSecretMutationAllowed(company, bot, decoded.botToken);
      await assertManagedInstallCompletionAllowed(company, endpoint);
      for (const [secret, value] of [[access, decoded.botToken], [refresh, decoded.botToken], [bot, undefined], [bot, "xoxb-other"]] as const)
        await expect(assertManagedInstallSecretMutationAllowed(company, secret, value)).rejects.toThrow();
      // Attach while inside ALS, then execute only after its active flag expires.
      later = gate.then(() => assertManagedInstallSecretMutationAllowed(company, bot, decoded.botToken));
    });
    const refusal = expect(later).rejects.toThrow();
    release();
    await refusal;
    await expect(assertManagedInstallCompletionAllowed(company, endpoint)).rejects.toThrow();
  });
  it("never grants completion from an intent/raw entry or a stale result scope", async () => {
    await reopen().begin(intent);
    await expect(assertManagedInstallCompletionAllowed(company, endpoint)).rejects.toThrow();
    await reopen().recordRaw({ intent, raw });
    await expect(assertManagedInstallCompletionAllowed(company, endpoint)).rejects.toThrow();
    const saved = await reopen().recordResult({ intent, raw, decoded });
    await withManagedInstallSettlement(saved, async () => {
      const changed = { ...saved, intent: { ...saved.intent, operationId: id(99) } };
      await fs.writeFile(file(), JSON.stringify({ fixture: Buffer.from(JSON.stringify(changed)).toString("base64") }));
      await expect(assertManagedInstallCompletionAllowed(company, endpoint)).rejects.toThrow();
    });
  });
  it("refuses missing original journal or directory inside its active completion scope", async () => {
    for (const removeDirectory of [false, true]) {
      const saved = await result();
      await withManagedInstallSettlement(saved, async () => {
        if (removeDirectory) await fs.rm(path.dirname(file()), { recursive: true });
        else await fs.rm(file());
        await expect(assertManagedInstallCompletionAllowed(company, endpoint)).rejects.toThrow();
      });
    }
  });
  it("refuses manager credential aliases even when also the original bot", async () => {
    const aliased = { ...intent, originalRegistration: { ...intent.originalRegistration, secretIds: { botToken: access } }, originalRegistrationSecrets: { [access]: descriptor(access) } };
    await reopen().begin(aliased); await reopen().recordRaw({ intent: aliased, raw });
    const saved = await reopen().recordResult({ intent: aliased, raw, decoded });
    await withManagedInstallSettlement(saved, async () => { await expect(assertManagedInstallSecretMutationAllowed(company, access, decoded.botToken)).rejects.toThrow(); });
  });
  it("retains temporary preparation and causal sync/close errors", async () => {
    const open = fs.open.bind(fs); const first = new Error("sync failed"), second = new Error("close failed");
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp")) { const close = handle.close.bind(handle); vi.spyOn(handle, "sync").mockRejectedValue(first); vi.spyOn(handle, "close").mockImplementation(async () => { await close(); throw second; }); }
      return handle;
    });
    const failure = await reopen().begin(intent).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toEqual([first, second]);
    vi.restoreAllMocks();
    expect(await fs.readdir(path.dirname(file()))).toHaveLength(1);
    await expect(reopen().read()).rejects.toThrow();
    await expect(reopen().begin(intent)).rejects.toThrow();
  });
  it("repairs a lost deletion flush before acknowledging absence/new use", async () => {
    const saved = await result(); const original = durable.syncDirectory; const failure = new Error("directory sync failed");
    const sync = vi.spyOn(durable, "syncDirectory").mockRejectedValue(failure);
    await expect(reopen().clear(saved)).rejects.toBe(failure);
    await expect(reopen().read()).rejects.toBe(failure);
    await expect(reopen().begin(intent)).rejects.toBe(failure);
    sync.mockImplementation(original);
    expect(await reopen().read()).toBeNull();
    await reopen().begin(intent);
  });
  it.each(["symlink", "hardlink"])("refuses static %s journal without reading bytes", async kind => {
    await fs.mkdir(path.dirname(file()), { recursive: true }); const target = path.join(fixture.root, "target"); await fs.writeFile(target, "unknown");
    if (kind === "symlink") await fs.symlink(target, file()); else await fs.link(target, file());
    const read = vi.spyOn(fs, "readFile");
    await expect(reopen().read()).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it("refuses observed directory disappearance and directory aliases", async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    const read = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => { await fs.rmdir(path.dirname(file())); return read(...args); });
    await expect(reopen().read()).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();
    await fs.symlink(fixture.root, path.dirname(file()));
    await expect(reopen().read()).rejects.toThrow();
  });
  it.each(["file", "directory"] as const)("retains active original definition occupancy after journal %s disappears", async missing => {
    const definition = "00000000-0000-4000-8000-000000000099", unrelated = "00000000-0000-4000-8000-000000000098", selected = structuredClone(intent);
    selected.originalManagerSecrets[access].identity.authority.definition = { id: definition, key: "original" };
    await reopen().begin(selected); await expect(assertNoPendingManagedInstallForDefinition(company, definition)).rejects.toThrow(); await reopen().recordRaw({ intent: selected, raw }); const saved = await reopen().recordResult({ intent: selected, raw, decoded });
    await withManagedInstallSettlement(saved, async () => {
      await expect(assertNoPendingManagedInstallForDefinition(company, definition)).rejects.toThrow();
      await assertNoPendingManagedInstallForDefinition(company, unrelated);
      if (missing === "directory") await fs.rm(path.dirname(file()), { recursive: true }); else await fs.rm(file());
      await expect(assertNoPendingManagedInstallForDefinition(company, definition)).rejects.toThrow();
      await assertNoPendingManagedInstallForDefinition(company, unrelated);
    });
    // Scope expiry grants no permanent deny when retained original occupancy is absent.
    await assertNoPendingManagedInstallForDefinition(company, definition);
  });

});
