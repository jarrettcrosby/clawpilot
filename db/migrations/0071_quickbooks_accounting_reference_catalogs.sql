CREATE TABLE IF NOT EXISTS quickbooks_tax_codes (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  quickbooks_tax_code_id text NOT NULL,
  name text NOT NULL,
  description text,
  taxable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quickbooks_tax_code_id),
  CONSTRAINT quickbooks_tax_codes_id_present CHECK (
    quickbooks_tax_code_id = btrim(quickbooks_tax_code_id)
    AND char_length(quickbooks_tax_code_id) BETWEEN 1 AND 200
    AND quickbooks_tax_code_id ~ '^[!-~]+$'
  ),
  CONSTRAINT quickbooks_tax_codes_name_present CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 240 AND name !~ '[[:cntrl:]]'
  )
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_tax_codes_catalog
  ON quickbooks_tax_codes (organization_id, active, name, quickbooks_tax_code_id);

CREATE TABLE IF NOT EXISTS quickbooks_classes (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  quickbooks_class_id text NOT NULL,
  name text NOT NULL,
  fully_qualified_name text NOT NULL,
  child boolean NOT NULL DEFAULT false,
  parent_id text,
  active boolean NOT NULL DEFAULT true,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quickbooks_class_id),
  CONSTRAINT quickbooks_classes_id_present CHECK (
    quickbooks_class_id = btrim(quickbooks_class_id)
    AND char_length(quickbooks_class_id) BETWEEN 1 AND 200
    AND quickbooks_class_id ~ '^[!-~]+$'
  ),
  CONSTRAINT quickbooks_classes_name_present CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 240 AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT quickbooks_classes_fqn_present CHECK (
    fully_qualified_name = btrim(fully_qualified_name)
    AND char_length(fully_qualified_name) BETWEEN 1 AND 500
    AND fully_qualified_name !~ '[[:cntrl:]]'
  )
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_classes_catalog
  ON quickbooks_classes (organization_id, active, fully_qualified_name, quickbooks_class_id);

CREATE TABLE IF NOT EXISTS quickbooks_departments (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  quickbooks_department_id text NOT NULL,
  name text NOT NULL,
  fully_qualified_name text NOT NULL,
  child boolean NOT NULL DEFAULT false,
  parent_id text,
  active boolean NOT NULL DEFAULT true,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quickbooks_department_id),
  CONSTRAINT quickbooks_departments_id_present CHECK (
    quickbooks_department_id = btrim(quickbooks_department_id)
    AND char_length(quickbooks_department_id) BETWEEN 1 AND 200
    AND quickbooks_department_id ~ '^[!-~]+$'
  ),
  CONSTRAINT quickbooks_departments_name_present CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 240 AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT quickbooks_departments_fqn_present CHECK (
    fully_qualified_name = btrim(fully_qualified_name)
    AND char_length(fully_qualified_name) BETWEEN 1 AND 500
    AND fully_qualified_name !~ '[[:cntrl:]]'
  )
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_departments_catalog
  ON quickbooks_departments (
    organization_id, active, fully_qualified_name, quickbooks_department_id
  );
