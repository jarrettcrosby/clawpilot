-- Provider-aware fulfillment notification controls.
--
-- Shopify customer notifications are an explicit ClawPilot account policy.
-- Missing policy data remains fail-closed (notify_customer_default = false).
-- Faire owns retailer notifications, so it cannot have a row in this table.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE TABLE IF NOT EXISTS operations_shopify_fulfillment_notification_policies (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  policy_version text NOT NULL
    DEFAULT 'shopify-fulfillment-notification-v1'
    CHECK (policy_version = 'shopify-fulfillment-notification-v1'),
  notify_customer_default boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL CHECK (revision > 0),
  change_reason text NOT NULL
    CHECK (
      length(btrim(change_reason)) BETWEEN 10 AND 500
      AND change_reason !~ '[[:cntrl:]]'
    ),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT operations_shopify_fulfillment_notification_policy_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION enforce_shopify_fulfillment_notification_policy_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_type text;
BEGIN
  SELECT provider, integration_type
    INTO account_provider, account_type
  FROM operations_integration_accounts
  WHERE organization_id = NEW.organization_id
    AND id = NEW.integration_account_id;

  IF account_provider IS NULL THEN
    RAISE EXCEPTION 'Shopify fulfillment notification policy account does not exist';
  END IF;
  IF account_provider <> 'shopify' OR account_type <> 'commerce' THEN
    RAISE EXCEPTION 'Fulfillment notification policy is Shopify-commerce-only';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_shopify_fulfillment_notification_policy_account_write
  ON operations_shopify_fulfillment_notification_policies;
CREATE TRIGGER enforce_shopify_fulfillment_notification_policy_account_write
BEFORE INSERT OR UPDATE OF organization_id, integration_account_id
ON operations_shopify_fulfillment_notification_policies
FOR EACH ROW EXECUTE FUNCTION enforce_shopify_fulfillment_notification_policy_account();

INSERT INTO operations_shopify_fulfillment_notification_policies (
  organization_id,
  integration_account_id,
  notify_customer_default,
  revision,
  change_reason,
  created_by,
  updated_by
)
SELECT
  account.organization_id,
  account.id,
  false,
  1,
  'Safe default established during fulfillment notification rollout',
  account.created_by,
  account.updated_by
FROM operations_integration_accounts account
WHERE account.integration_type = 'commerce'
  AND account.provider = 'shopify'
ON CONFLICT (organization_id, integration_account_id) DO NOTHING;

COMMENT ON TABLE operations_shopify_fulfillment_notification_policies IS
  'Revisioned Shopify account default for customer fulfillment notifications. Absence always means false.';

COMMENT ON COLUMN operations_commerce_fulfillment_exports.payload_snapshot IS
  'Immutable provider request evidence, including the resolved customer-notification decision used for every retry.';
