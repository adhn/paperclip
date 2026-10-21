import { and, eq, isNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";

type Lease = Pick<typeof environmentLeases.$inferSelect,
  "id" | "companyId" | "heartbeatRunId" | "environmentId" | "provider" | "providerLeaseId" | "metadata">;

/** Called only by the final-invocation stop fence, after the SSH supervisor has
 * reaped its descendants. The host supplies lease identity, never agent config.
 * This records process stop only; release and workspace restoration stay separate. */
export async function recordSshLeaseProcessStopped(db: Db, input: {
  companyId: string; runId: string; agentId: string; leaseId: string;
  environmentId: string | null; providerLeaseId: string | null; invocationId: string;
}) {
  if (!input.environmentId || !input.providerLeaseId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.invocationId)) {
    throw new Error("SSH termination identity is incomplete");
  }
  const receipt = { ...remoteTerminationReceipt({ id: input.leaseId,
    companyId: input.companyId, heartbeatRunId: input.runId,
    provider: "ssh", providerLeaseId: input.providerLeaseId,
  }, { providerLeaseId: input.providerLeaseId, state: "stopped" })!,
    sshInvocationId: input.invocationId };
  const [row] = await db.update(environmentLeases).set({
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ remoteExecutionTermination: receipt })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.environmentId, input.environmentId),
    eq(environmentLeases.provider, "ssh"), eq(environmentLeases.providerLeaseId, input.providerLeaseId),
    eq(environmentLeases.status, "active"), isNull(environmentLeases.releasedAt),
    sql`exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.id} = ${input.runId}
      and ${heartbeatRuns.companyId} = ${input.companyId} and ${heartbeatRuns.agentId} = ${input.agentId}
      and ${heartbeatRuns.runtimeMode} = 'legacy')`,
  )).returning({ id: environmentLeases.id });
  if (!row) throw new Error("SSH termination proof does not match an active host-owned run lease");
}

export function sshLeaseStopReleaseMetadata(lease: Lease): { cleanupStatus: "success" | "failed"; remoteExecutionTermination?: Record<string, unknown> } {
  const receipt = lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  const verified = lease.provider === "ssh" && receipt?.schema === "paperclip.remote-termination.v1" &&
    receipt.companyId === lease.companyId && receipt.runId === lease.heartbeatRunId && receipt.leaseId === lease.id &&
    receipt.provider === "ssh" && receipt.state === "stopped" && typeof receipt.sshInvocationId === "string" &&
    /^[0-9a-f-]{36}$/i.test(receipt.sshInvocationId) && remoteTerminationReceipt(lease, receipt);
  return verified ? { cleanupStatus: "success", remoteExecutionTermination: receipt } : { cleanupStatus: "failed" };
}
