import crypto from 'crypto'
import { recordAuditEvent } from '@/lib/auditWriter'
import type {
  QuickBooksAccount,
  QuickBooksAttachment,
  QuickBooksClass,
  QuickBooksCompanyInfo,
  QuickBooksCustomer,
  QuickBooksDepartment,
  QuickBooksFinancialReportSnapshot,
  QuickBooksItem,
  QuickBooksTaxCode,
  QuickBooksTransaction,
  QuickBooksVendor,
} from '@/lib/integrations/quickBooksClient'
import { acquireTransactionAdvisoryLock, query, withTransaction } from '@/lib/persistence/postgres'

export const QUICKBOOKS_MAPPING_KEYS = [
  'gross_sales', 'discounts', 'voids', 'refunds', 'taxes', 'tips', 'service_charges',
  'gift_cards', 'cash', 'card', 'other_tender', 'payouts', 'fees', 'over_short',
] as const

export type QuickBooksMappingKey = typeof QUICKBOOKS_MAPPING_KEYS[number]

export type QuickBooksSyncJob = {
  id: string
  organizationId: string
  ownerEmail: string
  connectionId: string
  attemptCount: number
  maxAttempts: number
  lockToken: string
}

function safeError(value: unknown) {
  return String(value || 'QuickBooks sync failed').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1000)
}

type TransactionClient = Parameters<Parameters<typeof withTransaction>[0]>[0]

type QuickBooksConnectionBindingRow = {
  maton_connection_id: string
  company_name: string
  country: string | null
}

type CancelledQuickBooksWriteRow = {
  id: string
  operation_kind: string
  previous_status: string
  provider_request_id: string
  request_fingerprint: string
}

