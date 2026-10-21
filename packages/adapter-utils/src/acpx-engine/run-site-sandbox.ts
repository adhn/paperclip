// The sandbox run site.
//
// The sandbox site runs the agent in a remote runner. It owns the four concerns
// the host site never has: it stages the workspace and the managed home into the
// sandbox, it holds the per-session staging lease, it starts both host-side
// bridges, and it syncs the managed home back on teardown. Its store keeps the
// staged files warm across runs of the same session, so a compatible resume
// reuses the already-staged in-sandbox runtime instead of re-shipping.
//
// The site owns the orchestration and the policy: the staging lease, the reuse
// and stale decision, the ledger registrations, the launch-environment envelope,
// the bridge overlap, and the single callback-environment sequencing point. The
// engine injects the leaf input/output primitives — the workspace stage call, the
// managed-home seam, the two bridge starts, and the step timer — so this module
// stays free of the engine's private staging helpers and the unit tests drive it
// with fakes.
//
// Amendment B (credential scope): `startTransport` builds the run-scoped bridge
// contribution and hands it to the injected `finalizeLaunchEnv`, the sole
// consumer of a contribution. The site, its ledger entries, and its reuse
// candidate never retain a run-scoped contribution or a bridge token. The staged
// reuse payload carries the staged files only.

import { AcpxStartupCancellationError, AcpxStartupCleanupError, associateStartupRecoveryLease, inspectActualStartupRecovery, associateActualStartupRecovery, type cancellableSandboxStartup } from "./startup-cancellation.js";
import type {
  AdapterExecutionTarget,
  AdapterExecutionTargetPaperclipBridgeHandle,
  AdapterExecutionTargetProcessSessionBridgeHandle,
  AdapterManagedRuntimeAsset,
  PreparedAdapterExecutionTargetRuntime,
} from "@paperclipai/adapter-utils/execution-target";
import type {
  AcpRunContext,
  AcquiredRunResources,
  LaunchEnvironmentContribution,
  PlacedWorkspace,
  ReadyRunResources,
  RunScopedContribution,
  RunSiteTransport,
  SandboxReuseCandidate,
  SessionReuseStore,
  SitePlan,
} from "./run-contracts.js";
import { createSessionReuseStore } from "./session-reuse-store.js";
import type { WorkspaceRestoreOutcome } from "../workspace-restore-merge.js";

const stagingWaitAbortDetails = new WeakMap<AcpxStagingWaitAbortedError, unknown>();
export class AcpxStagingWaitAbortedError extends Error {
  constructor(original: unknown) {
    super("ACP staging admission was canceled before resource acquisition.");
    this.name = "AcpxStagingWaitAbortedError";
    stagingWaitAbortDetails.set(this, original);
  }
  static inspect(error: AcpxStagingWaitAbortedError) { return stagingWaitAbortDetails.get(error); }
}

const retainedStagingLeases = new Set<() => void>();
const stagingLeaseHolds = new WeakMap<() => void, { held: boolean; error?: unknown }>();
export function registerStagingLease(release: () => void): void { stagingLeaseHolds.set(release, { held: false }); }
export function retainStagingLease(release: (() => void) | null | undefined, error: unknown): void {
  const state = release && stagingLeaseHolds.get(release);
  if (state) { state.held = true; state.error = error; retainedStagingLeases.add(release!); }
}
export function inspectStagingLeaseRetention(release: () => void): unknown {
  return stagingLeaseHolds.get(release)?.error;
}
export function stagingLeaseIsRetained(release: (() => void) | null | undefined): boolean {
  return Boolean(release && stagingLeaseHolds.get(release)?.held);
}

const stagedCleanupDetails = new WeakMap<AcpxStagedRuntimeCleanupError, Readonly<{
  orderedFailures: readonly unknown[];
  stagedRuntime: PreparedAdapterExecutionTargetRuntime | null;
  runtimeRootDir: string | null;
  resources?: unknown;
}>>();

