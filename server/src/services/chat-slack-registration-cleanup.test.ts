import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatEndpoints, chatSlackRegistrations, toolOauthStates, type Db } from "@paperclipai/db";

const effects = vi.hoisted(() => ({ guard: vi.fn(), claimGuard: vi.fn(), remove: vi.fn() }));
vi.mock("./connectors/slack/setup/manager-claim-recovery.js", () => ({ assertNoPendingManagerClaimForEndpoint: effects.claimGuard }));
vi.mock("./connectors/slack/setup/install-recovery.js", () => ({ assertNoPendingSlackInstall: effects.guard }));
vi.mock("./secrets.js", () => ({ secretService: () => ({ remove: effects.remove }) }));
import { removeSlackRegistration } from "./chat-slack-registration-cleanup.js";

function fixture(hasRegistration = true) {
  const calls: string[] = [];
  const row = { companyId: "00000000-0000-4000-8000-000000000101", endpointId: "00000000-0000-4000-8000-000000000102", secretIds: { bot: "original-secret" } };
  const endpoint = { companyId: "00000000-0000-4000-8000-000000000101", connectionId: "original-connection" };
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: async () => table === chatSlackRegistrations ? (hasRegistration ? [row] : []) : [endpoint] }) }),
    delete: vi.fn((table: unknown) => ({ where: async () => { expect(table).toBe(toolOauthStates); calls.push("oauth-delete"); } })),
    update: vi.fn((table: unknown) => ({ set: (value: Record<string, unknown>) => ({ where: async () => { expect(table).toBe(chatSlackRegistrations); calls.push("secretIds" in value ? "erase-secret-ids" : "mark-removed"); } }) })),
  };
  const lease = { assertOwned: vi.fn(async () => {}) };
  effects.remove.mockImplementation(async (id: string) => { expect(id).toBe("original-secret"); calls.push("secret-remove"); });
  effects.guard.mockImplementation(async () => { calls.push("journal-guard"); });
  effects.claimGuard.mockImplementation(async () => { calls.push("claim-journal-guard"); });
  return { db, lease, calls };
}
beforeEach(() => { vi.resetAllMocks(); });
describe("Slack registration retained install ownership", () => {
  it.each([true, false])("guards all cleanup before mutation with registration present=%s", async registered => {
    const { db, lease, calls } = fixture(registered);
    effects.guard.mockRejectedValue(new Error("pending original exchange"));
    await expect(removeSlackRegistration(db as unknown as Db, "00000000-0000-4000-8000-000000000102", lease)).rejects.toMatchObject({ status: 409 });
    expect(effects.guard).toHaveBeenCalledExactlyOnceWith("00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102");
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(effects.remove).not.toHaveBeenCalled();
    expect(calls).toEqual(["claim-journal-guard"]);
  });
  it.each([true, false])("claim uncertainty refuses cleanup before install guard or mutation with registration present=%s", async registered => {
    const { db, lease, calls } = fixture(registered);
    effects.claimGuard.mockRejectedValue(new Error("pending original manager claim"));
    await expect(removeSlackRegistration(db as unknown as Db, "00000000-0000-4000-8000-000000000102", lease)).rejects.toMatchObject({ status: 409 });
    expect(effects.claimGuard).toHaveBeenCalledExactlyOnceWith("00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102");
    expect(effects.guard).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled(); expect(effects.remove).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it("cleared recovery permits exact original cleanup on retry", async () => {
    const { db, lease, calls } = fixture();
    effects.guard.mockRejectedValueOnce(new Error("retained journal"));
    await expect(removeSlackRegistration(db as unknown as Db, "00000000-0000-4000-8000-000000000102", lease)).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual(["claim-journal-guard"]);
    await removeSlackRegistration(db as unknown as Db, "00000000-0000-4000-8000-000000000102", lease);
    expect(calls).toEqual(["claim-journal-guard", "claim-journal-guard", "journal-guard", "oauth-delete", "mark-removed", "oauth-delete", "secret-remove", "erase-secret-ids"]);
    expect(effects.guard).toHaveBeenNthCalledWith(2, "00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102");
    expect(effects.remove).toHaveBeenCalledExactlyOnceWith("original-secret");
    expect(db.delete).toHaveBeenCalledTimes(2);
    expect(db.update).toHaveBeenCalledTimes(2);
  });
});