async function assertNoProcessingQuickBooksWrites(client: TransactionClient, organizationId: string) {
  const processing = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM quickbooks_write_requests
       WHERE organization_id = $1::uuid AND status = 'processing'
     ) AS exists`,
    [organizationId],
  )
  if (processing.rows[0]?.exists) {
    throw new Error('Wait for the in-progress QuickBooks write to finish before changing the connection')
  }
}

async function cancelUnpostedQuickBooksWrites(input: {
  client: TransactionClient
  organizationId: string
  actorEmail: string
  reason: 'connection_rebound' | 'connection_disconnected'
}) {
  const errorCode = input.reason === 'connection_rebound'
    ? 'QUICKBOOKS_WRITE_CONNECTION_REBOUND'
    : 'QUICKBOOKS_WRITE_CONNECTION_DISCONNECTED'
  const errorMessage = input.reason === 'connection_rebound'
    ? 'Accounting change cancelled because the reviewed QuickBooks connection was replaced.'
    : 'Accounting change cancelled because QuickBooks was disconnected.'
  const cancelled = await input.client.query<CancelledQuickBooksWriteRow>(
    `WITH cancellable AS (
       SELECT id, status AS previous_status
       FROM quickbooks_write_requests
       WHERE organization_id = $1::uuid
         AND status IN ('draft', 'pending_approval', 'approved', 'failed', 'dead')
       FOR UPDATE
     )
     UPDATE quickbooks_write_requests request SET
       status = 'cancelled', cancelled_by = lower($2), cancelled_at = COALESCE(request.cancelled_at, now()),
       locked_at = NULL, locked_by = NULL, lock_token = NULL,
       last_error_code = $3, last_error_message = $4, updated_at = now()
     FROM cancellable
     WHERE request.id = cancellable.id
     RETURNING request.id::text, request.operation_kind, cancellable.previous_status,
       request.provider_request_id, request.request_fingerprint`,
    [input.organizationId, input.actorEmail, errorCode, errorMessage],
  )
  for (const request of cancelled.rows) {
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'quickbooks.write.cancelled',
      aggregateType: 'quickbooks_write_request',
      aggregateId: request.id,
      organizationId: input.organizationId,
      payload: {
        operationKind: request.operation_kind,
        previousStatus: request.previous_status,
        requestStatus: 'cancelled',
        providerRequestId: request.provider_request_id,
        requestFingerprint: request.request_fingerprint,
        reason: input.reason,
      },
    }, input.client)
  }
  return cancelled.rowCount || 0
}

async function invalidatePosAccountingQuickBooksBinding(input: {
  client: TransactionClient
  organizationId: string
  actorEmail: string
}) {
  const currentProfiles = await input.client.query<{ id: string }>(
    `SELECT id::text
     FROM pos_accounting_profiles
     WHERE organization_id = $1::uuid AND effective_to IS NULL
     ORDER BY restaurant_guid NULLS FIRST, profile_revision
     FOR UPDATE`,
    [input.organizationId],
  )
  for (const profile of currentProfiles.rows) {
    await input.client.query(
      `UPDATE pos_accounting_profiles SET effective_to = clock_timestamp()
       WHERE id = $1::uuid AND effective_to IS NULL`,
      [profile.id],
    )
    await input.client.query(
      `INSERT INTO pos_accounting_profiles (
         organization_id, restaurant_guid, profile_revision, schema_version,
         quickbooks_binding_status, quickbooks_connection_fingerprint,
         quickbooks_company_name, quickbooks_connection_verified_at, quickbooks_catalog_synced_at,
         posting_method, quickbooks_class_id, quickbooks_class_name,
         quickbooks_department_id, quickbooks_department_name,
         quickbooks_customer_id, quickbooks_customer_name,
         quickbooks_clearing_account_id, quickbooks_clearing_account_name,
         track_sales_tax, breakout_dimensions, memo_mode, custom_memo,
         custom_transaction_number, transaction_number_suffix,
         suppress_zero_over_short, auto_payout_tips, deposit_checks_with_cash,
         open_check_policy, batch_hold_policy, created_by
       )
       SELECT previous.organization_id, previous.restaurant_guid,
         (SELECT COALESCE(MAX(candidate.profile_revision), 0)::integer + 1
          FROM pos_accounting_profiles candidate
          WHERE candidate.organization_id = previous.organization_id
            AND candidate.restaurant_guid IS NOT DISTINCT FROM previous.restaurant_guid),
         previous.schema_version,
         'unbound', NULL, NULL, NULL, NULL,
         previous.posting_method, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         previous.track_sales_tax, previous.breakout_dimensions, previous.memo_mode, previous.custom_memo,
         previous.custom_transaction_number, previous.transaction_number_suffix,
         previous.suppress_zero_over_short, previous.auto_payout_tips, previous.deposit_checks_with_cash,
         previous.open_check_policy, previous.batch_hold_policy, lower($2)
       FROM pos_accounting_profiles previous
       WHERE previous.id = $1::uuid`,
      [profile.id, input.actorEmail],
    )
  }
  const invalidatedMappings = await input.client.query<{ id: string }>(
    `UPDATE pos_accounting_catalog_mappings SET effective_to = clock_timestamp()
     WHERE organization_id = $1::uuid AND effective_to IS NULL
     RETURNING id::text`,
    [input.organizationId],
  )
  return {
    profileCount: currentProfiles.rowCount || 0,
    mappingCount: invalidatedMappings.rowCount || 0,
  }
}

export async function readQuickBooksIntegrationStateFromPostgres(organizationId: string) {
  const [connection, counts, accounts, items, locations, mappings, drafts, job] = await Promise.all([
    query<{
      company_name: string
      country: string | null
      status: string
      catalog_sync_enabled: boolean
      verified_at: string
      last_catalog_synced_at: string | null
      last_error_code: string | null
      credential_owner_email: string
      crm_pipeline_id: string | null
      crm_customer_sync_enabled: boolean
      crm_product_sync_enabled: boolean
      last_crm_synced_at: string | null
      last_crm_sync_error: string | null
    }>(
      `SELECT company_name, country, status, catalog_sync_enabled,
         verified_at::text, last_catalog_synced_at::text, last_error_code, credential_owner_email,
         crm_pipeline_id::text, crm_customer_sync_enabled, crm_product_sync_enabled,
         last_crm_synced_at::text, last_crm_sync_error
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid LIMIT 1`,
      [organizationId],
    ),
    query<{
      accounts: string; items: string; customers: string; vendors: string
      classes: string; departments: string; tax_codes: string
      transactions: string; attachments: string; reports: string
    }>(
      `SELECT
         (SELECT count(*) FROM quickbooks_accounts WHERE organization_id = $1::uuid)::text AS accounts,
         (SELECT count(*) FROM quickbooks_items WHERE organization_id = $1::uuid)::text AS items,
         (SELECT count(*) FROM quickbooks_customers WHERE organization_id = $1::uuid)::text AS customers,
         (SELECT count(*) FROM quickbooks_vendors WHERE organization_id = $1::uuid)::text AS vendors,
         (SELECT count(*) FROM quickbooks_classes WHERE organization_id = $1::uuid)::text AS classes,
         (SELECT count(*) FROM quickbooks_departments WHERE organization_id = $1::uuid)::text AS departments,
         (SELECT count(*) FROM quickbooks_tax_codes WHERE organization_id = $1::uuid)::text AS tax_codes,
         (SELECT count(*) FROM quickbooks_transactions WHERE organization_id = $1::uuid)::text AS transactions,
         (SELECT count(*) FROM quickbooks_attachments WHERE organization_id = $1::uuid)::text AS attachments,
         (SELECT count(*) FROM quickbooks_financial_reports
           WHERE organization_id = $1::uuid AND status = 'ready')::text AS reports`,
      [organizationId],
    ),
    query<{
      id: string; name: string; fully_qualified_name: string; classification: string | null
      account_type: string | null; account_sub_type: string | null; active: boolean
    }>(
      `SELECT quickbooks_account_id AS id, name, fully_qualified_name, classification,
         account_type, account_sub_type, active
       FROM quickbooks_accounts
       WHERE organization_id = $1::uuid
       ORDER BY active DESC, fully_qualified_name, quickbooks_account_id`,
      [organizationId],
    ),
    query<{
      id: string; name: string; fully_qualified_name: string; item_type: string; sku: string | null
      description: string | null; unit_price: string; purchase_cost: string; active: boolean
    }>(
      `SELECT quickbooks_item_id AS id, name, fully_qualified_name, item_type, sku, description,
         unit_price::text, purchase_cost::text, active
       FROM quickbooks_items
       WHERE organization_id = $1::uuid
       ORDER BY active DESC, fully_qualified_name, quickbooks_item_id`,
      [organizationId],
    ),
    query<{ restaurant_guid: string; restaurant_name: string; location_name: string | null }>(
      `SELECT restaurant_guid::text, restaurant_name, location_name
       FROM toast_locations
       WHERE organization_id = $1::uuid AND selected = true AND archived = false
       ORDER BY restaurant_name, restaurant_guid`,
      [organizationId],
    ),
    query<{ restaurant_guid: string; mapping_key: string; quickbooks_account_id: string | null }>(
      `SELECT restaurant_guid::text, mapping_key, quickbooks_account_id
       FROM toast_accounting_mappings
       WHERE organization_id = $1::uuid
       ORDER BY restaurant_guid, mapping_key`,
      [organizationId],
    ),
    query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM toast_accounting_export_drafts
       WHERE organization_id = $1::uuid
       GROUP BY status ORDER BY status`,
      [organizationId],
    ),
    query<{
      status: string; attempt_count: number; last_error: string | null; updated_at: string; completed_at: string | null
    }>(
      `SELECT status, attempt_count, last_error, updated_at::text, completed_at::text
       FROM quickbooks_sync_outbox
       WHERE organization_id = $1::uuid AND sync_kind = 'catalog'
       LIMIT 1`,
      [organizationId],
    ),
  ])

  const connectionRow = connection.rows[0]
  return {
    connection: connectionRow ? {
      configured: true,
      companyName: connectionRow.company_name,
      country: connectionRow.country,
      status: connectionRow.status,
      catalogSyncEnabled: connectionRow.catalog_sync_enabled,
      verifiedAt: connectionRow.verified_at,
      lastCatalogSyncedAt: connectionRow.last_catalog_synced_at,
      lastErrorCode: connectionRow.last_error_code,
      credentialOwnerEmail: connectionRow.credential_owner_email,
    } : { configured: false },
    counts: {
      accounts: Number(counts.rows[0]?.accounts || 0),
      items: Number(counts.rows[0]?.items || 0),
      customers: Number(counts.rows[0]?.customers || 0),
      vendors: Number(counts.rows[0]?.vendors || 0),
      classes: Number(counts.rows[0]?.classes || 0),
      departments: Number(counts.rows[0]?.departments || 0),
      taxCodes: Number(counts.rows[0]?.tax_codes || 0),
      transactions: Number(counts.rows[0]?.transactions || 0),
      attachments: Number(counts.rows[0]?.attachments || 0),
      reports: Number(counts.rows[0]?.reports || 0),
    },
    crmSync: connectionRow ? {
      pipelineId: connectionRow.crm_pipeline_id,
      customerSyncEnabled: connectionRow.crm_customer_sync_enabled,
      productSyncEnabled: connectionRow.crm_product_sync_enabled,
      lastSyncedAt: connectionRow.last_crm_synced_at,
      lastError: connectionRow.last_crm_sync_error,
    } : {
      pipelineId: null,
      customerSyncEnabled: false,
      productSyncEnabled: false,
      lastSyncedAt: null,
      lastError: null,
    },
    accounts: accounts.rows.map((row) => ({
      id: row.id,
      name: row.name,
      fullyQualifiedName: row.fully_qualified_name,
      classification: row.classification,
      accountType: row.account_type,
      accountSubType: row.account_sub_type,
      active: row.active,
    })),
    items: items.rows.map((row) => ({
      id: row.id,
      name: row.name,
      fullyQualifiedName: row.fully_qualified_name,
      itemType: row.item_type,
      sku: row.sku,
      description: row.description,
      unitPrice: Number(row.unit_price || 0),
      purchaseCost: Number(row.purchase_cost || 0),
      active: row.active,
    })),
    toastLocations: locations.rows.map((row) => ({
      restaurantGuid: row.restaurant_guid,
      restaurantName: row.restaurant_name,
      locationName: row.location_name,
    })),
    mappings: mappings.rows.map((row) => ({
      restaurantGuid: row.restaurant_guid,
      mappingKey: row.mapping_key,
      quickBooksAccountId: row.quickbooks_account_id,
    })),
    draftCounts: Object.fromEntries(drafts.rows.map((row) => [row.status, Number(row.count || 0)])),
    sync: job.rows[0] ? {
      status: job.rows[0].status,
      attemptCount: job.rows[0].attempt_count,
      lastError: job.rows[0].last_error,
      updatedAt: job.rows[0].updated_at,
      completedAt: job.rows[0].completed_at,
    } : null,
  }
}

