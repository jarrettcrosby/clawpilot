CREATE TABLE IF NOT EXISTS toast_menu_catalog_sync_status (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  source_provider text NOT NULL DEFAULT 'toast' CHECK (source_provider = 'toast'),
  provider_restaurant_id text NOT NULL,
  source_revision timestamptz,
  observed_source_revision timestamptz,
  status text NOT NULL DEFAULT 'never_synced' CHECK (
    status IN ('never_synced', 'ready', 'unchanged', 'unavailable', 'error')
  ),
  unavailable_reason text CHECK (
    unavailable_reason IS NULL OR unavailable_reason IN ('menus_scope_required', 'menu_not_published')
  ),
  last_error_code text,
  menu_count integer NOT NULL DEFAULT 0 CHECK (menu_count >= 0),
  group_count integer NOT NULL DEFAULT 0 CHECK (group_count >= 0),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  sales_category_count integer NOT NULL DEFAULT 0 CHECK (sales_category_count >= 0),
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid),
  UNIQUE (organization_id, source_provider, provider_restaurant_id),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE,
  CONSTRAINT toast_menu_catalog_sync_provider_id_valid CHECK (
    provider_restaurant_id = restaurant_guid::text
  )
);

CREATE TABLE IF NOT EXISTS toast_menu_catalog_restaurants (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  source_provider text NOT NULL DEFAULT 'toast' CHECK (source_provider = 'toast'),
  provider_restaurant_id text NOT NULL,
  name text NOT NULL,
  timezone text,
  active boolean NOT NULL DEFAULT true,
  archived boolean NOT NULL DEFAULT false,
  source_revision timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid),
  UNIQUE (organization_id, source_provider, provider_restaurant_id),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE,
  CONSTRAINT toast_menu_catalog_restaurants_state_valid CHECK (NOT (active AND archived)),
  CONSTRAINT toast_menu_catalog_restaurants_provider_id_valid CHECK (
    provider_restaurant_id = restaurant_guid::text
  ),
  CONSTRAINT toast_menu_catalog_restaurants_name_valid CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 240 AND name !~ '[[:cntrl:]]'
  )
);

CREATE TABLE IF NOT EXISTS toast_menu_catalog_menus (
  organization_id uuid NOT NULL,
  restaurant_guid uuid NOT NULL,
  menu_guid uuid NOT NULL,
  source_provider text NOT NULL DEFAULT 'toast' CHECK (source_provider = 'toast'),
  provider_menu_id text NOT NULL,
  name text NOT NULL,
  visibility text[] NOT NULL DEFAULT '{}'::text[],
  active boolean NOT NULL DEFAULT true,
  archived boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  source_revision timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid, menu_guid),
  UNIQUE (organization_id, restaurant_guid, source_provider, provider_menu_id),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_menu_catalog_restaurants (organization_id, restaurant_guid) ON DELETE CASCADE,
  CONSTRAINT toast_menu_catalog_menus_state_valid CHECK (NOT (active AND archived)),
  CONSTRAINT toast_menu_catalog_menus_provider_id_valid CHECK (
    provider_menu_id = menu_guid::text
  ),
  CONSTRAINT toast_menu_catalog_menus_name_valid CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 240 AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT toast_menu_catalog_menus_visibility_valid CHECK (cardinality(visibility) <= 32)
);

CREATE TABLE IF NOT EXISTS toast_menu_catalog_groups (
  organization_id uuid NOT NULL,
  restaurant_guid uuid NOT NULL,
  menu_guid uuid NOT NULL,
  group_guid uuid NOT NULL,
  parent_group_guid uuid,
  source_provider text NOT NULL DEFAULT 'toast' CHECK (source_provider = 'toast'),
  provider_group_id text NOT NULL,
  name text NOT NULL,
  visibility text[] NOT NULL DEFAULT '{}'::text[],
  active boolean NOT NULL DEFAULT true,
  archived boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  source_revision timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid, menu_guid, group_guid),
  UNIQUE (organization_id, restaurant_guid, menu_guid, source_provider, provider_group_id),
  FOREIGN KEY (organization_id, restaurant_guid, menu_guid)
    REFERENCES toast_menu_catalog_menus (organization_id, restaurant_guid, menu_guid) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, restaurant_guid, menu_guid, parent_group_guid)
    REFERENCES toast_menu_catalog_groups (organization_id, restaurant_guid, menu_guid, group_guid)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT toast_menu_catalog_groups_parent_valid CHECK (
    parent_group_guid IS NULL OR parent_group_guid <> group_guid
  ),
  CONSTRAINT toast_menu_catalog_groups_state_valid CHECK (NOT (active AND archived)),
  CONSTRAINT toast_menu_catalog_groups_provider_id_valid CHECK (
    provider_group_id = group_guid::text
  ),
  CONSTRAINT toast_menu_catalog_groups_name_valid CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 240 AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT toast_menu_catalog_groups_visibility_valid CHECK (cardinality(visibility) <= 32)
);

