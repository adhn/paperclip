import type { AdapterExecutionContext } from "../types.js";
import type { CommandManagedRuntimeRunner } from "../command-managed-runtime.js";

export type StartupOperationInspection = Readonly<{
  operation: Promise<unknown>; originalRpc: Promise<unknown> | null;
  outcome: Readonly<{ status: "pending" } | { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown }>;
  resources: readonly unknown[];
}>;
export type StartupRecoveryInspection = Readonly<{
  operations: readonly StartupOperationInspection[]; recoveryLeases: readonly (() => void)[];
  stopAttempt: Promise<void> | null;
  stopOutcome: Readonly<{ status: "not-started" | "pending" | "fulfilled" } | { status: "rejected"; reason: unknown }>;
}>;
const actualStartupRecoveries = new WeakMap<object, { inspect: () => StartupRecoveryInspection; associate: (release: () => void) => void }>();
export function inspectActualStartupRecovery(owner: unknown): StartupRecoveryInspection | undefined {
  return owner && typeof owner === "object" ? actualStartupRecoveries.get(owner)?.inspect() : undefined;
}
export function associateActualStartupRecovery(owner: unknown, release: () => void): void {
  const actual = owner && typeof owner === "object" ? actualStartupRecoveries.get(owner) : undefined;
  if (!actual) throw new Error("Startup recovery association is unavailable.");
  actual.associate(release);
}

const cancellationDetails = new WeakMap<AcpxStartupCancellationError, Readonly<{ originalReason: unknown; orderedFailures: readonly unknown[]; operations: readonly StartupOperationInspection[]; recoveryLeases: readonly (() => void)[] }>>();
export class AcpxStartupCancellationError extends Error {
  constructor(originalReason: unknown, priorFailures: readonly unknown[] = []) {
    super("Sandbox startup was canceled.");
    this.name = "AcpxStartupCancellationError";
    cancellationDetails.set(this, Object.freeze({ originalReason, orderedFailures: Object.freeze([...priorFailures, originalReason]), operations: Object.freeze([]), recoveryLeases: Object.freeze([]) }));
  }
  static inspect(error: AcpxStartupCancellationError) { return cancellationDetails.get(error); }
}

const cleanupFailureDetails = new WeakMap<AcpxStartupCleanupError, Readonly<{ orderedFailures: readonly unknown[]; operations: readonly StartupOperationInspection[]; recoveryLeases: readonly (() => void)[] }>>();
export class AcpxStartupCleanupError extends Error {
  constructor(orderedFailures: readonly unknown[]) {
    super("Sandbox startup cleanup requires exact inspection.");
    this.name = "AcpxStartupCleanupError";
    cleanupFailureDetails.set(this, Object.freeze({ orderedFailures: Object.freeze([...orderedFailures]), operations: Object.freeze([]), recoveryLeases: Object.freeze([]) }));
  }
  static inspect(error: AcpxStartupCleanupError) { return cleanupFailureDetails.get(error); }
}

/** Diagnostic association only: this does not admit, release, or validate retirement. */
export function associateStartupRecoveryLease(error: unknown, release: () => void): void {
  if (error instanceof AcpxStartupCancellationError) {
    const facts = cancellationDetails.get(error);
    if (!facts?.operations.length) throw new Error("Startup recovery association is unavailable.");
    cancellationDetails.set(error, Object.freeze({ ...facts, recoveryLeases: Object.freeze([...new Set([...facts.recoveryLeases, release])]) }));
    return;
  }
  if (error instanceof AcpxStartupCleanupError) {
    const facts = cleanupFailureDetails.get(error);
    if (!facts?.operations.length) throw new Error("Startup recovery association is unavailable.");
    cleanupFailureDetails.set(error, Object.freeze({ ...facts, recoveryLeases: Object.freeze([...new Set([...facts.recoveryLeases, release])]) }));
    return;
  }
  throw new Error("Startup recovery association is unavailable.");
}

