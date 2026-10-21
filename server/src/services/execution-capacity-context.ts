import { capacityAgentContract, capacityEnvironmentContract, capacityFingerprint } from "./execution-capacity-policy.js";
import { conflict } from "../errors.js";
import type { Db } from "@paperclipai/db";
import type { executionAdmissionService } from "./execution-admission.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type CapacityOperationOwner = { db: Db; companyId: string; attemptId: string; token: string; environmentId: string;
  leaseId?: string; runId?: string; operationKind?: "probe" | "adapter_test" | "lifecycle" };
const operations = new AsyncLocalStorage<CapacityOperationOwner>();
export function currentCapacityOperation(db: Db) {
  const owner = operations.getStore();
  return owner?.db === db ? owner : undefined;
}
export function withCapacityOperationOwner<T>(owner: CapacityOperationOwner, body: () => Promise<T>) {
  return operations.run(owner, body);
}

type Admission = ReturnType<typeof executionAdmissionService>;
// Explicit host installation only. Shared by every service factory using this
// database handle; there is no API, model-config or environment activation.
const contexts = new WeakMap<Db, Admission>();
const required = new WeakSet<Db>();
export function requireExecutionCapacity(db: Db) {
  if (contexts.has(db)) throw new Error("capacity_already_installed");
  required.add(db);
}
const progress = new WeakMap<Db, () => Promise<unknown>>();
export function registerCapacityProgress(db: Db, wake: () => Promise<unknown>) { progress.set(db, wake); }
const progressTimers = new WeakMap<Db, { timer: ReturnType<typeof setTimeout>; notBefore: number }>();
export function scheduleCapacityProgress(db: Db, delayMs = 5_050) {
  if (!progress.has(db)) return;
  const notBefore = Date.now() + delayMs;
  const pending = progressTimers.get(db);
  if (pending && pending.notBefore <= notBefore) return;
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    progressTimers.delete(db);
    // Durable rows remain authoritative if the host wake fails. A later normal
    // queue sweep retries; never spin indefinitely against a closed/stale host.
    void requestCapacityProgress(db).catch(() => undefined);
  }, delayMs);
  timer.unref?.();
  progressTimers.set(db, { timer, notBefore });
}
export async function requestCapacityProgress(db: Db) { await progress.get(db)?.(); }
export function installExecutionCapacity(db: Db, admission: Admission) {
  if (contexts.has(db)) throw new Error("capacity_already_installed");
  contexts.set(db, admission);
}
export function executionCapacity(db: Db) {
  const admission = contexts.get(db);
  if (!admission && required.has(db)) throw new Error("capacity_bootstrap_required");
  return admission;
}

export async function guardCapacityExecution(db: Db, input: {
  companyId: string; runId?: string | null; environmentId?: string;
  agent?: Parameters<typeof capacityAgentContract>[0];
  environment?: Parameters<typeof capacityEnvironmentContract>[0];
}) {
  const admission = executionCapacity(db);
  if (!admission) return;
  // Probe/lifecycle operations require their own durable owner before setup.
  const operation = currentCapacityOperation(db);
  if (!input.runId && (!operation || operation.companyId !== input.companyId))
    throw conflict("Waiting for execution capacity", { code: "capacity_operation_not_admitted" });
  const binding = input.runId
    ? await admission.assertRunReady(input.companyId, input.runId, input.environmentId)
    : operation!.runId ? await admission.assertRunReady(input.companyId, operation!.runId, input.environmentId)
    : await admission.assertOperationReady({ ...operation!, environmentId: input.environmentId });
  if ((input.agent && capacityFingerprint(capacityAgentContract(input.agent)) !== binding.agentFingerprint) ||
      (input.environment && capacityFingerprint(capacityEnvironmentContract(input.environment)) !== binding.environmentFingerprint))
    throw conflict("Execution configuration changed; waiting for a new capacity decision", { code: "capacity_identity_changed" });
}

export async function guardCapacityWorkspaceConfiguration(db: Db, input: {
  companyId: string; runId: string; configuration: unknown;
}) {
  const admission = executionCapacity(db);
  if (!admission) return;
  const binding = await admission.assertRunReady(input.companyId, input.runId);
  if (input.configuration && typeof input.configuration === "object" &&
      (input.configuration as { aiBinding?: unknown }).aiBinding != null)
    throw conflict("This AI connection needs trusted capacity admission", { code: "capacity_ai_binding_unsupported" });
  if (!binding.workspaceConfigurations.includes(capacityFingerprint(input.configuration)))
    throw conflict("Workspace configuration needs a new capacity decision", { code: "capacity_workspace_configuration_changed" });
}

export async function guardCapacityResolvedExecutionConfig(db: Db, input: {
  companyId: string; runId?: string; configuration: Record<string, unknown>;
}) {
  const admission = executionCapacity(db);
  if (!admission) return;
  if (input.runId) await admission.assertRunReady(input.companyId, input.runId);
  else await guardCapacityExecution(db, { companyId: input.companyId });
  const env = input.configuration.env;
  if (env && typeof env === "object" && ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "GOOGLE_GEMINI_BASE_URL",
    "GOOGLE_GENAI_USE_VERTEXAI", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "PAPERCLIP_AI_PROVIDER_KEY", "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_CODEX_PROVIDERS"]
    .some(key => typeof (env as Record<string, unknown>)[key] === "string" && String((env as Record<string, unknown>)[key]).trim()))
    throw conflict("This credential needs trusted capacity admission", { code: "capacity_paid_api_unsupported" });
}
