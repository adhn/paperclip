import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { refreshCompanySubscriptions, refreshSubscriptionConnection } from "../services/subscription-refresh.js";
import type { SubscriptionConnection } from "../services/subscriptions.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const mocks = vi.hoisted(() => ({ select: vi.fn(), accounts: vi.fn(), credential: vi.fn(), runtimeCredential: vi.fn(), register: vi.fn(), probe: vi.fn() }));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ select: mocks.select, subscriptionAccounts: mocks.accounts, credential: mocks.credential, runtimeCredential: mocks.runtimeCredential }) }));
vi.mock("../services/subscriptions.js", () => ({ subscriptionService: () => ({ register: mocks.register }) }));
vi.mock("../services/subscription-identity.js", () => ({ probeSubscriptionIdentity: mocks.probe }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function database() {
  return {
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "claimed" }] }) }) }),
    select: () => ({ from: () => ({ where: async () => [{ credentialKey: "fixture-key" }] }) }),
  } as unknown as Db;
}
const input = (id: string): SubscriptionConnection => ({ companyId: id, connectionId: id, grantId: id, provider: "openai", name: id, ownerUserId: "alice", credential: "fixture" });

const context = { kind: "user", userId: "alice" } as const;
const row = (companyId: string, id = companyId) => ({ summary: { status: "connected", provider: "openai" },
  connection: { id, companyId, name: id, config: { ai: { provider: "openai", method: "subscription" } } },
  grant: { id, companyId, connectionId: id, kind: "user", status: "active", subjectUserId: "alice" } });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.accounts.mockImplementation(async companyId => [row(companyId)]);
  mocks.runtimeCredential.mockResolvedValue("fresh-authorized-credential");
  mocks.register.mockImplementation(async (connection: SubscriptionConnection) => connection.grantId);
});

