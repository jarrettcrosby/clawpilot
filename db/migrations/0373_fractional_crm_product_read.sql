-- Permit the separately approved read capability; this migration grants no access.
SET LOCAL lock_timeout='5s';
ALTER TABLE fractional_crm_gateway_credentials
 DROP CONSTRAINT fractional_crm_gateway_credentials_capabilities_check;
ALTER TABLE fractional_crm_gateway_credentials ADD CONSTRAINT fractional_crm_gateway_credentials_capabilities_check
 CHECK(capabilities <@ ARRAY['crm.company.read','crm.contact.read','crm.product.read','crm.company.write','crm.contact.write','crm.onboarding.write']::text[]);
