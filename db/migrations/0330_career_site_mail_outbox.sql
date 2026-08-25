CREATE TABLE IF NOT EXISTS career_site_mail_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  source_app text NOT NULL,
  owner_email text NOT NULL,
  workspace_organization_id uuid NOT NULL,
  message_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  rfc_message_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  draft_id text,
  provider_message_id text,
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_site_mail_outbox_owner_membership_fkey
    FOREIGN KEY (owner_email, workspace_organization_id)
    REFERENCES app_user_organization_memberships (user_email, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT career_site_mail_outbox_source_valid CHECK (
    source_app = 'jarrett-career-site'
  ),
  CONSTRAINT career_site_mail_outbox_owner_normalized CHECK (
    owner_email = lower(btrim(owner_email))
    AND char_length(owner_email) BETWEEN 3 AND 254
    AND owner_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CONSTRAINT career_site_mail_outbox_message_type_valid CHECK (
    message_type IN (
      'contact-notification',
      'newsletter-request',
      'resume-approval-request',
      'approved-resume-link'
    )
  ),
  CONSTRAINT career_site_mail_outbox_idempotency_key_valid CHECK (
    char_length(idempotency_key) BETWEEN 10 AND 128
    AND idempotency_key ~ '^[a-z][a-z0-9-]*/[0-9a-f-]{36}$'
  ),
  CONSTRAINT career_site_mail_outbox_payload_valid CHECK (
    jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT career_site_mail_outbox_payload_hash_valid CHECK (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT career_site_mail_outbox_rfc_message_id_valid CHECK (
    rfc_message_id ~ '^career-site-[0-9a-f]{40}@suburbiasandwichco[.]com$'
  ),
  CONSTRAINT career_site_mail_outbox_provider_ids_valid CHECK (
    (draft_id IS NULL OR (char_length(draft_id) <= 512 AND draft_id ~ '^[A-Za-z0-9_-]+$'))
    AND (
      provider_message_id IS NULL
      OR (char_length(provider_message_id) <= 512 AND provider_message_id ~ '^[A-Za-z0-9_-]+$')
    )
  ),
  CONSTRAINT career_site_mail_outbox_error_length CHECK (
    last_error IS NULL OR char_length(last_error) <= 1000
  ),
  CONSTRAINT career_site_mail_outbox_lock_complete CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND lock_token IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND lock_token IS NULL)
  ),
  CONSTRAINT career_site_mail_outbox_delivery_complete CHECK (
    (status = 'succeeded' AND provider_message_id IS NOT NULL AND delivered_at IS NOT NULL)
    OR (status <> 'succeeded' AND delivered_at IS NULL)
  ),
  UNIQUE (source_app, idempotency_key),
  UNIQUE (rfc_message_id)
);

CREATE INDEX IF NOT EXISTS idx_career_site_mail_outbox_due
  ON career_site_mail_outbox (status, available_at, created_at, id)
  WHERE status IN ('queued', 'failed', 'processing');

CREATE INDEX IF NOT EXISTS idx_career_site_mail_outbox_owner_created
  ON career_site_mail_outbox (
    workspace_organization_id,
    owner_email,
    created_at DESC,
    id DESC
  );
