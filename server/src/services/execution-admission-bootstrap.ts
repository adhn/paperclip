import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { eq, inArray, sql } from "drizzle-orm";
import { admissionAttempts, admissionBootstraps, admissionCommands, admissionEpochs, admissionLegacyHolds,
  admissionScheduler, environmentLeases, heartbeatRuns, inspectMigrations, type Db } from "@paperclipai/db";
import { capacityFingerprint, capacityScopeKey, trustedCapacityPolicy } from "./execution-capacity-policy.js";
import { executionAdmissionService } from "./execution-admission.js";
import { requireExecutionCapacity } from "./execution-capacity-context.js";

const identity = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\u0000-\u001f]/.test(value));
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const policySchema = z.object({
  version: z.literal(1),
  // This first bootstrap stage has no execution mode or drain-release switch.
  // Protected runner authority and complete state/refresh contracts must land
  // before a separately reviewed implementation can allow any starts.
  mode: z.literal("held"),
  instance: identity,
  pendingLimit: z.number().int().min(1).max(4),
  legacyOwners: z.array(z.object({
    companyId: uuid, agentId: uuid, environmentId: uuid,
    runner: identity, providerAccount: identity, workspace: identity, session: identity, credential: identity,
  }).strict()).max(1000),
}).strict();
export type AdmissionBootstrapPolicy = z.infer<typeof policySchema>;
export function parseAdmissionBootstrapPolicy(value: unknown): AdmissionBootstrapPolicy {
  const parsed = policySchema.safeParse(value);
  // Never echo arbitrary policy or credential-bearing values through errors.
  if (!parsed.success) throw new Error("invalid_admission_bootstrap_policy");
  const policy = parsed.data;
  const owners = new Set<string>();
  const environments = new Map<string, string>();
  for (const owner of policy.legacyOwners) {
    const key = `${owner.companyId}:${owner.agentId}:${owner.environmentId}`;
    if (owners.has(key)) throw new Error("duplicate_admission_legacy_owner");
    owners.add(key);
    const resource = capacityFingerprint([owner.runner, owner.providerAccount, owner.workspace, owner.session, owner.credential]);
    const prior = environments.get(owner.environmentId);
    if (prior && prior !== resource) throw new Error("conflicting_admission_legacy_family");
    environments.set(owner.environmentId, resource);
  }
  return policy;
}

/** Only an operator-owned file on protected host configuration is accepted.
 * Projected ConfigMap symlinks are resolved, then the opened inode and every
 * canonical parent are checked. Agent-writable homes/workspaces are rejected.
 */
export async function loadAdmissionBootstrapPolicy(path: string | undefined) {
  if (!path || !isAbsolute(path)) throw new Error("admission_bootstrap_policy_required");
  async function protectedParents(filePath: string) {
    for (let parent = dirname(filePath); ; parent = dirname(parent)) {
      const directory = await stat(parent);
      if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022))
        throw new Error("admission_bootstrap_policy_unprotected");
      if (parent === "/") break;
    }
  }
  // Protect the configured name as well as its target. An agent-writable alias
  // to an otherwise trusted file must not select which policy is loaded.
  await protectedParents(path);
  const canonical = await realpath(path);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) || metadata.size > 1_048_576)
      throw new Error("admission_bootstrap_policy_unprotected");
    await protectedParents(canonical);
    let value: unknown;
    try { value = JSON.parse(await file.readFile("utf8")); }
    catch { throw new Error("invalid_admission_bootstrap_policy"); }
    return parseAdmissionBootstrapPolicy(value);
  } finally { await file.close(); }
}

/** Does not invoke SSH, providers, migrations, lifecycle repair or release.
 * All retained leases without exact native admission journals become holds,
 * including released/expired/succeeded leases. Native status alone does not
 * attest stop plus independent workspace/session/credential restoration.
 */
