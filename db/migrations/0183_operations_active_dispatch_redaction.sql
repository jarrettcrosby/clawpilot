-- Fail closed before an Active carrier mutation can own durable evidence.
-- Add new constraints as NOT VALID so new writes are protected immediately
-- without scanning populated tables while ACCESS EXCLUSIVE locks are held.
-- Separate migrations validate one protected table per transaction.

CREATE OR REPLACE FUNCTION
  operations_active_provider_evidence_is_redacted(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE entries(key, node) AS (
    SELECT NULL::text, value
    UNION ALL
    SELECT child.key, child.node
    FROM entries parent
    CROSS JOIN LATERAL (
      SELECT object_entry.key, object_entry.value AS node
      FROM jsonb_each(
        CASE
          WHEN jsonb_typeof(parent.node) = 'object' THEN parent.node
          ELSE '{}'::jsonb
        END
      ) object_entry
      UNION ALL
      SELECT NULL::text, array_entry.value AS node
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(parent.node) = 'array' THEN parent.node
          ELSE '[]'::jsonb
        END
      ) array_entry
    ) child
  )
  SELECT operations_production_rerate_json_is_redacted(value)
    AND octet_length(value::text) BETWEEN 2 AND 65536
    AND NOT EXISTS (
      SELECT 1
      FROM entries
      WHERE regexp_replace(lower(coalesce(key, '')), '[^a-z0-9]', '', 'g') IN (
        'token', 'bearertoken', 'oauthtoken', 'body', 'rawbody',
        'requestbody', 'responsebody', 'headers', 'requestheaders',
        'responseheaders'
      )
      OR (
        jsonb_typeof(node) = 'string'
        AND (
          regexp_replace(lower(node #>> '{}'), '[^a-z0-9]', '', 'g') IN (
            'authorization', 'accesstoken', 'token', 'bearertoken',
            'oauthtoken', 'refreshtoken', 'clientsecret', 'secret',
            'secretid', 'password', 'apikey', 'privatekey',
            'xshopifyaccesstoken', 'accountnumber', 'payeraccountnumber'
          )
          OR (node #>> '{}') ~*
            '(^|[[:space:]])Bearer[[:space:]]+[A-Za-z0-9._~+/=-]+'
          OR (node #>> '{}') ~*
            '<[[:space:]]*(AccessToken|RefreshToken|ClientSecret|SecretId|ApiKey|Password)[^>]*>'
        )
      )
    )
$$;

CREATE OR REPLACE FUNCTION
  operations_active_dispatch_terminal_diagnostic_is_safe(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT operations_active_provider_evidence_is_redacted(value)
    AND value ?& ARRAY[
      'diagnosticVersion', 'providerStatus', 'shipmentOutcome', 'retryable',
      'requestMayHaveReachedProvider', 'responseReceived'
    ]
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(value) key
      WHERE key <> ALL (ARRAY[
        'diagnosticVersion', 'providerStatus', 'shipmentOutcome', 'retryable',
        'requestMayHaveReachedProvider', 'responseReceived', 'httpStatus',
        'providerCode'
      ])
    )
    AND value -> 'diagnosticVersion' = '1'::jsonb
    AND jsonb_typeof(value -> 'providerStatus') = 'string'
    AND value ->> 'providerStatus' IN (
      'ambiguous_response', 'connection_lost', 'invalid_response',
      'provider_rejected', 'provider_unavailable',
      'safety_evidence_rejected', 'succeeded', 'timeout', 'transport_error'
    )
    AND jsonb_typeof(value -> 'shipmentOutcome') = 'string'
    AND value ->> 'shipmentOutcome' IN ('not_created', 'unknown', 'created')
    AND jsonb_typeof(value -> 'retryable') = 'boolean'
    AND jsonb_typeof(value -> 'requestMayHaveReachedProvider') = 'boolean'
    AND jsonb_typeof(value -> 'responseReceived') = 'boolean'
    AND (
      NOT value ? 'httpStatus'
      OR (
        jsonb_typeof(value -> 'httpStatus') = 'number'
        AND value ->> 'httpStatus' ~ '^[0-9]{3}$'
        AND (value ->> 'httpStatus')::integer BETWEEN 100 AND 599
      )
    )
    AND (
      NOT value ? 'providerCode'
      OR (
        jsonb_typeof(value -> 'providerCode') = 'string'
        AND value ->> 'providerCode' ~ '^[A-Z0-9][A-Z0-9_.:-]{0,63}$'
      )
    )
$$;

ALTER TABLE operations_active_carrier_group_attempts
  ADD CONSTRAINT operations_active_carrier_attempt_safety_valid CHECK (
    operations_active_provider_evidence_is_redacted(redacted_request)
    AND (
      provider_reference IS NULL
      OR provider_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    )
    AND (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,128}$')
    AND (
      (
        state = 'prepared'
        AND redacted_response = '{}'::jsonb
      )
      OR (
        state = 'succeeded'
        AND operations_active_dispatch_terminal_diagnostic_is_safe(
          redacted_response
        )
        AND redacted_response ->> 'providerStatus' = 'succeeded'
        AND redacted_response ->> 'shipmentOutcome' = 'created'
        AND (redacted_response ->> 'retryable')::boolean IS FALSE
      )
      OR (
        state = 'failed'
        AND operations_active_dispatch_terminal_diagnostic_is_safe(
          redacted_response
        )
        AND redacted_response ->> 'providerStatus' <> 'succeeded'
        AND redacted_response ->> 'shipmentOutcome' = 'not_created'
        AND (
          (redacted_response ->> 'requestMayHaveReachedProvider')::boolean
            IS FALSE
          OR (
            (redacted_response ->> 'responseReceived')::boolean IS TRUE
            AND redacted_response ->> 'providerStatus' = 'provider_rejected'
          )
        )
      )
      OR (
        state = 'unknown'
        AND operations_active_dispatch_terminal_diagnostic_is_safe(
          redacted_response
        )
        AND redacted_response ->> 'providerStatus' <> 'succeeded'
        AND redacted_response ->> 'shipmentOutcome' = 'unknown'
        AND (redacted_response ->> 'retryable')::boolean IS FALSE
      )
    )
    AND (
      state = 'prepared'
      OR (
        dispatched_at >= persisted_at
        AND completed_at >= dispatched_at
      )
    )
  ) NOT VALID;

ALTER TABLE operations_active_carrier_package_results
  ADD CONSTRAINT operations_active_carrier_package_evidence_redacted CHECK (
    operations_active_provider_evidence_is_redacted(redacted_provider_evidence)
  ) NOT VALID;

ALTER TABLE operations_label_attempts
  ADD CONSTRAINT operations_active_label_attempt_evidence_redacted CHECK (
    active_carrier_group_attempt_id IS NULL
    OR (
      operations_active_provider_evidence_is_redacted(redacted_request)
      AND operations_active_provider_evidence_is_redacted(redacted_response)
    )
  ) NOT VALID;

ALTER TABLE operations_labels
  ADD CONSTRAINT operations_active_label_evidence_redacted CHECK (
    active_carrier_group_attempt_id IS NULL
    OR operations_active_provider_evidence_is_redacted(
      redacted_provider_evidence
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_active_carrier_attempt_safety()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_attempt operations_active_carrier_group_attempts%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.state <> 'prepared' THEN
    RAISE EXCEPTION
      'Active carrier group attempt insert requires prepared state';
  END IF;

  IF NEW.persisted_at > clock_timestamp() + interval '5 seconds' THEN
    RAISE EXCEPTION
      'Active carrier attempt persisted_at exceeds database clock skew allowance';
  END IF;

  IF NEW.dispatched_at IS NOT NULL AND (
    NEW.dispatched_at > clock_timestamp() + interval '5 seconds'
    OR NEW.completed_at > clock_timestamp() + interval '5 seconds'
  ) THEN
    RAISE EXCEPTION
      'Active carrier terminal timestamps exceed database clock skew allowance';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.attempt_number > 1 THEN
    SELECT * INTO prior_attempt
    FROM operations_active_carrier_group_attempts candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.active_shipment_group_id = NEW.active_shipment_group_id
      AND candidate.attempt_number = NEW.attempt_number - 1
    FOR UPDATE;

    IF NOT FOUND
      OR prior_attempt.state <> 'failed'
      OR prior_attempt.completed_at > NEW.persisted_at
      OR NOT operations_active_dispatch_terminal_diagnostic_is_safe(
        prior_attempt.redacted_response
      )
      OR prior_attempt.redacted_response ->> 'shipmentOutcome' <> 'not_created'
      OR (prior_attempt.redacted_response ->> 'retryable')::boolean IS NOT TRUE
      OR NOT (
        (prior_attempt.redacted_response ->> 'requestMayHaveReachedProvider')::boolean
          IS FALSE
        OR (
          (prior_attempt.redacted_response ->> 'responseReceived')::boolean
            IS TRUE
          AND prior_attempt.redacted_response ->> 'providerStatus'
            = 'provider_rejected'
        )
      )
    THEN
      RAISE EXCEPTION
        'Active carrier retry requires completed retryable proof of noncreation';
    END IF;

    IF prior_attempt.selected_provider IS DISTINCT FROM NEW.selected_provider
      OR prior_attempt.selected_service_code
        IS DISTINCT FROM NEW.selected_service_code
      OR prior_attempt.selected_service_name
        IS DISTINCT FROM NEW.selected_service_name
      OR prior_attempt.package_count IS DISTINCT FROM NEW.package_count
    THEN
      RAISE EXCEPTION
        'Active carrier retry must retain its exact provider, service, and package count';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS
  validate_operations_active_carrier_attempt_safety_trigger
ON operations_active_carrier_group_attempts;
CREATE TRIGGER validate_operations_active_carrier_attempt_safety_trigger
BEFORE INSERT OR UPDATE ON operations_active_carrier_group_attempts
FOR EACH ROW EXECUTE FUNCTION validate_operations_active_carrier_attempt_safety();

COMMENT ON CONSTRAINT operations_active_carrier_attempt_safety_valid
ON operations_active_carrier_group_attempts IS
  'Requires redacted immutable requests, allowlisted state-consistent terminal diagnostics, safe text identifiers, and durable timestamp ordering.';
