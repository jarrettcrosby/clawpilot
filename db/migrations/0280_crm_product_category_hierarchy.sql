-- Keep SuiteCRM's flat Product category projection while giving ClawPilot a
-- pipeline-scoped hierarchy for catalog organization and product assignment.

CREATE TABLE IF NOT EXISTS crm_product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_product_categories_name_present CHECK (
    length(btrim(name)) BETWEEN 1 AND 100
  ),
  CONSTRAINT crm_product_categories_not_self_parent CHECK (
    parent_id IS NULL OR parent_id <> id
  ),
  CONSTRAINT crm_product_categories_pipeline_id_unique UNIQUE (pipeline_id, id),
  CONSTRAINT crm_product_categories_parent_fkey
    FOREIGN KEY (pipeline_id, parent_id)
    REFERENCES crm_product_categories(pipeline_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_product_categories_sibling_name
  ON crm_product_categories (
    pipeline_id,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  )
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_crm_product_categories_tree
  ON crm_product_categories (pipeline_id, parent_id, lower(name), id)
  WHERE active = true;

ALTER TABLE crm_products
  ADD COLUMN IF NOT EXISTS category_id uuid;

ALTER TABLE crm_products
  DROP CONSTRAINT IF EXISTS crm_products_category_fkey;

ALTER TABLE crm_products
  ADD CONSTRAINT crm_products_category_fkey
    FOREIGN KEY (pipeline_id, category_id)
    REFERENCES crm_product_categories(pipeline_id, id)
    ON DELETE RESTRICT;

INSERT INTO crm_product_categories (
  pipeline_id,
  parent_id,
  name,
  created_by,
  updated_by
)
SELECT DISTINCT ON (product.pipeline_id, lower(btrim(product.category)))
  product.pipeline_id,
  NULL,
  btrim(product.category),
  product.created_by,
  product.updated_by
FROM crm_products product
WHERE length(btrim(COALESCE(product.category, ''))) > 0
ORDER BY
  product.pipeline_id,
  lower(btrim(product.category)),
  product.updated_at,
  product.id
ON CONFLICT DO NOTHING;

UPDATE crm_products product
SET category_id = category.id
FROM crm_product_categories category
WHERE product.category_id IS NULL
  AND category.pipeline_id = product.pipeline_id
  AND category.parent_id IS NULL
  AND category.active = true
  AND lower(btrim(category.name)) = lower(btrim(product.category));

CREATE INDEX IF NOT EXISTS idx_crm_products_category
  ON crm_products (pipeline_id, category_id, lower(name), id)
  WHERE category_id IS NOT NULL;

COMMENT ON TABLE crm_product_categories IS
  'Pipeline-scoped ClawPilot product category hierarchy; provider taxonomies remain separate read-only evidence.';

COMMENT ON COLUMN crm_products.category_id IS
  'Optional ClawPilot category assignment; crm_products.category remains the flat SuiteCRM projection value.';
