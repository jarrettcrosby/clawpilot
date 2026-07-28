CREATE TABLE IF NOT EXISTS crm_data_transfer_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  actor_email text NOT NULL,
  entity text NOT NULL
    CHECK (entity IN (
      'organizations',
      'contacts',
      'products',
      'leads',
      'opportunities'
    )),
  schema_version text NOT NULL,
  file_name text NOT NULL,
  source_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'previewed'
    CHECK (status IN ('previewed', 'applying', 'applied', 'failed', 'expired')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  create_count integer NOT NULL DEFAULT 0 CHECK (create_count >= 0),
  update_count integer NOT NULL DEFAULT 0 CHECK (update_count >= 0),
  unchanged_count integer NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  ambiguous_count integer NOT NULL DEFAULT 0 CHECK (ambiguous_count >= 0),
  invalid_count integer NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  applied_count integer NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  idempotency_key text,
  apply_request_hash text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours'),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_data_transfer_runs_schema_present
    CHECK (length(btrim(schema_version)) > 0),
  CONSTRAINT crm_data_transfer_runs_file_name_present
    CHECK (length(btrim(file_name)) > 0),
  CONSTRAINT crm_data_transfer_runs_source_sha256_valid
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT crm_data_transfer_runs_pipeline_id_unique
    UNIQUE (pipeline_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_data_transfer_runs_idempotency
  ON crm_data_transfer_runs (pipeline_id, actor_email, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_data_transfer_runs_pipeline
  ON crm_data_transfer_runs (pipeline_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_crm_data_transfer_runs_expiry
  ON crm_data_transfer_runs (expires_at)
  WHERE status = 'previewed';

CREATE TABLE IF NOT EXISTS crm_data_transfer_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL,
  run_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number >= 2),
  classification text NOT NULL
    CHECK (classification IN (
      'create',
      'update',
      'unchanged',
      'ambiguous',
      'invalid'
    )),
  target_record_id uuid,
  target_reference_code text,
  observed_updated_at timestamptz,
  observed_source_hash text,
  proposed_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_diffs jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected boolean NOT NULL DEFAULT false,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_data_transfer_rows_run_fkey
    FOREIGN KEY (pipeline_id, run_id)
    REFERENCES crm_data_transfer_runs (pipeline_id, id)
    ON DELETE CASCADE,
  CONSTRAINT crm_data_transfer_rows_run_row_unique
    UNIQUE (run_id, row_number),
  CONSTRAINT crm_data_transfer_rows_diffs_array
    CHECK (jsonb_typeof(field_diffs) = 'array'),
  CONSTRAINT crm_data_transfer_rows_errors_array
    CHECK (jsonb_typeof(errors) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_crm_data_transfer_rows_preview
  ON crm_data_transfer_rows (pipeline_id, run_id, classification, row_number);