/** In-process inspection only; neither a durable receipt nor a stop proof. */
export class AcpxStagedRuntimeCleanupError extends Error {
  constructor(errors: readonly unknown[], stagedRuntime: PreparedAdapterExecutionTargetRuntime | null, resources?: unknown) {
    super("ACP staged runtime cleanup requires recovery inspection.");
    this.name = "AcpxStagedRuntimeCleanupError";
    stagedCleanupDetails.set(this, Object.freeze({ orderedFailures: Object.freeze([...errors]),
      stagedRuntime, runtimeRootDir: stagedRuntime?.runtimeRootDir ?? null, ...(resources === undefined ? {} : { resources }) }));
  }
  static inspect(error: AcpxStagedRuntimeCleanupError) { return stagedCleanupDetails.get(error); }
}

function retainActualStartupFailure(error: unknown, owner: unknown, release: (() => void) | null | undefined,
  runtime: PreparedAdapterExecutionTargetRuntime | null): AcpxStagedRuntimeCleanupError | undefined {
  const facts = inspectActualStartupRecovery(owner);
  if (!release || !facts?.stopAttempt || !facts.operations.length) return undefined;
  const previous = inspectStagingLeaseRetention(release);
  if (previous === error && error instanceof AcpxStagedRuntimeCleanupError) return error;
  const prior = previous instanceof AcpxStagedRuntimeCleanupError ? AcpxStagedRuntimeCleanupError.inspect(previous)!.orderedFailures : previous === undefined ? [] : [previous];
  const failure = new AcpxStagedRuntimeCleanupError([...prior, error], runtime,
    { originalCallbackError: error, startupRecovery: owner, operations: facts.operations, previous, release });
  retainStagingLease(release, failure);
  if (stagingLeaseIsRetained(release)) associateActualStartupRecovery(owner, release);
  return failure;
}

const bridgeStartupDetails = new WeakMap<AcpxBridgeStartupError, readonly unknown[]>();
export class AcpxBridgeStartupError extends Error {
  constructor(errors: readonly unknown[]) {
    super("ACP bridge startup failed. Exact inspection is required.");
    this.name = "AcpxBridgeStartupError";
    bridgeStartupDetails.set(this, Object.freeze([...errors]));
  }
  static inspect(error: AcpxBridgeStartupError) { return bridgeStartupDetails.get(error); }
}

/**
 * One staged in-sandbox runtime the store keeps for the next compatible resume.
 * It is the value the staged-runtime map holds. The engine still owns this shape;
 * the store reads its `lastUsedAt` and its `dispose` through the config
 * accessors. The staged cache has no per-entry idle timer, so the entry carries
 * none — the run-start sweep is the only eviction path.
 */
export interface StagedRuntimeStoreEntry {
  stagedRuntime: PreparedAdapterExecutionTargetRuntime;
  envDelta: Record<string, string>;
  teardown: (() => Promise<WorkspaceRestoreOutcome>) | null;
  dispose: (() => Promise<void>) | null;
  lastUsedAt: number;
}

/**
 * The result of one workspace stage into the sandbox. The site records these
 * fields on the run and, after a clean turn, into the staged store.
 */
export interface StagedWorkspace {
  readonly stagedRuntime: PreparedAdapterExecutionTargetRuntime;
  readonly teardown: (() => Promise<WorkspaceRestoreOutcome>) | null;
  readonly dispose: (() => Promise<void>) | null;
  readonly envDelta: Record<string, string>;
  /** True when the run reused an already-staged runtime rather than staging fresh. */
  readonly reused: boolean;
}

/** The leaf staging primitive the engine injects. It ships one asset set. */
export type StageWorkspace = (assets: AdapterManagedRuntimeAsset[]) => Promise<PreparedAdapterExecutionTargetRuntime>;

/**
 * The managed-home seam result, in the shape the site consumes. The engine maps
 * its adapter seam onto this before it passes the seam in.
 */
