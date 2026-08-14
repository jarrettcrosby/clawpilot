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
    length(btrim(name)) BETWEEN 1 AND 255
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

-- Existing provider taxonomies may be stored as long `Parent > Child > Leaf`
-- strings. Preserve that flat projection on the Product while converting each
-- bounded segment into a real hierarchy and assigning the Product to its leaf.
DO $$
DECLARE
  category_row record;
  category_segment text;
  normalized_segment text;
  parent_category_id uuid;
  resolved_category_id uuid;
BEGIN
  FOR category_row IN
    SELECT DISTINCT ON (product.pipeline_id, lower(btrim(product.category)))
      product.pipeline_id,
      btrim(product.category) AS flat_name,
      product.created_by,
      product.updated_by
    FROM crm_products product
    WHERE length(btrim(COALESCE(product.category, ''))) > 0
    ORDER BY
      product.pipeline_id,
      lower(btrim(product.category)),
      product.updated_at,
      product.id
  LOOP
    parent_category_id := NULL;
    resolved_category_id := NULL;

    FOREACH category_segment IN ARRAY regexp_split_to_array(category_row.flat_name, '\s*>\s*')
    LOOP
      normalized_segment := btrim(category_segment);
      IF length(normalized_segment) = 0 THEN
        CONTINUE;
      END IF;
      IF length(normalized_segment) > 255 THEN
        normalized_segment := left(normalized_segment, 246) || '…' || substr(md5(normalized_segment), 1, 8);
      END IF;

      resolved_category_id := NULL;
      INSERT INTO crm_product_categories (
        pipeline_id,
        parent_id,
        name,
        created_by,
        updated_by
      ) VALUES (
        category_row.pipeline_id,
        parent_category_id,
        normalized_segment,
        category_row.created_by,
        category_row.updated_by
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO resolved_category_id;

      IF resolved_category_id IS NULL THEN
        SELECT category.id
        INTO resolved_category_id
        FROM crm_product_categories category
        WHERE category.pipeline_id = category_row.pipeline_id
          AND category.parent_id IS NOT DISTINCT FROM parent_category_id
          AND category.active = true
          AND lower(btrim(category.name)) = lower(normalized_segment)
        LIMIT 1;
      END IF;

      IF resolved_category_id IS NULL THEN
        RAISE EXCEPTION 'CRM product category backfill could not resolve a hierarchy segment';
      END IF;
      parent_category_id := resolved_category_id;
    END LOOP;

    UPDATE crm_products product
    SET category_id = resolved_category_id
    WHERE resolved_category_id IS NOT NULL
      AND product.category_id IS NULL
      AND product.pipeline_id = category_row.pipeline_id
      AND lower(btrim(product.category)) = lower(category_row.flat_name);
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS idx_crm_products_category
  ON crm_products (pipeline_id, category_id, lower(name), id)
  WHERE category_id IS NOT NULL;

COMMENT ON TABLE crm_product_categories IS
  'Pipeline-scoped ClawPilot product category hierarchy; provider taxonomies remain separate read-only evidence.';

COMMENT ON COLUMN crm_products.category_id IS
  'Optional ClawPilot category assignment; crm_products.category remains the flat SuiteCRM projection value.';
