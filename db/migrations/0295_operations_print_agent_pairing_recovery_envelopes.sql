-- Recovery-safe local print-agent pairing.
--
-- A client generates and durably stores an X25519 key before redeeming a
-- short-lived cppair grant. The server seals the one generated cpprint
-- credential to that key and retains only the public binding and encrypted
-- envelope. If the commit succeeds but the HTTPS response is lost, the same
-- installation can replay the exact request for at most ten minutes without
-- creating a second agent or storing a plaintext credential.

ALTER TABLE operations_print_agent_pairing_grants
  ADD COLUMN IF NOT EXISTS redemption_protocol text,
  ADD COLUMN IF NOT EXISTS client_installation_id uuid,
  ADD COLUMN IF NOT EXISTS client_public_key_spki text,
  ADD COLUMN IF NOT EXISTS client_key_fingerprint text,
  ADD COLUMN IF NOT EXISTS credential_envelope jsonb,
  ADD COLUMN IF NOT EXISTS credential_envelope_sha256 text,
  ADD COLUMN IF NOT EXISTS recovery_expires_at timestamptz;

ALTER TABLE operations_print_agent_pairing_grants
  DROP CONSTRAINT IF EXISTS operations_print_agent_pairing_grants_terminal_state_valid;

ALTER TABLE operations_print_agent_pairing_grants
  ADD CONSTRAINT operations_print_agent_pairing_grants_terminal_state_valid CHECK (
    (
      status = 'pending'
      AND redeemed_at IS NULL
      AND expired_at IS NULL
      AND revoked_at IS NULL
      AND print_agent_id IS NULL
      AND redemption_idempotency_key IS NULL
      AND redemption_request_fingerprint IS NULL
      AND redemption_protocol IS NULL
      AND client_installation_id IS NULL
      AND client_public_key_spki IS NULL
      AND client_key_fingerprint IS NULL
      AND credential_envelope IS NULL
      AND credential_envelope_sha256 IS NULL
      AND recovery_expires_at IS NULL
    )
    OR (
      status = 'redeemed'
      AND redeemed_at IS NOT NULL
      AND expired_at IS NULL
      AND revoked_at IS NULL
      AND print_agent_id = reserved_agent_id
      AND length(btrim(redemption_idempotency_key)) BETWEEN 8 AND 200
      AND redemption_request_fingerprint ~ '^[a-f0-9]{64}$'
      AND (
        (
          -- Read-only compatibility for grants redeemed before this migration.
          -- The v2 API will not replay these because no recoverable envelope
          -- exists; an operator must revoke the orphaned agent and issue a new
          -- grant.
          redemption_protocol IS NULL
          AND client_installation_id IS NULL
          AND client_public_key_spki IS NULL
          AND client_key_fingerprint IS NULL
          AND credential_envelope IS NULL
          AND credential_envelope_sha256 IS NULL
          AND recovery_expires_at IS NULL
        )
        OR (
          redemption_protocol = 'x25519-hkdf-sha256-aes-256-gcm-v1'
          AND client_installation_id IS NOT NULL
          AND client_public_key_spki ~ '^[A-Za-z0-9_-]{59}$'
          AND client_key_fingerprint ~ '^[A-Za-z0-9_-]{43}$'
          AND jsonb_typeof(credential_envelope) = 'object'
          AND credential_envelope_sha256 ~ '^[a-f0-9]{64}$'
          AND recovery_expires_at > redeemed_at
          AND recovery_expires_at <= redeemed_at + interval '10 minutes'
        )
      )
    )
    OR (
      status = 'expired'
      AND redeemed_at IS NULL
      AND expired_at IS NOT NULL
      AND revoked_at IS NULL
      AND print_agent_id IS NULL
      AND redemption_idempotency_key IS NULL
      AND redemption_request_fingerprint IS NULL
      AND redemption_protocol IS NULL
      AND client_installation_id IS NULL
      AND client_public_key_spki IS NULL
      AND client_key_fingerprint IS NULL
      AND credential_envelope IS NULL
      AND credential_envelope_sha256 IS NULL
      AND recovery_expires_at IS NULL
    )
    OR (
      status = 'revoked'
      AND redeemed_at IS NULL
      AND expired_at IS NULL
      AND revoked_at IS NOT NULL
      AND print_agent_id IS NULL
      AND redemption_idempotency_key IS NULL
      AND redemption_request_fingerprint IS NULL
      AND redemption_protocol IS NULL
      AND client_installation_id IS NULL
      AND client_public_key_spki IS NULL
      AND client_key_fingerprint IS NULL
      AND credential_envelope IS NULL
      AND credential_envelope_sha256 IS NULL
      AND recovery_expires_at IS NULL
    )
  );

ALTER TABLE operations_print_agent_pairing_grants
  ADD CONSTRAINT operations_print_agent_pairing_grants_envelope_shape_valid CHECK (
    credential_envelope IS NULL
    OR (
      credential_envelope ?& ARRAY[
        'schemaVersion',
        'keyAgreement',
        'keyDerivation',
        'contentEncryption',
        'serverPublicKey',
        'salt',
        'iv',
        'ciphertext',
        'authTag',
        'authenticatedContext'
      ]
      AND credential_envelope - ARRAY[
        'schemaVersion',
        'keyAgreement',
        'keyDerivation',
        'contentEncryption',
        'serverPublicKey',
        'salt',
        'iv',
        'ciphertext',
        'authTag',
        'authenticatedContext'
      ] = '{}'::jsonb
      AND credential_envelope->>'schemaVersion' = '1'
      AND credential_envelope->>'keyAgreement' = 'X25519'
      AND credential_envelope->>'keyDerivation' = 'HKDF-SHA256'
      AND credential_envelope->>'contentEncryption' = 'A256GCM'
      AND credential_envelope->>'serverPublicKey' ~ '^[A-Za-z0-9_-]{59}$'
      AND credential_envelope->>'salt' ~ '^[A-Za-z0-9_-]{43}$'
      AND credential_envelope->>'iv' ~ '^[A-Za-z0-9_-]{16}$'
      AND credential_envelope->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
      AND credential_envelope->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
      AND credential_envelope->>'authenticatedContext' ~ '^[A-Za-z0-9_-]+$'
    )
  );

COMMENT ON COLUMN operations_print_agent_pairing_grants.client_public_key_spki IS
  'Canonical base64url X25519 SubjectPublicKeyInfo for the one authorized native installation. Public material only.';
COMMENT ON COLUMN operations_print_agent_pairing_grants.client_key_fingerprint IS
  'Base64url SHA-256 of canonical client_public_key_spki DER.';
COMMENT ON COLUMN operations_print_agent_pairing_grants.credential_envelope IS
  'AES-256-GCM ciphertext sealed through ephemeral X25519 and HKDF-SHA256. Never contains a plaintext cpprint credential.';
COMMENT ON COLUMN operations_print_agent_pairing_grants.recovery_expires_at IS
  'Bounded deadline for an exact same-client replay after a committed redemption response is lost.';
