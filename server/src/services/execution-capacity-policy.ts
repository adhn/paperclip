import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, environments, type Db } from "@paperclipai/db";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function capacityFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Supplied by host bootstrap, never agent config, request payload, or a model.
 * IDs name physical/shared resources: aliases MUST use the same ID. Paths and
 * credentials alone do not establish provider-account ownership. Until refresh
 * concurrency is proven, every mutable state scope is exclusive.
 */
export interface TrustedCapacityBinding {
  companyId: string;
  agentId: string;
  environmentId: string;
  adapterType: string;
  instance: string;
  instanceCapacity: number;
  runner: string;
  providerAccount: string;
  workspace: string;
  session: string;
  credential: string;
  agentFingerprint: string;
  environmentFingerprint: string;
  workspaceConfigurations: readonly string[];
  runnerCapacity: number;
  accountCapacity: number;
  // Optional only for older, held contracts. Executable admission requires an
  // attested canonical root and a durable remote epoch acknowledgement.
  fenceRoot?: string;
  sessionRoot?: string;
  credentialRoot?: string;
}
export function capacityAgentContract(agent: Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig" | "runtimeConfig" | "defaultEnvironmentId">) {
  return { adapterType: agent.adapterType, adapterConfig: agent.adapterConfig,
    runtimeConfig: agent.runtimeConfig, defaultEnvironmentId: agent.defaultEnvironmentId };
}
export function capacityWorkspaceContract(input: {
  sourceWorkspaceConfig: unknown; projectEnv?: unknown; routineEnv?: unknown; aiBinding?: unknown;
}) {
  return { sourceWorkspaceConfig: input.sourceWorkspaceConfig,
    projectEnv: input.projectEnv ?? {}, routineEnv: input.routineEnv ?? {}, aiBinding: input.aiBinding ?? null };
}
export function capacityEnvironmentContract(environment: Pick<typeof environments.$inferSelect, "id" | "driver" | "config" | "envVars">) {
  return { id: environment.id, driver: environment.driver, config: environment.config,
    envVars: environment.envVars };
}

export function capacityScopeKey(kind: string, identity: string) {
  if (!identity.trim() || identity !== identity.trim() || /[\u0000-\u001f]/.test(identity)) throw new Error("invalid_capacity_identity");
  return `${kind}:${capacityFingerprint(identity)}`;
}

export function trustedCapacityPolicy(configuration: readonly TrustedCapacityBinding[]) {
  const bindings: TrustedCapacityBinding[] = structuredClone([...configuration]);
  const scopes = new Map<string, number>();
  const byAgent = new Map<string, TrustedCapacityBinding>();
  const key = capacityScopeKey;
  function required(binding: TrustedCapacityBinding) {
    return [
      { key: key("instance", binding.instance), capacity: binding.instanceCapacity },
      { key: key("runner", binding.runner), capacity: binding.runnerCapacity },
      { key: key("account", binding.providerAccount), capacity: binding.accountCapacity },
      ...(["workspace", "session", "credential"] as const).map(kind => ({ key: key(kind, binding[kind]), capacity: 1 })),
      // An immutable contract discriminator detects policy changes even if all
      // resource names stay the same. It never replaces shared resource scopes.
      { key: key("contract", capacityFingerprint(binding)), capacity: 1 },
    ].sort((a, b) => a.key.localeCompare(b.key));
  }
  for (const binding of bindings) {
    if (![binding.companyId, binding.agentId, binding.environmentId].every(value =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) ||
      ![binding.agentFingerprint, binding.environmentFingerprint].every(value => /^[a-f0-9]{64}$/.test(value)))
      throw new Error("invalid_capacity_contract");
    if (!binding.workspaceConfigurations.length || binding.workspaceConfigurations.some(value => !/^[a-f0-9]{64}$/.test(value)))
      throw new Error("invalid_capacity_workspace_contract");
    binding.workspaceConfigurations = [...new Set(binding.workspaceConfigurations)].sort();
    const agentKey = `${binding.companyId}:${binding.agentId}`;
    if (byAgent.has(agentKey)) throw new Error("duplicate_capacity_agent");
    byAgent.set(agentKey, binding);
    for (const scope of required(binding)) {
      if (!Number.isSafeInteger(scope.capacity) || scope.capacity < 0) throw new Error("invalid_capacity_limit");
      if (scopes.has(scope.key) && scopes.get(scope.key) !== scope.capacity) throw new Error("conflicting_capacity_limit");
      scopes.set(scope.key, scope.capacity);
    }
  }
  return {
    forCleanup(contract: Record<string, unknown> | null) {
      const binding = bindings.find(candidate => capacityFingerprint(candidate) === capacityFingerprint(contract));
      if (!binding) throw new Error("capacity_cleanup_contract_unattested");
      return { binding: structuredClone(binding), scopes: required(binding) };
    },
    agentForEnvironment(companyId: string, environmentId: string) {
      const matches = bindings.filter(b => b.companyId === companyId && b.environmentId === environmentId);
      if (matches.length !== 1) throw new Error("capacity_probe_owner_ambiguous");
      return matches[0].agentId;
    },
    async resolve(db: Pick<Db, "select">, companyId: string, agentId: string) {
      const binding = byAgent.get(`${companyId}:${agentId}`);
      if (!binding) throw new Error("capacity_agent_unconfigured");
      const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
      const [environment] = await db.select().from(environments).where(eq(environments.id, binding.environmentId));
      if (!agent || !environment || environment.status !== "active" || environment.driver !== "ssh" ||
          agent.defaultEnvironmentId !== binding.environmentId || agent.adapterType !== binding.adapterType ||
          !["codex_local", "claude_local", "gemini_local"].includes(agent.adapterType) || agent.adapterConfig.engine !== "cli" ||
          agent.runtimeConfig.aiConnection != null ||
          capacityFingerprint(capacityAgentContract(agent)) !== binding.agentFingerprint ||
          capacityFingerprint(capacityEnvironmentContract(environment)) !== binding.environmentFingerprint)
        throw new Error("capacity_configuration_changed");
      return { binding: structuredClone(binding), scopes: required(binding) };
    },
  };
}
