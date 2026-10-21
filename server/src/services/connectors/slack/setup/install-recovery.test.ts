import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ root: "", failResult: false }));
vi.mock("../../../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => fixture.root }));
vi.mock("../../../../secrets/local-encrypted-provider.js", () => ({ localEncryptedProvider: {
  createVersion: async ({ value }: { value: string }) => {
    if (fixture.failResult && JSON.parse(value).kind === "slack-install-result") throw new Error("fixture result encryption failure");
    return { material: { fixture: Buffer.from(value).toString("base64") } };
  },
  resolveVersion: async ({ material }: { material: { fixture: string } }) => Buffer.from(material.fixture, "base64").toString(),
} }));
import { slackInstallRecovery, slackInstallRecoveryPath, assertNoPendingSlackInstall, assertNoPendingSlackInstallForSecret, assertNoPendingSlackInstallForDefinition, withSlackInstallResultSettlement, assertSlackInstallSecretMutationAllowed, type SlackInstallIntent } from "./install-recovery.js";
const company = "00000000-0000-4000-8000-000000000001";
const endpoint = "00000000-0000-4000-8000-000000000002";
const secret = "00000000-0000-4000-8000-000000000003";
const intent: SlackInstallIntent = { schema: 1, kind: "slack-install-intent", operationId: "00000000-0000-4000-8000-000000000004",
  companyId: company, endpointId: endpoint, connectionId: "00000000-0000-4000-8000-000000000005", requestId: "00000000-0000-4000-8000-000000000006",
  state: `slack-install.${"a".repeat(43)}`, appId: "A123", clientId: "123.456", callbackUri: "https://fixture.invalid/callback",
  runtimeGeneration: 1, actorUserId: "fixture-actor", actorSessionId: "fixture-session", requestedScopes: ["chat:write"],
  codeHash: "a".repeat(64), secretIds: { clientSecret: secret }, originalBotTokenHash: null, originalClientSecretHash: "a".repeat(64),
  managerGrantId: null, originalWorkspaceId: null, originalBotUserId: null, originalProviderAccountId: null, originalBotExternalId: null, originalAccount: {}, originalSecretIdentities: { clientSecret: { secretId: secret, versionId: secret, version: 1, authority: { parent: {}, version: {}, definition: null, providerConfig: null } } } };
const result = () => ({ schema: 1 as const, kind: "slack-install-result" as const, intent,
  raw: { status: 200, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from('{"ok":true,"access_token":"fixture-token"}').toString("base64") } });
const reopen = () => slackInstallRecovery(company, endpoint);
beforeEach(async () => { fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "slack-install-recovery-")); fixture.failResult = false; });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.root, { recursive: true, force: true }); });
describe("retained Slack install recovery", () => {
  it.each(["intent", "raw-result", "successful-result"] as const)("retains original definition occupancy across actual %s storage", async phase => {
    const definitionId = "00000000-0000-4000-8000-000000000010", unrelated = "00000000-0000-4000-8000-000000000011";
    const selected = { ...intent, originalSecretIdentities: { clientSecret: { ...intent.originalSecretIdentities.clientSecret,
      authority: { ...intent.originalSecretIdentities.clientSecret.authority, parent: { ...intent.originalSecretIdentities.clientSecret.authority.parent, companyId: company, userSecretDefinitionId: definitionId }, definition: { id: definitionId, companyId: company, ownerUserId: intent.actorUserId } } } } };
    await reopen().beginExchange(selected);
    if (phase !== "intent") await reopen().completeExchange({ ...result(), intent: selected,
      raw: phase === "raw-result" ? { status: 400, headers: {}, bodyBase64: Buffer.from("invalid original response").toString("base64") } : result().raw });
    const retained = await reopen().read();
    await expect(assertNoPendingSlackInstallForDefinition(company, definitionId)).rejects.toThrow();
    await assertNoPendingSlackInstallForDefinition(company, unrelated);
    // The original descriptor is durable, not a reference to caller-owned data.
    selected.originalSecretIdentities.clientSecret.authority.definition.id = unrelated;
    await expect(assertNoPendingSlackInstallForDefinition(company, definitionId)).rejects.toThrow();
    expect(await reopen().read()).toEqual(retained);
  });
  it("retains original intent across reopen and refuses exact or replacement replay", async () => {
    await reopen().beginExchange(intent);
    expect(await reopen().read()).toEqual(intent);
    await expect(reopen().beginExchange(intent)).rejects.toMatchObject({ code: "slack_install_recovery_pending" });
    await expect(reopen().beginExchange({ ...intent, operationId: "00000000-0000-4000-8000-000000000007" })).rejects.toThrow();
    await expect(assertNoPendingSlackInstall(company, endpoint)).rejects.toThrow();
    await expect(reopen().clear(result())).rejects.toThrow();
    await expect(assertNoPendingSlackInstallForSecret(company, secret)).rejects.toThrow();
    await assertNoPendingSlackInstallForSecret(company, "00000000-0000-4000-8000-000000000008");
  });
  it("retains original intent if result preparation fails", async () => {
    await reopen().beginExchange(intent);
    fixture.failResult = true;
    await expect(reopen().completeExchange(result())).rejects.toThrow("result encryption failure");
    expect(await reopen().read()).toEqual(intent);
  });
  it("retains exact raw result and requires exact settlement receipt", async () => {
    await reopen().beginExchange(intent);
    const retained = result();
    await reopen().completeExchange(retained);
    expect(await reopen().read()).toEqual(retained);
    await expect(reopen().clear({ ...retained, raw: { ...retained.raw, status: 400 } })).rejects.toThrow();
    await expect(reopen().completeExchange({ ...retained, intent: { ...intent, codeHash: "b".repeat(64) } })).rejects.toThrow();
    await reopen().clear(retained);
    expect(await reopen().read()).toBeNull();
    await reopen().clear(retained);
  });
  it("gates absent-file admission on repairing a failed post-settlement deletion flush", async () => {
    await reopen().beginExchange(intent);
    const receipt = result();
    await reopen().completeExchange(receipt);
    const directory = path.dirname(slackInstallRecoveryPath(company, endpoint));
    const open = fs.open.bind(fs);
    let failFlush = true;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === directory) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          if (failFlush) throw new Error("fixture deletion directory flush failure");
          await sync();
        });
      }
      return handle;
    });
    await expect(reopen().clear(receipt)).rejects.toThrow("deletion directory flush failure");
    await expect(fs.lstat(slackInstallRecoveryPath(company, endpoint))).rejects.toMatchObject({ code: "ENOENT" });
    const submit = vi.fn();
    await expect(assertNoPendingSlackInstall(company, endpoint).then(submit)).rejects.toThrow("deletion directory flush failure");
    await expect(assertNoPendingSlackInstallForSecret(company, secret)).rejects.toThrow("deletion directory flush failure");
    const next = { ...intent, operationId: "00000000-0000-4000-8000-000000000007", state: `slack-install.${"b".repeat(43)}`, codeHash: "b".repeat(64) };
    await expect(reopen().beginExchange(next)).rejects.toThrow("deletion directory flush failure");
    expect(submit).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
    failFlush = false;
    await assertNoPendingSlackInstall(company, endpoint);
    await reopen().beginExchange(next);
    expect(await reopen().read()).toEqual(next);
  });
  it("permits only exact original bot-token settlement from the retained raw response", async () => {
    const bot = "00000000-0000-4000-8000-000000000009";
    const selected = { ...intent, originalBotTokenHash: "b".repeat(64), secretIds: { ...intent.secretIds, botToken: bot }, originalSecretIdentities: { ...intent.originalSecretIdentities, botToken: { secretId: bot, versionId: bot, version: 1, authority: { parent: {}, version: {}, definition: null, providerConfig: null } } } };
    const receipt = { ...result(), intent: selected, raw: { ...result().raw,
      bodyBase64: Buffer.from(JSON.stringify({ ok: true, app_id: intent.appId, token_type: "bot", access_token: "xoxb-fixture" })).toString("base64") } };
    await reopen().beginExchange(selected);
    await reopen().completeExchange(receipt);
    await expect(assertSlackInstallSecretMutationAllowed(company, bot, "xoxb-fixture")).rejects.toThrow();
    await withSlackInstallResultSettlement(receipt, async () => {
      await assertSlackInstallSecretMutationAllowed(company, bot, "xoxb-fixture");
      await expect(assertSlackInstallSecretMutationAllowed(company, bot, "xoxb-other")).rejects.toThrow();
      await expect(assertSlackInstallSecretMutationAllowed(company, bot)).rejects.toThrow();
      await expect(assertSlackInstallSecretMutationAllowed(company, secret, "xoxb-fixture")).rejects.toThrow();
      await expect(assertNoPendingSlackInstallForSecret(company, bot)).rejects.toThrow();
    });
    const action = vi.fn(async () => {});
    await expect(withSlackInstallResultSettlement({ ...receipt, raw: { ...receipt.raw, status: 201 } }, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    expect(await reopen().read()).toEqual(receipt);
  });
  for (const exit of ["return", "throw"] as const) {
    it(`revokes inherited settlement permission after callback ${exit}`, async () => {
      const bot = "00000000-0000-4000-8000-000000000009";
      const selected = { ...intent, originalBotTokenHash: "b".repeat(64), secretIds: { botToken: bot }, originalSecretIdentities: { botToken: { secretId: bot, versionId: bot, version: 1, authority: { parent: {}, version: {}, definition: null, providerConfig: null } } } };
      const receipt = { ...result(), intent: selected, raw: { ...result().raw,
        bodyBase64: Buffer.from(JSON.stringify({ ok: true, app_id: intent.appId, token_type: "bot", access_token: "xoxb-fixture" })).toString("base64") } };
      await reopen().beginExchange(selected);
      await reopen().completeExchange(receipt);
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      let late!: Promise<void>;
      const settled = withSlackInstallResultSettlement(receipt, async () => {
        await assertSlackInstallSecretMutationAllowed(company, bot, "xoxb-fixture");
        late = wait.then(() => assertSlackInstallSecretMutationAllowed(company, bot, "xoxb-fixture"));
        if (exit === "throw") throw new Error("fixture SQL failure");
      });
      if (exit === "throw") await expect(settled).rejects.toThrow("SQL failure");
      else await settled;
      release();
      await expect(late).rejects.toThrow();
      expect(await reopen().read()).toEqual(receipt);
    });
  }
  it("retains a temporary preparation failure as uncertainty after reopen", async () => {
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("fixture rename failure"));
    await expect(reopen().beginExchange(intent)).rejects.toThrow("rename failure");
    rename.mockRestore();
    const files = await fs.readdir(path.dirname(slackInstallRecoveryPath(company, endpoint)));
    expect(files.some(name => name.endsWith(".tmp"))).toBe(true);
    await expect(reopen().read()).rejects.toThrow();
    await expect(reopen().beginExchange(intent)).rejects.toThrow();
    await expect(assertNoPendingSlackInstallForSecret(company, secret)).rejects.toThrow();
    await expect(assertNoPendingSlackInstallForDefinition(company, endpoint)).rejects.toThrow();
  });
  it("retains published intent after lost publication acknowledgement", async () => {
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => { await rename(from, to); throw new Error("fixture lost acknowledgement"); });
    await expect(reopen().beginExchange(intent)).rejects.toThrow("lost acknowledgement");
    expect(await reopen().read()).toEqual(intent);
    await expect(reopen().beginExchange(intent)).rejects.toThrow();
  });
  it("refuses enumeration disappearance after observing an existing company directory", async () => {
    const directory = path.dirname(slackInstallRecoveryPath(company, endpoint));
    await fs.mkdir(directory, { recursive: true });
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === directory) {
        await fs.rmdir(directory);
        throw Object.assign(new Error("fixture enumeration disappearance"), { code: "ENOENT" });
      }
      return readdir(...args);
    });
    await expect(assertNoPendingSlackInstallForSecret(company, secret)).rejects.toThrow("enumeration disappearance");
  });
  it("fails company secret inventory closed on unknown files", async () => {
    const directory = path.dirname(slackInstallRecoveryPath(company, endpoint));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "unknown"), "retained uncertainty");
    await expect(assertNoPendingSlackInstallForSecret(company, secret)).rejects.toThrow();
  });
});
