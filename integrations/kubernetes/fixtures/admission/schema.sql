-- Disposable fixture schema, deliberately NOT a Paperclip migration.
-- No cascade may erase unresolved occupancy. No TTL releases reservations.
CREATE TABLE admission_scheduler (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch uuid NOT NULL,
  draining boolean NOT NULL DEFAULT true,
  sequence bigint NOT NULL DEFAULT 0,
  pending_limit integer NOT NULL CHECK (pending_limit > 0),
  recovery_point timestamptz,
  evaluation_exemption_until timestamptz
);
CREATE TABLE admission_scopes (
  key text PRIMARY KEY,
  capacity integer NOT NULL CHECK (capacity >= 0),
  draining boolean NOT NULL DEFAULT false,
  not_before timestamptz,
  revision integer NOT NULL DEFAULT 1
);
CREATE TABLE admission_projects (
  company_id uuid NOT NULL,
  project_key text NOT NULL,
  last_grant bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(company_id, project_key)
);
CREATE TABLE admission_attempts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  project_key text NOT NULL,
  operation_key text NOT NULL,
  enqueue_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN
    ('queued','reserved','starting','running','stopping','uncertain','released','cancelled')),
  eligible boolean NOT NULL DEFAULT true,
  wait_reason text,
  not_before timestamptz,
  owner_epoch uuid,
  token uuid UNIQUE,
  grant_order bigint UNIQUE,
  binding jsonb,
  stop_evidence jsonb,
  restoration_complete boolean NOT NULL DEFAULT false,
  FOREIGN KEY(company_id, project_key) REFERENCES admission_projects(company_id, project_key)
);
CREATE UNIQUE INDEX admission_operation_unsettled ON admission_attempts(company_id, operation_key)
  WHERE state NOT IN ('released','cancelled');
CREATE INDEX admission_occupancy ON admission_attempts USING gin(scopes)
  WHERE state IN ('reserved','starting','running','stopping','uncertain');
