// Tests for the host run site (Phase 18).
//
// The host site is the null path with a warm-runtime store. These tests pin its
// warm-hit and warm-save behavior against the baseline warm sets, and confirm
// the null-path operations: host cwd plan, no staging failures, no transport,
// and no sync-back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostRunSite, type RuntimeCacheEntry } from "./run-site-host.js";
import type { AcpRunContext, ReadyRunResources } from "./run-contracts.js";

function makeEntry(id: string, lastUsedAt: number): RuntimeCacheEntry {
  return {
    runtime: { id, close: async () => {} } as never,
    handle: { sessionKey: id } as never,
    childStderrState: { logPath: null, pendingLiveLine: "" },
    processIdentitySink: { current: undefined, latest: null },
    fingerprint: `fp-${id}`,
    lastUsedAt,
  };
}

describe("host run site", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test_host_site_warm_hit_and_warm_save_match_baseline_sets", async () => {
    const warmHandles = new Map<string, RuntimeCacheEntry>();
    const closed: RuntimeCacheEntry[] = [];
    const site = createHostRunSite({
      warmHandles,
      now: () => Date.now(),
      idleMs: 60_000,
      closeWarmEntry: async (entry) => {
        closed.push(entry);
      },
    });
    const store = site.reuse();

    // Warm save: the entry lands in the caller's map as the sole warm entry, the
    // same set the baseline warm-save path produces (`warmHandles.size` is 1).
    const entry = makeEntry("paperclip:c:a:t:fp", Date.now());
    store.save(entry.handle.sessionKey, entry);
    expect(new Set(warmHandles.keys())).toEqual(new Set(["paperclip:c:a:t:fp"]));
    expect(warmHandles.get("paperclip:c:a:t:fp")).toBe(entry);
    // The save armed a per-entry idle timer.
    expect(entry.cleanupTimer).toBeDefined();

    // Warm hit: a borrow returns the same entry and leaves it in the map, so an
    // overlapping run of the same session still reads it. The borrow cleared the
    // idle timer, so the reused runtime does not expire while it is in use.
    expect(store.borrow("paperclip:c:a:t:fp")).toBe(entry);
    expect(warmHandles.size).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(closed).toEqual([]);
    expect(warmHandles.get("paperclip:c:a:t:fp")).toBe(entry);

    // A discard drops the entry and closes its runtime once, matching the
    // baseline drop set (empty map, one close).
    await store.discard("paperclip:c:a:t:fp");
    expect(warmHandles.size).toBe(0);
    expect(closed).toEqual([entry]);
  });

  it("test_host_site_plan_and_null_path_operations", async () => {
    const site = createHostRunSite({
      warmHandles: new Map(),
      now: () => 0,
      idleMs: 0,
      closeWarmEntry: async () => {},
    });

    const context = {
      fingerprintIdentity: { cwd: "/work/dir" },
    } as unknown as AcpRunContext;

    // The plan binds the session to the host cwd, names no relay-proxy spawn cwd,
    // and disables sandbox tracing.
    expect(site.plan(context)).toEqual({
      sessionCwd: "/work/dir",
      spawnCwd: undefined,
      tracingEnabled: false,
    });

    // The host runs in place, so it places nothing, starts no transport, and
    // syncs nothing back.
    expect(await site.placeWorkspace(context)).toEqual({ referencedProjectStagingFailures: [] });
    expect(await site.startTransport(context)).toEqual({ controlBridge: null, agentBridge: null });
    await expect(site.syncBack(context)).resolves.toBeUndefined();
  });

  it("test_host_site_reuse_candidate_names_runtime_and_session_handle", () => {
    const site = createHostRunSite({
      warmHandles: new Map(),
      now: () => 0,
      idleMs: 0,
      closeWarmEntry: async () => {},
    });

    const runtime = { id: "rt" };
    const sessionHandle = { id: "handle" };
    const resources = {
      get: (id: string) =>
        id === "acp_runtime" ? { runtime, sessionHandle, childProcessPid: 42 } : undefined,
    } as unknown as ReadyRunResources;

    expect(site.reuseCandidate(resources)).toEqual({ runtime, sessionHandle });
  });
  it.each(["error", "undefined"] as const)("retains supplied original warm predecessor after %s close rejection without redispatch", async kind => {
    const key = "legacy-supplied-predecessor", entry = makeEntry(key, Date.now()), failure = kind === "error" ? new Error("original warm close uncertain") : undefined;
    const close = vi.fn(async () => { throw failure; }); entry.runtime.close = close;
    const warmHandles = new Map([[key, entry]]);
    const store = createHostRunSite({ warmHandles, now: () => Date.now(), idleMs: 0,
      closeWarmEntry: original => original.runtime.close({ handle: original.handle, reason: "fixture original retirement", discardPersistentState: false }) }).reuse();
    await expect(store.discard(key)).rejects.toBe(failure);
    expect(warmHandles.get(key)).toBe(entry);
    expect(() => store.borrow(key)).toThrow(/cleanup|release|inspection/i);
    await expect(store.discard(key)).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce(); expect(warmHandles.get(key)).toBe(entry);
  });
  it("refuses borrowed reuse during actual pending close and deletes only after its one acknowledged return", async () => {
    const key = "supplied-pending-predecessor", entry = makeEntry(key, Date.now()); let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; }), close = vi.fn(async () => { await gate; }); entry.runtime.close = close;
    const warmHandles = new Map([[key, entry]]), store = createHostRunSite({ warmHandles, now: () => Date.now(), idleMs: 0,
      closeWarmEntry: original => original.runtime.close({ handle: original.handle, reason: "fixture original retirement", discardPersistentState: false }) }).reuse();
    const first = store.discard(key), second = store.discard(key);
    try {
      await Promise.resolve(); expect(close).toHaveBeenCalledOnce(); expect(warmHandles.get(key)).toBe(entry);
      expect(() => store.borrow(key)).toThrow(/cleanup|release|inspection/i);
    } finally { finish(); }
    await Promise.all([first, second]);
    expect(warmHandles.has(key)).toBe(false); expect(store.borrow(key)).toBeUndefined();
    await store.discard(key); expect(close).toHaveBeenCalledOnce();
  });
  it("keeps an idle supplied predecessor occupied after failed exact eviction", async () => {
    const key = "supplied-idle-predecessor", entry = makeEntry(key, Date.now() - 10_000), failure = new Error("idle predecessor close uncertain");
    const close = vi.fn(async () => { throw failure; }); entry.runtime.close = close;
    const warmHandles = new Map([[key, entry]]), store = createHostRunSite({ warmHandles, now: () => Date.now(), idleMs: 1_000,
      closeWarmEntry: original => original.runtime.close({ handle: original.handle, reason: "fixture idle retirement", discardPersistentState: false }) }).reuse();
    await expect(store.evictIdle(Date.now())).rejects.toBe(failure); expect(warmHandles.get(key)).toBe(entry);
    expect(() => store.borrow(key)).toThrow(/cleanup|release|inspection/i);
    await expect(store.evictIdle(Date.now())).rejects.toBe(failure); expect(close).toHaveBeenCalledOnce();
  });

});
