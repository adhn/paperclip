import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Local request/decryption configuration identity. These hashes neither attest
 * deployed bytes nor establish credential/key/session physical custody. */
export const connectorRecoveryAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({ schema: z.literal(1), kind: z.literal("hosted-sealed"), baseUrl: z.string().url(), instanceId: z.string().min(1),
    environment: z.enum(["development", "test", "staging", "production"]), signingKeySha256: hash, sealingKeySha256: hash }).strict(),
  z.object({ schema: z.literal(1), kind: z.literal("development-direct-oauth"), apiBaseUrl: z.literal("https://slack.com/api/"),
    appId: z.string().regex(/^A[A-Z0-9]+$/), clientId: z.string().regex(/^\d+\.\d+$/), clientSecretSha256: hash, callbackUri: z.string().url() }).strict(),
]);
export type ConnectorRecoveryAuthority = Readonly<z.infer<typeof connectorRecoveryAuthoritySchema>>;
export function sameConnectorRecoveryAuthority(left: unknown, right: unknown): boolean {
  const a = connectorRecoveryAuthoritySchema.safeParse(left), b = connectorRecoveryAuthoritySchema.safeParse(right);
  if (!a.success || !b.success) return false;
  const exact = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => x.localeCompare(y))) : item);
  return exact(a.data) === exact(b.data);
}
