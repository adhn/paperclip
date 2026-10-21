import { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() { return new WebClient("fixture-token", { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true }) as any; }
const uploads = () => [
  { filename: "a.txt", length: 1, data: Buffer.from("a"), file_id: "FA", upload_url: "https://upload.fixture.invalid/a", channel_id: "CA" },
  { filename: "b.txt", length: 1, data: Buffer.from("b"), file_id: "FB", upload_url: "https://upload.fixture.invalid/b", channel_id: "CB" },
];

describe("actual WebClient admitted upload task joins", () => {
  it.each(["url", "upload", "completion"] as const)("does not reject %s batch while an admitted sibling remains pending", async phase => {
    const client = fixture(), sibling = deferred<any>(), failure = new Error(`fixture ${phase} first failed`);
    const first = vi.fn(() => Promise.reject(failure)), second = vi.fn(() => sibling.promise);
    let operation: Promise<unknown>;
    if (phase === "url") {
      client.files.getUploadURLExternal = vi.fn((input: { filename: string }) => input.filename === "a.txt" ? first() : second());
      operation = client.fetchAllUploadURLExternal(uploads());
    } else if (phase === "upload") {
      client.makeRequest = vi.fn((url: string) => url.endsWith("/a") ? first() : second());
      operation = client.postFileUploadsToExternalURL(uploads(), {});
    } else {
      client.files.completeUploadExternal = vi.fn((input: { channel_id: string }) => input.channel_id === "CA" ? first() : second());
      operation = client.completeFileUploads(uploads());
    }
    let settled = false;
    const outcome = operation.then(value => { settled = true; return { rejected: false, value }; }, error => { settled = true; return { rejected: true, error }; });
    await turn(); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    sibling.resolve(phase === "upload" ? { status: 200, data: "fixture sibling accepted" } : { ok: true });
    expect(await outcome).toEqual({ rejected: true, error: failure });
  });
  it("joins all admitted URL factories even if one throws synchronously with undefined", async () => {
    const client = fixture(), sibling = deferred<any>();
    client.files.getUploadURLExternal = vi.fn((input: { filename: string }) => { if (input.filename === "a.txt") throw undefined; return sibling.promise; });
    let settled = false;
    const outcome = client.fetchAllUploadURLExternal(uploads()).then(() => { settled = true; return { rejected: false }; }, (error: unknown) => { settled = true; return { rejected: true, error }; });
    await turn(); expect(client.files.getUploadURLExternal).toHaveBeenCalledTimes(2); expect(settled).toBe(false);
    sibling.resolve({ file_id: "FB" }); expect(await outcome).toEqual({ rejected: true, error: undefined });
  });
  it("retains original and secondary failures in actual rejection-arrival order", async () => {
    const client = fixture(), a = deferred<any>(), b = deferred<any>(), first = new Error("fixture B failed first"), second = new Error("fixture A failed second");
    client.files.getUploadURLExternal = vi.fn((input: { filename: string }) => input.filename === "a.txt" ? a.promise : b.promise);
    const outcome = client.fetchAllUploadURLExternal(uploads()).catch((error: unknown) => error);
    await turn(); b.reject(first); await turn(); a.reject(second);
    const error = await outcome; expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([first, second]);
  });
  it("preserves input ordering for successful independently settling URL jobs", async () => {
    const client = fixture(), a = deferred<any>(), b = deferred<any>();
    client.files.getUploadURLExternal = vi.fn((input: { filename: string }) => input.filename === "a.txt" ? a.promise : b.promise);
    const result = client.fetchAllUploadURLExternal(uploads());
    await turn(); b.resolve({ file_id: "FB" }); a.resolve({ file_id: "FA" });
    expect(await result).toEqual([{ file_id: "FA" }, { file_id: "FB" }]);
  });
  it("actual uploadV2 does not start uploads or completion after a joined URL phase failure", async () => {
    const client = fixture(), sibling = deferred<any>();
    client.files.getUploadURLExternal = vi.fn((input: { filename: string }) => input.filename === "a.txt" ? Promise.reject(new Error("fixture allocation failed")) : sibling.promise);
    client.makeRequest = vi.fn(); client.files.completeUploadExternal = vi.fn();
    let settled = false;
    const result = client.files.uploadV2({ file_uploads: [{ file: Buffer.from("a"), filename: "a.txt" }, { file: Buffer.from("b"), filename: "b.txt" }], channel_id: "CFIXTURE" })
      .then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
    await turn(); expect(settled).toBe(false); expect(client.makeRequest).not.toHaveBeenCalled();
    sibling.resolve({ upload_url: "https://upload.fixture.invalid/b", file_id: "FB" });
    expect(await result).toBeInstanceOf(Error); expect(client.makeRequest).not.toHaveBeenCalled(); expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
  });
  it("actual uploadV2 joins queued axios upload siblings before failing and never completes them", async () => {
    const client = fixture(), sibling = deferred<any>();
    client.files.getUploadURLExternal = vi.fn(async (input: { filename: string }) => ({ upload_url: `https://upload.fixture.invalid/${input.filename}`, file_id: input.filename === "a.txt" ? "FA" : "FB" }));
    client.axios.post = vi.fn((url: string) => url.endsWith("a.txt") ? Promise.reject(new Error("fixture physical HTTP A failed")) : sibling.promise);
    client.files.completeUploadExternal = vi.fn();
    let settled = false;
    const result = client.files.uploadV2({ file_uploads: [{ file: Buffer.from("a"), filename: "a.txt" }, { file: Buffer.from("b"), filename: "b.txt" }], channel_id: "CFIXTURE" })
      .then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
    await turn(); expect(client.axios.post).toHaveBeenCalledTimes(2); expect(settled).toBe(false);
    sibling.resolve({ status: 200, data: "fixture physical HTTP B returned", headers: {} });
    expect(await result).toBeInstanceOf(Error); expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
    expect(client.axios.post).toHaveBeenCalledTimes(2);
  });
});
