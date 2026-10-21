import { describe, expect, it, vi } from "vitest";
import { TypedEventStream } from "@photon-ai/advanced-imessage";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const source = (next: () => Promise<IteratorResult<number>>, finish: () => Promise<IteratorResult<number>>) => ({
  [Symbol.asyncIterator]: () => ({ next, return: finish }),
});

describe("Photon TypedEventStream actual source cleanup", () => {
  it.each([new Error("fixture callback failed"), undefined])("preserves callback failure before failed iterator return: %s", async callbackFailure => {
    const returnFailure = new Error("fixture iterator return failed");
    const finish = vi.fn(async () => { throw returnFailure; });
    const callback = vi.fn(async () => { throw callbackFailure; });
    const outcome = deferred<unknown>();
    const stream = new TypedEventStream(source(async () => ({ done: false, value: 1 }), finish));
    stream.on(callback, outcome.resolve);
    const error = await outcome.promise;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([callbackFailure, returnFailure]);
    expect(callback).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    await expect(stream.close()).rejects.toBe(returnFailure);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("retains one close promise and joins admitted iterator return after abort", async () => {
    const next = deferred<IteratorResult<number>>();
    const returned = deferred<IteratorResult<number>>();
    const finish = vi.fn(() => returned.promise);
    const abort = vi.fn(async () => { next.resolve({ done: true, value: undefined }); });
    const stream = new TypedEventStream(source(() => next.promise, finish), abort);
    const pending = stream[Symbol.asyncIterator]().next();
    const close = stream.close();
    expect(stream.close()).toBe(close);
    let settled = false;
    void close.then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(abort).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    returned.resolve({ done: true, value: undefined });
    await close; await pending;
    expect(stream.close()).toBe(close);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("attempts iterator return despite cleanup rejection and retains both failures", async () => {
    const next = deferred<IteratorResult<number>>();
    const abortError = new Error("fixture abort failed");
    const returnError = new Error("fixture iterator return failed");
    const finish = vi.fn(async () => { throw returnError; });
    const stream = new TypedEventStream(source(() => next.promise, finish), async () => { throw abortError; });
    const pending = stream[Symbol.asyncIterator]().next().catch(error => error);
    const close = stream.close();
    const failed = close.catch(error => error);
    const error = await failed;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([abortError, returnError]);
    expect(await stream.close().catch(value => value)).toBe(error);
    expect(await pending).toBe(returnError);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("preserves throw undefined and publishes close before reentrant cleanup", async () => {
    let reentrant: Promise<void> | undefined;
    let stream: TypedEventStream<number>;
    stream = new TypedEventStream(source(async () => ({ done: true, value: undefined }), async () => ({ done: true, value: undefined })), async () => {
      reentrant = stream.close();
      throw undefined;
    });
    const close = stream.close();
    const outcome = await close.then(() => ({ rejected: false }), error => ({ rejected: true, error }));
    expect(reentrant).toBe(close);
    expect(outcome).toEqual({ rejected: true, error: undefined });
    expect(stream.close()).toBe(close);
  });

  it("preserves source iteration failure before iterator cleanup failure", async () => {
    const first = new Error("fixture next failed");
    const second = new Error("fixture return failed");
    const finish = vi.fn(async () => { throw second; });
    const stream = new TypedEventStream(source(async () => { throw first; }, finish));
    const error = await stream[Symbol.asyncIterator]().next().catch(value => value);
    expect(error.errors).toEqual([first, second]);
    await expect(stream.close()).rejects.toBe(second);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("does not initialize a claimed but unstarted source after close", async () => {
    const setup = vi.fn(() => ({ next: async () => ({ done: true as const, value: undefined }) }));
    const stream = new TypedEventStream<number>({ [Symbol.asyncIterator]: setup });
    const iterator = stream[Symbol.asyncIterator]();
    await stream.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(setup).not.toHaveBeenCalled();
  });

  it("still attempts independent cleanup after source iterator initialization fails", async () => {
    const failure = new Error("fixture iterator setup failed");
    const cleanup = vi.fn(async () => {});
    const stream = new TypedEventStream<number>({ [Symbol.asyncIterator]() { throw failure; } }, cleanup);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(failure);
    await stream.close();
    await stream.close();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("permits a callback to await close without joining its own pump", async () => {
    const callbackDone = deferred<void>();
    const finish = vi.fn(async () => ({ done: true as const, value: undefined }));
    const stream = new TypedEventStream(source(async () => ({ done: false, value: 1 }), finish));
    stream.on(async () => { await stream.close(); callbackDone.resolve(); }, callbackDone.reject);
    await callbackDone.promise;
    expect(finish).toHaveBeenCalledOnce();
  });
});
