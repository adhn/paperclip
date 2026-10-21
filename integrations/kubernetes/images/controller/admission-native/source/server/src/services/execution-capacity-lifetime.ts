import { copyBackCodexAuth } from "@paperclipai/adapter-codex-local/server";
import { parseDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { restoreWorkspaceFromSshExecution } from "@paperclipai/adapter-utils/ssh";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, protectedCommandJournals, type Db } from "@paperclipai/db";
import { withSshCommandJournal, runSshCommand, shellQuote, stopSshAdmissionCommand, type SshConnectionConfig, type SshCommandPayload, type SshLaunchAuthorization } from "@paperclipai/adapter-utils/ssh";
import { withExecutionStateJournal, type ExecutionStateKind } from "@paperclipai/adapter-utils/execution-state-journal";
import { conflict } from "../errors.js";
import { capacityEnvironmentContract, capacityFingerprint } from "./execution-capacity-policy.js";
import { currentCapacityOperation, executionCapacity, withCapacityOperationOwner, requestCapacityProgress, scheduleCapacityProgress, type CapacityOperationOwner } from "./execution-capacity-context.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { installedProtectedExecutionTransport } from "./protected-execution-transport.js";

const restoring = new AsyncLocalStorage<ExecutionStateKind>();
const activeLifetimes = new WeakMap<Db, Set<string>>();
function connection(config: SshConnectionConfig) {
  return { host: config.host, port: config.port, username: config.username, remoteWorkspacePath: config.remoteWorkspacePath,
    privateKey: config.privateKey, knownHosts: config.knownHosts, strictHostKeyChecking: config.strictHostKeyChecking };
}
function canonicalRoot(value: string | undefined): value is string {
  return Boolean(value?.startsWith("/") && value !== "/" && !value.split("/").slice(1).some(p => !p || p === "." || p === ".."));
}
const flushState = `import os,sys
from pathlib import Path
root=Path(sys.argv[1])
if root.resolve()!=root or not root.is_dir(): raise ValueError('state_root_changed')
for directory,dirs,files in os.walk(root,followlinks=False):
 for name in files:
  path=Path(directory)/name
  if path.is_symlink(): raise ValueError('state_symlink_unattested')
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  try: os.fsync(fd)
  finally: os.close(fd)
 for name in dirs:
  if (Path(directory)/name).is_symlink(): raise ValueError('state_symlink_unattested')
 fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try: os.fsync(fd)
 finally: os.close(fd)
`;

/** Own setup through finalization. State errors are durable holds, not inferred
 * from a successful result or from SSH-client exit. No TTL returns capacity. */