export interface ManagedHomeSeamResult {
  readonly stagedRuntime: PreparedAdapterExecutionTargetRuntime;
  readonly teardown: (() => Promise<WorkspaceRestoreOutcome>) | null;
  readonly dispose: (() => Promise<void>) | null;
}

/** The construction options for the sandbox site. Every value is per run. */
export interface SandboxRunSiteOptions {
  /** The run ledger. `executeAcpxEngine` creates it and passes it in (one ledger). */
  readonly ledger: AcquiredRunResources;
  /** The staged-runtime map the store operates over. The engine owns it across runs. */
  readonly stagedRuntimes: Map<string, StagedRuntimeStoreEntry>;
  /** The per-key staging mutex the lease and the sweep share. */
  readonly stagingLocks: Map<string, Promise<unknown>>;
  /** Cancellation may withdraw only a queued reservation before fn admission. */
  readonly signal?: AbortSignal;
  /** Actual executor-created helper; module-private identity is verified. */
  readonly startupRecovery?: ReturnType<typeof cancellableSandboxStartup>;
  readonly now: () => number;
  /** The staged-idle bound, in milliseconds. `0` or less disables the sweep. */
  readonly idleMs: number;
  /** The in-sandbox workspace dir the session binds to (a fingerprint input). */
  readonly sessionCwd: string;
  /** The host spawn cwd for the relay proxy on the remote process-session lane. */
  readonly spawnCwd: string;
  /** The remote runner-backed sandbox target. */
  readonly target: AdapterExecutionTarget;
  /**
   * The run env the site mutates in place. Staging repoints the managed-home env
   * var onto the in-sandbox home here, and the site captures the delta from it.
   */
  readonly env: Record<string, string>;
  /**
   * True when the supplied session params resume THIS staged session. Only a
   * compatible resume may reuse the already-staged runtime.
   */
  readonly isCompatibleResume: boolean;
  /** Ship the workspace (and, via the seam, the managed home) into the sandbox. */
  readonly stage: StageWorkspace;
  /**
   * Seed the managed home through `stage`, repoint the home env var, and wire the
   * per-run copy-back. Absent for custom agents and the shared-engine tests, where
   * the site stages the workspace with no home asset.
   */
  readonly seedManagedHome?: (stage: StageWorkspace) => Promise<ManagedHomeSeamResult>;
  /**
   * Remove a freshly staged in-sandbox runtime after the seam threw. The site
   * fires it when the seam fails after a successful stage.
   */
  readonly disposeFreshStagedRuntime: (stagedRuntime: PreparedAdapterExecutionTargetRuntime) => Promise<void>;
  /** Wrap the `stage.sync` step in the run's startup step timer. */
  readonly measureStageStep: <T>(run: () => Promise<T>) => Promise<T>;
  /** Publish the referenced-project workspace hints after a fresh stage. */
  readonly publishStagedProjectHints: (stagedProjectDirs: Record<string, string>) => void;
  readonly onReuseLog: () => Promise<void>;

  /** Start the host-side paperclip callback bridge. */
  readonly startPaperclipBridge: (
    runtimeRootDir: string | null,
  ) => Promise<AdapterExecutionTargetPaperclipBridgeHandle | null>;
  /** Start the host-side process-session bridge with a deferred launch env. */
  readonly startProcessSessionBridge: (input: {
    runtimeRootDir: string | null;
    launchEnv: () => Promise<Record<string, string>>;
  }) => Promise<AdapterExecutionTargetProcessSessionBridgeHandle | null>;
  /** Wrap each concurrent bridge start in the run's startup step timer. */
  readonly measureBridgeStep: <T>(step: "bridge.paperclip" | "bridge.process-session", run: () => Promise<T>) => Promise<T>;
  /**
   * Finalize the run's branded launch environment from the bridge contribution.
   * The engine owns `finalizeLaunchEnvironment`, so it stays the sole consumer of
   * a contribution; the site calls this capability at the sequencing point.
   */
  readonly finalizeLaunchEnv: (contributions: readonly LaunchEnvironmentContribution[]) => Record<string, string>;
  readonly onPaperclipBridgeLog: () => Promise<void>;

