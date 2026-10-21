import type { QuotaOwnerIdentity } from "./quota-owner-identity-schema.js";
import type { SecretRecoveryIdentity } from "./secret-recovery-identity-schema.js";
import { randomUUID } from "node:crypto";
import { quotaCredentialHash, type QuotaExchangeIntent, type QuotaExchangeResult, type quotaCredentialRecovery } from "./quota-credential-recovery.js";

/** Own the actual single-use exchange between prospective durable intent and
 * exact encrypted result. No failure after intent permits automatic reexchange.
 * Caller retains its company mutation lock through journal and SQL settlement. */
export async function exchangeQuotaCredential(input: {
  recovery: ReturnType<typeof quotaCredentialRecovery>;
  companyId: string; grantId: string; connectionId: string; secretId: string;
  current: string; originalSecretIdentity: SecretRecoveryIdentity; originalOwnerIdentity: QuotaOwnerIdentity; signal: AbortSignal; fetchImpl?: typeof fetch; beforeDispatch?: () => Promise<void>;
}): Promise<QuotaExchangeResult> {
  const auth = JSON.parse(input.current);
  const refreshToken = auth.tokens?.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) throw new Error("authentication_required");
  input.signal.throwIfAborted();
  const intent: QuotaExchangeIntent = {
    schema: 1, kind: "exchange-intent", operationId: randomUUID(),
    companyId: input.companyId, grantId: input.grantId, connectionId: input.connectionId,
    secretId: input.secretId, baseHash: quotaCredentialHash(input.current), originalSecretIdentity: input.originalSecretIdentity, originalOwnerIdentity: input.originalOwnerIdentity,
  };
  // Encryption and complete journal publication must succeed before fetch is
  // invoked. Lost publication acknowledgement may leave intent, never permission
  // to consume the original token again.
  await input.recovery.beginExchange(intent);
  // Cancellation while journal publication was pending still refuses a new
  // provider submission. The retained intent stays inspection-only; this does
  // not claim that cancellation can retract an already submitted exchange.
  input.signal.throwIfAborted();
  await input.beforeDispatch?.();
  input.signal.throwIfAborted();
  const response = await (input.fetchImpl ?? fetch)("https://auth.openai.com/oauth/token", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 400 || response.status === 401 ? "authentication_required" : "provider_unavailable");
  }
  const tokens = await response.json() as Record<string, unknown>;
  if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("provider_unavailable");
  const refreshed = JSON.stringify({ ...auth, tokens: { ...auth.tokens,
    access_token: tokens.access_token,
    ...(typeof tokens.refresh_token === "string" && tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(typeof tokens.id_token === "string" && tokens.id_token ? { id_token: tokens.id_token } : {}),
  }, last_refresh: new Date().toISOString() });
  const result: QuotaExchangeResult = { ...intent, kind: "exchange-result", intent, value: refreshed };
  await input.recovery.completeExchange(result);
  return result;
}
