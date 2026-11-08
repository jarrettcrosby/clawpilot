-- Add a grant vocabulary only. This migration does not provision or alter any credential.
ALTER TABLE fractional_crm_gateway_credentials
  DROP CONSTRAINT fractional_crm_gateway_credentials_capabilities_check,
  ADD CONSTRAINT fractional_crm_gateway_credentials_capabilities_check
    CHECK (capabilities <@ ARRAY[
      'crm.company.read', 'crm.contact.read', 'crm.company.write', 'crm.contact.write',
      'crm.onboarding.write', 'crm.customer-folder.write'
    ]::text[]);
