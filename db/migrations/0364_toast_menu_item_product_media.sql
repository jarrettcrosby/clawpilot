ALTER TABLE toast_menu_catalog_items
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS image_url text;

ALTER TABLE toast_menu_catalog_items
  DROP CONSTRAINT IF EXISTS toast_menu_catalog_items_sku_valid,
  DROP CONSTRAINT IF EXISTS toast_menu_catalog_items_description_valid,
  DROP CONSTRAINT IF EXISTS toast_menu_catalog_items_image_url_valid;

ALTER TABLE toast_menu_catalog_items
  ADD CONSTRAINT toast_menu_catalog_items_sku_valid CHECK (
    sku IS NULL OR (
      sku = btrim(sku)
      AND char_length(sku) BETWEEN 1 AND 200
      AND sku !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT toast_menu_catalog_items_description_valid CHECK (
    description IS NULL OR (
      description = btrim(description)
      AND char_length(description) BETWEEN 1 AND 4000
      AND description !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT toast_menu_catalog_items_image_url_valid CHECK (
    image_url IS NULL OR (
      image_url = btrim(image_url)
      AND char_length(image_url) BETWEEN 1 AND 2048
      AND image_url ~ '^https://[^[:space:]]+$'
      AND image_url !~ '[[:cntrl:]]'
    )
  );
