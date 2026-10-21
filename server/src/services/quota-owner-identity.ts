import { and, eq } from "drizzle-orm";
import { toolConnections, connectionGrants, type Db } from "@paperclipai/db";
import type { QuotaOwnerIdentity } from "./quota-owner-identity-schema.js";
/** Exact local predecessor facts, not independent history or an effect receipt. */
export async function readQuotaOwnerIdentity(db: Db, companyId: string, grantId: string): Promise<QuotaOwnerIdentity> {
  const [row] = await db.select({ connection: toolConnections, grant: connectionGrants })
    .from(connectionGrants).innerJoin(toolConnections, and(eq(toolConnections.id, connectionGrants.connectionId),
      eq(toolConnections.companyId, connectionGrants.companyId)))
    .where(and(eq(connectionGrants.id, grantId), eq(connectionGrants.companyId, companyId)));
  if (!row) throw new Error("credentials_unavailable");
  const mutableObservation = new Set(["updatedAt", "lastUsedAt", "healthCheckedAt", "lastHealthAt", "lastCatalogRefreshAt"]);
  const facts = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => !mutableObservation.has(key)));
  return JSON.parse(JSON.stringify({ connection: facts(row.connection), grant: facts(row.grant) })) as QuotaOwnerIdentity;
}
