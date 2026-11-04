-- PREPARED ONLY. Apply offline after separately approved schema/binding review.
-- No default binding, group, membership, role, permission, or active writer.
CREATE TABLE clawpilot_email_bindings (
  pipeline_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  workspace_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  generation BIGINT UNSIGNED NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  readers_json TEXT NOT NULL,
  audience_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  policy_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  runtime_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capability_policy_json MEDIUMTEXT NULL,
  capability_policy_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  enabled TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE clawpilot_email_identities (
  email_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  global_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  local_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  pipeline_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_archived TINYINT NOT NULL,
  capabilities_json MEDIUMTEXT NULL,
  INDEX cp_email_pipeline (pipeline_id)
) ENGINE=InnoDB;

-- A cancelled operation is a durable tombstone. A delayed request cannot publish
-- after the app has reconciled a timeout and released its authority-change fence.
-- The result includes verified native readback and must remain restricted to the
-- service principal; never log/export result_json as operational telemetry.
CREATE TABLE clawpilot_email_operations (
  operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  command_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pipeline_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json MEDIUMTEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CHECK (state IN ('committed','cancelled'))
) ENGINE=InnoDB;