export async function bindQuickBooksConnectionInPostgres(input: {
  organizationId: string
  ownerEmail: string
  connectionId: string
  company: QuickBooksCompanyInfo
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `quickbooks-binding:${input.organizationId}`)
    const current = await client.query<QuickBooksConnectionBindingRow>(
      `SELECT maton_connection_id, company_name, country
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid
       FOR UPDATE`,
      [input.organizationId],
    )
    const currentBinding = current.rows[0]
    const bindingChanged = Boolean(currentBinding) && (
      currentBinding.maton_connection_id !== input.connectionId
      || currentBinding.company_name !== input.company.companyName
      || currentBinding.country !== input.company.country
    )
    let cancelledWriteRequestCount = 0
    if (bindingChanged) {
      await assertNoProcessingQuickBooksWrites(client, input.organizationId)
      cancelledWriteRequestCount = await cancelUnpostedQuickBooksWrites({
        client,
        organizationId: input.organizationId,
        actorEmail: input.actorEmail,
        reason: 'connection_rebound',
      })
    }
    const conflict = await client.query<{ organization_id: string }>(
      `SELECT organization_id::text FROM organization_quickbooks_connections
       WHERE maton_connection_id = $1 AND organization_id <> $2::uuid LIMIT 1`,
      [input.connectionId, input.organizationId],
    )
    if (conflict.rowCount) throw new Error('This QuickBooks company is already bound to another ClawPilot organization')
    const invalidatedPosAccounting = bindingChanged || !currentBinding
      ? await invalidatePosAccountingQuickBooksBinding({
          client,
          organizationId: input.organizationId,
          actorEmail: input.actorEmail,
        })
      : { profileCount: 0, mappingCount: 0 }
    await client.query(
      `INSERT INTO organization_quickbooks_connections (
         organization_id, credential_owner_email, maton_connection_id, company_name, country,
         company_profile, status, catalog_sync_enabled, verified_at, created_by, updated_by, created_at, updated_at
       ) VALUES ($1::uuid, lower($2), $3, $4, $5, $6::jsonb, 'active', true, now(), lower($7), lower($7), now(), now())
       ON CONFLICT (organization_id) DO UPDATE SET
         credential_owner_email = EXCLUDED.credential_owner_email,
         maton_connection_id = EXCLUDED.maton_connection_id,
         company_name = EXCLUDED.company_name,
         country = EXCLUDED.country,
         company_profile = EXCLUDED.company_profile,
         status = 'active',
         catalog_sync_enabled = true,
         verified_at = now(),
         write_mode = CASE
           WHEN organization_quickbooks_connections.maton_connection_id IS DISTINCT FROM EXCLUDED.maton_connection_id
             OR organization_quickbooks_connections.company_name IS DISTINCT FROM EXCLUDED.company_name
             OR organization_quickbooks_connections.country IS DISTINCT FROM EXCLUDED.country
             THEN 'disabled'
           ELSE organization_quickbooks_connections.write_mode
         END,
         write_verified_at = CASE
           WHEN organization_quickbooks_connections.maton_connection_id IS DISTINCT FROM EXCLUDED.maton_connection_id
             OR organization_quickbooks_connections.company_name IS DISTINCT FROM EXCLUDED.company_name
             OR organization_quickbooks_connections.country IS DISTINCT FROM EXCLUDED.country
             THEN NULL
           ELSE organization_quickbooks_connections.write_verified_at
         END,
         write_verified_by = CASE
           WHEN organization_quickbooks_connections.maton_connection_id IS DISTINCT FROM EXCLUDED.maton_connection_id
             OR organization_quickbooks_connections.company_name IS DISTINCT FROM EXCLUDED.company_name
             OR organization_quickbooks_connections.country IS DISTINCT FROM EXCLUDED.country
             THEN NULL
           ELSE organization_quickbooks_connections.write_verified_by
         END,
         last_error_code = NULL,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        input.organizationId,
        input.ownerEmail,
        input.connectionId,
        input.company.companyName,
        input.company.country,
        JSON.stringify({
          legalName: input.company.legalName,
          email: input.company.email,
          phone: input.company.phone,
          address: input.company.address,
        }),
        input.actorEmail,
      ],
    )
    await client.query(
      `UPDATE quickbooks_sync_outbox SET
         status = 'pending', attempt_count = 0, available_at = now(),
         locked_at = NULL, locked_by = NULL, lock_token = NULL,
         result_summary = '{}'::jsonb, last_error = NULL, requested_by = lower($2),
         completed_at = NULL, updated_at = now()
       WHERE organization_id = $1::uuid AND sync_kind = 'catalog'`,
      [input.organizationId, input.actorEmail],
    )
    await client.query('DELETE FROM quickbooks_accounts WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query('DELETE FROM quickbooks_items WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query('DELETE FROM quickbooks_customers WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query('DELETE FROM quickbooks_vendors WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query('DELETE FROM quickbooks_classes WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query('DELETE FROM quickbooks_departments WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query('DELETE FROM quickbooks_tax_codes WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query('DELETE FROM quickbooks_transactions WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query('DELETE FROM quickbooks_attachments WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query('DELETE FROM quickbooks_financial_reports WHERE organization_id = $1::uuid', [input.organizationId])
    await client.query(
      `UPDATE toast_accounting_mappings SET
         quickbooks_account_id = NULL, quickbooks_account_name = NULL,
         updated_by = lower($2), updated_at = now()
       WHERE organization_id = $1::uuid`,
      [input.organizationId, input.actorEmail],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'quickbooks.connection.bound',
      aggregateType: 'workspace_organization',
      aggregateId: input.organizationId,
      organizationId: input.organizationId,
      payload: {
        companyName: input.company.companyName,
        country: input.company.country,
        bindingChanged,
        writeVerificationReset: bindingChanged,
        cancelledWriteRequestCount,
        invalidatedPosAccountingProfileCount: invalidatedPosAccounting.profileCount,
        invalidatedPosAccountingMappingCount: invalidatedPosAccounting.mappingCount,
      },
    }, client)
  })
}

export async function disconnectQuickBooksConnectionInPostgres(input: { organizationId: string; actorEmail: string }) {
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `quickbooks-binding:${input.organizationId}`)
    const current = await client.query<QuickBooksConnectionBindingRow>(
      `SELECT maton_connection_id, company_name, country
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid
       FOR UPDATE`,
      [input.organizationId],
    )
    if (!current.rowCount) return
    await assertNoProcessingQuickBooksWrites(client, input.organizationId)
    const cancelledWriteRequestCount = await cancelUnpostedQuickBooksWrites({
      client,
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      reason: 'connection_disconnected',
    })
    const invalidatedPosAccounting = await invalidatePosAccountingQuickBooksBinding({
      client,
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
    })
    const removed = await client.query<{ company_name: string }>(
      `DELETE FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid AND maton_connection_id = $2
       RETURNING company_name`,
      [input.organizationId, current.rows[0].maton_connection_id],
    )
    if (!removed.rowCount) throw new Error('QuickBooks connection changed before it could be disconnected')
    await client.query(
      `UPDATE toast_accounting_mappings SET
         quickbooks_account_id = NULL, quickbooks_account_name = NULL,
         updated_by = lower($2), updated_at = now()
       WHERE organization_id = $1::uuid`,
      [input.organizationId, input.actorEmail],
    )
    await client.query(
      `UPDATE toast_accounting_export_drafts SET status = 'needs_mapping', updated_at = now()
       WHERE organization_id = $1::uuid AND status IN ('needs_mapping', 'needs_review', 'failed')`,
      [input.organizationId],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'quickbooks.connection.disconnected',
      aggregateType: 'workspace_organization',
      aggregateId: input.organizationId,
      organizationId: input.organizationId,
      payload: {
        companyName: removed.rows[0].company_name,
        cancelledWriteRequestCount,
        invalidatedPosAccountingProfileCount: invalidatedPosAccounting.profileCount,
        invalidatedPosAccountingMappingCount: invalidatedPosAccounting.mappingCount,
      },
    }, client)
  })
}

export async function setQuickBooksCatalogSyncEnabledInPostgres(input: {
  organizationId: string
  enabled: boolean
  actorEmail: string
}) {
  const result = await query(
    `UPDATE organization_quickbooks_connections
     SET catalog_sync_enabled = $2, updated_by = lower($3), updated_at = now()
     WHERE organization_id = $1::uuid`,
    [input.organizationId, input.enabled, input.actorEmail],
  )
  if (!result.rowCount) throw new Error('Connect QuickBooks before configuring catalog sync')
}

export async function queueQuickBooksCatalogSyncInPostgres(input: {
  organizationId: string
  actorEmail: string | null
}) {
  const result = await query<{ id: string; status: string }>(
    `INSERT INTO quickbooks_sync_outbox (
       organization_id, sync_kind, status, attempt_count, available_at, requested_by, created_at, updated_at
     )
     SELECT $1::uuid, 'catalog', 'pending', 0, now(), lower($2), now(), now()
     FROM organization_quickbooks_connections WHERE organization_id = $1::uuid
     ON CONFLICT (organization_id, sync_kind) DO UPDATE SET
       status = CASE WHEN quickbooks_sync_outbox.status = 'processing' THEN 'processing' ELSE 'pending' END,
       attempt_count = CASE WHEN quickbooks_sync_outbox.status = 'processing' THEN quickbooks_sync_outbox.attempt_count ELSE 0 END,
       available_at = CASE WHEN quickbooks_sync_outbox.status = 'processing' THEN quickbooks_sync_outbox.available_at ELSE now() END,
       locked_at = CASE WHEN quickbooks_sync_outbox.status = 'processing' THEN quickbooks_sync_outbox.locked_at ELSE NULL END,
       locked_by = CASE WHEN quickbooks_sync_outbox.status = 'processing' THEN quickbooks_sync_outbox.locked_by ELSE NULL END,
       lock_token = CASE WHEN quickbooks_sync_outbox.status = 'processing' THEN quickbooks_sync_outbox.lock_token ELSE NULL END,
       last_error = CASE WHEN quickbooks_sync_outbox.status = 'processing' THEN quickbooks_sync_outbox.last_error ELSE NULL END,
       requested_by = COALESCE(EXCLUDED.requested_by, quickbooks_sync_outbox.requested_by),
       completed_at = CASE WHEN quickbooks_sync_outbox.status = 'processing' THEN quickbooks_sync_outbox.completed_at ELSE NULL END,
       updated_at = now()
     RETURNING id::text, status`,
    [input.organizationId, input.actorEmail],
  )
  if (!result.rowCount) throw new Error('Connect QuickBooks before refreshing the catalog')
  return result.rows[0]
}

export async function queueAutomaticQuickBooksCatalogSyncsInPostgres() {
  const result = await query(
    `INSERT INTO quickbooks_sync_outbox (
       organization_id, sync_kind, status, attempt_count, available_at, requested_by, created_at, updated_at
     )
     SELECT organization_id, 'catalog', 'pending', 0, now(), NULL, now(), now()
     FROM organization_quickbooks_connections
     WHERE status = 'active'
       AND catalog_sync_enabled = true
       AND (last_catalog_synced_at IS NULL OR last_catalog_synced_at < now() - interval '24 hours')
     ON CONFLICT (organization_id, sync_kind) DO UPDATE SET
       status = CASE
         WHEN quickbooks_sync_outbox.status = 'processing' THEN 'processing'
         WHEN quickbooks_sync_outbox.status = 'dead' THEN 'dead'
         WHEN quickbooks_sync_outbox.updated_at >= now() - interval '30 minutes' THEN quickbooks_sync_outbox.status
         ELSE 'pending'
       END,
       attempt_count = CASE
         WHEN quickbooks_sync_outbox.status IN ('processing', 'dead') THEN quickbooks_sync_outbox.attempt_count
         WHEN quickbooks_sync_outbox.updated_at >= now() - interval '30 minutes' THEN quickbooks_sync_outbox.attempt_count
         ELSE 0
       END,
       available_at = CASE
         WHEN quickbooks_sync_outbox.status IN ('processing', 'dead') OR quickbooks_sync_outbox.updated_at >= now() - interval '30 minutes'
           THEN quickbooks_sync_outbox.available_at
         ELSE now()
       END,
       updated_at = CASE
         WHEN quickbooks_sync_outbox.status IN ('processing', 'dead') OR quickbooks_sync_outbox.updated_at >= now() - interval '30 minutes'
           THEN quickbooks_sync_outbox.updated_at
         ELSE now()
       END`,
  )
  return result.rowCount || 0
}

export async function claimQuickBooksSyncJobsInPostgres(input: { limit: number; workerId: string }) {
  return withTransaction(async (client) => {
    const claimed = await client.query<{
      id: string; organization_id: string; attempt_count: number; max_attempts: number; lock_token: string
    }>(
      `WITH candidate AS (
         SELECT id FROM quickbooks_sync_outbox
         WHERE (
           status IN ('pending', 'failed') AND available_at <= now()
         ) OR (
           status = 'processing' AND locked_at < now() - interval '10 minutes'
         )
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE quickbooks_sync_outbox job SET
         status = 'processing', attempt_count = job.attempt_count + 1,
         locked_at = now(), locked_by = $2, lock_token = gen_random_uuid(), updated_at = now()
       FROM candidate WHERE job.id = candidate.id
       RETURNING job.id::text, job.organization_id::text, job.attempt_count, job.max_attempts, job.lock_token::text`,
      [Math.max(1, Math.min(input.limit, 10)), input.workerId],
    )
    if (!claimed.rowCount) return []
    const bindings = await client.query<{
      organization_id: string; credential_owner_email: string; maton_connection_id: string
    }>(
      `SELECT organization_id::text, credential_owner_email, maton_connection_id
       FROM organization_quickbooks_connections
       WHERE organization_id = ANY($1::uuid[])`,
      [claimed.rows.map((row) => row.organization_id)],
    )
    const byOrganization = new Map(bindings.rows.map((row) => [row.organization_id, row]))
    return claimed.rows.flatMap((row): QuickBooksSyncJob[] => {
      const binding = byOrganization.get(row.organization_id)
      return binding ? [{
        id: row.id,
        organizationId: row.organization_id,
        ownerEmail: binding.credential_owner_email,
        connectionId: binding.maton_connection_id,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
        lockToken: row.lock_token,
      }] : []
    })
  })
}

export async function completeQuickBooksCatalogSyncInPostgres(input: {
  job: QuickBooksSyncJob
  company: QuickBooksCompanyInfo
  accounts: QuickBooksAccount[]
  items: QuickBooksItem[]
  customers: QuickBooksCustomer[]
  vendors: QuickBooksVendor[]
  classes: QuickBooksClass[]
  departments: QuickBooksDepartment[]
  taxCodes: QuickBooksTaxCode[]
  transactions: QuickBooksTransaction[]
  attachments: QuickBooksAttachment[]
  reports: QuickBooksFinancialReportSnapshot[]
}) {
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `quickbooks-binding:${input.job.organizationId}`)
    const activeBinding = await client.query(
      `SELECT organization_id
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid AND maton_connection_id = $2
       FOR SHARE`,
      [input.job.organizationId, input.job.connectionId],
    )
    if (activeBinding.rowCount !== 1) throw new Error('QuickBooks connection changed before catalog completion')
    const activeLease = await client.query(
      `SELECT id
       FROM quickbooks_sync_outbox
       WHERE id = $1::uuid AND organization_id = $2::uuid
         AND status = 'processing' AND lock_token = $3::uuid
       FOR UPDATE`,
      [input.job.id, input.job.organizationId, input.job.lockToken],
    )
    if (activeLease.rowCount !== 1) throw new Error('QuickBooks sync lease was lost')
    await client.query('DELETE FROM quickbooks_accounts WHERE organization_id = $1::uuid', [input.job.organizationId])
    for (const account of input.accounts) {
      await client.query(
        `INSERT INTO quickbooks_accounts (
         organization_id, quickbooks_account_id, name, fully_qualified_name, classification,
           account_type, account_sub_type, currency_code, current_balance, active, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())`,
        [
          input.job.organizationId, account.id, account.name, account.fullyQualifiedName,
          account.classification, account.accountType, account.accountSubType, account.currencyCode,
          account.currentBalance, account.active, JSON.stringify(account.sourcePayload),
        ],
      )
    }
    await client.query('DELETE FROM quickbooks_items WHERE organization_id = $1::uuid', [input.job.organizationId])
    for (const item of input.items) {
      await client.query(
        `INSERT INTO quickbooks_items (
           organization_id, quickbooks_item_id, name, fully_qualified_name, item_type, sku, description,
           unit_price, purchase_cost, quantity_on_hand, track_quantity, income_account_id,
           expense_account_id, asset_account_id, active, taxable, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, now())`,
        [
          input.job.organizationId, item.id, item.name, item.fullyQualifiedName, item.itemType, item.sku,
          item.description, item.unitPrice, item.purchaseCost, item.quantityOnHand, item.trackQuantity,
          item.incomeAccountId, item.expenseAccountId, item.assetAccountId, item.active, item.taxable,
          JSON.stringify(item.sourcePayload),
        ],
      )
    }
    await client.query('DELETE FROM quickbooks_customers WHERE organization_id = $1::uuid', [input.job.organizationId])
    for (let offset = 0; offset < input.customers.length; offset += 500) {
      await client.query(
        `INSERT INTO quickbooks_customers (
           organization_id, quickbooks_customer_id, display_name, company_name, email, phone,
           currency_code, balance, active, source_payload, synced_at
         )
         SELECT $1::uuid, row.id, row."displayName", row."companyName", row.email, row.phone,
           row."currencyCode", row.balance, row.active, row."sourcePayload", now()
         FROM jsonb_to_recordset($2::jsonb) AS row(
           id text, "displayName" text, "companyName" text, email text, phone text,
           "currencyCode" text, balance numeric, active boolean, "sourcePayload" jsonb
         )`,
        [input.job.organizationId, JSON.stringify(input.customers.slice(offset, offset + 500))],
      )
    }
    await client.query('DELETE FROM quickbooks_vendors WHERE organization_id = $1::uuid', [input.job.organizationId])
    for (let offset = 0; offset < input.vendors.length; offset += 500) {
      await client.query(
        `INSERT INTO quickbooks_vendors (
           organization_id, quickbooks_vendor_id, display_name, company_name, email, phone,
           currency_code, balance, active, source_payload, synced_at
         )
         SELECT $1::uuid, row.id, row."displayName", row."companyName", row.email, row.phone,
           row."currencyCode", row.balance, row.active, row."sourcePayload", now()
         FROM jsonb_to_recordset($2::jsonb) AS row(
           id text, "displayName" text, "companyName" text, email text, phone text,
           "currencyCode" text, balance numeric, active boolean, "sourcePayload" jsonb
         )`,
        [input.job.organizationId, JSON.stringify(input.vendors.slice(offset, offset + 500))],
      )
    }
    await client.query('DELETE FROM quickbooks_classes WHERE organization_id = $1::uuid', [input.job.organizationId])
    for (const dimension of input.classes) {
      await client.query(
        `INSERT INTO quickbooks_classes (
           organization_id, quickbooks_class_id, name, fully_qualified_name,
           child, parent_id, active, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
        [
          input.job.organizationId, dimension.id, dimension.name, dimension.fullyQualifiedName,
          dimension.child, dimension.parentId, dimension.active, JSON.stringify(dimension.sourcePayload),
        ],
      )
    }
    await client.query('DELETE FROM quickbooks_departments WHERE organization_id = $1::uuid', [input.job.organizationId])
    for (const dimension of input.departments) {
      await client.query(
        `INSERT INTO quickbooks_departments (
           organization_id, quickbooks_department_id, name, fully_qualified_name,
           child, parent_id, active, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
        [
          input.job.organizationId, dimension.id, dimension.name, dimension.fullyQualifiedName,
          dimension.child, dimension.parentId, dimension.active, JSON.stringify(dimension.sourcePayload),
        ],
      )
    }
    await client.query('DELETE FROM quickbooks_tax_codes WHERE organization_id = $1::uuid', [input.job.organizationId])
    for (const taxCode of input.taxCodes) {
      await client.query(
        `INSERT INTO quickbooks_tax_codes (
           organization_id, quickbooks_tax_code_id, name, description,
           taxable, active, source_payload, synced_at
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, now())`,
        [
          input.job.organizationId, taxCode.id, taxCode.name, taxCode.description,
          taxCode.taxable, taxCode.active, JSON.stringify(taxCode.sourcePayload),
        ],
      )
    }
    await client.query('DELETE FROM quickbooks_transactions WHERE organization_id = $1::uuid', [input.job.organizationId])
    for (let offset = 0; offset < input.transactions.length; offset += 500) {
      await client.query(
        `INSERT INTO quickbooks_transactions (
           organization_id, entity_type, quickbooks_transaction_id, document_number,
           transaction_date, due_date, party_id, party_name, account_id, account_name,
           currency_code, total_amount, open_balance, transaction_status, email_status,
           payment_method, memo, source_payload, synced_at
         )
         SELECT $1::uuid, row."entityType", row.id, row."documentNumber",
           row."transactionDate"::date, row."dueDate"::date, row."partyId", row."partyName",
           row."accountId", row."accountName", row."currencyCode", row."totalAmount",
           row."openBalance", row.status, row."emailStatus", row."paymentMethod", row.memo,
           row."sourcePayload", now()
         FROM jsonb_to_recordset($2::jsonb) AS row(
           id text, "entityType" text, "documentNumber" text, "transactionDate" text,
           "dueDate" text, "partyId" text, "partyName" text, "accountId" text,
           "accountName" text, "currencyCode" text, "totalAmount" numeric,
           "openBalance" numeric, status text, "emailStatus" text, "paymentMethod" text,
           memo text, "sourcePayload" jsonb
         )`,
        [input.job.organizationId, JSON.stringify(input.transactions.slice(offset, offset + 500))],
      )
    }
    await client.query('DELETE FROM quickbooks_attachments WHERE organization_id = $1::uuid', [input.job.organizationId])
    for (let offset = 0; offset < input.attachments.length; offset += 500) {
      await client.query(
        `INSERT INTO quickbooks_attachments (
           organization_id, quickbooks_attachment_id, file_name, content_type, size_bytes,
           note, entity_references, source_payload, synced_at
         )
         SELECT $1::uuid, row.id, row."fileName", row."contentType", row."sizeBytes",
           row.note, COALESCE(row."entityReferences", '[]'::jsonb), row."sourcePayload", now()
         FROM jsonb_to_recordset($2::jsonb) AS row(
           id text, "fileName" text, "contentType" text, "sizeBytes" bigint,
           note text, "entityReferences" jsonb, "sourcePayload" jsonb
         )`,
        [input.job.organizationId, JSON.stringify(input.attachments.slice(offset, offset + 500))],
      )
    }
    for (const snapshot of input.reports) {
      if (snapshot.status === 'ready' && snapshot.report) {
        await client.query(
          `INSERT INTO quickbooks_financial_reports (
             organization_id, report_key, period_key, report_name, report_basis,
             start_period, end_period, currency_code, generated_at, columns_payload,
             rows_payload, report_options, status, last_error_code, last_attempted_at, synced_at
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6::date, $7::date, $8, $9::timestamptz,
             $10::jsonb, $11::jsonb, $12::jsonb, 'ready', NULL, now(), now()
           )
           ON CONFLICT (organization_id, report_key, period_key) DO UPDATE SET
             report_name = EXCLUDED.report_name,
             report_basis = EXCLUDED.report_basis,
             start_period = EXCLUDED.start_period,
             end_period = EXCLUDED.end_period,
             currency_code = EXCLUDED.currency_code,
             generated_at = EXCLUDED.generated_at,
             columns_payload = EXCLUDED.columns_payload,
             rows_payload = EXCLUDED.rows_payload,
             report_options = EXCLUDED.report_options,
             status = 'ready',
             last_error_code = NULL,
             last_attempted_at = now(),
             synced_at = now()`,
          [
            input.job.organizationId,
            snapshot.reportKey,
            snapshot.periodKey,
            snapshot.report.reportName,
            snapshot.report.reportBasis,
            snapshot.report.startPeriod,
            snapshot.report.endPeriod,
            snapshot.report.currencyCode,
            snapshot.report.generatedAt,
            JSON.stringify(snapshot.report.columns),
            JSON.stringify(snapshot.report.rows),
            JSON.stringify({ noData: snapshot.report.noData, ...snapshot.report.options }),
          ],
        )
        continue
      }
      await client.query(
        `INSERT INTO quickbooks_financial_reports (
           organization_id, report_key, period_key, report_name, status,
           last_error_code, last_attempted_at
         ) VALUES ($1::uuid, $2, $3, 'QuickBooks report', 'error', $4, now())
         ON CONFLICT (organization_id, report_key, period_key) DO UPDATE SET
           status = CASE
             WHEN quickbooks_financial_reports.synced_at IS NOT NULL THEN quickbooks_financial_reports.status
             ELSE 'error'
           END,
           last_error_code = EXCLUDED.last_error_code,
           last_attempted_at = now()`,
        [input.job.organizationId, snapshot.reportKey, snapshot.periodKey, snapshot.errorCode],
      )
    }
    await client.query(
      `UPDATE toast_accounting_mappings mapping SET
         quickbooks_account_id = NULL, quickbooks_account_name = NULL, updated_at = now()
       WHERE mapping.organization_id = $1::uuid
         AND mapping.quickbooks_account_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM quickbooks_accounts account
           WHERE account.organization_id = mapping.organization_id
             AND account.quickbooks_account_id = mapping.quickbooks_account_id
             AND account.active = true
         )`,
      [input.job.organizationId],
    )
    await client.query(
      `UPDATE organization_quickbooks_connections SET
         company_name = $2, country = $3, company_profile = $4::jsonb,
         status = 'active', verified_at = now(),
         last_catalog_synced_at = now(), last_error_code = NULL, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [
        input.job.organizationId,
        input.company.companyName,
        input.company.country,
        JSON.stringify({
          legalName: input.company.legalName,
          email: input.company.email,
          phone: input.company.phone,
          address: input.company.address,
        }),
      ],
    )
    const completed = await client.query(
      `UPDATE quickbooks_sync_outbox SET
         status = 'succeeded', result_summary = $3::jsonb, last_error = NULL,
         locked_at = NULL, locked_by = NULL, lock_token = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid AND lock_token = $2::uuid`,
      [input.job.id, input.job.lockToken, JSON.stringify({
        accounts: input.accounts.length,
        items: input.items.length,
        customers: input.customers.length,
        vendors: input.vendors.length,
        classes: input.classes.length,
        departments: input.departments.length,
        taxCodes: input.taxCodes.length,
        transactions: input.transactions.length,
        attachments: input.attachments.length,
        reportsReady: input.reports.filter((report) => report.status === 'ready').length,
        reportsFailed: input.reports.filter((report) => report.status === 'error').length,
      })],
    )
    if (!completed.rowCount) throw new Error('QuickBooks sync lease was lost')
    await recordAuditEvent({
      actor: 'system',
      eventType: 'quickbooks.catalog.succeeded',
      aggregateType: 'workspace_organization',
      aggregateId: input.job.organizationId,
      organizationId: input.job.organizationId,
      isSystem: true,
      payload: {
        companyName: input.company.companyName,
        accounts: input.accounts.length,
        items: input.items.length,
        customers: input.customers.length,
        vendors: input.vendors.length,
        classes: input.classes.length,
        departments: input.departments.length,
        taxCodes: input.taxCodes.length,
        transactions: input.transactions.length,
        attachments: input.attachments.length,
        reportsReady: input.reports.filter((report) => report.status === 'ready').length,
        reportsFailed: input.reports.filter((report) => report.status === 'error').length,
      },
    }, client)
  })
}

