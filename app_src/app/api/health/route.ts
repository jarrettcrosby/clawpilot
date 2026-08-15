import { NextResponse } from 'next/server'
import fs from 'fs'
import { getAgentRuntime } from '@/lib/agents/provider'
import { getRepositoryRunnerConfiguration } from '@/lib/agents/repositoryRunnerConfig'
import { getStorageDriver, isHostedRuntime } from '@/lib/persistence/config'
import { query as queryAgentCredentials } from '@/lib/persistence/agentCredentials'
import { query } from '@/lib/persistence/postgres'
import {
  OPERATIONS_COMMAND_RECEIPT_HEALTH_QUERY,
} from '@/lib/persistence/operationsCommandReceiptHealth'
import { readPipelineOutboxWorkerHeartbeatFromPostgres } from '@/lib/persistence/pipeline'
import { readAgentDispatchWorkerHeartbeatFromPostgres } from '@/lib/persistence/agentDispatch'
import { readAgentResearchWorkerHeartbeatFromPostgres } from '@/lib/persistence/agentResearch'
import { readToastWorkerHeartbeatFromPostgres } from '@/lib/persistence/toastIntegrations'
import { readQuickBooksWorkerHeartbeatFromPostgres } from '@/lib/persistence/quickBooksIntegrations'
import {
  readCommerceCatalogWorkerHeartbeatFromPostgres,
} from '@/lib/persistence/commerceCatalogSync'
import {
  readCommerceOrderReconciliationHealthFromPostgres,
  readCommerceOrderReconciliationWorkerHeartbeatFromPostgres,
} from '@/lib/persistence/commerceOrderReconciliation'
import {
  readCommerceOrderRevisionHealthFromPostgres,
} from '@/lib/persistence/commerceOrderRevisions'
import {
  readCommerceOrderSyncCursorKeyReadinessFromPostgres,
  readCommerceOrderSyncHealthFromPostgres,
} from '@/lib/persistence/commerceOrderSync'
import {
  CommerceOrderRevisionEvidenceKeyConfigError,
  resolveCommerceOrderRevisionEvidenceKeyConfig,
  summarizeCommerceOrderRevisionEvidenceKeyReadiness,
} from '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'
import {
  readShopifyInventoryRefreshHealthFromPostgres,
  readShopifyInventoryRefreshWorkerHeartbeatFromPostgres,
} from '@/lib/persistence/shopifyInventoryRefresh'
import {
  readShopifyWebhookReceiptHealthFromPostgres,
} from '@/lib/persistence/shopifyWebhookReceiptHealth'
import {
  readShopifyOrderWebhookSignalHealthFromPostgres,
} from '@/lib/persistence/shopifyOrderWebhookSignals'
import {
  readShopifyOrderManagementHealthFromPostgres,
} from '@/lib/persistence/shopifyOrderManagement'
import {
  shopifyOrderManagementRuntime,
} from '@/lib/integrations/shopifyOrderManagementRuntime'
import {
  readFaireInventoryPollHealthFromPostgres,
  readFaireInventoryPollWorkerHeartbeatFromPostgres,
} from '@/lib/persistence/faireInventoryPolling'
import {
  readCommerceProductImageImportQueueHealthInPostgres,
} from '@/lib/persistence/commerceProductImageImports'
import {
  classifyCommerceProductImageImportOperationalHealth,
} from '@/lib/commerceProductImageImportHealth'
import {
  readFaireProductImageProjectionHealthInPostgres,
} from '@/lib/persistence/faireProductImageProjection'
import {
  commerceReadRuntimeAvailable,
} from '@/lib/integrations/commerceIntake'
import {
  commerceReadAccountSql,
  commerceReadRuntimeSummary,
} from '@/lib/integrations/commerceReadRuntime'
import {
  commerceOrderHistoryDurableDegraded,
  commerceOrderHistoryOperationalHealth,
} from '@/lib/integrations/commerceOrderHistoryHealth'
import {
  faireAutomaticExactRefreshHealthSnapshot,
  faireAutomaticOrderPromotionHealthSnapshot,
  faireUnattributedAttentionHealthSnapshot,
} from '@/lib/integrations/commerceFaireAutomaticPromotion'
import {
  shopifyAutomaticOrderPromotionHealthSnapshot,
} from '@/lib/integrations/commerceShopifyAutomaticPromotion'
import { effectiveDocumentEmbeddingConfiguration } from '@/lib/documentEmbeddings'
import { validateShortLinkConfiguration } from '@/lib/shortlinks'
import { readSuiteCrmWorkerHeartbeat } from '@/lib/persistence/crm'
import { suiteCrmBaseUrl } from '@/lib/crm/suiteCrmClient'
import {
  suiteCrmProductImageReadConfiguration,
} from '@/lib/crm/suiteCrmProductImageReadClient'
import {
  suiteCrmNativeProductImageProjectionConfiguration,
} from '@/lib/crm/suiteCrmNativeProductImageClient'
import {
  fulfillmentOptimizerRuntimeHealth,
} from '@/lib/operations/fulfillmentOptimizerRuntimeConfig'
import {
  readSuiteCrmProductImageIngestionHealthInPostgres,
} from '@/lib/persistence/suiteCrmProductImageIngestion'
import {
  readSuiteCrmNativeProductImageProjectionHealthInPostgres,
} from '@/lib/persistence/suiteCrmProductImageProjection'

const DEV_LOG_PATH = '/tmp/clawd-app-dev.log'
const FALLBACK_LOG_PATH = '/tmp/clawd-app.log'
const ERROR_PATTERNS = [/⨯/, /Error:/, /error TS/, /TypeError/, /ReferenceError/, /SyntaxError/, /Unhandled/, /ENOENT/, /500/]
const WINDOW_MS = 5 * 60 * 1000 // last 5 minutes
const MAX_BYTES_TO_SCAN = 256 * 1024
// SHA-256 over pg_proc.prosrc after removing full-line -- comments, collapsing
// whitespace, and trimming. These pin the audited Faire grant-evidence bodies.
const FAIRE_SCOPE_CURRENT_PROSRC_SHA256 =
  'be9c9d5ce1442cf6c1df2aaffcf1dd075eeb24172fe1f7ec2e6d2002b98bea49'
const FAIRE_SCOPE_TRIGGER_PROSRC_SHA256 =
  '022f71dfd366bf18bc263d8dcfee07d96e9c4e199f797c25b085403105906a03'

// Exact structural attestation for 0293. The migration checksum pins the
// backfill, the pg_proc hash pins strict policy validation, and the catalog
// constraint hash prevents a same-named but weakened CHECK from passing.
const SHOPIFY_CHECKOUT_AUDIENCE_POLICY_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE filename = '0293_shopify_checkout_audience_policy.sql'
      AND checksum =
        'ad112694afea9286f28d38e6522224d44b36f5b32013f87483399e6da5ce8707'
  )
  AND (
    SELECT encode(
      digest(
        convert_to(
          trim(regexp_replace(
            installed_function.prosrc,
            '[[:space:]]+', ' ', 'g'
          )),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_proc installed_function
    WHERE installed_function.oid = to_regprocedure(
      'operations_shopify_checkout_audience_policy_is_valid(jsonb)'
    )
  ) = '69cf98f4440714e6907e8c9a56a9a87e57b5985dcce3909ce80fc5980c96974a'
  AND (
    SELECT encode(
      digest(
        convert_to(
          concat_ws(
            '|',
            installed_check.conname,
            installed_check.convalidated::text,
            pg_get_constraintdef(installed_check.oid)
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_constraint installed_check
    WHERE installed_check.conrelid = to_regclass(
      'operations_shopify_carrier_service_configs'
    )
      AND installed_check.conname =
        'operations_shopify_configs_checkout_audience_valid'
      AND installed_check.contype = 'c'
  ) = '8c5a314298d629ea08b1f0df80b28001f8bc31d413fe10d547dd7eaaaf5845a9'
  AND NOT EXISTS (
    SELECT 1
    FROM operations_shopify_carrier_service_configs config
    WHERE config.policy_snapshot ? 'shadowCheckoutAudience'
      AND operations_shopify_checkout_audience_policy_is_valid(
        config.policy_snapshot -> 'shadowCheckoutAudience'
      ) IS NOT TRUE
  )
`

// Exact structural attestation for 0288. This is intentionally stricter than
// checking schema_migrations: mapped refresh work must not run if a column,
// constraint, foreign key, or rolling-deployment single-flight index drifts.
const OPERATIONS_SHOPIFY_LOCATION_ROUTING_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE filename = '0288_operations_shopify_location_routing.sql'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'operations_commerce_inventory_location_mappings',
        'ownership_classification', 'text', true, '''unknown''::text'
      ),
      (
        'operations_commerce_inventory_location_mappings',
        'provider_snapshot_json', 'jsonb', true, '''{}''::jsonb'
      ),
      (
        'operations_commerce_inventory_location_mappings',
        'provider_snapshot_hash', 'text', false, NULL
      ),
      (
        'operations_commerce_inventory_location_mappings',
        'provider_observed_at', 'timestamp with time zone', false, NULL
      ),
      (
        'operations_commerce_inventory_location_mappings',
        'inventory_import_enabled', 'boolean', true, 'true'
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'location_mapping_id', 'uuid', false, NULL
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'location_mapping_row_version', 'bigint', false, NULL
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'provider_location_id', 'text', false, NULL
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'inventory_location_id', 'uuid', false, NULL
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'inventory_pool_id', 'uuid', false, NULL
      )
    ) AS required_column(
      table_name, column_name, type_name, not_null, default_expression
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_attribute installed_column
      LEFT JOIN pg_attrdef installed_default
        ON installed_default.adrelid = installed_column.attrelid
       AND installed_default.adnum = installed_column.attnum
      WHERE installed_column.attrelid =
              to_regclass(required_column.table_name)
        AND installed_column.attname = required_column.column_name
        AND installed_column.atttypid =
              required_column.type_name::regtype
        AND installed_column.attnotnull = required_column.not_null
        AND NOT installed_column.attisdropped
        AND (
          (
            required_column.default_expression IS NULL
            AND installed_default.oid IS NULL
          )
          OR pg_get_expr(
            installed_default.adbin,
            installed_default.adrelid
          ) = required_column.default_expression
        )
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'operations_commerce_inventory_location_mappings',
        'operations_commerce_inventory_location_mappings_ownership_valid',
        'CHECK ((ownership_classification = ANY (ARRAY[''unknown''::text, ''merchant_managed''::text, ''fulfillment_service''::text])))'
      ),
      (
        'operations_commerce_inventory_location_mappings',
        'operations_commerce_inventory_location_mappings_snapshot_valid',
        'CHECK (((jsonb_typeof(provider_snapshot_json) = ''object''::text) AND (((provider_snapshot_hash IS NULL) AND (provider_observed_at IS NULL) AND (provider_snapshot_json = ''{}''::jsonb)) OR ((provider_snapshot_hash ~ ''^[a-f0-9]{64}$''::text) AND (provider_observed_at IS NOT NULL)))))'
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'operations_shopify_inventory_refresh_jobs_status_check',
        'CHECK ((status = ANY (ARRAY[''pending''::text, ''processing''::text, ''failed''::text, ''succeeded''::text, ''cancelled''::text, ''dead''::text, ''mapped_pending''::text, ''mapped_processing''::text, ''mapped_failed''::text, ''mapped_succeeded''::text, ''mapped_cancelled''::text, ''mapped_dead''::text])))'
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'operations_shopify_inventory_refresh_lease_valid',
        'CHECK ((((status = ANY (ARRAY[''processing''::text, ''mapped_processing''::text])) AND (locked_at IS NOT NULL) AND (locked_by IS NOT NULL) AND (lock_token IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > locked_at)) OR ((status <> ALL (ARRAY[''processing''::text, ''mapped_processing''::text])) AND (locked_at IS NULL) AND (locked_by IS NULL) AND (lock_token IS NULL) AND (lease_expires_at IS NULL))))'
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'operations_shopify_inventory_refresh_completion_valid',
        'CHECK (((status = ANY (ARRAY[''succeeded''::text, ''cancelled''::text, ''dead''::text, ''mapped_succeeded''::text, ''mapped_cancelled''::text, ''mapped_dead''::text])) = (completed_at IS NOT NULL)))'
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'operations_shopify_inventory_refresh_mapping_fence_complete',
        'CHECK ((((location_mapping_id IS NULL) AND (location_mapping_row_version IS NULL) AND (provider_location_id IS NULL) AND (inventory_location_id IS NULL) AND (inventory_pool_id IS NULL)) OR ((location_mapping_id IS NOT NULL) AND (location_mapping_row_version IS NOT NULL) AND (location_mapping_row_version >= 0) AND (provider_location_id IS NOT NULL) AND ((length(btrim(provider_location_id)) >= 1) AND (length(btrim(provider_location_id)) <= 512)) AND (provider_location_id !~ ''[[:cntrl:]]''::text) AND (inventory_location_id IS NOT NULL) AND (inventory_pool_id IS NOT NULL))))'
      ),
      (
        'operations_shopify_inventory_refresh_jobs',
        'operations_shopify_inventory_refresh_mapping_status_consistent',
        'CHECK ((((location_mapping_id IS NULL) AND (status !~~ ''mapped_%''::text)) OR ((location_mapping_id IS NOT NULL) AND (status ~~ ''mapped_%''::text))))'
      )
    ) AS required_check(table_name, constraint_name, definition)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint installed_check
      WHERE installed_check.conrelid =
              to_regclass(required_check.table_name)
        AND installed_check.conname = required_check.constraint_name
        AND installed_check.contype = 'c'
        AND installed_check.convalidated
        AND pg_get_constraintdef(installed_check.oid) =
              required_check.definition
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'operations_shopify_inventory_refresh_mapping_fkey',
        ARRAY[
          'organization_id', 'integration_account_id', 'location_mapping_id'
        ]::name[],
        'operations_commerce_inventory_location_mappings',
        ARRAY[
          'organization_id', 'integration_account_id', 'id'
        ]::name[]
      ),
      (
        'operations_shopify_inventory_refresh_inventory_location_fkey',
        ARRAY[
          'organization_id', 'warehouse_id', 'inventory_location_id'
        ]::name[],
        'operations_locations',
        ARRAY['organization_id', 'warehouse_id', 'id']::name[]
      ),
      (
        'operations_shopify_inventory_refresh_inventory_pool_fkey',
        ARRAY['organization_id', 'inventory_pool_id']::name[],
        'operations_inventory_pools',
        ARRAY['organization_id', 'id']::name[]
      )
    ) AS required_fk(
      constraint_name, local_columns, reference_table, reference_columns
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint installed_fk
      WHERE installed_fk.conrelid =
              to_regclass('operations_shopify_inventory_refresh_jobs')
        AND installed_fk.confrelid =
              to_regclass(required_fk.reference_table)
        AND installed_fk.conname = required_fk.constraint_name
        AND installed_fk.contype = 'f'
        AND installed_fk.convalidated
        AND installed_fk.confdeltype = 'r'
        AND ARRAY(
          SELECT installed_local.attname
          FROM unnest(installed_fk.conkey) WITH ORDINALITY
            local_key(attnum, ordinal)
          JOIN pg_attribute installed_local
            ON installed_local.attrelid = installed_fk.conrelid
           AND installed_local.attnum = local_key.attnum
          ORDER BY local_key.ordinal
        ) = required_fk.local_columns
        AND ARRAY(
          SELECT installed_reference.attname
          FROM unnest(installed_fk.confkey) WITH ORDINALITY
            reference_key(attnum, ordinal)
          JOIN pg_attribute installed_reference
            ON installed_reference.attrelid = installed_fk.confrelid
           AND installed_reference.attnum = reference_key.attnum
          ORDER BY reference_key.ordinal
        ) = required_fk.reference_columns
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'idx_operations_shopify_inventory_refresh_active_account',
        ARRAY['organization_id', 'integration_account_id']::name[],
        '(status = ANY (ARRAY[''pending''::text, ''processing''::text, ''failed''::text]))'
      ),
      (
        'idx_operations_shopify_inventory_refresh_active_mapping',
        ARRAY[
          'organization_id', 'integration_account_id', 'location_mapping_id'
        ]::name[],
        '((location_mapping_id IS NOT NULL) AND (status = ANY (ARRAY[''mapped_pending''::text, ''mapped_processing''::text, ''mapped_failed''::text])))'
      ),
      (
        'idx_operations_shopify_inventory_refresh_processing_account',
        ARRAY['organization_id', 'integration_account_id']::name[],
        '(status = ''mapped_processing''::text)'
      )
    ) AS required_index(index_name, column_names, predicate)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_index installed_index
      WHERE installed_index.indexrelid =
              to_regclass(required_index.index_name)
        AND installed_index.indrelid =
              to_regclass('operations_shopify_inventory_refresh_jobs')
        AND installed_index.indisunique
        AND installed_index.indisvalid
        AND installed_index.indisready
        AND ARRAY(
          SELECT installed_column.attname
          FROM unnest(installed_index.indkey::smallint[]) WITH ORDINALITY
            indexed_attribute(attnum, ordinal)
          JOIN pg_attribute installed_column
            ON installed_column.attrelid = installed_index.indrelid
           AND installed_column.attnum = indexed_attribute.attnum
          ORDER BY indexed_attribute.ordinal
        ) = required_index.column_names
        AND pg_get_expr(
          installed_index.indpred,
          installed_index.indrelid
      ) = required_index.predicate
    )
  )
  AND EXISTS (
    SELECT 1
    FROM pg_index projection_target_index
    WHERE projection_target_index.indexrelid = to_regclass(
            'idx_operations_commerce_inventory_active_projection_target'
          )
      AND projection_target_index.indrelid = to_regclass(
            'operations_commerce_inventory_location_mappings'
          )
      AND projection_target_index.indisunique
      AND projection_target_index.indisvalid
      AND projection_target_index.indisready
      AND ARRAY(
        SELECT projection_target_column.attname
        FROM unnest(projection_target_index.indkey::smallint[])
          WITH ORDINALITY indexed_attribute(attnum, ordinal)
        JOIN pg_attribute projection_target_column
          ON projection_target_column.attrelid =
                projection_target_index.indrelid
         AND projection_target_column.attnum = indexed_attribute.attnum
        ORDER BY indexed_attribute.ordinal
      ) = ARRAY[
        'organization_id', 'warehouse_id', 'location_id',
        'inventory_pool_id'
      ]::name[]
      AND pg_get_expr(
        projection_target_index.indpred,
        projection_target_index.indrelid
      ) = '((active = true) AND (inventory_import_enabled = true))'
  )
`

// Exact structural attestation for 0289. The three catalog hashes pin every
// installed column, CHECK constraint, and foreign key on the authorization,
// one-shot attempt, and immutable outcome ledgers. The remaining clauses pin
// the safety-critical unique indexes, function bodies, and enabled triggers so
// a same-named but weakened provider-write control cannot report healthy.
const OPERATIONS_SHOPIFY_LOCATION_ADMINISTRATION_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE filename =
      '0289_operations_shopify_location_administration.sql'
  )
  AND (
    WITH target_table(table_name) AS (
      VALUES
        ('operations_shopify_location_administration_authorizations'),
        ('operations_shopify_location_administration_attempts'),
        ('operations_shopify_location_administration_outcomes')
    )
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_column.attnum::text,
              installed_column.attname,
              format_type(
                installed_column.atttypid,
                installed_column.atttypmod
              ),
              installed_column.attnotnull::text,
              COALESCE(
                pg_get_expr(
                  installed_default.adbin,
                  installed_default.adrelid
                ),
                ''
              )
            ),
            chr(10) ORDER BY
              installed_table.relname,
              installed_column.attnum
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM target_table required_table
    JOIN pg_class installed_table
      ON installed_table.oid = to_regclass(required_table.table_name)
    JOIN pg_attribute installed_column
      ON installed_column.attrelid = installed_table.oid
    LEFT JOIN pg_attrdef installed_default
      ON installed_default.adrelid = installed_column.attrelid
     AND installed_default.adnum = installed_column.attnum
    WHERE installed_column.attnum > 0
      AND NOT installed_column.attisdropped
  ) = 'cbbc8b291f3fa65763de5d4535fd8ff93d8ce1802d43fe4241640edc930d7c58'
  AND (
    WITH target_table(table_name) AS (
      VALUES
        ('operations_shopify_location_administration_authorizations'),
        ('operations_shopify_location_administration_attempts'),
        ('operations_shopify_location_administration_outcomes')
    )
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_check.conname,
              installed_check.convalidated::text,
              pg_get_constraintdef(installed_check.oid)
            ),
            chr(10) ORDER BY
              installed_table.relname,
              installed_check.conname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM target_table required_table
    JOIN pg_class installed_table
      ON installed_table.oid = to_regclass(required_table.table_name)
    JOIN pg_constraint installed_check
      ON installed_check.conrelid = installed_table.oid
     AND installed_check.contype = 'c'
  ) = '3e805985730407b50af636736bbe8ef66373214d3a73b1262afd0e6bdf7e9e9c'
  AND (
    WITH target_table(table_name) AS (
      VALUES
        ('operations_shopify_location_administration_authorizations'),
        ('operations_shopify_location_administration_attempts'),
        ('operations_shopify_location_administration_outcomes')
    )
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_fk.conname,
              installed_fk.convalidated::text,
              installed_fk.confdeltype::text,
              installed_fk.confupdtype::text,
              pg_get_constraintdef(installed_fk.oid)
            ),
            chr(10) ORDER BY
              installed_table.relname,
              installed_fk.conname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM target_table required_table
    JOIN pg_class installed_table
      ON installed_table.oid = to_regclass(required_table.table_name)
    JOIN pg_constraint installed_fk
      ON installed_fk.conrelid = installed_table.oid
     AND installed_fk.contype = 'f'
  ) = '3330bdef494fa4d7f7658398a68594639e3cb68ee7f8e1dc4a90e44d467adf64'
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'operations_shopify_location_administration_authorizations',
        'ops_shopify_location_admin_one_unresolved_account_idx',
        ARRAY['organization_id', 'integration_account_id']::name[],
        '(status = ANY (ARRAY[''processing''::text, ''unknown''::text]))'
      ),
      (
        'operations_shopify_location_administration_authorizations',
        'ops_shopify_location_admin_auth_idempotency_unique',
        ARRAY[
          'organization_id', 'integration_account_id', 'idempotency_key'
        ]::name[],
        NULL
      ),
      (
        'operations_shopify_location_administration_attempts',
        'ops_shopify_location_admin_attempt_authorization_unique',
        ARRAY['organization_id', 'authorization_id']::name[],
        NULL
      ),
      (
        'operations_shopify_location_administration_outcomes',
        'ops_shopify_location_admin_outcome_state_unique',
        ARRAY[
          'organization_id', 'authorization_id', 'outcome_state'
        ]::name[],
        NULL
      )
    ) AS required_index(
      table_name, index_name, column_names, predicate
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_index installed_index
      WHERE installed_index.indexrelid =
              to_regclass(required_index.index_name)
        AND installed_index.indrelid =
              to_regclass(required_index.table_name)
        AND installed_index.indisunique
        AND installed_index.indisvalid
        AND installed_index.indisready
        AND installed_index.indexprs IS NULL
        AND installed_index.indnkeyatts =
              cardinality(required_index.column_names)
        AND installed_index.indnatts =
              cardinality(required_index.column_names)
        AND ARRAY(
          SELECT installed_column.attname
          FROM unnest(installed_index.indkey::smallint[]) WITH ORDINALITY
            indexed_attribute(attnum, ordinal)
          JOIN pg_attribute installed_column
            ON installed_column.attrelid = installed_index.indrelid
           AND installed_column.attnum = indexed_attribute.attnum
          ORDER BY indexed_attribute.ordinal
        ) = required_index.column_names
        AND pg_get_expr(
          installed_index.indpred,
          installed_index.indrelid
        ) IS NOT DISTINCT FROM required_index.predicate
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'operations_shopify_location_admin_actor_current(uuid,text,text)',
        'sql', 's',
        '73d54458ab0e4365c5cf00aacd46c1f1d2b79a408a623c550d90e05304d33b6a'
      ),
      (
        'operations_shopify_location_admin_is_current(uuid,uuid)',
        'sql', 's',
        '607e63fb075aa325859a421cdb4189ccee7b42c70e1fe4aa4f994b878e305e3e'
      ),
      (
        'protect_shopify_location_admin_authorization()',
        'plpgsql', 'v',
        'f9296999f1f9d05397084d8783abe0831cccfe1077710ff47db5b5a402af1f4a'
      ),
      (
        'protect_shopify_location_admin_attempt()',
        'plpgsql', 'v',
        'd8293a79b42c6b4a013048ef2beccb043b883926af275751e60648cf5c5195c8'
      ),
      (
        'protect_shopify_location_admin_outcome()',
        'plpgsql', 'v',
        'b86cd878d3775a1ef6cde16896f364574ac0e414cfeb4621833e1e52c001eb8a'
      )
    ) AS required_function(
      signature, language_name, volatility, source_sha256
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_proc installed_function
      JOIN pg_language installed_language
        ON installed_language.oid = installed_function.prolang
      WHERE installed_function.oid =
              to_regprocedure(required_function.signature)
        AND installed_function.prokind = 'f'
        AND installed_language.lanname = required_function.language_name
        AND installed_function.provolatile::text =
              required_function.volatility
        AND encode(
          digest(
            convert_to(
              regexp_replace(
                btrim(
                  regexp_replace(
                    installed_function.prosrc,
                    E'(^|[\\n\\r])[[:blank:]]*--[^\\n\\r]*',
                    ' ',
                    'g'
                  )
                ),
                '[[:space:]]+',
                ' ',
                'g'
              ),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) = required_function.source_sha256
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'operations_shopify_location_administration_authorizations',
        'validate_shopify_location_admin_auth_insert', 5,
        'protect_shopify_location_admin_authorization()'
      ),
      (
        'operations_shopify_location_administration_authorizations',
        'protect_shopify_location_admin_auth_write', 27,
        'protect_shopify_location_admin_authorization()'
      ),
      (
        'operations_shopify_location_administration_attempts',
        'protect_shopify_location_admin_attempt_write', 31,
        'protect_shopify_location_admin_attempt()'
      ),
      (
        'operations_shopify_location_administration_outcomes',
        'protect_shopify_location_admin_outcome_write', 31,
        'protect_shopify_location_admin_outcome()'
      )
    ) AS required_trigger(
      table_name, trigger_name, trigger_type, function_signature
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger installed_trigger
      WHERE installed_trigger.tgrelid =
              to_regclass(required_trigger.table_name)
        AND installed_trigger.tgname = required_trigger.trigger_name
        AND installed_trigger.tgtype = required_trigger.trigger_type
        AND installed_trigger.tgenabled = 'O'
        AND NOT installed_trigger.tgisinternal
        AND installed_trigger.tgconstraint = 0
        AND installed_trigger.tgfoid =
              to_regprocedure(required_trigger.function_signature)
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'gsla',
        'operations.shopify_location_administration_authorization'
      ),
      (
        'gslt',
        'operations.shopify_location_administration_attempt'
      ),
      (
        'gslo',
        'operations.shopify_location_administration_outcome'
      )
    ) AS required_reference(prefix, entity_type)
    WHERE NOT EXISTS (
      SELECT 1
      FROM global_reference_entity_types installed_reference
      WHERE installed_reference.prefix = required_reference.prefix
        AND installed_reference.entity_type = required_reference.entity_type
    )
  )
