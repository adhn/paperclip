import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), remove: vi.fn() }));
vi.mock("./install-recovery.js", () => ({ assertNoPendingSlackInstall: mocks.guard }));
vi.mock("../../../secrets.js", () => ({ secretService: () => ({ remove: mocks.remove }) }));
vi.mock("../../../../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
import { createSlackCompletion } from "./completion.js";
import type { SlackRegistrationStore, SlackSetupActor } from "./registration.js";

function fixture(status: "credentials_saved" | "configured") {
  const row = { companyId: "00000000-0000-4000-8000-000000000101", endpointId: "00000000-0000-4000-8000-000000000102", status, secretIds: { botToken: "original-token", signingSecret: "original-signing" }, workspaceId: "T1", botUserId: "U1", requestId: "original-request" };
  const select = vi.fn(() => ({ from: () => ({ where: async () => [] }) }));
  const db = { select, update: vi.fn(), transaction: vi.fn() };
  const options = {
    runtimeBotToken: vi.fn(), runtimeSigningSecret: vi.fn(), configure: vi.fn(async () => { throw new Error("configure checkpoint"); }),
    linkInstaller: vi.fn(), canWelcome: vi.fn(),
    withLock: vi.fn(async (_id: string, action: (lease: unknown) => Promise<unknown>) => action(lease)),
  };
  const lease = { assertOwned: vi.fn(async () => {}) };
  const store = {
    db, options, endpoint: vi.fn(async () => ({ endpoint: { publicId: "original-public", setup: {} } })),
    registration: vi.fn(async () => row), assertOrigins: vi.fn(),
    api: vi.fn(async () => ({ team_id: "T1", user_id: "U1" })),
    readSecret: vi.fn(async () => "fixture-only"), audit: vi.fn(), setFailure: vi.fn(),
  };
  return { completion: createSlackCompletion(store as unknown as SlackRegistrationStore), store, row, lease, select };
}
const actor = { userId: "installer", sessionId: null, bypassPermissionCheck: false } as SlackSetupActor;
beforeEach(() => { vi.resetAllMocks(); });
function noEffects(f: ReturnType<typeof fixture>) {
  expect(f.store.api).not.toHaveBeenCalled();
  expect(f.store.readSecret).not.toHaveBeenCalled();
  expect(f.store.options.configure).not.toHaveBeenCalled();
  expect(f.store.options.runtimeBotToken).not.toHaveBeenCalled();
  expect(f.store.options.runtimeSigningSecret).not.toHaveBeenCalled();
  expect(f.store.options.linkInstaller).not.toHaveBeenCalled();
  expect(f.store.db.update).not.toHaveBeenCalled();
  expect(f.store.db.transaction).not.toHaveBeenCalled();
  expect(f.store.setFailure).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
}
describe("Slack completion retained original installation recovery gate", () => {
  it.each(["intent", "result"])("refuses resume before all credential/provider/cleanup effects for retained %s", async kind => {
    const f = fixture("credentials_saved");
    const pending = new Error(`retained ${kind}`);
    mocks.guard.mockRejectedValueOnce(pending);
    await expect(f.completion.resumeLocked("00000000-0000-4000-8000-000000000102", actor, f.lease)).rejects.toBe(pending);
    expect(mocks.guard).toHaveBeenCalledExactlyOnceWith("00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102");
    noEffects(f);
    expect(f.row.status).toBe("credentials_saved");
    mocks.guard.mockResolvedValue(undefined);
    await f.completion.resumeLocked("00000000-0000-4000-8000-000000000102", actor, f.lease);
    expect(f.store.api).toHaveBeenCalledExactlyOnceWith("auth.test", {}, "fixture-only", undefined);
    expect(f.store.options.configure).toHaveBeenCalledOnce();
    expect(f.store.setFailure).toHaveBeenCalledOnce();
  });
  it("guards configured resume before staged-secret cleanup", async () => {
    const f = fixture("configured");
    mocks.guard.mockRejectedValue(new Error("retained result"));
    await expect(f.completion.resumeLocked("00000000-0000-4000-8000-000000000102", actor, f.lease)).rejects.toThrow("retained result");
    noEffects(f);
    expect(f.row.status).toBe("configured");
  });
  it("guards direct verification before provider use and reaches endpoint read only after clearance", async () => {
    const f = fixture("configured");
    mocks.guard.mockRejectedValueOnce(new Error("retained result"));
    await expect(f.completion.notifyVerified("00000000-0000-4000-8000-000000000102")).rejects.toThrow("retained result");
    noEffects(f);
    expect(f.select).not.toHaveBeenCalled();
    mocks.guard.mockResolvedValue(undefined);
    await f.completion.notifyVerified("00000000-0000-4000-8000-000000000102");
    expect(f.select).toHaveBeenCalledOnce();
    expect(mocks.guard).toHaveBeenNthCalledWith(2, "00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102");
    expect(f.row.status).toBe("configured");
  });
  it("background verification cannot bypass the same retained-install gate", async () => {
    const f = fixture("configured");
    f.select.mockImplementationOnce(() => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [{ endpointId: "00000000-0000-4000-8000-000000000102" }] }) }) }) }) as never);
    mocks.guard.mockRejectedValue(new Error("retained intent"));
    await f.completion.processPendingVerificationMessages();
    expect(mocks.guard).toHaveBeenCalledExactlyOnceWith("00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102");
    expect(f.select).toHaveBeenCalledOnce();
    noEffects(f);
    expect(f.row.status).toBe("configured");
  });
});
