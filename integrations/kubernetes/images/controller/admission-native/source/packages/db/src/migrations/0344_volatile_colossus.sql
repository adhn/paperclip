CREATE TABLE "execution_admission_bootstraps" (
	"epoch" uuid PRIMARY KEY NOT NULL,
	"policy_hash" text NOT NULL,
	"instance" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_admission_bootstrap_mode" CHECK ("execution_admission_bootstraps"."mode" = 'held')
);
--> statement-breakpoint
CREATE TABLE "execution_admission_legacy_holds" (
	"source" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"environment_id" uuid,
	"scopes" text[] NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"policy_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_admission_legacy_scopes" CHECK (cardinality("execution_admission_legacy_holds"."scopes") > 0),
	CONSTRAINT "execution_admission_legacy_hash" CHECK ("execution_admission_legacy_holds"."evidence_hash" ~ '^[a-f0-9]{64}$' and "execution_admission_legacy_holds"."policy_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "execution_admission_bootstraps" ADD CONSTRAINT "execution_admission_bootstraps_epoch_execution_admission_epochs_epoch_fk" FOREIGN KEY ("epoch") REFERENCES "public"."execution_admission_epochs"("epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_legacy_holds" ADD CONSTRAINT "execution_admission_legacy_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_legacy_holds" ADD CONSTRAINT "execution_admission_legacy_holds_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_legacy_holds" ADD CONSTRAINT "execution_admission_legacy_holds_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;