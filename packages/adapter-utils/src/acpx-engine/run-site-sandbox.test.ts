// Tests for the sandbox run site (Phase 19).
//
// The sandbox site owns staging, the staging lease, both bridges, the launch-
// environment contribution, and sync-back. These tests drive the site in
// isolation with fakes: they pin the ledger registrations, the bridge overlap and
// the callback-environment sequencing point, the staged-files reuse (which still
// creates the runtime), the synchronous plan, and Amendment B — no run-scoped
// contribution or bridge token escapes into the ledger or the reuse payload.

import { describe, expect, it, vi } from "vitest";
import {
  createSandboxRunSite,
  inspectStagingLeaseRetention,
  AcpxStagedRuntimeCleanupError,
  AcpxBridgeStartupError,
  AcpxStagingWaitAbortedError,
  type ManagedHomeSeamResult,
  type SandboxRunSiteOptions,
  type StagedRuntimeStoreEntry,
} from "./run-site-sandbox.js";
import { AcpxStartupCancellationError, cancellableSandboxStartup } from "./startup-cancellation.js";
import type {
  AcpRunContext,
  AcquiredRunResources,
  LaunchEnvironmentContribution,
  ReadyRunResources,
  ResourceId,
  RunResourceRegistration,
  SandboxReuseCandidate,
  StagedRuntimeResource,
} from "./run-contracts.js";
import type { PreparedAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";

function makeStagedRuntime(id: string): PreparedAdapterExecutionTargetRuntime {
  return {
    runtimeRootDir: `/remote/${id}/.paperclip-runtime/acpx`,
    additionalSourceDirs: {},
    additionalSourceFailures: [],
  } as unknown as PreparedAdapterExecutionTargetRuntime;
}

function makeLedger(): { ledger: AcquiredRunResources; registered: RunResourceRegistration[] } {
  const registered: RunResourceRegistration[] = [];
  const ledger: AcquiredRunResources = {
    register(registration) {
      registered.push(registration as RunResourceRegistration);
    },
    seal() {
      throw new Error("seal is not exercised by these unit tests");
    },
    takeForSettlement() {
      throw new Error("takeForSettlement is not exercised by these unit tests");
    },
  };
  return { ledger, registered };
}

function makeContext(sessionKey: string): AcpRunContext {
  return { sessionKey } as unknown as AcpRunContext;
}

/** Build a site over injectable fakes. Every option has a sensible default. */
function makeSite(overrides: Partial<SandboxRunSiteOptions> = {}) {
  const { ledger, registered } = makeLedger();
  const env: Record<string, string> = { BASE: "1" };
  const stagedRuntimes = new Map<string, StagedRuntimeStoreEntry>();
  const stagingLocks = new Map<string, Promise<unknown>>();
  const freshStaged = makeStagedRuntime("fresh");
  const bridgeCalls: string[] = [];
  const options: SandboxRunSiteOptions = {
    ledger,
    stagedRuntimes,
    stagingLocks,
    now: () => 1000,
    idleMs: 60_000,
    sessionCwd: "/remote/workspace",
    spawnCwd: "/host/workspace",
    target: { kind: "remote" } as unknown as SandboxRunSiteOptions["target"],
    env,
    isCompatibleResume: false,
    stage: async () => freshStaged,
    seedManagedHome: async (stage) => {
      const stagedRuntime = await stage([]);
      // Repoint a managed-home env var, so the site captures the delta.
      env.CODEX_HOME = "/remote/home";
      return {
        stagedRuntime,
        teardown: async () => ({ ok: true }),
        dispose: async () => {},
      } satisfies ManagedHomeSeamResult;
    },
    disposeFreshStagedRuntime: async () => {},
    measureStageStep: (run) => run(),
    publishStagedProjectHints: () => {},
    onReuseLog: async () => {},
    startPaperclipBridge: async () => {
      bridgeCalls.push("paperclip:start");
      return { env: { PAPERCLIP_API_KEY: "run-token" }, stop: async () => {} } as never;
    },
    startProcessSessionBridge: async ({ launchEnv }) => {
      bridgeCalls.push("process-session:start");
      await launchEnv();
      return { agentCommand: null, stop: async () => {} } as never;
    },
    measureBridgeStep: (_step, run) => run(),
    finalizeLaunchEnv: (contributions) => {
      const merged = { ...env };
      for (const contribution of contributions) Object.assign(merged, contribution.env);
      return merged;
    },
    onPaperclipBridgeLog: async () => {},
    stopBridges: async () => {},
    ...overrides,
  };
  const site = createSandboxRunSite(options);
  return { site, ledger, registered, env, stagedRuntimes, stagingLocks, freshStaged, bridgeCalls, options };
}

/** A minimal `ReadyRunResources` that resolves a single staged runtime. */
function makeReady(stagedRuntime: PreparedAdapterExecutionTargetRuntime): ReadyRunResources {
  const staged: StagedRuntimeResource = { stagedRuntime, disposeStaged: async () => {} };
  return {
    get: (id: ResourceId) => (id === "staged_runtime" ? staged : undefined),
    scopeOf: () => undefined,
    has: (id: ResourceId) => id === "staged_runtime",
    sealed: ["staged_runtime"],
  } as unknown as ReadyRunResources;
}

describe("sandbox run site", () => {
  it("test_sandbox_site_registers_staging_bridges_and_lease_in_ledger", async () => {
    const { site, registered } = makeSite();
    await site.placeWorkspace(makeContext("paperclip:c:a:t:fp"));
    await site.startTransport(makeContext("paperclip:c:a:t:fp"));

    const byId = new Set(registered.map((entry) => entry.id));
    // Staging registers the staged runtime, the managed-home copy-back, and the
    // per-session staging lease. Both bridge starts register their handles.
    expect(byId).toEqual(
      new Set<ResourceId>(["staged_runtime", "managed_home", "staging_lease", "control_bridge", "agent_bridge"]),
    );
    // The staged runtime is startup-rollback until a clean turn promotes it; the
    // copy-back, the lease, and the bridges live through the whole run.
    const scopeOf = (id: ResourceId) => registered.find((entry) => entry.id === id)?.scope;
    expect(scopeOf("staged_runtime")).toBe("startup_rollback");
    expect(scopeOf("managed_home")).toBe("per_run");
    expect(scopeOf("staging_lease")).toBe("per_run");
    expect(scopeOf("control_bridge")).toBe("per_run");
    expect(scopeOf("agent_bridge")).toBe("per_run");
  });

  it("test_sandbox_site_place_workspace_carries_referenced_project_failure_reason", async () => {
    // A referenced project that fails to stage carries its failure reason back on
    // the placed-workspace result, so a reader of the run learns why it dropped.
    const failedStaged = {
      runtimeRootDir: "/remote/fail/.paperclip-runtime/acpx",
      additionalSourceDirs: {},
      additionalSourceFailures: [{ projectId: "proj-x", error: "extract failed: boom" }],
    } as unknown as PreparedAdapterExecutionTargetRuntime;
    const { site } = makeSite({ stage: async () => failedStaged });

    const placed = await site.placeWorkspace(makeContext("s"));

    expect(placed).toEqual({
      referencedProjectStagingFailures: [{ projectId: "proj-x", error: "extract failed: boom" }],
    });
  });

  it("test_sandbox_site_preserves_bridge_overlap_and_callback_sequencing", async () => {
    const events: string[] = [];
    let releasePaperclip!: () => void;
    const paperclipGate = new Promise<void>((resolve) => {
      releasePaperclip = resolve;
    });
    let processLaunchEnv: Record<string, string> | null = null;
    const { site } = makeSite({
      startPaperclipBridge: async () => {
        events.push("paperclip:start");
        await paperclipGate;
        events.push("paperclip:env-ready");
        return { env: { PAPERCLIP_API_KEY: "run-token" }, stop: async () => {} } as never;
      },
      startProcessSessionBridge: async ({ launchEnv }) => {
        events.push("process-session:start");
        // The launch awaits the sequencing point, so it observes the merged env.
        processLaunchEnv = await launchEnv();
        events.push("process-session:launch");
        return { agentCommand: null, stop: async () => {} } as never;
      },
    });

    await site.placeWorkspace(makeContext("s"));
    const transportPromise = site.startTransport(makeContext("s"));
    // Both bridges start before the paperclip env resolves: their setup overlaps.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain("paperclip:start");
    expect(events).toContain("process-session:start");
    expect(events).not.toContain("process-session:launch");

    // Release the paperclip env; the process-session launch now observes the
    // merged run-scoped env (the single sequencing point).
    releasePaperclip();
    const transport = await transportPromise;
    expect(events.indexOf("paperclip:env-ready")).toBeLessThan(events.indexOf("process-session:launch"));
    expect(processLaunchEnv).toEqual({ BASE: "1", CODEX_HOME: "/remote/home", PAPERCLIP_API_KEY: "run-token" });
    expect(transport.launchEnv).toEqual(processLaunchEnv);
  });

  it("test_sandbox_site_session_new_starts_only_after_the_sync_barrier_settles", async () => {
    // The staging step wraps the inbound sync coordinator. Hold it open with a
    // gate, so the sync barrier stays unsettled. `placeWorkspace` awaits staging,
    // so it stays pending while the gate is held.
    let releaseStaging!: () => void;
    const stagingGate = new Promise<void>((resolve) => {
      releaseStaging = resolve;
    });
    const freshStaged = makeStagedRuntime("fresh");
    const { site, bridgeCalls } = makeSite({
      stage: async () => {
        await stagingGate;
        return freshStaged;
      },
    });

    // Drive the real run order: the engine awaits `placeWorkspace`, then starts the
    // transport. `startProcessSessionBridge` models the ACP `session/new` startup.
    let placed = false;
    const run = (async () => {
      await site.placeWorkspace(makeContext("s"));
      placed = true;
      await site.startTransport(makeContext("s"));
    })();
    run.catch(() => undefined);

    // The sync barrier is still open, so `placeWorkspace` has not resolved and the
    // process-session bridge that starts `session/new` has not started.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(placed).toBe(false);
    expect(bridgeCalls).not.toContain("process-session:start");

    // Settle the sync barrier. `placeWorkspace` resolves, then the transport starts
    // `session/new`.
    releaseStaging();
    await run;
    expect(placed).toBe(true);
    expect(bridgeCalls).toContain("process-session:start");
  });

  it("test_sandbox_site_borrow_yields_files_and_runtime_is_still_created", async () => {
    const cachedRuntime = makeStagedRuntime("cached");
    const stagedRuntimes = new Map<string, StagedRuntimeStoreEntry>([
      [
        "paperclip:c:a:t:fp",
        {
          stagedRuntime: cachedRuntime,
          envDelta: { CODEX_HOME: "/remote/home" },
          teardown: async () => ({ ok: true }),
          dispose: async () => {},
          lastUsedAt: 500,
        },
      ],
    ]);
    const { site, env } = makeSite({ stagedRuntimes, isCompatibleResume: true });

    // A borrow reads the staged entry without removal, so an overlapping run of
    // the same session still reads it.
    const borrowed = site.reuse().borrow("paperclip:c:a:t:fp");
    expect(borrowed?.stagedRuntime).toBe(cachedRuntime);
    expect(stagedRuntimes.has("paperclip:c:a:t:fp")).toBe(true);

    // A reuse hit yields the staged FILES (not a live runtime): `placeWorkspace`
    // reports `reused` and re-applies the seam env delta, and the reuse candidate
    // names the staged files only. So the run still creates the runtime and runs
    // the handshake against the reused files.
    await site.placeWorkspace(makeContext("paperclip:c:a:t:fp"));
    expect(site.staged?.reused).toBe(true);
    expect(site.staged?.stagedRuntime).toBe(cachedRuntime);
    expect(env.CODEX_HOME).toBe("/remote/home");
    const candidate: SandboxReuseCandidate = site.reuseCandidate(makeReady(cachedRuntime));
    expect(candidate).toEqual({ stagedRuntime: cachedRuntime });
    expect("runtime" in candidate).toBe(false);
    expect("sessionHandle" in candidate).toBe(false);
  });

  it("test_site_plan_supplies_session_cwd_spawn_cwd_and_tracing_before_the_fingerprint_build", () => {
    const { site } = makeSite();
    // `plan()` is synchronous and reads no staged state, so it runs before the
    // fingerprint build. It binds the session to the in-sandbox cwd, redirects the
    // relay-proxy spawn to the host cwd, and enables sandbox tracing.
    expect(site.plan(makeContext("s"))).toEqual({
      sessionCwd: "/remote/workspace",
      spawnCwd: "/host/workspace",
      tracingEnabled: true,
    });
  });

  it("test_bridge_contribution_is_not_retained_by_site_ledger_or_reuse_payload", async () => {
    const { site, registered } = makeSite();
    await site.placeWorkspace(makeContext("s"));
    const transport = await site.startTransport(makeContext("s"));

    // The ledger holds the bridge HANDLES, never the run-scoped token env.
    const control = registered.find((entry) => entry.id === "control_bridge");
    expect(control?.payload).toBe(transport.controlBridge);
    // The staged reuse payload carries the staged files only — no credential
    // material and no bridge token.
    const candidate = site.reuseCandidate(makeReady(site.staged!.stagedRuntime));
    expect(Object.keys(candidate)).toEqual(["stagedRuntime"]);

    // Compile-time (Amendment B): a run-scoped contribution is not assignable to
    // the staged reuse payload. This function never runs; the assertion holds at
    // typecheck only. A runtime call on a synthetic value would crash.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    function _staged_reuse_payload_rejects_a_run_scoped_contribution(
      contribution: LaunchEnvironmentContribution,
    ): void {
      // @ts-expect-error a launch-environment contribution is not a staged reuse payload
      const payload: SandboxReuseCandidate = contribution;
      void payload;
    }
  });
});


