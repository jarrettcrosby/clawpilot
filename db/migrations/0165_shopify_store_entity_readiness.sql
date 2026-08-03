-- Make the provider-verified Shopify store entity part of the one canonical
-- CarrierService readiness predicate. Public callbacks, setup reads, mutation
-- guards, and checkout mapping validation must never disagree about readiness
-- or fall back to a platform name, editable connection label, or external ID.

CREATE OR REPLACE FUNCTION
  operations_shopify_carrier_service_config_is_ready(
    requested_organization_id uuid,
    requested_config_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_carrier_service_configs config
    JOIN operations_integration_accounts account
      ON account.organization_id = config.organization_id
     AND account.id = config.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = config.organization_id
    JOIN operations_warehouses warehouse
      ON warehouse.organization_id = config.organization_id
     AND warehouse.id = config.warehouse_id
    WHERE config.organization_id = requested_organization_id
      AND config.id = requested_config_id
      AND config.registration_state IN (
        'shadow_simulated', 'registered'
      )
      AND account.integration_type = 'commerce'
      AND account.provider = 'shopify'
      AND account.environment = 'sandbox'
      AND account.status <> 'error'
      AND length(
        btrim(account.configuration ->> 'accountName')
      ) BETWEEN 1 AND 255
      AND btrim(account.configuration ->> 'accountName')
        !~ '[[:cntrl:]]'
      AND account.commerce_credential_generation
        = config.credential_generation
      AND credential.credential_version = config.credential_generation
      AND credential.verification_status = 'verified'
      AND activation.revision = config.activation_revision
      AND (
        (
          config.registration_state = 'registered'
          AND activation.state IN ('shadow', 'active')
        )
        OR (
          config.registration_state = 'shadow_simulated'
          AND activation.state = 'shadow'
        )
      )
      AND warehouse.status = 'active'
      AND (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_materials selected
        JOIN operations_packaging_materials material
          ON material.organization_id = selected.organization_id
         AND material.id = selected.packaging_material_id
        JOIN operations_packaging_material_stock stock
          ON stock.organization_id = material.organization_id
         AND stock.packaging_material_id = material.id
         AND stock.warehouse_id = config.warehouse_id
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND material.status = 'active'
          AND material.row_version
            = selected.packaging_material_row_version
          AND material.rated_outer_length_mm > 0
          AND material.rated_outer_width_mm > 0
          AND material.rated_outer_height_mm > 0
          AND material.rated_outer_dimension_evidence_type IN (
            'customer_confirmed', 'measured', 'provider', 'legacy'
          )
          AND length(
            btrim(material.rated_outer_dimension_evidence_reference)
          ) BETWEEN 1 AND 500
          AND material.rated_outer_dimension_confirmed_at IS NOT NULL
          AND stock.is_available = true
          AND stock.on_hand_quantity > 0
      ) = (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_materials selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      )
      AND (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_materials selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      ) BETWEEN 1 AND 8
      AND (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_carriers selected
        JOIN operations_carrier_accounts carrier_account
          ON carrier_account.organization_id = selected.organization_id
         AND carrier_account.id = selected.carrier_account_id
        JOIN operations_integration_accounts carrier_integration
          ON carrier_integration.organization_id
            = carrier_account.organization_id
         AND carrier_integration.id
            = carrier_account.integration_account_id
        JOIN operations_carrier_credentials carrier_credential
          ON carrier_credential.organization_id
            = carrier_integration.organization_id
         AND carrier_credential.integration_account_id
            = carrier_integration.id
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND carrier_account.status = 'active'
          AND carrier_integration.status = 'active'
          AND carrier_integration.integration_type = 'carrier'
          AND carrier_integration.provider = selected.carrier_provider
          AND carrier_integration.environment = 'sandbox'
          AND carrier_credential.verification_status = 'verified'
      ) = 2
      AND EXISTS (
        SELECT 1
        FROM operations_shopify_carrier_service_config_carriers selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND selected.carrier_provider = 'ups_rest'
      )
      AND EXISTS (
        SELECT 1
        FROM operations_shopify_carrier_service_config_carriers selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND selected.carrier_provider = 'fedex_rest'
      )
  )
$$;

COMMENT ON FUNCTION
  operations_shopify_carrier_service_config_is_ready(uuid, uuid) IS
  'Returns true only when the sandbox Shopify CarrierService configuration, provider-verified bounded store entity, activation, warehouse, current packaging stock, and paired verified UPS/FedEx bindings are ready.';
