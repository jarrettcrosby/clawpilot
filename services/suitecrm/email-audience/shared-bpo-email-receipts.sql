-- Prepared only. Install separately after the exact native schema is reviewed.
-- This is an immutable identity/receipt journal; no permissions or users.
CREATE TABLE clawpilot_shared_bpo_email_receipts (
  operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  intent_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  proof_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  native_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  global_id VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  projection_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  snapshot_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  UNIQUE KEY cp_shared_email_nonce (nonce),
  UNIQUE KEY cp_shared_email_native (native_id),
  UNIQUE KEY cp_shared_email_global (global_id)
) ENGINE=InnoDB;
