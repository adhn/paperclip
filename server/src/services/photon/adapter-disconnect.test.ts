import { describe, expect, it, vi } from "vitest";
import { createGrpcClient } from "@photon-ai/advanced-imessage";
vi.mock("@photon-ai/advanced-imessage", async (importOriginal) => ({
  ...await importOriginal<typeof import("@photon-ai/advanced-imessage")>(),
  createGrpcClient: vi.fn(() => ({ close: async () => {} })),
}));
import { PhotonChatAdapter } from "./adapter.js";

function deferred() {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, fail) => { reject = fail; });
  return { promise, reject };
}
function fixture(retire: () => unknown, recoveryClose: () => unknown, clientClose: () => unknown) {
  const adapter = new PhotonChatAdapter("test", {
    identity: { phoneNumber: "+10000000000" }, retire,
  } as never, {} as never, { close: clientClose } as never);
  // Install the actual private transport lifecycle handle without creating an
  // external connection. Cleanup still runs through the production adapter.
  Object.assign(adapter, { recovery: { close: recoveryClose } });
  return adapter;
}

describe("Photon independent disconnect ownership", () => {
  it("disables hidden gRPC retries for the actual native client construction", () => {
    new PhotonChatAdapter("test", { identity: { phoneNumber: "+10000000000" }, address: "isolated.invalid", token: async () => "fixture-token" } as never, {} as never);
    expect(createGrpcClient).toHaveBeenLastCalledWith(expect.objectContaining({
      retry: false, autoIdempotency: false,
      channelOptions: expect.objectContaining({ "grpc.enable_retries": 0 }),
    }));
  });

  it("attempts every cleanup despite synchronous failures and joins asynchronous cleanup", async () => {
    const authError = new Error("auth retirement failed");
    const recoveryError = new Error("recovery close failed");
    const clientError = new Error("client close failed");
    const client = deferred();
    const retire = vi.fn(() => { throw authError; });
    const recovery = vi.fn(() => { throw recoveryError; });
    const close = vi.fn(() => client.promise);
    const adapter = fixture(retire, recovery, close);
    const first = adapter.disconnect();
    expect(adapter.disconnect()).toBe(first);
    let settled = false;
    const outcome = first.catch((error) => { settled = true; return error; });
    await Promise.resolve();
    await Promise.resolve();
    expect(retire).toHaveBeenCalledOnce();
    expect(recovery).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    client.reject(clientError);
    expect((await outcome).errors).toEqual([authError, recoveryError, clientError]);
    expect(adapter.disconnect()).toBe(first);
    await expect(adapter.disconnect()).rejects.toMatchObject({ errors: [authError, recoveryError, clientError] });
    expect(close).toHaveBeenCalledOnce();
    expect(() => adapter.recoveryStream()).toThrow("retired");
  });

  it("retains the original cleanup error instead of accepting a later opaque no-op", async () => {
    const error = new Error("recovery cleanup unknown");
    const recovery = vi.fn().mockImplementationOnce(() => { throw error; }).mockImplementation(() => {});
    const close = vi.fn(async () => {});
    const adapter = fixture(vi.fn(), recovery, close);
    await expect(adapter.disconnect()).rejects.toBe(error);
    await expect(adapter.disconnect()).rejects.toBe(error);
    expect(recovery).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains a successful exact cleanup without recreating the recovery transport", async () => {
    const retire = vi.fn();
    const recovery = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const adapter = fixture(retire, recovery, close);
    const first = adapter.disconnect();
    await first;
    expect(adapter.disconnect()).toBe(first);
    expect(retire).toHaveBeenCalledOnce();
    expect(recovery).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(() => adapter.recoveryStream()).toThrow("retired");
  });
});
