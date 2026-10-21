CREATE TABLE "execution_admission_legacy_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"sequence" bigint NOT NULL,
	"decision_hash" text NOT NULL,
	"decision" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_admission_legacy_decisions" ADD CONSTRAINT "execution_admission_legacy_decisions_source_execution_admission_legacy_holds_source_fk" FOREIGN KEY ("source") REFERENCES "public"."execution_admission_legacy_holds"("source") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admission_legacy_decision_order" ON "execution_admission_legacy_decisions" USING btree ("source","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_admission_legacy_decision_hash" ON "execution_admission_legacy_decisions" USING btree ("decision_hash");
--> statement-breakpoint
CREATE FUNCTION execution_admission_legacy_decisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'legacy reconciliation decisions are append-only'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_admission_legacy_decisions_immutable
BEFORE UPDATE OR DELETE ON execution_admission_legacy_decisions
FOR EACH ROW EXECUTE FUNCTION execution_admission_legacy_decisions_immutable();