/** A returned stop callback is a local acknowledgment only. Outstanding RPC
 * ownership remains explicit; this helper cannot prove physical termination. */
export function cancellableSandboxStartup(ctx: AdapterExecutionContext) {
  const target = ctx.executionTarget;
  const signal = ctx.signal;
  const stop = ctx.stopRemoteStartup;
  if (!signal || !stop || target?.kind !== "remote" || target.transport !== "sandbox" || !target.runner) {
    const recovery = { context: ctx, stopAcknowledged: () => false, finish: async () => {},
      inspect: () => Object.freeze({ operations: Object.freeze([]) as readonly StartupOperationInspection[], recoveryLeases: Object.freeze([]) as readonly (() => void)[], stopAttempt: null as Promise<void> | null,
        stopOutcome: Object.freeze({ status: "not-started" as const }) as Readonly<{ status: "not-started" | "pending" | "fulfilled" } | { status: "rejected"; reason: unknown }> }),
      associateRecoveryLease: (_release: () => void) => { throw new Error("Startup recovery association is unavailable."); } };
    actualStartupRecoveries.set(recovery, { inspect: recovery.inspect, associate: recovery.associateRecoveryLease });
    return recovery;
  }
  let armed = true;
  let cancellation: AcpxStartupCancellationError | undefined;
  const cancellationError = () => {
    cancellation ??= new AcpxStartupCancellationError(signal.reason, rpcFailures);
    publishFacts();
    return cancellation;
  };
  const refuseAborted = () => { if (signal.aborted) throw cancellationError(); };
  let stopping: Promise<void> | undefined;
  let stopAcknowledged = false;
  let stopOutcome: Readonly<{ status: "not-started" | "pending" | "fulfilled" } | { status: "rejected"; reason: unknown }> = Object.freeze({ status: "not-started" });
  const recoveryLeases: Array<() => void> = [];
  const admitted: Array<{ promise: Promise<unknown>; originalRpc: Promise<unknown> | null; submitted: boolean; resources: unknown[];
    outcome: StartupOperationInspection["outcome"] }> = [];
  const rpcFailures: unknown[] = [];
  let failedStopJoin: Promise<never> | undefined;
  let cleanupError: AcpxStartupCleanupError | undefined;
  function inspectOperations(): readonly StartupOperationInspection[] {
    return Object.freeze(admitted.filter(record => record.submitted).map(record => Object.freeze({
      operation: record.promise, originalRpc: record.originalRpc, outcome: Object.freeze({ ...record.outcome }), resources: Object.freeze([...record.resources]),
    })));
  }
  function allRecoveryLeases(): readonly (() => void)[] {
    return Object.freeze([...new Set([...recoveryLeases, ...(cancellation ? cancellationDetails.get(cancellation)!.recoveryLeases : []), ...(cleanupError ? cleanupFailureDetails.get(cleanupError)!.recoveryLeases : [])])]);
  }
  function publishFacts() {
    const operations = inspectOperations();
    const associated = allRecoveryLeases();
    if (cancellation) {
      const originalReason = cancellationDetails.get(cancellation)!.originalReason;
      cancellationDetails.set(cancellation, Object.freeze({ originalReason, orderedFailures: Object.freeze([...rpcFailures, originalReason]), operations, recoveryLeases: associated }));
    }
    if (cleanupError) {
      const orderedFailures = cleanupFailureDetails.get(cleanupError)!.orderedFailures;
      cleanupFailureDetails.set(cleanupError, Object.freeze({ orderedFailures, operations, recoveryLeases: associated }));
    }
  }
  let rejectStopped!: (error: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  // Cancellation can arrive between RPCs, when nobody is awaiting this yet.
  void stopped.catch(() => {});
  const onAbort = () => {
    if (stopping) return;
    stopOutcome = Object.freeze({ status: "pending" });
    stopping = Promise.resolve().then(stop);
    void stopping.then(
      () => {
        stopAcknowledged = true;
        stopOutcome = Object.freeze({ status: "fulfilled" });
        rejectStopped(cancellationError());
      },
      // A failed callback leaves the original operations unresolved. Join their
      // actual outcomes rather than treating local cancellation as retirement.
      reason => { stopOutcome = Object.freeze({ status: "rejected", reason }); },
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const joinStop = async () => {
    try {
      await stopping;
    } catch (stopError) {
      if (!failedStopJoin) {
        failedStopJoin = (async () => {
          // Preserve settled originals as well as pending callbacks; rejected
          // operations may already have left an active-only collection.
          await Promise.allSettled(admitted.map(record => record.promise));
          if (rpcFailures.length) {
            cleanupError = new AcpxStartupCleanupError([...rpcFailures, stopError]);
            publishFacts();
            throw cleanupError;
          }
          throw stopError;
        })();
        void failedStopJoin.catch(() => {});
      }
      return failedStopJoin;
    }
  };
  const guard = async <T>(call: (ownResource: (resource: unknown) => void, ownRpc: (rpc: Promise<unknown>) => void) => Promise<T>): Promise<T> => {
    if (!armed && !stopping) return call(() => {}, () => {});
    if (stopping) {
      await joinStop();
      return stopped;
    }
    const record = { submitted: false, resources: [], originalRpc: null, outcome: { status: "pending" } } as typeof admitted[number];
    const operation = Promise.resolve().then(() => {
      if (stopping) refuseAborted();
      record.submitted = true;
      publishFacts();
      const originalRpc = call(resource => { record.resources.push(resource); publishFacts(); }, rpc => { record.originalRpc = rpc; publishFacts(); });
      record.originalRpc ??= originalRpc;
      publishFacts();
      return originalRpc;
    });
    record.promise = operation;
    admitted.push(record);
    void operation.then(value => { record.outcome = { status: "fulfilled", value }; publishFacts(); }, reason => {
      record.outcome = { status: "rejected", reason };
      if (record.submitted) rpcFailures.push(reason);
      publishFacts();
    });
    try {
      return await Promise.race([operation, stopped]);
    } finally {
      if (stopping) {
        await joinStop();
        refuseAborted();
      }
    }
  };
  const original = target.runner;
  const runner: CommandManagedRuntimeRunner = {
    ...original,
    execute: input => guard(() => original.execute(input)),
    ...(original.syncIn ? { syncIn: (input: Parameters<NonNullable<typeof original.syncIn>>[0]) => guard(() => original.syncIn!(input)) } : {}),
    ...(original.syncOut ? { syncOut: (input: Parameters<NonNullable<typeof original.syncOut>>[0]) => guard(() => original.syncOut!(input)) } : {}),
    ...(original.openDuplexChannel ? {
      openDuplexChannel: (input: Parameters<NonNullable<typeof original.openDuplexChannel>>[0]) => guard(async (ownResource, ownRpc) => {
        const opening = original.openDuplexChannel!(input);
        ownRpc(opening);
        const channel = await opening;
        ownResource(channel);
        // An open RPC can return after the stop callback acknowledged. Join its
        // host-route close; neither callback proves physical termination.
        if (stopping) await channel.close();
        return channel;
      }),
    } : {}),
  };
  const recovery = {
    context: { ...ctx, executionTarget: { ...target, runner } },
    stopAcknowledged: () => stopAcknowledged,
    inspect: () => Object.freeze({ operations: inspectOperations(), recoveryLeases: allRecoveryLeases(), stopAttempt: stopping ?? null, stopOutcome }),
    associateRecoveryLease: (release: () => void) => {
      if (!admitted.some(record => record.submitted)) throw new Error("Startup recovery association is unavailable.");
      if (!recoveryLeases.includes(release)) recoveryLeases.push(release);
      publishFacts();
    },
    async finish() {
      signal.removeEventListener("abort", onAbort);
      armed = false;
      if (stopping) await joinStop();
      refuseAborted();
    },
  };
  actualStartupRecoveries.set(recovery, { inspect: recovery.inspect, associate: recovery.associateRecoveryLease });
  return recovery;
}
