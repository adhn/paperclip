import { assertNoPendingManagerClaimForDefinition } from "./manager-claim-recovery.js";
import { SLACK_MANAGER_SCOPES } from "@paperclipai/shared";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const fixture = vi.hoisted(() => ({ root: "", failEncrypt: false }));
vi.mock("../../../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => fixture.root }));
vi.mock("../../../../secrets/local-encrypted-provider.js", () => ({ localEncryptedProvider: {
  createVersion: async ({ value }: { value: string }) => { if (fixture.failEncrypt) throw new Error("fixture encryption failed"); return { material: { fixture: Buffer.from(value).toString("base64") } }; },
  resolveVersion: async ({ material }: { material: { fixture: string } }) => Buffer.from(material.fixture, "base64").toString(),
} }));
import { managerClaimRecovery, managerClaimRecoveryPath, managerClaimHash, assertNoPendingManagerClaimForActor, assertNoPendingManagerClaimForEndpoint, assertNoPendingManagerClaimForSecret, withManagerClaimSettlement, assertManagerClaimSecretMutationAllowed, type ManagerClaimIntent } from "./manager-claim-recovery.js";
const company = "00000000-0000-4000-8000-000000000001", endpoint = "00000000-0000-4000-8000-000000000002", secret = "00000000-0000-4000-8000-000000000003";
const state = `slack-manager.${"a".repeat(43)}`;
const intent: ManagerClaimIntent = { schema: 1, kind: "manager-claim-intent", family: "slack.manager.claim.hosted", clientMode: "claim",
  operationId: "00000000-0000-4000-8000-000000000004", redemptionId: "00000000-0000-4000-8000-000000000005", companyId: company, endpointId: endpoint,
  managerAppId: "A123", originalConnection: { id: "00000000-0000-4000-8000-000000000007", companyId: company },
  actorUserId: "fixture-user", actorSessionId: "fixture-session", stateHash: managerClaimHash(state), codeHash: managerClaimHash("fixture-code"),
  originalEndpoint: { id: endpoint, companyId: company, connectionId: "00000000-0000-4000-8000-000000000007" }, originalRegistration: null,
  originalOauthState: { state, companyId: company, connectionId: "00000000-0000-4000-8000-000000000007", createdByActorId: "fixture-user", createdBySessionId: "fixture-session" },
  originalGrants: [{ id: "00000000-0000-4000-8000-000000000006", companyId: company, userId: "fixture-user", accessSecretId: secret, refreshSecretId: null, managerAppId: "A123", workspaceId: "T123", slackUserId: "U123" }],
  originalSecrets: { [secret]: { identity: { secretId: secret, versionId: secret, version: 1, authority: { parent: {}, version: {}, definition: null, providerConfig: null } }, valueHash: managerClaimHash("fixture-original") } },
  originalClientAuthority: { schema: 1, kind: "hosted-sealed", baseUrl: "https://fixture.invalid", instanceId: "fixture", environment: "test", signingKeySha256: managerClaimHash("fixture-signing"), sealingKeySha256: managerClaimHash("fixture-sealing") },
};
const raw = { status: 200, headers: { "x-fixture": "retained" }, bodyBase64: Buffer.from("fixture sealed bytes").toString("base64") };
const credentials = { v: 1 as const, accessToken: "fixture-access", refreshToken: "fixture-refresh", tokenType: "user" as const, accessTokenExpiresAt: "2099-01-01T00:00:00.000Z", refreshTokenExpiresAt: null, scopes: [...SLACK_MANAGER_SCOPES], subject: intent.actorUserId, companyId: company, instanceId: "fixture", environment: "test" as const, provider: "slack" as const, profile: "slack.manager" as const, slackManager: { appId: "A123", workspaceId: "T123", workspaceName: "Fixture", userId: "U123" } };
const reopen = () => managerClaimRecovery(company, endpoint);
const file = () => managerClaimRecoveryPath(company, endpoint);
beforeEach(async () => { fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-claim-")); fixture.failEncrypt = false; });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.root, { recursive: true, force: true }); });

describe("independent manager claim recovery occupancy", () => {
  it("retains exact intent after reopen and refuses every repeated operation", async () => {
    await reopen().begin(intent);
    expect(await reopen().read()).toEqual(intent);
    await expect(reopen().begin(intent)).rejects.toThrow();
    await expect(reopen().begin({ ...intent, operationId: endpoint })).rejects.toThrow();
    await expect(assertNoPendingManagerClaimForActor(company, intent.actorUserId)).rejects.toThrow();
    await expect(assertNoPendingManagerClaimForEndpoint(company, endpoint)).rejects.toThrow();
    await expect(assertNoPendingManagerClaimForSecret(company, secret)).rejects.toThrow();
    await assertNoPendingManagerClaimForSecret(company, endpoint);
  });
  it("requires exact raw-before-result transition and exact acknowledged clear", async () => {
    await reopen().begin(intent);
    await expect(reopen().recordResult({ intent, raw, credentials })).rejects.toThrow();
    await reopen().recordRaw({ intent, raw });
    await expect(reopen().recordRaw({ intent, raw: { ...raw, status: 201 } })).rejects.toThrow();
    const result = await reopen().recordResult({ intent, raw, credentials });
    expect(await reopen().read()).toEqual(result);
    await expect(reopen().clear({ ...result, credentials: { ...credentials, accessToken: "other" } })).rejects.toThrow();
    await reopen().clear(result);
    expect(await reopen().read()).toBeNull();
  });
  it("retains raw invalid provider result even when decoded structural validation fails", async () => {
    await reopen().begin(intent);
    const failed = { ...raw, status: 500, bodyBase64: Buffer.from([255, 0, 128]).toString("base64") };
    await reopen().recordRaw({ intent, raw: failed });
    await expect(reopen().recordResult({ intent, raw: failed, credentials })).rejects.toThrow();
    expect(await reopen().read()).toEqual({ schema: 1, kind: "manager-claim-raw", intent, raw: failed });
    await expect(reopen().begin(intent)).rejects.toThrow();
  });
  it("refuses family substitution and incomplete original credential authority", async () => {
    await expect(reopen().begin({ ...intent, clientMode: "code" })).rejects.toThrow();
    await expect(reopen().begin({ ...intent, originalSecrets: {} })).rejects.toThrow();
    expect(await reopen().read()).toBeNull();
  });
  it("retains original intent when raw encryption fails", async () => {
    await reopen().begin(intent); fixture.failEncrypt = true;
    await expect(reopen().recordRaw({ intent, raw })).rejects.toThrow("fixture encryption failed");
    expect(await reopen().read()).toEqual(intent);
  });
  for (const alias of ["symlink", "hardlink", "directory"] as const) it(`refuses static ${alias} journal aliases`, async () => {
    await reopen().begin(intent);
    const saved = `${file()}.saved`;
    await fs.rename(file(), saved);
    if (alias === "symlink") await fs.symlink(saved, file());
    else if (alias === "hardlink") await fs.link(saved, file());
    else await fs.mkdir(file());
    // Remove backup from managed directory so this specifically exercises leaf refusal.
    await fs.rename(saved, path.join(fixture.root, "outside"));
    await expect(reopen().read()).rejects.toThrow();
    await expect(assertNoPendingManagerClaimForActor(company, intent.actorUserId)).rejects.toThrow();
  });
  it("refuses unknown temporary occupancy", async () => {
    await reopen().begin(intent);
    await fs.writeFile(`${file()}.uncertain.tmp`, "fixture");
    await expect(reopen().read()).rejects.toThrow();
    await expect(assertNoPendingManagerClaimForSecret(company, endpoint)).rejects.toThrow();
  });
  it("does not treat disappearance during observed enumeration as absence", async () => {
    await reopen().begin(intent);
    const realRead = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementationOnce(async (...args: Parameters<typeof fs.readdir>) => { await fs.rm(path.dirname(file()), { recursive: true }); return realRead(...args); });
    await expect(reopen().read()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains causal sync and close errors plus temporary uncertainty", async () => {
    const realOpen = fs.open.bind(fs);
    const first = new Error("fixture file sync failed"), second = new Error("fixture close failed");
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const close = handle.close.bind(handle);
        handle.sync = async () => { throw first; };
        handle.close = async () => { await close(); throw second; };
      }
      return handle;
    });
    const error = await reopen().begin(intent).catch(value => value);
    expect(error.errors).toEqual([first, second]);
    await expect(reopen().read()).rejects.toThrow();
  });
  it("refuses directory replacement during an absent-file durability barrier", async () => {
    await reopen().begin(intent);
    await fs.rm(file());
    const realOpen = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === path.dirname(file()) && !replaced) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync(); replaced = true;
          await fs.rename(path.dirname(file()), path.join(fixture.root, "old-directory"));
          await fs.mkdir(path.dirname(file()));
        };
      }
      return handle;
    });
    await expect(reopen().read()).rejects.toThrow();
    expect(replaced).toBe(true);
  });

  it("allows only exact original result-target token writes inside active settlement", async () => {
    await reopen().begin(intent); await reopen().recordRaw({ intent, raw });
    const result = await reopen().recordResult({ intent, raw, credentials });
    await expect(assertManagerClaimSecretMutationAllowed(company, secret, credentials.accessToken)).rejects.toThrow();
    await withManagerClaimSettlement(result, async () => {
      await assertManagerClaimSecretMutationAllowed(company, secret, credentials.accessToken);
      await expect(assertManagerClaimSecretMutationAllowed(company, secret, credentials.refreshToken)).rejects.toThrow();
      await expect(assertManagerClaimSecretMutationAllowed(company, secret)).rejects.toThrow();
      await expect(assertNoPendingManagerClaimForSecret(company, secret)).rejects.toThrow();
    });
    await expect(assertManagerClaimSecretMutationAllowed(company, secret, credentials.accessToken)).rejects.toThrow();
    await expect(withManagerClaimSettlement({ ...result, raw: { ...raw, status: 201 } }, async () => {})).rejects.toThrow();
  });
  it.each(["scopes", "expired", "instance", "environment"] as const)("retains decoded %s failure without granting settlement capability", async failure => {
    const invalid = { ...credentials, ...(failure === "scopes" ? { scopes: [] } : failure === "expired" ? { accessTokenExpiresAt: "2000-01-01T00:00:00.000Z" }
      : failure === "instance" ? { instanceId: "other-instance" } : { environment: "production" as const }) };
    await reopen().begin(intent); await reopen().recordRaw({ intent, raw });
    const result = await reopen().recordResult({ intent, raw, credentials: invalid });
    const action = vi.fn(async () => { await assertManagerClaimSecretMutationAllowed(company, secret, invalid.accessToken); });
    await expect(withManagerClaimSettlement(result, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    await expect(assertManagerClaimSecretMutationAllowed(company, secret, invalid.accessToken)).rejects.toThrow();
    expect(await reopen().read()).toEqual(result);
  });

  it.each([true, false])("pins development result instance/environment before scope (valid=%s)", async valid => {
    const original = { ...intent, family: "slack.manager.oauth.development" as const, clientMode: "code" as const,
      originalClientAuthority: { schema: 1 as const, kind: "development-direct-oauth" as const, apiBaseUrl: "https://slack.com/api/" as const,
        appId: "A123", clientId: "123.456", clientSecretSha256: managerClaimHash("fixture-client"), callbackUri: "https://fixture.invalid/callback" } };
    const decoded = { ...credentials, instanceId: valid ? "local-slack-qualification" : "other", environment: "development" as const };
    await reopen().begin(original); await reopen().recordRaw({ intent: original, raw });
    const result = await reopen().recordResult({ intent: original, raw, credentials: decoded });
    const action = vi.fn(async () => { await assertManagerClaimSecretMutationAllowed(company, secret, decoded.accessToken); });
    if (valid) { await withManagerClaimSettlement(result, action); expect(action).toHaveBeenCalledOnce(); }
    else { await expect(withManagerClaimSettlement(result, action)).rejects.toThrow(); expect(action).not.toHaveBeenCalled(); }
    expect(await reopen().read()).toEqual(result);
  });

  it.each(["ambiguous-role", "foreign-target"] as const)("refuses settlement capability for %s", async mode => {
    const changed = { ...intent, originalGrants: intent.originalGrants.map(grant => ({ ...grant,
      ...(mode === "ambiguous-role" ? { refreshSecretId: secret } : { workspaceId: "T999" }),
    })) };
    await reopen().begin(changed); await reopen().recordRaw({ intent: changed, raw });
    const result = await reopen().recordResult({ intent: changed, raw, credentials });
    await withManagerClaimSettlement(result, async () => {
      await expect(assertManagerClaimSecretMutationAllowed(company, secret, credentials.accessToken)).rejects.toThrow();
    });
  });
  it.each(["return", "throw"] as const)("revokes detached inherited capability after callback %s", async mode => {
    await reopen().begin(intent); await reopen().recordRaw({ intent, raw });
    const result = await reopen().recordResult({ intent, raw, credentials });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let detached!: Promise<unknown>;
    const run = withManagerClaimSettlement(result, async () => {
      detached = gate.then(() => assertManagerClaimSecretMutationAllowed(company, secret, credentials.accessToken)).catch(error => error);
      if (mode === "throw") throw new Error("fixture callback failed");
    });
    await run.catch(() => {}); release();
    expect(await detached).toBeInstanceOf(Error);
  });

  it("gates absent-file reuse on completing failed unlink directory flush", async () => {
    await reopen().begin(intent); await reopen().recordRaw({ intent, raw });
    const result = await reopen().recordResult({ intent, raw, credentials });
    const realOpen = fs.open.bind(fs); let fail = true;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === path.dirname(file()) && fail) handle.sync = async () => { throw new Error("fixture directory flush failed"); };
      return handle;
    });
    await expect(reopen().clear(result)).rejects.toThrow("directory flush failed");
    await expect(reopen().read()).rejects.toThrow("directory flush failed");
    await expect(reopen().begin(intent)).rejects.toThrow("directory flush failed");
    fail = false;
    await reopen().begin(intent);
    expect(await reopen().read()).toEqual(intent);
  });
  it.each(["file", "directory"] as const)("retains active original definition occupancy after journal %s disappears", async missing => {
    const definition = "00000000-0000-4000-8000-000000000099", unrelated = "00000000-0000-4000-8000-000000000098", selected = structuredClone(intent);
    selected.originalSecrets[secret].identity.authority.definition = { id: definition, key: "original" };
    await reopen().begin(selected); await expect(assertNoPendingManagerClaimForDefinition(company, definition)).rejects.toThrow(); await reopen().recordRaw({ intent: selected, raw }); const saved = await reopen().recordResult({ intent: selected, raw, credentials });
    await withManagerClaimSettlement(saved, async () => {
      await expect(assertNoPendingManagerClaimForDefinition(company, definition)).rejects.toThrow();
      await assertNoPendingManagerClaimForDefinition(company, unrelated);
      if (missing === "directory") await fs.rm(path.dirname(file()), { recursive: true }); else await fs.rm(file());
      await expect(assertNoPendingManagerClaimForDefinition(company, definition)).rejects.toThrow();
      await assertNoPendingManagerClaimForDefinition(company, unrelated);
    });
    // Scope expiry grants no permanent deny when retained original occupancy is absent.
    await assertNoPendingManagerClaimForDefinition(company, definition);
  });

});
