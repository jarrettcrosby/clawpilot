-- Account-scoped policy for unmatched commerce catalog variants.
--
-- Absence of a row means the safe default: operator review, revision zero.
-- Automatic creation remains a ClawPilot-only write; provider data is never
-- changed by this policy.

CREATE TABLE IF NOT EXISTS operations_commerce_product_intake_policies (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  policy_version text NOT NULL
    DEFAULT 'commerce-product-intake-policy-v1'
    CHECK (policy_version = 'commerce-product-intake-policy-v1'),
  unmatched_action text NOT NULL DEFAULT 'review'
    CHECK (unmatched_action IN ('review', 'auto_create')),
  revision integer NOT NULL CHECK (revision > 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT operations_commerce_product_intake_policy_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS
  idx_operations_commerce_product_intake_policy_action
  ON operations_commerce_product_intake_policies (
    organization_id, unmatched_action, updated_at DESC
  );

-- Exact provider-variant mappings keep inactive history when an explicit
-- audited remap changes the active ClawPilot product. Only the active binding
-- is unique; this migration does not provide a product-merge workflow.
DROP INDEX IF EXISTS idx_operations_product_mappings_exact_variant;
CREATE UNIQUE INDEX idx_operations_product_mappings_exact_variant
  ON operations_product_mappings (
    organization_id, integration_account_id, external_variant_id
  )
  WHERE external_variant_id IS NOT NULL
    AND active = true;