describe("sandbox admission failure ownership", () => {
  it.each([undefined, null, false, 0, ""])("refuses a rejected bridge even with falsy reason %s", async reason => {
    let launches = 0;
    const { site } = makeSite({
      startPaperclipBridge: async () => { throw reason; },
      startProcessSessionBridge: async () => null,
      finalizeLaunchEnv: () => { launches++; return {}; },
    });
    await site.placeWorkspace(makeContext("falsy-bridge"));
    const outcome = await site.startTransport(makeContext("falsy-bridge")).then(
      () => ({ rejected: false, reason: "unexpected success" }), error => ({ rejected: true, reason: error }));
    expect(outcome).toEqual({ rejected: true, reason });
    expect(launches).toBe(0);
  });

  it.each([undefined, new Error("private seam marker")])("preserves original seam rejection after successful actual disposal", async original => {
    let disposed: unknown;
    const { site, freshStaged, bridgeCalls } = makeSite({
      seedManagedHome: async stage => { await stage([]); throw original; },
      disposeFreshStagedRuntime: async staged => { disposed = staged; },
    });
    const outcome = await site.placeWorkspace(makeContext("failed-seam")).then(
      () => ({ rejected: false, error: null }), error => ({ rejected: true, error }));
    expect(outcome.rejected).toBe(true); expect(outcome.error).toBe(original);
    expect(disposed).toBe(freshStaged); expect(bridgeCalls).toEqual([]);
  });

  it.each([undefined, new Error("private cleanup marker")])("retains causal seam and disposal failures privately", async cleanup => {
    const original = new Error("private seam marker");
    const { site, freshStaged, bridgeCalls } = makeSite({
      seedManagedHome: async stage => { await stage([]); throw original; },
      disposeFreshStagedRuntime: async () => { throw cleanup; },
    });
    const error = await site.placeWorkspace(makeContext("failed-cleanup")).catch(error => error);
    expect(error).toBeInstanceOf(AcpxStagedRuntimeCleanupError);
    expect(AcpxStagedRuntimeCleanupError.inspect(error)).toEqual({ orderedFailures: [original, cleanup],
      stagedRuntime: freshStaged, runtimeRootDir: freshStaged.runtimeRootDir });
    expect(bridgeCalls).toEqual([]);
    const serialized = JSON.stringify(error) + Object.getOwnPropertyNames(error).map(key => String(error[key])).join(" ");
    expect(serialized).not.toContain("private seam marker"); expect(serialized).not.toContain("private cleanup marker");
    expect(serialized).not.toContain(freshStaged.runtimeRootDir);
    expect(Object.getOwnPropertyNames(error)).not.toContain("cause");
    expect(Object.getOwnPropertyNames(error)).not.toContain("errors");
  });
});


