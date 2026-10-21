import type { AiCredentialUseContext } from "./ai-credential-use-context.js";
import { and, eq, lt, or, isNull } from "drizzle-orm";
import { aiSubscriptions, aiSubscriptionConnections, type Db } from "@paperclipai/db";
import { aiConnectionService } from "./ai-connections.js";
import { subscriptionService, type SubscriptionConnection } from "./subscriptions.js";
import { probeSubscriptionIdentity } from "./subscription-identity.js";
import { logger } from "../middleware/logger.js";
import { tooManyRequests } from "../errors.js";
import { trackIdleWork } from "./task-admission.js";

const jobs = new WeakMap<Db, Map<string, Promise<void>>>();
const discovery = new WeakMap<Db, Map<string, Promise<void>>>();
const REFRESH_MS = 6 * 60 * 60 * 1000;

/** Cached metadata refresh only. Never exchanges tokens or blocks a run/page on a provider. */
export function refreshSubscriptionConnection(db: Db, input: SubscriptionConnection, id: string, request: typeof fetch = fetch, context?: AiCredentialUseContext): Promise<void> {
  let active = jobs.get(db);
  if (!active) jobs.set(db, active = new Map());
  const existing = active.get(id);
  if (existing) return existing;
  // Bound provider concurrency across all companies on this instance. Dashboard
  // discovery waits below; opportunistic run observations remain due when busy.
  if (active.size >= 4) return Promise.resolve();
  const task = trackIdleWork((async () => {
    const [claimed] = await db.update(aiSubscriptions).set({ lastCheckedAt: new Date() }).where(and(
      eq(aiSubscriptions.companyId, input.companyId), eq(aiSubscriptions.id, id),
      or(isNull(aiSubscriptions.lastCheckedAt), lt(aiSubscriptions.lastCheckedAt, new Date(Date.now() - REFRESH_MS))),
    )).returning({ id: aiSubscriptions.id });
    if (!claimed) return;
    try {
      if (!context) throw new Error("credential_use_context_required");
      const service = aiConnectionService(db);
      const current = context.kind === "agent" ? await service.select(context.selection)
        : (await service.subscriptionAccounts(input.companyId, context.userId)).find(row => row.connection.id === input.connectionId && row.grant.id === input.grantId);
      if (!current || current.connection.companyId !== input.companyId || current.connection.id !== input.connectionId || current.grant.id !== input.grantId || current.grant.subjectUserId !== input.ownerUserId) throw new Error("credentials_unavailable");
      const metadata = current.connection.config.ai as { provider?: unknown } | undefined;
      if (metadata?.provider !== input.provider) throw new Error("credentials_unavailable");
      const credential = await service.runtimeCredential(current, context);
      const fresh = { ...input, credential };
      const observation = await probeSubscriptionIdentity(input.companyId, input.provider, credential, request);
      // A later execution/reconnect may now use another account. Never replace
      // that binding with a slow response for the previous credential.
      const [binding] = await db.select().from(aiSubscriptionConnections).where(and(eq(aiSubscriptionConnections.companyId, input.companyId), eq(aiSubscriptionConnections.grantId, input.grantId)));
      if (binding?.credentialKey !== observation.credentialKey) return;
      await subscriptionService(db).register(fresh, observation);
    } catch {
      await db.update(aiSubscriptions).set({ refreshStatus: "unavailable" }).where(and(eq(aiSubscriptions.companyId, input.companyId), eq(aiSubscriptions.id, id)));
    }
  })().catch(() => {
    // No raw provider/credential errors are logged or returned to a user.
    logger.warn({ companyId: input.companyId, subscriptionId: id }, "Subscription observation could not be saved");
  }).finally(() => active!.delete(id)));
  active.set(id, task);
  return task;
}

export function refreshCompanySubscriptions(db: Db, companyId: string, userId: string): Promise<void> {
  let active = discovery.get(db);
  if (!active) discovery.set(db, active = new Map());
  const key = `${companyId}:${userId}`;
  const existing = active.get(key);
  if (existing) return existing;
  if (active.size >= 20) throw tooManyRequests("Subscription account checks are busy. Try again shortly.");
  const task = trackIdleWork((async () => {
    const service = aiConnectionService(db);
    // Uses the existing credential audience. Being a company admin does not
    // authorize probing another member's personal credentials.
    for (const row of await service.subscriptionAccounts(companyId, userId)) {
      if (row.summary.status !== "connected") continue;
      try {
        const credential = await service.runtimeCredential(row, { kind: "user", userId });
        const input: SubscriptionConnection = { companyId, connectionId: row.connection.id, grantId: row.grant.id,
          provider: row.summary.provider, name: row.connection.name, ownerUserId: row.grant.subjectUserId, credential };
        const id = await subscriptionService(db).register(input);
        // Accepted discovery must not silently skip an account. At most twenty
        // discovery tasks can wait here; never create an unbounded provider queue.
        // Recheck after each completion because another discovery may take a slot.
        let providers = jobs.get(db);
        while (providers && providers.size >= 4 && !providers.has(id)) {
          await Promise.race(providers.values());
          providers = jobs.get(db);
        }
        await refreshSubscriptionConnection(db, input, id, fetch, { kind: "user", userId });
      } catch {
        logger.warn({ companyId, connectionId: row.connection.id }, "Subscription discovery unavailable for a connection");
      }
    }
  })().catch(() => logger.warn({ companyId }, "Subscription discovery unavailable"))
    .finally(() => active!.delete(key)));
  active.set(key, task);
  return task;
}
