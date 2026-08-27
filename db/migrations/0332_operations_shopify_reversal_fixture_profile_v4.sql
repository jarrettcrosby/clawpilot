-- Derive the unpaid Shopify order status for the hidden reversal fixture.
-- Historical v1, v2, and v3 commands remain readable; new commands use v4.

ALTER TABLE public.operations_shopify_reversal_fixture_commands
  DROP CONSTRAINT shopify_reversal_fixture_commands_profile_version_valid,
  ADD CONSTRAINT shopify_reversal_fixture_commands_profile_version_valid
    CHECK (fixture_profile_version IN (
      'shopify-reversal-fixture-v1',
      'shopify-reversal-fixture-v2',
      'shopify-reversal-fixture-v3',
      'shopify-reversal-fixture-v4'
    ));
