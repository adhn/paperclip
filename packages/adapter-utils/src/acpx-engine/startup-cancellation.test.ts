import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";
import type { CommandManagedDuplexChannel, CommandManagedRuntimeRunner } from "../command-managed-runtime.js";
import { AcpxStartupCleanupError, AcpxStartupCancellationError, cancellableSandboxStartup } from "./startup-cancellation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const result = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
function fixture(stop = vi.fn(async () => {}), extra: Partial<CommandManagedRuntimeRunner> = {}) {
  const controller = new AbortController();
  const execute = vi.fn(async () => result);
  const ctx = {
    signal: controller.signal, stopRemoteStartup: stop,
    executionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", runner: { execute, ...extra } },
  } as unknown as AdapterExecutionContext;
  const startup = cancellableSandboxStartup(ctx);
  const runner = (startup.context.executionTarget as { runner: CommandManagedRuntimeRunner }).runner;
  return { controller, execute, stop, startup, runner };
}

describe("sandbox startup cancellation boundary", () => {
  it("keeps ownership until the stop callback returns, including an early command error", async () => {
    const receipt = deferred<void>();
    const command = deferred<typeof result>();
    const f = fixture(vi.fn(() => receipt.promise));
    f.execute.mockReturnValue(command.promise);
    let settled = false;
    const outcome = f.runner.execute({ command: "setup" }).catch(error => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.controller.abort(new Error("Stopped"));
    command.reject(new Error("socket closed"));
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    receipt.resolve();
    const cancellation = await outcome;
    expect(cancellation).toBeInstanceOf(AcpxStartupCancellationError);
    expect(AcpxStartupCancellationError.inspect(cancellation)?.orderedFailures).toEqual([new Error("socket closed"), new Error("Stopped")]);
    await expect(f.startup.finish()).rejects.toThrow("Sandbox startup was canceled.");
    await expect(f.runner.execute({ command: "late setup" })).rejects.toThrow("Sandbox startup was canceled.");
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("does not abandon a hung command when the stop callback fails", async () => {
    const command = deferred<typeof result>();
    const f = fixture(vi.fn(async () => { throw new Error("stop unverified"); }));
    f.execute.mockReturnValue(command.promise);
    let settled = false;
    const outcome = f.runner.execute({ command: "setup" }).catch(error => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.controller.abort();
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    command.resolve(result);
    expect(await outcome).toEqual(new Error("stop unverified"));
    await expect(f.startup.finish()).rejects.toThrow("stop unverified");
  });

  it("waits for all parallel setup requests after an unverified stop", async () => {
    const first = deferred<typeof result>();
    const second = deferred<typeof result>();
    const f = fixture(vi.fn(async () => { throw new Error("stop unverified"); }));
    f.execute.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let settled = false;
    const a = f.runner.execute({ command: "first" }).catch(error => error).finally(() => { settled = true; });
    const b = f.runner.execute({ command: "second" }).catch(error => error);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
    f.controller.abort();
    first.reject(new Error("first failed"));
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    second.resolve(result);
    const error = await a;
    expect(error).toBeInstanceOf(AcpxStartupCleanupError);
    expect(AcpxStartupCleanupError.inspect(error)?.orderedFailures).toEqual([new Error("first failed"), new Error("stop unverified")]);
    expect(await b).toBe(error);
    await expect(f.startup.finish()).rejects.toBe(error);
  });

  it("disarms after successful startup and leaves ordinary turn cancellation alone", async () => {
    const f = fixture();
    await f.runner.execute({ command: "setup" });
    await f.startup.finish();
    f.controller.abort();
    await expect(f.runner.execute({ command: "normal turn cleanup" })).resolves.toEqual(result);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("never starts a command when cancellation arrives before setup", async () => {
    const f = fixture();
    f.controller.abort(new Error("Stopped"));
    await expect(f.runner.execute({ command: "setup" })).rejects.toThrow("Sandbox startup was canceled.");
    await expect(f.startup.finish()).rejects.toThrow("Sandbox startup was canceled.");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("closes a duplex route returned after startup was cancelled", async () => {
    const opening = deferred<CommandManagedDuplexChannel>();
    const channel = {
      write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), stop: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const openDuplexChannel = vi.fn(() => opening.promise);
    const f = fixture(vi.fn(async () => {}), { openDuplexChannel });
    const outcome = f.runner.openDuplexChannel!({ command: ["agent"] }).catch(error => error);
    await vi.waitFor(() => expect(openDuplexChannel).toHaveBeenCalledOnce());
    f.controller.abort(new Error("Stopped"));
    expect(await outcome).toBeInstanceOf(AcpxStartupCancellationError);
    opening.resolve(channel);
    await vi.waitFor(() => expect(channel.close).toHaveBeenCalledOnce());
    await expect(f.startup.finish()).rejects.toThrow("Sandbox startup was canceled.");
  });

  it("does not stop another run's runner", async () => {
    const a = fixture();
    const b = fixture();
    a.controller.abort(new Error("Stopped"));
    await expect(a.startup.finish()).rejects.toThrow("Sandbox startup was canceled.");
    await expect(b.runner.execute({ command: "setup" })).resolves.toEqual(result);
    await b.startup.finish();
    expect(b.stop).not.toHaveBeenCalled();
  });
});


describe("startup cancellation diagnostic custody", () => {
  it("preserves exact private reason while finish and stopped RPCs expose only a fixed error", async () => {
    const f = fixture(), original = new Error("private startup token /credential/location");
    f.controller.abort(original);
    const error = await f.startup.finish().catch(error => error);
    expect(error).toBeInstanceOf(AcpxStartupCancellationError);
    expect(AcpxStartupCancellationError.inspect(error)?.originalReason).toBe(original);
    const late = await f.runner.execute({ command: "not admitted" }).catch(error => error);
    expect(late).toBe(error);
    expect(f.execute).not.toHaveBeenCalled();
    const publicFields = JSON.stringify(error) + Object.getOwnPropertyNames(error).map(key => String(error[key])).join(" ");
    expect(publicFields).not.toContain("private startup token"); expect(publicFields).not.toContain("/credential/location");
    expect(Object.getOwnPropertyNames(error)).not.toContain("cause");
  });
});


describe("startup cancellation original causal outcomes", () => {
  it.each(["error", "undefined"] as const)("joins all admitted callbacks and preserves original %s before failed stop", async kind => {
    const command = deferred<typeof result>(), sibling = deferred<typeof result>(), stop = deferred<void>();
    const original = kind === "undefined" ? undefined : new Error("private original callback credential"), stopError = new Error("private stop callback credential");
    const f = fixture(vi.fn(() => stop.promise));
    f.execute.mockReturnValueOnce(command.promise).mockReturnValueOnce(sibling.promise);
    let settled = false;
    const a = f.runner.execute({ command: "original" }).catch(error => error).finally(() => { settled = true; });
    const b = f.runner.execute({ command: "sibling" }).catch(error => error);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
    f.controller.abort(new Error("private cancellation reason"));
    command.reject(original);
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    stop.reject(stopError);
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    sibling.resolve(result);
    const error = await a;
    expect(error).toBeInstanceOf(AcpxStartupCleanupError);
    expect(AcpxStartupCleanupError.inspect(error)?.orderedFailures).toEqual([original, stopError]);
    expect(await b).toBe(error);
    await expect(f.startup.finish()).rejects.toBe(error);
    await expect(f.runner.execute({ command: "no replay" })).rejects.toBe(error);
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.stop).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(error) + Object.getOwnPropertyNames(error).map(key => String(error[key])).join(" ");
    expect(serialized).not.toContain("private original callback"); expect(serialized).not.toContain("private stop callback");
    expect(Object.getOwnPropertyNames(error)).not.toContain("cause"); expect(Object.getOwnPropertyNames(error)).not.toContain("errors");
  });
  it("preserves sole undefined stop failure without inventing an aggregate", async () => {
    const command = deferred<typeof result>(), stop = deferred<void>();
    const f = fixture(vi.fn(() => stop.promise)); f.execute.mockReturnValue(command.promise);
    const outcome = f.runner.execute({ command: "only callback" }); void outcome.catch(() => {});
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.controller.abort(); stop.reject(undefined); command.resolve(result);
    await expect(outcome).rejects.toBeUndefined();
    await expect(f.startup.finish()).rejects.toBeUndefined();
  });
  it("preserves a late RPC undefined rejection privately before the acknowledged-stop cancellation reason", async () => {
    const command = deferred<typeof result>(), originalReason = new Error("private original cancellation reason");
    const f = fixture(); f.execute.mockReturnValue(command.promise);
    const outcome = f.runner.execute({ command: "late outcome" }).catch(error => error);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce()); f.controller.abort(originalReason);
    const error = await outcome;
    expect(error).toBeInstanceOf(AcpxStartupCancellationError);
    command.reject(undefined);
    await vi.waitFor(() => expect(AcpxStartupCancellationError.inspect(error)?.orderedFailures).toEqual([undefined, originalReason]));
    expect(AcpxStartupCancellationError.inspect(error)?.originalReason).toBe(originalReason);
    await expect(f.startup.finish()).rejects.toBe(error);
  });

});


describe("admitted startup RPC custody after stop callback acknowledgment", () => {
  it("retains exact pending original RPC and late returned value without replay", async () => {
    const command = deferred<typeof result>(), value = { ...result, stdout: "private late runtime resource" };
    const f = fixture(); f.execute.mockReturnValue(command.promise);
    const pending = f.runner.execute({ command: "admitted" }).catch(error => error);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce()); f.controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(AcpxStartupCancellationError);
    expect(AcpxStartupCancellationError.inspect(error)?.operations[0]?.originalRpc).toBe(command.promise);
    expect(AcpxStartupCancellationError.inspect(error)?.operations[0]?.outcome.status).toBe("pending");
    command.resolve(value);
    await vi.waitFor(() => expect(AcpxStartupCancellationError.inspect(error)?.operations[0]?.outcome).toEqual({ status: "fulfilled", value }));
    await expect(f.runner.execute({ command: "no replay" })).rejects.toBe(error);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(error)).not.toContain("private late runtime resource");
  });
  it.each(["error", "undefined"] as const)("retains actual late channel before its %s close failure", async kind => {
    const opening = deferred<CommandManagedDuplexChannel>(), closing = deferred<void>();
    const failure = kind === "undefined" ? undefined : new Error("private late channel close failure");
    const channel = { write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), stop: vi.fn(), close: vi.fn(() => closing.promise) };
    const open = vi.fn(() => opening.promise), f = fixture(vi.fn(async () => {}), { openDuplexChannel: open });
    const pending = f.runner.openDuplexChannel!({ command: ["agent"] }).catch(error => error);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce()); f.controller.abort();
    const error = await pending;
    opening.resolve(channel);
    await vi.waitFor(() => expect(channel.close).toHaveBeenCalledOnce());
    expect(AcpxStartupCancellationError.inspect(error)?.operations[0]?.originalRpc).toBe(opening.promise);
    expect(AcpxStartupCancellationError.inspect(error)?.operations[0]?.resources).toEqual([channel]);
    expect(AcpxStartupCancellationError.inspect(error)?.operations[0]?.outcome.status).toBe("pending");
    closing.reject(failure);
    await vi.waitFor(() => expect(AcpxStartupCancellationError.inspect(error)?.operations[0]?.outcome).toEqual({ status: "rejected", reason: failure }));
    expect(AcpxStartupCancellationError.inspect(error)?.orderedFailures[0]).toBe(failure);
    await expect(f.startup.finish()).rejects.toBe(error);
    expect(open).toHaveBeenCalledOnce(); expect(channel.close).toHaveBeenCalledOnce();
  });
});


describe("actual startup instance recovery inspection", () => {
  it("retains real submitted success and sole undefined stop failure without a primitive-key registry", async () => {
    const rpc = Promise.resolve(result), stop = deferred<void>();
    const f = fixture(vi.fn(() => stop.promise)); f.execute.mockReturnValue(rpc);
    await f.runner.execute({ command: "actual completed setup" });
    f.controller.abort(); await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce()); stop.reject(undefined);
    await expect(f.startup.finish()).rejects.toBeUndefined();
    const facts = f.startup.inspect();
    expect(facts.operations[0]?.originalRpc).toBe(rpc); expect(facts.operations[0]?.outcome).toEqual({ status: "fulfilled", value: result });
    expect(facts.stopAttempt).toBeInstanceOf(Promise); expect(facts.stopOutcome).toEqual({ status: "rejected", reason: undefined });
    expect(facts.recoveryLeases).toEqual([]); expect(Object.isFrozen(facts)).toBe(true); expect(Object.isFrozen(facts.operations)).toBe(true);
  });
  it("returns no fabricated owner operations when cancellation integration is inactive", () => {
    const startup = cancellableSandboxStartup({} as AdapterExecutionContext);
    expect(startup.inspect()).toEqual({ operations: [], recoveryLeases: [], stopAttempt: null, stopOutcome: { status: "not-started" } });
  });
});