async function occupy<T>(db: Db, owner: CapacityOperationOwner, body: () => Promise<T>, recovery = false): Promise<T> {
  return withActiveLifetime(db, owner.attemptId, () => occupyOwned(db, owner, body, recovery));
}
async function withActiveLifetime<T>(db: Db, attemptId: string, body: () => Promise<T>): Promise<T> {
  const active = activeLifetimes.get(db) ?? new Set<string>();
  activeLifetimes.set(db, active);
  if (active.has(attemptId)) throw new Error("capacity_finalizer_active");
  active.add(attemptId);
  try { return await body(); }
  catch (error) { scheduleCapacityProgress(db); throw error; }
  finally { active.delete(attemptId); }
}
async function occupyOwned<T>(db: Db, owner: CapacityOperationOwner, body: () => Promise<T>, recovery: boolean): Promise<T> {
  const admission = executionCapacity(db)!;
  const binding = recovery ? await admission.assertCleanupReady(owner) : owner.runId
    ? await admission.assertRunReady(owner.companyId, owner.runId, owner.environmentId)
    : await admission.assertOperationReady(owner);
  if (![binding.fenceRoot, binding.sessionRoot, binding.credentialRoot].every(canonicalRoot))
    throw conflict("Waiting for execution capacity", { code: "capacity_operation_not_admitted" });
  const [environment] = await db.select().from(environments).where(eq(environments.id, binding.environmentId));
  if (!environment || capacityFingerprint(capacityEnvironmentContract(environment)) !== binding.environmentFingerprint)
    throw new Error("capacity_identity_changed");
  if (environment.driver !== "ssh") throw new Error("capacity_identity_changed");
  const parsed = await resolveEnvironmentDriverConfigForRuntime(db, owner.companyId, { ...environment, driver: "ssh" });
  if (parsed.driver !== "ssh") throw new Error("capacity_identity_changed");
  const [retainedLease] = recovery ? await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, owner.companyId),
    sql`${environmentLeases.metadata}->>'admissionAttemptId' = ${owner.attemptId}`,
  )) : [];
  const lease = retainedLease ?? (await db.insert(environmentLeases).values({ companyId: owner.companyId,
    environmentId: owner.environmentId, heartbeatRunId: owner.runId ?? null, provider: "ssh", status: "active",
    providerLeaseId: `ssh://${parsed.config.username}@${parsed.config.host}:${parsed.config.port}${parsed.config.remoteWorkspacePath}`,
    metadata: { agentId: binding.agentId, driver: "ssh", admissionOperationId: owner.runId ? null : owner.attemptId,
      admissionAttemptId: owner.attemptId, remoteCwd: parsed.config.remoteWorkspacePath,
      host: parsed.config.host, port: parsed.config.port, username: parsed.config.username,
      remoteWorkspacePath: parsed.config.remoteWorkspacePath },
  }).returning())[0];
  const occupiedOwner = { ...owner, leaseId: lease.id };
  const protectedTransport = installedProtectedExecutionTransport(db);
  const activeCommands = new Set<string>();
  const services = new Set<() => Promise<void>>();
  let authorizing = Promise.resolve();
  const stateRoots = new Map<string, { id: string; kind: ExecutionStateKind; root: string }>();
  return withCapacityOperationOwner(occupiedOwner, () => withSshCommandJournal({
    async authorize(spec, commandHash, environment) {
      if (capacityFingerprint(connection(spec)) !== capacityFingerprint(connection(parsed.config)))
        throw new Error("capacity_ssh_target_changed");
      if (!restoring.getStore()) {
        const effectiveRoot = binding.adapterType === "codex_local" ? environment.CODEX_HOME
          : binding.adapterType === "claude_local" ? environment.CLAUDE_CONFIG_DIR : environment.HOME;
        if (effectiveRoot) {
          if (!canonicalRoot(effectiveRoot)) throw new Error("capacity_effective_state_root_unattested");
          for (const kind of ["session", "credential"] as const) {
            const key = `${kind}:${effectiveRoot}`;
            if (!stateRoots.has(key)) {
              const id = await admission.requireRestoration({ ...owner, kind,
                descriptor: { operation: "remote_state", root: effectiveRoot } });
              stateRoots.set(key, { id, kind, root: effectiveRoot });
            }
          }
        }
      }
      // Serialize only durable grants. State preflight above can itself issue
      // an owned command; no lock is held across executable work.
      const previous = authorizing;
      let unlock!: () => void;
      authorizing = new Promise<void>(resolve => { unlock = resolve; });
      await previous;
      try {
        const authorization = await admission.journalCommand({ ...owner, leaseId: lease.id, commandHash,
          restoration: restoring.getStore(), concurrentWith: [...activeCommands] });
        activeCommands.add(authorization.binding.attemptId);
        return authorization;
      } finally { unlock(); }
    },
    ...(protectedTransport ? { spawnProtected: (authorization: SshLaunchAuthorization, payload: Readonly<SshCommandPayload>) => protectedTransport.spawn(owner, authorization, payload, async () => {
      await admission.recordCommandStopped({ ...owner, binding: authorization.binding, stopped: true });
      activeCommands.delete(authorization.binding.attemptId);
    }) } : {}),
    async stopped({ binding: stoppedBinding }) {
      await admission.recordCommandStopped({ ...owner, binding: stoppedBinding, stopped: true });
      activeCommands.delete(stoppedBinding.attemptId);
    },
    settled({ binding: stoppedBinding }) { activeCommands.delete(stoppedBinding.attemptId); },
    keepAlive(stop) { services.add(stop); },
  }, () => withExecutionStateJournal({
    mutate: body => admission.mutateRestoration(owner, body),
    checkpoint: (id, kind, descriptor) => admission.checkpointRestoration({ ...owner, id, kind, descriptor }),
    require: (kind, descriptor) => admission.requireRestoration({ ...owner, kind, descriptor }),
    async restore(id, kind, restoreBody) {
      try {
        const result = await restoring.run(kind, restoreBody);
        await admission.finishRestoration({ ...owner, id, kind, success: true });
        return result;
      } catch (error) {
        await admission.finishRestoration({ ...owner, id, kind, success: false });
        throw error;
      }
    },
  }, async () => {
    let result: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      result = await body();
      if (!recovery && owner.operationKind === "lifecycle" && result === "complete")
        await admission.recordOperationResult({ ...owner, result: "complete" });
    }
    catch (error) {
      await admission.cancel(owner.companyId, owner.attemptId);
      failure = error;
      failed = true;
    }
    try {
    for (const stop of services) await stop();
    await admission.beginRestoration(owner);
    // Workspace copy-back obligations have their own durable results. For
    // runner-resident state, independently force and verify durable filesystem
    // state after all owned processes have stopped. Each check is journalled.
    await admission.recordRestoration({ ...owner, kind: "workspace", success: true });
    for (const { id, kind, root } of stateRoots.values()) {
      try {
        await restoring.run(kind, () => runSshCommand(parsed.config,
          `python3 -I -c ${shellQuote(flushState)} ${shellQuote(root)}`, { timeoutMs: 30_000 }));
        await admission.finishRestoration({ ...owner, id, kind, success: true });
      } catch (error) {
        await admission.finishRestoration({ ...owner, id, kind, success: false });
        throw error;
      }
    }
    for (const [kind, root] of [["session", binding.sessionRoot!], ["credential", binding.credentialRoot!]] as const) {
      try {
        await restoring.run(kind, () => runSshCommand(parsed.config,
          `python3 -I -c ${shellQuote(flushState)} ${shellQuote(root)}`, { timeoutMs: 30_000 }));
        await admission.recordRestoration({ ...owner, kind, success: true });
      } catch (error) {
        await admission.recordRestoration({ ...owner, kind, success: false });
        throw error;
      }
    }
    await admission.releaseCapacity(owner);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, owner.companyId)));
    } catch (settlementError) {
      if (failed) throw new AggregateError([failure, settlementError], "Execution failed and restoration remains pending");
      throw settlementError;
    }
    if (failed) throw failure;
    return result as T;
  })));
}