describe("staged unknown cleanup occupancy", () => {
  it("retains stale exact entry and same-key lease after failed actual disposal without staging a successor", async () => {
    let stages = 0, disposals = 0;
    const { site, stagedRuntimes, stagingLocks, options } = makeSite({ stage: async () => { stages++; return makeStagedRuntime("new"); } });
    const old = { stagedRuntime: makeStagedRuntime("old"), envDelta: {}, teardown: null,
      dispose: async () => { disposals++; throw undefined; }, lastUsedAt: 0 };
    stagedRuntimes.set("occupied", old);
    const error = await site.placeWorkspace(makeContext("occupied")).catch(error => error);
    expect(error).toBeInstanceOf(AcpxStagedRuntimeCleanupError);
    expect(stagedRuntimes.get("occupied")).toBe(old); expect(stagingLocks.has("occupied")).toBe(true);
    let successorReturned = false;
    void createSandboxRunSite(options).placeWorkspace(makeContext("occupied")).then(() => { successorReturned = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(successorReturned).toBe(false); expect(stages).toBe(0); expect(disposals).toBe(1);
    // An occupied idle key does not block unrelated keys or trigger another dispose.
    await site.reuse().evictIdle(100000);
    const other = createSandboxRunSite(options);
    await other.placeWorkspace(makeContext("other"));
    expect(stages).toBe(1); expect(disposals).toBe(1);
    other.stagingLeaseRelease?.();
  });
  it("does not release actual lease when stop callback rejects, including a synchronous throw", async () => {
    const { site, stagingLocks } = makeSite({ stopBridges: () => { throw undefined; } });
    await site.placeWorkspace(makeContext("occupied-stop"));
    await site.startTransport(makeContext("occupied-stop"));
    const error = await site.syncBack().catch(error => error);
    expect(error).toBeInstanceOf(AcpxStagedRuntimeCleanupError);
    expect(stagingLocks.has("occupied-stop")).toBe(true);
    site.stagingLeaseRelease?.();
    expect(stagingLocks.has("occupied-stop")).toBe(true);
  });
});


describe("independent bridge rejection facts", () => {
  it("retains both failed starts including undefined without exposing private reasons", async () => {
    const secondary = new Error("private secondary bridge failure");
    const { site } = makeSite({ startPaperclipBridge: async () => { throw undefined; },
      startProcessSessionBridge: async () => { throw secondary; } });
    await site.placeWorkspace(makeContext("both-starts"));
    const error = await site.startTransport(makeContext("both-starts")).catch(error => error);
    expect(error).toBeInstanceOf(AcpxBridgeStartupError);
    expect(AcpxBridgeStartupError.inspect(error)).toEqual([undefined, secondary]);
    expect(JSON.stringify(error)).not.toContain("private secondary");
    site.stagingLeaseRelease?.();
  });
});


describe("queued staging reservation cancellation", () => {
  it.each([false, true])("withdraws only aborted waiter and preserves predecessor ordering (later waiter %s)", async queued => {
    let stages = 0;
    const first = makeSite({ stage: async () => { stages++; return makeStagedRuntime("cancel-stage-" + stages); } });
    await first.site.placeWorkspace(makeContext("cancel-key"));
    const original = first.stagingLocks.get("cancel-key");
    const abort = new AbortController(), reason = new Error("fixture queued request canceled");
    const waiter = createSandboxRunSite({ ...first.options, signal: abort.signal });
    const pending = waiter.placeWorkspace(makeContext("cancel-key"));
    void pending.catch(() => {});
    const successor = queued ? createSandboxRunSite(first.options) : null;
    let nextReturned = false;
    const next = successor?.placeWorkspace(makeContext("cancel-key")).then(() => { nextReturned = true; });
    abort.abort(reason);
    const error = await pending.catch(error => error);
    expect(error).toBeInstanceOf(AcpxStagingWaitAbortedError);
    expect(AcpxStagingWaitAbortedError.inspect(error)).toBe(reason);
    expect(JSON.stringify(error) + error.message).not.toContain(reason.message);
    expect(stages).toBe(1); expect(nextReturned).toBe(false);
    if (!queued) expect(first.stagingLocks.get("cancel-key")).toBe(original);
    first.site.stagingLeaseRelease?.();
    if (next) { await next; expect(stages).toBe(2); successor!.stagingLeaseRelease?.(); }
    expect(first.stagingLocks.size).toBe(0);
  });
  it("does not shortcut actual admitted staging or release its owned resources on caller abort", async () => {
    let finish!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; }), stageEntered = new Promise<void>(resolve => { entered = resolve; });
    const abort = new AbortController();
    const first = makeSite({ signal: abort.signal, stage: async () => { entered(); await gate; return makeStagedRuntime("admitted-before-abort"); } });
    let returned = false;
    const pending = first.site.placeWorkspace(makeContext("admitted-key")).then(() => { returned = true; });
    await stageEntered; abort.abort();
    await Promise.resolve(); await Promise.resolve();
    expect(returned).toBe(false); expect(first.stagingLocks.size).toBe(1);
    finish(); await pending;
    expect(first.stagingLocks.size).toBe(1);
    first.site.stagingLeaseRelease?.(); expect(first.stagingLocks.size).toBe(0);
  });
});


