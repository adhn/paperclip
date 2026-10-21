import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ hold: "", scoped: false, locks: [] as string[] }));
const checks = vi.hoisted(() => ({ guard: (family: string) => { if (state.hold === family) throw new Error(`fixture retained ${family}`); } }));
vi.mock("./install-recovery.js", () => ({ assertNoPendingSlackInstall: async () => checks.guard("customer") }));
vi.mock("./manager-claim-recovery.js", () => ({ assertNoPendingManagerClaimForEndpoint: async () => checks.guard("claim"), assertNoPendingManagerClaimForActor: async () => checks.guard("claim"), assertNoPendingManagerClaimForCompany: async () => checks.guard("claim") }));
vi.mock("./manager-refresh-recovery.js", () => ({ assertNoPendingManagerRefreshForActor: async () => checks.guard("refresh"), assertNoPendingManagerRefreshForCompany: async () => checks.guard("refresh") }));
vi.mock("./manager-revoke-recovery.js", () => ({ assertNoPendingManagerRevokeForActor: async () => checks.guard("revoke"), assertNoPendingManagerRevokeForCompany: async () => checks.guard("revoke") }));
vi.mock("./managed-install-recovery.js", () => ({ assertNoPendingManagedInstallForEndpoint: async () => checks.guard("managed"), assertManagedInstallCompletionAllowed: async () => { if (!state.scoped) checks.guard("managed"); } }));
vi.mock("./staged-cleanup-recovery.js", () => ({ assertNoPendingStagedCleanupForEndpoint: async () => checks.guard("staged") }));
vi.mock("./registration-cleanup-recovery.js", () => ({ assertNoPendingRegistrationCleanupForEndpoint: async () => checks.guard("cleanup") }));
vi.mock("./setup-message-recovery.js", () => ({ assertNoPendingSetupMessageForEndpoint: async () => checks.guard("message") }));
vi.mock("@paperclipai/adapter-codex-local/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("@paperclipai/adapter-codex-local/server")>()), withAccountHomeSecretMutationLock: async (_env: unknown, _company: string, action: () => unknown) => { state.locks.push("company"); return action(); } }));
import { assertSlackSetupNewUse, assertSlackSetupConfigurationUse } from "./new-use-guard.js";
import { createCustomerOwnedSetup } from "./customer-owned.js";
import type { SlackRegistrationStore } from "./registration.js";
const company = "00000000-0000-4000-8000-000000000001", endpoint = "00000000-0000-4000-8000-000000000002";
const actor = { userId: "fixture-user", sessionId: "fixture-session", bypassPermissionCheck: true };
function fixture(method: "automatic" | "managed" = "automatic") {
  const row = { endpointId: endpoint, companyId: company, appId: "A123", requestId: endpoint, managerGrantId: method === "managed" ? endpoint : null, status: "install", errorCode: "slack_manifest_update_pending", manifest: {}, secretIds: {} };
  const api = vi.fn(async (_method: string, ..._args: unknown[]) => ({ ok: true })), renderAvatar = vi.fn(async () => Buffer.from("fixture image"));
  const saveAvatar = vi.fn(async () => {}), audit = vi.fn(async () => {}), update = vi.fn(() => ({ set: () => ({ where: async () => {} }) }));
  const store = { db: { update }, api, renderAvatar, saveAvatar, audit, registration: async () => row, assertOrigins: () => {},
    endpoint: async () => ({ endpoint: { id: endpoint, companyId: company, status: "draft", assignedAgentId: endpoint, setup: { slackSetupMethod: method } }, agentAppearance: {}, agentName: "Fixture" }),
    options: { withLock: async (_id: string, work: (lease: { assertOwned(): Promise<void> }) => Promise<unknown>) => { state.locks.push("endpoint"); return work({ assertOwned: async () => {} }); } },
  } as unknown as SlackRegistrationStore;
  return { row, api, renderAvatar, saveAvatar, audit, update, setup: createCustomerOwnedSetup(store) };
}
beforeEach(() => { state.hold = ""; state.scoped = false; state.locks = []; });
describe("actual automatic setup pre-effect exclusion", () => {
  it.each(["message", "cleanup", "claim", "revoke", "refresh", "staged", "customer", "managed"])("refuses retained %s before actual app update or avatar work", async family => {
    const f = fixture(); state.hold = family;
    await expect(f.setup.create(endpoint, actor, { requestId: endpoint, credentials: { configurationToken: "fixture token" } } as never)).rejects.toThrow(`retained ${family}`);
    expect(f.api).not.toHaveBeenCalled(); expect(f.renderAvatar).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.saveAvatar).not.toHaveBeenCalled();
    expect(state.locks.slice(0, 2)).toEqual(["endpoint", "company"]);
  });
  it("permits admitted automatic manifest and avatar effects with no held original family", async () => {
    const f = fixture(); await f.setup.create(endpoint, actor, { requestId: endpoint, credentials: { configurationToken: "fixture token" } } as never);
    expect(f.api.mock.calls.map(call => call[0])).toEqual(["apps.manifest.update", "apps.icon.set"]);
    expect(f.renderAvatar).toHaveBeenCalledOnce();
  });
  it("permits managed app preparation before any managed-install parent intent exists", async () => {
    const f = fixture("managed");
    await f.setup.create(endpoint, actor, { requestId: endpoint, credentials: { configurationToken: "fixture token" } } as never,
      { grantId: endpoint, workspaceId: "TFIXTURE", request: f.api as never });
    expect(f.api.mock.calls.map(call => call[0])).toEqual(["apps.manifest.update", "apps.icon.set"]);
  });
  it("rechecks after avatar render before actual icon submission", async () => {
    const f = fixture(); f.renderAvatar.mockImplementationOnce(async () => { state.hold = "message"; return Buffer.from("fixture image"); });
    await f.setup.create(endpoint, actor, { requestId: endpoint, credentials: { configurationToken: "fixture token" } } as never);
    expect(f.api.mock.calls.map(call => call[0])).toEqual(["apps.manifest.update"]);
  });
  it("allows exact managed completion capability only on configuration entry, never new operations", async () => {
    state.hold = "managed"; state.scoped = true;
    const input = { companyId: company, endpointId: endpoint, actorUserId: actor.userId };
    await assertSlackSetupConfigurationUse(input); await expect(assertSlackSetupNewUse(input)).rejects.toThrow("retained managed");
    state.hold = "message"; await expect(assertSlackSetupConfigurationUse(input)).rejects.toThrow("retained message");
  });
  it.each(["claim", "refresh", "revoke"])("cannot omit actor identity to bypass company %s occupancy", async family => {
    state.hold = family; await expect(assertSlackSetupNewUse({ companyId: company, endpointId: endpoint })).rejects.toThrow(`retained ${family}`);
  });
});
