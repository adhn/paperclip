-- INACTIVE REVIEW TEXT. NOT A MIGRATION. No statement below is executable.
-- All proposed SQL is inside one block comment, ending at end of file.
-- SQL execution, schema validation and concurrency tests: NOT RUN.
/*
-- Proposed owner: paperclip_authority_owner NOLOGIN, not granted to application.
-- Proposed sole caller: paperclip_authority_executor LOGIN, no role membership,
-- no BYPASSRLS, no superuser, no CREATE privileges, no underlying table writes.
-- Provisioning roles, credentials and recovery are separate reviewed work.
CREATE SCHEMA paperclip_h AUTHORIZATION paperclip_authority_owner;
REVOKE ALL ON SCHEMA paperclip_h FROM PUBLIC;
GRANT USAGE ON SCHEMA paperclip_h TO paperclip_authority_executor;

CREATE TABLE paperclip_h.generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  incarnation uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  phase text NOT NULL CHECK (phase IN ('held','open','recovering')),
  inventory_hash text NOT NULL CHECK (inventory_hash ~ '^[0-9a-f]{64}$')
);
-- Intentionally no initial row: absence fails closed, never bootstrap empty H.
CREATE TABLE paperclip_h.scopes (
  scope_id text PRIMARY KEY,
  capacity integer NOT NULL CHECK (capacity > 0),
  held boolean NOT NULL DEFAULT true
);
CREATE TABLE paperclip_h.original_holds (
  source text PRIMARY KEY,
  hold_hash text NOT NULL CHECK (hold_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  status text NOT NULL CHECK (status IN ('held','reconciled','deny-pending','revoked')),
  decision_sequence bigint NOT NULL CHECK (decision_sequence >= 0),
  decision_hash text,
  supported boolean NOT NULL DEFAULT false
);
-- Original account/session/workspace families, all aliases and unsupported
-- sources must be imported independently before phase=open. No INSERT grants.
CREATE TABLE paperclip_h.approved_requests (
  operation_id uuid PRIMARY KEY,
  incarnation uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  operation_kind text NOT NULL CHECK (operation_kind IN ('claim','release','deny')),
  target_id uuid NOT NULL,
  descriptor jsonb NOT NULL CHECK (jsonb_typeof(descriptor)='object')
);
-- Persisted BEFORE submission by missing independent fact/consent importer.
-- This original prospective record remains occupied when effect outcome is lost.
CREATE TABLE paperclip_h.operations (
  operation_id uuid PRIMARY KEY REFERENCES paperclip_h.approved_requests(operation_id),
  incarnation uuid NOT NULL,
  epoch bigint NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  operation_kind text NOT NULL CHECK (operation_kind IN ('claim','release','deny')),
  target_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('committed-exact','deny-committed')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE paperclip_h.claims (
  claim_id uuid PRIMARY KEY,
  admission_operation_id uuid NOT NULL UNIQUE REFERENCES paperclip_h.operations(operation_id),
  owner_run_id uuid NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  phase text NOT NULL CHECK (phase IN ('occupied','released'))
);
CREATE TABLE paperclip_h.prospective_denials (
  deny_id uuid PRIMARY KEY,
  source text NOT NULL REFERENCES paperclip_h.original_holds(source),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  previous_decision_hash text NOT NULL CHECK (previous_decision_hash ~ '^[0-9a-f]{64}$'),
  next_sequence bigint NOT NULL CHECK (next_sequence >= 2),
  operator_approval_hash text NOT NULL CHECK (operator_approval_hash ~ '^[0-9a-f]{64}$'),
  stage text NOT NULL CHECK (stage IN ('prospective','native-denied','settled'))
);
-- Only an independent reviewed evidence importer can create/update these rows.
-- No caller-provided boolean or callback can manufacture completed B/exclusion.
CREATE TABLE paperclip_h.release_facts (
  claim_id uuid PRIMARY KEY REFERENCES paperclip_h.claims(claim_id),
  owner_run_id uuid NOT NULL,
  incarnation uuid NOT NULL,
  epoch bigint NOT NULL,
  runtime_barrier_hash text NOT NULL CHECK (runtime_barrier_hash ~ '^[0-9a-f]{64}$'),
  storage_exclusion_hash text NOT NULL CHECK (storage_exclusion_hash ~ '^[0-9a-f]{64}$'),
  root_group_hash text NOT NULL CHECK (root_group_hash ~ '^[0-9a-f]{64}$'),
  facts_hash text NOT NULL CHECK (facts_hash ~ '^[0-9a-f]{64}$'),
  valid_until timestamptz NOT NULL,
  consumed_by uuid UNIQUE
);

-- Internal routine; no EXECUTE grant. Every effect locks this SAME row through
-- COMMIT, never check in one transaction and mutate in a later transaction.
CREATE FUNCTION paperclip_h.require_generation(p_incarnation uuid, p_epoch bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, paperclip_h AS $body$
DECLARE g paperclip_h.generation%ROWTYPE;
BEGIN
  IF session_user <> 'paperclip_authority_executor' OR
     current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'sole executor and serializable transaction required';
  END IF;
  SELECT * INTO STRICT g FROM paperclip_h.generation WHERE singleton FOR UPDATE;
  IF g.phase <> 'open' OR g.incarnation IS DISTINCT FROM p_incarnation OR
     g.epoch IS DISTINCT FROM p_epoch THEN
    RAISE EXCEPTION 'authority generation held';
  END IF;
END
$body$;

-- No direct EXECUTE grant. Caller cannot invent a requestHash and thereby
-- acquire authority: all typed fields must match the independently retained row.
CREATE FUNCTION paperclip_h.require_request(
  p_operation uuid, p_hash text, p_incarnation uuid, p_epoch bigint,
  p_kind text, p_target uuid, p_descriptor jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, paperclip_h AS $body$
DECLARE r paperclip_h.approved_requests%ROWTYPE;
BEGIN
  SELECT * INTO STRICT r FROM paperclip_h.approved_requests
    WHERE operation_id=p_operation FOR UPDATE;
  IF r.incarnation IS DISTINCT FROM p_incarnation OR r.epoch IS DISTINCT FROM p_epoch OR
     r.request_hash IS DISTINCT FROM p_hash OR r.operation_kind IS DISTINCT FROM p_kind OR
     r.target_id IS DISTINCT FROM p_target OR r.descriptor IS DISTINCT FROM p_descriptor THEN
    RAISE EXCEPTION 'retained exact prospective request required';
  END IF;
END
$body$;

-- claim itself IS the authoritative native admission effect, not permission for
-- Paperclip to create another independently authoritative reservation afterward.
CREATE FUNCTION paperclip_h.claim(
  p_operation uuid, p_hash text, p_incarnation uuid, p_epoch bigint,
  p_claim uuid, p_run uuid, p_scopes text[], p_sources text[], p_inventory text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, paperclip_h AS $body$
DECLARE existing paperclip_h.operations%ROWTYPE;
        required_sources text[]; canonical_scopes text[]; s text; n bigint;
BEGIN
  PERFORM paperclip_h.require_generation(p_incarnation, p_epoch);
  IF p_operation IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR
     p_claim IS NULL OR p_run IS NULL OR p_scopes IS NULL OR
     cardinality(p_scopes) = 0 OR p_sources IS NULL OR p_inventory IS NULL THEN
    RAISE EXCEPTION 'exact nonempty typed request required';
  END IF;
  PERFORM paperclip_h.require_request(p_operation,p_hash,p_incarnation,p_epoch,
    'claim',p_claim,jsonb_build_object('claim',p_claim,'run',p_run,'scopes',p_scopes,
                                      'sources',p_sources,'inventoryHash',p_inventory));
  SELECT * INTO existing FROM paperclip_h.operations WHERE operation_id=p_operation;
  IF FOUND THEN
    IF existing.request_hash IS DISTINCT FROM p_hash OR
       existing.operation_kind <> 'claim' OR existing.target_id IS DISTINCT FROM p_claim OR
       existing.incarnation IS DISTINCT FROM p_incarnation OR existing.epoch IS DISTINCT FROM p_epoch THEN
      RAISE EXCEPTION 'operation identity conflict';
    END IF;
    RETURN 'already-recorded-inspect-original';
  END IF;
  SELECT array_agg(x ORDER BY x) INTO canonical_scopes FROM
    (SELECT DISTINCT unnest(p_scopes) AS x) members;
  IF p_scopes IS DISTINCT FROM canonical_scopes OR array_position(p_scopes,NULL) IS NOT NULL OR
     p_inventory IS DISTINCT FROM (SELECT inventory_hash FROM paperclip_h.generation WHERE singleton) THEN
    RAISE EXCEPTION 'complete canonical inventory required';
  END IF;
  SELECT coalesce(array_agg(source ORDER BY source), ARRAY[]::text[]) INTO required_sources
    FROM paperclip_h.original_holds WHERE scopes && p_scopes;
  IF p_sources IS DISTINCT FROM required_sources OR EXISTS (
    SELECT 1 FROM paperclip_h.original_holds WHERE scopes && p_scopes
      AND (status <> 'reconciled' OR NOT supported)) THEN
    RAISE EXCEPTION 'original shared hold closure remains held';
  END IF;
  FOREACH s IN ARRAY p_scopes LOOP
    IF NOT EXISTS (SELECT 1 FROM paperclip_h.scopes WHERE scope_id=s AND NOT held) THEN
      RAISE EXCEPTION 'unknown or held original scope';
    END IF;
    SELECT count(*) INTO n FROM paperclip_h.claims WHERE phase='occupied' AND s=ANY(scopes);
    IF n >= (SELECT capacity FROM paperclip_h.scopes WHERE scope_id=s) THEN
      RAISE EXCEPTION 'scope capacity occupied';
    END IF;
  END LOOP;
  INSERT INTO paperclip_h.operations VALUES
    (p_operation,p_incarnation,p_epoch,p_hash,'claim',p_claim,'committed-exact',clock_timestamp());
  INSERT INTO paperclip_h.claims VALUES (p_claim,p_operation,p_run,p_scopes,'occupied');
  RETURN 'committed-exact';
END
$body$;

-- This orders ONLY the native deny, not runtime T, completed B, physical
-- exclusion, total revoked-settled, or historical receipt reconstruction.
CREATE FUNCTION paperclip_h.deny(
  p_operation uuid, p_hash text, p_incarnation uuid, p_epoch bigint, p_deny uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, paperclip_h AS $body$
DECLARE d paperclip_h.prospective_denials%ROWTYPE; h paperclip_h.original_holds%ROWTYPE;
        existing paperclip_h.operations%ROWTYPE;
BEGIN
  PERFORM paperclip_h.require_generation(p_incarnation,p_epoch);
  IF p_operation IS NULL OR p_deny IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'exact deny identity required';
  END IF;
  SELECT * INTO existing FROM paperclip_h.operations WHERE operation_id=p_operation;
  IF FOUND THEN
    IF existing.request_hash IS DISTINCT FROM p_hash OR existing.operation_kind <> 'deny' OR
       existing.target_id IS DISTINCT FROM p_deny OR
       existing.incarnation IS DISTINCT FROM p_incarnation OR existing.epoch IS DISTINCT FROM p_epoch THEN
      RAISE EXCEPTION 'operation identity conflict';
    END IF;
    RETURN 'already-recorded-inspect-original';
  END IF;
  SELECT * INTO STRICT d FROM paperclip_h.prospective_denials WHERE deny_id=p_deny FOR UPDATE;
  SELECT * INTO STRICT h FROM paperclip_h.original_holds WHERE source=d.source FOR UPDATE;
  PERFORM paperclip_h.require_request(p_operation,p_hash,p_incarnation,p_epoch,
    'deny',p_deny,jsonb_build_object('deny',p_deny,'source',d.source,'intentHash',d.intent_hash,
      'previousDecisionHash',d.previous_decision_hash,'nextSequence',d.next_sequence,
      'operatorApprovalHash',d.operator_approval_hash));
  IF d.stage <> 'prospective' OR h.decision_sequence + 1 <> d.next_sequence OR
     h.decision_hash IS DISTINCT FROM d.previous_decision_hash THEN
    RAISE EXCEPTION 'prospective deny predecessor conflict';
  END IF;
  UPDATE paperclip_h.original_holds SET status='deny-pending' WHERE source=d.source;
  UPDATE paperclip_h.prospective_denials SET stage='native-denied' WHERE deny_id=p_deny;
  INSERT INTO paperclip_h.operations VALUES
    (p_operation,p_incarnation,p_epoch,p_hash,'deny',p_deny,'deny-committed',clock_timestamp());
  RETURN 'native-denied-only';
END
$body$;

CREATE FUNCTION paperclip_h.release(
  p_operation uuid, p_hash text, p_incarnation uuid, p_epoch bigint,
  p_claim uuid, p_run uuid, p_facts_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, paperclip_h AS $body$
DECLARE c paperclip_h.claims%ROWTYPE; f paperclip_h.release_facts%ROWTYPE;
        existing paperclip_h.operations%ROWTYPE;
BEGIN
  PERFORM paperclip_h.require_generation(p_incarnation,p_epoch);
  IF p_operation IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR
     p_claim IS NULL OR p_run IS NULL OR p_facts_hash IS NULL THEN
    RAISE EXCEPTION 'exact release identity required';
  END IF;
  PERFORM paperclip_h.require_request(p_operation,p_hash,p_incarnation,p_epoch,
    'release',p_claim,jsonb_build_object('claim',p_claim,'run',p_run,'factsHash',p_facts_hash));
  SELECT * INTO existing FROM paperclip_h.operations WHERE operation_id=p_operation;
  IF FOUND THEN
    IF existing.request_hash IS DISTINCT FROM p_hash OR existing.operation_kind <> 'release' OR
       existing.target_id IS DISTINCT FROM p_claim OR
       existing.incarnation IS DISTINCT FROM p_incarnation OR existing.epoch IS DISTINCT FROM p_epoch THEN
      RAISE EXCEPTION 'operation identity conflict';
    END IF;
    RETURN 'already-recorded-inspect-original';
  END IF;
  SELECT * INTO STRICT c FROM paperclip_h.claims WHERE claim_id=p_claim FOR UPDATE;
  SELECT * INTO STRICT f FROM paperclip_h.release_facts WHERE claim_id=p_claim FOR UPDATE;
  IF c.phase <> 'occupied' OR c.owner_run_id IS DISTINCT FROM p_run OR
     f.owner_run_id IS DISTINCT FROM p_run OR f.incarnation IS DISTINCT FROM p_incarnation OR
     f.epoch IS DISTINCT FROM p_epoch OR f.facts_hash IS DISTINCT FROM p_facts_hash OR
     f.valid_until <= clock_timestamp() OR f.consumed_by IS NOT NULL THEN
    RAISE EXCEPTION 'release facts incomplete or stale';
  END IF;
  INSERT INTO paperclip_h.operations VALUES
    (p_operation,p_incarnation,p_epoch,p_hash,'release',p_claim,'committed-exact',clock_timestamp());
  UPDATE paperclip_h.release_facts SET consumed_by=p_operation WHERE claim_id=p_claim;
  UPDATE paperclip_h.claims SET phase='released' WHERE claim_id=p_claim;
  RETURN 'committed-exact';
END
$body$;

-- Proposed grants only AFTER all predicates/callers/evidence/recovery validated.
-- Functions default to PUBLIC EXECUTE: revoke before exposing schema/connection.
REVOKE ALL ON ALL TABLES IN SCHEMA paperclip_h FROM PUBLIC, paperclip_authority_executor;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA paperclip_h FROM PUBLIC, paperclip_authority_executor;
GRANT EXECUTE ON FUNCTION paperclip_h.claim(uuid,text,uuid,bigint,uuid,uuid,text[],text[],text)
  TO paperclip_authority_executor;
GRANT EXECUTE ON FUNCTION paperclip_h.deny(uuid,text,uuid,bigint,uuid)
  TO paperclip_authority_executor;
GRANT EXECUTE ON FUNCTION paperclip_h.release(uuid,text,uuid,bigint,uuid,uuid,text)
  TO paperclip_authority_executor;
-- Read-only journal inspector role requires separate exact row-level view design.
-- No grants for evidence ingestion, generation open/rotation, source import,
-- current witness update, native P projection mutation or revoked settlement.
-- Owner/function ownership reassignment and search-path/grant auditing remain
-- deployment requirements. A superuser/restore administrator bypasses SQL roles.
*/
