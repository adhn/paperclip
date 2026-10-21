import type { AiConnectionBinding } from "@paperclipai/shared";
/** Trusted caller facts rechecked against current SQL before new credential use. */
export type AiCredentialSelectionInput = {
  companyId: string; userId: string | null; agentId: string; adapterType: string;
  model?: unknown; runnerProvider?: unknown; acpxAgent?: unknown;
  allowUninstalledPersonal?: boolean; allowUninstalledShared?: boolean; allowLegacyValidation?: boolean;
  binding: AiConnectionBinding;
};
export type AiCredentialUseContext =
  | { kind: "agent"; selection: AiCredentialSelectionInput }
  | { kind: "user"; userId: string };