export async function withCapacityOperation<T>(db: Db, input: { companyId: string; agentId?: string;
  environmentId: string; kind: "probe" | "adapter_test" | "lifecycle"; key: string }, body: () => Promise<T>): Promise<T> {
  const admission = executionCapacity(db);
  if (!admission) return body();
  const parent = currentCapacityOperation(db);
  if (parent) {
    if (parent.companyId !== input.companyId || parent.environmentId !== input.environmentId)
      throw new Error("capacity_nested_owner");
    if (parent.runId) await admission.assertRunReady(parent.companyId, parent.runId, input.environmentId);
    else await admission.assertOperationReady(parent);
    return body();
  }
  let operation = await admission.registerOperation(input);
  if (operation.state === "stopping" && !activeLifetimes.get(db)?.has(operation.id)) {
    await reconcileCapacityReservation(db, input.companyId, operation.id);
    operation = await admission.registerOperation(input);
  }
  if (input.kind === "lifecycle" && operation.state === "released" && operation.operationResult === "complete") return "complete" as T;
  const reservation = await admission.claimOperation(input.companyId, operation.id);
  if (!reservation?.token) throw conflict("Waiting for execution capacity", { code: "capacity_operation_not_admitted" });
  try {
    return await occupy(db, { db, companyId: input.companyId, environmentId: input.environmentId,
      attemptId: operation.id, token: reservation.token, operationKind: input.kind }, body);
  } finally { await requestCapacityProgress(db); }
}

export async function withCapacityRun<T>(db: Db, runId: string, body: () => Promise<T>): Promise<T> {
  const admission = executionCapacity(db);
  if (!admission) return body();
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!run) throw new Error("capacity_native_run_stopped");
  const binding = await admission.assertRunReady(run.companyId, run.id);
  const attempt = await admission.runReservation(run.companyId, run.id);
  return occupy(db, { db, companyId: run.companyId, environmentId: binding.environmentId,
    attemptId: attempt.id, token: attempt.token!, runId }, body);
}

export async function stopCapacityRunCommands(db: Db, companyId: string, runId: string) {
  const admission = executionCapacity(db);
  if (!admission) return;
  // Fence first. Enumeration afterwards includes every command that committed
  // before this Stop, including a launch whose response never reached its host.
  const before = await admission.commandsForRun(companyId, runId);
  for (const { attempt } of before) await admission.cancel(companyId, attempt.id);
  const pending = await admission.commandsForRun(companyId, runId);
  for (const { attempt } of pending) await stopCapacityReservation(db, companyId, attempt.id);
}

export async function stopCapacityAgentOperations(db: Db, agentIds: string[]) {
  const admission = executionCapacity(db);
  if (!admission || !agentIds.length) return;
  for (const attempt of await admission.agentOperations(agentIds)) {
    await admission.cancel(attempt.companyId, attempt.id);
    await stopCapacityReservation(db, attempt.companyId, attempt.id);
  }
}

