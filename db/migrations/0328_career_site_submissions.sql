CREATE TABLE IF NOT EXISTS career_site_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_submission_id uuid NOT NULL,
  source_app text NOT NULL,
  owner_email text NOT NULL,
  workspace_organization_id uuid NOT NULL,
  form_type text NOT NULL,
  requester_name text,
  requester_email text NOT NULL,
  requester_organization text,
  interest text,
  message text,
  network_interest boolean NOT NULL DEFAULT false,
  role_fit boolean NOT NULL DEFAULT false,
  newsletter_consent boolean NOT NULL DEFAULT false,
  resume_variant text,
  source_url text,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_site_submissions_owner_membership_fkey
    FOREIGN KEY (owner_email, workspace_organization_id)
    REFERENCES app_user_organization_memberships (user_email, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT career_site_submissions_source_valid CHECK (
    source_app = 'jarrett-career-site'
  ),
  CONSTRAINT career_site_submissions_owner_normalized CHECK (
    owner_email = lower(btrim(owner_email))
    AND char_length(owner_email) BETWEEN 3 AND 254
    AND owner_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CONSTRAINT career_site_submissions_requester_email_normalized CHECK (
    requester_email = lower(btrim(requester_email))
    AND char_length(requester_email) BETWEEN 3 AND 160
    AND requester_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CONSTRAINT career_site_submissions_name_length CHECK (
    requester_name IS NULL OR char_length(requester_name) BETWEEN 2 AND 100
  ),
  CONSTRAINT career_site_submissions_organization_length CHECK (
    requester_organization IS NULL OR char_length(requester_organization) <= 120
  ),
  CONSTRAINT career_site_submissions_message_length CHECK (
    message IS NULL OR char_length(message) <= 3000
  ),
  CONSTRAINT career_site_submissions_interest_valid CHECK (
    interest IS NULL OR interest IN ('leadership', 'advisory', 'product', 'media', 'other')
  ),
  CONSTRAINT career_site_submissions_resume_variant_valid CHECK (
    resume_variant IS NULL OR resume_variant IN ('executive', 'servicenow', 'odyssey')
  ),
  CONSTRAINT career_site_submissions_source_url_valid CHECK (
    source_url IS NULL OR (
      char_length(source_url) <= 500
      AND source_url ~ '^https://jarrett[.]suburbiasandwichco[.]com(/[^?#]*)?$'
    )
  ),
  CONSTRAINT career_site_submissions_payload_hash_valid CHECK (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT career_site_submissions_form_payload_valid CHECK (
    (
      form_type = 'contact'
      AND requester_name IS NOT NULL
      AND interest IS NOT NULL
      AND message IS NOT NULL
      AND network_interest = false
      AND role_fit = false
      AND newsletter_consent = false
      AND resume_variant IS NULL
    ) OR (
      form_type = 'resume-request'
      AND requester_name IS NOT NULL
      AND interest IS NULL
      AND newsletter_consent = false
      AND resume_variant IS NOT NULL
    ) OR (
      form_type = 'newsletter'
      AND requester_name IS NULL
      AND requester_organization IS NULL
      AND interest IS NULL
      AND message IS NULL
      AND network_interest = false
      AND role_fit = false
      AND newsletter_consent = true
      AND resume_variant IS NULL
    )
  ),
  UNIQUE (source_app, external_submission_id)
);

CREATE INDEX IF NOT EXISTS idx_career_site_submissions_owner_created
  ON career_site_submissions (
    workspace_organization_id,
    owner_email,
    created_at DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_career_site_submissions_form_created
  ON career_site_submissions (form_type, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS career_site_submission_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE
    REFERENCES career_site_submissions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_site_submission_outbox_error_length CHECK (
    last_error IS NULL OR char_length(last_error) <= 1000
  ),
  CONSTRAINT career_site_submission_outbox_lock_complete CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND lock_token IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND lock_token IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_career_site_submission_outbox_due
  ON career_site_submission_outbox (status, available_at, created_at, id)
  WHERE status IN ('queued', 'failed', 'processing');
