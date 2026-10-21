import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export type AdmissionState = "queued" | "reserved" | "starting" | "stopping" | "uncertain" | "released" | "cancelled";
export interface AdmissionLaunchBinding {
  epoch: string;
  companyId: string;
  agentId: string;
  runId: string;
  attemptId: string;
  environmentId: string;
  leaseId: string;
  invocationId: string;
}

// Instance-wide resource coordination is deliberately outside company ownership.
// Tenant work and fairness records below retain company boundaries. No cascading
// delete, expiry, or run-status projection may erase unresolved occupancy.
export const admissionEpochs = pgTable("execution_admission_epochs", {
  epoch: uuid("epoch").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const admissionScheduler = pgTable("execution_admission_scheduler", {
  singleton: boolean("singleton").primaryKey().default(true),
  epoch: uuid("epoch").notNull().references(() => admissionEpochs.epoch),
  draining: boolean("draining").notNull().default(true),
  sequence: bigint("sequence", { mode: "bigint" }).notNull().default(sql`0`),
  pendingLimit: integer("pending_limit").notNull(),
  recoveryPoint: timestamp("recovery_point", { withTimezone: true }),
  evaluationExemptionUntil: timestamp("evaluation_exemption_until", { withTimezone: true }),
}, t => [
  check("execution_admission_singleton", sql`${t.singleton}`),
  check("execution_admission_pending_limit", sql`${t.pendingLimit} > 0`),
]);

export const admissionScopes = pgTable("execution_admission_scopes", {
  key: text("key").primaryKey(),
  capacity: integer("capacity").notNull(),
  draining: boolean("draining").notNull().default(false),
  notBefore: timestamp("not_before", { withTimezone: true }),
  revision: integer("revision").notNull().default(1),
}, t => [check("execution_admission_capacity", sql`${t.capacity} >= 0`)]);

export const admissionProjects = pgTable("execution_admission_projects", {
  companyId: uuid("company_id").notNull().references(() => companies.id),
  projectKey: text("project_key").notNull(),
  lastGrant: bigint("last_grant", { mode: "bigint" }).notNull().default(sql`0`),
}, t => [primaryKey({ columns: [t.companyId, t.projectKey] })]);

// Linked admission metadata, not a second queue: native run/wake/issue authority
// must be claimed in the very same transaction as the reservation.
export const admissionAttempts = pgTable("execution_admission_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  runId: uuid("run_id").references(() => heartbeatRuns.id),
  operationKey: text("operation_key"),
  operationKind: text("operation_kind").$type<"probe" | "adapter_test" | "lifecycle">(),
  operationResult: text("operation_result").$type<"complete">(),
  contract: jsonb("contract").$type<Record<string, unknown>>(),
  restoration: jsonb("restoration").$type<{ workspace?: boolean; session?: boolean; credential?: boolean }>().notNull().default({}),
  eligibleUntil: timestamp("eligible_until", { withTimezone: true }),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  issueId: uuid("issue_id").references(() => issues.id),
  projectKey: text("project_key").notNull(),
  enqueueOrder: bigint("enqueue_order", { mode: "bigint" }).generatedAlwaysAsIdentity().notNull(),
  scopes: text("scopes").array().notNull(),
  state: text("state").$type<AdmissionState>().notNull().default("queued"),
  waitReason: text("wait_reason"),
  ownerEpoch: uuid("owner_epoch").references(() => admissionEpochs.epoch),
  token: uuid("token"),
  grantOrder: bigint("grant_order", { mode: "bigint" }),
  binding: jsonb("binding").$type<AdmissionLaunchBinding>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("execution_admission_owner", sql`(${t.runId} is not null and ${t.operationKey} is null and ${t.operationKind} is null) or (${t.runId} is null and ${t.operationKey} is not null and ${t.operationKind} is not null and ${t.operationKind} in ('probe','adapter_test','lifecycle'))`),
  uniqueIndex("execution_admission_operation_unsettled").on(t.companyId, t.agentId, t.operationKind, t.operationKey).where(sql`${t.state} not in ('released','cancelled')`),
  foreignKey({ columns: [t.companyId, t.projectKey], foreignColumns: [admissionProjects.companyId, admissionProjects.projectKey] }),
  check("execution_admission_scopes_nonempty", sql`cardinality(${t.scopes}) > 0`),
  check("execution_admission_state", sql`${t.state} in ('queued','reserved','starting','stopping','uncertain','released','cancelled')`),
  uniqueIndex("execution_admission_run_unsettled").on(t.runId).where(sql`${t.state} not in ('released','cancelled')`),
  uniqueIndex("execution_admission_enqueue_order").on(t.enqueueOrder),
  uniqueIndex("execution_admission_token").on(t.token),
  uniqueIndex("execution_admission_grant_order").on(t.grantOrder),
  uniqueIndex("execution_admission_invocation").on(sql`(${t.binding}->>'invocationId')`).where(sql`${t.binding} is not null`),
  index("execution_admission_company_run").on(t.companyId, t.runId),
]);

// Every executable helper has a separate single-use remote attempt identity.
// A parent cannot be released while even one child lacks an exact stop proof.
export const admissionCommands = pgTable("execution_admission_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id").notNull().references(() => admissionAttempts.id),
  binding: jsonb("binding").$type<AdmissionLaunchBinding>().notNull(),
  fenceRoot: text("fence_root").notNull(),
  commandHash: text("command_hash").notNull(),
  stopped: boolean("stopped").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("execution_admission_command_invocation").on(sql`(${t.binding}->>'invocationId')`)]);