export async function bootstrapHeldExecutionAdmission(db: Db, input: unknown) {
  requireExecutionCapacity(db);
  const policy = parseAdmissionBootstrapPolicy(input);
  const policyHash = capacityFingerprint(policy);
  const epoch = randomUUID();
  const globalScope = capacityScopeKey("instance", policy.instance);
  const result = await db.transaction(async tx => {
    // Serializes empty-schema bootstrap as well as the existing singleton row.
    await tx.execute(sql`select pg_advisory_xact_lock(174510, 1)`);
    const [scheduler] = await tx.select().from(admissionScheduler).for("update");
    if (scheduler && !scheduler.draining) throw new Error("admission_bootstrap_requires_drain");
    const [previous] = scheduler ? await tx.select().from(admissionBootstraps)
      .where(eq(admissionBootstraps.epoch, scheduler.epoch)) : [];
    if (scheduler && !previous) throw new Error("admission_bootstrap_unknown_previous_owner");
    if (previous && previous.instance !== policy.instance) throw new Error("admission_bootstrap_instance_changed");
    const attempts = await tx.select().from(admissionAttempts);
    const commands = await tx.select().from(admissionCommands);
    const leases = await tx.select().from(environmentLeases);
    const runs = await tx.select().from(heartbeatRuns);
    const byRun = new Map(runs.map(run => [run.id, run]));
    const journalledLeases = new Set<string>();
    for (const attempt of attempts) if (attempt.binding) journalledLeases.add(`${attempt.companyId}:${attempt.binding.leaseId}`);
    for (const command of commands) {
      const parent = attempts.find(attempt => attempt.id === command.attemptId);
      if (parent && parent.companyId === command.binding.companyId)
        journalledLeases.add(`${parent.companyId}:${command.binding.leaseId}`);
    }
    async function hold(source: string, companyId: string, agentId: string | null, runId: string | null,
      environmentId: string | null, evidence: Record<string, unknown>) {
      const owner = policy.legacyOwners.find(owner => owner.companyId === companyId && owner.agentId === agentId &&
        owner.environmentId === environmentId);
      // An unknown relation cannot be treated as free space. It blocks the
      // entire instance instead of guessing which provider family it belongs to.
      const scopes = owner ? (["runner", "providerAccount", "workspace", "session", "credential"] as const)
        .map(kind => capacityScopeKey(kind === "providerAccount" ? "account" : kind, owner[kind])).sort() : [globalScope];
      const evidenceHash = capacityFingerprint(evidence);
      const [existing] = await tx.select().from(admissionLegacyHolds).where(eq(admissionLegacyHolds.source, source));
      if (existing) {
        if (existing.companyId !== companyId || existing.agentId !== agentId || existing.runId !== runId ||
            existing.environmentId !== environmentId || existing.evidenceHash !== evidenceHash ||
            JSON.stringify(existing.scopes) !== JSON.stringify(scopes)) throw new Error("admission_legacy_hold_drift");
        return;
      }
      await tx.insert(admissionLegacyHolds).values({ source, companyId, agentId, runId, environmentId,
        scopes, evidence, evidenceHash, policyHash });
    }
    const leaseRuns = new Set<string>();
    for (const lease of leases) {
      if (lease.heartbeatRunId) leaseRuns.add(lease.heartbeatRunId);
      if (journalledLeases.has(`${lease.companyId}:${lease.id}`)) continue;
      const run = lease.heartbeatRunId ? byRun.get(lease.heartbeatRunId) : undefined;
      const matchingRun = run?.companyId === lease.companyId ? run : undefined;
      // Missing/conflicting identity gets the global hold. No request metadata
      // is sufficient to name a trusted resource family by itself.
      const agentId = matchingRun && (!lease.metadata?.agentId || lease.metadata.agentId === matchingRun.agentId)
        ? matchingRun.agentId : null;
      await hold(`lease:${lease.id}`, lease.companyId, agentId, matchingRun?.id ?? null, lease.environmentId, {
        kind: "legacy_lease", leaseId: lease.id, companyId: lease.companyId, runId: lease.heartbeatRunId,
        agentId, environmentId: lease.environmentId, provider: lease.provider, status: lease.status,
        cleanupStatus: lease.cleanupStatus, releasedAt: lease.releasedAt?.toISOString() ?? null,
        // Presence is recorded without treating an unvalidated receipt as proof.
        receiptPresent: lease.metadata?.terminationReceipt != null,
        runStatus: matchingRun?.status ?? null,
      });
    }
    const trackedRuns = new Set(attempts.filter(attempt => attempt.runId).map(attempt => `${attempt.companyId}:${attempt.runId}`));
    for (const run of runs) {
      if (leaseRuns.has(run.id) || trackedRuns.has(`${run.companyId}:${run.id}`)) continue;
      await hold(`run:${run.id}`, run.companyId, run.agentId, run.id, null, {
        kind: "legacy_run_without_lease", companyId: run.companyId, agentId: run.agentId, runId: run.id, status: run.status,
      });
    }
    // Every existing hold survives even if its native row is no longer returned.
    // New ownership never clears old contracts or fabricates remote epoch ACKs.
    await tx.insert(admissionEpochs).values({ epoch });
    await tx.insert(admissionBootstraps).values({ epoch, policyHash, instance: policy.instance, mode: "held" });
    if (scheduler) await tx.update(admissionScheduler).set({ epoch, draining: true, pendingLimit: policy.pendingLimit });
    else await tx.insert(admissionScheduler).values({ epoch, draining: true, pendingLimit: policy.pendingLimit });
    await tx.update(admissionAttempts).set({ state: "uncertain", waitReason: "bootstrap_reconciliation_required", updatedAt: new Date() })
      .where(inArray(admissionAttempts.state, ["reserved", "starting", "stopping", "uncertain"]));
    return { epoch, policyHash, legacyHolds: (await tx.select({ source: admissionLegacyHolds.source }).from(admissionLegacyHolds)).length };
  });
  const admission = executionAdmissionService(db, epoch, trustedCapacityPolicy([]), { startsHeld: true });
  return { ...result, admission, mode: "held" as const };
}

export async function bootstrapProductionAdmission(db: Db, policyPath: string | undefined) {
  requireExecutionCapacity(db);
  return bootstrapHeldExecutionAdmission(db, await loadAdmissionBootstrapPolicy(policyPath));
}

export async function loadProductionAdmissionPolicy(input: {
  databaseUrl?: string | null; autoApply?: string; policyPath?: string;
}) {
  if (!input.databaseUrl) throw new Error("admission_bootstrap_requires_external_database");
  if (input.autoApply !== "false") throw new Error("admission_bootstrap_requires_manual_migration");
  return loadAdmissionBootstrapPolicy(input.policyPath);
}

export async function requireAdmissionMigrations(connectionString: string) {
  const state = await inspectMigrations(connectionString);
  if (state.status !== "upToDate") throw new Error("admission_bootstrap_schema_not_current");
}
