import type { Db } from "@paperclipai/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installExecutionCapacity, registerCapacityProgress } from "../services/execution-capacity-context.js";

let sweep: typeof import("../services/execution-capacity-lifetime.js").reconcileStoppedCapacityReservations;
let reconcile: typeof import("../services/execution-capacity-lifetime.js").reconcileCapacityReservation;
beforeAll(async () => {
  const lifetime = await import("../services/execution-capacity-lifetime.js");
  sweep = lifetime.reconcileStoppedCapacityReservations;
  reconcile = lifetime.reconcileCapacityReservation;
});
afterEach(() => vi.useRealTimers());

function fixture() {
  const db = {} as Db;
  const commands = vi.fn().mockRejectedValue(new Error("missing exact stop receipt"));
  const stopping = vi.fn().mockResolvedValue([{ id: "held", companyId: "company" }]);
  installExecutionCapacity(db, { stoppingReservations: stopping, commandsForAttempt: commands } as never);
  return { db, commands, stopping };
}

describe("same-controller cleanup sweep", () => {
  it("bounds retries/backoff and leaves an unverified stop held without replay or adoption", async () => {
    vi.useFakeTimers();
    const f = fixture();
    registerCapacityProgress(f.db, () => sweep(f.db));
    await sweep(f.db);
    await sweep(f.db);
    expect(f.commands).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.commands).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(f.commands).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    await sweep(f.db);
    expect(f.commands).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores reentrant/concurrent sweeps while enumeration is in flight", async () => {
    const f = fixture();
    let finish!: () => void;
    f.stopping.mockImplementation(async () => {
      await sweep(f.db);
      await new Promise<void>(resolve => { finish = resolve; });
      return [];
    });
    const first = sweep(f.db);
    await sweep(f.db);
    finish();
    await first;
    expect(f.stopping).toHaveBeenCalledTimes(1);
    expect(f.commands).not.toHaveBeenCalled();
  });

  it("prunes settled rows so retry bookkeeping does not suppress a later reservation", async () => {
    const f = fixture();
    await sweep(f.db);
    f.stopping.mockResolvedValueOnce([]);
    await sweep(f.db);
    await sweep(f.db);
    expect(f.commands).toHaveBeenCalledTimes(2);
  });

  it("guards reconciliation before its first asynchronous stop lookup", async () => {
    const f = fixture();
    let fail!: (error: Error) => void;
    f.commands.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = reconcile(f.db, "company", "held");
    const rejected = expect(pending).rejects.toThrow("missing exact stop receipt");
    await sweep(f.db);
    await expect(reconcile(f.db, "company", "held")).rejects.toThrow("capacity_finalizer_active");
    expect(f.commands).toHaveBeenCalledTimes(1);
    fail(new Error("missing exact stop receipt"));
    await rejected;
  });
});