describe("canceled reservation terminal queue bookkeeping", () => {
  it("prunes canceled B/C chain only after A actually releases", async () => {
    const first = makeSite(); await first.site.placeWorkspace(makeContext("chain"));
    const bAbort = new AbortController(), cAbort = new AbortController();
    const b = createSandboxRunSite({ ...first.options, signal: bAbort.signal }).placeWorkspace(makeContext("chain"));
    const c = createSandboxRunSite({ ...first.options, signal: cAbort.signal }).placeWorkspace(makeContext("chain"));
    void b.catch(() => {}); void c.catch(() => {});
    bAbort.abort(); cAbort.abort(); await Promise.allSettled([b, c]);
    expect(first.stagingLocks.size).toBe(1);
    first.site.stagingLeaseRelease?.();
    await vi.waitFor(() => expect(first.stagingLocks.size).toBe(0));
  });
  it("prunes exact restored predecessor that was already released before the waiter canceled", async () => {
    const first = makeSite(); await first.site.placeWorkspace(makeContext("released-before-cancel"));
    const abort = new AbortController();
    const waiter = createSandboxRunSite({ ...first.options, signal: abort.signal }).placeWorkspace(makeContext("released-before-cancel"));
    void waiter.catch(() => {});
    first.site.stagingLeaseRelease?.(); abort.abort();
    await expect(waiter).rejects.toBeInstanceOf(AcpxStagingWaitAbortedError);
    await vi.waitFor(() => expect(first.stagingLocks.size).toBe(0));
  });
  it("normalizes a rejected predecessor without letting a second waiter bypass the first active gate", async () => {
    const first = makeSite();
    const rejected = Promise.reject(new Error("fixture prior queue rejection")); void rejected.catch(() => {});
    first.stagingLocks.set("rejected-key", rejected);
    await first.site.placeWorkspace(makeContext("rejected-key"));
    let entered = false;
    const next = createSandboxRunSite({ ...first.options, stage: async () => { entered = true; return makeStagedRuntime("after-rejected-prev"); } });
    const pending = next.placeWorkspace(makeContext("rejected-key"));
    await Promise.resolve(); await Promise.resolve();
    expect(entered).toBe(false);
    first.site.stagingLeaseRelease?.(); await pending;
    expect(entered).toBe(true); next.stagingLeaseRelease?.();
    expect(first.stagingLocks.size).toBe(0);
  });
  it("refuses preaborted and predecessor-settlement aborted callers before staging", async () => {
    let stages = 0;
    const abort = new AbortController(); abort.abort(new Error("private queued abort cause"));
    const first = makeSite({ signal: abort.signal, stage: async () => { stages++; return makeStagedRuntime("unexpected"); } });
    await expect(first.site.placeWorkspace(makeContext("preaborted"))).rejects.toBeInstanceOf(AcpxStagingWaitAbortedError);
    expect(stages).toBe(0); expect(first.stagingLocks.size).toBe(0);
    const later = new AbortController(); let release!: () => void;
    const previous = new Promise<void>(resolve => { release = resolve; });
    previous.then(() => { later.abort(); });
    first.stagingLocks.set("settlement-abort", previous);
    const site = createSandboxRunSite({ ...first.options, signal: later.signal });
    const pending = site.placeWorkspace(makeContext("settlement-abort"));
    release();
    await expect(pending).rejects.toBeInstanceOf(AcpxStagingWaitAbortedError);
    expect(stages).toBe(0);
    await vi.waitFor(() => expect(first.stagingLocks.size).toBe(0));
  });
});


