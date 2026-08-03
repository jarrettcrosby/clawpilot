-- Faire can keep a published listing writable while its sale state is paused.
-- Preserve the exact normalized availability evidence on the immutable grant,
-- but authorize Product-image writes from the provider lifecycle fence.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

ALTER TABLE operations_faire_product_image_delivery_grants
  DROP CONSTRAINT IF EXISTS operations_faire_product_image_grant_channel_valid,
  ADD CONSTRAINT operations_faire_product_image_grant_channel_valid CHECK (
    (
      channel_normalized_status = 'active'
      AND channel_provider_active = true
    )
    OR (
      channel_normalized_status = 'unavailable'
      AND channel_provider_active = false
    )
  );

DO $migration$
DECLARE
  function_definition text;
  active_only_predicate text :=
    'AND channel_state.normalized_status = ''active''
          AND channel_state.provider_active = true';
  writable_lifecycle_predicate text :=
    'AND upper(btrim(channel_state.provider_status_raw)) IN (
            ''DRAFT'', ''PUBLISHED'', ''ACTIVE''
          )
          AND channel_state.normalized_status
            = image_grant.channel_normalized_status
          AND channel_state.provider_active
            = image_grant.channel_provider_active
          AND (
            (
              channel_state.normalized_status = ''active''
              AND channel_state.provider_active = true
            )
            OR (
              channel_state.normalized_status = ''unavailable''
              AND channel_state.provider_active = false
            )
          )';
BEGIN
  SELECT pg_get_functiondef(
    'operations_faire_provider_write_authority_is_current(uuid,uuid,uuid,text,integer,integer,text,text,text,bigint,text,text,text,jsonb,uuid)'::regprocedure
  ) INTO function_definition;

  IF strpos(
    function_definition,
    'upper(btrim(channel_state.provider_status_raw))'
  ) > 0 THEN
    RETURN;
  END IF;

  IF function_definition IS NULL
     OR strpos(function_definition, active_only_predicate) = 0 THEN
    RAISE EXCEPTION
      'Faire Product-image authority lifecycle predicate was not found';
  END IF;

  function_definition := replace(
    function_definition,
    active_only_predicate,
    writable_lifecycle_predicate
  );

  IF strpos(function_definition, active_only_predicate) > 0 THEN
    RAISE EXCEPTION
      'Faire Product-image authority lifecycle predicate was not replaced';
  END IF;

  EXECUTE function_definition;
END;
$migration$;
