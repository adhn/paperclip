import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), authority: vi.fn(), beforeLock: undefined as (() => void) | undefined, locked: false, leaseOwned: false, order: [] as string[] }));
vi.mock("@paperclipai/adapter-codex-local/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("@paperclipai/adapter-codex-local/server")>()), withAccountHomeSecretMutationLock: async (_home: unknown, _company: string, action: () => Promise<unknown>) => {
  mocks.order.push("company-lock"); mocks.beforeLock?.(); mocks.locked = true;
  try { return await action(); } finally { mocks.locked = false; }
} }));
vi.mock("../connectors/slack/setup/new-use-guard.js", () => ({ assertSlackSetupConfigurationUse: mocks.guard }));
vi.mock("./slack-credential-authority.js", () => ({ readSlackCredentialAuthority: mocks.authority }));
vi.mock("./imessage-photon/setup.js", () => ({ preparePhotonConfiguration: vi.fn(), createPhotonConfiguration: () => ({}) }));
vi.mock("./telegram/setup.js", () => ({ createTelegramSetup: () => ({}) }));
vi.mock("./github/setup.js", () => ({ createGitHubSetup: () => ({}) }));
vi.mock("./speko/setup.js", () => ({ createSpekoSetup: () => ({}) }));
import { createChatConfiguration } from "./configuration.js";
const companyId = "00000000-0000-4000-8000-000000000001", endpointId = "00000000-0000-4000-8000-000000000002";
function fixture(action: "configure" | "reconnect" | "resume" | "verify", provider = "slack") {
  const endpoint = { id: endpointId, companyId, connectionId: "connection", provider,
    status: action === "resume" ? "paused" : action === "verify" ? "verifying" : action === "reconnect" ? "active" : "draft",
    setup: { step: action === "resume" ? "complete" : "provider_setup", webhookVerifiedAt: new Date().toISOString() }, botExternalId: "original-bot" };
  const record = { endpoint, connection: { id: "connection", status: "active" }, credentialSecretRefs: [{ secretId: "original-secret", versionSelector: "latest" }] };
  let version = 1;
  mocks.authority.mockImplementation(async () => structuredClone({ refs: record.credentialSecretRefs, identities: [{ secretId: record.credentialSecretRefs[0].secretId, version }] }));
  const checkpoint = new Error("provider inventory checkpoint");
  const verifyCredentials = vi.fn(async () => { if (provider === "slack") expect(mocks.locked).toBe(true); mocks.order.push("verify"); return { botExternalId: "original-bot" }; });
  const prepareProviderInventory = vi.fn(async () => { if (provider === "slack") expect(mocks.locked).toBe(true); mocks.order.push("inventory"); throw checkpoint; });
  const lease = { assertOwned: vi.fn(async () => { mocks.order.push("lease-check"); mocks.leaseOwned = true; }) };
  const options = {
    endpointRecord: vi.fn(async () => record), get: vi.fn(),
    withCredentialMutationLease: async (_endpoint: unknown, action: (guard: typeof lease) => Promise<unknown>) => { mocks.order.push("credential-lease"); return action(lease); },
    resolveCredentials: vi.fn(async () => ({ botToken: "fixture", signingSecret: "fixture" })), normalizedCredentials: vi.fn(),
    verifyCredentials, prepareProviderInventory, nativeBotIdentityMatches: vi.fn(() => true), assertNativeBotIdentityAvailable: vi.fn(),
    getWebhookPublicBaseUrl: () => "https://fixture.invalid", SUPPLIED_CREDENTIAL_KEYS: { slack: ["botToken", "signingSecret"] }, PROVIDER_LABELS: { slack: "Slack", github: "GitHub" },
  } as unknown as Parameters<typeof createChatConfiguration>[1];
  return { record, setVersion: (next: number) => { version = next; }, service: createChatConfiguration({} as Db, options), options, lease, verifyCredentials, prepareProviderInventory, checkpoint };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.locked = false; mocks.leaseOwned = false; mocks.order = []; mocks.beforeLock = undefined;
  mocks.guard.mockImplementation(async () => { expect(mocks.locked).toBe(true); expect(mocks.leaseOwned).toBe(true); mocks.order.push("recovery-guard"); });
});
describe("manual Slack configuration original recovery admission", () => {
  it.each([
    ["configure", "message"], ["reconnect", "registration-cleanup"], ["resume", "manager-claim"], ["verify", "customer-install"],
  ] as const)("refuses %s with retained %s before provider probes", async (action, family) => {
    const f = fixture(action), pending = new Error(`${family} original recovery pending`);
    mocks.guard.mockRejectedValue(pending);
    await expect(f.service.configure(endpointId, { action }, "installer")).rejects.toBe(pending);
    expect(f.verifyCredentials).not.toHaveBeenCalled(); expect(f.prepareProviderInventory).not.toHaveBeenCalled();
    expect(mocks.guard).toHaveBeenCalledWith({ companyId, endpointId, actorUserId: "installer" });
    expect(mocks.order.slice(0, 2)).toEqual(["credential-lease", "company-lock"]);
  });
  it("rechecks recovery after credential verification before provider inventory", async () => {
    const f = fixture("configure"), pending = new Error("new original recovery hold");
    mocks.guard.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(pending);
    await expect(f.service.configure(endpointId, { action: "configure" }, "installer")).rejects.toBe(pending);
    expect(f.verifyCredentials).toHaveBeenCalledOnce(); expect(f.prepareProviderInventory).not.toHaveBeenCalled();
    expect(mocks.guard).toHaveBeenCalledTimes(3);
  });
  it("permits only the shared guard's active exact originating completion to reach its provider checkpoint", async () => {
    const f = fixture("configure");
    // Shared guard's own tests prove the real journal capability. This isolated
    // boundary case verifies its allowed result reaches actual configuration.
    await expect(f.service.configureWithCredentialLease(endpointId, { action: "configure" }, f.lease, "installer")).rejects.toBe(f.checkpoint);
    expect(f.verifyCredentials).toHaveBeenCalledOnce(); expect(f.prepareProviderInventory).toHaveBeenCalledOnce();
    expect(mocks.order).toEqual(["company-lock", "lease-check", "recovery-guard", "company-lock", "lease-check", "recovery-guard", "verify", "company-lock", "lease-check", "recovery-guard", "inventory"]);
  });
  it("passes missing actor explicitly for strict company-wide recovery occupancy", async () => {
    const f = fixture("configure"), pending = new Error("company manager hold"); mocks.guard.mockRejectedValueOnce(pending);
    await expect(f.service.configure(endpointId, { action: "configure" })).rejects.toBe(pending);
    expect(mocks.guard).toHaveBeenCalledWith({ companyId, endpointId, actorUserId: undefined });
    expect(f.verifyCredentials).not.toHaveBeenCalled();
  });
  it("leaves other-provider credential verification outside the Slack guard and company lock", async () => {
    const f = fixture("configure", "discord");
    await expect(f.service.configure(endpointId, { action: "configure" }, "installer")).rejects.toBe(f.checkpoint);
    expect(mocks.guard).not.toHaveBeenCalled(); expect(mocks.order).not.toContain("company-lock");
    expect(f.verifyCredentials).toHaveBeenCalledOnce(); expect(f.prepareProviderInventory).toHaveBeenCalledOnce();
  });

  it.each(["version", "reference", "control"] as const)("refuses changed stored %s after verify before inventory", async (change) => {
    const f = fixture("configure");
    f.verifyCredentials.mockImplementationOnce(async () => {
      if (change === "version") f.setVersion(2);
      if (change === "reference") f.record.credentialSecretRefs[0].secretId = "replacement-secret";
      if (change === "control") f.record.endpoint.botExternalId = "replacement-bot";
      return { botExternalId: "original-bot" };
    });
    await expect(f.service.configure(endpointId, { action: "configure" }, "installer")).rejects.toThrow(/Slack .* (authority|ownership) changed/);
    expect(f.verifyCredentials).toHaveBeenCalledOnce();
    expect(f.prepareProviderInventory).not.toHaveBeenCalled();
  });
  it("captures the current version under lock before resolving and never dispatches old plaintext", async () => {
    const f = fixture("configure");
    mocks.beforeLock = () => { f.setVersion(2); mocks.beforeLock = undefined; };
    const resolve = f.options.resolveCredentials as ReturnType<typeof vi.fn>;
    resolve.mockImplementationOnce(async () => {
      expect(mocks.locked).toBe(true);
      return { botToken: "current-token", signingSecret: "current-signing" };
    });
    await expect(f.service.configure(endpointId, { action: "configure" }, "installer")).rejects.toBe(f.checkpoint);
    expect(f.verifyCredentials).toHaveBeenCalledWith("slack", { botToken: "current-token", signingSecret: "current-signing" });
    expect(f.prepareProviderInventory).toHaveBeenCalledOnce();
  });
  it("refuses a version change during resolution before the first provider dispatch", async () => {
    const f = fixture("resume");
    (f.options.resolveCredentials as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      f.setVersion(2);
      return { botToken: "old-token", signingSecret: "old-signing" };
    });
    await expect(f.service.configure(endpointId, { action: "resume" }, "installer")).rejects.toThrow("Slack stored credential authority changed");
    expect(f.verifyCredentials).not.toHaveBeenCalled();
    expect(f.prepareProviderInventory).not.toHaveBeenCalled();
  });

  it("binds stored partial reconnect fields while preserving the supplied original token", async () => {
    const f = fixture("reconnect");
    (f.options.normalizedCredentials as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_endpoint, supplied) => {
      expect(mocks.locked).toBe(true);
      return { botToken: supplied.botToken, signingSecret: "stored-signing" };
    });
    f.verifyCredentials.mockImplementationOnce(async () => {
      f.setVersion(2);
      return { botExternalId: "original-bot" };
    });
    await expect(f.service.configure(endpointId, { action: "reconnect", credentials: { botToken: "original-supplied-token" } }, "installer")).rejects.toThrow("Slack stored credential authority changed");
    expect(f.verifyCredentials).toHaveBeenCalledWith("slack", { botToken: "original-supplied-token", signingSecret: "stored-signing" });
    expect(f.prepareProviderInventory).not.toHaveBeenCalled();
  });

});
