import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const fixture = vi.hoisted(() => ({ root: "", failEncrypt: false }));
vi.mock("../../../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => fixture.root }));
vi.mock("../../../../secrets/local-encrypted-provider.js", () => ({ localEncryptedProvider: {
  createVersion: async ({ value }: { value: string }) => { if (fixture.failEncrypt) throw new Error("fixture encrypt failed"); return { material: { fixture: Buffer.from(value).toString("base64") } }; },
  resolveVersion: async ({ material }: { material: { fixture: string } }) => Buffer.from(material.fixture, "base64").toString(),
} }));
import { setupMessageRecovery, setupMessageRecoveryPath, setupMessageHash, assertNoPendingSetupMessageForActor, assertNoPendingSetupMessageForEndpoint, assertNoPendingSetupMessageForSecret, assertNoPendingSetupMessageForDefinition, inspectPending, type SetupMessageIntent } from "./setup-message-recovery.js";
const company = "00000000-0000-4000-8000-000000000001", endpoint = "00000000-0000-4000-8000-000000000002", connection = "00000000-0000-4000-8000-000000000003", secret = "00000000-0000-4000-8000-000000000004";
const account = { status: "linked", externalUserId: "UORIGINAL", paperclipUserId: "fixture-user", welcomeStatus: "pending", verificationStatus: "pending" };
const intent: SetupMessageIntent = { schema: 1, kind: "setup-message-intent", operationId: "00000000-0000-4000-8000-000000000005", companyId: company, endpointId: endpoint,
  messageKind: "welcome", actorUserId: "fixture-user", actorSessionId: "fixture-session", originalEndpoint: { id: endpoint, companyId: company, connectionId: connection, setup: { slackAccount: account } },
  originalConnection: { id: connection, companyId: company, credentialSecretRefs: [{ configPath: "credentials.botToken", secretId: secret }] }, originalRegistration: { endpointId: endpoint, companyId: company, status: "configured" }, originalAccount: account,
  runtimeTokenIdentity: { secretId: secret, versionId: secret, version: 1, authority: { parent: { companyId: company }, version: {}, definition: null, providerConfig: null } }, tokenHash: setupMessageHash("fixture-original-token"),
  params: { channel: "UORIGINAL", text: "Fixture original welcome", unfurl_links: "false", unfurl_media: "false" }, directApiAuthority: { apiBaseUrl: "https://slack.com/api/", method: "chat.postMessage" } };
const decoded = { channel: "DFIXTURE", ts: "123.456" };
const raw = { status: 200, headers: { "x-fixture": "exact" }, bodyBase64: Buffer.from(JSON.stringify({ ok: true, ...decoded })).toString("base64") };
const reopen = () => setupMessageRecovery(company, endpoint, "welcome"), file = () => setupMessageRecoveryPath(company, endpoint, "welcome");
beforeEach(async () => { fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "setup-message-")); fixture.failEncrypt = false; });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.root, { recursive: true, force: true }); });
describe("independent original setup message outcomes", () => {
  it.each(["intent", "raw", "result", "settled"] as const)("retains exact original definition through %s without consulting mutable refs", async phase => {
    const definitionId = "00000000-0000-4000-8000-000000000010", unrelated = "00000000-0000-4000-8000-000000000011";
    const selected = { ...intent, runtimeTokenIdentity: { ...intent.runtimeTokenIdentity, authority: { ...intent.runtimeTokenIdentity.authority, parent: { ...intent.runtimeTokenIdentity.authority.parent, userSecretDefinitionId: definitionId },
      definition: { id: definitionId, companyId: company, ownerUserId: intent.actorUserId } } } };
    await reopen().begin(selected);
    if (phase !== "intent") await reopen().recordRaw({ intent: selected, raw });
    if (phase === "result" || phase === "settled") {
      const result = await reopen().recordResult({ intent: selected, raw, decoded });
      if (phase === "settled") await reopen().recordSettlementReturned(result);
    }
    const retained = await reopen().read();
    await assertNoPendingSetupMessageForDefinition(company, unrelated);
    if (phase === "settled") await assertNoPendingSetupMessageForDefinition(company, definitionId);
    else await expect(assertNoPendingSetupMessageForDefinition(company, definitionId)).rejects.toThrow();
    selected.runtimeTokenIdentity.authority.definition.id = unrelated;
    if (phase !== "settled") await expect(assertNoPendingSetupMessageForDefinition(company, definitionId)).rejects.toThrow();
    expect(await reopen().read()).toEqual(retained);
  });
  it("retains intent before any raw effect and refuses all provider replay", async () => {
    expect(await inspectPending()).toBe("none"); await reopen().begin(intent); expect(await reopen().read()).toEqual(intent);
    await expect(reopen().begin(intent)).rejects.toThrow(); await expect(reopen().begin({ ...intent, operationId: endpoint })).rejects.toThrow();
    await expect(assertNoPendingSetupMessageForActor(company, intent.actorUserId)).rejects.toThrow();
    await expect(assertNoPendingSetupMessageForEndpoint(company, endpoint)).rejects.toThrow();
    await expect(assertNoPendingSetupMessageForSecret(company, secret)).rejects.toThrow(); expect(await inspectPending()).toBe("present");
  });
  it("requires exact raw result then originating SQL acknowledgement and retains settled receipt forever", async () => {
    await reopen().begin(intent); await expect(reopen().recordResult({ intent, raw, decoded })).rejects.toThrow();
    await reopen().recordRaw({ intent, raw }); const result = await reopen().recordResult({ intent, raw, decoded });
    expect(await inspectPending()).toBe("present"); const settled = await reopen().recordSettlementReturned(result);
    expect(settled.kind).toBe("setup-message-settled"); expect(await reopen().read()).toEqual(settled);
    await assertNoPendingSetupMessageForActor(company, intent.actorUserId); await assertNoPendingSetupMessageForEndpoint(company, endpoint); await assertNoPendingSetupMessageForSecret(company, secret);
    expect(await inspectPending()).toBe("none"); await expect(reopen().begin(intent)).rejects.toThrow();
    expect(await reopen().recordSettlementReturned(result)).toEqual(settled);
    await expect(reopen().recordResult({ intent, raw, decoded })).rejects.toThrow();
    expect(await fs.readFile(file(), "utf8")).not.toContain("fixture-original-token");
  });
  it.each(["channel", "timestamp", "http", "invalid-json"] as const)("retains full raw %s uncertainty when exact decoded result is invalid", async failure => {
    const response = failure === "http" ? { ...raw, status: 500 } : failure === "invalid-json" ? { ...raw, bodyBase64: Buffer.from([255, 0, 128]).toString("base64") } : raw;
    const output = failure === "channel" ? { ...decoded, channel: "DOTHER" } : failure === "timestamp" ? { ...decoded, ts: "bad" } : decoded;
    await reopen().begin(intent); await reopen().recordRaw({ intent, raw: response });
    await expect(reopen().recordResult({ intent, raw: response, decoded: output })).rejects.toThrow();
    expect(await reopen().read()).toEqual({ schema: 1, kind: "setup-message-raw", intent, raw: response });
    await expect(reopen().begin(intent)).rejects.toThrow();
  });
  it("refuses a result DM channel different from the original known destination", async () => {
    const originalAccount = { ...account, dmChannelId: "DKNOWN" };
    const original = { ...intent, originalAccount, originalEndpoint: { ...intent.originalEndpoint, setup: { slackAccount: originalAccount } }, params: { ...intent.params, channel: "DKNOWN" } };
    await reopen().begin(original); await reopen().recordRaw({ intent: original, raw });
    await expect(reopen().recordResult({ intent: original, raw, decoded })).rejects.toThrow();
  });
  it("refuses old status backfill, route substitution and changed original operation", async () => {
    const originalAccount = { ...account, welcomeStatus: "sent" };
    await expect(reopen().begin({ ...intent, originalAccount, originalEndpoint: { ...intent.originalEndpoint, setup: { slackAccount: originalAccount } } })).rejects.toThrow();
    await expect(reopen().begin({ ...intent, params: { ...intent.params, channel: "UOTHER" } })).rejects.toThrow();
    await reopen().begin(intent); await expect(reopen().recordRaw({ intent: { ...intent, operationId: endpoint }, raw })).rejects.toThrow();
  });
  it.each(["secret", "company", "selector", "duplicate-ref"] as const)("refuses mismatched actual runtime credential %s authority", async change => {
    const ref = { configPath: "credentials.botToken", secretId: change === "secret" ? endpoint : secret,
      ...(change === "selector" ? { versionSelector: 1 } : {}) };
    const original = { ...intent, originalConnection: { ...intent.originalConnection, credentialSecretRefs: change === "duplicate-ref" ? [ref, ref] : [ref] },
      runtimeTokenIdentity: change === "company" ? { ...intent.runtimeTokenIdentity, authority: { ...intent.runtimeTokenIdentity.authority, parent: { companyId: endpoint } } } : intent.runtimeTokenIdentity };
    await expect(reopen().begin(original)).rejects.toThrow(); expect(await reopen().read()).toBeNull();
  });

  it("retains exact result if settlement acknowledgement publication fails", async () => {
    await reopen().begin(intent); await reopen().recordRaw({ intent, raw }); const result = await reopen().recordResult({ intent, raw, decoded }); fixture.failEncrypt = true;
    await expect(reopen().recordSettlementReturned(result)).rejects.toThrow("encrypt failed");
    expect(await reopen().read()).toEqual(result); expect(await inspectPending()).toBe("present"); await expect(reopen().begin(intent)).rejects.toThrow();
  });
  it("keeps welcome and verification as independent original intents", async () => {
    await reopen().begin(intent);
    const verification = { ...intent, operationId: endpoint, messageKind: "verification" as const, params: { ...intent.params, text: "Fixture original verification" } };
    const other = setupMessageRecovery(company, endpoint, "verification"); await other.begin(verification);
    expect(await reopen().read()).toEqual(intent); expect(await other.read()).toEqual(verification);
  });
  it.each(["symlink", "hardlink", "directory"] as const)("classifies static %s aliases as unknown even for settled receipts", async alias => {
    await reopen().begin(intent); await reopen().recordRaw({ intent, raw }); await reopen().recordSettlementReturned(await reopen().recordResult({ intent, raw, decoded }));
    const outside = path.join(fixture.root, "outside"); await fs.rename(file(), outside);
    if (alias === "symlink") await fs.symlink(outside, file()); else if (alias === "hardlink") await fs.link(outside, file()); else await fs.mkdir(file());
    expect(await inspectPending()).toBe("unknown"); await expect(assertNoPendingSetupMessageForActor(company, "unrelated")).rejects.toThrow();
  });
  it("classifies temporary occupancy and observed disappearance as unknown", async () => {
    await reopen().begin(intent); await fs.writeFile(`${file()}.tmp`, "fixture"); expect(await inspectPending()).toBe("unknown"); await expect(assertNoPendingSetupMessageForDefinition(company, endpoint)).rejects.toThrow(); await fs.rm(`${file()}.tmp`);
    const realRead = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === path.dirname(file())) await fs.rm(path.dirname(file()), { recursive: true, force: true });
      return realRead(...args);
    });
    expect(await inspectPending()).toBe("unknown");
  });
  it("preserves causal file sync and close errors and refuses temporary uncertainty", async () => {
    const realOpen = fs.open.bind(fs), first = new Error("fixture sync"), second = new Error("fixture close");
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args); if (String(args[0]).endsWith(".tmp")) {
        const close = handle.close.bind(handle); handle.sync = async () => { throw first; }; handle.close = async () => { await close(); throw second; };
      } return handle;
    });
    expect((await reopen().begin(intent).catch(error => error)).errors).toEqual([first, second]);
    expect(await inspectPending()).toBe("unknown"); await expect(reopen().read()).rejects.toThrow();
  });
});
