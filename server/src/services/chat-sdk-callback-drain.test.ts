import { beforeEach, describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({ chats: [] as Array<{ reaction: (event: unknown) => Promise<unknown>; shutdown: ReturnType<typeof vi.fn> }> }));
vi.mock("@chat-adapter/slack", () => ({ createSlackAdapter: () => ({ name: "slack" }) }));
vi.mock("chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chat")>();
  return { ...actual, Chat: class {
    reaction!: (event: unknown) => Promise<unknown>;
    shutdown = vi.fn(async () => {});
    constructor() { captures.chats.push(this); }
    onDirectMessage() {}
    onNewMention() {}
    onSubscribedMessage() {}
    onNewMessage() {}
    onReaction(handler: (event: unknown) => Promise<unknown>) { this.reaction = handler; }
    async initialize() {}
  } };
});
import { createChatSdkEndpointRuntime, type CreateChatSdkEndpointRuntimeOptions } from "./chat-sdk-runtime.js";
import { createChatRuntime } from "./chat-runtime.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function options(onReaction: () => Promise<void>): CreateChatSdkEndpointRuntimeOptions {
  return {
    companyId: "company", endpointId: "endpoint", logger: "silent",
    providerConfig: { provider: "slack", userName: "test", credentials: { botToken: "fixture", signingSecret: "fixture", botUserId: "U1" } },
    callbacks: { onMessage: async () => {}, onReaction },
    persistence: { compareAndSet: async () => true, deleteIfVersion: async () => true, read: async () => null },
  };
}
beforeEach(() => { captures.chats = []; });

describe("ordinary application callback retirement ownership", () => {
  it("joins an admitted noncommand callback and refuses late callback admission", async () => {
    const entered = deferred(), release = deferred();
    const effect = vi.fn();
    const callback = vi.fn(async () => { entered.resolve(); await release.promise; effect(); });
    const endpoint = createChatSdkEndpointRuntime(options(callback));
    const chat = captures.chats[0];
    const admitted = chat.reaction({ raw: {} });
    await entered.promise;
    let retired = false;
    const stopping = endpoint.shutdown().then(() => { retired = true; });
    // Late SDK dispatch must not invoke the application after synchronous fence.
    await chat.reaction({ raw: {} }).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();
    expect(retired).toBe(false);
    release.resolve();
    await Promise.all([admitted, stopping]);
    expect(effect).toHaveBeenCalledOnce();
    expect(chat.shutdown).toHaveBeenCalledOnce();
  });

  it("allows callback-origin retirement request while external shutdown joins its settlement", async () => {
    const registry = createChatRuntime();
    const requested = deferred(), release = deferred();
    let removal!: Promise<boolean>;
    const callback = vi.fn(async () => {
      expect(registry.isInsideEndpointCallback("endpoint")).toBe(true);
      registry.fenceEndpointAdmission("endpoint");
      removal = registry.removeEndpoint("endpoint");
      void removal.catch(() => undefined);
      requested.resolve();
      await release.promise;
    });
    await registry.replaceEndpoint(options(callback));
    const chat = captures.chats[0];
    const admitted = chat.reaction({ raw: {} });
    await requested.promise;
    let settled = false;
    const external = registry.shutdown().then(() => { settled = true; });
    await chat.reaction({ raw: {} }).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(callback).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all([admitted, removal, external]);
    expect(registry.isInsideEndpointCallback("endpoint")).toBe(false);
    expect(chat.shutdown).toHaveBeenCalledOnce();
  });
  it("retains an already-rejected non-Discord callback outcome and refuses successor ownership", async () => {
    const registry = createChatRuntime();
    const failure = new Error("application effect outcome unknown");
    await registry.replaceEndpoint(options(async () => { throw failure; }));
    const chat = captures.chats[0];
    // Simulate an SDK that already observed/swallowed the callback rejection:
    // its callback task is settled and absent from the active-task snapshot.
    await expect(chat.reaction({ raw: {} })).rejects.toBe(failure);
    await expect(registry.removeEndpoint("endpoint")).rejects.toBe(failure);
    expect(chat.shutdown).toHaveBeenCalledOnce();
    expect(registry.get("endpoint")).toBeNull();
    await expect(registry.replaceEndpoint(options(async () => {}))).rejects.toBe(failure);
    expect(captures.chats).toHaveLength(1);
    expect(chat.shutdown).toHaveBeenCalledTimes(2);
  });

});
