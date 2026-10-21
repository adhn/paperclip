import { describe, expect, it, vi } from "vitest";
import { Chat } from "chat";

describe("Chat shutdown reports actual disconnect failures", () => {
  it("attempts every adapter and state cleanup then rejects original failures", async () => {
    const adapterError = new Error("adapter disconnect unknown");
    const stateError = new Error("state disconnect unknown");
    const first = vi.fn(async () => { throw adapterError; });
    const second = vi.fn(async () => {});
    const state = vi.fn(async () => { throw stateError; });
    const chat = new Chat({ userName: "test", logger: "silent",
      adapters: { first: { name: "first", disconnect: first }, second: { name: "second", disconnect: second } },
      state: { disconnect: state },
    } as never);
    await expect(chat.shutdown()).rejects.toMatchObject({ errors: [adapterError, stateError] });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(state).toHaveBeenCalledOnce();
  });
  it("does not turn a rejected adapter cleanup into success when state cleanup succeeds", async () => {
    const error = new Error("adapter cleanup failed");
    const disconnect = vi.fn(async () => { throw error; });
    const state = vi.fn(async () => {});
    const chat = new Chat({ userName: "test", logger: "silent",
      adapters: { fake: { name: "fake", disconnect } }, state: { disconnect: state },
    } as never);
    await expect(chat.shutdown()).rejects.toMatchObject({ errors: [error] });
    expect(state).toHaveBeenCalledOnce();
  });
});