CREATE TABLE IF NOT EXISTS toast_menu_catalog_sales_categories (
  organization_id uuid NOT NULL,
  restaurant_guid uuid NOT NULL,
  sales_category_guid uuid NOT NULL,
  source_provider text NOT NULL DEFAULT 'toast' CHECK (source_provider = 'toast'),
  provider_sales_category_id text NOT NULL,
  name text NOT NULL,
  plu text,
  active boolean NOT NULL DEFAULT true,
  archived boolean NOT NULL DEFAULT false,
  source_revision timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid, sales_category_guid),
  UNIQUE (organization_id, restaurant_guid, source_provider, provider_sales_category_id),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_menu_catalog_restaurants (organization_id, restaurant_guid) ON DELETE CASCADE,
  CONSTRAINT toast_menu_catalog_categories_state_valid CHECK (NOT (active AND archived)),
  CONSTRAINT toast_menu_catalog_categories_provider_id_valid CHECK (
    provider_sales_category_id = sales_category_guid::text
  ),
  CONSTRAINT toast_menu_catalog_categories_name_valid CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 240 AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT toast_menu_catalog_categories_plu_valid CHECK (
    plu IS NULL OR (plu = btrim(plu) AND char_length(plu) BETWEEN 1 AND 200 AND plu !~ '[[:cntrl:]]')
  )
);

CREATE TABLE IF NOT EXISTS toast_menu_catalog_items (
  organization_id uuid NOT NULL,
  restaurant_guid uuid NOT NULL,
  menu_guid uuid NOT NULL,
  group_guid uuid NOT NULL,
  item_guid uuid NOT NULL,
  source_provider text NOT NULL DEFAULT 'toast' CHECK (source_provider = 'toast'),
  provider_item_id text NOT NULL,
  name text NOT NULL,
  plu text,
  price numeric(16, 4),
  visibility text[] NOT NULL DEFAULT '{}'::text[],
  sales_category_guid uuid,
  provider_sales_category_id text,
  active boolean NOT NULL DEFAULT true,
  archived boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  source_revision timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid, menu_guid, group_guid, item_guid),
  UNIQUE (
    organization_id, restaurant_guid, menu_guid, group_guid, source_provider, provider_item_id
  ),
  FOREIGN KEY (organization_id, restaurant_guid, menu_guid, group_guid)
    REFERENCES toast_menu_catalog_groups (organization_id, restaurant_guid, menu_guid, group_guid)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, restaurant_guid, sales_category_guid)
    REFERENCES toast_menu_catalog_sales_categories (
      organization_id, restaurant_guid, sales_category_guid
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT toast_menu_catalog_items_category_pair CHECK (
    (sales_category_guid IS NULL) = (provider_sales_category_id IS NULL)
    AND (
      sales_category_guid IS NULL
      OR provider_sales_category_id = sales_category_guid::text
    )
  ),
  CONSTRAINT toast_menu_catalog_items_provider_id_valid CHECK (
    provider_item_id = item_guid::text
  ),
  CONSTRAINT toast_menu_catalog_items_state_valid CHECK (NOT (active AND archived)),
  CONSTRAINT toast_menu_catalog_items_name_valid CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 240 AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT toast_menu_catalog_items_plu_valid CHECK (
    plu IS NULL OR (plu = btrim(plu) AND char_length(plu) BETWEEN 1 AND 200 AND plu !~ '[[:cntrl:]]')
  ),
  CONSTRAINT toast_menu_catalog_items_visibility_valid CHECK (cardinality(visibility) <= 32)
);

CREATE INDEX IF NOT EXISTS idx_toast_menu_catalog_sync_status
  ON toast_menu_catalog_sync_status (organization_id, status, last_checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_toast_menu_catalog_menus_active
  ON toast_menu_catalog_menus (organization_id, restaurant_guid, position, name) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_toast_menu_catalog_groups_active
  ON toast_menu_catalog_groups (
    organization_id, restaurant_guid, menu_guid, parent_group_guid, position, name
  ) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_toast_menu_catalog_items_provider
  ON toast_menu_catalog_items (
    organization_id, restaurant_guid, source_provider, provider_item_id
  ) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_toast_menu_catalog_categories_provider
  ON toast_menu_catalog_sales_categories (
    organization_id, restaurant_guid, source_provider, provider_sales_category_id
  ) WHERE active = true;