describe("actual admitted startup callback holds staging ownership", () => {
  it("pins the actual acquired lease and late RPC result after acknowledged-stop cancellation", async () => {
    let complete!: (value: unknown) => void;
    const rpc = new Promise<unknown>(resolve => { complete = resolve; }), execute = vi.fn(() => rpc);
    const abort = new AbortController();
    const startup = cancellableSandboxStartup({ signal: abort.signal, stopRemoteStartup: async () => {},
      executionTarget: { kind: "remote", transport: "sandbox", providerKey: "fixture", runner: { execute } } } as never);
    const runner = (startup.context.executionTarget as { runner: { execute: () => Promise<unknown> } }).runner;
    let stages = 0;
    const first = makeSite({ signal: abort.signal, stage: async () => { stages++; await runner.execute(); return makeStagedRuntime("never-returned-stage"); } });
    const pending = first.site.placeWorkspace(makeContext("admitted-held"));
    void pending.catch(() => {});
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce()); abort.abort();
    const error = await pending.catch(error => error);
    expect(error).toBeInstanceOf(AcpxStagedRuntimeCleanupError);
    const release = first.site.stagingLeaseRelease!;
    expect(release).toBeTypeOf("function");
    expect(inspectStagingLeaseRetention(release)).toBe(error);
    release(); expect(first.stagingLocks.size).toBe(1);
    const resources = AcpxStagedRuntimeCleanupError.inspect(error)!.resources as { startupError: AcpxStartupCancellationError; release: unknown };
    expect(resources.release).toBe(release);
    expect(AcpxStartupCancellationError.inspect(resources.startupError)?.operations[0]?.originalRpc).toBe(rpc);
    const late = { stdout: "private late runtime identity" }; complete(late);
    await vi.waitFor(() => expect(AcpxStartupCancellationError.inspect(resources.startupError)?.operations[0]?.outcome).toEqual({ status: "fulfilled", value: late }));
    const successor = createSandboxRunSite({ ...first.options, signal: undefined });
    void successor.placeWorkspace(makeContext("admitted-held")).catch(() => {});
    await Promise.resolve(); await Promise.resolve();
    expect(stages).toBe(1); expect(first.stagingLocks.size).toBe(1);
    release(); expect(first.stagingLocks.size).toBe(1);
    await expect(startup.finish()).rejects.toBe(resources.startupError);
  });
});


