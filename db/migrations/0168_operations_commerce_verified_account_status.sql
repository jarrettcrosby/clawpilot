-- Make the generic commerce-account status describe current credential
-- eligibility for provider reads and registered checkout callback computation.
-- Signed-receipt intake remains an independent, opt-in policy, and provider
-- mutations remain fenced by Operations activation plus their exact grants.

UPDATE operations_integration_accounts account
SET status = 'active',
    updated_at = now()
FROM operations_commerce_credentials credential
WHERE account.integration_type = 'commerce'
  AND account.status = 'disabled'
  AND credential.organization_id = account.organization_id
  AND credential.integration_account_id = account.id
  AND credential.external_account_id = account.external_account_id
  AND credential.credential_version =
        account.commerce_credential_generation
  AND credential.verification_status = 'verified';

COMMENT ON COLUMN operations_integration_accounts.status IS
  'Connection lifecycle status. For commerce accounts, active means the current credential generation is verified and eligible for provider reads and registered callback computation; it does not enable receipt intake or authorize provider writes.';