describe("subscription discovery capacity", () => {
  it.each(["intent", "result"])("does not register or probe a credential held by pending exchange %s", async (kind) => {
    const db = database();
    mocks.accounts.mockResolvedValue([row(`pending-company-${kind}`, `pending-${kind}`)]);
    mocks.credential.mockResolvedValue("consumed-predecessor");
    mocks.runtimeCredential.mockRejectedValueOnce(new Error(`quota exchange ${kind} requires inspection`));
    const before = idleWorkSnapshot();
    await refreshCompanySubscriptions(db, `pending-company-${kind}`, "alice");
    expect(mocks.runtimeCredential).toHaveBeenCalledOnce();
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(before.active);
  });

  it("tracks detached provider refresh through its final database write", async () => {
    const db = database(), probe = deferred<{ credentialKey: string }>(), save = deferred<string>();
    const before = idleWorkSnapshot();
    mocks.probe.mockReturnValue(probe.promise);
    mocks.register.mockReturnValue(save.promise);
    const task = refreshSubscriptionConnection(db, input("tracked"), "tracked", fetch, context);
    try {
      await vi.waitFor(() => expect(mocks.probe).toHaveBeenCalledOnce());
      expect(mocks.runtimeCredential).toHaveBeenCalledWith(expect.objectContaining({ connection: expect.objectContaining({ id: "tracked" }) }), context);
      expect(mocks.probe).toHaveBeenCalledWith("tracked", "openai", "fresh-authorized-credential", fetch);
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
      expect(refreshSubscriptionConnection(db, input("tracked"), "tracked", fetch, context)).toBe(task);
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
      probe.resolve({ credentialKey: "fixture-key" });
      await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledOnce());
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
    } finally {
      probe.resolve({ credentialKey: "fixture-key" }); save.resolve("tracked"); await task;
    }
    expect(idleWorkSnapshot().active).toBe(before.active);
    expect(idleWorkSnapshot().generation).toBe(before.generation + 2);
  });

  it("tracks detached discovery while it waits for account credentials", async () => {
    const db = database(), accounts = deferred<[]>();
    const before = idleWorkSnapshot();
    mocks.accounts.mockReturnValue(accounts.promise);
    const task = refreshCompanySubscriptions(db, "tracked-company", "alice");
    try {
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
      expect(refreshCompanySubscriptions(db, "tracked-company", "alice")).toBe(task);
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
    } finally { accounts.resolve([]); await task; }
    expect(idleWorkSnapshot().active).toBe(before.active);
  });

  it.each([false, true])("waits for a provider slot without dropping accepted discovery (provider fails: %s)", async (fails) => {
    const db = database();
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    let started = 0, active = 0, peak = 0, fifthReads = 0;
    mocks.runtimeCredential.mockImplementation(async current => current.connection.id === "fifth"
      ? (++fifthReads === 1 ? "prequeue-fifth-credential" : "afterqueue-fifth-credential") : "fresh-busy-credential");
    mocks.probe.mockImplementation(async () => {
      const index = started++;
      peak = Math.max(peak, ++active);
      await gates[index].promise;
      active--;
      if (index === 0 && fails) throw new Error("fixture provider failure");
      return { credentialKey: "fixture-key" };
    });
    mocks.accounts.mockImplementation(async companyId => [row(companyId)]);
    const running = Array.from({ length: 4 }, (_, i) => refreshSubscriptionConnection(db, input(`busy-${i}`), `busy-${i}`, fetch, context));
    let discovery: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(started).toBe(4));
      let completed = false;
      discovery = refreshCompanySubscriptions(db, "fifth", "alice").then(() => { completed = true; });
      await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ grantId: "fifth" })));
      expect(started).toBe(4);
      expect(completed).toBe(false);
      gates[0].resolve();
      await vi.waitFor(() => expect(started).toBe(5));
      expect(peak).toBe(4);
      expect(mocks.probe).toHaveBeenCalledWith("fifth", "openai", "afterqueue-fifth-credential", fetch);
      expect(mocks.probe.mock.calls.some(call => call[2] === "prequeue-fifth-credential")).toBe(false);
      expect(mocks.runtimeCredential).toHaveBeenCalledWith(expect.objectContaining({ connection: expect.objectContaining({ id: "fifth" }) }), context);
      gates[4].resolve();
      await discovery;
      expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ grantId: "fifth" }), { credentialKey: "fixture-key" });
    } finally {
      gates.forEach(gate => gate.resolve());
      await Promise.all([...running, discovery]);
    }
  });

  it("rejects excess discovery with a retryable error, deduplicates accepted work, and releases capacity", async () => {
    const db = database(), gate = deferred<[]>();
    mocks.accounts.mockReturnValue(gate.promise);
    const accepted = Array.from({ length: 20 }, (_, i) => refreshCompanySubscriptions(db, "company", `user-${i}`));
    try {
      expect(refreshCompanySubscriptions(db, "company", "user-0")).toBe(accepted[0]);
      expect(mocks.accounts).toHaveBeenCalledTimes(20);
      expect(() => refreshCompanySubscriptions(db, "company", "overflow")).toThrow(expect.objectContaining({ status: 429 }));
    } finally {
      gate.resolve([]);
      await Promise.all(accepted);
    }
    await refreshCompanySubscriptions(db, "company", "overflow");
    expect(mocks.accounts).toHaveBeenCalledTimes(21);
  });
  it("refuses provider observation without an explicit use context", async () => {
    await refreshSubscriptionConnection(database(), input("missing-context"), "missing-context");
    expect(mocks.probe).not.toHaveBeenCalled(); expect(mocks.runtimeCredential).not.toHaveBeenCalled();
  });
  it.each(["membership", "audience", "binding"])("rechecks %s after waiting for a discovery provider slot", async denial => {
    const db = database(), gates = Array.from({ length: 4 }, () => deferred<void>());
    let started = 0, queuedVisible = true;
    mocks.accounts.mockImplementation(async companyId => {
      if (companyId !== "queued-denial" || queuedVisible) return [row(companyId)];
      if (denial === "membership") throw new Error("current membership denied");
      if (denial === "audience") return [];
      return [{ ...row(companyId), grant: { ...row(companyId).grant, id: "replacement-grant" } }];
    });
    mocks.runtimeCredential.mockImplementation(async current => {
      if (current.connection.id === "queued-denial" && !queuedVisible) throw new Error(`${denial} denied`);
      return `fresh-${current.connection.id}`;
    });
    mocks.probe.mockImplementation(async () => { const i = started++; await gates[i].promise; return { credentialKey: "fixture-key" }; });
    const running = Array.from({ length: 4 }, (_, i) => refreshSubscriptionConnection(db, input(`queue-busy-${i}`), `queue-busy-${i}`, fetch, context));
    let discovery: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(started).toBe(4));
      discovery = refreshCompanySubscriptions(db, "queued-denial", "alice");
      await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ grantId: "queued-denial" })));
      queuedVisible = false;
      gates[0].resolve();
      await discovery;
      expect(started).toBe(4);
      expect(mocks.probe.mock.calls.every(call => call[2] !== "fixture")).toBe(true);
      expect(mocks.accounts).toHaveBeenCalledWith("queued-denial", "alice");
      expect(mocks.runtimeCredential).toHaveBeenCalledWith(expect.objectContaining({ connection: expect.objectContaining({ id: "queued-denial" }) }), context);
    } finally { gates.forEach(gate => gate.resolve()); await Promise.all([...running, discovery]); }
  });

});