  /** Stop both bridges and run the managed-home copy-back on teardown. */
  readonly stopBridges: (input: {
    controlBridge: AdapterExecutionTargetPaperclipBridgeHandle | null;
    agentBridge: AdapterExecutionTargetProcessSessionBridgeHandle | null;
  }) => Promise<void>;
}

/** The transport the sandbox site started, plus the run-scoped launch env. */
export interface SandboxRunSiteTransport extends RunSiteTransport {
  /** The finalized launch env for the process launch. */
  readonly launchEnv: Record<string, string>;
}

/** The sandbox run site. It owns staging, the lease, both bridges, and sync-back. */
export interface SandboxRunSite {
  readonly kind: "sandbox";
  plan(context: AcpRunContext): SitePlan;
  placeWorkspace(context: AcpRunContext): Promise<PlacedWorkspace>;
  startTransport(context: AcpRunContext): Promise<SandboxRunSiteTransport>;
  reuse(): SessionReuseStore<StagedRuntimeStoreEntry>;
  reuseCandidate(resources: ReadyRunResources): SandboxReuseCandidate;
  syncBack(context: AcpRunContext): Promise<void>;
  /** The staged workspace the run installed or reused, or null before `placeWorkspace`. */
  readonly staged: StagedWorkspace | null;
  /**
   * The paperclip callback bridge the run started, or null before
   * `startTransport` or on the host lane. `startTransport` sets it before it
   * rethrows a partial-bring-up failure, so an abandon path can stop the bridge
   * that started when its sibling threw.
   */
  readonly controlBridge: AdapterExecutionTargetPaperclipBridgeHandle | null;
  /** The process-session bridge the run started, or null before `startTransport`. */
  readonly agentBridge: AdapterExecutionTargetProcessSessionBridgeHandle | null;
  /**
   * Release the per-session staging lease `placeWorkspace` acquired, or null
   * before `placeWorkspace`. An abandon path calls it to free the lease when the
   * run never reaches sync-back.
   */
  readonly stagingLeaseRelease: (() => void) | null;
}

