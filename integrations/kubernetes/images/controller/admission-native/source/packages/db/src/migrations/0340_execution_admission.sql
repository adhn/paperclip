CREATE TABLE "execution_admission_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"project_key" text NOT NULL,
	"enqueue_order" bigint GENERATED ALWAYS AS IDENTITY (sequence name "execution_admission_attempts_enqueue_order_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scopes" text[] NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"wait_reason" text,
	"owner_epoch" uuid,
	"token" uuid,
	"grant_order" bigint,
	"binding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_admission_scopes_nonempty" CHECK (cardinality("execution_admission_attempts"."scopes") > 0),
	CONSTRAINT "execution_admission_state" CHECK ("execution_admission_attempts"."state" in ('queued','reserved','starting','stopping','uncertain','released','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "execution_admission_epochs" (
	"epoch" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_admission_projects" (
	"company_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"last_grant" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "execution_admission_projects_company_id_project_key_pk" PRIMARY KEY("company_id","project_key")
);
--> statement-breakpoint
CREATE TABLE "execution_admission_scheduler" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"epoch" uuid NOT NULL,
	"draining" boolean DEFAULT true NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"pending_limit" integer NOT NULL,
	"recovery_point" timestamp with time zone,
	"evaluation_exemption_until" timestamp with time zone,
	CONSTRAINT "execution_admission_singleton" CHECK ("execution_admission_scheduler"."singleton"),
	CONSTRAINT "execution_admission_pending_limit" CHECK ("execution_admission_scheduler"."pending_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "execution_admission_scopes" (
	"key" text PRIMARY KEY NOT NULL,
	"capacity" integer NOT NULL,
	"draining" boolean DEFAULT false NOT NULL,
	"not_before" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "execution_admission_capacity" CHECK ("execution_admission_scopes"."capacity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD CONSTRAINT "execution_admission_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD CONSTRAINT "execution_admission_attempts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD CONSTRAINT "execution_admission_attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD CONSTRAINT "execution_admission_attempts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD CONSTRAINT "execution_admission_attempts_owner_epoch_execution_admission_epochs_epoch_fk" FOREIGN KEY ("owner_epoch") REFERENCES "public"."execution_admission_epochs"("epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD CONSTRAINT "execution_admission_attempts_company_id_project_key_execution_admission_projects_company_id_project_key_fk" FOREIGN KEY ("company_id","project_key") REFERENCES "public"."execution_admission_projects"("company_id","project_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_projects" ADD CONSTRAINT "execution_admission_projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_scheduler" ADD CONSTRAINT "execution_admission_scheduler_epoch_execution_admission_epochs_epoch_fk" FOREIGN KEY ("epoch") REFERENCES "public"."execution_admission_epochs"("epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admission_run_unsettled" ON "execution_admission_attempts" USING btree ("run_id") WHERE "execution_admission_attempts"."state" not in ('released','cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admission_enqueue_order" ON "execution_admission_attempts" USING btree ("enqueue_order");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admission_token" ON "execution_admission_attempts" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admission_grant_order" ON "execution_admission_attempts" USING btree ("grant_order");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admission_invocation" ON "execution_admission_attempts" USING btree (("binding"->>'invocationId')) WHERE "execution_admission_attempts"."binding" is not null;--> statement-breakpoint
CREATE INDEX "execution_admission_company_run" ON "execution_admission_attempts" USING btree ("company_id","run_id");