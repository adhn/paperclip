import { z } from "zod";

export const secretRecoveryIdentitySchema = z.object({
  secretId: z.string().uuid(), versionId: z.string().uuid(), version: z.number().int().positive(),
  authority: z.object({ parent: z.record(z.string(), z.unknown()), version: z.record(z.string(), z.unknown()),
    definition: z.record(z.string(), z.unknown()).nullable(), providerConfig: z.record(z.string(), z.unknown()).nullable(),
  }).strict(),
}).strict();
export type SecretRecoveryIdentity = z.infer<typeof secretRecoveryIdentitySchema>;
