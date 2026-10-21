CREATE TABLE "execution_admission_restorations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"descriptor" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_admission_attempts" ADD COLUMN "eligible_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "execution_admission_restorations" ADD CONSTRAINT "execution_admission_restorations_attempt_id_execution_admission_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."execution_admission_attempts"("id") ON DELETE no action ON UPDATE no action;