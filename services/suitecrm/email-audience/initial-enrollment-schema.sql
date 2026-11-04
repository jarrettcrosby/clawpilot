-- Explicit offline installation only. No group, identity, policy or activation.
-- A receipt is inserted in the same InnoDB transaction as its exact enrollment.
-- Existing rows are terminal evidence: the service never updates/deletes them.
CREATE TABLE clawpilot_email_initial_enrollments (
  operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  plan_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  delta_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  approval_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  approval_json MEDIUMTEXT NOT NULL,
  receipt_json MEDIUMTEXT NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CHECK (state IN ('committed','cancelled'))
) ENGINE=InnoDB;
