import { describe, expect, it, vi } from "vitest";
import { createSlackSetupClient } from "./provider-client.js";

function responseClient(stream: ReadableStream<Uint8Array>, releaseFailure?: { value: unknown }) {
  const response = new Response(stream, { status: 200, headers: { "x-fixture": "exact" } });
  const getReader = stream.getReader.bind(stream);
  const releases = vi.fn();
  vi.spyOn(stream, "getReader").mockImplementation((...args: unknown[]) => {
    const reader = Reflect.apply(getReader, stream, args) as ReadableStreamDefaultReader<Uint8Array>;
    const release = reader.releaseLock.bind(reader);
    reader.releaseLock = () => { releases(); release(); if (releaseFailure) throw releaseFailure.value; };
    return reader;
  });
  const fetch = vi.fn(async () => response);
  const observer = vi.fn(async () => {});
  return { api: createSlackSetupClient(fetch as typeof globalThis.fetch), fetch, observer, releases };
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; throw new Error("expected rejection"); } catch (error) { return error; }
}
describe("Slack provider response cleanup ownership", () => {
  it.each([new Error("read failed"), undefined])("preserves an actual stream failure plus release failure: %s", async readFailure => {
    const releaseFailure = new Error("release failed");
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(readFailure); } });
    const f = responseClient(stream, { value: releaseFailure });
    const error = await rejection(f.api("oauth.v2.access", {}, undefined, undefined, f.observer));
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([readFailure, releaseFailure]);
    expect(f.releases).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.observer).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });
  it("retains bounded-size failure before failed cancellation and release", async () => {
    const cancelFailure = new Error("cancel failed"), releaseFailure = new Error("release failed");
    const cancel = vi.fn(async () => { throw cancelFailure; });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel });
    const f = responseClient(stream, { value: releaseFailure });
    const error = await rejection(f.api("oauth.v2.access", {}, undefined, undefined, f.observer));
    expect(error).toBeInstanceOf(AggregateError);
    const failures = (error as AggregateError).errors;
    expect(failures[0]).toMatchObject({ status: 422, details: { code: "slack_provider_failure" } });
    expect(failures.slice(1)).toEqual([cancelFailure, releaseFailure]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.releases).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.observer).not.toHaveBeenCalled();
  });
  it("preserves a sole stream failure exactly and releases once without a retry", async () => {
    const failure = new Error("read failed");
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } });
    const f = responseClient(stream);
    await expect(f.api("oauth.v2.access", {}, undefined, undefined, f.observer)).rejects.toBe(failure);
    expect(f.releases).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.observer).not.toHaveBeenCalled();
  });
  it.each([new Error("observer failed"), undefined])("awaits observer and preserves its exact failure after body cleanup: %s", async failure => {
    const bytes = new Uint8Array([0xff, 0, 0x7b]); // Invalid JSON must never mask observer rejection.
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const f = responseClient(stream);
    let releaseObserver!: () => void;
    const wait = new Promise<void>(resolve => { releaseObserver = resolve; });
    const entered = new Promise<void>(resolve => {
      f.observer.mockImplementation(async () => { resolve(); await wait; throw failure; });
    });
    let settled = false;
    const operation = f.api("oauth.v2.access", {}, undefined, undefined, f.observer);
    const outcome = operation.then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await entered;
    expect(settled).toBe(false);
    expect(f.releases).toHaveBeenCalledOnce();
    expect(f.observer).toHaveBeenCalledWith({ status: 200, headers: { "x-fixture": "exact" }, bodyBase64: Buffer.from(bytes).toString("base64") });
    releaseObserver();
    expect(await outcome).toBe(failure);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
