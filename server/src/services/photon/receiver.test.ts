import { describe, expect, it, vi } from "vitest";
import { PhotonReceiver } from "./receiver.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function receiver(admit: () => Promise<void>, close = async () => {}) {
  const stream = {
    close,
    async *[Symbol.asyncIterator]() {
      yield { type: "message.received", sequence: 1, occurredAt: new Date().toISOString() };
      yield { type: "catchup.complete", headSequence: 1 };
    },
  };
  const state = { read: async () => undefined, update: vi.fn(async () => {}) };
  const instance = new PhotonReceiver({
    client: {} as never, state: state as never, lineId: "line", intakeAfter: 0,
    assertOwned: async () => {}, admit, failure: async () => {},
    catchUp: () => stream as never,
  });
  return { instance, state };
}

describe("Photon receiver callback drain", () => {
  it("retains subscriptions created before a later initialization failure", async () => {
    const close = vi.fn(async () => {});
    const instance = new PhotonReceiver({
      client: {
        messages: { subscribeEvents: () => ({ close }) },
        chats: { subscribeEvents: () => { throw new Error("subscribe failed"); } },
      } as never,
      state: {} as never, lineId: "line", intakeAfter: 0,
      assertOwned: async () => {}, admit: async () => {}, failure: async () => {},
    });
    expect(() => instance.start()).toThrow("subscribe failed");
    await instance.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("joins an admitted callback even after the stream transport closes", async () => {
    const entered = deferred();
    const completion = deferred();
    const effect = vi.fn();
    const f = receiver(async () => { entered.resolve(); await completion.promise; effect(); });
    const catchUp = f.instance.catchUp();
    await entered.promise;
    let closed = false;
    const closing = f.instance.close().then(() => { closed = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    completion.resolve();
    await Promise.all([closing, catchUp]);
    expect(effect).toHaveBeenCalledOnce();
    await f.instance.catchUp();
    expect(effect).toHaveBeenCalledOnce();
  });

  it("joins admitted work before exposing a failed transport cleanup", async () => {
    const entered = deferred();
    const completion = deferred();
    const f = receiver(async () => { entered.resolve(); await completion.promise; }, async () => { throw new Error("close failed"); });
    const catchUp = f.instance.catchUp().catch(() => {});
    await entered.promise;
    let settled = false;
    const closing = f.instance.close().catch((error) => { settled = true; return error; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    completion.resolve();
    expect(await closing).toMatchObject({ message: "close failed" });
    await catchUp;
  });
  it("retains failed cleanup even when a later SDK close would resolve as a no-op", async () => {
    const entered = deferred();
    const completion = deferred();
    const failure = new Error("original cleanup unknown");
    let attempts = 0;
    const close = vi.fn(async () => { if (++attempts === 1) throw failure; });
    const f = receiver(async () => { entered.resolve(); await completion.promise; }, close);
    const catchUp = f.instance.catchUp();
    await entered.promise;
    const first = f.instance.close();
    const second = f.instance.close();
    expect(second).toBe(first);
    let settled = false;
    const outcome = first.catch((error) => { settled = true; return error; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    completion.resolve();
    expect(await outcome).toBe(failure);
    await catchUp;
    const attemptsAfterDrain = attempts;
    await expect(f.instance.close()).rejects.toBe(failure);
    expect(attempts).toBe(attemptsAfterDrain);
  });

  it("retains cleanup first failed by catch-up finally before shutdown begins", async () => {
    const failure = new Error("catch-up cleanup unknown");
    let attempts = 0;
    const f = receiver(async () => {}, async () => { if (++attempts === 1) throw failure; });
    await expect(f.instance.catchUp()).rejects.toBe(failure);
    await expect(f.instance.close()).rejects.toBe(failure);
    const afterClose = attempts;
    await expect(f.instance.close()).rejects.toBe(failure);
    expect(attempts).toBe(afterClose);
  });

});