export async function failQuickBooksSyncJobInPostgres(input: { job: QuickBooksSyncJob; error: unknown }) {
  const dead = input.job.attemptCount >= input.job.maxAttempts
  const error = safeError(input.error)
  await withTransaction(async (client) => {
    const failed = await client.query(
      `UPDATE quickbooks_sync_outbox SET
         status = $3, last_error = $4,
         available_at = now() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempt_count, 7)))::integer),
         locked_at = NULL, locked_by = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND lock_token = $2::uuid`,
      [input.job.id, input.job.lockToken, dead ? 'dead' : 'failed', error],
    )
    if (!failed.rowCount) return false
    await client.query(
      `UPDATE organization_quickbooks_connections SET
         status = 'error', last_error_code = $2, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [input.job.organizationId, dead ? 'QUICKBOOKS_SYNC_DEAD' : 'QUICKBOOKS_SYNC_FAILED'],
    )
    await recordAuditEvent({
      actor: 'system',
      eventType: dead ? 'quickbooks.catalog.dead' : 'quickbooks.catalog.failed',
      aggregateType: 'workspace_organization',
      aggregateId: input.job.organizationId,
      organizationId: input.job.organizationId,
      isSystem: true,
      payload: { attemptCount: input.job.attemptCount, error },
    }, client)
  })
  return dead
}

export async function updateQuickBooksMappingsInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  mappings: Partial<Record<QuickBooksMappingKey, string | null>>
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    const location = await client.query(
      `SELECT 1 FROM toast_locations
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND selected = true AND archived = false`,
      [input.organizationId, input.restaurantGuid],
    )
    if (!location.rowCount) throw new Error('The selected Toast location is unavailable')
    for (const key of QUICKBOOKS_MAPPING_KEYS) {
      if (!(key in input.mappings)) continue
      const accountId = String(input.mappings[key] || '').trim() || null
      let accountName: string | null = null
      if (accountId) {
        const account = await client.query<{ fully_qualified_name: string }>(
          `SELECT fully_qualified_name FROM quickbooks_accounts
           WHERE organization_id = $1::uuid AND quickbooks_account_id = $2 AND active = true LIMIT 1`,
          [input.organizationId, accountId],
        )
        if (!account.rowCount) throw new Error(`QuickBooks account mapping is invalid for ${key}`)
        accountName = account.rows[0].fully_qualified_name
      }
      await client.query(
        `INSERT INTO toast_accounting_mappings (
           organization_id, restaurant_guid, mapping_key, quickbooks_account_id,
           quickbooks_account_name, updated_by, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, lower($6), now(), now())
         ON CONFLICT (organization_id, restaurant_guid, mapping_key) DO UPDATE SET
           quickbooks_account_id = EXCLUDED.quickbooks_account_id,
           quickbooks_account_name = EXCLUDED.quickbooks_account_name,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [input.organizationId, input.restaurantGuid, key, accountId, accountName, input.actorEmail],
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'quickbooks.account_mappings.updated',
      aggregateType: 'toast_location',
      aggregateId: input.restaurantGuid,
      organizationId: input.organizationId,
      payload: { mappingKeys: Object.keys(input.mappings) },
    }, client)
  })
}