/** Create the sandbox run site over the engine's staged-runtime map and ledger. */
export function createSandboxRunSite(options: SandboxRunSiteOptions): SandboxRunSite {
  const store = createSessionReuseStore<StagedRuntimeStoreEntry>({
    entries: options.stagedRuntimes,
    now: options.now,
    idleMs: options.idleMs,
    lastUsedAt: (entry) => entry.lastUsedAt,
    // The staged cache arms no per-entry timer; the run-start sweep is the only
    // eviction path, and it runs under the per-key staging lease.
    deleteAfterRelease: true,
    release: async (entry) => {
      try { await entry.dispose?.(); }
      catch (error) { throw new AcpxStagedRuntimeCleanupError([error], entry.stagedRuntime); }
    },
    withEvictLease: async (key, critical) => {
      if (options.stagingLocks.has(key)) return;
      try {
        const lease = await withStagingLease(options.stagingLocks, key, critical);
        lease.release();
      } catch (error) {
        // The failed key remains occupied; its uncertainty does not block other keys.
        if (!(error instanceof AcpxStagedRuntimeCleanupError)) throw error;
      }
    },
  });

  // The lease the run holds from the stage-or-reuse decision through the active
  // turn until `syncBack` releases it. Held on the run, not on the store, because
  // a run keeps its lease across its whole lifetime.
  let leaseRelease: (() => void) | null = null;
  let staged: StagedWorkspace | null = null;
  let controlBridge: AdapterExecutionTargetPaperclipBridgeHandle | null = null;
  let agentBridge: AdapterExecutionTargetProcessSessionBridgeHandle | null = null;

  return {
    kind: "sandbox",

    plan(): SitePlan {
      // The sandbox binds the session to the in-sandbox workspace dir, redirects
      // the relay proxy spawn to the host cwd, and emits real sandbox trace spans.
      return {
        sessionCwd: options.sessionCwd,
        spawnCwd: options.spawnCwd,
        tracingEnabled: true,
      };
    },

    async placeWorkspace(context: AcpRunContext): Promise<PlacedWorkspace> {
      const sessionKey = context.sessionKey;
      const stageOwner: { runtime: PreparedAdapterExecutionTargetRuntime | null } = { runtime: null };
      const lease = await withStagingLease(options.stagingLocks, sessionKey, async (): Promise<StagedWorkspace> => {
        const cached = options.isCompatibleResume ? store.borrow(sessionKey) : undefined;
        if (cached) {
          stageOwner.runtime = cached.stagedRuntime;
          // Reuse the already-staged in-sandbox workspace and managed home.
          // Re-apply the env keys the seam repointed and reuse the per-run
          // copy-back so the copy-back cadence stays exactly per run.
          Object.assign(options.env, cached.envDelta);
          cached.lastUsedAt = options.now();
          await options.onReuseLog();
          return {
            stagedRuntime: cached.stagedRuntime,
            teardown: cached.teardown,
            dispose: cached.dispose,
            envDelta: cached.envDelta,
            reused: true,
          };
        }
        // Not a compatible resume: stage fresh. Drop and dispose a stale entry
        // that collides on this key first, so a fresh stage neither reuses nor
        // leaks it.
        const stale = options.stagedRuntimes.get(sessionKey);
        if (stale) {
          try { await stale.dispose?.(); }
          catch (error) { throw new AcpxStagedRuntimeCleanupError([error], stale.stagedRuntime); }
          if (options.stagedRuntimes.get(sessionKey) === stale) options.stagedRuntimes.delete(sessionKey);
        }
        const envBeforeStage = { ...options.env };
        let freshlyStaged: PreparedAdapterExecutionTargetRuntime | null = null;
        const stage: StageWorkspace = async (assets) => {
          const result = await options.stage(assets);
          freshlyStaged = result;
          stageOwner.runtime = result;
          return result;
        };
        const seam = await options.measureStageStep(async (): Promise<ManagedHomeSeamResult> => {
          if (options.seedManagedHome) {
            try {
              return await options.seedManagedHome(stage);
            } catch (seamErr) {
              const held = retainActualStartupFailure(seamErr, options.startupRecovery, leaseRelease, freshlyStaged);
              if (held) throw held;
              // The seam threw after a possible successful stage. Dispose the fresh
              // staged runtime so the abandoned in-sandbox managed home never leaks,
              // then rethrow the seam error.
              if (freshlyStaged) {
                try { await options.disposeFreshStagedRuntime(freshlyStaged); }
                catch (cleanupError) { throw new AcpxStagedRuntimeCleanupError([seamErr, cleanupError], freshlyStaged); }
              }
              throw seamErr;
            }
          }
          return { stagedRuntime: await stage([]), teardown: null, dispose: null };
        });
        const envDelta: Record<string, string> = {};
        for (const [key, value] of Object.entries(options.env)) {
          if (envBeforeStage[key] !== value) envDelta[key] = value;
        }
        return {
          stagedRuntime: seam.stagedRuntime,
          teardown: seam.teardown,
          dispose: seam.dispose,
          envDelta,
          reused: false,
        };
      }, options.signal, release => { leaseRelease = release; }, options.startupRecovery, stageOwner);
      leaseRelease = lease.release;
      staged = lease.value;
      // Publish the referenced-project workspace hints (known only after staging).
      const stagedProjectDirs = staged.stagedRuntime.additionalSourceDirs ?? {};
      if (Object.keys(stagedProjectDirs).length > 0) {
        options.publishStagedProjectHints(stagedProjectDirs);
      }
      // Register the acquired resources into the ledger. A per-run copy-back and a
      // staging lease live through the whole run; the staged runtime is
      // startup-rollback until a clean turn promotes it.
      options.ledger.register({
        id: "staged_runtime",
        payload: { stagedRuntime: staged.stagedRuntime, disposeStaged: staged.dispose ?? (async () => {}) },
        scope: "startup_rollback",
      });
      if (staged.teardown) {
        options.ledger.register({
          id: "managed_home",
          payload: { teardown: staged.teardown, envDelta: staged.envDelta },
          scope: "per_run",
        });
      }
      if (leaseRelease) {
        const release = leaseRelease;
        options.ledger.register({
          id: "staging_lease",
          payload: { release },
          scope: "per_run",
        });
      }
      return {
        referencedProjectStagingFailures: (staged.stagedRuntime.additionalSourceFailures ?? []).map(
          (failure) => ({ projectId: failure.projectId, error: failure.error }),
        ),
      };
    },

    async startTransport(): Promise<SandboxRunSiteTransport> {
      // Bring up both host-side bridges concurrently. Their remote subtrees are
      // disjoint, so their env-independent setup overlaps. The one real
      // dependency — the paperclip bridge's returned env must reach the
      // process-session launch — is sequenced by `launchEnv`, a memoized thunk the
      // process-session bridge awaits right before its launch.
      const stagedRootDir = staged?.stagedRuntime.runtimeRootDir ?? null;
      const paperclipStart = options.measureBridgeStep("bridge.paperclip", () =>
        options.startPaperclipBridge(stagedRootDir),
      );
      // The single sequencing point (paperclip env → process-session launch),
      // memoized so the merge runs exactly once whether the process-session bridge
      // consumes it at launch or `startTransport` finalizes it below.
      let launchEnvPromise: Promise<Record<string, string>> | null = null;
      let launchEnv: Record<string, string> = {};
      const finalizeLaunchEnv = (): Promise<Record<string, string>> =>
        (launchEnvPromise ??= (async () => {
          const paperclip = await paperclipStart;
          // The paperclip bridge token is run-scoped: it lives for this run only and
          // never enters a reuse payload (Amendment B). The site hands it to the
          // engine's `finalizeLaunchEnv`, the sole consumer of a contribution, and
          // retains nothing.
          const contributions: LaunchEnvironmentContribution[] = [];
          if (paperclip) {
            contributions.push({ scope: "run", env: paperclip.env } as unknown as RunScopedContribution);
            await options.onPaperclipBridgeLog();
          }
          launchEnv = options.finalizeLaunchEnv(contributions);
          return launchEnv;
        })());
      const processSessionStart = options.measureBridgeStep("bridge.process-session", () =>
        options.startProcessSessionBridge({ runtimeRootDir: stagedRootDir, launchEnv: finalizeLaunchEnv }),
      );
      // Settle BOTH starts, so a partial failure can stop whichever bridge started.
      const [paperclip, processSession] = await Promise.allSettled([paperclipStart, processSessionStart]);
      controlBridge = paperclip.status === "fulfilled" ? paperclip.value : null;
      agentBridge = processSession.status === "fulfilled" ? processSession.value : null;
      const failures = [paperclip, processSession].filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failures.length === 1) throw failures[0]!.reason;
      if (failures.length > 1) throw new AcpxBridgeStartupError(failures.map(outcome => outcome.reason));
      // Guarantee the merge ran even if the process-session bridge returned without
      // consuming the launch env (memoized, so a no-op if it did).
      await finalizeLaunchEnv();
      if (controlBridge) {
        options.ledger.register({ id: "control_bridge", payload: controlBridge, scope: "per_run" });
      }
      if (agentBridge) {
        options.ledger.register({ id: "agent_bridge", payload: agentBridge, scope: "per_run" });
      }
      return { controlBridge, agentBridge, launchEnv };
    },

    reuse(): SessionReuseStore<StagedRuntimeStoreEntry> {
      return store;
    },

    reuseCandidate(resources: ReadyRunResources): SandboxReuseCandidate {
      const stagedResource = resources.get("staged_runtime");
      if (!stagedResource) {
        throw new Error("sandbox run site cannot name a reuse candidate without a staged_runtime resource");
      }
      // The reuse payload carries the staged files only — no credential material.
      return { stagedRuntime: stagedResource.stagedRuntime };
    },

    async syncBack(): Promise<void> {
      try {
        // Stop both bridges, then run the managed-home copy-back (mirrors the CLI
        // finally: stop bridge, then restore workspace).
        await options.stopBridges({ controlBridge, agentBridge });
      } catch (error) {
        const failure = staged ? new AcpxStagedRuntimeCleanupError([error], staged.stagedRuntime, { controlBridge, agentBridge, leaseRelease }) : error;
        retainStagingLease(leaseRelease, failure);
        throw failure;
      }
      leaseRelease?.();
      leaseRelease = null;
    },

    get staged(): StagedWorkspace | null {
      return staged;
    },

    get controlBridge(): AdapterExecutionTargetPaperclipBridgeHandle | null {
      return controlBridge;
    },

    get agentBridge(): AdapterExecutionTargetProcessSessionBridgeHandle | null {
      return agentBridge;
    },

    get stagingLeaseRelease(): (() => void) | null {
      return leaseRelease;
    },
  };
}