async function stopCapacityReservation(db: Db, companyId: string, attemptId: string) {
  const admission = executionCapacity(db)!;
  const { attempt, commands } = await admission.commandsForAttempt(companyId, attemptId);
  if (!commands.length) return;
  const protectedTransport = installedProtectedExecutionTransport(db);
  if (protectedTransport) {
    if (!attempt.token) throw new Error("admission_ownership");
    for (const command of commands) await protectedTransport.stop(command.id, () => admission.recordCommandStopped({
      companyId, attemptId: attempt.id, token: attempt.token!, binding: command.binding, stopped: true,
    }));
    return;
  }
  // A restarted host without its explicit protected installer cannot reinterpret
  // a committed protected command as a legacy SSH command.
  const [protectedCommand] = await db.select({ commandId: protectedCommandJournals.commandId }).from(protectedCommandJournals)
    .where(inArray(protectedCommandJournals.commandId, commands.map(command => command.id))).limit(1);
  if (protectedCommand) throw new Error("protected_transport_required_for_retained_command");
    const [environment] = await db.select().from(environments).where(eq(environments.id, String(attempt.contract?.environmentId)));
    if (!environment || capacityFingerprint(capacityEnvironmentContract(environment)) !== attempt.contract?.environmentFingerprint)
      throw new Error("capacity_stop_target_changed");
    if (environment.driver !== "ssh") throw new Error("capacity_stop_target_changed");
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, { ...environment, driver: "ssh" });
    if (parsed.driver !== "ssh" || !attempt.token) throw new Error("capacity_stop_target_changed");
    for (const command of commands) {
      await stopSshAdmissionCommand({ ...parsed.config, remoteCwd: parsed.config.remoteWorkspacePath }, command);
      await admission.recordCommandStopped({ companyId, attemptId: attempt.id, token: attempt.token, binding: command.binding, stopped: true });
    }
  }

/** Host-only restart/partial-finalization path. Never replays the executable body.
 * Remote takeover/ack must precede adoption; unsupported recovery data stays held.
 * Provider-specific state restoration is supplied by the trusted host, never by
 * an agent, request payload, or a successful provider result.
 */