export async function readQuickBooksCachedItemsInPostgres(input: {
  organizationId: string
  itemIds: string[]
}) {
  const result = await query<{
    quickbooks_item_id: string; name: string; fully_qualified_name: string; item_type: string
    sku: string | null; description: string | null; unit_price: string; purchase_cost: string; active: boolean
    source_payload: Record<string, unknown>
  }>(
    `SELECT quickbooks_item_id, name, fully_qualified_name, item_type, sku, description,
       unit_price::text, purchase_cost::text, active, source_payload
     FROM quickbooks_items
     WHERE organization_id = $1::uuid AND quickbooks_item_id = ANY($2::text[])
     ORDER BY fully_qualified_name, quickbooks_item_id`,
    [input.organizationId, input.itemIds],
  )
  return result.rows.map((row) => ({
    id: row.quickbooks_item_id,
    name: row.name,
    fullyQualifiedName: row.fully_qualified_name,
    itemType: row.item_type,
    sku: row.sku,
    description: row.description,
    unitPrice: Number(row.unit_price || 0),
    purchaseCost: Number(row.purchase_cost || 0),
    active: row.active,
    sourcePayload: row.source_payload,
  }))
}

const QUICKBOOKS_WORKER_HEARTBEAT_KEY = 'quickbooks.sync.worker.heartbeat'

export async function recordQuickBooksWorkerHeartbeatInPostgres(details: Record<string, unknown>) {
  const payload = { checkedAt: new Date().toISOString(), ...details }
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [QUICKBOOKS_WORKER_HEARTBEAT_KEY, JSON.stringify(payload)],
  )
  return payload
}

export async function readQuickBooksWorkerHeartbeatFromPostgres() {
  const result = await query<{ value: Record<string, unknown> }>(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [QUICKBOOKS_WORKER_HEARTBEAT_KEY],
  )
  return result.rows[0]?.value || null
}

export function quickBooksWorkerId() {
  return String(process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || crypto.randomUUID()).slice(0, 200)
}
