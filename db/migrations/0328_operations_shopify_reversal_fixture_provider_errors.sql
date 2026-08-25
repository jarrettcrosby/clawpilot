-- Bounded provider-rejection evidence for the hidden Shopify reversal fixture.
-- Only an exact attempted provider mutation that was rejected or became unknown
-- may retain a printable operator-facing summary.

ALTER TABLE public.operations_shopify_reversal_fixture_commands
  DROP CONSTRAINT
    operations_shopify_reversal_fixtu_fixture_profile_version_check,
  ADD CONSTRAINT shopify_reversal_fixture_commands_profile_version_valid
    CHECK (fixture_profile_version IN (
      'shopify-reversal-fixture-v1',
      'shopify-reversal-fixture-v2'
    ));

ALTER TABLE public.operations_shopify_reversal_fixture_outcomes
  ADD COLUMN provider_error_summary text,
  ADD CONSTRAINT
    shopify_reversal_fixture_outcomes_provider_error_summary_valid
    CHECK (
      provider_error_summary IS NULL
      OR (
        outcome_state IN ('rejected', 'unknown')
        AND provider_mutation_attempted = true
        AND provider_error_summary = pg_catalog.btrim(provider_error_summary)
        AND pg_catalog.char_length(provider_error_summary) BETWEEN 1 AND 500
        AND provider_error_summary !~ '[[:cntrl:]]'
        AND provider_error_summary ~ (
          '^Shopify rejected order creation \('
          || '(FULFILLMENT_SERVICE_INVALID|INVALID|INVENTORY_CLAIM_FAILED|'
          || 'PROCESSED_AT_INVALID|REDUNDANT_CUSTOMER_FIELDS|SHOP_DORMANT|'
          || 'TAX_LINE_RATE_MISSING|UNSPECIFIED)'
          || '( at [A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,15})?'
          || '(; (FULFILLMENT_SERVICE_INVALID|INVALID|'
          || 'INVENTORY_CLAIM_FAILED|PROCESSED_AT_INVALID|'
          || 'REDUNDANT_CUSTOMER_FIELDS|SHOP_DORMANT|'
          || 'TAX_LINE_RATE_MISSING|UNSPECIFIED)'
          || '( at [A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,15})?)*'
          || '\)$'
        )
      )
    );

COMMENT ON COLUMN
  public.operations_shopify_reversal_fixture_outcomes.provider_error_summary IS
  'Sanitized printable provider error summary retained only for an attempted rejected or unknown fixture mutation.';

CREATE OR REPLACE VIEW
  public.operations_shopify_reversal_fixture_command_state
AS
SELECT command.organization_id,
       command.id AS command_id,
       command.global_id AS command_global_id,
       command.phase,
       CASE
         WHEN approval.id IS NULL THEN 'awaiting_approval'
         WHEN attempt.id IS NULL THEN 'prepared'
         WHEN reconciliation.id IS NOT NULL THEN reconciliation.outcome_state
         WHEN initial_outcome.id IS NULL THEN 'processing'
         ELSE initial_outcome.outcome_state
       END AS state,
       approval.global_id AS approval_global_id,
       approval.approved_by,
       approval.approved_at,
       attempt.global_id AS attempt_global_id,
       initial_outcome.global_id AS initial_outcome_global_id,
       reconciliation.global_id AS reconciliation_outcome_global_id,
       COALESCE(
         reconciliation.provider_order_id,
         initial_outcome.provider_order_id
       ) AS provider_order_id,
       COALESCE(
         reconciliation.provider_reference,
         initial_outcome.provider_reference
       ) AS provider_reference,
       command.prepared_at,
       command.expires_at,
       initial_outcome.error_code AS provider_error_code,
       initial_outcome.provider_error_summary
FROM public.operations_shopify_reversal_fixture_commands command
LEFT JOIN public.operations_shopify_reversal_fixture_approvals approval
  ON approval.organization_id = command.organization_id
 AND approval.command_id = command.id
LEFT JOIN public.operations_shopify_reversal_fixture_attempts attempt
  ON attempt.organization_id = command.organization_id
 AND attempt.command_id = command.id
LEFT JOIN public.operations_shopify_reversal_fixture_outcomes initial_outcome
  ON initial_outcome.organization_id = command.organization_id
 AND initial_outcome.attempt_id = attempt.id
 AND initial_outcome.outcome_state IN ('succeeded', 'rejected', 'unknown')
LEFT JOIN public.operations_shopify_reversal_fixture_outcomes reconciliation
  ON reconciliation.organization_id = command.organization_id
 AND reconciliation.attempt_id = attempt.id
 AND reconciliation.outcome_state LIKE 'reconciled_%';
