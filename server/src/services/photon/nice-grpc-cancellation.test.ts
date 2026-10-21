import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual installed/patched nice-grpc factory. No channel, socket,
// credential, provider call or replacement cancellation wrapper is created.
const requireNiceGrpc = createRequire(import.meta.resolve("nice-grpc"));
type MiddlewareCall = {
  request: unknown;
  next(request: unknown, options: { signal: AbortSignal }): AsyncGenerator<unknown>;
};
type Middleware = (call: MiddlewareCall, options: { signal: AbortSignal }) => AsyncGenerator<unknown>;
type Factory = (
  definition: Record<string, unknown>, client: unknown,
  middleware: Middleware | undefined, options: Record<string, unknown>,
) => (request: unknown, options: { signal: AbortSignal }) => AsyncIterable<unknown>;
const factories: Array<[string, Factory]> = [
  ["server-stream", requireNiceGrpc("./client/createServerStreamingMethod.js").createServerStreamingMethod],
  ["bidi-stream", requireNiceGrpc("./client/createBidiStreamingMethod.js").createBidiStreamingMethod],
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(kind: string, factory: Factory, middleware?: Middleware, requestOverride?: unknown, duringRpc?: (controller: AbortController) => void) {
  const controller = new AbortController();
  const readable = new Readable({ objectMode: true, read() {} });
  const stream = Object.assign(readable, {
    cancel: vi.fn(() => { readable.destroy(Object.assign(new Error("synthetic local cancellation"), { name: "AbortError" })); }),
    write: vi.fn(() => true), end: vi.fn(),
  });
  const rpc = vi.fn(() => { duringRpc?.(controller); return stream; });
  const client = { makeServerStreamRequest: rpc, makeBidiStreamRequest: rpc };
  const pulls = vi.fn();
  const request = requestOverride ?? (kind === "bidi-stream" ? {
    async *[Symbol.asyncIterator]() { pulls(); },
  } : Buffer.from("synthetic-request"));
  const method = factory({
    path: "/fixture.Service/Stream", requestStream: kind === "bidi-stream", responseStream: true,
    options: {}, requestSerialize: () => Buffer.from("request"), responseSerialize: () => Buffer.from("response"),
    requestDeserialize: (value: unknown) => value, responseDeserialize: (value: unknown) => value,
  }, client, middleware, {});
  const iterator = method(request, { signal: controller.signal })[Symbol.asyncIterator]();
  return { controller, iterator, rpc, pulls, stream };
}

describe.each(factories)("nice-grpc actual %s cancellation admission", (kind, factory) => {
  it("cancels synchronous abort during RPC setup before acquiring any producer", async () => {
    const next = vi.fn(async () => ({ done: true, value: undefined }));
    const acquire = vi.fn(() => ({ next }));
    const request = kind === "bidi-stream" ? { [Symbol.asyncIterator]: acquire } : undefined;
    const f = fixture(kind, factory, undefined, request, (controller) => controller.abort());
    await expect(f.iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.stream.cancel).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(f.stream.write).not.toHaveBeenCalled();
    expect(f.stream.end).not.toHaveBeenCalled();
  });
  it("refuses an already-aborted signal before RPC creation or request iteration", async () => {
    const f = fixture(kind, factory);
    f.controller.abort();
    await expect(f.iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.pulls).not.toHaveBeenCalled();
    expect(f.stream.cancel).not.toHaveBeenCalled();
    expect(await f.iterator.next()).toMatchObject({ done: true });
    f.stream.destroy();
  });

  it("refuses abort completed while upstream authentication middleware was awaiting", async () => {
    const entered = deferred();
    const release = deferred();
    const middleware: Middleware = async function* (call, options) {
      entered.resolve();
      await release.promise;
      return yield* call.next(call.request, options);
    };
    const f = fixture(kind, factory, middleware);
    const outcome = f.iterator.next().then(() => undefined, (error) => error);
    try {
      await entered.promise;
      f.controller.abort();
    } finally {
      release.resolve();
    }
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.pulls).not.toHaveBeenCalled();
    expect(f.stream.cancel).not.toHaveBeenCalled();
    f.stream.destroy();
  });

  it("preserves active local cancellation without replay or a second RPC", async () => {
    const f = fixture(kind, factory);
    const outcome = f.iterator.next().then(() => undefined, (error) => error);
    try {
      await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce());
    } finally {
      f.controller.abort();
    }
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(f.stream.cancel).toHaveBeenCalledOnce();
    expect(await f.iterator.next()).toMatchObject({ done: true });
    expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.stream.write).not.toHaveBeenCalled();
    // This is local cancellation only; no remote acknowledgement/rollback or
    // transport/credential retirement receipt is fabricated from the error.
    f.stream.destroy();
  });
});

