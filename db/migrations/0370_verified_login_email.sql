-- The migration runner holds one transaction for this file. Take the existing
-- user/identity lock order before any DDL, then keep identity writers blocked
-- from the ownership snapshot through installation of the insert trigger.
-- SHARE ROW EXCLUSIVE still permits ordinary reads and the old link path's
-- user FOR SHARE/FK checks; it conflicts with identity INSERT's ROW EXCLUSIVE.
LOCK TABLE app_users, app_user_external_identities IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE app_user_login_addresses (
  user_email text PRIMARY KEY REFERENCES app_users(email),
  login_email text NOT NULL UNIQUE CHECK (login_email = lower(btrim(login_email)) AND length(login_email) BETWEEN 3 AND 254),
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_login_email_changes (
  user_email text PRIMARY KEY REFERENCES app_users(email),
  new_email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  requested_at timestamptz NOT NULL DEFAULT now(),
  request_window_started timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 1,
  consumed_at timestamptz
);

-- A login address cannot also become an independent account through an invitation.
-- Serialize the two namespaces so concurrent invitation/confirmation cannot collide.
CREATE FUNCTION guard_clawpilot_login_address() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE address text;
BEGIN
  IF TG_TABLE_NAME = 'app_users' THEN address := NEW.email;
  ELSE address := NEW.login_email; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('clawpilot-login-address:' || address, 0));
  IF TG_TABLE_NAME = 'app_users' THEN
    IF EXISTS (SELECT 1 FROM app_user_login_addresses WHERE login_email = address AND user_email <> NEW.email) THEN
      RAISE EXCEPTION 'Email address belongs to an existing login' USING ERRCODE = '23505';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM app_users WHERE email = address AND email <> NEW.user_email) THEN
      RAISE EXCEPTION 'Email address belongs to an existing account' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_users_guard_login_address BEFORE INSERT OR UPDATE OF email ON app_users
  FOR EACH ROW EXECUTE FUNCTION guard_clawpilot_login_address();
CREATE TRIGGER login_addresses_guard_account BEFORE INSERT OR UPDATE ON app_user_login_addresses
  FOR EACH ROW EXECUTE FUNCTION guard_clawpilot_login_address();

-- Original identity links and mutation receipts remain immutable history. A
-- changed-login user must explicitly relink; only this current binding rotates.
CREATE TABLE app_user_google_login_bindings (
  provider text NOT NULL DEFAULT 'google' CHECK (provider = 'google'),
  provider_subject text PRIMARY KEY,
  user_email text NOT NULL UNIQUE REFERENCES app_users(email),
  verified_email text NOT NULL CHECK (verified_email = lower(btrim(verified_email))),
  linked_organization_id uuid NOT NULL REFERENCES workspace_organizations(id),
  linked_by text NOT NULL REFERENCES app_users(email),
  row_version bigint NOT NULL DEFAULT 0,
  linked_at timestamptz NOT NULL DEFAULT now()
);

-- Revoking a current binding must never release its Google subject for another
-- account. Keep immutable ownership independent of the rotating login binding.
CREATE TABLE app_google_subject_owners (
  provider_subject text PRIMARY KEY,
  user_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  first_linked_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_google_subject_owners (provider_subject, user_email, first_linked_at)
  SELECT provider_subject, user_email, linked_at FROM app_user_external_identities
  WHERE provider = 'google';
CREATE TRIGGER app_google_subject_owners_immutable
  BEFORE UPDATE OR DELETE ON app_google_subject_owners
  FOR EACH ROW EXECUTE FUNCTION reject_app_auth_immutable_mutation();

CREATE FUNCTION reserve_clawpilot_google_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app_google_subject_owners (provider_subject, user_email, first_linked_at)
    VALUES (NEW.provider_subject, NEW.user_email, NEW.linked_at)
    ON CONFLICT (provider_subject) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM app_google_subject_owners
    WHERE provider_subject = NEW.provider_subject AND user_email = NEW.user_email) THEN
    RAISE EXCEPTION 'Google subject belongs to another account' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_user_google_login_bindings_reserve_subject
  BEFORE INSERT OR UPDATE ON app_user_google_login_bindings
  FOR EACH ROW EXECUTE FUNCTION reserve_clawpilot_google_subject();
CREATE TRIGGER app_user_external_identities_reserve_subject
  BEFORE INSERT ON app_user_external_identities
  FOR EACH ROW EXECUTE FUNCTION reserve_clawpilot_google_subject();

CREATE VIEW app_effective_google_identities AS
  SELECT identity.* FROM app_user_external_identities identity
  WHERE NOT EXISTS (SELECT 1 FROM app_user_login_addresses login WHERE login.user_email = identity.user_email)
  UNION ALL
  SELECT binding.* FROM app_user_google_login_bindings binding
  JOIN app_user_login_addresses login ON login.user_email = binding.user_email
    AND login.login_email = binding.verified_email;
