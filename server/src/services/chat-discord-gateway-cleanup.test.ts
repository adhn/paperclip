import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "@chat-adapter/discord";
import { Client, Events } from "discord.js";

const clients: Client[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(clients.splice(0).map((client) => client.destroy()));
});
function adapter(onGatewayEvent?: (event: { type: string }) => Promise<void>) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } };
  const value = new DiscordAdapter({ botToken: "fixture-token", applicationId: "12345678901234567", publicKey: "ab".repeat(32), logger, onGatewayEvent } as never);
  Object.assign(value, { chat: {} });
  return value;
}
async function start(value: DiscordAdapter, abortSignal?: AbortSignal) {
  let listener!: Promise<unknown>;
  await value.startGatewayListener({ waitUntil: (task) => { listener = Promise.resolve(task); } }, 1, abortSignal);
  return { listener };
}
function localLogin() {
  return vi.spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
    clients.push(this);
    this.token = "fixture-token";
    this.rest.setToken("fixture-token");
    return "fixture-token";
  });
}

describe("actual Discord Gateway cleanup and acknowledgement policy", () => {
  for (const callbackType of ["ready", "disconnected"] as const) {
    for (const fails of [false, true]) {
      it(`joins admitted ${callbackType} callback ${fails ? "uncertainty" : "completion"} before listener settlement`, async () => {
        const login = localLogin();
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const original = new Error("lifecycle callback outcome unknown");
        const callback = vi.fn(async (event: { type: string }) => {
          if (event.type !== callbackType) return;
          entered();
          await pending;
          if (fails) throw original;
        });
        const value = adapter(callback);
        const abort = new AbortController();
        const { listener } = await start(value, abort.signal);
        let settled = false;
        const outcome = listener.then(
          () => { settled = true; return null; },
          (error) => { settled = true; return error; },
        );
        try {
          await vi.waitFor(() => expect(clients).toHaveLength(1));
          if (callbackType === "ready") clients[0].emit(Events.ShardReady, 0, new Set());
          else clients[0].emit(Events.ShardDisconnect, { code: 1000 } as never, 0);
          await started;
          abort.abort();
          await vi.waitFor(() => expect(clients[0].token).toBeNull());
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(false);
          expect(value.paperclipGatewayCleanupFailed).toBe(false);
        } finally {
          abort.abort();
          release();
          await outcome;
        }
        const result = await outcome;
        if (fails) {
          expect(result).toBeInstanceOf(AggregateError);
          expect(result.errors).toContain(original);
          expect(value.paperclipGatewayCleanupFailed).toBe(true);
          await expect(value.startGatewayListener({ waitUntil: () => {} }, 1)).rejects.toThrow("cleanup remains uncertain");
        } else {
          expect(result).toBeNull();
          expect(value.paperclipGatewayCleanupFailed).toBe(false);
        }
        expect(callback.mock.calls.filter(([event]) => event.type === callbackType)).toHaveLength(1);
        expect(login).toHaveBeenCalledOnce();
      });
    }
  }

  for (const fails of [false, true]) {
    it(`joins admitted partial reaction fetch and application ${fails ? "failure" : "completion"}`, async () => {
      localLogin();
      const value = adapter();
      let releaseFetch!: () => void;
      const fetchPending = new Promise<void>((resolve) => { releaseFetch = resolve; });
      let releaseProcess!: () => void;
      const processPending = new Promise<void>((resolve) => { releaseProcess = resolve; });
      const failure = new Error("reaction callback outcome unknown");
      const handle = vi.spyOn(value as never as { handleGatewayReaction(): Promise<void> }, "handleGatewayReaction")
        .mockImplementation(async () => { await processPending; if (fails) throw failure; });
      const reaction = { partial: true, fetch: vi.fn(async () => { await fetchPending; return { partial: false, message: { id: "message", channelId: "channel" } }; }), message: { id: "message", guild: { shardId: 0 }, channelId: "channel" }, emoji: { name: "ok" } };
      const user = { id: "user", partial: false, bot: false, username: "fixture" };
      const abort = new AbortController();
      const { listener } = await start(value, abort.signal);
      let settled = false;
      const outcome = listener.then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
      try {
        await vi.waitFor(() => expect(clients).toHaveLength(1));
        clients[0].emit(Events.MessageReactionAdd, reaction as never, user as never, {} as never);
        await vi.waitFor(() => expect(reaction.fetch).toHaveBeenCalledOnce());
        abort.abort();
        await vi.waitFor(() => expect(clients[0].token).toBeNull());
        expect(settled).toBe(false);
        releaseFetch();
        await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        clients[0].emit(Events.MessageReactionAdd, reaction as never, user as never, {} as never);
        expect(reaction.fetch).toHaveBeenCalledOnce();
      } finally {
        abort.abort(); releaseFetch(); releaseProcess();
        await outcome;
      }
      const result = await outcome;
      if (fails) {
        expect(result).toBeInstanceOf(AggregateError);
        expect(value.paperclipGatewayCleanupFailed).toBe(true);
        await expect(value.startGatewayListener({ waitUntil: () => {} }, 1)).rejects.toThrow("cleanup remains uncertain");
      } else expect(result).toBeNull();
      expect(handle).toHaveBeenCalledOnce();
    });
  }

  it("joins configured webhook forwarding and retains its original failure without replay", async () => {
    localLogin();
    const value = adapter();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const failure = new Error("forwarding outcome unknown");
    const forward = vi.spyOn(value as never as { forwardGatewayEvent(): Promise<void> }, "forwardGatewayEvent")
      .mockImplementation(async () => { await pending; throw failure; });
    const abort = new AbortController();
    let listener!: Promise<unknown>;
    await value.startGatewayListener({ waitUntil: (task) => { listener = Promise.resolve(task); } }, 1, abort.signal, "https://fixture.invalid/hook");
    let settled = false;
    const outcome = listener.then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(clients).toHaveLength(1));
      clients[0].emit(Events.Raw, { t: "READY", d: {} });
      await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce());
      abort.abort();
      await vi.waitFor(() => expect(clients[0].token).toBeNull());
      expect(settled).toBe(false);
      clients[0].emit(Events.Raw, { t: "READY", d: {} });
    } finally { abort.abort(); release(); await outcome; }
    const result = await outcome;
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toContain(failure);
    expect(forward).toHaveBeenCalledOnce();
    expect(value.paperclipGatewayCleanupFailed).toBe(true);
  });

  for (const destroyFails of [false, true]) {
    it(`cleans up synchronous handler setup failure with ${destroyFails ? "retained teardown uncertainty" : "successful teardown"}`, async () => {
      const original = new Error("handler setup failed after client construction");
      const cleanup = new Error("setup cleanup outcome unknown");
      const value = adapter();
      let selected!: Client;
      vi.spyOn(value as never as { setupLegacyGatewayHandlers(client: Client): () => void }, "setupLegacyGatewayHandlers")
        .mockImplementation((client) => {
          selected = client;
          clients.push(client);
          client.token = "fixture-token";
          client.rest.setToken("fixture-token");
          if (destroyFails) vi.spyOn(client, "destroy").mockRejectedValue(cleanup);
          throw original;
        });
      const login = vi.spyOn(Client.prototype, "login");
      const result = await (await start(value)).listener.catch((error) => error);
      expect(login).not.toHaveBeenCalled();
      expect(selected.token).toBeNull();
      await expect((selected.rest as unknown as { resolveRequest(input: unknown): Promise<unknown> }).resolveRequest({ fullRoute: "/users/@me", method: "GET" })).rejects.toThrow("none was present");
      if (destroyFails) {
        expect(result).toBeInstanceOf(AggregateError);
        expect(result.errors).toEqual([original, cleanup]);
        expect(value.paperclipGatewayCleanupFailed).toBe(true);
        await expect(value.startGatewayListener({ waitUntil: () => {} }, 1)).rejects.toThrow("cleanup remains uncertain");
      } else {
        expect(result).toBe(original);
        expect(value.paperclipGatewayCleanupFailed).toBe(false);
      }
    });
  }

  it("preserves original login failure before failed lifecycle failure notification", async () => {
    const original = new Error("original login failure");
    const notification = new Error("failure notification outcome unknown");
    const login = vi.spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
      clients.push(this);
      throw original;
    });
    const value = adapter(async (event) => { if (event.type === "failure") throw notification; });
    const { listener } = await start(value);
    const result = await listener.catch((error) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors[0]).toBe(original);
    expect(result.errors).toContain(notification);
    expect(value.paperclipGatewayCleanupFailed).toBe(true);
    expect(clients[0].token).toBeNull();
    await expect(value.startGatewayListener({ waitUntil: () => {} }, 1)).rejects.toThrow("cleanup remains uncertain");
    expect(login).toHaveBeenCalledOnce();
  });

  it("latches actual destroy failure, attempts independent cleanup and refuses a successor", async () => {
    const login = localLogin();
    const failure = new Error("websocket teardown unknown");
    const value = adapter();
    const cleanup = vi.fn(() => { throw new Error("handler cleanup failed"); });
    vi.spyOn(value as never as { setupLegacyGatewayHandlers: () => () => void }, "setupLegacyGatewayHandlers").mockReturnValue(cleanup);
    vi.spyOn(Client.prototype, "destroy").mockRejectedValueOnce(failure);
    const { listener } = await start(value);
    const error = await listener.catch((reason) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(failure);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(value.paperclipGatewayCleanupFailed).toBe(true);
    expect(clients[0].token).toBeNull();
    await expect((clients[0].rest as unknown as { resolveRequest(input: unknown): Promise<unknown> }).resolveRequest({ fullRoute: "/users/@me", method: "GET" })).rejects.toThrow("none was present");
    await expect(value.startGatewayListener({ waitUntil: () => {} }, 1)).rejects.toThrow("cleanup remains uncertain");
    expect(login).toHaveBeenCalledOnce();
  });

  it("retains failed actual Client cleanup inside login and prevents adapter successor use", async () => {
    const connectFailure = new Error("connect failed before cleanup");
    const destroyFailure = new Error("actual websocket cleanup unknown");
    const value = adapter();
    let websocketDestroy!: ReturnType<typeof vi.spyOn>;
    let selected!: Client;
    const legacyCleanup = vi.fn();
    vi.spyOn(value as never as { setupLegacyGatewayHandlers(client: Client): () => void }, "setupLegacyGatewayHandlers")
      .mockImplementation((client) => {
        selected = client;
        clients.push(client);
        vi.spyOn(client.ws, "connect").mockRejectedValue(connectFailure);
        websocketDestroy = vi.spyOn(client.ws, "destroy").mockRejectedValue(destroyFailure);
        return legacyCleanup;
      });
    const first = await start(value);
    const error = await first.listener.catch((reason) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect(value.paperclipGatewayCleanupFailed).toBe(true);
    expect(legacyCleanup).toHaveBeenCalledOnce();
    expect(selected.token).toBeNull();
    await expect((selected.rest as unknown as { resolveRequest(input: unknown): Promise<unknown> }).resolveRequest({ fullRoute: "/users/@me", method: "GET" })).rejects.toThrow("none was present");
    const cleanup = selected.destroy();
    expect(selected.destroy()).toBe(cleanup);
    await expect(cleanup).rejects.toMatchObject({ errors: [destroyFailure] });
    expect(websocketDestroy).toHaveBeenCalledOnce();
    await expect(value.startGatewayListener({ waitUntil: () => {} }, 1)).rejects.toThrow("cleanup remains uncertain");
    expect(clients).toHaveLength(1);
    // Both connect and retained cleanup failures remain inspectable, not masked.
    expect(error.errors[0].errors[0]).toBe(connectFailure);
  });

  it("retains successful actual Client destruction without repeating underlying cleanup", async () => {
    const client = new Client({ intents: [] });
    clients.push(client);
    const websocketDestroy = vi.spyOn(client.ws, "destroy");
    const first = client.destroy();
    await first;
    expect(client.destroy()).toBe(first);
    await client.destroy();
    expect(websocketDestroy).toHaveBeenCalledOnce();
    expect(client.token).toBeNull();
  });

  it("allows another session after an ordinary login failure with successful cleanup", async () => {
    const failure = new Error("transient login failure");
    vi.spyOn(Client.prototype, "login").mockImplementationOnce(async function (this: Client) { clients.push(this); throw failure; })
      .mockImplementation(async function (this: Client) { clients.push(this); return "fixture-token"; });
    const value = adapter();
    const first = await start(value);
    await expect(first.listener).rejects.toBe(failure);
    expect(value.paperclipGatewayCleanupFailed).toBe(false);
    await (await start(value)).listener;
    expect(clients).toHaveLength(2);
  });

  for (const rejectLogin of [false, true]) {
    it(`joins pending login after resource shutdown before ${rejectLogin ? "session rejection" : "cleanup success"}`, async () => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let destroyed!: () => void;
      const stopped = new Promise<void>((resolve) => { destroyed = resolve; });
      const failure = new Error("late ordinary login rejection");
      const login = vi.spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
        clients.push(this);
        entered();
        await pending;
        if (rejectLogin) throw failure;
        return "fixture-token";
      });
      const actualDestroy = Client.prototype.destroy;
      vi.spyOn(Client.prototype, "destroy").mockImplementation(async function (this: Client) {
        await actualDestroy.call(this);
        destroyed();
      });
      const value = adapter();
      const abort = new AbortController();
      const { listener } = await start(value, abort.signal);
      let settled = false;
      const outcome = listener.then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
      await started;
      abort.abort();
      await stopped;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(login).toHaveBeenCalledOnce();
      expect(value.paperclipGatewayCleanupFailed).toBe(false);
      release();
      expect(await outcome).toBe(rejectLogin ? failure : null);
      expect(value.paperclipGatewayCleanupFailed).toBe(false);
    });
  }

  it("configures actual REST to refuse hidden uncertain acknowledgement retries and rate waits", async () => {
    localLogin();
    await (await start(adapter())).listener;
    const rest = clients[0].rest;
    expect(rest.options.retries).toBe(0);
    expect(typeof rest.options.rejectOnRateLimit).toBe("function");
    const failure = Object.assign(new Error("acknowledgement transport unknown"), { name: "AbortError" });
    const request = vi.fn(async () => { throw failure; });
    rest.options.makeRequest = request;
    await expect(rest.post("/interactions/12345678901234567/fixture-token/callback", { auth: false, body: { type: 5 } })).rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();
    request.mockImplementation(async () => new Response("", { status: 429, headers: { "retry-after": "600" } }) as never);
    const rateLimit = await rest.post("/interactions/22345678901234567/fixture-token/callback", { auth: false, body: { type: 5 } }).catch((error) => error);
    expect(rateLimit.constructor.name).toBe("RateLimitError");
    expect(rateLimit.route).toContain("/interactions/");
    expect(rateLimit.retryAfter).toBeGreaterThanOrEqual(600_000);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
