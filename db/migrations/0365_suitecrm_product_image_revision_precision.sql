-- V8 collection timestamps were historically rounded to a minute. Keep those
-- immutable observations explicitly ambiguous; never manufacture lost seconds.
ALTER TABLE crm_suitecrm_product_image_observations
  ADD COLUMN suitecrm_modified_at_precision text NOT NULL DEFAULT 'minute'
    CHECK (suitecrm_modified_at_precision IN ('minute', 'exact'));

-- Permit one immutable precision attestation for otherwise identical evidence
-- at second zero. The snapshot fence still rejects differing same-time hashes.
ALTER TABLE crm_suitecrm_product_image_observations
  DROP CONSTRAINT crm_suitecrm_product_image_observation_replay_unique,
  ADD CONSTRAINT crm_suitecrm_product_image_observation_replay_unique UNIQUE (
    organization_id, suitecrm_id, suitecrm_modified_at, snapshot_sha256,
    suitecrm_modified_at_precision
  );
