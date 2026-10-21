CREATE TABLE "execution_protected_authority_pins" (
	"pool" text PRIMARY KEY NOT NULL,
	"instance" text NOT NULL,
	"policy" text NOT NULL,
	"incarnation" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"epoch" text,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "execution_protected_pin_generation" CHECK ("execution_protected_authority_pins"."generation" >= 0 and "execution_protected_authority_pins"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "execution_protected_authority_requests" (
	"nonce" uuid PRIMARY KEY NOT NULL,
	"pool" text NOT NULL,
	"pin_revision" integer NOT NULL,
	"request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_protected_command_journals" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"pool" text NOT NULL,
	"contract" jsonb NOT NULL,
	"contract_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_protected_authority_requests" ADD CONSTRAINT "execution_protected_authority_requests_pool_execution_protected_authority_pins_pool_fk" FOREIGN KEY ("pool") REFERENCES "public"."execution_protected_authority_pins"("pool") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_protected_command_journals" ADD CONSTRAINT "execution_protected_command_journals_command_id_execution_admission_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."execution_admission_commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_protected_command_journals" ADD CONSTRAINT "execution_protected_command_journals_pool_execution_protected_authority_pins_pool_fk" FOREIGN KEY ("pool") REFERENCES "public"."execution_protected_authority_pins"("pool") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION execution_protected_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'protected execution history cannot be deleted'; END IF;
  IF TG_TABLE_NAME = 'execution_protected_authority_pins' THEN
    IF NEW.pool <> OLD.pool OR NEW.instance <> OLD.instance OR NEW.policy <> OLD.policy OR NEW.incarnation <> OLD.incarnation
      OR NEW.revision <> OLD.revision + 1 OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation + 1
      OR (NEW.generation = OLD.generation AND NEW.epoch IS DISTINCT FROM OLD.epoch) THEN
      RAISE EXCEPTION 'protected execution high-water identity/monotonicity violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'execution_protected_authority_requests' THEN
    IF OLD.receipt IS NOT NULL OR NEW.receipt IS NULL OR
      (to_jsonb(NEW) - 'receipt') IS DISTINCT FROM (to_jsonb(OLD) - 'receipt') THEN
      RAISE EXCEPTION 'protected execution request/receipt is immutable';
    END IF;
  ELSE
    RAISE EXCEPTION 'protected execution committed journal is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER execution_protected_pin_immutable BEFORE UPDATE OR DELETE ON execution_protected_authority_pins
  FOR EACH ROW EXECUTE FUNCTION execution_protected_immutable();
--> statement-breakpoint
CREATE TRIGGER execution_protected_request_immutable BEFORE UPDATE OR DELETE ON execution_protected_authority_requests
  FOR EACH ROW EXECUTE FUNCTION execution_protected_immutable();
--> statement-breakpoint
CREATE TRIGGER execution_protected_journal_immutable BEFORE UPDATE OR DELETE ON execution_protected_command_journals
  FOR EACH ROW EXECUTE FUNCTION execution_protected_immutable();
