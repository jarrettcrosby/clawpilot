-- An agent acknowledgement proves only that bytes were handed to the configured
-- device. Physical paper or label output requires a separate, human-authored,
-- append-only attestation fenced to the exact terminal delivery ledger event.

CREATE TABLE IF NOT EXISTS operations_print_physical_output_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  print_job_id uuid NOT NULL,
  delivery_attempt_id uuid NOT NULL,
  delivery_attempt_sequence_number integer NOT NULL
    CHECK (delivery_attempt_sequence_number > 0),
  delivered_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  verified_by text NOT NULL,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  CONSTRAINT operations_print_physical_output_reason_valid CHECK (
    NULLIF(btrim(reason), '') IS NOT NULL
    AND length(reason) <= 500
    AND reason !~ E'[\\001-\\010\\013\\014\\016-\\037\\177]'
  ),
  CONSTRAINT operations_print_physical_output_verified_by_valid CHECK (
    verified_by = lower(btrim(verified_by))
    AND verified_by LIKE '%@%'
  ),
  CONSTRAINT operations_print_physical_output_idempotency_present CHECK (
    NULLIF(btrim(idempotency_key), '') IS NOT NULL
  ),
  CONSTRAINT operations_print_physical_output_fingerprint_valid CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT operations_print_physical_output_job_fkey
    FOREIGN KEY (organization_id, print_job_id)
    REFERENCES operations_print_jobs(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_physical_output_attempt_fkey
    FOREIGN KEY (organization_id, print_job_id, delivery_attempt_id)
    REFERENCES operations_print_delivery_attempts(
      organization_id, print_job_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_print_physical_output_one_per_job
    UNIQUE (organization_id, print_job_id),
  CONSTRAINT operations_print_physical_output_idempotency_unique
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_operations_print_physical_output_verified
  ON operations_print_physical_output_attestations (
    organization_id, verified_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION validate_operations_print_physical_output_attestation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  print_job operations_print_jobs%ROWTYPE;
  delivered_attempt operations_print_delivery_attempts%ROWTYPE;
  latest_attempt_id uuid;
  verifier_membership app_user_organization_memberships%ROWTYPE;
BEGIN
  SELECT job.*
    INTO print_job
    FROM operations_print_jobs job
   WHERE job.organization_id = NEW.organization_id
     AND job.id = NEW.print_job_id
   FOR UPDATE;

  IF print_job.id IS NULL OR print_job.status <> 'delivered' THEN
    RAISE EXCEPTION
      'physical output can only be attested for a delivered print job'
      USING ERRCODE = '23514';
  END IF;

  SELECT attempt.*
    INTO delivered_attempt
    FROM operations_print_delivery_attempts attempt
   WHERE attempt.organization_id = NEW.organization_id
     AND attempt.print_job_id = NEW.print_job_id
     AND attempt.id = NEW.delivery_attempt_id
     AND attempt.state = 'delivered';

  SELECT attempt.id
    INTO latest_attempt_id
    FROM operations_print_delivery_attempts attempt
   WHERE attempt.organization_id = NEW.organization_id
     AND attempt.print_job_id = NEW.print_job_id
   ORDER BY attempt.sequence_number DESC
   LIMIT 1;

  IF delivered_attempt.id IS NULL
     OR latest_attempt_id IS DISTINCT FROM delivered_attempt.id
     OR print_job.delivered_at IS DISTINCT FROM delivered_attempt.occurred_at
     OR NEW.delivery_attempt_sequence_number
       IS DISTINCT FROM delivered_attempt.sequence_number THEN
    RAISE EXCEPTION
      'physical output attestation delivery version is not current'
      USING ERRCODE = '23514';
  END IF;

  SELECT membership.*
    INTO verifier_membership
    FROM app_user_organization_memberships membership
   WHERE membership.user_email = NEW.verified_by
     AND membership.organization_id = NEW.organization_id;

  IF verifier_membership.user_email IS NULL
     OR verifier_membership.status <> 'active'
     OR NOT (
       verifier_membership.role = 'owner'
       OR verifier_membership.permissions
         @> '{"executeWarehouse":true}'::jsonb
     ) THEN
    RAISE EXCEPTION
      'physical output attestation requires active warehouse execution access'
      USING ERRCODE = '42501';
  END IF;

  NEW.delivered_at := delivered_attempt.occurred_at;
  NEW.verified_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_print_physical_output_attestation_write
  ON operations_print_physical_output_attestations;
CREATE TRIGGER validate_operations_print_physical_output_attestation_write
BEFORE INSERT ON operations_print_physical_output_attestations
FOR EACH ROW
EXECUTE FUNCTION validate_operations_print_physical_output_attestation();

DROP TRIGGER IF EXISTS protect_operations_print_physical_output_attestation_write
  ON operations_print_physical_output_attestations;
CREATE TRIGGER protect_operations_print_physical_output_attestation_write
BEFORE UPDATE OR DELETE ON operations_print_physical_output_attestations
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

COMMENT ON TABLE operations_print_physical_output_attestations IS
  'Append-only operator visual confirmations of physical output, fenced to one exact delivered print-job ledger event. Local print agents never write this table.';
COMMENT ON COLUMN operations_print_physical_output_attestations.verified_by IS
  'Immutable operator email captured while an active organization membership had warehouse execution access; intentionally retained after later membership changes.';
COMMENT ON COLUMN operations_print_physical_output_attestations.reason IS
  'Operator statement describing the observed paper or label output.';
