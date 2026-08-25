import { query } from '@/lib/persistence/postgres'

export const SHOPIFY_REVERSAL_FIXTURE_MIGRATION =
  '0326_operations_shopify_reversal_test_fixture.sql' as const
export const SHOPIFY_REVERSAL_FIXTURE_MIGRATION_CHECKSUM =
  '8e23a84f09527467acaf2a1ec500642cd6bf11f532c4131dd98b4b8655e09a25' as const

export async function readShopifyReversalFixtureHealthInPostgres() {
  const structural = await query<{
    migration_current: boolean
    command_table: boolean
    approval_table: boolean
    attempt_table: boolean
    outcome_table: boolean
    state_view: boolean
    actor_function: boolean
    account_function: boolean
    database_function: boolean
    approval_session_function: boolean
    approval_function: boolean
    fulfillment_function: boolean
    provider_claim_function: boolean
    immutable_trigger_count: string
    database_identity: string | null
  }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM public.schema_migrations migration
         WHERE migration.filename = $1
           AND migration.checksum = $2
       ) AS migration_current,
       to_regclass('public.operations_shopify_reversal_fixture_commands')
         IS NOT NULL AS command_table,
       to_regclass('public.operations_shopify_reversal_fixture_approvals')
         IS NOT NULL AS approval_table,
       to_regclass('public.operations_shopify_reversal_fixture_attempts')
         IS NOT NULL AS attempt_table,
       to_regclass('public.operations_shopify_reversal_fixture_outcomes')
         IS NOT NULL AS outcome_table,
       to_regclass('public.operations_shopify_reversal_fixture_command_state')
         IS NOT NULL AS state_view,
       to_regprocedure(
         'public.operations_shopify_reversal_fixture_actor_is_manager(uuid,text,text)'
       ) IS NOT NULL AS actor_function,
       to_regprocedure(
         'public.operations_shopify_reversal_fixture_account_is_current(uuid,uuid,bigint,integer,text,text,text)'
       ) IS NOT NULL AS account_function,
       to_regprocedure(
         'public.operations_shopify_reversal_fixture_database_is_trusted()'
       ) IS NOT NULL AS database_function,
       to_regprocedure(
         'public.operations_shopify_reversal_fixture_approval_session_is_current(uuid,uuid,uuid,text,text,text,text)'
       ) IS NOT NULL AS approval_session_function,
       to_regprocedure(
         'public.operations_shopify_reversal_fixture_approval_is_current(uuid,uuid,uuid)'
       ) IS NOT NULL AS approval_function,
       to_regprocedure(
         'public.operations_shopify_reversal_fixture_fulfillment_is_safe(uuid,uuid,uuid,bigint,timestamp with time zone,text,jsonb)'
       ) IS NOT NULL AS fulfillment_function,
       to_regprocedure(
         'public.operations_shopify_reversal_fixture_provider_claim_is_current(uuid,uuid,uuid,text,text,text)'
       ) IS NOT NULL AS provider_claim_function,
       (
         SELECT count(*)::text
         FROM pg_catalog.pg_trigger trigger
         JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname IN (
             'operations_shopify_reversal_fixture_commands',
             'operations_shopify_reversal_fixture_approvals',
             'operations_shopify_reversal_fixture_attempts',
             'operations_shopify_reversal_fixture_outcomes'
           )
           AND trigger.tgname IN (
             'protect_shopify_reversal_fixture_command_insert',
             'protect_shopify_reversal_fixture_approval_insert',
             'protect_shopify_reversal_fixture_attempt_insert',
             'protect_shopify_reversal_fixture_outcome_insert',
             'immutable_shopify_reversal_fixture_commands',
             'immutable_shopify_reversal_fixture_approvals',
             'immutable_shopify_reversal_fixture_attempts',
             'immutable_shopify_reversal_fixture_outcomes'
           )
           AND NOT trigger.tgisinternal
       ) AS immutable_trigger_count,
       (
         SELECT setting.value->>'id'
         FROM public.app_settings setting
         WHERE setting.key = 'deployment.database.identity'
         LIMIT 1
       ) AS database_identity`,
    [
      SHOPIFY_REVERSAL_FIXTURE_MIGRATION,
      SHOPIFY_REVERSAL_FIXTURE_MIGRATION_CHECKSUM,
    ],
  )
  const row = structural.rows[0]
  const structureCurrent = Boolean(
    row?.migration_current
    && row.command_table
    && row.approval_table
    && row.attempt_table
    && row.outcome_table
    && row.state_view
    && row.actor_function
    && row.account_function
    && row.database_function
    && row.approval_session_function
    && row.approval_function
    && row.fulfillment_function
    && row.provider_claim_function
    && Number(row.immutable_trigger_count) === 8,
  )
  if (!structureCurrent) {
    return Object.freeze({
      migrationCurrent: false,
      structureCurrent: false,
      databaseIdentity: row?.database_identity || null,
      awaitingApproval: 0,
      prepared: 0,
      processing: 0,
      unknown: 0,
      terminal: 0,
    })
  }
  const counts = await query<{
    awaiting_approval: string
    prepared: string
    processing: string
    unknown: string
    terminal: string
  }>(
    `SELECT
       count(*) FILTER (WHERE state = 'awaiting_approval')::text
         AS awaiting_approval,
       count(*) FILTER (WHERE state = 'prepared')::text AS prepared,
       count(*) FILTER (WHERE state = 'processing')::text AS processing,
       count(*) FILTER (WHERE state = 'unknown')::text AS unknown,
       count(*) FILTER (WHERE state IN (
         'succeeded', 'rejected', 'reconciled_applied',
         'reconciled_absent', 'reconciled_ambiguous'
       ))::text AS terminal
     FROM public.operations_shopify_reversal_fixture_command_state`,
  )
  return Object.freeze({
    migrationCurrent: true,
    structureCurrent: true,
    databaseIdentity: row.database_identity,
    awaitingApproval: Number(counts.rows[0]?.awaiting_approval || 0),
    prepared: Number(counts.rows[0]?.prepared || 0),
    processing: Number(counts.rows[0]?.processing || 0),
    unknown: Number(counts.rows[0]?.unknown || 0),
    terminal: Number(counts.rows[0]?.terminal || 0),
  })
}
