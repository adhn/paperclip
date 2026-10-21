import { assertNoPendingManagerRefreshForDefinition } from "./manager-refresh-recovery.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ root: "", failKind: "" }));
vi.mock("../../../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => fixture.root }));
vi.mock("../../../../secrets/local-encrypted-provider.js", () => ({ localEncryptedProvider: {
  createVersion: async ({ value }: { value: string }) => { if (JSON.parse(value).kind === fixture.failKind) throw new Error("publication failed"); return { material: { fixture: Buffer.from(value).toString("base64") } }; },
  resolveVersion: async ({ material }: { material: { fixture: string } }) => Buffer.from(material.fixture, "base64").toString(),
} }));
import { managerRefreshRecovery, managerRefreshRecoveryPath, assertNoPendingManagerRefreshForActor, assertManagerRefreshSecretMutationAllowed, assertManagerRefreshSaveAllowed, withManagerRefreshSettlement, type ManagerRefreshIntent } from "./manager-refresh-recovery.js";
const companyId = "00000000-0000-4000-8000-000000000001", grantId = "00000000-0000-4000-8000-000000000002";
const intent: ManagerRefreshIntent = { schema: 1, kind: "manager-refresh-intent", family: "slack.manager.refresh", operationId: "00000000-0000-4000-8000-000000000003", companyId, grantId,
  ownerUserId: "owner", managerAppId: "AMANAGER", workspaceId: "TORIGINAL", slackUserId: "UORIGINAL", profile: "slack.manager", clientAuthority: { schema: 1, kind: "hosted-sealed", baseUrl: "https://broker.fixture.invalid", instanceId: "fixture", environment: "staging", signingKeySha256: "c".repeat(64), sealingKeySha256: "d".repeat(64) }, clientMode: "claim", originalRevision: 2, claimedRevision: 3,
  access: { identity: { secretId: "00000000-0000-4000-8000-000000000004", versionId: "00000000-0000-4000-8000-000000000006", version: 2, authority: { parent: { owner: "original-access-owner" }, version: { original: "access-version" }, definition: null, providerConfig: null } }, secretId: "00000000-0000-4000-8000-000000000004", latestVersion: 2, valueHash: "a".repeat(64) }, refresh: { identity: { secretId: "00000000-0000-4000-8000-000000000005", versionId: "00000000-0000-4000-8000-000000000007", version: 4, authority: { parent: { owner: "original-refresh-owner" }, version: { original: "refresh-version" }, definition: null, providerConfig: null } }, secretId: "00000000-0000-4000-8000-000000000005", latestVersion: 4, valueHash: "b".repeat(64) } };
const raw = { status: 200, headers: {}, bodyBase64: Buffer.from('{"sealed":"original"}').toString("base64") };
import { SLACK_MANAGER_SCOPES } from "@paperclipai/shared";
const credentials = { v: 1 as const, accessToken: "new-access", refreshToken: "new-refresh", tokenType: "user" as const, accessTokenExpiresAt: "2035-01-01T00:00:00.000Z", refreshTokenExpiresAt: null, scopes: [...SLACK_MANAGER_SCOPES], subject: "owner", companyId, instanceId: "fixture", environment: "staging" as const, provider: "slack" as const, profile: "slack.manager" as const };
const recovery = () => managerRefreshRecovery(companyId, grantId);
beforeEach(async () => { fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-refresh-")); fixture.failKind = ""; });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.root, { recursive: true, force: true }); });
describe("original manager refresh journal", () => {
  it("retains exact intent across reopen and refuses exchange replacement and actor new use", async () => {
    await recovery().begin(intent);
    expect(await recovery().read()).toEqual(intent);
    await expect(recovery().begin(intent)).rejects.toMatchObject({ code: "slack_manager_refresh_recovery_pending" });
    await expect(recovery().begin({ ...intent, claimedRevision: 9 })).rejects.toThrow();
    await expect(assertNoPendingManagerRefreshForActor(companyId, "owner")).rejects.toThrow();
    await assertNoPendingManagerRefreshForActor(companyId, "other");
  });
  it("holds historical records missing original client authority", async () => {
    const { clientAuthority: _missing, ...historical } = intent;
    const file = managerRefreshRecoveryPath(companyId, grantId); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ fixture: Buffer.from(JSON.stringify(historical)).toString("base64") }));
    await expect(recovery().read()).rejects.toThrow();
    await expect(assertNoPendingManagerRefreshForActor(companyId, "owner")).rejects.toThrow();
    await expect(recovery().begin(intent)).rejects.toThrow();
  });
  it("retains raw before decoded result and refuses changed originals or raw output", async () => {
    await recovery().begin(intent); await recovery().recordRaw({ intent, raw });
    expect(await recovery().read()).toMatchObject({ kind: "manager-refresh-raw", intent, raw });
    await expect(recovery().recordResult({ intent, raw: { ...raw, status: 201 }, credentials })).rejects.toThrow();
    await expect(recovery().recordResult({ intent, raw, credentials: { ...credentials, subject: "other" } })).rejects.toThrow();
    const result = await recovery().recordResult({ intent, raw, credentials });
    expect(await recovery().read()).toEqual(result);
    await expect(recovery().clear({ ...result, credentials: { ...credentials, accessToken: "different" } })).rejects.toThrow();
    await recovery().clear(result); expect(await recovery().read()).toBeNull();
  });
  it("retains raw output when decoded-result publication fails", async () => {
    await recovery().begin(intent); await recovery().recordRaw({ intent, raw });
    fixture.failKind = "manager-refresh-result";
    await expect(recovery().recordResult({ intent, raw, credentials })).rejects.toThrow("publication failed");
    expect(await recovery().read()).toMatchObject({ kind: "manager-refresh-raw" });
  });
  it("retains published intent after lost rename acknowledgement", async () => {
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => { await rename(from, to); throw new Error("lost rename acknowledgement"); });
    await expect(recovery().begin(intent)).rejects.toThrow("lost rename acknowledgement");
    expect(await recovery().read()).toEqual(intent);
    await expect(recovery().begin(intent)).rejects.toThrow();
  });
  it("refuses all new-use guards on temp/unrecognized inventory", async () => {
    const directory = path.dirname(managerRefreshRecoveryPath(companyId, grantId)); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "unknown.tmp"), "occupancy");
    await expect(recovery().read()).rejects.toThrow();
    await expect(assertNoPendingManagerRefreshForActor(companyId, "other")).rejects.toThrow();
    await expect(assertManagerRefreshSecretMutationAllowed(companyId, intent.access.secretId, "new-access")).rejects.toThrow();
  });
  it("permits only exact settlement token writes and expires inherited asynchronous capability", async () => {
    await recovery().begin(intent); await recovery().recordRaw({ intent, raw });
    const result = await recovery().recordResult({ intent, raw, credentials });
    let later!: () => Promise<void>;
    await withManagerRefreshSettlement(result, async () => {
      await assertManagerRefreshSaveAllowed(companyId, "owner", grantId, credentials);
      await assertManagerRefreshSecretMutationAllowed(companyId, intent.access.secretId, "new-access");
      await assertManagerRefreshSecretMutationAllowed(companyId, intent.refresh.secretId, "new-refresh");
      await expect(assertManagerRefreshSecretMutationAllowed(companyId, intent.access.secretId)).rejects.toThrow();
      await expect(assertManagerRefreshSecretMutationAllowed(companyId, intent.access.secretId, "arbitrary")).rejects.toThrow();
      const scope = import("node:async_hooks");
      const { AsyncResource } = await scope;
      later = AsyncResource.bind(() => assertManagerRefreshSecretMutationAllowed(companyId, intent.access.secretId, "new-access"));
    });
    await expect(later()).rejects.toThrow();
    await expect(assertManagerRefreshSaveAllowed(companyId, "owner", grantId, credentials)).rejects.toThrow();
  });
  it.each(["file", "directory"] as const)("retains active original definition occupancy after journal %s disappears", async missing => {
    const definition = "00000000-0000-4000-8000-000000000099", unrelated = "00000000-0000-4000-8000-000000000098", selected = structuredClone(intent);
    selected.access.identity.authority.definition = { id: definition, key: "original" };
    await recovery().begin(selected); await expect(assertNoPendingManagerRefreshForDefinition(companyId, definition)).rejects.toThrow(); await recovery().recordRaw({ intent: selected, raw }); const saved = await recovery().recordResult({ intent: selected, raw, credentials });
    await withManagerRefreshSettlement(saved, async () => {
      await expect(assertNoPendingManagerRefreshForDefinition(companyId, definition)).rejects.toThrow();
      await assertNoPendingManagerRefreshForDefinition(companyId, unrelated);
      if (missing === "directory") await fs.rm(path.dirname(managerRefreshRecoveryPath(companyId, grantId)), { recursive: true }); else await fs.rm(managerRefreshRecoveryPath(companyId, grantId));
      await expect(assertNoPendingManagerRefreshForDefinition(companyId, definition)).rejects.toThrow();
      await assertNoPendingManagerRefreshForDefinition(companyId, unrelated);
    });
    // Scope expiry grants no permanent deny when retained original occupancy is absent.
    await assertNoPendingManagerRefreshForDefinition(companyId, definition);
  });

});