export async function reconcileCapacityReservation(db: Db, companyId: string, attemptId: string,
  restoreAsset?: (descriptor: Record<string, unknown>, spec: SshConnectionConfig) => Promise<void>) {
  try {
    // Own the entire reconciliation, including stop/enumeration. Otherwise a
    // concurrent sweep could stop new restoration children before occupy starts.
    return await withActiveLifetime(db, attemptId, () => reconcileOwnedReservation(db, companyId, attemptId, restoreAsset));
  } finally { await requestCapacityProgress(db); }
}
async function reconcileOwnedReservation(db: Db, companyId: string, attemptId: string,
  restoreAsset?: (descriptor: Record<string, unknown>, spec: SshConnectionConfig) => Promise<void>) {
  const admission = executionCapacity(db);
  if (!admission) throw new Error("trusted_capacity_policy_required");
  let { attempt } = await admission.commandsForAttempt(companyId, attemptId);
  if (attempt.state === "released") return;
  if (attempt.state === "uncertain") attempt = await admission.adoptReservation(companyId, attemptId);
  else await admission.cancel(companyId, attemptId);
  ({ attempt } = await admission.commandsForAttempt(companyId, attemptId));
  if (!attempt.token || attempt.state !== "stopping") throw new Error("admission_not_restoring");
  await stopCapacityReservation(db, companyId, attemptId);
  const owner = { db, companyId, attemptId, token: attempt.token,
    environmentId: String(attempt.contract?.environmentId), ...(attempt.runId ? { runId: attempt.runId } : {}) };
  const binding = await admission.assertCleanupReady(owner);
  const [environment] = await db.select().from(environments).where(eq(environments.id, owner.environmentId));
  if (!environment || environment.driver !== "ssh" || capacityFingerprint(capacityEnvironmentContract(environment)) !== binding.environmentFingerprint)
    throw new Error("capacity_stop_target_changed");
  const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, { ...environment, driver: "ssh" });
  if (parsed.driver !== "ssh") throw new Error("capacity_stop_target_changed");
  function baseline(value: unknown) {
    const parsed = parseDirectorySnapshot(value);
    if (parsed) return parsed;
    // This path saves inline v1 baselines. Unsupported or corrupt baselines
    // cannot be replaced with a fresh snapshot during cleanup.
    throw new Error("capacity_recovery_baseline_unavailable");
  }
  await admission.beginRestoration(owner);
  await occupyOwned(db, owner, async () => {
    // Children (transfer staging) settle before the outer workspace merge.
    for (const obligation of (await admission.restorationObligations(owner)).reverse()) {
      if (obligation.status === "success") continue;
      const descriptor = obligation.descriptor;
      await restoring.run(obligation.kind, async () => {
        try {
          if (descriptor.operation === "remote_state" && canonicalRoot(String(descriptor.root))) {
            await runSshCommand(parsed.config, `python3 -I -c ${shellQuote(flushState)} ${shellQuote(String(descriptor.root))}`);
          } else if (descriptor.operation === "directory_copy_back" &&
              typeof descriptor.localDir === "string" && canonicalRoot(descriptor.localDir) &&
              typeof descriptor.remoteDir === "string" && canonicalRoot(descriptor.remoteDir)) {
            await restoreWorkspaceFromSshExecution({ spec: { ...parsed.config, remoteCwd: parsed.config.remoteWorkspacePath },
              localDir: String(descriptor.localDir), remoteDir: String(descriptor.remoteDir),
              baselineSnapshot: baseline(descriptor.baselineSnapshot) });
          } else if (descriptor.operation === "runtime_workspace" && descriptor.phase === "ready" &&
              typeof descriptor.localDir === "string" && canonicalRoot(descriptor.localDir) &&
              typeof descriptor.remoteDir === "string" && canonicalRoot(descriptor.remoteDir)) {
            await restoreWorkspaceFromSshExecution({ spec: { ...parsed.config, remoteCwd: parsed.config.remoteWorkspacePath },
              localDir: String(descriptor.localDir), remoteDir: String(descriptor.remoteDir),
              baselineSnapshot: baseline(descriptor.baselineSnapshot), restoreGitHistory: descriptor.restoreGitHistory === true,
              repositories: (descriptor.repositories as Array<{ path: string; baselineSnapshot: unknown }> ?? [])
                .map(repository => ({ path: repository.path, baselineSnapshot: baseline(repository.baselineSnapshot) })) });
          } else if (descriptor.operation === "codex_auth" && typeof descriptor.hostAuthPath === "string" && canonicalRoot(descriptor.hostAuthPath) &&
              typeof descriptor.remoteDir === "string" && canonicalRoot(descriptor.remoteDir)) {
            await copyBackCodexAuth({ hostAuthPath: descriptor.hostAuthPath,
              readSandboxAuth: async () => Buffer.from((await runSshCommand(parsed.config,
                `base64 < ${shellQuote(descriptor.remoteDir + "/auth.json")}`, { maxBuffer: 1024 * 1024 })).stdout.replace(/\s+/g, ""), "base64"),
              log: async () => {}, env: process.env });
          } else {
            if (!restoreAsset) throw new Error("capacity_recovery_restorer_unavailable");
            await restoreAsset(descriptor, parsed.config);
          }
          await admission.finishRestoration({ ...owner, id: obligation.id, kind: obligation.kind, success: true });
        } catch (error) {
          await admission.finishRestoration({ ...owner, id: obligation.id, kind: obligation.kind, success: false });
          throw error;
        }
      });
    }
  }, true);
}

const recoverySweeps = new WeakSet<Db>();
const recoveryRetries = new WeakMap<Db, Map<string, { failures: number; notBefore: number }>>();
/** Bounded same-controller cleanup retries. Restart ownership is never inferred;
 * uncertain/old-epoch reservations require explicit acknowledged adoption first. */
export async function reconcileStoppedCapacityReservations(db: Db) {
  const admission = executionCapacity(db);
  if (!admission || recoverySweeps.has(db)) return;
  recoverySweeps.add(db);
  try {
    const attempts = await admission.stoppingReservations();
    const retries = recoveryRetries.get(db) ?? new Map<string, { failures: number; notBefore: number }>();
    recoveryRetries.set(db, retries);
    for (const id of retries.keys()) if (!attempts.some(attempt => attempt.id === id)) retries.delete(id);
    for (const attempt of attempts) {
      if (activeLifetimes.get(db)?.has(attempt.id)) continue;
      const retry = retries.get(attempt.id);
      if (retry && (retry.failures >= 3 || retry.notBefore > Date.now())) continue;
      try {
        await reconcileCapacityReservation(db, attempt.companyId, attempt.id);
        retries.delete(attempt.id);
      } catch {
        // The durable child/restoration journals retain the precise unresolved
        // obligation. Exhausting retries never returns capacity or replays work.
        const failures = (retry?.failures ?? 0) + 1;
        const delay = failures === 1 ? 1_000 : 5_000;
        retries.set(attempt.id, { failures, notBefore: Date.now() + delay });
        if (failures < 3) scheduleCapacityProgress(db, delay + 50);
      }
    }
  } finally { recoverySweeps.delete(db); }
}
