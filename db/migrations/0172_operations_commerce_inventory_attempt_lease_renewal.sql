-- A Shopify inventory read must be able to renew its live projection lease,
-- and a captured read must be able to rotate an expired projection lease,
-- without weakening immutable provider-call evidence.
-- Replace the original finalize-once trigger from migration 0111; the trigger
-- itself remains installed and every non-inventory attempt keeps the original
-- prepared-to-terminal-only behavior.

CREATE OR REPLACE FUNCTION protect_operations_commerce_provider_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Commerce provider attempts are immutable and cannot be deleted';
  END IF;

  IF ROW(
    NEW.id,
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.action,
    NEW.adapter_version,
    NEW.external_object_id,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.redacted_request,
    NEW.attempt_number,
    NEW.requested_at,
    NEW.created_by
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.action,
    OLD.adapter_version,
    OLD.external_object_id,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.redacted_request,
    OLD.attempt_number,
    OLD.requested_at,
    OLD.created_by
  ) THEN
    RAISE EXCEPTION
      'Commerce provider attempt identity and request evidence are immutable';
  END IF;

  IF OLD.state <> 'prepared' THEN
    RAISE EXCEPTION 'Terminal commerce provider attempts are immutable';
  END IF;

  IF NEW.state = 'prepared' THEN
    IF OLD.action <> 'inventory.levels.read'
       OR NEW.action <> 'inventory.levels.read'
       OR (
         to_jsonb(NEW)
           - ARRAY['lease_token', 'lease_expires_at']::text[]
       ) IS DISTINCT FROM (
         to_jsonb(OLD)
           - ARRAY['lease_token', 'lease_expires_at']::text[]
       ) THEN
      RAISE EXCEPTION
        'Prepared inventory attempts permit lease-only maintenance';
    END IF;

    IF NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN
      IF OLD.lease_token IS NULL
         OR OLD.lease_expires_at IS NULL
         OR OLD.lease_expires_at <= clock_timestamp()
         OR NEW.lease_expires_at IS NULL
         OR NEW.lease_expires_at <= OLD.lease_expires_at
         OR NEW.lease_expires_at
              > clock_timestamp() + interval '15 minutes' THEN
        RAISE EXCEPTION
          'Prepared inventory lease renewal must extend one live bounded lease';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.lease_token IS NULL
       OR OLD.lease_expires_at IS NULL
       OR OLD.lease_expires_at > clock_timestamp()
       OR NEW.lease_token IS NULL
       OR NEW.lease_expires_at IS NULL
       OR NEW.lease_expires_at <= clock_timestamp()
       OR NEW.lease_expires_at
            > clock_timestamp() + interval '15 minutes'
       OR NOT EXISTS (
         SELECT 1
         FROM operations_commerce_inventory_captures capture
         WHERE capture.organization_id = OLD.organization_id
           AND capture.integration_account_id =
               OLD.integration_account_id
           AND capture.provider_attempt_id = OLD.id
           AND capture.request_hash = OLD.request_hash
       ) THEN
      RAISE EXCEPTION
        'Prepared inventory lease rotation requires one expired captured read';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.completed_at IS NULL
     OR NEW.lease_token IS NOT NULL
     OR NEW.lease_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'Commerce provider attempt must finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION protect_operations_commerce_provider_attempt() IS
  'Protects immutable provider-call evidence, permits bounded live lease renewal for prepared inventory reads and expired lease rotation only for captured reads, and otherwise requires one terminal finalization.';
