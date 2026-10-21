import { z } from "zod";
export const quotaOwnerIdentitySchema = z.object({
  connection: z.record(z.string(), z.unknown()), grant: z.record(z.string(), z.unknown()),
}).strict();
export type QuotaOwnerIdentity = z.infer<typeof quotaOwnerIdentitySchema>;