describe("startup cancellation without submitted resource ownership", () => {
  it("does not occupy a lease for a real helper cancellation with zero submitted RPCs", async () => {
    const abort = new AbortController(); abort.abort();
    const execute = vi.fn(async () => ({}));
    const startup = cancellableSandboxStartup({ signal: abort.signal, stopRemoteStartup: async () => {},
      executionTarget: { kind: "remote", transport: "sandbox", providerKey: "fixture", runner: { execute } } } as never);
    const error = await startup.finish().catch(error => error);
    expect(AcpxStartupCancellationError.inspect(error)?.operations).toEqual([]);
    const f = makeSite({ stage: async () => { throw error; } });
    await expect(f.site.placeWorkspace(makeContext("no-submitted-rpc"))).rejects.toBe(error);
    expect(f.stagingLocks.size).toBe(0); expect(execute).not.toHaveBeenCalled();
    expect(AcpxStartupCancellationError.inspect(error)?.recoveryLeases).toEqual([]);
  });
});


describe("actual startup ownership before site callback cleanup", () => {
  it.each(["seed", "reuse"] as const)("retains exact %s resources before ordinary callback failure cleanup", async (phase) => {
    const abort = new AbortController(), callbackError = new Error("private callback failure");
    const value = { stdout: "completed original startup RPC" };
    const execute = vi.fn(async () => value);
    const startup = cancellableSandboxStartup({ signal: abort.signal, stopRemoteStartup: async () => {},
      executionTarget: { kind: "remote", transport: "sandbox", providerKey: "fixture", runner: { execute } } } as never);
    await (startup.context.executionTarget as { runner: { execute: () => Promise<unknown> } }).runner.execute();
    const runtime = makeStagedRuntime(`callback-${phase}`), dispose = vi.fn(async () => {});
    const fail = () => { abort.abort(); throw callbackError; };
    const f = makeSite({ startupRecovery: startup, stage: async () => runtime, disposeFreshStagedRuntime: dispose,
      isCompatibleResume: phase === "reuse",
      seedManagedHome: async stage => { await stage([]); return fail(); }, onReuseLog: async () => fail() });
    if (phase === "reuse") f.stagedRuntimes.set("callback-held", { stagedRuntime: runtime, teardown: null,
      dispose, envDelta: {}, lastUsedAt: 1000 });
    const error = await f.site.placeWorkspace(makeContext("callback-held")).catch(error => error);
    expect(error).toBeInstanceOf(AcpxStagedRuntimeCleanupError);
    const facts = AcpxStagedRuntimeCleanupError.inspect(error)!;
    expect(facts.orderedFailures[0]).toBe(callbackError); expect(facts.stagedRuntime).toBe(runtime);
    const release = f.site.stagingLeaseRelease!;
    expect(inspectStagingLeaseRetention(release)).toBe(error);
    expect((facts.resources as { startupRecovery: unknown; release: unknown }).startupRecovery).toBe(startup);
    expect((facts.resources as { release: unknown }).release).toBe(release);
    expect(startup.inspect().recoveryLeases).toEqual([release]);
    expect(startup.inspect().operations[0]?.outcome).toEqual({ status: "fulfilled", value });
    expect(dispose).not.toHaveBeenCalled(); release(); expect(f.stagingLocks.size).toBe(1);
    expect(JSON.stringify(error)).not.toContain("private callback failure");
    await expect(startup.finish()).rejects.toBeInstanceOf(AcpxStartupCancellationError);
  });
  it("cleans ordinary failed seed with no submitted RPC without inventing occupancy", async () => {
    const abort = new AbortController(), failure = new Error("ordinary seed failure"), dispose = vi.fn(async () => {});
    const startup = cancellableSandboxStartup({ signal: abort.signal, stopRemoteStartup: async () => {},
      executionTarget: { kind: "remote", transport: "sandbox", providerKey: "fixture", runner: { execute: vi.fn() } } } as never);
    const f = makeSite({ startupRecovery: startup, disposeFreshStagedRuntime: dispose,
      seedManagedHome: async stage => { await stage([]); abort.abort(); throw failure; } });
    await expect(f.site.placeWorkspace(makeContext("no-rpc-callback"))).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledOnce(); expect(f.stagingLocks.size).toBe(0);
    expect(startup.inspect().recoveryLeases).toEqual([]);
    await expect(startup.finish()).rejects.toBeInstanceOf(AcpxStartupCancellationError);
  });
  it("does not accept fabricated helper inspection as submitted resource authority", async () => {
    const failure = new Error("ordinary failure"), dispose = vi.fn(async () => {}), inspect = vi.fn(() => ({
      stopAttempt: Promise.resolve(), operations: [{ operation: Promise.resolve(), originalRpc: null }], recoveryLeases: [] }));
    const f = makeSite({ startupRecovery: { inspect } as never, disposeFreshStagedRuntime: dispose,
      seedManagedHome: async stage => { await stage([]); throw failure; } });
    await expect(f.site.placeWorkspace(makeContext("forged-owner"))).rejects.toBe(failure);
    expect(inspect).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce(); expect(f.stagingLocks.size).toBe(0);
  });
});
