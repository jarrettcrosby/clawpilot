BEGIN;

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_carrier_service_config_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_organization_id uuid;
  requested_config_id uuid;
  config_state text;
  config_service_gid text;
  retained_config_row_version bigint;
  registered_write_token text;
  integration_provider text;
  selected_environment text;
  environment_binding_count bigint;
BEGIN
  requested_organization_id := COALESCE(
    NEW.organization_id, OLD.organization_id
  );
  requested_config_id := COALESCE(NEW.config_id, OLD.config_id);
  SELECT config.registration_state, config.service_gid, config.row_version
    INTO config_state, config_service_gid, retained_config_row_version
  FROM operations_shopify_carrier_service_configs config
  WHERE config.organization_id = requested_organization_id
    AND config.id = requested_config_id;
  registered_write_token := current_setting(
    'clawpilot.shopify_carrier_binding_write_token', true
  );
  IF config_state = 'registered'
     AND config_service_gid IS NOT NULL
     AND TG_TABLE_NAME IN (
       'operations_shopify_carrier_service_config_materials',
       'operations_shopify_carrier_service_config_carriers'
     )
     AND registered_write_token
       = requested_config_id::text || ':'
         || retained_config_row_version::text
  THEN
    IF EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipts receipt
      WHERE receipt.organization_id = requested_organization_id
        AND receipt.config_id = requested_config_id
        AND receipt.config_row_version = retained_config_row_version
        AND receipt.status = 'processing'
        AND receipt.lease_expires_at > now()
    ) THEN
      RAISE EXCEPTION
        'Wait for the active checkout-rate request before changing rate sources';
    END IF;
  ELSIF config_state NOT IN ('unconfigured', 'disabled', 'error')
        OR config_service_gid IS NOT NULL THEN
    RAISE EXCEPTION
      'Disable the provider CarrierService before changing callback bindings';
  END IF;

  IF TG_TABLE_NAME
       = 'operations_shopify_carrier_service_config_carriers'
     AND TG_OP <> 'DELETE' THEN
    SELECT integration.provider, integration.environment
      INTO integration_provider, selected_environment
    FROM operations_carrier_accounts carrier_account
    JOIN operations_integration_accounts integration
      ON integration.organization_id = carrier_account.organization_id
     AND integration.id = carrier_account.integration_account_id
    WHERE carrier_account.organization_id = NEW.organization_id
      AND carrier_account.id = NEW.carrier_account_id;
    IF integration_provider IS DISTINCT FROM NEW.carrier_provider
       OR integration_provider NOT IN ('ups_rest', 'fedex_rest')
       OR selected_environment NOT IN ('sandbox', 'production') THEN
      RAISE EXCEPTION
        'Shopify callback carrier binding requires an exact TEST or LIVE direct carrier account';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      SELECT count(*) INTO environment_binding_count
      FROM operations_shopify_carrier_service_config_carriers selected
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = selected.organization_id
       AND carrier_account.id = selected.carrier_account_id
      JOIN operations_integration_accounts integration
        ON integration.organization_id = carrier_account.organization_id
       AND integration.id = carrier_account.integration_account_id
      WHERE selected.organization_id = NEW.organization_id
        AND selected.config_id = NEW.config_id
        AND selected.carrier_account_id <> OLD.carrier_account_id
        AND integration.environment = selected_environment;
    ELSE
      SELECT count(*) INTO environment_binding_count
      FROM operations_shopify_carrier_service_config_carriers selected
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = selected.organization_id
       AND carrier_account.id = selected.carrier_account_id
      JOIN operations_integration_accounts integration
        ON integration.organization_id = carrier_account.organization_id
       AND integration.id = carrier_account.integration_account_id
      WHERE selected.organization_id = NEW.organization_id
        AND selected.config_id = NEW.config_id
        AND integration.environment = selected_environment;
    END IF;
    IF environment_binding_count >= 8 THEN
      RAISE EXCEPTION
        'Shopify callback supports at most eight carrier accounts per environment';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION
  validate_operations_shopify_carrier_service_config_child() IS
  'Allows up to eight exact sandbox and eight exact production direct-carrier bindings. Registered material and carrier replacement requires an exact transaction-local config row-version token and no live checkout receipt; other child edits remain disabled-only.';

COMMIT;