`

// Exact structural attestation for 0290. The catalog hashes pin every column,
// CHECK constraint, and foreign key across the five local-only training
// ledgers. The remaining clauses pin the one-open-run fence and every
// safety-critical function and trigger that prevents training evidence from
// becoming canonical inventory, reservation, shipment, postage, or export
// authority.
const OPERATIONS_SHADOW_TRAINING_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE filename = '0290_operations_shadow_training_runs.sql'
  )
  AND (
    WITH target_table(table_name) AS (
      VALUES
        ('operations_shadow_training_runs'),
        ('operations_shadow_training_packages'),
        ('operations_shadow_training_pick_tasks'),
        ('operations_shadow_training_label_links'),
        ('operations_shadow_training_events')
    )
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_column.attnum::text,
              installed_column.attname,
              format_type(
                installed_column.atttypid,
                installed_column.atttypmod
              ),
              installed_column.attnotnull::text,
              COALESCE(
                pg_get_expr(
                  installed_default.adbin,
                  installed_default.adrelid
                ),
                ''
              )
            ),
            chr(10) ORDER BY
              installed_table.relname,
              installed_column.attnum
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM target_table required_table
    JOIN pg_class installed_table
      ON installed_table.oid = to_regclass(required_table.table_name)
    JOIN pg_attribute installed_column
      ON installed_column.attrelid = installed_table.oid
    LEFT JOIN pg_attrdef installed_default
      ON installed_default.adrelid = installed_column.attrelid
     AND installed_default.adnum = installed_column.attnum
    WHERE installed_column.attnum > 0
      AND NOT installed_column.attisdropped
  ) = '94b2140dfccc4cbe4be93f7a012209f62c42e843571e98478eaed8138f184ca4'
  AND (
    WITH target_table(table_name) AS (
      VALUES
        ('operations_shadow_training_runs'),
        ('operations_shadow_training_packages'),
        ('operations_shadow_training_pick_tasks'),
        ('operations_shadow_training_label_links'),
        ('operations_shadow_training_events')
    )
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_check.conname,
              installed_check.convalidated::text,
              pg_get_constraintdef(installed_check.oid)
            ),
            chr(10) ORDER BY
              installed_table.relname,
              installed_check.conname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM target_table required_table
    JOIN pg_class installed_table
      ON installed_table.oid = to_regclass(required_table.table_name)
    JOIN pg_constraint installed_check
      ON installed_check.conrelid = installed_table.oid
     AND installed_check.contype = 'c'
  ) = '901e43b88b31a4b9351fcfd47922662d4279521cee47565dc58acbf316097286'
  AND (
    WITH target_table(table_name) AS (
      VALUES
        ('operations_shadow_training_runs'),
        ('operations_shadow_training_packages'),
        ('operations_shadow_training_pick_tasks'),
        ('operations_shadow_training_label_links'),
        ('operations_shadow_training_events')
    )
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_fk.conname,
              installed_fk.convalidated::text,
              installed_fk.confdeltype::text,
              installed_fk.confupdtype::text,
              pg_get_constraintdef(installed_fk.oid)
            ),
            chr(10) ORDER BY
              installed_table.relname,
              installed_fk.conname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM target_table required_table
    JOIN pg_class installed_table
      ON installed_table.oid = to_regclass(required_table.table_name)
    JOIN pg_constraint installed_fk
      ON installed_fk.conrelid = installed_table.oid
     AND installed_fk.contype = 'f'
  ) = '499e300e70604fc04b2439d060ffebd1e2115211b8d98d9ce008c23334713db2'
  AND (
    WITH target_table(table_name) AS (
      VALUES
        ('operations_shadow_training_runs'),
        ('operations_shadow_training_packages'),
        ('operations_shadow_training_pick_tasks'),
        ('operations_shadow_training_label_links'),
        ('operations_shadow_training_events')
    )
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_unique.conname,
              installed_unique.contype::text,
              installed_unique.convalidated::text,
              pg_get_constraintdef(installed_unique.oid)
            ),
            chr(10) ORDER BY
              installed_table.relname,
              installed_unique.conname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM target_table required_table
    JOIN pg_class installed_table
      ON installed_table.oid = to_regclass(required_table.table_name)
    JOIN pg_constraint installed_unique
      ON installed_unique.conrelid = installed_table.oid
     AND installed_unique.contype IN ('p', 'u')
  ) = 'c22cef6f8aa8f8fb01e82a154d6c4e93e8ed79eda97a2539ff91c6bdcd4ec834'
  AND (
    WITH target_table(table_name) AS (
      VALUES
        ('operations_shadow_training_runs'),
        ('operations_shadow_training_packages'),
        ('operations_shadow_training_pick_tasks'),
        ('operations_shadow_training_label_links'),
        ('operations_shadow_training_events')
    )
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_index_table.relname,
              installed_index.indisunique::text,
              installed_index.indisprimary::text,
              installed_index.indisvalid::text,
              installed_index.indisready::text,
              installed_index.indisreplident::text,
              installed_index.indnkeyatts::text,
              installed_index.indnatts::text,
              pg_get_indexdef(installed_index.indexrelid),
              COALESCE(
                pg_get_expr(
                  installed_index.indpred,
                  installed_index.indrelid
                ),
                ''
              )
            ),
            chr(10) ORDER BY
              installed_table.relname,
              installed_index_table.relname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM target_table required_table
    JOIN pg_class installed_table
      ON installed_table.oid = to_regclass(required_table.table_name)
    JOIN pg_index installed_index
      ON installed_index.indrelid = installed_table.oid
     AND installed_index.indisunique
    JOIN pg_class installed_index_table
      ON installed_index_table.oid = installed_index.indexrelid
  ) = '16a6e0621dc8e4baa112f231a094243cfd222230f73ecba4b842ba3006f2dba4'
  AND EXISTS (
    SELECT 1
    FROM pg_index installed_index
    WHERE installed_index.indexrelid =
            to_regclass('operations_shadow_training_runs_one_open_order')
      AND installed_index.indrelid =
            to_regclass('operations_shadow_training_runs')
      AND installed_index.indisunique
      AND installed_index.indisvalid
      AND installed_index.indisready
      AND installed_index.indexprs IS NULL
      AND installed_index.indnkeyatts = 2
      AND installed_index.indnatts = 2
      AND ARRAY(
        SELECT installed_column.attname
        FROM unnest(installed_index.indkey::smallint[]) WITH ORDINALITY
          indexed_attribute(attnum, ordinal)
        JOIN pg_attribute installed_column
          ON installed_column.attrelid = installed_index.indrelid
         AND installed_column.attnum = indexed_attribute.attnum
        ORDER BY indexed_attribute.ordinal
      ) = ARRAY['organization_id', 'source_order_id']::name[]
      AND pg_get_expr(
        installed_index.indpred,
        installed_index.indrelid
      ) = '(state <> ''reset''::text)'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'validate_operations_shadow_training_package_fact()',
        'plpgsql', 'v',
        '6898d7e22abcb3963c55bac7f3eb30cef0eda6dd8ca030d36e1bf99d3f683cd0'
      ),
      (
        'validate_operations_shadow_training_pick_fact()',
        'plpgsql', 'v',
        '340ca4ea1323121e8316f852e9240f21cc99fb23bf53eb312d923617347c3bce'
      ),
      (
        'validate_operations_shadow_training_plan_coverage()',
        'plpgsql', 'v',
        '1ec65dc17177ce3d53776ebb035f175f0d7ba10900d2dc5de88bfb31aafd5ea0'
      ),
      (
        'protect_operations_shadow_training_run()',
        'plpgsql', 'v',
        '9a033b6182465d99682fc1ecee2dca0302ac95f726b1f2b3d1ef6c7bc932371a'
      ),
      (
        'validate_operations_shadow_training_run_identity()',
        'plpgsql', 'v',
        '4d0a836345d3bc310ad27d9ae4f74a25b0bc2bf246e10712b3e2427bd168cf93'
      ),
      (
        'protect_operations_shadow_training_package()',
        'plpgsql', 'v',
        '8425b26ae132be23ef0b835fc03b5ac35bf0b42b2728a098ff1184f62f4fa1fc'
      ),
      (
        'protect_operations_shadow_training_pick_task()',
        'plpgsql', 'v',
        'c1fa92771860f78c76184fae9ffa538cb772d25efd0fadc23d2f72192f106e21'
      ),
      (
        'protect_operations_shadow_training_event()',
        'plpgsql', 'v',
        'e15f2304f2daa3d4ec1238374d052368f57c68bf6df030bbdd21735e245bf230'
      ),
      (
        'validate_operations_shadow_training_label_link()',
        'plpgsql', 'v',
        '786a373981688256f1f83b94208b405a2b6446d04a21678a2a76a4110005d14e'
      ),
      (
        'guard_shadow_commerce_canonical_write()',
        'plpgsql', 'v',
        'eac242f228f3865c002e492a3e451a519d63c642794ca4c102ac0a7f34e710a3'
      ),
      (
        'guard_shadow_training_activation_change()',
        'plpgsql', 'v',
        'b6f80a886cf6d6218b714c8588219464a07c801991fa727de219db515861855f'
      )
    ) AS required_function(
      signature, language_name, volatility, source_sha256
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_proc installed_function
      JOIN pg_language installed_language
        ON installed_language.oid = installed_function.prolang
      WHERE installed_function.oid =
              to_regprocedure(required_function.signature)
        AND installed_function.prokind = 'f'
        AND installed_language.lanname = required_function.language_name
        AND installed_function.provolatile::text =
              required_function.volatility
        AND encode(
          digest(
            convert_to(
              regexp_replace(
                btrim(
                  regexp_replace(
                    installed_function.prosrc,
                    E'(^|[\\n\\r])[[:blank:]]*--[^\\n\\r]*',
                    ' ',
                    'g'
                  )
                ),
                '[[:space:]]+',
                ' ',
                'g'
              ),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) = required_function.source_sha256
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'operations_shadow_training_packages',
        'validate_operations_shadow_training_package_fact_commit',
        5, true, true, true,
        'validate_operations_shadow_training_package_fact()'
      ),
      (
        'operations_shadow_training_pick_tasks',
        'validate_operations_shadow_training_pick_fact_commit',
        5, true, true, true,
        'validate_operations_shadow_training_pick_fact()'
      ),
      (
        'operations_shadow_training_runs',
        'validate_operations_shadow_training_plan_coverage_update',
        19, false, false, false,
        'validate_operations_shadow_training_plan_coverage()'
      ),
      (
        'operations_shadow_training_runs',
        'validate_operations_shadow_training_run_identity_mutation',
        23, false, false, false,
        'validate_operations_shadow_training_run_identity()'
      ),
      (
        'operations_shadow_training_runs',
        'protect_operations_shadow_training_run_mutation',
        27, false, false, false,
        'protect_operations_shadow_training_run()'
      ),
      (
        'operations_shadow_training_packages',
        'protect_operations_shadow_training_package_mutation',
        27, false, false, false,
        'protect_operations_shadow_training_package()'
      ),
      (
        'operations_shadow_training_pick_tasks',
        'protect_operations_shadow_training_pick_task_mutation',
        27, false, false, false,
        'protect_operations_shadow_training_pick_task()'
      ),
      (
        'operations_shadow_training_events',
        'protect_operations_shadow_training_event_mutation',
        27, false, false, false,
        'protect_operations_shadow_training_event()'
      ),
      (
        'operations_shadow_training_label_links',
        'validate_operations_shadow_training_label_link_mutation',
        31, false, false, false,
        'validate_operations_shadow_training_label_link()'
      ),
      (
        'operations_fulfillment_plans',
        'guard_shadow_commerce_canonical_plan_insert',
        23, false, false, false,
        'guard_shadow_commerce_canonical_write()'
      ),
      (
        'operations_reservations',
        'guard_shadow_commerce_canonical_reservation_insert',
        23, false, false, false,
        'guard_shadow_commerce_canonical_write()'
      ),
      (
        'operations_shipments',
        'guard_shadow_commerce_canonical_shipment_insert',
        23, false, false, false,
        'guard_shadow_commerce_canonical_write()'
      ),
      (
        'operations_commerce_fulfillment_exports',
        'guard_shadow_commerce_canonical_export_insert',
        23, false, false, false,
        'guard_shadow_commerce_canonical_write()'
      ),
      (
        'operations_activation_scopes',
        'guard_shadow_training_activation_change_insert',
        7, false, false, false,
        'guard_shadow_training_activation_change()'
      ),
      (
        'operations_activation_scopes',
        'guard_shadow_training_activation_change_update',
        19, false, false, false,
        'guard_shadow_training_activation_change()'
      ),
      (
        'operations_activation_scopes',
        'guard_shadow_training_activation_change_delete',
        11, false, false, false,
        'guard_shadow_training_activation_change()'
      )
    ) AS required_trigger(
      table_name, trigger_name, trigger_type, constraint_trigger,
      trigger_deferrable, initially_deferred, function_signature
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger installed_trigger
      WHERE installed_trigger.tgrelid =
              to_regclass(required_trigger.table_name)
        AND installed_trigger.tgname = required_trigger.trigger_name
        AND installed_trigger.tgtype = required_trigger.trigger_type
        AND installed_trigger.tgenabled = 'O'
        AND NOT installed_trigger.tgisinternal
        AND (installed_trigger.tgconstraint <> 0) =
              required_trigger.constraint_trigger
        AND installed_trigger.tgdeferrable =
              required_trigger.trigger_deferrable
        AND installed_trigger.tginitdeferred =
              required_trigger.initially_deferred
        AND installed_trigger.tgfoid =
              to_regprocedure(required_trigger.function_signature)
        AND ARRAY(
          SELECT installed_update_column.attname
          FROM unnest(installed_trigger.tgattr::smallint[])
            WITH ORDINALITY update_attribute(attnum, ordinal)
          JOIN pg_attribute installed_update_column
            ON installed_update_column.attrelid = installed_trigger.tgrelid
           AND installed_update_column.attnum = update_attribute.attnum
          ORDER BY update_attribute.ordinal
        ) = CASE
          WHEN required_trigger.trigger_name IN (
            'validate_operations_shadow_training_plan_coverage_update',
            'guard_shadow_training_activation_change_update'
          ) THEN ARRAY['state']::name[]
          ELSE ARRAY[]::name[]
        END
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('gtrn', 'operations.shadow_training_run'),
      ('gtpk', 'operations.shadow_training_package'),
      ('gtpt', 'operations.shadow_training_pick_task'),
      ('gtll', 'operations.shadow_training_label_link'),
      ('gtev', 'operations.shadow_training_event')
    ) AS required_reference(prefix, entity_type)
    WHERE NOT EXISTS (
      SELECT 1
      FROM global_reference_entity_types installed_reference
      WHERE installed_reference.prefix = required_reference.prefix
        AND installed_reference.entity_type = required_reference.entity_type
    )
  )
`

// Exact structural attestation for the planned-only 0291 correction ledger.
// The migration checksum and catalog hashes pin every column, CHECK, foreign
// key, primary/unique constraint, and index. Function-source and trigger
// hashes keep the validation and append-only fences intact, while the exact
// global reference binding keeps correction evidence in its registered
// namespace.
const OPERATIONS_ORDER_REPLANNING_CORRECTIONS_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE filename = '0291_operations_order_replanning_corrections.sql'
      AND checksum =
        '6ac42626a53b421d1d5085e0f2ddc578df29ec400d2a70bc156ce9c9fbb0ff60'
  )
  AND (
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_column.attnum::text,
              installed_column.attname,
              format_type(
                installed_column.atttypid,
                installed_column.atttypmod
              ),
              installed_column.attnotnull::text,
              COALESCE(
                pg_get_expr(
                  installed_default.adbin,
                  installed_default.adrelid
                ),
                ''
              )
            ),
            chr(10) ORDER BY installed_column.attnum
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_class installed_table
    JOIN pg_attribute installed_column
      ON installed_column.attrelid = installed_table.oid
    LEFT JOIN pg_attrdef installed_default
      ON installed_default.adrelid = installed_column.attrelid
     AND installed_default.adnum = installed_column.attnum
    WHERE installed_table.oid =
            to_regclass('operations_order_replanning_corrections')
      AND installed_column.attnum > 0
      AND NOT installed_column.attisdropped
  ) = '2938b378a5b5bcca279c528b86d7b1df9182abfd31351d1c7fe39735aee4ec67'
  AND (
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_check.conname,
              installed_check.convalidated::text,
              pg_get_constraintdef(installed_check.oid)
            ),
            chr(10) ORDER BY installed_check.conname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_class installed_table
    JOIN pg_constraint installed_check
      ON installed_check.conrelid = installed_table.oid
     AND installed_check.contype = 'c'
    WHERE installed_table.oid =
            to_regclass('operations_order_replanning_corrections')
  ) = '803de41c0651fcdb789c3cb0713fdd4b624fc193734971d6ce3685bcd32f3b44'
  AND (
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_fk.conname,
              installed_fk.convalidated::text,
              installed_fk.confdeltype::text,
              installed_fk.confupdtype::text,
              pg_get_constraintdef(installed_fk.oid)
            ),
            chr(10) ORDER BY installed_fk.conname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_class installed_table
    JOIN pg_constraint installed_fk
      ON installed_fk.conrelid = installed_table.oid
     AND installed_fk.contype = 'f'
    WHERE installed_table.oid =
            to_regclass('operations_order_replanning_corrections')
  ) = '2187b8e068b269a9b028016c289bcbafb015d21cc5741af9662af9ac755f888c'
  AND (
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_unique.conname,
              installed_unique.contype::text,
              installed_unique.convalidated::text,
              pg_get_constraintdef(installed_unique.oid)
            ),
            chr(10) ORDER BY installed_unique.conname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_class installed_table
    JOIN pg_constraint installed_unique
      ON installed_unique.conrelid = installed_table.oid
     AND installed_unique.contype IN ('p', 'u')
    WHERE installed_table.oid =
            to_regclass('operations_order_replanning_corrections')
  ) = '48bcb77441900d0f09ef13a570e6cb2a9d14af7d7731de14224aa02771f11348'
  AND (
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_index_table.relname,
              installed_index.indisunique::text,
              installed_index.indisprimary::text,
              installed_index.indisvalid::text,
              installed_index.indisready::text,
              installed_index.indisreplident::text,
              installed_index.indnkeyatts::text,
              installed_index.indnatts::text,
              pg_get_indexdef(installed_index.indexrelid),
              COALESCE(
                pg_get_expr(
                  installed_index.indpred,
                  installed_index.indrelid
                ),
                ''
              )
            ),
            chr(10) ORDER BY installed_index_table.relname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_class installed_table
    JOIN pg_index installed_index
      ON installed_index.indrelid = installed_table.oid
    JOIN pg_class installed_index_table
      ON installed_index_table.oid = installed_index.indexrelid
    WHERE installed_table.oid =
            to_regclass('operations_order_replanning_corrections')
  ) = '767b517b2911b4f3e4e527605531e4bcbc46701fbb69c4aa7421e85b865b4951'
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'validate_operations_order_replanning_correction()',
        'plpgsql', 'v',
        '9e9d9e682d1aeefb8a08476ea4c2c48139eb0857d82824c48925d4f4654b9041'
      ),
      (
        'reject_operations_order_replanning_correction_mutation()',
        'plpgsql', 'v',
        '6ff446c0be811717eb351904655a3b6b1f846c8cb0fd71da15f2c06da1d5ca42'
      )
    ) AS required_function(
      signature, language_name, volatility, source_sha256
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_proc installed_function
      JOIN pg_language installed_language
        ON installed_language.oid = installed_function.prolang
      WHERE installed_function.oid =
              to_regprocedure(required_function.signature)
        AND installed_function.prokind = 'f'
        AND installed_language.lanname = required_function.language_name
        AND installed_function.provolatile::text =
              required_function.volatility
        AND encode(
          digest(
            convert_to(
              regexp_replace(
                btrim(
                  regexp_replace(
                    installed_function.prosrc,
                    E'(^|[\\n\\r])[[:blank:]]*--[^\\n\\r]*',
                    ' ',
                    'g'
                  )
                ),
                '[[:space:]]+',
                ' ',
                'g'
              ),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) = required_function.source_sha256
    )
  )
  AND (
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_table.relname,
              installed_trigger.tgname,
              installed_trigger.tgtype::text,
              (installed_trigger.tgconstraint <> 0)::text,
              installed_trigger.tgdeferrable::text,
              installed_trigger.tginitdeferred::text,
              installed_trigger.tgenabled::text,
              installed_trigger.tgfoid::regprocedure::text,
              installed_trigger.tgattr::text
            ),
            chr(10) ORDER BY installed_trigger.tgname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_class installed_table
    JOIN pg_trigger installed_trigger
      ON installed_trigger.tgrelid = installed_table.oid
     AND NOT installed_trigger.tgisinternal
    WHERE installed_table.oid =
            to_regclass('operations_order_replanning_corrections')
  ) = '14ac1ff9cfe3b8e46f113db57f19c591b01b363fe107865b79e9ed2cdedbc96f'
  AND EXISTS (
    SELECT 1
    FROM global_reference_entity_types installed_reference
    WHERE installed_reference.prefix = 'gorc'
      AND installed_reference.entity_type =
            'operations.order_replanning_correction'
      AND installed_reference.display_name = 'Order replanning correction'
  )
