CREATE TABLE IF NOT EXISTS workspace_organization_branding (
  organization_id uuid PRIMARY KEY REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  logo_mime_type text,
  logo_bytes bytea,
  primary_color text NOT NULL DEFAULT '#1F2430',
  accent_color text NOT NULL DEFAULT '#A8C7FA',
  revision bigint NOT NULL DEFAULT 1,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_organization_branding_logo_pair CHECK (
    (logo_mime_type IS NULL AND logo_bytes IS NULL)
    OR (logo_mime_type IS NOT NULL AND logo_bytes IS NOT NULL)
  ),
  CONSTRAINT workspace_organization_branding_logo_type CHECK (
    logo_mime_type IS NULL OR logo_mime_type IN ('image/png', 'image/jpeg', 'image/webp')
  ),
  CONSTRAINT workspace_organization_branding_logo_size CHECK (
    logo_bytes IS NULL OR octet_length(logo_bytes) <= 2097152
  ),
  CONSTRAINT workspace_organization_branding_primary_color CHECK (
    primary_color ~ '^#[0-9A-F]{6}$'
  ),
  CONSTRAINT workspace_organization_branding_accent_color CHECK (
    accent_color ~ '^#[0-9A-F]{6}$'
  ),
  CONSTRAINT workspace_organization_branding_revision_valid CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS idx_workspace_organization_branding_updated
  ON workspace_organization_branding (updated_at DESC, organization_id);
