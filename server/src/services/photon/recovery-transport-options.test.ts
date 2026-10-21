import { describe, expect, it, vi } from "vitest";
import { Client } from "@grpc/grpc-js";
import { PhotonRecoveryTransport } from "./recovery-transport.js";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";

const observed = vi.hoisted(() => ({ clients: [] as Array<{ options: Record<string, unknown>; rpc: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> }));
vi.mock("@grpc/grpc-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@grpc/grpc-js")>();
  return {
    ...actual,
    Client: class {
      makeServerStreamRequest = vi.fn(() => { throw new Error("RPC forbidden in constructor fixture"); });
      close = vi.fn();
      constructor(readonly address: string, _credentials: unknown, readonly options: Record<string, unknown>) {
        observed.clients.push({ options, rpc: this.makeServerStreamRequest, close: this.close });
      }
    },
  };
});

describe("Photon recovery transport retry authority", () => {
  it("disables grpc-js retries at its actual client construction without authenticating or starting RPC", () => {
    const token = vi.fn(async () => "synthetic-token");
    const transport = new PhotonRecoveryTransport({ address: "fixture.invalid:443", token } as never);
    const client = observed.clients.at(-1)!;
    expect(client.options).toMatchObject({
      "grpc.enable_retries": 0,
      "grpc.max_receive_message_length": MAX_ATTACHMENT_BYTES + 1024 * 1024,
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    transport.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("keeps explicitly supplied client ownership without allocating a second channel", () => {
    const before = observed.clients.length;
    const close = vi.fn();
    const client = { close, makeServerStreamRequest: vi.fn() } as unknown as Client;
    const transport = new PhotonRecoveryTransport({ address: "fixture.invalid:443" } as never, client);
    expect(observed.clients).toHaveLength(before);
    transport.close();
    expect(close).toHaveBeenCalledOnce();
    expect(client.makeServerStreamRequest).not.toHaveBeenCalled();
  });
});