`
function commerceRevisionEvidenceConfiguration() {
  try {
    const configuration = resolveCommerceOrderRevisionEvidenceKeyConfig({
      environment: process.env,
      hosted: isHostedRuntime(),
    })
    const readiness = summarizeCommerceOrderRevisionEvidenceKeyReadiness(
      configuration,
      { referencedKeyIds: [], unpurgedProtectedReadCount: 0 },
    )
    return {
      status: readiness.ready ? 'ready' : 'invalid',
      activeKeyId: readiness.activeKeyId,
      keyCount: readiness.configuredKeyIds.length,
      reason: readiness.ready ? null : 'key_configuration_invalid',
    }
  } catch (error) {
    const reason = error instanceof CommerceOrderRevisionEvidenceKeyConfigError
      ? ({
          COMMERCE_ORDER_REVISION_EVIDENCE_FINGERPRINT_KEY_REQUIRED:
            'fingerprint_key_missing',
          COMMERCE_ORDER_REVISION_EVIDENCE_ACTIVE_KEY_ID_REQUIRED:
            'active_key_id_invalid',
          COMMERCE_ORDER_REVISION_EVIDENCE_ACTIVE_KEY_ID_INVALID:
            'active_key_id_invalid',
          COMMERCE_ORDER_REVISION_EVIDENCE_KEY_RING_REQUIRED:
            'key_ring_invalid',
          COMMERCE_ORDER_REVISION_EVIDENCE_KEY_RING_INVALID:
            'key_ring_invalid',
          COMMERCE_ORDER_REVISION_EVIDENCE_ACTIVE_KEY_UNAVAILABLE:
            'active_key_unavailable',
        } as Record<string, string>)[error.code]
        || 'key_configuration_invalid'
      : 'key_configuration_invalid'
    return {
      status: 'invalid', activeKeyId: null, keyCount: 0,
      reason,
    }
  }
}

function resolveLogPath(): { path: string; expectedDevLogPresent: boolean; usedFallback: boolean } {
  const expectedDevLogPresent = fs.existsSync(DEV_LOG_PATH)
  if (expectedDevLogPresent) {
    return { path: DEV_LOG_PATH, expectedDevLogPresent, usedFallback: false }
  }

  if (fs.existsSync(FALLBACK_LOG_PATH)) {
    return { path: FALLBACK_LOG_PATH, expectedDevLogPresent, usedFallback: true }
  }

  return { path: DEV_LOG_PATH, expectedDevLogPresent, usedFallback: false }
}

function readLogTailUtf8(path: string, bytes: number): string {
  const stat = fs.statSync(path)
  const size = stat.size
  if (size <= 0) return ''

  const chunkSize = Math.min(size, bytes)
  const start = Math.max(0, size - chunkSize)
  const fd = fs.openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(chunkSize)
    fs.readSync(fd, buffer, 0, chunkSize, start)
    return buffer.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

export async function GET() {
  const checkedAt = Date.now()
  const railwayRuntime = Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.RAILWAY_ENVIRONMENT_ID
    || process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_ENVIRONMENT,
  )
  const cloudProvider = railwayRuntime ? 'railway' : process.env.VERCEL ? 'vercel' : null

  if (isHostedRuntime()) {
    const errors: string[] = []
    const warnings: string[] = []
    const storage = getStorageDriver()
    const commerceReadReconciliation = commerceReadRuntimeSummary()
    const shopifyOrderManagementRuntimeState =
      shopifyOrderManagementRuntime()
    const shopifyOrderManagementRuntimeSummary = {
      available: shopifyOrderManagementRuntimeState.available,
      mode: shopifyOrderManagementRuntimeState.mode,
      blocker: shopifyOrderManagementRuntimeState.blockerCode,
      providerWritesEnabled:
        shopifyOrderManagementRuntimeState.providerWritesEnabled,
      productionAvailable:
        shopifyOrderManagementRuntimeState.productionAvailable,
      allowlistedAccountCount:
        shopifyOrderManagementRuntimeState.allowedAccountGlobalIds.length,
    }
    let shopifyOrderManagement: Record<string, unknown> = {
      status: 'migration-pending',
      runtime: shopifyOrderManagementRuntimeSummary,
      durable: null,
    }
    const fulfillmentOptimizer = fulfillmentOptimizerRuntimeHealth()
    if (fulfillmentOptimizer.configurationStatus === 'invalid') {
      errors.push(
        `Fulfillment optimizer runtime configuration is invalid (${fulfillmentOptimizer.reason || 'ORTOOLS_CONFIGURATION_INVALID'}).`,
      )
    } else if (
      railwayRuntime
      && fulfillmentOptimizer.configurationStatus === 'disabled'
    ) {
      errors.push(
        'Fulfillment optimizer is disabled in this Railway application environment.',
      )
    }
    let database: Record<string, unknown> = { status: 'not-configured' }
    let credentialStore: Record<string, unknown> = { status: 'not-configured' }
    let worker: Record<string, unknown> = { status: 'not-owned' }
    let agentWorker: Record<string, unknown> = { status: 'not-owned' }
    let agentResearchWorker: Record<string, unknown> = { status: 'not-owned' }
    let toastWorker: Record<string, unknown> = { status: 'not-owned' }
    let quickBooksWorker: Record<string, unknown> = { status: 'not-owned' }
    let commerceCatalogWorker: Record<string, unknown> = {
      status: 'disabled',
      runtimeAuthority: commerceReadReconciliation,
    }
    let commerceOrderReconciliationWorker: Record<string, unknown> = {
      status: 'disabled',
      runtimeAuthority: commerceReadReconciliation,
      automaticShopifyOrderPromotion:
        shopifyAutomaticOrderPromotionHealthSnapshot(),
      automaticFaireOrderPromotion:
        faireAutomaticOrderPromotionHealthSnapshot(),
      automaticFaireExactRefresh:
        faireAutomaticExactRefreshHealthSnapshot(),
      automaticFaireUnattributedAttention:
        faireUnattributedAttentionHealthSnapshot(),
      canonicalOrderRevisions: {
        status: 'migration-pending',
        heartbeat: null,
        durable: null,
      },
    }
    let commerceOrderHistory: Record<string, unknown> = {
      status: 'not-applied',
      providerReadOnly: true,
      providerWrites: 0,
    }
    let shopifyInventoryRefreshWorker: Record<string, unknown> = {
      status: 'disabled',
      runtimeAuthority: commerceReadReconciliation,
    }
    let shopifyWebhookReceipts: Record<string, unknown> = {
      status: 'disabled',
      accounts: 0,
      actionableAccounts: 0,
      actionable: 0,
      staleQueued: 0,
      staleProcessing: 0,
      failed: 0,
      deadLetter: 0,
      heldProductDeletes: 0,
      oldestActionableAt: null,
    }
    let faireInventoryPollWorker: Record<string, unknown> = {
      status: 'disabled',
      runtimeAuthority: commerceReadReconciliation,
    }
    let commerceProductImageImportWorker: Record<string, unknown> = {
      status: 'disabled',
      runtimeAuthority: commerceReadReconciliation,
    }
    let faireProductImageProjection: Record<string, unknown> = {
      status: 'unavailable',
      latestResultAt: null,
    }
    const suiteCrmProductImageConfiguration =
      suiteCrmProductImageReadConfiguration()
    const suiteCrmNativeProductImageConfiguration =
      suiteCrmNativeProductImageProjectionConfiguration()
    let suiteCrmNativeProductImageProjection: Record<string, unknown> = {
      status: suiteCrmNativeProductImageConfiguration.enabled
        ? 'unavailable'
        : 'disabled',
      ...suiteCrmNativeProductImageConfiguration,
      latestResult: null,
      latestResultAt: null,
    }
    let suiteCrmProductImageIngestion: Record<string, unknown> = {
      status: suiteCrmProductImageConfiguration.enabled
        ? 'unavailable'
        : 'disabled',
      enabled: suiteCrmProductImageConfiguration.enabled,
      ready: suiteCrmProductImageConfiguration.ready,
      missing: suiteCrmProductImageConfiguration.missing,
      invalid: suiteCrmProductImageConfiguration.invalid,
      credentialConflicts:
        suiteCrmProductImageConfiguration.credentialConflicts,
      aclAttestation: suiteCrmProductImageConfiguration.aclAttestation,
      requiredAcl: suiteCrmProductImageConfiguration.acl,
      providerWrites: 0,
    }
    let integrationQueues: Record<string, unknown> = { status: 'not-configured' }
    let operationsCommands: Record<string, unknown> = { status: 'not-configured' }
    let crm: Record<string, unknown> = { status: 'disabled' }
    let knowledgeWorkers: Array<Record<string, unknown>> = []
    const repositoryRunner = getRepositoryRunnerConfiguration()
    const commerceRevisionEvidence =
      commerceRevisionEvidenceConfiguration()

    if (cloudProvider === 'railway' && storage !== 'postgres') {
      errors.push('Railway runtime requires Postgres storage.')
    }
    if (process.env.APP_AUTH_REQUIRED !== '1') {
      errors.push('Hosted runtime authentication is not enabled.')
    }
    if (String(process.env.APP_LOGIN_PASSWORD || '').length < 16) {
      errors.push('Hosted runtime login password is missing or too short.')
    }
    if (!String(process.env.APP_LOGIN_EMAIL || '').includes('@')) {
      errors.push('Hosted runtime operator email is not configured.')
    }
    if (String(process.env.APP_SESSION_SECRET || process.env.NEXTAUTH_SECRET || '').length < 32) {
      errors.push('Hosted runtime session secret is missing or too short.')
    }
    if (String(process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY || '').length < 32) {
      errors.push('Hosted runtime agent credential encryption key is missing or too short.')
    }
    if (commerceRevisionEvidence.status !== 'ready') {
      errors.push('Hosted runtime commerce revision evidence encryption is not configured.')
    }
    if (String(process.env.AGENT_CREDENTIAL_DATABASE_URL || '').length < 16) {
      errors.push('Hosted runtime agent credential database is not configured.')
    } else {
      try {
        await queryAgentCredentials('SELECT operator_id FROM agent_chatgpt_credentials LIMIT 1')
        credentialStore = { status: 'reachable', shared: true }
      } catch (error) {
        credentialStore = { status: 'unreachable', shared: true }
        console.error('[health] Agent credential store health check failed', error)
        errors.push('Agent credential store is unreachable.')
      }
    }
    if (String(process.env.MATON_API_KEY || '').length < 16) {
      errors.push('Hosted runtime Maton credential is missing or too short.')
    }
    if (String(process.env.MATON_GMAIL_CONNECTION_ID || '').length < 8) {
      errors.push('Hosted runtime Maton Gmail connection is not configured.')
    }
    if (repositoryRunner.enabled && !repositoryRunner.ready) {
      errors.push(repositoryRunner.reason)
    }
    if (!String(process.env.CLAWPILOT_MAIL_FROM || '').includes('@')) {
      errors.push('Hosted runtime ClawPilot mail sender is not configured.')
    }
    try {
      const publicUrl = new URL(String(process.env.CLAWPILOT_PUBLIC_URL || ''))
      if (publicUrl.protocol !== 'https:') errors.push('Hosted runtime public URL must use HTTPS.')
    } catch {
      errors.push('Hosted runtime public URL is not configured.')
    }
    if (String(process.env.PIPELINE_SHEET_ID || '').length < 20) {
      errors.push('Hosted runtime pipeline Sheet is not configured.')
    }
    if (cloudProvider === 'railway' && String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '').length < 32) {
      errors.push('Pipeline outbox worker credential is missing or too short.')
    }
    if (cloudProvider === 'railway' && process.env.CLAWPILOT_DB_FALLBACK_TO_FILE !== 'false') {
      errors.push('Railway database fallback must be disabled.')
    }
    const crmEnabled = process.env.CRM_ENABLED === '1'
    if (crmEnabled) {
      try {
        suiteCrmBaseUrl()
        if (String(process.env.SUITECRM_CLIENT_ID || '').length < 16) throw new Error('SuiteCRM client ID is missing or too short.')
        if (String(process.env.SUITECRM_CLIENT_SECRET || '').length < 32) throw new Error('SuiteCRM client secret is missing or too short.')
        crm = { status: 'configured' }
      } catch (error) {
        crm = { status: 'misconfigured' }
        errors.push(error instanceof Error ? error.message : 'SuiteCRM configuration is invalid.')
      }
    }
    try {
      validateShortLinkConfiguration({ requireServiceClient: true, requirePublicOrigin: true })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Short-link configuration is invalid.')
    }
    let embeddingProvider: 'local' | 'openai' = 'local'
    try {
      embeddingProvider = (await effectiveDocumentEmbeddingConfiguration()).provider
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Document embedding configuration is invalid.')
    }

    if (storage === 'postgres') {
      try {
        const result = await query<{
          now: string
          worker_migration_applied: boolean
          auth_migration_applied: boolean
          agent_auth_migration_applied: boolean
          users_migration_applied: boolean
          attribution_migration_applied: boolean
          workspaces_migration_applied: boolean
          workspace_security_migration_applied: boolean
          agent_dispatch_migration_applied: boolean
          invitation_migration_applied: boolean
          knowledge_migration_applied: boolean
          hardening_migration_applied: boolean
          invitation_delivery_migration_applied: boolean
          invitation_pending_migration_applied: boolean
          shortlinks_migration_applied: boolean
          vector_knowledge_migration_applied: boolean
          shortlink_preflight_migration_applied: boolean
          shortlink_hardening_migration_applied: boolean
          maton_credentials_migration_applied: boolean
          managed_pipeline_resources_migration_applied: boolean
          crm_gateway_migration_applied: boolean
          crm_identity_hierarchy_migration_applied: boolean
          pipeline_sheet_links_migration_applied: boolean
          crm_integrations_migration_applied: boolean
          crm_board_projection_migration_applied: boolean
          account_membership_migration_applied: boolean
          suitecrm_inbound_sync_migration_applied: boolean
          crm_display_text_migration_applied: boolean
          browser_sessions_migration_applied: boolean
          workspace_preferences_migration_applied: boolean
          pipeline_catalog_migration_applied: boolean
          atomic_product_catalog_migration_applied: boolean
          organization_branding_migration_applied: boolean
          pipeline_spelling_migration_applied: boolean
          residual_pipeline_catalog_migration_applied: boolean
          historical_pipeline_catalog_migration_applied: boolean
          configured_pipeline_dropdowns_migration_applied: boolean
          canonical_dropdown_layout_migration_applied: boolean
          empty_pipeline_templates_migration_applied: boolean
          crm_contact_owner_identity_migration_applied: boolean
          repository_runner_migration_applied: boolean
          crm_employee_identity_migration_applied: boolean
          canonical_suitecrm_usernames_migration_applied: boolean
          agent_research_migration_applied: boolean
          toast_integrations_migration_applied: boolean
          multi_workspace_memberships_migration_applied: boolean
          quickbooks_connector_migration_applied: boolean
          quickbooks_explorer_migration_applied: boolean
          quickbooks_reports_migration_applied: boolean
          quickbooks_write_control_migration_applied: boolean
          demo_quickbooks_crm_migration_applied: boolean
          demo_workspace_account_migration_applied: boolean
          toast_pos_orders_migration_applied: boolean
          quickbooks_write_connection_binding_migration_applied: boolean
          pos_accounting_profiles_migration_applied: boolean
          toast_menu_catalog_migration_applied: boolean
          quickbooks_reference_catalogs_migration_applied: boolean
          toast_sync_rerun_migration_applied: boolean
          toast_sync_worker_hardening_migration_applied: boolean
          pos_accounting_notifications_migration_applied: boolean
          quickbooks_write_binding_compatibility_migration_applied: boolean
          pos_accounting_notification_consent_migration_applied: boolean
          pos_accounting_date_commands_migration_applied: boolean
          pos_accounting_posting_outcomes_migration_applied: boolean
          external_pos_accounting_outcomes_migration_applied: boolean
          distributed_operations_migration_applied: boolean
          operations_hardening_migration_applied: boolean
          crm_interaction_contacts_migration_applied: boolean
          operations_command_results_migration_applied: boolean
          operations_package_workflow_migration_applied: boolean
          product_packaging_profiles_migration_applied: boolean
          operations_carrier_credentials_migration_applied: boolean
          operations_sandbox_rating_migration_applied: boolean
          operations_rate_delegation_migration_applied: boolean
          operations_carrier_accounts_gl_coding_migration_applied: boolean
          operations_printer_configuration_migration_applied: boolean
          operations_carrier_billing_integrity_migration_applied: boolean
          operations_carrier_billing_review_migration_applied: boolean
          operations_print_delivery_migration_applied: boolean
          operations_print_device_reference_privacy_applied: boolean
          operations_print_agent_pairing_grants_applied: boolean
          shopify_carrier_configured_carriers_applied: boolean
          shopify_checkout_audience_policy_applied: boolean
          carrier_shipping_diagnostics_applied: boolean
          carrier_shipping_diagnostic_attempt_counts: Record<
            'sandbox' | 'production',
            {
              prepared: number
              stalePrepared: number
              succeeded: number
              failed: number
              unknown: number
            }
          >
          crm_native_activity_projection_migration_applied: boolean
          crm_contact_identity_aliases_migration_applied: boolean
          operations_settlement_lifecycle_migration_applied: boolean
          operations_label_execution_migration_applied: boolean
          operations_receiving_topology_migration_applied: boolean
          pos_payment_exceptions_migration_applied: boolean
          crm_reference_quarantine_migration_applied: boolean
          demo_managed_resource_guard_migration_applied: boolean
          quickbooks_pos_evidence_refresh_migration_applied: boolean
          toast_location_closeout_hour_migration_applied: boolean
          operations_warehouse_operating_profile_migration_applied: boolean
          operations_slotting_replenishment_migration_applied: boolean
          operations_replenishment_execution_migration_applied: boolean
          operations_carrier_account_sender_name_migration_applied: boolean
          operations_commerce_integrations_migration_applied: boolean
          operations_faire_oauth_migration_applied: boolean
          operations_shopify_order_preview_migration_applied: boolean
          operations_commerce_normalization_migration_applied: boolean
          operations_commerce_continuations_migration_applied: boolean
          operations_commerce_order_attention_kinds_applied: boolean
          operations_carrier_rate_test_labels_migration_applied: boolean
          operations_print_agent_capabilities_migration_applied: boolean
          operations_carrier_label_artifacts_migration_applied: boolean
          operations_commerce_product_policy_migration_applied: boolean
          operations_commerce_catalog_sync_migration_applied: boolean
          operations_package_contents_migration_applied: boolean
          operations_commerce_incomplete_header_money_migration_applied: boolean
          operations_packaging_materials_migration_applied: boolean
          operations_packaging_material_lifecycle_migration_applied: boolean
          operations_shopify_inventory_migration_applied: boolean
          measurement_preferences_migration_applied: boolean
          packaging_material_unit_neutral_names_migration_applied: boolean
          workspace_currency_preference_migration_applied: boolean
          operations_pack_hierarchy_migration_applied: boolean
          crm_data_transfers_migration_applied: boolean
          operations_product_channel_states_migration_applied: boolean
          crm_product_identity_aliases_migration_applied: boolean
          operations_product_channel_offers_migration_applied: boolean
          operations_pack_runtime_association_migration_applied: boolean
          operations_commerce_pack_resolution_migration_applied: boolean
          operations_hybrid_cartonization_recipes_migration_applied: boolean
          operations_cartonization_package_rates_migration_applied: boolean
          operations_cartonization_rate_evidence_migration_applied: boolean
          operations_cartonization_rate_evidence_integrity_applied: boolean
          operations_fulfilled_line_price_state_applied: boolean
          operations_commerce_packaging_source_repair_applied: boolean
          operations_recipe_pack_association_migration_applied: boolean
          operations_cartonization_evidence_scale_applied: boolean
          operations_cartonization_shipment_rates_applied: boolean
          operations_one_off_shipments_applied: boolean
          operations_cartonization_enabled_carriers_applied: boolean
          operations_cartonization_rate_constraint_repair_applied: boolean
          operations_two_pass_pack_rate_runs_applied: boolean
          operations_pack_rate_pricing_semantics_applied: boolean
          operations_carrier_billing_mud_applied: boolean
          operations_shopify_inventory_refresh_migration_applied: boolean
          operations_shopify_location_routing_applied: boolean
          operations_shopify_location_administration_applied: boolean
          operations_shadow_training_applied: boolean
          operations_order_replanning_corrections_applied: boolean
          operations_shopify_inventory_webhook_refresh_applied: boolean
          operations_shopify_catalog_webhook_refresh_applied: boolean
          operations_commerce_pack_evidence_fingerprint_applied: boolean
          operations_shadow_fulfillment_destination_repair_applied: boolean
          operations_shadow_rate_choice_package_identity_repair_applied: boolean
          operations_fulfillment_execution_union_repair_applied: boolean
          operations_fulfillment_rate_parcel_repair_applied: boolean
          operations_shopify_checkout_plan_rate_policy_applied: boolean
          shopify_active_account_readiness_migration_applied: boolean
          operations_commerce_inventory_attempt_lease_renewal_applied: boolean
          operations_shopify_shipping_service_codes_applied: boolean
          operations_shopify_checkout_provider_attempts_applied: boolean
          operations_shopify_checkout_rate_warm_policy_applied: boolean
          operations_canonical_fulfillment_planning_applied: boolean
          operations_fulfillment_executions_applied: boolean
          operations_shopify_customer_rate_policies_applied: boolean
          operations_active_multi_package_execution_applied: boolean
          operations_production_fulfillment_rerates_applied: boolean
          operations_shopify_shadow_policy_lifetime_applied: boolean
          operations_shopify_shadow_test_subsidy_applied: boolean
          operations_shopify_quote_match_families_applied: boolean
          operations_sandbox_commerce_e2e_authorization_applied: boolean
          operations_commerce_active_canonical_collation_applied: boolean
          operations_sandbox_commerce_e2e_active_guards_applied: boolean
          operations_faire_sandbox_commerce_e2e_applied: boolean
          operations_fulfillment_notification_policy_applied: boolean
          global_id_alphanumeric_compatibility_applied: boolean
          global_id_base32hex_allocator_applied: boolean
          faire_provider_write_auth_applied: boolean
          faire_fulfillment_authority_applied: boolean
          operations_commerce_fulfillment_recovery_applied: boolean
          operations_commerce_product_image_imports_applied: boolean
          operations_commerce_product_image_fanout_applied: boolean
          operations_commerce_product_image_source_normalization_applied: boolean
          operations_faire_product_image_projection_applied: boolean
          operations_faire_inventory_polling_applied: boolean
          suitecrm_product_image_reverse_ingestion_applied: boolean
          operations_commerce_order_revisions_applied: boolean
          operations_commerce_order_revision_apply_applied: boolean
          operations_one_off_carrier_selection_applied: boolean
          operations_commerce_order_sync_foundation_applied: boolean
          operations_commerce_authority_policies_applied: boolean
          operations_shopify_order_webhook_signals_applied: boolean
          operations_shopify_order_management_applied: boolean
          migration_checksums_present: boolean
        }>(
          `
            SELECT
              now()::text AS now,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0002_pipeline_outbox_worker.sql'
              ) AS worker_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0003_auth_magic_codes.sql'
              ) AS auth_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0004_agent_chatgpt_auth.sql'
              ) AS agent_auth_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0005_app_users.sql'
              ) AS users_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0006_agent_user_attribution.sql'
              ) AS attribution_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0007_multi_tenant_workspaces.sql'
              ) AS workspaces_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0008_workspace_security_hardening.sql'
              ) AS workspace_security_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0009_agent_dispatch_outbox.sql'
              ) AS agent_dispatch_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0010_user_invitations.sql'
              ) AS invitation_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0011_knowledge_releases_checkpoints.sql'
              ) AS knowledge_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0012_invitation_release_hardening.sql'
              ) AS hardening_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0013_invitation_delivery_coordination.sql'
              ) AS invitation_delivery_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0014_invitation_delivery_pending.sql'
              ) AS invitation_pending_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0015_short_links.sql'
              ) AS shortlinks_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0016_document_vectors_and_ai_radar.sql'
              ) AS vector_knowledge_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0016_z_short_link_destination_preflight.sql'
              ) AS shortlink_preflight_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0017_short_link_destination_hardening.sql'
              ) AS shortlink_hardening_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0018_user_maton_credentials.sql'
              ) AS maton_credentials_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0019_managed_pipeline_google_resources.sql'
              ) AS managed_pipeline_resources_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0020_crm_gateway_and_reporting.sql'
              ) AS crm_gateway_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0021_crm_identity_and_organization_hierarchy.sql'
              ) AS crm_identity_hierarchy_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0022_pipeline_sheet_access_links.sql'
              ) AS pipeline_sheet_links_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0023_crm_modules_references_and_integrations.sql'
              ) AS crm_integrations_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0033_crm_board_projection_and_legacy_alias_cleanup.sql'
              ) AS crm_board_projection_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0034_account_membership_crm_board_scope.sql'
              ) AS account_membership_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0035_suitecrm_inbound_sync_status.sql'
              ) AS suitecrm_inbound_sync_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0036_crm_display_text_and_card_semantics.sql'
              ) AS crm_display_text_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0040_browser_sessions_and_impersonation.sql'
              ) AS browser_sessions_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0041_dashboard_workspace_preferences.sql'
              ) AS workspace_preferences_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0045_pipeline_people_products_and_dropdown_catalogs.sql'
              ) AS pipeline_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0046_atomic_pipeline_products_and_sync_retry_state.sql'
              ) AS atomic_product_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0047_workspace_organization_branding.sql'
              ) AS organization_branding_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0048_canonical_pipeline_negotiation_spelling.sql'
              ) AS pipeline_spelling_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0049_residual_pipeline_catalog_repair.sql'
              ) AS residual_pipeline_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0050_historical_pipeline_catalog_restore.sql'
              ) AS historical_pipeline_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0051_preserve_configured_pipeline_dropdowns.sql'
              ) AS configured_pipeline_dropdowns_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0052_restore_canonical_dropdown_layout.sql'
              ) AS canonical_dropdown_layout_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0053_seed_empty_pipeline_templates.sql'
              ) AS empty_pipeline_templates_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0054_crm_contact_owner_user_identity.sql'
              ) AS crm_contact_owner_identity_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0055_repository_runner_control_plane.sql'
              ) AS repository_runner_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0056_crm_employee_identity_and_workbook_dashboard.sql'
              ) AS crm_employee_identity_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0057_canonical_suitecrm_usernames.sql'
              ) AS canonical_suitecrm_usernames_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0058_agent_public_research_outbox.sql'
              ) AS agent_research_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0059_toast_restaurant_integrations.sql'
              ) AS toast_integrations_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0060_multi_workspace_memberships.sql'
              ) AS multi_workspace_memberships_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0061_quickbooks_organization_connector.sql'
              ) AS quickbooks_connector_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0062_quickbooks_financial_explorer.sql'
              ) AS quickbooks_explorer_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0063_quickbooks_financial_reports.sql'
              ) AS quickbooks_reports_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0064_quickbooks_write_control.sql'
              ) AS quickbooks_write_control_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0065_demo_and_quickbooks_crm_reconciliation.sql'
              ) AS demo_quickbooks_crm_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0066_demo_workspace_account.sql'
              ) AS demo_workspace_account_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0067_toast_pos_orders.sql'
              ) AS toast_pos_orders_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0068_quickbooks_write_connection_binding.sql'
              ) AS quickbooks_write_connection_binding_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0069_pos_accounting_profiles_and_catalog_mappings.sql'
              ) AS pos_accounting_profiles_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0070_toast_menu_catalog.sql'
              ) AS toast_menu_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0071_quickbooks_accounting_reference_catalogs.sql'
              ) AS quickbooks_reference_catalogs_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0072_toast_sync_rerun_requests.sql'
              ) AS toast_sync_rerun_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0073_toast_sync_worker_hardening.sql'
              ) AS toast_sync_worker_hardening_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0074_pos_accounting_issue_notifications.sql'
              ) AS pos_accounting_notifications_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0075_quickbooks_write_binding_compatibility.sql'
              ) AS quickbooks_write_binding_compatibility_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0076_pos_accounting_notification_consent.sql'
              ) AS pos_accounting_notification_consent_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0078_pos_accounting_date_commands.sql'
              ) AS pos_accounting_date_commands_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0079_pos_accounting_posting_outcomes.sql'
              ) AS pos_accounting_posting_outcomes_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0080_external_pos_accounting_outcomes.sql'
              ) AS external_pos_accounting_outcomes_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0081_distributed_operations_foundation.sql'
              ) AS distributed_operations_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0082_operations_activation_and_command_safety.sql'
              ) AS operations_hardening_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0083_crm_interaction_contacts.sql'
              ) AS crm_interaction_contacts_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0084_operations_command_results.sql'
              ) AS operations_command_results_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0085_operations_package_workflow.sql'
              ) AS operations_package_workflow_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0086_product_packaging_profiles.sql'
              ) AS product_packaging_profiles_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0087_operations_carrier_credentials.sql'
              ) AS operations_carrier_credentials_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0088_operations_sandbox_rating_and_mock_retirement.sql'
              ) AS operations_sandbox_rating_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0089_operations_rate_delegation_and_carrier_settlement.sql'
              ) AS operations_rate_delegation_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0090_operations_carrier_accounts_and_gl_coding.sql'
              ) AS operations_carrier_accounts_gl_coding_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0091_operations_printer_configuration.sql'
              ) AS operations_printer_configuration_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0092_operations_carrier_billing_integrity.sql'
              ) AS operations_carrier_billing_integrity_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0093_operations_carrier_billing_import_and_review.sql'
              ) AS operations_carrier_billing_review_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0094_operations_print_delivery.sql'
              ) AS operations_print_delivery_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0095_crm_native_activity_projection.sql'
              ) AS crm_native_activity_projection_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0096_crm_contact_identity_aliases.sql'
              ) AS crm_contact_identity_aliases_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0097_operations_settlement_lifecycle.sql'
              ) AS operations_settlement_lifecycle_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0098_operations_label_execution.sql'
              ) AS operations_label_execution_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0101_operations_receiving_and_topology.sql'
              ) AS operations_receiving_topology_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0102_pos_payment_exceptions.sql'
              ) AS pos_payment_exceptions_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0103_pipeline_crm_reference_quarantine.sql'
              ) AS crm_reference_quarantine_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0104_demo_managed_resource_guard.sql'
              ) AS demo_managed_resource_guard_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0105_quickbooks_pos_evidence_refresh.sql'
              ) AS quickbooks_pos_evidence_refresh_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0106_toast_location_closeout_hour.sql'
              ) AS toast_location_closeout_hour_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0107_operations_warehouse_operating_profile.sql'
              ) AS operations_warehouse_operating_profile_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0108_operations_slotting_and_replenishment.sql'
              ) AS operations_slotting_replenishment_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0109_operations_replenishment_execution.sql'
              ) AS operations_replenishment_execution_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0110_operations_carrier_account_sender_name.sql'
              ) AS operations_carrier_account_sender_name_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0111_operations_commerce_integrations.sql'
              ) AS operations_commerce_integrations_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0112_operations_faire_oauth.sql'
              ) AS operations_faire_oauth_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0113_operations_shopify_order_preview.sql'
              ) AS operations_shopify_order_preview_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0114_operations_commerce_normalization.sql'
              ) AS operations_commerce_normalization_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0115_operations_commerce_intake_continuations.sql'
              ) AS operations_commerce_continuations_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0251_operations_commerce_order_attention_kinds.sql'
              ) AS operations_commerce_order_attention_kinds_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0116_operations_carrier_rate_test_labels.sql'
              ) AS operations_carrier_rate_test_labels_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0117_operations_print_agent_capabilities.sql'
              ) AS operations_print_agent_capabilities_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0118_operations_carrier_label_output_artifacts.sql'
              ) AS operations_carrier_label_artifacts_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0119_operations_commerce_product_intake_policy.sql'
              ) AS operations_commerce_product_policy_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0120_operations_commerce_catalog_sync.sql'
              ) AS operations_commerce_catalog_sync_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0121_operations_package_contents.sql'
              ) AS operations_package_contents_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0122_operations_commerce_incomplete_header_money.sql'
              ) AS operations_commerce_incomplete_header_money_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0123_operations_packaging_materials.sql'
              ) AS operations_packaging_materials_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0279_operations_packaging_material_lifecycle.sql'
              ) AS operations_packaging_material_lifecycle_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0124_operations_shopify_inventory.sql'
              ) AS operations_shopify_inventory_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0125_measurement_preferences.sql'
              ) AS measurement_preferences_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0126_packaging_material_unit_neutral_names.sql'
              ) AS packaging_material_unit_neutral_names_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0127_workspace_currency_preference.sql'
              ) AS workspace_currency_preference_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0128_operations_pack_hierarchy.sql'
              ) AS operations_pack_hierarchy_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0129_crm_data_transfers.sql'
              ) AS crm_data_transfers_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0130_operations_product_channel_states.sql'
              ) AS operations_product_channel_states_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0131_crm_product_identity_aliases.sql'
              ) AS crm_product_identity_aliases_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0132_operations_product_channel_offers.sql'
              ) AS operations_product_channel_offers_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0133_operations_pack_runtime_association.sql'
              ) AS operations_pack_runtime_association_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0134_operations_commerce_pack_resolution.sql'
              ) AS operations_commerce_pack_resolution_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0135_operations_hybrid_cartonization_recipes.sql'
              ) AS operations_hybrid_cartonization_recipes_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0136_operations_cartonization_package_rates.sql'
              ) AS operations_cartonization_package_rates_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0137_operations_cartonization_rate_evidence.sql'
              ) AS operations_cartonization_rate_evidence_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0138_operations_cartonization_rate_evidence_integrity.sql'
              ) AS operations_cartonization_rate_evidence_integrity_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0139_operations_fulfilled_line_price_state.sql'
              ) AS operations_fulfilled_line_price_state_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0140_operations_commerce_packaging_source_constraint.sql'
              ) AS operations_commerce_packaging_source_repair_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0141_operations_recipe_only_pack_associations.sql'
              ) AS operations_recipe_pack_association_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0142_operations_cartonization_evidence_scale.sql'
              ) AS operations_cartonization_evidence_scale_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0143_operations_cartonization_shipment_rates.sql'
              ) AS operations_cartonization_shipment_rates_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0258_operations_one_off_shipments.sql'
              ) AS operations_one_off_shipments_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0259_operations_cartonization_enabled_carriers.sql'
              ) AS operations_cartonization_enabled_carriers_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0144_operations_cartonization_shipment_rate_constraint_repair.sql'
              ) AS operations_cartonization_rate_constraint_repair_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0145_operations_two_pass_pack_rate_runs.sql'
              ) AS operations_two_pass_pack_rate_runs_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0146_operations_pack_rate_pricing_semantics.sql'
              ) AS operations_pack_rate_pricing_semantics_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0147_operations_carrier_billing_mud.sql'
              ) AS operations_carrier_billing_mud_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0169_operations_shopify_inventory_refresh_queue.sql'
              ) AS operations_shopify_inventory_refresh_migration_applied,
              (
                ${OPERATIONS_SHOPIFY_LOCATION_ROUTING_HEALTH_SQL}
              ) AS operations_shopify_location_routing_applied,
              (
                ${OPERATIONS_SHOPIFY_LOCATION_ADMINISTRATION_HEALTH_SQL}
              ) AS operations_shopify_location_administration_applied,
              (
                ${OPERATIONS_SHADOW_TRAINING_HEALTH_SQL}
              ) AS operations_shadow_training_applied,
              (
                ${OPERATIONS_ORDER_REPLANNING_CORRECTIONS_HEALTH_SQL}
              ) AS operations_order_replanning_corrections_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0190_operations_shopify_inventory_webhook_refresh.sql'
              ) AS operations_shopify_inventory_webhook_refresh_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0197_operations_shopify_catalog_webhook_refresh.sql'
              ) AS operations_shopify_catalog_webhook_refresh_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0191_operations_commerce_pack_evidence_fingerprint.sql'
              ) AS operations_commerce_pack_evidence_fingerprint_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0192_operations_shadow_fulfillment_destination_fingerprint.sql'
              ) AS operations_shadow_fulfillment_destination_repair_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0193_operations_shadow_rate_choice_package_identity.sql'
              ) AS operations_shadow_rate_choice_package_identity_repair_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0194_operations_fulfillment_execution_union_repair.sql'
              ) AS operations_fulfillment_execution_union_repair_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0195_operations_fulfillment_rate_parcel_evidence.sql'
              ) AS operations_fulfillment_rate_parcel_repair_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0170_operations_shopify_checkout_plan_rate_policy.sql'
              ) AS operations_shopify_checkout_plan_rate_policy_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0171_shopify_active_account_readiness.sql'
              ) AS shopify_active_account_readiness_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0172_operations_commerce_inventory_attempt_lease_renewal.sql'
              ) AS operations_commerce_inventory_attempt_lease_renewal_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0173_operations_shopify_shipping_service_codes.sql'
              ) AS operations_shopify_shipping_service_codes_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0174_operations_shopify_checkout_provider_attempts.sql'
              ) AS operations_shopify_checkout_provider_attempts_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0175_operations_shopify_checkout_rate_warm_policy.sql'
              ) AS operations_shopify_checkout_rate_warm_policy_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0176_operations_canonical_fulfillment_planning.sql'
              ) AS operations_canonical_fulfillment_planning_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0177_operations_fulfillment_executions.sql'
              ) AS operations_fulfillment_executions_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0178_operations_shopify_customer_rate_policies.sql'
              ) AS operations_shopify_customer_rate_policies_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0179_operations_active_multi_package_execution.sql'
              ) AS operations_active_multi_package_execution_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0180_operations_production_fulfillment_rerates.sql'
              ) AS operations_production_fulfillment_rerates_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0181_operations_shopify_shadow_policy_lifetime.sql'
              ) AS operations_shopify_shadow_policy_lifetime_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0188_operations_shopify_shadow_test_subsidy.sql'
              ) AS operations_shopify_shadow_test_subsidy_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0189_operations_shopify_checkout_quote_match_families.sql'
              ) AS operations_shopify_quote_match_families_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0198_operations_sandbox_commerce_e2e_authorization.sql'
              ) AS operations_sandbox_commerce_e2e_authorization_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0199_operations_commerce_active_canonical_collation.sql'
              ) AS operations_commerce_active_canonical_collation_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0200_operations_sandbox_commerce_e2e_active_guards.sql'
              ) AS operations_sandbox_commerce_e2e_active_guards_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0201_operations_fulfillment_notification_policy.sql'
              ) AS operations_fulfillment_notification_policy_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0218_global_id_alphanumeric_expand_141_149_and_catalog_gate.sql'
              ) AS global_id_alphanumeric_compatibility_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0219_global_id_base32hex_allocator.sql'
              ) AND EXISTS (
                SELECT 1
                FROM pg_proc procedure
                JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
                WHERE namespace.nspname = current_schema()
                  AND procedure.proname = 'allocate_global_reference'
                  AND pg_get_function_identity_arguments(procedure.oid) =
                    'requested_prefix text'
                  AND position(
                    'gen_random_bytes(12)'
                    IN pg_get_functiondef(procedure.oid)
                  ) > 0
                  AND position(
                    '0123456789abcdefghijklmnopqrstuv'
                    IN pg_get_functiondef(procedure.oid)
                  ) > 0
                  AND position(
                    'FOR attempt IN 1..32 LOOP'
                    IN pg_get_functiondef(procedure.oid)
                  ) > 0
                  AND position(
                    '1000000 + floor(random() * 9000000)'
                    IN pg_get_functiondef(procedure.oid)
                  ) = 0
              ) AND EXISTS (
                SELECT 1
                FROM pg_index index_row
                WHERE index_row.indexrelid = to_regclass(
                    'crm_reference_registry_base32hex_suffix_unique_idx'
                  )
                  AND index_row.indisunique
                  AND index_row.indisvalid
                  AND index_row.indisready
                  AND position(
                    'global_reference_suffix'
                    IN pg_get_indexdef(index_row.indexrelid)
                  ) > 0
                  AND position(
                    '= 12'
                    IN pg_get_indexdef(index_row.indexrelid)
                  ) > 0
              ) AS global_id_base32hex_allocator_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0220_operations_faire_provider_write_authorizations.sql'
              )
              AND EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0228_operations_faire_oauth_grant_evidence.sql'
              )
              AND to_regclass(
                'operations_faire_provider_write_scope_evidence'
              ) IS NOT NULL
              AND to_regclass(
                'operations_faire_provider_write_authorizations'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_faire_write_scope_list_valid(text[])'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_faire_write_capability_list_valid(text[])'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_faire_provider_write_canonical_jsonb(jsonb)'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_faire_provider_write_request_hash(jsonb)'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_faire_provider_write_json_is_redacted(jsonb)'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_faire_oauth_scope_list_valid(text[])'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_faire_oauth_scope_json_valid(jsonb)'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_proc procedure
                JOIN pg_namespace namespace
                  ON namespace.oid = procedure.pronamespace
                WHERE namespace.nspname = current_schema()
                  AND procedure.oid = to_regprocedure(
                    'operations_faire_provider_write_scope_evidence_is_current(uuid,uuid,uuid,integer)'
                  )::oid
                  AND encode(
                    digest(
                      convert_to(
                        btrim(
                          regexp_replace(
                            regexp_replace(
                              procedure.prosrc,
                              E'(^|[\\n\\r])[[:blank:]]*--[^\\n\\r]*',
                              ' ',
                              'g'
                            ),
                            '[[:space:]]+',
                            ' ',
                            'g'
                          )
                        ),
                        'UTF8'
                      ),
                      'sha256'
                    ),
                    'hex'
                  ) = '${FAIRE_SCOPE_CURRENT_PROSRC_SHA256}'
              )
              AND to_regprocedure(
                'operations_faire_provider_write_fence_hash(uuid,uuid,uuid,text,integer,integer,text,text,text,bigint,text,text,text,text[],text[],text)'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_proc procedure
                JOIN pg_namespace namespace
                  ON namespace.oid = procedure.pronamespace
                WHERE namespace.nspname = current_schema()
                  AND procedure.oid = to_regprocedure(
                    'protect_operations_faire_scope_evidence()'
                  )::oid
                  AND encode(
                    digest(
                      convert_to(
                        btrim(
                          regexp_replace(
                            regexp_replace(
                              procedure.prosrc,
                              E'(^|[\\n\\r])[[:blank:]]*--[^\\n\\r]*',
                              ' ',
                              'g'
                            ),
                            '[[:space:]]+',
                            ' ',
                            'g'
                          )
                        ),
                        'UTF8'
                      ),
                      'sha256'
                    ),
                    'hex'
                  ) = '${FAIRE_SCOPE_TRIGGER_PROSRC_SHA256}'
              )
              AND to_regprocedure(
                'protect_operations_faire_write_authorization()'
              ) IS NOT NULL
              AND position(
                'NOT NEW.verified_write_scopes <@ evidence_scopes'
                IN pg_get_functiondef(
                  to_regprocedure(
                    'protect_operations_faire_write_authorization()'
                  )::oid
                )
              ) > 0
              AND to_regprocedure(
                'validate_operations_faire_scope_evidence_insert()'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_faire_provider_write_authority_is_current(uuid,uuid,uuid,text,integer,integer,text,text,text,bigint,text,text,text,jsonb,uuid)'
              ) IS NOT NULL
              AND position(
                'evidence.verified_write_scopes @> auth.verified_write_scopes'
                IN pg_get_functiondef(
                  to_regprocedure(
                    'operations_faire_provider_write_authority_is_current(uuid,uuid,uuid,text,integer,integer,text,text,text,bigint,text,text,text,jsonb,uuid)'
                  )::oid
                )
              ) > 0
              AND to_regprocedure(
                'protect_operations_commerce_external_effect_intent()'
              ) IS NOT NULL
              AND position(
                'operations_faire_provider_write_authority_is_current'
                IN pg_get_functiondef(
                  to_regprocedure(
                    'protect_operations_commerce_external_effect_intent()'
                  )::oid
                )
              ) > 0
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trg
                WHERE trg.tgrelid = to_regclass(
                    'operations_faire_provider_write_scope_evidence'
                  )
                  AND trg.tgname =
                    'protect_operations_faire_scope_evidence_write'
                  AND trg.tgfoid = to_regprocedure(
                    'protect_operations_faire_scope_evidence()'
                  )::oid
                  AND trg.tgenabled = 'O'
                  AND trg.tgtype = 31
                  AND NOT trg.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trg
                WHERE trg.tgrelid = to_regclass(
                    'operations_faire_provider_write_scope_evidence'
                  )
                  AND trg.tgname =
                    'validate_operations_faire_scope_evidence_insert_write'
                  AND trg.tgfoid = to_regprocedure(
                    'validate_operations_faire_scope_evidence_insert()'
                  )::oid
                  AND trg.tgenabled = 'O'
                  AND trg.tgtype = 5
                  AND NOT trg.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trg
                WHERE trg.tgrelid = to_regclass(
                    'operations_commerce_external_effect_intents'
                  )
                  AND trg.tgname =
                    'protect_operations_commerce_external_effect_intent_write'
                  AND trg.tgfoid = to_regprocedure(
                    'protect_operations_commerce_external_effect_intent()'
                  )::oid
                  AND trg.tgenabled <> 'D'
                  AND NOT trg.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trg
                WHERE trg.tgrelid = to_regclass(
                    'operations_faire_provider_write_authorizations'
                  )
                  AND trg.tgname =
                    'protect_operations_faire_write_authorization_write'
                  AND trg.tgfoid = to_regprocedure(
                    'protect_operations_faire_write_authorization()'
                  )::oid
                  AND trg.tgenabled <> 'D'
                  AND NOT trg.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_index idx
                WHERE idx.indexrelid = to_regclass(
                    'operations_faire_write_auth_active_aggregate_idx'
                  )
                  AND idx.indisunique
                  AND idx.indisvalid
                  AND idx.indisready
              )
              AND EXISTS (
                SELECT 1
                FROM pg_index idx
                WHERE idx.indexrelid = to_regclass(
                    'operations_faire_write_auth_effect_tombstone_idx'
                  )
                  AND idx.indrelid = to_regclass(
                    'operations_faire_provider_write_authorizations'
                  )
                  AND idx.indisunique
                  AND idx.indisvalid
                  AND idx.indisready
                  AND idx.indpred IS NULL
                  AND idx.indexprs IS NULL
                  AND idx.indnkeyatts = 6
                  AND idx.indnatts = 6
                  AND ARRAY(
                    SELECT attribute.attname::text
                    FROM unnest(idx.indkey) WITH ORDINALITY
                      key_column(attnum, ordinality)
                    JOIN pg_attribute attribute
                      ON attribute.attrelid = idx.indrelid
                     AND attribute.attnum = key_column.attnum
                    ORDER BY key_column.ordinality
                  ) = ARRAY[
                    'organization_id',
                    'integration_account_id',
                    'action',
                    'aggregate_type',
                    'aggregate_id',
                    'aggregate_revision'
                  ]::text[]
              )
              AND EXISTS (
                SELECT 1
                FROM pg_index idx
                WHERE idx.indexrelid = to_regclass(
                    'operations_commerce_effect_faire_auth_unique'
                  )
                  AND idx.indisunique
                  AND idx.indisvalid
                  AND idx.indisready
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint fk
                WHERE fk.conrelid = to_regclass(
                    'operations_faire_provider_write_scope_evidence'
                  )
                  AND fk.confrelid = to_regclass(
                    'operations_commerce_provider_attempts'
                  )
                  AND fk.conname =
                    'operations_faire_scope_evidence_attempt_fkey'
                  AND fk.contype = 'f'
                  AND fk.convalidated
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint fk
                WHERE fk.conrelid = to_regclass(
                    'operations_faire_provider_write_authorizations'
                  )
                  AND fk.confrelid = to_regclass(
                    'operations_faire_provider_write_scope_evidence'
                  )
                  AND fk.conname =
                    'operations_faire_write_auth_scope_evidence_fkey'
                  AND fk.contype = 'f'
                  AND fk.convalidated
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint fk
                WHERE fk.conrelid = to_regclass(
                    'operations_faire_provider_write_authorizations'
                  )
                  AND fk.confrelid = to_regclass(
                    'operations_commerce_provider_attempts'
                  )
                  AND fk.conname =
                    'operations_faire_write_auth_attempt_fkey'
                  AND fk.contype = 'f'
                  AND fk.convalidated
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint fk
                WHERE fk.conrelid = to_regclass(
                    'operations_commerce_external_effect_intents'
                  )
                  AND fk.confrelid = to_regclass(
                    'operations_faire_provider_write_authorizations'
                  )
                  AND fk.conname =
                    'operations_commerce_effect_faire_auth_fkey'
                  AND fk.contype = 'f'
                  AND fk.convalidated
              ) AS faire_provider_write_auth_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0224_operations_faire_fulfillment_authority.sql'
              )
              AND to_regprocedure(
                'operations_faire_fulfillment_scope_evidence_is_current(uuid,uuid,integer)'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_commerce_active_cohort_matches_current(uuid,jsonb,text,integer,text)'
              ) IS NOT NULL
                AS faire_fulfillment_authority_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0229_operations_commerce_fulfillment_recovery.sql'
              )
              AND EXISTS (
                SELECT 1
                FROM pg_index idx
                WHERE idx.indexrelid = to_regclass(
                    'operations_commerce_fulfillment_exports_recovery_idx'
                  )
                  AND idx.indrelid = to_regclass(
                    'operations_commerce_fulfillment_exports'
                  )
                  AND idx.indisvalid
                  AND idx.indisready
                  AND idx.indpred IS NOT NULL
              ) AS operations_commerce_fulfillment_recovery_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0221_operations_commerce_product_image_imports.sql'
              )
              AND to_regclass(
                'operations_commerce_product_image_snapshot_fences'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_product_image_observation_sets'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_product_image_observations'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_product_image_observation_set_memberships'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_product_image_import_jobs'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_product_image_import_worker_heartbeat'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_product_image_asset_provenance'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_product_image_bindings'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_commerce_product_image_account_is_current(uuid,uuid,text,integer)'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_commerce_product_image_mapping_resolution(uuid,uuid,text,text)'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_commerce_product_image_observation_is_current_active(uuid,uuid)'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_commerce_product_image_job_fences_are_current(uuid,uuid)'
              ) IS NOT NULL
              AND to_regprocedure(
                'guard_operations_commerce_product_image_observation_set_membership()'
              ) IS NOT NULL
              AND to_regprocedure(
                'validate_ops_commerce_image_set_evidence(uuid,uuid,uuid)'
              ) IS NOT NULL
              AND to_regprocedure(
                'validate_ops_commerce_image_set_row()'
              ) IS NOT NULL
              AND to_regprocedure(
                'validate_ops_commerce_image_member_row()'
              ) IS NOT NULL
              AND to_regprocedure(
                'guard_operations_commerce_product_image_binding()'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_attribute attribute
                WHERE attribute.attrelid = to_regclass(
                    'operations_commerce_product_image_observations'
                  )
                  AND attribute.attname = 'observation_set_id'
                  AND attribute.attnotnull
                  AND NOT attribute.attisdropped
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint fk
                WHERE fk.conrelid = to_regclass(
                    'operations_commerce_product_image_observations'
                  )
                  AND fk.confrelid = to_regclass(
                    'operations_commerce_product_image_observation_sets'
                  )
                  AND fk.conname =
                    'ops_commerce_image_observation_set_fkey'
                  AND fk.contype = 'f'
                  AND fk.convalidated
                  AND fk.confdeltype = 'r'
                  AND ARRAY(
                    SELECT attribute.attname::text
                    FROM unnest(fk.conkey) WITH ORDINALITY
                      key_column(attnum, ordinality)
                    JOIN pg_attribute attribute
                      ON attribute.attrelid = fk.conrelid
                     AND attribute.attnum = key_column.attnum
                    ORDER BY key_column.ordinality
                  ) = ARRAY[
                    'organization_id',
                    'integration_account_id',
                    'provider',
                    'credential_generation',
                    'external_product_id',
                    'observation_set_id'
                  ]::text[]
                  AND ARRAY(
                    SELECT attribute.attname::text
                    FROM unnest(fk.confkey) WITH ORDINALITY
                      key_column(attnum, ordinality)
                    JOIN pg_attribute attribute
                      ON attribute.attrelid = fk.confrelid
                     AND attribute.attnum = key_column.attnum
                    ORDER BY key_column.ordinality
                  ) = ARRAY[
                    'organization_id',
                    'integration_account_id',
                    'provider',
                    'credential_generation',
                    'external_product_id',
                    'id'
                  ]::text[]
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_snapshot_fences'
                  )
                  AND trigger_row.tgname =
                    'guard_operations_commerce_product_image_snapshot_fence_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_operations_commerce_product_image_snapshot_fence()'
                  )::oid
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 31
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_observation_set_memberships'
                  )
                  AND trigger_row.tgname =
                    'guard_operations_commerce_product_image_set_member_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_operations_commerce_product_image_observation_set_membership()'
                  )::oid
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 31
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_observation_sets'
                  )
                  AND trigger_row.tgname =
                    'validate_operations_commerce_image_set_membership'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'validate_ops_commerce_image_set_row()'
                  )::oid
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 5
                  AND trigger_row.tgdeferrable
                  AND trigger_row.tginitdeferred
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_observation_set_memberships'
                  )
                  AND trigger_row.tgname =
                    'validate_operations_commerce_image_set_member_insert'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'validate_ops_commerce_image_member_row()'
                  )::oid
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 5
                  AND trigger_row.tgdeferrable
                  AND trigger_row.tginitdeferred
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_observation_sets'
                  )
                  AND trigger_row.tgname =
                    'guard_operations_commerce_product_image_observation_set_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_operations_commerce_product_image_observation_set()'
                  )::oid
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 31
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_observations'
                  )
                  AND trigger_row.tgname =
                    'guard_operations_commerce_product_image_observation_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_operations_commerce_product_image_observation()'
                  )::oid
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 31
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_import_jobs'
                  )
                  AND trigger_row.tgname =
                    'guard_operations_commerce_product_image_import_job_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_operations_commerce_product_image_import_job()'
                  )::oid
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 31
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_asset_provenance'
                  )
                  AND trigger_row.tgname =
                    'guard_operations_commerce_product_image_provenance_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_operations_commerce_product_image_asset_provenance()'
                  )::oid
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 31
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_bindings'
                  )
                  AND trigger_row.tgname =
                    'guard_operations_commerce_product_image_binding_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_operations_commerce_product_image_binding()'
                  )::oid
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 31
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'operations_commerce_product_image_import_jobs'
                  )
                  AND constraint_row.conname =
                    'ops_commerce_image_job_observation_generation_unique'
                  AND constraint_row.contype = 'u'
                  AND constraint_row.convalidated
              )
              AND EXISTS (
                SELECT 1
                FROM pg_index index_row
                WHERE index_row.indexrelid = to_regclass(
                    'ops_commerce_image_job_single_flight_idx'
                  )
                  AND index_row.indisunique
                  AND index_row.indisvalid
                  AND index_row.indisready
              ) AS operations_commerce_product_image_imports_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0225_operations_commerce_product_image_exact_fanout.sql'
              )
              AND to_regprocedure(
                'operations_commerce_product_image_mapping_targets(uuid,uuid,text,text)'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'operations_commerce_product_image_asset_provenance'
                  )
                  AND constraint_row.conname =
                    'ops_commerce_image_provenance_job_product_unique'
                  AND constraint_row.contype = 'u'
                  AND constraint_row.convalidated
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'operations_commerce_product_image_bindings'
                  )
                  AND constraint_row.conname =
                    'ops_commerce_image_binding_exact_product_unique'
                  AND constraint_row.contype = 'u'
                  AND constraint_row.convalidated
              ) AS operations_commerce_product_image_fanout_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0227_operations_commerce_product_image_source_normalization.sql'
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'operations_commerce_product_image_asset_provenance'
                  )
                  AND constraint_row.conname =
                    'ops_commerce_image_provenance_source_evidence_valid'
                  AND constraint_row.contype = 'c'
                  AND constraint_row.convalidated
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_asset_provenance'
                  )
                  AND trigger_row.tgname =
                    'guard_operations_commerce_product_image_source_evidence_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_operations_commerce_product_image_source_evidence()'
                  )
                  AND trigger_row.tgtype = 31
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_commerce_product_image_asset_provenance'
                  )
                  AND trigger_row.tgname =
                    'guard_operations_commerce_product_image_provenance_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_operations_commerce_product_image_asset_provenance()'
                  )
                  AND trigger_row.tgtype = 31
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              ) AS operations_commerce_product_image_source_normalization_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0230_operations_faire_product_image_projection.sql'
              )
              AND EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0234_operations_faire_product_image_writable_lifecycle.sql'
              )
              AND to_regclass(
                'operations_faire_product_image_delivery_grants'
              ) IS NOT NULL
              AND to_regclass(
                'operations_faire_product_image_provider_steps'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_faire_provider_write_authority_is_current(uuid,uuid,uuid,text,integer,integer,text,text,text,bigint,text,text,text,jsonb,uuid)'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_operations_faire_product_image_grant()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_operations_faire_product_image_authority()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_operations_faire_product_image_step()'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_faire_product_image_delivery_grants'
                  )
                  AND trigger_row.tgname =
                    'protect_operations_faire_product_image_grant_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'protect_operations_faire_product_image_grant()'
                  )
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_faire_provider_write_authorizations'
                  )
                  AND trigger_row.tgname =
                    'protect_operations_faire_product_image_authority_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'protect_operations_faire_product_image_authority()'
                  )
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_faire_product_image_provider_steps'
                  )
                  AND trigger_row.tgname =
                    'protect_operations_faire_product_image_step_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'protect_operations_faire_product_image_step()'
                  )
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'operations_faire_provider_write_authorizations'
                  )
                  AND constraint_row.conname =
                    'operations_faire_write_auth_image_grant_fkey'
                  AND constraint_row.contype = 'f'
                  AND constraint_row.convalidated
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'operations_faire_provider_write_authorizations'
                  )
                  AND constraint_row.conname =
                    'operations_faire_write_auth_shadow_effect_fkey'
                  AND constraint_row.contype = 'f'
                  AND constraint_row.convalidated
              ) AS operations_faire_product_image_projection_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0231_operations_faire_sandbox_commerce_e2e.sql'
              )
              AND EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0232_operations_faire_sandbox_parcel_evidence.sql'
              )
              AND EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0233_operations_faire_sandbox_promotion_evidence.sql'
              )
              AND to_regclass(
                'operations_sandbox_commerce_e2e_faire_evidence'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM information_schema.columns column_row
                WHERE column_row.table_schema = 'public'
                  AND column_row.table_name =
                    'operations_sandbox_commerce_e2e_faire_evidence'
                  AND column_row.column_name =
                    'item_pack_evidence_hash'
                  AND column_row.is_nullable = 'NO'
              )
              AND EXISTS (
                SELECT 1
                FROM information_schema.columns column_row
                WHERE column_row.table_schema = 'public'
                  AND column_row.table_name =
                    'operations_sandbox_commerce_e2e_faire_evidence'
                  AND column_row.column_name =
                    'parcel_gross_weight_grams'
                  AND column_row.is_nullable = 'NO'
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'operations_sandbox_commerce_e2e_faire_evidence'
                  )
                  AND constraint_row.conname =
                    'operations_sandbox_commerce_e2e_faire_evidence_carton_package_fkey'
                  AND constraint_row.contype = 'f'
                  AND constraint_row.convalidated
              )
              AND to_regprocedure(
                'operations_sandbox_commerce_e2e_authorization_is_current(uuid,uuid,uuid)'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_sandbox_commerce_e2e_faire_evidence()'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_sandbox_commerce_e2e_faire_evidence'
                  )
                  AND trigger_row.tgname =
                    'protect_sandbox_commerce_e2e_faire_evidence_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'protect_sandbox_commerce_e2e_faire_evidence()'
                  )
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              ) AS operations_faire_sandbox_commerce_e2e_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0223_operations_faire_inventory_observation_polling.sql'
              )
              AND to_regclass(
                'operations_faire_inventory_poll_jobs'
              ) IS NOT NULL
              AND to_regclass(
                'operations_faire_inventory_observations'
              ) IS NOT NULL
              AND to_regclass(
                'idx_operations_faire_inventory_poll_active_account'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'operations_faire_inventory_observations'
                  )
                  AND trigger_row.tgname =
                    'protect_operations_faire_inventory_observation'
                  AND NOT trigger_row.tgisinternal
              ) AS operations_faire_inventory_polling_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0226_suitecrm_product_image_reverse_ingestion.sql'
              )
              AND to_regclass(
                'crm_suitecrm_product_image_observations'
              ) IS NOT NULL
              AND to_regclass(
                'crm_suitecrm_product_image_snapshot_fences'
              ) IS NOT NULL
              AND to_regclass(
                'crm_suitecrm_product_image_asset_provenance'
              ) IS NOT NULL
              AND to_regclass(
                'crm_suitecrm_product_image_ingestion_worker_heartbeat'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'crm_suitecrm_product_image_observations'
                  )
                  AND trigger_row.tgname =
                    'guard_crm_suitecrm_product_image_observation_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_crm_suitecrm_product_image_observation()'
                  )
                  AND trigger_row.tgtype = 31
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'crm_suitecrm_product_image_asset_provenance'
                  )
                  AND trigger_row.tgname =
                    'guard_crm_suitecrm_product_image_provenance_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_crm_suitecrm_product_image_provenance()'
                  )
                  AND trigger_row.tgtype = 31
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'crm_suitecrm_product_image_snapshot_fences'
                  )
                  AND trigger_row.tgname =
                    'guard_crm_suitecrm_product_image_snapshot_fence_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_crm_suitecrm_product_image_snapshot_fence()'
                  )
                  AND trigger_row.tgtype = 31
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass(
                    'crm_suitecrm_product_image_snapshot_fences'
                  )
                  AND trigger_row.tgname =
                    'guard_crm_suitecrm_image_fence_initial_revision_write'
                  AND trigger_row.tgfoid = to_regprocedure(
                    'guard_crm_suitecrm_image_fence_initial_revision()'
                  )
                  AND trigger_row.tgtype = 5
                  AND trigger_row.tgenabled = 'O'
                  AND NOT trigger_row.tgisinternal
              )
              AND (
                SELECT count(*) = 5
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'crm_suitecrm_product_image_observations'
                  )
                  AND constraint_row.conname IN (
                    'crm_suitecrm_product_image_observation_provider_writes_zero',
                    'crm_suitecrm_product_image_observation_correlation_valid',
                    'crm_suitecrm_product_image_observation_media_valid',
                    'crm_suitecrm_product_image_observation_primary_valid',
                    'crm_suitecrm_product_image_observation_timestamp_valid'
                  )
                  AND constraint_row.convalidated
              )
              AND (
                SELECT count(*) = 5
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'crm_suitecrm_product_image_asset_provenance'
                  )
                  AND constraint_row.conname IN (
                    'crm_suitecrm_product_image_provenance_provider_writes_zero',
                    'crm_suitecrm_product_image_provenance_scope_valid',
                    'crm_suitecrm_product_image_provenance_primary_before_valid',
                    'crm_suitecrm_product_image_provenance_result_valid',
                    'crm_suitecrm_product_image_provenance_resolution_valid'
                  )
                  AND constraint_row.convalidated
              )
              AND EXISTS (
                SELECT 1
                FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = to_regclass(
                    'crm_suitecrm_product_image_snapshot_fences'
                  )
                  AND constraint_row.conname =
                    'crm_suitecrm_product_image_snapshot_fence_provenance_fkey'
                  AND constraint_row.contype = 'f'
                  AND constraint_row.convalidated
              ) AS suitecrm_product_image_reverse_ingestion_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0273_operations_commerce_order_revisions.sql'
              )
              AND to_regclass(
                'operations_commerce_order_revision_targets'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_order_revision_observations'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_order_revision_dispositions'
              ) IS NOT NULL
                AS operations_commerce_order_revisions_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0274_operations_commerce_order_revision_apply.sql'
              )
              AND to_regclass(
                'operations_commerce_order_revision_reads'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_order_revision_applications'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_order_revision_application_lines'
              ) IS NOT NULL
                AS operations_commerce_order_revision_apply_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0275_operations_one_off_carrier_selection.sql'
              )
              AND EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'operations_one_off_shipment_quotes'
                  AND column_name = 'carrier_selection_schema_version'
              )
              AND EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'operations_one_off_shipment_quotes'
                  AND column_name = 'required_carrier_selections'
              )
                AS operations_one_off_carrier_selection_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0276_operations_commerce_order_sync_foundation.sql'
              )
              AND to_regclass(
                'operations_commerce_order_sync_policies'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_order_backfill_sessions'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_order_observations'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_order_observation_lines'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_order_event_observations'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_commerce_order_sync_session_lineage()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_credentialed_commerce_account_identity()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_commerce_order_sync_session_mutation()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_commerce_order_observation_lineage()'
              ) IS NOT NULL
              AND to_regprocedure(
                'commerce_order_observation_accepts_children(uuid,uuid)'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_commerce_order_observation_line_lineage()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_commerce_order_event_lineage()'
              ) IS NOT NULL
              AND to_regprocedure(
                'reject_commerce_order_sync_evidence_mutation()'
              ) IS NOT NULL
              AND to_regprocedure(
                'redact_expired_commerce_order_sensitive_evidence(integer)'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM (
                  VALUES
                    (
                      'operations_integration_accounts',
                      'credentialed_commerce_account_identity_guard',
                      'protect_credentialed_commerce_account_identity()'
                    ),
                    (
                      'operations_commerce_order_backfill_sessions',
                      'commerce_order_sync_session_lineage_guard',
                      'protect_commerce_order_sync_session_lineage()'
                    ),
                    (
                      'operations_commerce_order_backfill_sessions',
                      'commerce_order_sync_session_mutation_guard',
                      'protect_commerce_order_sync_session_mutation()'
                    ),
                    (
                      'operations_commerce_order_observations',
                      'commerce_order_observations_lineage_guard',
                      'protect_commerce_order_observation_lineage()'
                    ),
                    (
                      'operations_commerce_order_observation_lines',
                      'commerce_order_observation_lines_lineage_guard',
                      'protect_commerce_order_observation_line_lineage()'
                    ),
                    (
                      'operations_commerce_order_event_observations',
                      'commerce_order_event_observations_lineage_guard',
                      'protect_commerce_order_event_lineage()'
                    ),
                    (
                      'operations_commerce_order_observations',
                      'commerce_order_observations_immutable',
                      'reject_commerce_order_sync_evidence_mutation()'
                    ),
                    (
                      'operations_commerce_order_observation_lines',
                      'commerce_order_observation_lines_immutable',
                      'reject_commerce_order_sync_evidence_mutation()'
                    ),
                    (
                      'operations_commerce_order_event_observations',
                      'commerce_order_event_observations_immutable',
                      'reject_commerce_order_sync_evidence_mutation()'
                    )
                ) AS required_history_trigger(
                  table_name, trigger_name, function_signature
                )
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_trigger installed_history_trigger
                  WHERE installed_history_trigger.tgrelid =
                    to_regclass(required_history_trigger.table_name)
                    AND installed_history_trigger.tgname =
                      required_history_trigger.trigger_name
                    AND installed_history_trigger.tgfoid = to_regprocedure(
                      required_history_trigger.function_signature
                    )
                    AND NOT installed_history_trigger.tgisinternal
                    AND installed_history_trigger.tgenabled IN ('O', 'A')
                )
              )
                AS operations_commerce_order_sync_foundation_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0277_operations_commerce_authority_policies.sql'
              )
              AND to_regclass(
                'operations_commerce_authority_policies'
              ) IS NOT NULL
              AND to_regclass(
                'operations_commerce_provider_write_scope_requests'
              ) IS NOT NULL
                AS operations_commerce_authority_policies_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0278_operations_shopify_order_webhook_signals.sql'
              )
              AND to_regclass(
                'operations_shopify_order_webhook_signals'
              ) IS NOT NULL
              AND to_regclass(
                'operations_shopify_order_webhook_targets'
              ) IS NOT NULL
              AND to_regclass(
                'operations_shopify_order_webhook_reads'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_shopify_order_webhook_signal()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_shopify_order_webhook_target()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_shopify_order_webhook_read()'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM (
                  VALUES
                    (
                      'operations_shopify_order_webhook_signals',
                      'protect_shopify_order_webhook_signal_write',
                      'protect_shopify_order_webhook_signal()'
                    ),
                    (
                      'operations_shopify_order_webhook_targets',
                      'protect_shopify_order_webhook_target_write',
                      'protect_shopify_order_webhook_target()'
                    ),
                    (
                      'operations_shopify_order_webhook_reads',
                      'protect_shopify_order_webhook_read_write',
                      'protect_shopify_order_webhook_read()'
                    )
                ) AS required_order_webhook_trigger(
                  table_name, trigger_name, function_signature
                )
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_trigger installed_order_webhook_trigger
                  WHERE installed_order_webhook_trigger.tgrelid =
                    to_regclass(required_order_webhook_trigger.table_name)
                    AND installed_order_webhook_trigger.tgname =
                      required_order_webhook_trigger.trigger_name
                    AND installed_order_webhook_trigger.tgfoid =
                      to_regprocedure(
                        required_order_webhook_trigger.function_signature
                      )
                    AND NOT installed_order_webhook_trigger.tgisinternal
                    AND installed_order_webhook_trigger.tgenabled IN ('O', 'A')
                )
              )
                AS operations_shopify_order_webhook_signals_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0283_operations_shopify_order_management.sql'
              )
              AND to_regclass(
                'operations_shopify_order_management_authorizations'
              ) IS NOT NULL
              AND to_regclass(
                'operations_shopify_order_management_attempts'
              ) IS NOT NULL
              AND to_regclass(
                'operations_shopify_order_management_outcomes'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_shopify_order_management_snapshot_updated_at(jsonb)'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_shopify_order_management_is_current(uuid,uuid,boolean)'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_shopify_order_management_authorization()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_shopify_order_management_attempt()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_shopify_order_management_outcome()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_shopify_order_management_downstream_race()'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM (
                  VALUES
                    (
                      'operations_shopify_order_management_authorizations',
                      'protect_shopify_order_management_authorization_write',
                      'protect_shopify_order_management_authorization()'
                    ),
                    (
                      'operations_shopify_order_management_attempts',
                      'protect_shopify_order_management_attempt_write',
                      'protect_shopify_order_management_attempt()'
                    ),
                    (
                      'operations_shopify_order_management_outcomes',
                      'protect_shopify_order_management_outcome_write',
                      'protect_shopify_order_management_outcome()'
                    ),
                    (
                      'operations_orders',
                      'protect_shopify_order_management_order_status_race',
                      'protect_shopify_order_management_downstream_race()'
                    ),
                    (
                      'operations_fulfillment_plans',
                      'protect_shopify_order_management_plan_race',
                      'protect_shopify_order_management_downstream_race()'
                    ),
                    (
                      'operations_reservations',
                      'protect_shopify_order_management_reservation_race',
                      'protect_shopify_order_management_downstream_race()'
                    ),
                    (
                      'operations_billable_events',
                      'protect_shopify_order_management_billable_event_race',
                      'protect_shopify_order_management_downstream_race()'
                    ),
                    (
                      'operations_sandbox_commerce_e2e_authorizations',
                      'block_shopify_order_management_sandbox_e2e_authorization_race',
                      'protect_shopify_order_management_downstream_race()'
                    )
                ) AS required_shopify_order_management_trigger(
                  table_name, trigger_name, function_signature
                )
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_trigger installed_shopify_order_management_trigger
                  WHERE installed_shopify_order_management_trigger.tgrelid =
                    to_regclass(
                      required_shopify_order_management_trigger.table_name
                    )
                    AND installed_shopify_order_management_trigger.tgname =
                      required_shopify_order_management_trigger.trigger_name
                    AND installed_shopify_order_management_trigger.tgfoid =
                      to_regprocedure(
                        required_shopify_order_management_trigger.function_signature
                      )
                    AND NOT
                      installed_shopify_order_management_trigger.tgisinternal
                    AND installed_shopify_order_management_trigger.tgenabled =
                      'O'
                )
              )
                AS operations_shopify_order_management_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0284_operations_print_device_reference_privacy.sql'
              )
              AND EXISTS (
                SELECT 1
                FROM pg_trigger print_delivery_guard
                WHERE print_delivery_guard.tgrelid =
                  to_regclass('operations_print_delivery_attempts')
                  AND print_delivery_guard.tgname =
                    'protect_operations_print_delivery_attempt_write'
                  AND print_delivery_guard.tgfoid =
                    to_regprocedure('protect_operations_append_only()')
                  AND NOT print_delivery_guard.tgisinternal
                  AND print_delivery_guard.tgenabled = 'O'
                  AND print_delivery_guard.tgtype = 27
              )
              AND to_regprocedure(
                'normalize_operations_print_delivery_device_reference()'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_trigger print_device_reference_guard
                WHERE print_device_reference_guard.tgrelid =
                  to_regclass('operations_print_delivery_attempts')
                  AND print_device_reference_guard.tgname =
                    'normalize_operations_print_delivery_device_reference_write'
                  AND print_device_reference_guard.tgfoid = to_regprocedure(
                    'normalize_operations_print_delivery_device_reference()'
                  )
                  AND NOT print_device_reference_guard.tgisinternal
                  AND print_device_reference_guard.tgenabled = 'O'
                  AND print_device_reference_guard.tgtype = 7
              ) AS operations_print_device_reference_privacy_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0287_operations_print_agent_pairing_grants.sql'
              )
              AND to_regclass(
                'operations_print_agent_pairing_grants'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_operations_print_agent_pairing_grant()'
              ) IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_trigger pairing_grant_guard
                WHERE pairing_grant_guard.tgrelid = to_regclass(
                  'operations_print_agent_pairing_grants'
                )
                  AND pairing_grant_guard.tgname =
                    'protect_operations_print_agent_pairing_grant_write'
                  AND pairing_grant_guard.tgfoid = to_regprocedure(
                    'protect_operations_print_agent_pairing_grant()'
                  )
                  AND NOT pairing_grant_guard.tgisinternal
                  AND pairing_grant_guard.tgenabled = 'O'
                  AND pairing_grant_guard.tgtype = 27
              ) AS operations_print_agent_pairing_grants_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0285_shopify_carrier_service_configured_carriers.sql'
              )
              AND EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0292_shopify_registered_rate_source_refresh.sql'
              )
              AND to_regprocedure(
                'operations_shopify_carrier_service_config_is_ready(uuid,uuid)'
              ) IS NOT NULL
              AND to_regprocedure(
                'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
              ) IS NOT NULL
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_shopify_carrier_service_config_child()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%TG_TABLE_NAME IN ( ''operations_shopify_carrier_service_config_materials'', ''operations_shopify_carrier_service_config_carriers'' )%'
              AND NOT EXISTS (
                SELECT 1
                FROM (VALUES
                  (
                    'operations_shopify_carrier_service_config_carriers',
                    'operations_shopify_carrier_service_config_carriers_pkey',
                    'PRIMARY KEY (organization_id, config_id, carrier_account_id)'
                  ),
                  (
                    'operations_shopify_checkout_rate_receipt_provider_attempts',
                    'operations_shopify_checkout_rate_receipt_provider_attempts_pkey',
                    'PRIMARY KEY (organization_id, receipt_id, carrier_account_id)'
                  ),
                  (
                    'operations_pack_rate_run_rate_choices',
                    'operations_pack_rate_run_rate_choices_pkey',
                    'PRIMARY KEY (organization_id, id)'
                  ),
                  (
                    'operations_fulfillment_execution_rate_attempts',
                    'operations_fulfillment_execution_rate_attempts_pkey',
                    'PRIMARY KEY (organization_id, execution_id, carrier_account_id)'
                  ),
                  (
                    'operations_pack_rate_runs',
                    'operations_pack_rate_runs_selected_carrier_account_fkey',
                    'FOREIGN KEY (organization_id, selected_carrier_account_id) REFERENCES operations_carrier_accounts(organization_id, id) ON DELETE RESTRICT'
                  ),
                  (
                    'operations_pack_rate_run_rate_choices',
                    'operations_pack_rate_run_rate_choices_account_fkey',
                    'FOREIGN KEY (organization_id, carrier_account_id) REFERENCES operations_carrier_accounts(organization_id, id) ON DELETE RESTRICT'
                  ),
                  (
                    'operations_shipment_groups',
                    'operations_shipment_groups_selected_carrier_account_fkey',
                    'FOREIGN KEY (organization_id, selected_carrier_account_id) REFERENCES operations_carrier_accounts(organization_id, id) ON DELETE RESTRICT'
                  ),
                  (
                    'operations_shipment_groups',
                    'operations_shipment_groups_run_account_fkey',
                    'FOREIGN KEY (organization_id, fulfillment_pack_rate_run_id, selected_carrier_account_id) REFERENCES operations_pack_rate_runs(organization_id, id, selected_carrier_account_id) ON DELETE RESTRICT'
                  ),
                  (
                    'operations_fulfillment_execution_rate_attempts',
                    'operations_fulfillment_rate_attempts_account_fkey',
                    'FOREIGN KEY (organization_id, carrier_account_id) REFERENCES operations_carrier_accounts(organization_id, id) ON DELETE RESTRICT'
                  )
                ) AS required_shopify_carrier_constraint(
                  table_name, constraint_name, definition
                )
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_constraint installed_constraint
                  WHERE installed_constraint.conrelid =
                    to_regclass(required_shopify_carrier_constraint.table_name)
                    AND installed_constraint.conname =
                      required_shopify_carrier_constraint.constraint_name
                    AND pg_get_constraintdef(installed_constraint.oid) =
                      required_shopify_carrier_constraint.definition
                )
              )
              AND EXISTS (
                SELECT 1
                FROM pg_class installed_index_class
                JOIN pg_index installed_index
                  ON installed_index.indexrelid = installed_index_class.oid
                WHERE installed_index_class.relname =
                  'operations_pack_rate_choices_account_service_unique'
                  AND installed_index.indrelid = to_regclass(
                    'operations_pack_rate_run_rate_choices'
                  )
                  AND installed_index.indisunique
                  AND ARRAY(
                    SELECT installed_column.attname
                    FROM unnest(installed_index.indkey::smallint[])
                      WITH ORDINALITY AS indexed_attribute(attnum, ordinal)
                    JOIN pg_attribute installed_column
                      ON installed_column.attrelid = installed_index.indrelid
                     AND installed_column.attnum = indexed_attribute.attnum
                    ORDER BY indexed_attribute.ordinal
                  ) = ARRAY[
                    'organization_id', 'run_id', 'carrier_account_id',
                    'provider', 'service_code'
                  ]::name[]
                  AND pg_get_expr(
                    installed_index.indpred,
                    installed_index.indrelid
                  ) = '(carrier_account_id IS NOT NULL)'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM (VALUES
                  ('operations_pack_rate_runs', 'selected_carrier_account_id'),
                  ('operations_pack_rate_run_rate_choices', 'carrier_account_id'),
                  ('operations_shipment_groups', 'selected_carrier_account_id'),
                  ('operations_fulfillment_execution_rate_attempts', 'carrier_account_id')
                ) AS required_shopify_carrier_column(table_name, column_name)
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_attribute installed_column
                  WHERE installed_column.attrelid =
                    to_regclass(required_shopify_carrier_column.table_name)
                    AND installed_column.attname =
                      required_shopify_carrier_column.column_name
                    AND installed_column.atttypid = 'uuid'::regtype
                    AND NOT installed_column.attisdropped
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM (VALUES
                  ('validate_operations_shopify_carrier_service_config_child()'),
                  ('derive_operations_legacy_pack_rate_run_account()'),
                  ('derive_operations_legacy_pack_rate_choice_account()'),
                  ('derive_operations_legacy_shipment_group_account()'),
                  ('validate_operations_pack_rate_choice_account()'),
                  ('validate_operations_shipment_group_account()'),
                  ('validate_operations_pack_rate_account_lineage_complete()'),
                  ('validate_operations_fulfillment_account_lineage_complete()'),
                  ('operations_shopify_carrier_configuration_allows_rating(jsonb,text)'),
                  ('operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'),
                  ('operations_shopify_carrier_service_config_is_ready(uuid,uuid)'),
                  ('operations_shopify_checkout_carrier_parcels_match(uuid,uuid,jsonb)'),
                  ('operations_shopify_checkout_carrier_selection_key(text,text)'),
                  ('operations_legacy_shopify_receipt_offer_carrier_account_id(uuid,text,text,text,text,bigint,text)'),
                  ('operations_legacy_shopify_config_carrier_account_id(uuid,text,text)'),
                  ('operations_legacy_shopify_fulfillment_attempt_carrier_account_id(uuid,uuid,text,boolean)'),
                  ('derive_operations_legacy_shopify_carrier_selection_key()'),
                  ('validate_one_off_rate_selection_key()'),
                  ('protect_operations_shopify_checkout_rate_receipt_offer()'),
                  ('protect_op_shopify_checkout_provider_attempt()'),
                  ('validate_op_shopify_checkout_attempt_finalization()'),
                  ('validate_operations_fulfillment_execution()')
                ) AS required_shopify_carrier_function(function_signature)
                WHERE to_regprocedure(
                  required_shopify_carrier_function.function_signature
                ) IS NULL
              )
              AND regexp_replace(
                pg_get_functiondef(
                  to_regprocedure('validate_operations_fulfillment_execution()')
                ),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%attempt.carrier_account_id = run.selected_carrier_account_id%'
              AND regexp_replace(
                pg_get_functiondef(
                  to_regprocedure('validate_operations_fulfillment_execution()')
                ),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%choice.carrier_account_id = attempt.carrier_account_id%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'operations_shopify_carrier_configuration_allows_rating(jsonb,text)'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%WHEN ''production'' THEN (%production_rate%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%requested_environment IN (''sandbox'', ''production'')%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%carrier_integration.environment = requested_environment%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%carrier_account.id = selected.carrier_account_id%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%operations_shopify_carrier_configuration_allows_rating( carrier_integration.configuration, requested_environment )%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'operations_shopify_carrier_service_config_is_ready(uuid,uuid)'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%activation.state = ''shadow''%config.id, ''sandbox''%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'operations_shopify_carrier_service_config_is_ready(uuid,uuid)'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%activation.state = ''active''%config.id, ''production''%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'derive_operations_legacy_shopify_carrier_selection_key()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%carrier_integration.environment = CASE receipt.activation_state%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'derive_operations_legacy_shopify_carrier_selection_key()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%NEW.carrier_selection_key := operations_shopify_checkout_carrier_selection_key(%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'derive_operations_legacy_shopify_carrier_selection_key()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%NEW.actor_email IS NOT NULL%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_one_off_rate_selection_key()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%NEW.actor_email IS NULL AND NEW.purpose = ''cartonization_shipment_rate''%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_one_off_rate_selection_key()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%carrier_integration.environment = CASE receipt.activation_state%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_one_off_rate_selection_key()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%NEW.carrier_selection_key = operations_shopify_checkout_carrier_selection_key(%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_one_off_rate_selection_key()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%operations_one_off_carrier_selection_key( NEW.provider,%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'protect_operations_shopify_checkout_rate_receipt_offer()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%rate_evidence.carrier_selection_key = operations_shopify_checkout_carrier_selection_key(%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'protect_op_shopify_checkout_provider_attempt()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%selected.carrier_account_id = NEW.carrier_account_id%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'protect_op_shopify_checkout_provider_attempt()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%carrier_integration.environment = CASE receipt.activation_state%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'protect_op_shopify_checkout_provider_attempt()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%rate_evidence.carrier_selection_key = operations_shopify_checkout_carrier_selection_key(%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_op_shopify_checkout_attempt_finalization()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%selected.carrier_account_id = attempt.carrier_account_id%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_op_shopify_checkout_attempt_finalization()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%carrier_integration.environment = CASE NEW.activation_state%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_op_shopify_checkout_attempt_finalization()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%rate_evidence.carrier_selection_key IS DISTINCT FROM operations_shopify_checkout_carrier_selection_key(%'
              AND NOT EXISTS (
                SELECT 1
                FROM (VALUES
                  (
                    'operations_shopify_carrier_service_config_materials',
                    'validate_shopify_cs_config_material_write',
                    'validate_operations_shopify_carrier_service_config_child()',
                    31
                  ),
                  (
                    'operations_shopify_carrier_service_config_carriers',
                    'validate_shopify_cs_config_carrier_write',
                    'validate_operations_shopify_carrier_service_config_child()',
                    31
                  ),
                  (
                    'operations_pack_rate_runs',
                    'a_derive_operations_legacy_pack_rate_run_account',
                    'derive_operations_legacy_pack_rate_run_account()',
                    23
                  ),
                  (
                    'operations_pack_rate_run_rate_choices',
                    'a_derive_operations_legacy_pack_rate_choice_account',
                    'derive_operations_legacy_pack_rate_choice_account()',
                    23
                  ),
                  (
                    'operations_shipment_groups',
                    'a_derive_operations_legacy_shipment_group_account',
                    'derive_operations_legacy_shipment_group_account()',
                    23
                  ),
                  (
                    'operations_pack_rate_run_rate_choices',
                    'validate_operations_pack_rate_choice_account_write',
                    'validate_operations_pack_rate_choice_account()',
                    23
                  ),
                  (
                    'operations_shipment_groups',
                    'validate_operations_shipment_group_account_write',
                    'validate_operations_shipment_group_account()',
                    23
                  ),
                  (
                    'operations_carrier_rate_requests',
                    'derive_operations_legacy_shopify_carrier_selection_key_write',
                    'derive_operations_legacy_shopify_carrier_selection_key()',
                    7
                  ),
                  (
                    'operations_carrier_rate_requests',
                    'validate_one_off_rate_selection_key_write',
                    'validate_one_off_rate_selection_key()',
                    23
                  ),
                  (
                    'operations_shopify_checkout_rate_receipt_offers',
                    'protect_operations_shopify_checkout_rate_receipt_offer_write',
                    'protect_operations_shopify_checkout_rate_receipt_offer()',
                    31
                  ),
                  (
                    'operations_shopify_checkout_rate_receipt_provider_attempts',
                    'protect_op_shopify_checkout_provider_attempt_write',
                    'protect_op_shopify_checkout_provider_attempt()',
                    31
                  ),
                  (
                    'operations_shopify_checkout_rate_receipts',
                    'validate_op_shopify_checkout_attempt_finalization',
                    'validate_op_shopify_checkout_attempt_finalization()',
                    19
                  )
                ) AS required_shopify_carrier_ordinary_trigger(
                  table_name, trigger_name, function_signature, trigger_type
                )
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_trigger installed_shopify_carrier_trigger
                  WHERE installed_shopify_carrier_trigger.tgrelid =
                    to_regclass(
                      required_shopify_carrier_ordinary_trigger.table_name
                    )
                    AND installed_shopify_carrier_trigger.tgname =
                      required_shopify_carrier_ordinary_trigger.trigger_name
                    AND installed_shopify_carrier_trigger.tgfoid =
                      to_regprocedure(
                        required_shopify_carrier_ordinary_trigger.function_signature
                      )
                    AND NOT installed_shopify_carrier_trigger.tgisinternal
                    AND installed_shopify_carrier_trigger.tgenabled = 'O'
                    AND installed_shopify_carrier_trigger.tgtype =
                      required_shopify_carrier_ordinary_trigger.trigger_type
                    AND installed_shopify_carrier_trigger.tgconstraint = 0
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM (VALUES
                  (
                    'operations_pack_rate_runs',
                    'validate_operations_pack_rate_account_run_deferred',
                    'validate_operations_pack_rate_account_lineage_complete()',
                    5
                  ),
                  (
                    'operations_pack_rate_run_rate_choices',
                    'validate_operations_pack_rate_account_choice_deferred',
                    'validate_operations_pack_rate_account_lineage_complete()',
                    5
                  ),
                  (
                    'operations_fulfillment_executions',
                    'validate_operations_fulfillment_account_execution_deferred',
                    'validate_operations_fulfillment_account_lineage_complete()',
                    5
                  ),
                  (
                    'operations_shipment_groups',
                    'validate_operations_fulfillment_account_group_deferred',
                    'validate_operations_fulfillment_account_lineage_complete()',
                    5
                  ),
                  (
                    'operations_fulfillment_execution_rate_attempts',
                    'validate_operations_fulfillment_account_attempt_deferred',
                    'validate_operations_fulfillment_account_lineage_complete()',
                    5
                  ),
                  (
                    'operations_pack_rate_run_rate_choices',
                    'validate_operations_fulfillment_account_choice_deferred',
                    'validate_operations_fulfillment_account_lineage_complete()',
                    5
                  ),
                  (
                    'operations_fulfillment_executions',
                    'validate_operations_fulfillment_execution_deferred',
                    'validate_operations_fulfillment_execution()',
                    21
                  ),
                  (
                    'operations_shipment_groups',
                    'validate_operations_fulfillment_group_deferred',
                    'validate_operations_fulfillment_execution()',
                    21
                  ),
                  (
                    'operations_fulfillment_execution_rate_attempts',
                    'validate_operations_fulfillment_attempts_deferred',
                    'validate_operations_fulfillment_execution()',
                    21
                  ),
                  (
                    'operations_fulfillment_execution_lines',
                    'validate_operations_fulfillment_lines_deferred',
                    'validate_operations_fulfillment_execution()',
                    21
                  ),
                  (
                    'operations_fulfillment_execution_packages',
                    'validate_operations_fulfillment_packages_deferred',
                    'validate_operations_fulfillment_execution()',
                    21
                  ),
                  (
                    'operations_label_attempts',
                    'validate_operations_fulfillment_label_attempt_link_deferred',
                    'validate_operations_fulfillment_execution()',
                    21
                  ),
                  (
                    'operations_labels',
                    'validate_operations_fulfillment_label_link_deferred',
                    'validate_operations_fulfillment_execution()',
                    21
                  ),
                  (
                    'operations_shipments',
                    'validate_operations_fulfillment_shipment_link_deferred',
                    'validate_operations_fulfillment_execution()',
                    21
                  )
                ) AS required_shopify_carrier_deferred_trigger(
                  table_name, trigger_name, function_signature, trigger_type
                )
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_trigger installed_shopify_carrier_trigger
                  JOIN pg_constraint installed_shopify_carrier_constraint
                    ON installed_shopify_carrier_constraint.oid =
                      installed_shopify_carrier_trigger.tgconstraint
                  WHERE installed_shopify_carrier_trigger.tgrelid =
                    to_regclass(
                      required_shopify_carrier_deferred_trigger.table_name
                    )
                    AND installed_shopify_carrier_trigger.tgname =
                      required_shopify_carrier_deferred_trigger.trigger_name
                    AND installed_shopify_carrier_trigger.tgfoid =
                      to_regprocedure(
                        required_shopify_carrier_deferred_trigger.function_signature
                      )
                    AND NOT installed_shopify_carrier_trigger.tgisinternal
                    AND installed_shopify_carrier_trigger.tgenabled = 'O'
                    AND installed_shopify_carrier_trigger.tgtype =
                      required_shopify_carrier_deferred_trigger.trigger_type
                    AND installed_shopify_carrier_constraint.contype = 't'
                    AND installed_shopify_carrier_constraint.condeferrable
                    AND installed_shopify_carrier_constraint.condeferred
                )
              )
                AS shopify_carrier_configured_carriers_applied,
              (
                ${SHOPIFY_CHECKOUT_AUDIENCE_POLICY_HEALTH_SQL}
              ) AS shopify_checkout_audience_policy_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename =
                  '0286_carrier_shipping_account_diagnostics.sql'
              )
              AND to_regprocedure(
                'validate_operations_carrier_shipping_diagnostic_lineage()'
              ) IS NOT NULL
              AND to_regprocedure(
                'maintain_operations_carrier_shipping_diagnostic_authority_lease()'
              ) IS NOT NULL
              AND to_regprocedure(
                'protect_operations_carrier_shipping_diagnostic_authority()'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM (VALUES
                  (
                    'operations_activation_scopes',
                    'operations_activation_scopes_shipping_diagnostic_lease_valid'
                  ),
                  (
                    'operations_integration_accounts',
                    'operations_integration_accounts_shipping_diagnostic_lease_valid'
                  ),
                  (
                    'operations_carrier_credentials',
                    'operations_carrier_credentials_shipping_diagnostic_lease_valid'
                  ),
                  (
                    'operations_carrier_accounts',
                    'operations_carrier_accounts_shipping_diagnostic_lease_valid'
                  )
                ) AS required_diagnostic_lease(table_name, constraint_name)
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_attribute installed_lease_column
                  JOIN pg_attrdef installed_lease_default
                    ON installed_lease_default.adrelid =
                      installed_lease_column.attrelid
                   AND installed_lease_default.adnum =
                      installed_lease_column.attnum
                  WHERE installed_lease_column.attrelid =
                    to_regclass(required_diagnostic_lease.table_name)
                    AND installed_lease_column.attname =
                      'production_shipping_diagnostic_lease_count'
                    AND installed_lease_column.atttypid = 'integer'::regtype
                    AND installed_lease_column.attnotnull
                    AND NOT installed_lease_column.attisdropped
                    AND pg_get_expr(
                      installed_lease_default.adbin,
                      installed_lease_default.adrelid
                    ) = '0'
                )
                OR NOT EXISTS (
                  SELECT 1
                  FROM pg_constraint installed_lease_constraint
                  WHERE installed_lease_constraint.conrelid =
                    to_regclass(required_diagnostic_lease.table_name)
                    AND installed_lease_constraint.conname =
                      required_diagnostic_lease.constraint_name
                    AND pg_get_constraintdef(
                      installed_lease_constraint.oid
                    ) = 'CHECK ((production_shipping_diagnostic_lease_count >= 0))'
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM (VALUES
                  (
                    'operations_carrier_rate_test_label_attempts',
                    'operations_carrier_test_attempts_live_account_open_unique',
                    ARRAY[
                      'organization_id', 'carrier_account_id'
                    ]::name[],
                    '((environment = ''production''::text) AND (action = ''create''::text) AND (state = ANY (ARRAY[''prepared''::text, ''unknown''::text])))'
                  ),
                  (
                    'operations_carrier_rate_test_labels',
                    'operations_carrier_test_labels_live_account_active_unique',
                    ARRAY[
                      'organization_id', 'carrier_account_id'
                    ]::name[],
                    '((environment = ''production''::text) AND (status = ''created''::text))'
                  )
                ) AS required_diagnostic_fence_index(
                  table_name, index_name, column_names, predicate
                )
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_class installed_fence_index_class
                  JOIN pg_index installed_fence_index
                    ON installed_fence_index.indexrelid =
                      installed_fence_index_class.oid
                  WHERE installed_fence_index_class.relname =
                    required_diagnostic_fence_index.index_name
                    AND installed_fence_index.indrelid = to_regclass(
                      required_diagnostic_fence_index.table_name
                    )
                    AND installed_fence_index.indisunique
                    AND installed_fence_index.indisvalid
                    AND installed_fence_index.indisready
                    AND ARRAY(
                      SELECT installed_fence_column.attname
                      FROM unnest(installed_fence_index.indkey::smallint[])
                        WITH ORDINALITY AS indexed_attribute(attnum, ordinal)
                      JOIN pg_attribute installed_fence_column
                        ON installed_fence_column.attrelid =
                          installed_fence_index.indrelid
                       AND installed_fence_column.attnum =
                          indexed_attribute.attnum
                      ORDER BY indexed_attribute.ordinal
                    ) = required_diagnostic_fence_index.column_names
                    AND pg_get_expr(
                      installed_fence_index.indpred,
                      installed_fence_index.indrelid
                    ) = required_diagnostic_fence_index.predicate
                )
              )
              AND EXISTS (
                SELECT 1
                FROM pg_class diagnostic_health_index_class
                JOIN pg_index diagnostic_health_index
                  ON diagnostic_health_index.indexrelid =
                    diagnostic_health_index_class.oid
                WHERE diagnostic_health_index_class.relname =
                  'operations_carrier_rate_test_attempts_health_recent_idx'
                  AND diagnostic_health_index.indrelid = to_regclass(
                    'operations_carrier_rate_test_label_attempts'
                  )
                  AND diagnostic_health_index.indisvalid
                  AND diagnostic_health_index.indisready
                  AND pg_get_indexdef(
                    diagnostic_health_index.indexrelid
                  ) LIKE '%(requested_at DESC, id DESC) INCLUDE (environment, state)%'
              )
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_carrier_shipping_diagnostic_lineage()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%evidence.purpose = ''shipping_account_diagnostic'' AND evidence.environment <> ''production''%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_carrier_shipping_diagnostic_lineage()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%evidence.integration_account_id <> NEW.integration_account_id%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_carrier_shipping_diagnostic_lineage()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%evidence.carrier_account_id <> NEW.carrier_account_id%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_carrier_shipping_diagnostic_lineage()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%NEW.environment IN (''sandbox'', ''production'')%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_carrier_shipping_diagnostic_lineage()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%NEW.environment = ''sandbox''%label.account_number_fingerprint = carrier_account.account_number_fingerprint%integration.environment = ''sandbox''%credential.credential_version = NEW.credential_version%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_carrier_shipping_diagnostic_lineage()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%production_label%activation.state = ''active''%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_carrier_shipping_diagnostic_lineage()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%FOR UPDATE OF integration, credential, carrier_account, activation%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_carrier_shipping_diagnostic_lineage()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%credentialFingerprint%credential.credential_fingerprint%accountNumberFingerprint%carrier_account.account_number_fingerprint%registeredAddressFingerprint%carrier_account.registered_address_fingerprint%senderName%carrier_account.sender_name%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'validate_operations_carrier_shipping_diagnostic_lineage()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%diagnostic_row->>''action'' = ''void''%credential.credential_version = NEW.credential_version%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'maintain_operations_carrier_shipping_diagnostic_authority_lease()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%attempt_row.environment <> ''production''%attempt_row.action <> ''create''%lease_delta := 1%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'maintain_operations_carrier_shipping_diagnostic_authority_lease()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%UPDATE operations_activation_scopes%UPDATE operations_integration_accounts%UPDATE operations_carrier_credentials%UPDATE operations_carrier_accounts%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'protect_operations_carrier_shipping_diagnostic_authority()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%production_shipping_diagnostic_lease_count%operations_activation_scopes%operations_integration_accounts%operations_carrier_credentials%operations_carrier_accounts%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'protect_operations_carrier_shipping_diagnostic_authority()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%production_rate%production_label%verification_status%allow_sender_billing%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'protect_operations_carrier_shipping_diagnostic_authority()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%NEW.credential_ciphertext%NEW.credential_iv%NEW.credential_tag%NEW.credential_fingerprint%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'protect_operations_carrier_shipping_diagnostic_authority()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%NEW.account_number_ciphertext%NEW.account_number_iv%NEW.account_number_tag%NEW.encryption_version%NEW.account_number_fingerprint%NEW.registered_address%NEW.registered_address_fingerprint%NEW.sender_name%'
              AND regexp_replace(
                pg_get_functiondef(to_regprocedure(
                  'protect_operations_carrier_shipping_diagnostic_authority()'
                )),
                '[[:space:]]+', ' ', 'g'
              ) LIKE '%NEW.account_number_last_four%OLD.account_number_ciphertext%OLD.account_number_last_four%OLD.registered_address%OLD.sender_name%'
              AND NOT EXISTS (
                SELECT 1
                FROM (VALUES
                  (
                    'operations_carrier_rate_test_labels',
                    'validate_operations_carrier_shipping_diagnostic_label',
                    'validate_operations_carrier_shipping_diagnostic_lineage()',
                    7
                  ),
                  (
                    'operations_carrier_rate_test_label_attempts',
                    'validate_operations_carrier_shipping_diagnostic_attempt',
                    'validate_operations_carrier_shipping_diagnostic_lineage()',
                    7
                  ),
                  (
                    'operations_carrier_rate_test_label_attempts',
                    'maintain_operations_carrier_shipping_diagnostic_authority_lease',
                    'maintain_operations_carrier_shipping_diagnostic_authority_lease()',
                    29
                  ),
                  (
                    'operations_activation_scopes',
                    'protect_operations_carrier_shipping_diagnostic_activation',
                    'protect_operations_carrier_shipping_diagnostic_authority()',
                    19
                  ),
                  (
                    'operations_integration_accounts',
                    'protect_operations_carrier_shipping_diagnostic_integration',
                    'protect_operations_carrier_shipping_diagnostic_authority()',
                    19
                  ),
                  (
                    'operations_carrier_credentials',
                    'protect_operations_carrier_shipping_diagnostic_credential',
                    'protect_operations_carrier_shipping_diagnostic_authority()',
                    19
                  ),
                  (
                    'operations_carrier_accounts',
                    'protect_operations_carrier_shipping_diagnostic_account',
                    'protect_operations_carrier_shipping_diagnostic_authority()',
                    19
                  )
                ) AS required_diagnostic_trigger(
                  table_name, trigger_name, function_signature, trigger_type
                )
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM pg_trigger installed_diagnostic_trigger
                  WHERE installed_diagnostic_trigger.tgrelid =
                    to_regclass(required_diagnostic_trigger.table_name)
                    AND installed_diagnostic_trigger.tgname =
                      required_diagnostic_trigger.trigger_name
                    AND installed_diagnostic_trigger.tgfoid =
                      to_regprocedure(
                        required_diagnostic_trigger.function_signature
                      )
                    AND NOT installed_diagnostic_trigger.tgisinternal
                    AND installed_diagnostic_trigger.tgenabled = 'O'
                    AND installed_diagnostic_trigger.tgtype =
                      required_diagnostic_trigger.trigger_type
                    AND installed_diagnostic_trigger.tgconstraint = 0
                )
              ) AS carrier_shipping_diagnostics_applied,
              (
                SELECT jsonb_build_object(
                  'sandbox', jsonb_build_object(
                    'prepared', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'sandbox'
                        AND diagnostic_attempt.state = 'prepared'
                    ),
                    'stalePrepared', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'sandbox'
                        AND diagnostic_attempt.state = 'prepared'
                        AND diagnostic_attempt.requested_at <
                          now() - interval '2 minutes'
                    ),
                    'succeeded', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'sandbox'
                        AND diagnostic_attempt.state = 'succeeded'
                    ),
                    'failed', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'sandbox'
                        AND diagnostic_attempt.state = 'failed'
                    ),
                    'unknown', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'sandbox'
                        AND diagnostic_attempt.state = 'unknown'
                    )
                  ),
                  'production', jsonb_build_object(
                    'prepared', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'production'
                        AND diagnostic_attempt.state = 'prepared'
                    ),
                    'stalePrepared', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'production'
                        AND diagnostic_attempt.state = 'prepared'
                        AND diagnostic_attempt.requested_at <
                          now() - interval '2 minutes'
                    ),
                    'succeeded', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'production'
                        AND diagnostic_attempt.state = 'succeeded'
                    ),
                    'failed', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'production'
                        AND diagnostic_attempt.state = 'failed'
                    ),
                    'unknown', count(*) FILTER (
                      WHERE diagnostic_attempt.environment = 'production'
                        AND diagnostic_attempt.state = 'unknown'
                    )
                  )
                )
                FROM (
                  SELECT recent_attempt.environment,
                         recent_attempt.state,
                         recent_attempt.requested_at
                  FROM operations_carrier_rate_test_label_attempts
                    recent_attempt
                  ORDER BY recent_attempt.requested_at DESC,
                           recent_attempt.id DESC
                  LIMIT 500
                ) diagnostic_attempt
              ) AS carrier_shipping_diagnostic_attempt_counts,
              NOT EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE checksum IS NULL OR checksum !~ '^[0-9a-f]{64}$'
              ) AS migration_checksums_present
          `,
        )
        const row = result.rows[0]
        const canonicalOrderRevisionHealth =
          row?.operations_commerce_order_revision_apply_applied
            ? await readCommerceOrderRevisionHealthFromPostgres()
            : null
        const orderHistoryHealth =
          row?.operations_commerce_order_sync_foundation_applied
            ? await Promise.all([
                readCommerceOrderSyncHealthFromPostgres(),
                readCommerceOrderSyncCursorKeyReadinessFromPostgres(),
                row?.operations_shopify_order_webhook_signals_applied
                  ? readShopifyOrderWebhookSignalHealthFromPostgres()
                  : Promise.resolve(null),
              ])
            : null
        database = {
          status: 'reachable',
          checkedAt: row?.now || new Date(checkedAt).toISOString(),
          migrationsCurrent: Boolean(
            row?.worker_migration_applied
            && row?.auth_migration_applied
            && row?.agent_auth_migration_applied
            && row?.users_migration_applied
            && row?.attribution_migration_applied
            && row?.workspaces_migration_applied
            && row?.workspace_security_migration_applied
            && row?.agent_dispatch_migration_applied
            && row?.invitation_migration_applied
            && row?.knowledge_migration_applied
            && row?.hardening_migration_applied
            && row?.invitation_delivery_migration_applied
            && row?.invitation_pending_migration_applied
            && row?.shortlinks_migration_applied
            && row?.vector_knowledge_migration_applied
            && row?.shortlink_preflight_migration_applied
            && row?.shortlink_hardening_migration_applied
            && row?.maton_credentials_migration_applied
            && row?.managed_pipeline_resources_migration_applied
            && row?.crm_gateway_migration_applied
            && row?.crm_identity_hierarchy_migration_applied
            && row?.pipeline_sheet_links_migration_applied
            && row?.crm_integrations_migration_applied
            && row?.crm_board_projection_migration_applied
            && row?.account_membership_migration_applied
            && row?.suitecrm_inbound_sync_migration_applied
            && row?.crm_display_text_migration_applied
            && row?.browser_sessions_migration_applied
            && row?.workspace_preferences_migration_applied
            && row?.pipeline_catalog_migration_applied
            && row?.atomic_product_catalog_migration_applied
            && row?.organization_branding_migration_applied
            && row?.pipeline_spelling_migration_applied
            && row?.residual_pipeline_catalog_migration_applied
            && row?.historical_pipeline_catalog_migration_applied
            && row?.configured_pipeline_dropdowns_migration_applied
            && row?.canonical_dropdown_layout_migration_applied
            && row?.empty_pipeline_templates_migration_applied
            && row?.crm_contact_owner_identity_migration_applied
            && row?.repository_runner_migration_applied
            && row?.crm_employee_identity_migration_applied
            && row?.canonical_suitecrm_usernames_migration_applied
            && row?.agent_research_migration_applied
            && row?.toast_integrations_migration_applied
            && row?.multi_workspace_memberships_migration_applied
            && row?.quickbooks_connector_migration_applied
            && row?.quickbooks_explorer_migration_applied
            && row?.quickbooks_reports_migration_applied
            && row?.quickbooks_write_control_migration_applied
            && row?.demo_quickbooks_crm_migration_applied
            && row?.demo_workspace_account_migration_applied
            && row?.toast_pos_orders_migration_applied
            && row?.quickbooks_write_connection_binding_migration_applied
            && row?.pos_accounting_profiles_migration_applied
            && row?.toast_menu_catalog_migration_applied
            && row?.quickbooks_reference_catalogs_migration_applied
            && row?.toast_sync_rerun_migration_applied
            && row?.toast_sync_worker_hardening_migration_applied
            && row?.pos_accounting_notifications_migration_applied
            && row?.quickbooks_write_binding_compatibility_migration_applied
            && row?.pos_accounting_notification_consent_migration_applied
            && row?.pos_accounting_date_commands_migration_applied
            && row?.pos_accounting_posting_outcomes_migration_applied
            && row?.external_pos_accounting_outcomes_migration_applied
            && row?.distributed_operations_migration_applied
            && row?.operations_hardening_migration_applied
            && row?.crm_interaction_contacts_migration_applied
            && row?.operations_command_results_migration_applied
            && row?.operations_package_workflow_migration_applied
            && row?.product_packaging_profiles_migration_applied
            && row?.operations_carrier_credentials_migration_applied
            && row?.operations_sandbox_rating_migration_applied
            && row?.operations_rate_delegation_migration_applied
            && row?.operations_carrier_accounts_gl_coding_migration_applied
            && row?.operations_printer_configuration_migration_applied
            && row?.operations_carrier_billing_integrity_migration_applied
            && row?.operations_carrier_billing_review_migration_applied
            && row?.operations_print_delivery_migration_applied
            && row?.operations_print_device_reference_privacy_applied
            && row?.operations_print_agent_pairing_grants_applied
            && row?.shopify_carrier_configured_carriers_applied
            && row?.shopify_checkout_audience_policy_applied
            && row?.carrier_shipping_diagnostics_applied
            && row?.crm_native_activity_projection_migration_applied
            && row?.crm_contact_identity_aliases_migration_applied
            && row?.operations_settlement_lifecycle_migration_applied
            && row?.operations_label_execution_migration_applied
            && row?.operations_receiving_topology_migration_applied
            && row?.pos_payment_exceptions_migration_applied
            && row?.crm_reference_quarantine_migration_applied
            && row?.demo_managed_resource_guard_migration_applied
            && row?.quickbooks_pos_evidence_refresh_migration_applied
            && row?.toast_location_closeout_hour_migration_applied
            && row?.operations_warehouse_operating_profile_migration_applied
            && row?.operations_slotting_replenishment_migration_applied
            && row?.operations_replenishment_execution_migration_applied
            && row?.operations_carrier_account_sender_name_migration_applied
            && row?.operations_commerce_integrations_migration_applied
            && row?.operations_faire_oauth_migration_applied
            && row?.operations_shopify_order_preview_migration_applied
            && row?.operations_commerce_normalization_migration_applied
            && row?.operations_commerce_continuations_migration_applied
            && row?.operations_commerce_order_attention_kinds_applied
            && row?.operations_carrier_rate_test_labels_migration_applied
            && row?.operations_print_agent_capabilities_migration_applied
            && row?.operations_carrier_label_artifacts_migration_applied
            && row?.operations_commerce_product_policy_migration_applied
            && row?.operations_commerce_catalog_sync_migration_applied
            && row?.operations_package_contents_migration_applied
            && row?.operations_commerce_incomplete_header_money_migration_applied
            && row?.operations_packaging_materials_migration_applied
            && row?.operations_packaging_material_lifecycle_migration_applied
            && row?.operations_shopify_inventory_migration_applied
            && row?.measurement_preferences_migration_applied
            && row?.packaging_material_unit_neutral_names_migration_applied
            && row?.workspace_currency_preference_migration_applied
            && row?.operations_pack_hierarchy_migration_applied
            && row?.crm_data_transfers_migration_applied
            && row?.operations_product_channel_states_migration_applied
            && row?.crm_product_identity_aliases_migration_applied
            && row?.operations_product_channel_offers_migration_applied
            && row?.operations_pack_runtime_association_migration_applied
            && row?.operations_commerce_pack_resolution_migration_applied
            && row?.operations_hybrid_cartonization_recipes_migration_applied
            && row?.operations_cartonization_package_rates_migration_applied
            && row?.operations_cartonization_rate_evidence_migration_applied
            && row?.operations_cartonization_rate_evidence_integrity_applied
            && row?.operations_fulfilled_line_price_state_applied
            && row?.operations_commerce_packaging_source_repair_applied
            && row?.operations_recipe_pack_association_migration_applied
            && row?.operations_cartonization_evidence_scale_applied
            && row?.operations_cartonization_shipment_rates_applied
            && row?.operations_one_off_shipments_applied
            && row?.operations_cartonization_enabled_carriers_applied
            && row?.operations_cartonization_rate_constraint_repair_applied
            && row?.operations_two_pass_pack_rate_runs_applied
            && row?.operations_pack_rate_pricing_semantics_applied
            && row?.operations_carrier_billing_mud_applied
            && row?.operations_shopify_inventory_refresh_migration_applied
            && row?.operations_shopify_location_routing_applied
            && row?.operations_shopify_location_administration_applied
            && row?.operations_shadow_training_applied
            && row?.operations_order_replanning_corrections_applied
            && row?.operations_shopify_inventory_webhook_refresh_applied
            && row?.operations_shopify_catalog_webhook_refresh_applied
            && row?.operations_commerce_pack_evidence_fingerprint_applied
            && row?.operations_shadow_fulfillment_destination_repair_applied
            && row?.operations_shadow_rate_choice_package_identity_repair_applied
            && row?.operations_fulfillment_execution_union_repair_applied
            && row?.operations_fulfillment_rate_parcel_repair_applied
            && row?.operations_shopify_checkout_plan_rate_policy_applied
            && row?.shopify_active_account_readiness_migration_applied
            && row?.operations_commerce_inventory_attempt_lease_renewal_applied
            && row?.operations_shopify_shipping_service_codes_applied
            && row?.operations_shopify_checkout_provider_attempts_applied
            && row?.operations_shopify_checkout_rate_warm_policy_applied
            && row?.operations_canonical_fulfillment_planning_applied
            && row?.operations_fulfillment_executions_applied
            && row?.operations_shopify_customer_rate_policies_applied
            && row?.operations_active_multi_package_execution_applied
            && row?.operations_production_fulfillment_rerates_applied
            && row?.operations_shopify_shadow_policy_lifetime_applied
            && row?.operations_shopify_shadow_test_subsidy_applied
            && row?.operations_shopify_quote_match_families_applied
            && row?.operations_sandbox_commerce_e2e_authorization_applied
            && row?.operations_commerce_active_canonical_collation_applied
            && row?.operations_sandbox_commerce_e2e_active_guards_applied
            && row?.operations_faire_sandbox_commerce_e2e_applied
            && row?.operations_fulfillment_notification_policy_applied
            && row?.global_id_alphanumeric_compatibility_applied
            && row?.global_id_base32hex_allocator_applied
            && row?.faire_provider_write_auth_applied
            && row?.faire_fulfillment_authority_applied
            && row?.operations_commerce_fulfillment_recovery_applied
            && row?.operations_commerce_product_image_imports_applied
            && row?.operations_commerce_product_image_fanout_applied
            && row?.operations_commerce_product_image_source_normalization_applied
            && row?.operations_faire_product_image_projection_applied
            && row?.operations_faire_inventory_polling_applied
            && row?.suitecrm_product_image_reverse_ingestion_applied
            && row?.operations_commerce_order_revisions_applied
            && row?.operations_commerce_order_revision_apply_applied
            && row?.operations_one_off_carrier_selection_applied
            && row?.operations_commerce_order_sync_foundation_applied
            && row?.operations_commerce_authority_policies_applied
            && row?.operations_shopify_order_webhook_signals_applied
            && row?.operations_shopify_order_management_applied
            && row?.migration_checksums_present
          ),
          carrierShippingDiagnostics: {
            status: row?.carrier_shipping_diagnostics_applied
              ? 'ready'
              : 'migration-pending',
            attempts: row?.carrier_shipping_diagnostic_attempt_counts || null,
          },
          printAgentPairing: {
            status: row?.operations_print_agent_pairing_grants_applied
              ? 'ready'
              : 'migration-pending',
          },
          shopifyCheckoutAudiencePolicy: {
            status: row?.shopify_checkout_audience_policy_applied
              ? 'ready'
              : 'migration-or-structure-pending',
          },
          shopifyLocationRouting: {
            status: row?.operations_shopify_location_routing_applied
              ? 'ready'
              : 'migration-or-structure-pending',
          },
          shopifyLocationAdministration: {
            status: row?.operations_shopify_location_administration_applied
              ? 'ready'
              : 'migration-or-structure-pending',
          },
          shadowTraining: {
            status: row?.operations_shadow_training_applied
              ? 'ready'
              : 'migration-or-structure-pending',
          },
          orderReplanningCorrections: {
            status: row?.operations_order_replanning_corrections_applied
              ? 'ready'
              : 'migration-or-structure-pending',
          },
        }
        const carrierDiagnosticAttempts =
          row?.carrier_shipping_diagnostic_attempt_counts
        if (
          (carrierDiagnosticAttempts?.sandbox?.stalePrepared || 0) > 0
          || (carrierDiagnosticAttempts?.production?.stalePrepared || 0) > 0
        ) {
          warnings.push(
            'Carrier shipping diagnostics have stale prepared attempts requiring review before retry.',
          )
        }
        if (
          (carrierDiagnosticAttempts?.sandbox?.unknown || 0) > 0
          || (carrierDiagnosticAttempts?.production?.unknown || 0) > 0
        ) {
          warnings.push(
            'Carrier shipping diagnostics have unknown provider outcomes requiring manual review; do not retry.',
          )
        }
        if (canonicalOrderRevisionHealth) {
          commerceOrderReconciliationWorker = {
            ...commerceOrderReconciliationWorker,
            status: canonicalOrderRevisionHealth.status === 'degraded'
              ? 'degraded'
              : 'disabled',
            livenessStatus: 'disabled',
            operationalStatus: canonicalOrderRevisionHealth.status,
            canonicalOrderRevisions: {
              status: canonicalOrderRevisionHealth.status,
              heartbeat: null,
              durable: canonicalOrderRevisionHealth,
            },
          }
          if (canonicalOrderRevisionHealth.expiredProtectedReadBacklog > 0) {
            warnings.push(
              'Expired canonical-order protected evidence is awaiting bounded purge.',
            )
          }
          if (canonicalOrderRevisionHealth.protectedEvidenceKeys.ready !== true) {
            warnings.push(
              'Canonical-order protected evidence key readiness requires attention.',
            )
          }
        }
        if (orderHistoryHealth) {
          const [durable, cursorKeys, shopifyOrderWebhookSignals] =
            orderHistoryHealth
          const shopifyWebhookDurableDegraded = Boolean(
            shopifyOrderWebhookSignals
            && (
              shopifyOrderWebhookSignals.staleProcessing > 0
              || shopifyOrderWebhookSignals.failed > 0
              || shopifyOrderWebhookSignals.dead > 0
              || shopifyOrderWebhookSignals.overdueDirty > 0
            )
          )
          const durableDegraded = commerceOrderHistoryDurableDegraded({
            staleProcessing: durable.staleProcessing,
            failed: durable.failed,
            blocked: durable.blocked,
            dead: durable.dead,
            overduePolls: durable.overduePolls,
            expiredSensitiveEvidence: durable.expiredSensitiveEvidence,
            cursorKeysReady: cursorKeys.ready === true,
          }) || shopifyWebhookDurableDegraded
          const historyRuntimeAvailable = commerceReadRuntimeAvailable()
          const historyWorkerHeartbeat = historyRuntimeAvailable
            ? await readCommerceOrderReconciliationWorkerHeartbeatFromPostgres()
            : null
          const historyWorkerResult = (
            historyWorkerHeartbeat?.orderHistory
            && typeof historyWorkerHeartbeat.orderHistory === 'object'
            && !Array.isArray(historyWorkerHeartbeat.orderHistory)
          ) ? historyWorkerHeartbeat.orderHistory as Record<string, unknown> : null
          const shopifyWebhookWorkerResult = (
            historyWorkerHeartbeat?.shopifyOrderWebhooks
            && typeof historyWorkerHeartbeat.shopifyOrderWebhooks === 'object'
            && !Array.isArray(historyWorkerHeartbeat.shopifyOrderWebhooks)
          ) ? historyWorkerHeartbeat.shopifyOrderWebhooks as Record<string, unknown> : null
          const historyWorkerDegraded = (
            historyWorkerHeartbeat?.phase === 'failed'
            || historyWorkerResult?.degraded === true
            || shopifyWebhookWorkerResult?.degraded === true
          )
          const operational = commerceOrderHistoryOperationalHealth({
            runtimeAvailable: historyRuntimeAvailable,
            heartbeatCheckedAt: String(
              historyWorkerHeartbeat?.checkedAt || '',
            ) || null,
            checkedAtMs: checkedAt,
            pollIntervalMs: Number(
              process.env.COMMERCE_ORDER_RECONCILIATION_POLL_MS || 60_000,
            ),
            durableDegraded,
            workerDegraded: historyWorkerDegraded,
          })
          commerceOrderHistory = {
            status: operational.status,
            providerReadOnly: true,
            providerWrites: 0,
            transport: durable.transport,
            continuousTransportCounts: durable.continuousTransportCounts,
            pollingCadenceMinutes: durable.pollingCadenceMinutes,
            runtimeAvailable: operational.runtimeAvailable,
            worker: {
              ...operational.worker,
              phase: historyWorkerHeartbeat?.phase || null,
              historyDegraded: historyWorkerResult?.degraded === true,
              historyErrorCode: historyWorkerResult?.degraded === true
                ? String(historyWorkerResult.errorCode || '') || null
                : null,
              shopifyOrderWebhooksDegraded:
                shopifyWebhookWorkerResult?.degraded === true,
              shopifyOrderWebhooksErrorCode:
                shopifyWebhookWorkerResult?.degraded === true
                  ? String(shopifyWebhookWorkerResult.errorCode || '') || null
                  : null,
            },
            durable,
            cursorKeys,
            shopifyOrderWebhookSignals,
          }
          if (!operational.runtimeAvailable) {
            warnings.push(
              'Commerce order history provider reads are disabled by runtime configuration.',
            )
          } else if (operational.worker.status !== 'reachable') {
            warnings.push(
              'Commerce order history worker heartbeat is missing or stale.',
            )
          } else if (historyWorkerDegraded) {
            warnings.push(
              'The latest commerce order history worker cycle was degraded.',
            )
          }
          if (durable.expiredSensitiveEvidence > 0) {
            warnings.push(
              'Expired commerce-order tracking or provider attribution evidence is awaiting bounded redaction.',
            )
          }
          if (durable.staleProcessing > 0 || durable.dead > 0) {
            warnings.push(
              'Commerce order history has stale or terminal provider-read sessions.',
            )
          }
          if (durable.failed > 0 || durable.blocked > 0) {
            warnings.push(
              'Commerce order history has failed or blocked provider-read sessions.',
            )
          }
          if (durable.overduePolls > 0) {
            warnings.push(
              'Commerce order history has overdue scheduled provider reads.',
            )
          }
          if (shopifyWebhookDurableDegraded) {
            warnings.push(
              'Shopify order webhook exact-read targets are stale, failed, dead, or overdue.',
            )
          }
          if (shopifyWebhookWorkerResult?.degraded === true) {
            warnings.push(
              'The latest Shopify order webhook exact-read drain was degraded.',
            )
          }
          if (cursorKeys.ready !== true) {
            warnings.push(
              'Commerce order history cursor-key readiness requires attention.',
            )
          }
        }
        if (row?.operations_commerce_integrations_migration_applied) {
          shopifyWebhookReceipts =
            await readShopifyWebhookReceiptHealthFromPostgres()
          if (Number(shopifyWebhookReceipts.actionable || 0) > 0) {
            warnings.push(
              'Current Shopify webhook receipts require operator attention.',
            )
          }
        }
        if (row?.operations_shopify_order_management_applied) {
          const durable =
            await readShopifyOrderManagementHealthFromPostgres()
          const degraded = (
            durable.staleProcessing > 0
            || durable.unknown > 0
          )
          shopifyOrderManagement = {
            status: degraded
              ? 'degraded'
              : durable.processing > 0
                ? 'processing'
                : shopifyOrderManagementRuntimeState.available
                  ? 'ready'
                  : 'disabled',
            runtime: shopifyOrderManagementRuntimeSummary,
            durable,
          }
          if (durable.staleProcessing > 0) {
            warnings.push(
              'Shopify order management has stale provider-write attempts requiring reconciliation.',
            )
          }
          if (durable.unknown > 0) {
            warnings.push(
              'Shopify order management has unknown provider-write outcomes requiring reconciliation.',
            )
          }
        }
        if (
          !row?.worker_migration_applied
          || !row?.auth_migration_applied
          || !row?.agent_auth_migration_applied
          || !row?.users_migration_applied
          || !row?.attribution_migration_applied
          || !row?.workspaces_migration_applied
          || !row?.workspace_security_migration_applied
          || !row?.agent_dispatch_migration_applied
          || !row?.invitation_migration_applied
          || !row?.knowledge_migration_applied
          || !row?.hardening_migration_applied
          || !row?.invitation_delivery_migration_applied
          || !row?.invitation_pending_migration_applied
          || !row?.shortlinks_migration_applied
          || !row?.vector_knowledge_migration_applied
          || !row?.shortlink_preflight_migration_applied
          || !row?.shortlink_hardening_migration_applied
          || !row?.maton_credentials_migration_applied
          || !row?.managed_pipeline_resources_migration_applied
          || !row?.crm_gateway_migration_applied
          || !row?.crm_identity_hierarchy_migration_applied
          || !row?.pipeline_sheet_links_migration_applied
          || !row?.crm_integrations_migration_applied
          || !row?.crm_board_projection_migration_applied
          || !row?.account_membership_migration_applied
          || !row?.suitecrm_inbound_sync_migration_applied
          || !row?.crm_display_text_migration_applied
          || !row?.browser_sessions_migration_applied
          || !row?.workspace_preferences_migration_applied
          || !row?.pipeline_catalog_migration_applied
          || !row?.atomic_product_catalog_migration_applied
          || !row?.organization_branding_migration_applied
          || !row?.pipeline_spelling_migration_applied
          || !row?.residual_pipeline_catalog_migration_applied
          || !row?.historical_pipeline_catalog_migration_applied
          || !row?.configured_pipeline_dropdowns_migration_applied
          || !row?.canonical_dropdown_layout_migration_applied
          || !row?.empty_pipeline_templates_migration_applied
          || !row?.crm_contact_owner_identity_migration_applied
          || !row?.repository_runner_migration_applied
          || !row?.crm_employee_identity_migration_applied
          || !row?.canonical_suitecrm_usernames_migration_applied
          || !row?.agent_research_migration_applied
          || !row?.toast_integrations_migration_applied
          || !row?.multi_workspace_memberships_migration_applied
          || !row?.quickbooks_connector_migration_applied
          || !row?.quickbooks_explorer_migration_applied
          || !row?.quickbooks_reports_migration_applied
          || !row?.quickbooks_write_control_migration_applied
          || !row?.demo_quickbooks_crm_migration_applied
          || !row?.demo_workspace_account_migration_applied
          || !row?.toast_pos_orders_migration_applied
          || !row?.quickbooks_write_connection_binding_migration_applied
          || !row?.pos_accounting_profiles_migration_applied
          || !row?.toast_menu_catalog_migration_applied
          || !row?.quickbooks_reference_catalogs_migration_applied
          || !row?.toast_sync_rerun_migration_applied
          || !row?.toast_sync_worker_hardening_migration_applied
          || !row?.pos_accounting_notifications_migration_applied
          || !row?.quickbooks_write_binding_compatibility_migration_applied
          || !row?.pos_accounting_notification_consent_migration_applied
          || !row?.pos_accounting_date_commands_migration_applied
          || !row?.pos_accounting_posting_outcomes_migration_applied
          || !row?.external_pos_accounting_outcomes_migration_applied
          || !row?.distributed_operations_migration_applied
          || !row?.operations_hardening_migration_applied
          || !row?.crm_interaction_contacts_migration_applied
          || !row?.operations_command_results_migration_applied
          || !row?.operations_package_workflow_migration_applied
          || !row?.product_packaging_profiles_migration_applied
          || !row?.operations_carrier_credentials_migration_applied
          || !row?.operations_sandbox_rating_migration_applied
          || !row?.operations_rate_delegation_migration_applied
          || !row?.operations_carrier_accounts_gl_coding_migration_applied
          || !row?.operations_printer_configuration_migration_applied
          || !row?.operations_carrier_billing_integrity_migration_applied
          || !row?.operations_carrier_billing_review_migration_applied
          || !row?.operations_print_delivery_migration_applied
          || !row?.operations_print_device_reference_privacy_applied
          || !row?.operations_print_agent_pairing_grants_applied
          || !row?.shopify_carrier_configured_carriers_applied
          || !row?.shopify_checkout_audience_policy_applied
          || !row?.carrier_shipping_diagnostics_applied
          || !row?.crm_native_activity_projection_migration_applied
          || !row?.crm_contact_identity_aliases_migration_applied
          || !row?.operations_settlement_lifecycle_migration_applied
          || !row?.operations_label_execution_migration_applied
          || !row?.operations_receiving_topology_migration_applied
          || !row?.pos_payment_exceptions_migration_applied
          || !row?.crm_reference_quarantine_migration_applied
          || !row?.demo_managed_resource_guard_migration_applied
          || !row?.quickbooks_pos_evidence_refresh_migration_applied
          || !row?.toast_location_closeout_hour_migration_applied
          || !row?.operations_warehouse_operating_profile_migration_applied
          || !row?.operations_slotting_replenishment_migration_applied
          || !row?.operations_replenishment_execution_migration_applied
          || !row?.operations_carrier_account_sender_name_migration_applied
          || !row?.operations_commerce_integrations_migration_applied
          || !row?.operations_faire_oauth_migration_applied
          || !row?.operations_shopify_order_preview_migration_applied
          || !row?.operations_commerce_normalization_migration_applied
          || !row?.operations_commerce_continuations_migration_applied
          || !row?.operations_commerce_order_attention_kinds_applied
          || !row?.operations_carrier_rate_test_labels_migration_applied
          || !row?.operations_print_agent_capabilities_migration_applied
          || !row?.operations_carrier_label_artifacts_migration_applied
          || !row?.operations_commerce_product_policy_migration_applied
          || !row?.operations_commerce_catalog_sync_migration_applied
          || !row?.operations_package_contents_migration_applied
          || !row?.operations_commerce_incomplete_header_money_migration_applied
          || !row?.operations_packaging_materials_migration_applied
          || !row?.operations_packaging_material_lifecycle_migration_applied
          || !row?.operations_shopify_inventory_migration_applied
          || !row?.measurement_preferences_migration_applied
          || !row?.packaging_material_unit_neutral_names_migration_applied
          || !row?.workspace_currency_preference_migration_applied
          || !row?.operations_pack_hierarchy_migration_applied
          || !row?.crm_data_transfers_migration_applied
          || !row?.operations_product_channel_states_migration_applied
          || !row?.crm_product_identity_aliases_migration_applied
          || !row?.operations_product_channel_offers_migration_applied
          || !row?.operations_pack_runtime_association_migration_applied
          || !row?.operations_commerce_pack_resolution_migration_applied
          || !row?.operations_hybrid_cartonization_recipes_migration_applied
          || !row?.operations_cartonization_package_rates_migration_applied
          || !row?.operations_cartonization_rate_evidence_migration_applied
          || !row?.operations_cartonization_rate_evidence_integrity_applied
          || !row?.operations_fulfilled_line_price_state_applied
          || !row?.operations_commerce_packaging_source_repair_applied
          || !row?.operations_recipe_pack_association_migration_applied
          || !row?.operations_cartonization_evidence_scale_applied
          || !row?.operations_cartonization_shipment_rates_applied
          || !row?.operations_one_off_shipments_applied
          || !row?.operations_cartonization_enabled_carriers_applied
          || !row?.operations_cartonization_rate_constraint_repair_applied
          || !row?.operations_two_pass_pack_rate_runs_applied
          || !row?.operations_pack_rate_pricing_semantics_applied
          || !row?.operations_carrier_billing_mud_applied
          || !row?.operations_shopify_inventory_refresh_migration_applied
          || !row?.operations_shopify_location_routing_applied
          || !row?.operations_shopify_location_administration_applied
          || !row?.operations_shadow_training_applied
          || !row?.operations_order_replanning_corrections_applied
          || !row?.operations_shopify_inventory_webhook_refresh_applied
          || !row?.operations_shopify_catalog_webhook_refresh_applied
          || !row?.operations_commerce_pack_evidence_fingerprint_applied
          || !row?.operations_shadow_fulfillment_destination_repair_applied
          || !row?.operations_shadow_rate_choice_package_identity_repair_applied
          || !row?.operations_fulfillment_execution_union_repair_applied
          || !row?.operations_fulfillment_rate_parcel_repair_applied
          || !row?.operations_shopify_checkout_plan_rate_policy_applied
          || !row?.shopify_active_account_readiness_migration_applied
          || !row?.operations_commerce_inventory_attempt_lease_renewal_applied
          || !row?.operations_shopify_shipping_service_codes_applied
          || !row?.operations_shopify_checkout_provider_attempts_applied
          || !row?.operations_shopify_checkout_rate_warm_policy_applied
          || !row?.operations_canonical_fulfillment_planning_applied
          || !row?.operations_fulfillment_executions_applied
          || !row?.operations_shopify_customer_rate_policies_applied
          || !row?.operations_active_multi_package_execution_applied
          || !row?.operations_production_fulfillment_rerates_applied
          || !row?.operations_shopify_shadow_policy_lifetime_applied
          || !row?.operations_shopify_shadow_test_subsidy_applied
          || !row?.operations_shopify_quote_match_families_applied
          || !row?.operations_sandbox_commerce_e2e_authorization_applied
          || !row?.operations_commerce_active_canonical_collation_applied
          || !row?.operations_sandbox_commerce_e2e_active_guards_applied
          || !row?.operations_faire_sandbox_commerce_e2e_applied
          || !row?.operations_fulfillment_notification_policy_applied
          || !row?.global_id_alphanumeric_compatibility_applied
          || !row?.global_id_base32hex_allocator_applied
          || !row?.faire_provider_write_auth_applied
          || !row?.faire_fulfillment_authority_applied
          || !row?.operations_commerce_fulfillment_recovery_applied
          || !row?.operations_commerce_product_image_imports_applied
          || !row?.operations_commerce_product_image_fanout_applied
          || !row?.operations_commerce_product_image_source_normalization_applied
          || !row?.operations_faire_product_image_projection_applied
          || !row?.operations_faire_inventory_polling_applied
          || !row?.suitecrm_product_image_reverse_ingestion_applied
          || !row?.operations_commerce_order_revisions_applied
          || !row?.operations_commerce_order_revision_apply_applied
          || !row?.operations_one_off_carrier_selection_applied
          || !row?.operations_commerce_order_sync_foundation_applied
          || !row?.operations_commerce_authority_policies_applied
          || !row?.operations_shopify_order_webhook_signals_applied
          || !row?.operations_shopify_order_management_applied
          || !row?.migration_checksums_present
        ) {
          errors.push('Required database migrations are not applied.')
        }

        if (row?.operations_hardening_migration_applied) {
          const commandResult = await query<{
            processing: number
            failed: number
            stale_processing: number
            policy_rejected: number
            superseded: number
            actionable_failed: number
            active_organizations: number
            shadow_organizations: number
          }>(OPERATIONS_COMMAND_RECEIPT_HEALTH_QUERY)
          const commands = commandResult.rows[0]
          const staleProcessing = Number(commands?.stale_processing || 0)
          const failed = Number(commands?.failed || 0)
          const policyRejected = Number(commands?.policy_rejected || 0)
          const superseded = Number(commands?.superseded || 0)
          const actionableFailed = Number(commands?.actionable_failed || 0)
          operationsCommands = {
            status: staleProcessing > 0
              ? 'error'
              : actionableFailed > 0
                ? 'degraded'
                : 'healthy',
            processing: Number(commands?.processing || 0),
            failed,
            policyRejected,
            superseded,
            actionableFailed,
            staleProcessing,
            activation: {
              activeOrganizations: Number(commands?.active_organizations || 0),
              shadowOrganizations: Number(commands?.shadow_organizations || 0),
            },
          }
          if (staleProcessing > 0) {
            errors.push('Operations command receipts have stale processing commands.')
          }
          if (actionableFailed > 0) {
            warnings.push(
              'Operations command receipts have actionable failures available for review or retry.',
            )
          }
        }

        if (
          row?.toast_integrations_migration_applied
          && row?.quickbooks_connector_migration_applied
          && row?.demo_workspace_account_migration_applied
          && row?.quickbooks_write_control_migration_applied
          && row?.quickbooks_write_connection_binding_migration_applied
          && row?.pos_accounting_notifications_migration_applied
          && row?.quickbooks_write_binding_compatibility_migration_applied
          && row?.pos_accounting_notification_consent_migration_applied
          && row?.pos_accounting_date_commands_migration_applied
          && row?.pos_accounting_posting_outcomes_migration_applied
          && row?.external_pos_accounting_outcomes_migration_applied
        ) {
          const queueResult = await query<{
            toast_pending: number
            toast_failed: number
            toast_dead: number
            toast_stale_processing: number
            toast_overdue: number
            quickbooks_pending: number
            quickbooks_failed: number
            quickbooks_dead: number
            quickbooks_stale_processing: number
            quickbooks_overdue: number
            quickbooks_write_processing: number
            quickbooks_write_failed: number
            quickbooks_write_dead: number
            quickbooks_write_stale_processing: number
            quickbooks_write_unbound_active: number
            pos_notification_pending: number
            pos_notification_failed: number
            pos_notification_dead: number
            pos_notification_stale_processing: number
            pos_notification_overdue: number
          }>(
            `WITH toast_queue AS (
               SELECT
                 count(*) FILTER (WHERE job.status = 'pending')::integer AS pending,
                 count(*) FILTER (WHERE job.status = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE job.status = 'dead')::integer AS dead,
                 count(*) FILTER (
                   WHERE job.status = 'processing'
                     AND COALESCE(job.locked_at, job.updated_at) < now() - interval '15 minutes'
                 )::integer AS stale_processing,
                 count(*) FILTER (
                   WHERE job.status IN ('pending', 'failed')
                     AND job.available_at < now() - interval '15 minutes'
                 )::integer AS overdue
               FROM toast_sync_outbox job
               JOIN workspace_organizations organization ON organization.id = job.organization_id
               WHERE organization.is_demo = false
             ), quickbooks_queue AS (
               SELECT
                 count(*) FILTER (WHERE job.status = 'pending')::integer AS pending,
                 count(*) FILTER (WHERE job.status = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE job.status = 'dead')::integer AS dead,
                 count(*) FILTER (
                   WHERE job.status = 'processing'
                     AND COALESCE(job.locked_at, job.updated_at) < now() - interval '15 minutes'
                 )::integer AS stale_processing,
                 count(*) FILTER (
                   WHERE job.status IN ('pending', 'failed')
                     AND job.available_at < now() - interval '15 minutes'
                 )::integer AS overdue
               FROM quickbooks_sync_outbox job
               JOIN workspace_organizations organization ON organization.id = job.organization_id
               WHERE organization.is_demo = false
             ), quickbooks_write_queue AS (
               SELECT
                 count(*) FILTER (WHERE request.status = 'processing')::integer AS processing,
                 count(*) FILTER (WHERE request.status = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE request.status = 'dead')::integer AS dead,
                 count(*) FILTER (
                   WHERE request.status = 'processing'
                     AND COALESCE(request.locked_at, request.updated_at) < now() - interval '15 minutes'
                 )::integer AS stale_processing,
                 count(*) FILTER (
                   WHERE request.reviewed_maton_connection_id IS NULL
                     AND request.status NOT IN ('succeeded', 'cancelled')
                 )::integer AS unbound_active
               FROM quickbooks_write_requests request
               JOIN workspace_organizations organization ON organization.id = request.organization_id
               WHERE organization.is_demo = false
             ), pos_notification_queue AS (
               SELECT
                 count(*) FILTER (WHERE notification.status = 'pending')::integer AS pending,
                 count(*) FILTER (WHERE notification.status = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE notification.status = 'dead')::integer AS dead,
                 count(*) FILTER (
                   WHERE notification.status = 'processing'
                     AND notification.locked_at < now() - interval '15 minutes'
                 )::integer AS stale_processing,
                 count(*) FILTER (
                   WHERE notification.status IN ('pending', 'failed')
                     AND notification.available_at < now() - interval '15 minutes'
                 )::integer AS overdue
               FROM pos_accounting_notification_outbox notification
               JOIN pos_accounting_issue_states issue ON issue.id = notification.issue_state_id
               JOIN workspace_organizations organization ON organization.id = issue.organization_id
               WHERE organization.is_demo = false
             )
             SELECT
               toast_queue.pending AS toast_pending,
               toast_queue.failed AS toast_failed,
               toast_queue.dead AS toast_dead,
               toast_queue.stale_processing AS toast_stale_processing,
               toast_queue.overdue AS toast_overdue,
               quickbooks_queue.pending AS quickbooks_pending,
               quickbooks_queue.failed AS quickbooks_failed,
               quickbooks_queue.dead AS quickbooks_dead,
               quickbooks_queue.stale_processing AS quickbooks_stale_processing,
               quickbooks_queue.overdue AS quickbooks_overdue,
               quickbooks_write_queue.processing AS quickbooks_write_processing,
               quickbooks_write_queue.failed AS quickbooks_write_failed,
               quickbooks_write_queue.dead AS quickbooks_write_dead,
               quickbooks_write_queue.stale_processing AS quickbooks_write_stale_processing,
               quickbooks_write_queue.unbound_active AS quickbooks_write_unbound_active,
               pos_notification_queue.pending AS pos_notification_pending,
               pos_notification_queue.failed AS pos_notification_failed,
               pos_notification_queue.dead AS pos_notification_dead,
               pos_notification_queue.stale_processing AS pos_notification_stale_processing,
               pos_notification_queue.overdue AS pos_notification_overdue
             FROM toast_queue
             CROSS JOIN quickbooks_queue
             CROSS JOIN quickbooks_write_queue
             CROSS JOIN pos_notification_queue`,
          )
          const queue = queueResult.rows[0]
          const queueErrors = Number(queue?.toast_dead || 0)
            + Number(queue?.toast_stale_processing || 0)
            + Number(queue?.toast_overdue || 0)
            + Number(queue?.quickbooks_dead || 0)
            + Number(queue?.quickbooks_stale_processing || 0)
            + Number(queue?.quickbooks_overdue || 0)
            + Number(queue?.quickbooks_write_dead || 0)
            + Number(queue?.quickbooks_write_stale_processing || 0)
            + Number(queue?.quickbooks_write_unbound_active || 0)
            + Number(queue?.pos_notification_dead || 0)
            + Number(queue?.pos_notification_stale_processing || 0)
            + Number(queue?.pos_notification_overdue || 0)
          integrationQueues = {
            status: queueErrors > 0 ? 'error' : 'healthy',
            toast: {
              pending: Number(queue?.toast_pending || 0),
              failed: Number(queue?.toast_failed || 0),
              dead: Number(queue?.toast_dead || 0),
              staleProcessing: Number(queue?.toast_stale_processing || 0),
              overdue: Number(queue?.toast_overdue || 0),
            },
            quickBooks: {
              pending: Number(queue?.quickbooks_pending || 0),
              failed: Number(queue?.quickbooks_failed || 0),
              dead: Number(queue?.quickbooks_dead || 0),
              staleProcessing: Number(queue?.quickbooks_stale_processing || 0),
              overdue: Number(queue?.quickbooks_overdue || 0),
            },
            quickBooksWrites: {
              processing: Number(queue?.quickbooks_write_processing || 0),
              failed: Number(queue?.quickbooks_write_failed || 0),
              dead: Number(queue?.quickbooks_write_dead || 0),
              staleProcessing: Number(queue?.quickbooks_write_stale_processing || 0),
              unboundActive: Number(queue?.quickbooks_write_unbound_active || 0),
            },
            posAccountingNotifications: {
              pending: Number(queue?.pos_notification_pending || 0),
              failed: Number(queue?.pos_notification_failed || 0),
              dead: Number(queue?.pos_notification_dead || 0),
              staleProcessing: Number(queue?.pos_notification_stale_processing || 0),
              overdue: Number(queue?.pos_notification_overdue || 0),
            },
          }
          if (cloudProvider === 'railway') {
            if (Number(queue?.toast_dead || 0) > 0) errors.push('Toast sync queue has terminal failed jobs.')
            if (Number(queue?.toast_stale_processing || 0) > 0) errors.push('Toast sync queue has stale processing jobs.')
            if (Number(queue?.toast_overdue || 0) > 0) errors.push('Toast sync queue has overdue jobs.')
            if (Number(queue?.quickbooks_dead || 0) > 0) errors.push('QuickBooks sync queue has terminal failed jobs.')
            if (Number(queue?.quickbooks_stale_processing || 0) > 0) errors.push('QuickBooks sync queue has stale processing jobs.')
            if (Number(queue?.quickbooks_overdue || 0) > 0) errors.push('QuickBooks sync queue has overdue jobs.')
            if (Number(queue?.quickbooks_write_dead || 0) > 0) errors.push('QuickBooks write queue has terminal failed requests.')
            if (Number(queue?.quickbooks_write_stale_processing || 0) > 0) errors.push('QuickBooks write queue has stale processing requests.')
            if (Number(queue?.quickbooks_write_unbound_active || 0) > 0) errors.push('QuickBooks write queue has requests without a reviewed connection binding.')
            if (Number(queue?.pos_notification_dead || 0) > 0) errors.push('POS accounting notification queue has terminal failed deliveries.')
            if (Number(queue?.pos_notification_stale_processing || 0) > 0) errors.push('POS accounting notification queue has stale processing deliveries.')
            if (Number(queue?.pos_notification_overdue || 0) > 0) errors.push('POS accounting notification queue has overdue deliveries.')
          }
        }

        if (cloudProvider === 'railway') {
          const heartbeat = await readPipelineOutboxWorkerHeartbeatFromPostgres()
          const heartbeatAt = Date.parse(String(heartbeat?.checkedAt || ''))
          const pollMs = Math.max(1000, Math.min(Number(process.env.PIPELINE_OUTBOX_POLL_MS || 10000), 300000))
          const maxHeartbeatAgeMs = Math.max(90_000, pollMs * 3)
          const ageMs = Number.isFinite(heartbeatAt) ? checkedAt - heartbeatAt : null
          worker = {
            status: ageMs !== null && ageMs <= maxHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: heartbeat?.checkedAt || null,
            phase: heartbeat?.phase || null,
            ageMs,
          }
          if (ageMs === null || ageMs > maxHeartbeatAgeMs) {
            errors.push('Pipeline outbox worker heartbeat is missing or stale.')
          }

          if (crmEnabled) {
            const crmHeartbeat = await readSuiteCrmWorkerHeartbeat()
            const crmHeartbeatAt = Date.parse(String(crmHeartbeat?.checkedAt || ''))
            const crmAgeMs = Number.isFinite(crmHeartbeatAt) ? checkedAt - crmHeartbeatAt : null
            crm = {
              status: crmAgeMs !== null && crmAgeMs <= maxHeartbeatAgeMs ? 'reachable' : 'stale',
              heartbeatAt: crmHeartbeat?.checkedAt || null,
              phase: crmHeartbeat?.phase || null,
              ageMs: crmAgeMs,
            }
            if (crmAgeMs === null || crmAgeMs > maxHeartbeatAgeMs) {
              errors.push('SuiteCRM outbox worker heartbeat is missing or stale.')
            }
            if (
              suiteCrmNativeProductImageConfiguration.enabled
              && !suiteCrmNativeProductImageConfiguration.ready
            ) {
              warnings.push(
                'SuiteCRM native Product image projection is enabled but its dedicated media credentials, URLs, or credential separation are incomplete or invalid.',
              )
            } else if (suiteCrmNativeProductImageConfiguration.enabled) {
              const nativeImageProjection =
                await readSuiteCrmNativeProductImageProjectionHealthInPostgres()
              const projectionDegraded = nativeImageProjection.dead > 0
                || nativeImageProjection.retrying > 0
              suiteCrmNativeProductImageProjection = {
                status: projectionDegraded ? 'degraded' : 'ready',
                ...suiteCrmNativeProductImageConfiguration,
                ...nativeImageProjection,
              }
              if (nativeImageProjection.dead > 0) {
                warnings.push(
                  'SuiteCRM native Product image projection has terminal failed outbox work.',
                )
              }
              if (nativeImageProjection.retrying > 0) {
                warnings.push(
                  'SuiteCRM native Product image projection has retrying outbox work.',
                )
              }
            }
          }

          const agentHeartbeat = await readAgentDispatchWorkerHeartbeatFromPostgres()
          const agentHeartbeatAt = Date.parse(String(agentHeartbeat?.checkedAt || ''))
          const agentPollMs = Math.max(1000, Math.min(Number(process.env.AGENT_DISPATCH_POLL_MS || 5000), 300000))
          const maxAgentHeartbeatAgeMs = Math.max(240_000, agentPollMs * 3)
          const agentAgeMs = Number.isFinite(agentHeartbeatAt) ? checkedAt - agentHeartbeatAt : null
          agentWorker = {
            status: agentAgeMs !== null && agentAgeMs <= maxAgentHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: agentHeartbeat?.checkedAt || null,
            phase: agentHeartbeat?.phase || null,
            ageMs: agentAgeMs,
          }
          if (agentAgeMs === null || agentAgeMs > maxAgentHeartbeatAgeMs) {
            errors.push('Agent dispatch worker heartbeat is missing or stale.')
          }

          const researchHeartbeat = await readAgentResearchWorkerHeartbeatFromPostgres()
          const researchHeartbeatAt = Date.parse(String(researchHeartbeat?.checkedAt || ''))
          const researchPollMs = Math.max(5000, Math.min(Number(process.env.AGENT_RESEARCH_POLL_MS || 10000), 300000))
          const maxResearchHeartbeatAgeMs = Math.max(360_000, researchPollMs * 3)
          const researchAgeMs = Number.isFinite(researchHeartbeatAt) ? checkedAt - researchHeartbeatAt : null
          agentResearchWorker = {
            status: researchAgeMs !== null && researchAgeMs <= maxResearchHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: researchHeartbeat?.checkedAt || null,
            phase: researchHeartbeat?.phase || null,
            ageMs: researchAgeMs,
          }
          if (researchAgeMs === null || researchAgeMs > maxResearchHeartbeatAgeMs) {
            errors.push('Agent research worker heartbeat is missing or stale.')
          }

          const toastHeartbeat = await readToastWorkerHeartbeatFromPostgres()
          const toastHeartbeatAt = Date.parse(String(toastHeartbeat?.checkedAt || ''))
          const toastPollMs = Math.max(5000, Math.min(Number(process.env.TOAST_SYNC_POLL_MS || 15000), 300000))
          const maxToastHeartbeatAgeMs = Math.max(180_000, toastPollMs * 3)
          const toastAgeMs = Number.isFinite(toastHeartbeatAt) ? checkedAt - toastHeartbeatAt : null
          toastWorker = {
            status: toastAgeMs !== null && toastAgeMs <= maxToastHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: toastHeartbeat?.checkedAt || null,
            phase: toastHeartbeat?.phase || null,
            ageMs: toastAgeMs,
          }
          if (toastAgeMs === null || toastAgeMs > maxToastHeartbeatAgeMs) {
            errors.push('Toast sync worker heartbeat is missing or stale.')
          }

          const quickBooksHeartbeat = await readQuickBooksWorkerHeartbeatFromPostgres()
          const quickBooksHeartbeatAt = Date.parse(String(quickBooksHeartbeat?.checkedAt || ''))
          const quickBooksPollMs = Math.max(5000, Math.min(Number(process.env.QUICKBOOKS_SYNC_POLL_MS || 30000), 300000))
          const maxQuickBooksHeartbeatAgeMs = Math.max(180_000, quickBooksPollMs * 3)
          const quickBooksAgeMs = Number.isFinite(quickBooksHeartbeatAt) ? checkedAt - quickBooksHeartbeatAt : null
          quickBooksWorker = {
            status: quickBooksAgeMs !== null && quickBooksAgeMs <= maxQuickBooksHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: quickBooksHeartbeat?.checkedAt || null,
            phase: quickBooksHeartbeat?.phase || null,
            ageMs: quickBooksAgeMs,
          }
          if (quickBooksAgeMs === null || quickBooksAgeMs > maxQuickBooksHeartbeatAgeMs) {
            errors.push('QuickBooks sync worker heartbeat is missing or stale.')
          }

          if (
            commerceReadRuntimeAvailable()
            && row?.operations_commerce_catalog_sync_migration_applied
          ) {
            const commerceHeartbeat =
              await readCommerceCatalogWorkerHeartbeatFromPostgres()
            const commerceHeartbeatAt = Date.parse(
              String(commerceHeartbeat?.checkedAt || ''),
            )
            const commercePollMs = Math.max(
              5_000,
              Math.min(
                Number(
                  process.env.COMMERCE_CATALOG_SYNC_POLL_MS || 10_000,
                ),
                300_000,
              ),
            )
            const maxCommerceHeartbeatAgeMs = Math.max(
              180_000,
              commercePollMs * 3,
            )
            const commerceAgeMs = Number.isFinite(commerceHeartbeatAt)
              ? checkedAt - commerceHeartbeatAt
              : null
            const commerceQueue = (
              // The health view must use the same lane-specific account
              // authority as the worker. Historical work from a sandbox or a
              // disabled account remains visible separately, but cannot make
              // a production runtime unhealthy.
              await query<{
                queued: number
                retrying: number
                dead: number
                historical_dead: number
                stale_processing: number
                overdue: number
                orphaned_running_cursors: number
                unreconciled_shopify_accounts: number
                unreconciled_shopify_signals: string
                overdue_shopify_refreshes_without_active_job: number
              }>(
                `WITH catalog_jobs AS (
                   SELECT job.*,
                          EXISTS (
                            SELECT 1
                            FROM operations_integration_accounts account
                            JOIN operations_commerce_credentials credential
                              ON credential.organization_id = account.organization_id
                             AND credential.integration_account_id = account.id
                            JOIN operations_commerce_product_intake_policies policy
                              ON policy.organization_id = account.organization_id
                             AND policy.integration_account_id = account.id
                            JOIN operations_activation_scopes activation
                              ON activation.organization_id = account.organization_id
                            WHERE account.organization_id = job.organization_id
                              AND account.id = job.integration_account_id
                              AND account.integration_type = 'commerce'
                              AND account.provider = job.provider
                              AND ${commerceReadAccountSql('account')}
                              AND account.commerce_credential_generation
                                = job.credential_version
                              AND credential.credential_version
                                = job.credential_version
                              AND credential.verification_status = 'verified'
                              AND policy.policy_version
                                = 'commerce-product-intake-policy-v1'
                              AND policy.revision = job.policy_revision
                              AND activation.state IN ('shadow', 'active')
                              AND (
                                (
                                  account.provider = 'shopify'
                                  AND COALESCE(
                                    account.configuration->'grantedScopes',
                                    '[]'::jsonb
                                  ) ?| ARRAY[
                                    'read_products',
                                    'write_products'
                                  ]
                                )
                                OR (
                                  account.provider = 'faire'
                                  AND (
                                    credential.auth_mode = 'faire_brand_token'
                                    OR COALESCE(
                                      account.configuration->'requestedScopes',
                                      '[]'::jsonb
                                    ) ? 'READ_PRODUCTS'
                                  )
                                )
                              )
                          ) AS authoritative
                   FROM operations_commerce_catalog_sync_jobs job
                 ),
                 shopify_refresh AS (
                   SELECT
                     refresh.organization_id,
                     refresh.integration_account_id,
                     refresh.dirty_version,
                     refresh.reconciled_version,
                     refresh.last_signaled_at,
                     EXISTS (
                       SELECT 1
                       FROM operations_commerce_catalog_sync_jobs active
                       WHERE active.organization_id = refresh.organization_id
                         AND active.integration_account_id
                           = refresh.integration_account_id
                         AND active.status IN (
                           'pending', 'processing', 'failed'
                         )
                     ) AS active_job
                   FROM operations_shopify_catalog_refresh_states refresh
                   JOIN operations_integration_accounts account
                     ON account.organization_id = refresh.organization_id
                    AND account.id = refresh.integration_account_id
                   JOIN operations_commerce_credentials credential
                     ON credential.organization_id = account.organization_id
                    AND credential.integration_account_id = account.id
                   JOIN operations_commerce_product_intake_policies policy
                     ON policy.organization_id = account.organization_id
                    AND policy.integration_account_id = account.id
                   JOIN operations_activation_scopes activation
                     ON activation.organization_id = account.organization_id
                   WHERE account.integration_type = 'commerce'
                     AND account.provider = 'shopify'
                     AND ${commerceReadAccountSql('account')}
                     AND account.commerce_credential_generation
                       = refresh.credential_generation
                     AND credential.credential_version
                       = refresh.credential_generation
                     AND credential.verification_status = 'verified'
                     AND policy.policy_version
                       = 'commerce-product-intake-policy-v1'
                     AND activation.state IN ('shadow', 'active')
                     AND COALESCE(
                       account.configuration->'grantedScopes',
                       '[]'::jsonb
                     ) ?| ARRAY['read_products', 'write_products']
                 )
                 SELECT
                  count(*) FILTER (
                    WHERE status = 'pending' AND authoritative
                  )::integer AS queued,
                  count(*) FILTER (
                    WHERE status = 'failed' AND authoritative
                  )::integer AS retrying,
                   count(*) FILTER (
                     WHERE status = 'dead' AND authoritative
                   )::integer AS dead,
                   count(*) FILTER (
                     WHERE status = 'dead'
                   )::integer AS historical_dead,
                   count(*) FILTER (
                    WHERE status = 'processing'
                      AND authoritative
                      AND locked_at < now() - interval '10 minutes'
                   )::integer AS stale_processing,
                   count(*) FILTER (
                    WHERE status IN ('pending', 'failed')
                      AND authoritative
                      AND available_at < now() - interval '5 minutes'
                   )::integer AS overdue,
                   (
                    SELECT count(*)::integer
                    FROM operations_commerce_sync_cursors cursor
                    JOIN operations_integration_accounts account
                      ON account.organization_id = cursor.organization_id
                     AND account.id = cursor.integration_account_id
                    JOIN operations_commerce_credentials credential
                      ON credential.organization_id = account.organization_id
                     AND credential.integration_account_id = account.id
                    JOIN operations_commerce_product_intake_policies policy
                      ON policy.organization_id = account.organization_id
                     AND policy.integration_account_id = account.id
                    JOIN operations_activation_scopes activation
                      ON activation.organization_id = account.organization_id
                    WHERE cursor.resource = 'products'
                      AND cursor.reconciliation_status = 'running'
                      AND account.integration_type = 'commerce'
                      AND ${commerceReadAccountSql('account')}
                      AND credential.credential_version
                        = account.commerce_credential_generation
                      AND credential.verification_status = 'verified'
                      AND policy.policy_version
                        = 'commerce-product-intake-policy-v1'
                      AND activation.state IN ('shadow', 'active')
                      AND (
                        (
                          account.provider = 'shopify'
                          AND COALESCE(
                            account.configuration->'grantedScopes',
                            '[]'::jsonb
                          ) ?| ARRAY['read_products', 'write_products']
                        )
                        OR (
                          account.provider = 'faire'
                          AND (
                            credential.auth_mode = 'faire_brand_token'
                            OR COALESCE(
                              account.configuration->'requestedScopes',
                              '[]'::jsonb
                            ) ? 'READ_PRODUCTS'
                          )
                        )
                      )
                      AND NOT EXISTS (
                         SELECT 1
                         FROM operations_commerce_catalog_sync_jobs active
                         WHERE active.organization_id = cursor.organization_id
                           AND active.integration_account_id
                             = cursor.integration_account_id
                           AND active.status IN (
                             'pending', 'processing', 'failed'
                           )
                       )
                   ) AS orphaned_running_cursors,
                   (
                     SELECT count(*)::integer
                     FROM shopify_refresh refresh
                     WHERE refresh.dirty_version
                       > refresh.reconciled_version
                   ) AS unreconciled_shopify_accounts,
                   (
                     SELECT COALESCE(sum(
                       refresh.dirty_version - refresh.reconciled_version
                     ), 0)::text
                     FROM shopify_refresh refresh
                     WHERE refresh.dirty_version
                       > refresh.reconciled_version
                   ) AS unreconciled_shopify_signals,
                   (
                     SELECT count(*)::integer
                     FROM shopify_refresh refresh
                     WHERE refresh.dirty_version
                       > refresh.reconciled_version
                       AND refresh.active_job = false
                       AND refresh.last_signaled_at
                         < now() - interval '5 minutes'
                   ) AS overdue_shopify_refreshes_without_active_job
                 FROM catalog_jobs`,
              )
            ).rows[0]
            const dead = Number(commerceQueue?.dead || 0)
            const stale = Number(
              commerceQueue?.stale_processing || 0,
            )
            const overdue = Number(commerceQueue?.overdue || 0)
            const orphanedRunningCursors = Number(
              commerceQueue?.orphaned_running_cursors || 0,
            )
            const unreconciledShopifyAccounts = Number(
              commerceQueue?.unreconciled_shopify_accounts || 0,
            )
            const unreconciledShopifySignals = Number(
              commerceQueue?.unreconciled_shopify_signals || 0,
            )
            const overdueShopifyRefreshesWithoutActiveJob = Number(
              commerceQueue
                ?.overdue_shopify_refreshes_without_active_job || 0,
            )
            const loopReachable = (
              commerceAgeMs !== null
              && commerceAgeMs <= maxCommerceHeartbeatAgeMs
            )
            const operationalDegraded = (
              dead > 0
              || stale > 0
              || overdue > 0
              || orphanedRunningCursors > 0
              || overdueShopifyRefreshesWithoutActiveJob > 0
            )
            commerceCatalogWorker = {
              status: loopReachable
                ? (operationalDegraded ? 'degraded' : 'reachable')
                : 'stale',
              livenessStatus: loopReachable ? 'reachable' : 'stale',
              operationalStatus: operationalDegraded ? 'degraded' : 'ready',
              runtimeAuthority: commerceReadReconciliation,
              heartbeatAt: commerceHeartbeat?.checkedAt || null,
              phase: commerceHeartbeat?.phase || null,
              ageMs: commerceAgeMs,
              queued: Number(commerceQueue?.queued || 0),
              retrying: Number(commerceQueue?.retrying || 0),
              dead,
              historicalDead: Number(commerceQueue?.historical_dead || 0),
              staleProcessing: stale,
              overdue,
              orphanedRunningCursors,
              unreconciledShopifyAccounts,
              unreconciledShopifySignals,
              overdueShopifyRefreshesWithoutActiveJob,
            }
            if (
              commerceAgeMs === null
              || commerceAgeMs > maxCommerceHeartbeatAgeMs
            ) {
              errors.push(
                'Commerce catalog worker heartbeat is missing or stale.',
              )
            }
            if (dead > 0) {
              errors.push(
                'Commerce catalog queue has terminal failed jobs.',
              )
            }
            if (stale > 0) {
              errors.push(
                'Commerce catalog queue has stale processing jobs.',
              )
            }
            if (overdue > 0) {
              errors.push(
                'Commerce catalog queue has overdue jobs.',
              )
            }
            if (orphanedRunningCursors > 0) {
              errors.push(
                'Commerce catalog sync has running cursors without active jobs.',
              )
            }
            if (overdueShopifyRefreshesWithoutActiveJob > 0) {
              warnings.push(
                'Shopify catalog refresh has unreconciled webhook signals without an active reconciliation job.',
              )
            }
          }

          if (
            commerceReadRuntimeAvailable()
            && row?.operations_commerce_continuations_migration_applied
            && row?.operations_commerce_normalization_migration_applied
            && row?.operations_commerce_order_attention_kinds_applied
          ) {
            const orderHeartbeat =
              await readCommerceOrderReconciliationWorkerHeartbeatFromPostgres()
            const orderHeartbeatAt = Date.parse(
              String(orderHeartbeat?.checkedAt || ''),
            )
            const orderPollMs = Math.max(
              5_000,
              Math.min(
                Number(
                  process.env.COMMERCE_ORDER_RECONCILIATION_POLL_MS || 60_000,
                ),
                300_000,
              ),
            )
            const maxOrderHeartbeatAgeMs = Math.max(180_000, orderPollMs * 3)
            const orderAgeMs = Number.isFinite(orderHeartbeatAt)
              ? checkedAt - orderHeartbeatAt
              : null
            const orderState =
              await readCommerceOrderReconciliationHealthFromPostgres()
            const loopReachable = (
              orderAgeMs !== null
              && orderAgeMs <= maxOrderHeartbeatAgeMs
            )
            const operationalDegraded = (
              orderState.failed > 0
              || orderState.operatorAttentionRequired > 0
              || orderState.staleProcessing > 0
              || orderState.overdue > 0
              || canonicalOrderRevisionHealth?.status === 'degraded'
            )
            commerceOrderReconciliationWorker = {
              status: loopReachable
                ? (operationalDegraded ? 'degraded' : 'reachable')
                : 'stale',
              livenessStatus: loopReachable ? 'reachable' : 'stale',
              operationalStatus: operationalDegraded ? 'degraded' : 'ready',
              runtimeAuthority: commerceReadReconciliation,
              heartbeatAt: orderHeartbeat?.checkedAt || null,
              phase: orderHeartbeat?.phase || null,
              ageMs: orderAgeMs,
              automaticShopifyOrderPromotion:
                shopifyAutomaticOrderPromotionHealthSnapshot({
                  heartbeat:
                    orderHeartbeat?.automaticShopifyOrderPromotion,
                }),
              automaticFaireOrderPromotion:
                faireAutomaticOrderPromotionHealthSnapshot({
                  heartbeat:
                    orderHeartbeat?.automaticFaireOrderPromotion,
                }),
              automaticFaireExactRefresh:
                faireAutomaticExactRefreshHealthSnapshot(
                  orderHeartbeat?.automaticFaireExactRefresh,
                ),
              automaticFaireUnattributedAttention:
                faireUnattributedAttentionHealthSnapshot(
                  orderHeartbeat?.automaticFaireUnattributedAttention,
                ),
              canonicalOrderRevisions: {
                status: canonicalOrderRevisionHealth?.status
                  || 'migration-pending',
                heartbeat: orderHeartbeat?.canonicalOrderRevisions || null,
                durable: canonicalOrderRevisionHealth,
              },
              ...orderState,
            }
            if (!loopReachable) {
              errors.push(
                'Commerce order reconciliation worker heartbeat is missing or stale.',
              )
            }
            if (orderState.failed > 0) {
              warnings.push(
                'Commerce order reconciliation has failed accounts.',
              )
            }
            if (
              orderState.providerPromotionAttentionRequired.shopify > 0
            ) {
              warnings.push(
                'Shopify provider reads completed, but clean-path automatic local order promotion needs operator attention.',
              )
            }
            if (orderState.providerPromotionAttentionRequired.faire > 0) {
              warnings.push(
                'Faire provider reads completed, but automatic local order promotion needs operator attention.',
              )
            }
            if (orderState.faireExactRefreshAttentionRequired > 0) {
              warnings.push(
                'Faire exact order refresh needs operator attention.',
              )
            }
            if (orderState.faireUnattributedAttentionRequired > 0) {
              warnings.push(
                'Legacy Faire order attention needs operator review; its original subtype is unavailable.',
              )
            }
            if (orderState.staleProcessing > 0) {
              warnings.push(
                'Commerce order reconciliation has stale processing accounts.',
              )
            }
            if (orderState.overdue > 0) {
              warnings.push(
                'Commerce order reconciliation has overdue accounts.',
              )
            }
            if (canonicalOrderRevisionHealth?.summary.failed) {
              warnings.push(
                'Canonical commerce order revision checks have retryable failures.',
              )
            }
            if (canonicalOrderRevisionHealth?.summary.deadLetter) {
              warnings.push(
                'Canonical commerce order revision checks have terminal failed targets.',
              )
            }
            if (
              canonicalOrderRevisionHealth?.summary.materialReviewRequired
            ) {
              warnings.push(
                'Canonical Shopify or Faire order revisions require manager review.',
              )
            }
            if (canonicalOrderRevisionHealth?.summary.overdue) {
              warnings.push(
                'Canonical commerce order revision checks are overdue.',
              )
            }
            if (canonicalOrderRevisionHealth?.summary.stale) {
              warnings.push(
                'Canonical commerce order revision coverage is stale or has not completed.',
              )
            }
          }

          if (
            commerceReadRuntimeAvailable()
            && row?.operations_shopify_inventory_refresh_migration_applied
            && row?.operations_shopify_inventory_webhook_refresh_applied
            && row?.operations_shopify_catalog_webhook_refresh_applied
            && row?.operations_commerce_pack_evidence_fingerprint_applied
            && row?.shopify_active_account_readiness_migration_applied
            && row?.operations_commerce_inventory_attempt_lease_renewal_applied
          ) {
            const inventoryHeartbeat =
              await readShopifyInventoryRefreshWorkerHeartbeatFromPostgres()
            const inventoryHeartbeatAt = Date.parse(
              String(inventoryHeartbeat?.checkedAt || ''),
            )
            const inventoryPollMs = Math.max(
              5_000,
              Math.min(
                Number(
                  process.env.SHOPIFY_INVENTORY_REFRESH_POLL_MS || 10_000,
                ),
                300_000,
              ),
            )
            const maxInventoryHeartbeatAgeMs = Math.max(
              180_000,
              inventoryPollMs * 3,
            )
            const inventoryAgeMs = Number.isFinite(inventoryHeartbeatAt)
              ? checkedAt - inventoryHeartbeatAt
              : null
            const inventoryQueue =
              await readShopifyInventoryRefreshHealthFromPostgres()
            const loopReachable = (
              inventoryAgeMs !== null
              && inventoryAgeMs <= maxInventoryHeartbeatAgeMs
            )
            const operationalDegraded = (
              inventoryQueue.currentDead > 0
              || inventoryQueue.staleProcessing > 0
              || inventoryQueue.overdue > 0
              || inventoryQueue.staleAccounts > 0
              || inventoryQueue.retrying > 0
            )
            shopifyInventoryRefreshWorker = {
              status: loopReachable
                ? (operationalDegraded ? 'degraded' : 'reachable')
                : 'stale',
              livenessStatus: loopReachable ? 'reachable' : 'stale',
              operationalStatus: operationalDegraded ? 'degraded' : 'ready',
              runtimeAuthority: commerceReadReconciliation,
              heartbeatAt: inventoryHeartbeat?.checkedAt || null,
              phase: inventoryHeartbeat?.phase || null,
              ageMs: inventoryAgeMs,
              ...inventoryQueue,
            }
            if (
              inventoryAgeMs === null
              || inventoryAgeMs > maxInventoryHeartbeatAgeMs
            ) {
              errors.push(
                'Shopify inventory refresh worker heartbeat is missing or stale.',
              )
            }
            if (inventoryQueue.currentDead > 0) {
              warnings.push(
                'Shopify inventory refresh queue has terminal failed jobs.',
              )
            }
            if (inventoryQueue.staleProcessing > 0) {
              warnings.push(
                'Shopify inventory refresh queue has stale processing jobs.',
              )
            }
            if (inventoryQueue.overdue > 0) {
              warnings.push(
                'Shopify inventory refresh queue has overdue jobs.',
              )
            }
            if (inventoryQueue.staleAccounts > 0) {
              warnings.push(
                'Checkout-ready Shopify accounts have stale inventory evidence.',
              )
            }
            if (inventoryQueue.retrying > 0) {
              warnings.push(
                'Shopify inventory refresh jobs are retrying.',
              )
            }
          }

          if (
            commerceReadRuntimeAvailable()
            && row?.operations_faire_inventory_polling_applied
          ) {
            const faireHeartbeat =
              await readFaireInventoryPollWorkerHeartbeatFromPostgres()
            const faireHeartbeatAt = Date.parse(
              String(faireHeartbeat?.checkedAt || ''),
            )
            const sharedInventoryPollMs = Math.max(
              5_000,
              Math.min(
                Number(
                  process.env.SHOPIFY_INVENTORY_REFRESH_POLL_MS || 10_000,
                ),
                300_000,
              ),
            )
            const maxFaireHeartbeatAgeMs = Math.max(
              180_000,
              sharedInventoryPollMs * 3,
            )
            const faireAgeMs = Number.isFinite(faireHeartbeatAt)
              ? checkedAt - faireHeartbeatAt
              : null
            const faireQueue =
              await readFaireInventoryPollHealthFromPostgres()
            const loopReachable = (
              faireAgeMs !== null
              && faireAgeMs <= maxFaireHeartbeatAgeMs
            )
            const operationalDegraded = (
              faireQueue.dead > 0
              || faireQueue.staleLeases > 0
              || faireQueue.overdueAccounts > 0
              || faireQueue.retrying > 0
            )
            faireInventoryPollWorker = {
              status: loopReachable
                ? (operationalDegraded ? 'degraded' : 'reachable')
                : 'stale',
              livenessStatus: loopReachable ? 'reachable' : 'stale',
              operationalStatus: operationalDegraded ? 'degraded' : 'ready',
              runtimeAuthority: commerceReadReconciliation,
              heartbeatAt: faireHeartbeat?.checkedAt || null,
              phase: faireHeartbeat?.phase || null,
              ageMs: faireAgeMs,
              ...faireQueue,
            }
            if (!loopReachable) {
              errors.push(
                'Faire inventory observation worker heartbeat is missing or stale.',
              )
            }
            if (faireQueue.dead > 0) {
              warnings.push(
                'Faire inventory observation has terminal failed accounts requiring reviewed recovery.',
              )
            }
            if (faireQueue.staleLeases > 0) {
              warnings.push(
                'Faire inventory observation has stale processing leases.',
              )
            }
            if (faireQueue.overdueAccounts > 0) {
              warnings.push(
                'Faire inventory observations are overdue.',
              )
            }
            if (faireQueue.retrying > 0) {
              warnings.push(
                'Faire inventory observation jobs are retrying.',
              )
            }
            if (faireQueue.oauthScopeHintMissingAccounts > 0) {
              warnings.push(
                'Faire OAuth accounts that did not request READ_INVENTORIES cannot schedule inventory observation polling.',
              )
            }
          }

          if (
            commerceReadRuntimeAvailable()
            && row?.operations_commerce_product_image_imports_applied
            && row?.operations_commerce_product_image_fanout_applied
            && row?.operations_commerce_product_image_source_normalization_applied
          ) {
            const imageQueue =
              await readCommerceProductImageImportQueueHealthInPostgres()
            const imageHeartbeatAt = Date.parse(
              String(imageQueue.heartbeat?.checkedAt || ''),
            )
            const imagePollMs = Math.max(
              5_000,
              Math.min(
                Number(
                  process.env.COMMERCE_PRODUCT_IMAGE_IMPORT_POLL_MS || 15_000,
                ),
                300_000,
              ),
            )
            const maxImageHeartbeatAgeMs = Math.max(
              180_000,
              imagePollMs * 3,
            )
            const imageAgeMs = Number.isFinite(imageHeartbeatAt)
              ? checkedAt - imageHeartbeatAt
              : null
            const imageProgressAt = Date.parse(
              String(imageQueue.lastTerminalProgressAt || ''),
            )
            const imageProgressAgeMs = Number.isFinite(imageProgressAt)
              ? checkedAt - imageProgressAt
              : null
            const loopReachable = (
              imageAgeMs !== null
              && imageAgeMs <= maxImageHeartbeatAgeMs
            )
            const maxImageProgressAgeMs = Math.max(
              90_000,
              imagePollMs * 4,
            )
            const {
              activelyDraining,
              stalledOverdue,
              operationalDegraded,
            } = classifyCommerceProductImageImportOperationalHealth({
              deadCount: imageQueue.deadCount,
              staleLeaseCount: imageQueue.staleLeaseCount,
              overdueCount: imageQueue.overdueCount,
              retryCount: imageQueue.retryCount,
              heartbeatPhase: imageQueue.heartbeat?.phase,
              loopReachable,
              progressAgeMs: imageProgressAgeMs,
              maxProgressAgeMs: maxImageProgressAgeMs,
            })
            commerceProductImageImportWorker = {
              status: loopReachable
                ? (operationalDegraded ? 'degraded' : 'reachable')
                : 'stale',
              livenessStatus: loopReachable ? 'reachable' : 'stale',
              operationalStatus: operationalDegraded ? 'degraded' : 'ready',
              runtimeAuthority: commerceReadReconciliation,
              heartbeatAt: imageQueue.heartbeat?.checkedAt || null,
              phase: imageQueue.heartbeat?.phase || null,
              ageMs: imageAgeMs,
              waitingMapping: imageQueue.waitingMappingCount,
              queued: imageQueue.queuedCount,
              retrying: imageQueue.retryCount,
              claimed: imageQueue.claimedCount,
              dead: imageQueue.deadCount,
              historicalDead: imageQueue.historicalDeadCount,
              staleLeases: imageQueue.staleLeaseCount,
              overdue: imageQueue.overdueCount,
              activelyDraining,
              stalledOverdue,
              lastTerminalProgressAt: imageQueue.lastTerminalProgressAt,
              progressAgeMs: imageProgressAgeMs,
            }
            if (!loopReachable) {
              errors.push(
                'Commerce product image import worker heartbeat is missing or stale.',
              )
            }
            if (imageQueue.deadCount > 0) {
              warnings.push(
                'Commerce product image import queue has terminal failed jobs.',
              )
            }
            if (imageQueue.staleLeaseCount > 0) {
              warnings.push(
                'Commerce product image import queue has stale claimed jobs.',
              )
            }
            if (stalledOverdue) {
              warnings.push(
                'Commerce product image import queue has overdue jobs and is not making recent progress.',
              )
            }
            if (imageQueue.retryCount > 0) {
              warnings.push(
                'Commerce product image import jobs are retrying.',
              )
            }
            if (imageQueue.heartbeat?.phase === 'degraded') {
              warnings.push(
                'Commerce product image import worker reported a degraded pass.',
              )
            }
          }

          if (row?.operations_faire_product_image_projection_applied) {
            const projectionHealth =
              await readFaireProductImageProjectionHealthInPostgres()
            const pending = Number(projectionHealth.counts.pending || 0)
            const claimed = Number(projectionHealth.counts.claimed || 0)
            const expiredClaimed = Number(
              projectionHealth.expiredClaimed || 0,
            )
            const historicalUnknown = Number(
              projectionHealth.counts.unknown || 0,
            )
            const historicalFailed = Number(
              projectionHealth.counts.failed || 0,
            )
            const unknown = Number(
              projectionHealth.unresolvedCounts.unknown || 0,
            )
            const failed = Number(
              projectionHealth.unresolvedCounts.failed || 0,
            )
            faireProductImageProjection = {
              status: claimed > 0 || unknown > 0 || failed > 0
                ? 'degraded'
                : 'ready',
              pending,
              claimed,
              claimedInFlight: Math.max(0, claimed - expiredClaimed),
              expiredClaimed,
              simulated: Number(
                projectionHealth.counts.simulated || 0,
              ),
              succeeded: Number(
                projectionHealth.counts.succeeded || 0,
              ),
              failed,
              unknown,
              historical: {
                failed: historicalFailed,
                unknown: historicalUnknown,
              },
              latestResultAt: projectionHealth.latestAt,
            }
            if (claimed > expiredClaimed) {
              warnings.push(
                'Faire Product-image publication has in-flight claimed effects.',
              )
            }
            if (expiredClaimed > 0) {
              warnings.push(
                'Faire Product-image publication has expired claims ready for terminal no-replay reconciliation.',
              )
            }
            if (unknown > 0) {
              warnings.push(
                'Faire Product-image publication has terminal unknown outcomes requiring provider readback.',
              )
            }
            if (failed > 0) {
              warnings.push(
                'Faire Product-image publication has failed effects requiring operator review.',
              )
            }
          }

          if (row?.suitecrm_product_image_reverse_ingestion_applied) {
            if (
              suiteCrmProductImageConfiguration.enabled
              && !suiteCrmProductImageConfiguration.ready
            ) {
              suiteCrmProductImageIngestion = {
                ...suiteCrmProductImageIngestion,
                status: 'unavailable',
              }
              warnings.push(
                'SuiteCRM Product image reverse ingestion is enabled but its dedicated read-only credentials or ACL attestation are incomplete or invalid.',
              )
            } else if (suiteCrmProductImageConfiguration.enabled) {
              const imageIngestion =
                await readSuiteCrmProductImageIngestionHealthInPostgres()
              const imageIngestionHeartbeatAt = Date.parse(
                String(imageIngestion.heartbeat?.checkedAt || ''),
              )
              const imageIngestionPollMs = Math.max(
                5_000,
                Math.min(
                  Number(process.env.CRM_INTEGRATION_POLL_MS || 30_000),
                  300_000,
                ),
              )
              const imageIngestionAgeMs = Number.isFinite(
                imageIngestionHeartbeatAt,
              ) ? checkedAt - imageIngestionHeartbeatAt : null
              const imageIngestionReachable = (
                imageIngestionAgeMs !== null
                && imageIngestionAgeMs <= Math.max(
                  180_000,
                  imageIngestionPollMs * 3,
                )
              )
              const imageIngestionDegraded = (
                imageIngestion.heartbeat?.phase === 'degraded'
              )
              suiteCrmProductImageIngestion = {
                status: imageIngestionReachable
                  ? (imageIngestionDegraded ? 'degraded' : 'reachable')
                  : 'unavailable',
                enabled: true,
                ready: true,
                missing: [],
                invalid: [],
                credentialConflicts: [],
                aclAttestation:
                  suiteCrmProductImageConfiguration.aclAttestation,
                requiredAcl: suiteCrmProductImageConfiguration.acl,
                heartbeatAt: imageIngestion.heartbeat?.checkedAt || null,
                phase: imageIngestion.heartbeat?.phase || null,
                currentPass: imageIngestion.heartbeat?.details || {},
                ageMs: imageIngestionAgeMs,
                observations: imageIngestion.observations,
                importedPrimary: imageIngestion.importedPrimary,
                importedSecondary: imageIngestion.importedSecondary,
                echoesSuppressed: imageIngestion.echoesSuppressed,
                identityConflicts: imageIngestion.identityConflicts,
                mediaIntegrityConflicts:
                  imageIngestion.mediaIntegrityConflicts,
                lastObservedAt: imageIngestion.lastObservedAt,
                providerWrites: imageIngestion.providerWrites,
              }
              if (!imageIngestionReachable) {
                warnings.push(
                  'SuiteCRM Product image reverse ingestion is unavailable because its worker heartbeat is missing or stale.',
                )
              }
              if (imageIngestionDegraded) {
                warnings.push(
                  'SuiteCRM Product image reverse ingestion has a current sweep error or conflict for review.',
                )
              }
            }
          }

          const knowledgeResult = await query<{
            worker_name: string
            checked_at: string
            phase: string
            details: Record<string, unknown>
          }>(
            `SELECT worker_name, checked_at::text, phase, details FROM knowledge_worker_heartbeat ORDER BY worker_name`,
          )
          const radarPollMs = Math.max(60_000, Math.min(Number(process.env.AI_RADAR_POLL_MS || 3_600_000), 86_400_000))
          const embeddingPollMs = Math.max(5_000, Math.min(Number(process.env.DOCUMENT_EMBEDDING_POLL_MS || 15_000), 300_000))
          knowledgeWorkers = knowledgeResult.rows.map((row) => {
            const ageMs = checkedAt - Date.parse(row.checked_at)
            const maxAgeMs = row.worker_name === 'ai-radar'
              ? Math.max(120_000, radarPollMs * 2)
              : Math.max(90_000, embeddingPollMs * 3)
            const fresh = Number.isFinite(ageMs) && ageMs <= maxAgeMs
            return {
              name: row.worker_name,
              status: fresh ? 'reachable' : 'stale',
              phase: row.phase,
              heartbeatAt: row.checked_at,
              ageMs: Number.isFinite(ageMs) ? ageMs : null,
              maxAgeMs,
              details: row.details,
            }
          })
          for (const expectedWorker of ['ai-radar', 'document-embeddings']) {
            const workerStatus = knowledgeWorkers.find((entry) => entry.name === expectedWorker)
            if (!workerStatus) errors.push(`${expectedWorker} worker heartbeat is missing.`)
            else if (workerStatus.status === 'stale') errors.push(`${expectedWorker} worker heartbeat is stale.`)
            else if (workerStatus.phase === 'failed') errors.push(`${expectedWorker} worker reported a failure.`)
            else if (workerStatus.phase === 'degraded') warnings.push(`${expectedWorker} worker is degraded.`)
            if (expectedWorker === 'document-embeddings') {
              const details = workerStatus?.details && typeof workerStatus.details === 'object'
                ? workerStatus.details as Record<string, unknown>
                : {}
              const backlog = details.backlog && typeof details.backlog === 'object'
                ? details.backlog as Record<string, unknown>
                : {}
              if (Number(backlog.terminalFailed || 0) > 0 && workerStatus?.phase !== 'failed') {
                errors.push('document-embeddings worker has terminal failed jobs.')
              }
            }
          }
        }
      } catch (error) {
        database = {
          status: 'unreachable',
        }
        console.error('[health] Postgres health check failed', error)
        errors.push('Postgres is unreachable.')
      }
    } else {
      errors.push('Hosted runtime database is not configured.')
    }

    return NextResponse.json({
      status: errors.length > 0 ? 'error' : 'ok',
      errors,
      warnings,
      runtime: cloudProvider || 'hosted',
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.VERCEL_ENV || null,
      storage,
      database,
      credentialStore,
      worker,
      agentWorker,
      agentResearchWorker,
      toastWorker,
      quickBooksWorker,
      commerceReadReconciliation,
      commerceRevisionEvidence,
      commerceCatalogWorker,
      commerceOrderReconciliationWorker,
      commerceOrderHistory,
      shopifyOrderManagement,
      shopifyInventoryRefreshWorker,
      shopifyWebhookReceipts,
      faireInventoryPollWorker,
      commerceProductImageImportWorker,
      faireProductImageProjection,
      suiteCrmNativeProductImageProjection,
      suiteCrmProductImageIngestion,
      fulfillmentOptimizer,
      integrationQueues,
      operationsCommands,
      crm,
      knowledgeWorkers,
      capabilities: {
        openClawExecution: process.env.CLAWPILOT_EXECUTION_ENABLED === '1',
        agentRuntime: getAgentRuntime(),
        semanticDocumentSearch: embeddingProvider === 'openai',
        vectorDocumentSearch: true,
        aiRadar: process.env.AI_RADAR_ENABLED !== 'false',
        shortLinks: true,
        crm: process.env.CRM_ENABLED === '1',
        toast: true,
        quickBooks: true,
        repositoryRunner: {
          enabled: repositoryRunner.enabled,
          ready: repositoryRunner.ready,
          reason: repositoryRunner.reason,
          repository: repositoryRunner.repositoryFullName,
          baseBranch: repositoryRunner.baseBranch,
          patchOnly: true,
        },
      },
      checkedAt,
    }, { status: errors.length > 0 ? 503 : 200 })
  }

  const logSource = resolveLogPath()

  try {
    const stat = fs.statSync(logSource.path)
    if (checkedAt - stat.mtimeMs > WINDOW_MS) {
      return NextResponse.json({
        status: logSource.usedFallback ? 'degraded' : 'ok',
        errors: [],
        warnings: logSource.usedFallback ? ['Expected dev log missing; using fallback runtime log.'] : [],
        logPath: logSource.path,
        expectedDevLogPresent: logSource.expectedDevLogPresent,
        usedFallbackLog: logSource.usedFallback,
        lastModified: stat.mtimeMs,
        checkedAt,
      })
    }

    const raw = readLogTailUtf8(logSource.path, MAX_BYTES_TO_SCAN)
    const lines = raw.split('\n')

    const startupIndex = lines.reduce((latest, line, index) => (
      line.includes('Ready in') || line.includes('Starting...') ? index : latest
    ), -1)
    const recent = (startupIndex >= 0 ? lines.slice(startupIndex) : lines).slice(-200)
    const errors = recent.filter(l => ERROR_PATTERNS.some(p => p.test(l)))

    return NextResponse.json({
      status: errors.length > 0 ? 'error' : (logSource.usedFallback ? 'degraded' : 'ok'),
      errors: errors.slice(-10), // last 10 errors
      warnings: logSource.usedFallback ? ['Expected dev log missing; using fallback runtime log.'] : [],
      logPath: logSource.path,
      expectedDevLogPresent: logSource.expectedDevLogPresent,
      usedFallbackLog: logSource.usedFallback,
      lastModified: stat.mtimeMs,
      checkedAt,
      scannedBytes: Math.min(stat.size, MAX_BYTES_TO_SCAN),
    })
  } catch {
    return NextResponse.json({
      status: 'degraded',
      errors: [],
      warnings: ['Unable to read expected runtime log. Health is best-effort only.'],
      logPath: logSource.path,
      expectedDevLogPresent: logSource.expectedDevLogPresent,
      usedFallbackLog: logSource.usedFallback,
      checkedAt,
    })
  }
}