export const admissionRunnerEpochs = pgTable("execution_admission_runner_epochs", {
  runner: text("runner").primaryKey(),
  fenceRoot: text("fence_root").notNull(),
  epoch: uuid("epoch").notNull().references(() => admissionEpochs.epoch),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
});

export const admissionRestorations = pgTable("execution_admission_restorations", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id").notNull().references(() => admissionAttempts.id),
  kind: text("kind").$type<"workspace" | "session" | "credential">().notNull(),
  descriptor: jsonb("descriptor").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<"pending" | "success" | "failed">().notNull().default("pending"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("execution_admission_restoration_kind", sql`${t.kind} in ('workspace','session','credential')`),
  check("execution_admission_restoration_status", sql`${t.status} in ('pending','success','failed')`),
]);

// Historical occupancy is independent of fresh reservations and scope drains.
// Original native rows remain untouched. No TTL, cascade, or run-state projection
// is allowed to erase an unresolved hold. A separate reviewed present-day
// reconciliation ledger is required before any release mechanism is introduced.
export const admissionLegacyHolds = pgTable("execution_admission_legacy_holds", {
  source: text("source").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  agentId: uuid("agent_id").references(() => agents.id),
  runId: uuid("run_id").references(() => heartbeatRuns.id),
  environmentId: uuid("environment_id"),
  scopes: text("scopes").array().notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  policyHash: text("policy_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("execution_admission_legacy_scopes", sql`cardinality(${t.scopes}) > 0`),
  check("execution_admission_legacy_hash", sql`${t.evidenceHash} ~ '^[a-f0-9]{64}$' and ${t.policyHash} ~ '^[a-f0-9]{64}$'`),
]);

export const admissionBootstraps = pgTable("execution_admission_bootstraps", {
  epoch: uuid("epoch").primaryKey().references(() => admissionEpochs.epoch),
  policyHash: text("policy_hash").notNull(),
  instance: text("instance").notNull(),
  mode: text("mode").$type<"held">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("execution_admission_bootstrap_mode", sql`${t.mode} = 'held'`)]);

// Append-only present-day decisions. Historical leases and holds remain intact.
export const admissionLegacyDecisions = pgTable("execution_admission_legacy_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull().references(() => admissionLegacyHolds.source),
  sequence: bigint("sequence", { mode: "bigint" }).notNull(),
  decisionHash: text("decision_hash").notNull(),
  decision: jsonb("decision").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("execution_admission_legacy_decision_order").on(t.source, t.sequence),
  uniqueIndex("execution_admission_legacy_decision_hash").on(t.decisionHash)]);

// Independent verifier high-water state. Supervisor/runner snapshots cannot
// replace it. Requests are committed before transport and ACK application is a
// compare-and-set transaction; ambiguous transport never replays a command.
export const protectedAuthorityPins = pgTable("execution_protected_authority_pins", {
  pool: text("pool").primaryKey(),
  instance: text("instance").notNull(),
  policy: text("policy").notNull(),
  incarnation: text("incarnation").notNull(),
  generation: integer("generation").notNull().default(0),
  epoch: text("epoch"),
  revision: integer("revision").notNull().default(0),
}, t => [check("execution_protected_pin_generation", sql`${t.generation} >= 0 and ${t.revision} >= 0`)]);

export const protectedAuthorityRequests = pgTable("execution_protected_authority_requests", {
  nonce: uuid("nonce").primaryKey(),
  pool: text("pool").notNull().references(() => protectedAuthorityPins.pool),
  pinRevision: integer("pin_revision").notNull(),
  request: jsonb("request").$type<Record<string, unknown>>().notNull(),
  requestHash: text("request_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  receipt: jsonb("receipt").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const protectedCommandJournals = pgTable("execution_protected_command_journals", {
  commandId: uuid("command_id").primaryKey().references(() => admissionCommands.id),
  pool: text("pool").notNull().references(() => protectedAuthorityPins.pool),
  contract: jsonb("contract").$type<Record<string, unknown>>().notNull(),
  contractHash: text("contract_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