describe("nice-grpc actual bidi producer settlement", () => {
  const factory = factories[1]![1];

  it("preserves normal finite producer and response completion", async () => {
    const item = Buffer.from("one request");
    const response = Buffer.from("one response");
    const next = vi.fn()
      .mockResolvedValueOnce({ done: false, value: item })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const close = vi.fn(async () => ({ done: true, value: undefined }));
    const f = fixture("bidi-stream", factory, undefined, { [Symbol.asyncIterator]: () => ({ next, return: close }) });
    const first = f.iterator.next();
    void first.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(f.stream.end).toHaveBeenCalledOnce());
      expect(f.stream.write).toHaveBeenCalledOnce();
      expect(f.stream.write).toHaveBeenCalledWith(item);
      f.stream.push(response);
      expect(await first).toMatchObject({ done: false, value: response });
      f.stream.push(null);
      expect(await f.iterator.next()).toMatchObject({ done: true });
      expect(next).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();
      expect(f.stream.write).toHaveBeenCalledOnce();
      expect(f.stream.end).toHaveBeenCalledOnce();
      expect(f.rpc).toHaveBeenCalledOnce();
    } finally {
      f.controller.abort();
      await first.catch(() => undefined);
      await f.iterator.return?.().catch(() => undefined);
      f.stream.destroy();
    }
  });

  it.each(["abort", "response-end"])("keeps %s pending until producer next and return cleanup both settle", async (stop) => {
    const nextEntered = deferred(), nextRelease = deferred();
    const returnEntered = deferred(), returnRelease = deferred();
    const next = vi.fn(async () => {
      nextEntered.resolve();
      await nextRelease.promise;
      return { done: false, value: Buffer.from("late input") };
    });
    const close = vi.fn(async () => {
      returnEntered.resolve();
      await returnRelease.promise;
      return { done: true, value: undefined };
    });
    const request = { [Symbol.asyncIterator]: () => ({ next, return: close }) };
    const f = fixture("bidi-stream", factory, undefined, request);
    let settled = false;
    const outcome = f.iterator.next().then(
      (result) => { settled = true; return result; },
      (error) => { settled = true; return error; },
    );
    try {
      await nextEntered.promise;
      if (stop === "abort") f.controller.abort();
      else f.stream.push(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(f.stream.cancel).toHaveBeenCalledOnce();
      nextRelease.resolve();
      await returnEntered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(f.stream.write).not.toHaveBeenCalled();
      expect(f.stream.end).not.toHaveBeenCalled();
    } finally {
      nextRelease.resolve();
      returnRelease.resolve();
      const result = await outcome;
      if (stop === "abort") expect(result).toMatchObject({ name: "AbortError" });
      else expect(result).toMatchObject({ done: true });
    }
    expect(next).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(f.stream.write).not.toHaveBeenCalled();
    expect(f.stream.end).not.toHaveBeenCalled();
    expect(await f.iterator.next()).toMatchObject({ done: true });
    expect(f.rpc).toHaveBeenCalledOnce();
  });

  it.each(["Error", "AbortError"])("preserves original response failure before producer cleanup %s", async (cleanupName) => {
    const nextEntered = deferred(), nextRelease = deferred();
    const primary = new Error("response failed");
    const cleanup = Object.assign(new Error("producer return failed"), { name: cleanupName });
    const close = vi.fn(async () => { throw cleanup; });
    const request = { [Symbol.asyncIterator]: () => ({
      next: async () => {
        nextEntered.resolve();
        await nextRelease.promise;
        return { done: false, value: Buffer.from("late input") };
      },
      return: close,
    }) };
    const f = fixture("bidi-stream", factory, undefined, request);
    const outcome = f.iterator.next().then(() => undefined, (error) => error);
    try {
      await nextEntered.promise;
      f.stream.destroy(primary);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      nextRelease.resolve();
    }
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([primary, cleanup]);
    expect(close).toHaveBeenCalledOnce();
    expect(f.stream.cancel).toHaveBeenCalledOnce();
    expect(f.stream.write).not.toHaveBeenCalled();
    expect(f.stream.end).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledOnce();
  });

  it("never half-closes after an aborted pending producer finishes normally", async () => {
    const entered = deferred(), release = deferred();
    const close = vi.fn(async () => ({ done: true, value: undefined }));
    const request = { [Symbol.asyncIterator]: () => ({
      next: async () => { entered.resolve(); await release.promise; return { done: true, value: undefined }; },
      return: close,
    }) };
    const f = fixture("bidi-stream", factory, undefined, request);
    const outcome = f.iterator.next().then(() => undefined, (error) => error);
    try {
      await entered.promise;
      f.controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.stream.end).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(close).not.toHaveBeenCalled();
    expect(f.stream.cancel).toHaveBeenCalledOnce();
    expect(f.stream.write).not.toHaveBeenCalled();
    expect(f.stream.end).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledOnce();
  });

  it.each(["Error", "AbortError"])("retains a genuine producer %s instead of hiding it behind cancellation", async (name) => {
    const original = Object.assign(new Error("producer failed"), { name });
    const request = { async *[Symbol.asyncIterator]() { throw original; } };
    const f = fixture("bidi-stream", factory, undefined, request);
    await expect(f.iterator.next()).rejects.toBe(original);
    expect(f.stream.cancel).toHaveBeenCalledOnce();
    expect(f.stream.write).not.toHaveBeenCalled();
    expect(f.stream.end).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledOnce();
  });
});
