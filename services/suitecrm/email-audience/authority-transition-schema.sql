-- PREPARED ONLY. No route, activation, principal, role, group, membership, or
-- approval is installed by this schema. The separately reviewed app bridge must
-- provision an exact approval only after durable authorized app admission.
-- Grant approvals additionally attest that the app authority change committed.
-- Phase execution never changes approvals or expiry/revoke. The dedicated
-- provisioner may insert only an independently signed exact PG phase proof;
-- it cannot renew or overwrite a retained approval.
CREATE TABLE clawpilot_email_authority_approvals (
  operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  transition_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  desired_app_change_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  phase VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  oauth_client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_commit_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  proof_json TEXT NOT NULL,
  proof_signature VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  revoked TINYINT NOT NULL DEFAULT 0,
  CHECK (phase IN ('revoke','grant')),
  CHECK (phase <> 'grant' OR app_commit_fingerprint IS NOT NULL)
) ENGINE=InnoDB;

CREATE TABLE clawpilot_email_authority_operations (
  operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  transition_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  phase VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json MEDIUMTEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CHECK (phase IN ('revoke','grant')),
  CHECK (state IN ('committed','cancelled')),
  CHECK ((state='committed') = (result_json IS NOT NULL))
) ENGINE=InnoDB;

-- No row is created by installation. Only a verified native authority phase
-- may enroll a pipeline/its historical Emails into managed write scope.
CREATE TABLE clawpilot_email_write_scopes (
  pipeline_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;

CREATE TABLE clawpilot_email_write_permissions (
  email_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  pipeline_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capabilities_json MEDIUMTEXT NOT NULL,
  source_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  INDEX cp_email_write_pipeline (pipeline_id),
  CHECK (source_kind IN ('authority','publication'))
) ENGINE=InnoDB;