// Per-`sessionKey` async lease: chains each caller after the previous one so the
// stage-or-reuse decision for a session runs serially, then keeps the lease held
// until the run releases it. Two overlapping runs of the same session can never
// stage into the same remote workspace at once: the loser waits, then re-checks
// the cache before it decides.
async function withStagingLease<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  onAdmitted?: (release: () => void) => void,
  startupRecovery?: unknown,
  stageOwner?: { runtime: PreparedAdapterExecutionTargetRuntime | null },
): Promise<{ value: T; release: () => void }> {
  if (signal?.aborted) throw new AcpxStagingWaitAbortedError(signal.reason);
  const originalPrev = locks.get(key);
  const prev = (originalPrev ?? Promise.resolve()).catch(() => {});
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const mine: Promise<unknown> = prev.then(() => gate);
  locks.set(key, mine);
  let canceled = false;
  void mine.then(() => {
    const head = locks.get(key);
    if (canceled && (head === mine || (originalPrev !== undefined && head === originalPrev))) locks.delete(key);
  }).catch(() => {});
  const cancelReservation = () => {
    canceled = true;
    // Resolve only this reservation. A later waiter still follows mine, which
    // cannot resolve before the original predecessor does.
    releaseGate();
    if (locks.get(key) === mine) {
      if (originalPrev) locks.set(key, originalPrev);
      else locks.delete(key);
    }
  };
  let rejectWait!: (error: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
  void aborted.catch(() => {});
  const onAbort = () => { cancelReservation(); rejectWait(new AcpxStagingWaitAbortedError(signal!.reason)); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    await Promise.race([prev, aborted]);
    if (signal?.aborted) { cancelReservation(); throw new AcpxStagingWaitAbortedError(signal.reason); }
  } finally { signal?.removeEventListener("abort", onAbort); }
  let released = false;
  const release = () => {
    if (released || stagingLeaseIsRetained(release)) return;
    released = true;
    releaseGate();
    if (locks.get(key) === mine) locks.delete(key);
  };
  registerStagingLease(release);
  try {
    onAdmitted?.(release);
    return { value: await fn(), release };
  } catch (error) {
    const owned = retainActualStartupFailure(error, startupRecovery, release, stageOwner?.runtime ?? null);
    if (owned) throw owned;
    const startup = error instanceof AcpxStartupCancellationError ? AcpxStartupCancellationError.inspect(error)
      : error instanceof AcpxStartupCleanupError ? AcpxStartupCleanupError.inspect(error) : undefined;
    if (startup?.operations.length) {
      const failure = new AcpxStagedRuntimeCleanupError([error], null, { startupError: error, operations: startup.operations, release });
      retainStagingLease(release, failure);
      if (stagingLeaseIsRetained(release)) associateStartupRecoveryLease(error, release);
      throw failure;
    }
    if (error instanceof AcpxStagedRuntimeCleanupError) retainStagingLease(release, error);
    if (!released) release();
    throw error;
  }
}
