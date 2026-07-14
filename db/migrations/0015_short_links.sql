CREATE TABLE IF NOT EXISTS short_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email text NOT NULL,
  source_app text NOT NULL DEFAULT 'clawpilot',
  slug text NOT NULL,
  destination_url text NOT NULL,
  title text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  max_clicks bigint,
  click_count bigint NOT NULL DEFAULT 0,
  expires_at timestamptz,
  disabled_at timestamptz,
  last_clicked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT short_links_owner_normalized CHECK (owner_email = lower(owner_email)),
  CONSTRAINT short_links_source_app_valid CHECK (
    source_app ~ '^[a-z][a-z0-9-]{1,39}$'
  ),
  CONSTRAINT short_links_slug_valid CHECK (
    slug = lower(slug)
    AND slug ~ '^[a-z0-9][a-z0-9_-]{2,63}$'
  ),
  CONSTRAINT short_links_destination_valid CHECK (
    char_length(destination_url) BETWEEN 8 AND 4096
    AND (
      destination_url ~ '^https://'
      OR destination_url ~ '^http://(localhost|127\.0\.0\.1)([:/]|$)'
    )
  ),
  CONSTRAINT short_links_title_length CHECK (char_length(title) <= 200),
  CONSTRAINT short_links_click_count_nonnegative CHECK (click_count >= 0),
  CONSTRAINT short_links_max_clicks_positive CHECK (max_clicks IS NULL OR max_clicks > 0),
  CONSTRAINT short_links_click_count_bounded CHECK (max_clicks IS NULL OR click_count <= max_clicks),
  UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_short_links_owner_updated
  ON short_links (owner_email, updated_at DESC, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_short_links_destination
  ON short_links (owner_email, destination_url)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_short_links_tags
  ON short_links USING gin (tags);

CREATE TABLE IF NOT EXISTS short_link_clicks (
  id bigserial PRIMARY KEY,
  short_link_id uuid NOT NULL REFERENCES short_links(id) ON DELETE CASCADE,
  source_app text NOT NULL,
  referrer_host text,
  clicked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT short_link_clicks_source_app_valid CHECK (
    source_app ~ '^[a-z][a-z0-9-]{1,39}$'
  ),
  CONSTRAINT short_link_clicks_referrer_length CHECK (
    referrer_host IS NULL OR char_length(referrer_host) <= 255
  )
);

CREATE INDEX IF NOT EXISTS idx_short_link_clicks_link_time
  ON short_link_clicks (short_link_id, clicked_at DESC, id DESC);

UPDATE app_users
SET permissions = permissions || '{"manageLinks":false}'::jsonb
WHERE role = 'member';

UPDATE app_users
SET permissions = permissions || '{"manageLinks":true}'::jsonb
WHERE role IN ('owner', 'admin');
