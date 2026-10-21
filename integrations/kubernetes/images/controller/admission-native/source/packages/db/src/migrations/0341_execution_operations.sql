CREATE TABLE "execution_admission_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"binding" jsonb NOT NULL,
	"fence_root" text NOT NULL,
	"command_hash" text NOT NULL,
	"stopped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_admission_runner_epochs" (
	"runner" text PRIMARY KEY NOT NULL,
	"fence_root" text NOT NULL,
	"epoch" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD COLUMN "operation_key" text;--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD COLUMN "operation_kind" text;--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD COLUMN "contract" jsonb;--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD COLUMN "restoration" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_admission_commands" ADD CONSTRAINT "execution_admission_commands_attempt_id_execution_admission_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."execution_admission_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_admission_runner_epochs" ADD CONSTRAINT "execution_admission_runner_epochs_epoch_execution_admission_epochs_epoch_fk" FOREIGN KEY ("epoch") REFERENCES "public"."execution_admission_epochs"("epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admission_command_invocation" ON "execution_admission_commands" USING btree (("binding"->>'invocationId'));--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admission_operation_unsettled" ON "execution_admission_attempts" USING btree ("company_id","agent_id","operation_kind","operation_key") WHERE "execution_admission_attempts"."state" not in ('released','cancelled');--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD CONSTRAINT "execution_admission_owner" CHECK (("execution_admission_attempts"."run_id" is not null and "execution_admission_attempts"."operation_key" is null and "execution_admission_attempts"."operation_kind" is null) or ("execution_admission_attempts"."run_id" is null and "execution_admission_attempts"."operation_key" is not null and "execution_admission_attempts"."operation_kind" in ('probe','adapter_test','lifecycle')));