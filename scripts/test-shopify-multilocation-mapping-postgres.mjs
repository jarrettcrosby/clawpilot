#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim()
}

function applyMigrations(databaseUrl) {
  command('npm', ['run', 'db:migrate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 180_000,
  })
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 45_000
  let lastError = null
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

function loadProjection() {
  const path = 'app_src/lib/operations/shopifyInventoryProjection.ts'
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: path,
    },
  ).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Math,
    Object,
    exports: module.exports,
    module,
  }, { filename: path })
  return module.exports
}

function loadPersistence(pool) {
  const path = 'app_src/lib/persistence/commerceInventory.ts'
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
    },
  ).outputText
  const module = { exports: {} }
  const projection = loadProjection()
  const postgres = {
    query(text, values = []) {
      return pool.query(text, values)
    },
    async withTransaction(callback) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const value = await callback(client)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async acquireTransactionAdvisoryLock(client, key) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      )
    },
  }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    Intl,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/auditWriter') {
        return { async recordAuditEvent() {} }
      }
      if (specifier === '@/lib/integrations/commerceReadRuntime') {
        return {
          commerceReadAccountSql(alias) {
            return `${alias}.status = 'active'`
          },
        }
      }
      if (specifier === '@/lib/integrations/shopifyInventory') {
        return { SHOPIFY_INVENTORY_ADAPTER_VERSION: 'postgres-test-v1' }
      }
      if (specifier === '@/lib/operations/shopifyInventoryProjection') {
        return projection
      }
      if (specifier === '@/lib/operations/commerceStoreSync') {
        return {
          commerceStoreSyncRunningSql(alias) {
            return `operations_commerce_store_sync_is_running(${alias}.organization_id, ${alias}.id)`
          },
        }
      }
      if (specifier === '@/lib/persistence/commerceStoreSync') {
        return {
          async assertCommerceStoreSyncProviderReadLeaseCurrentWithClient() {},
        }
      }
      if (specifier === '@/lib/persistence/postgres') return postgres
      if (specifier.startsWith('@/')) return {}
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

const ids = {
  organization: '28900000-0000-4000-8000-000000000001',
  pipeline: '28900000-0000-4000-8000-000000000002',
  account: '28900000-0000-4000-8000-000000000003',
  accountTwo: '28900000-0000-4000-8000-000000000004',
  warehouse: '28900000-0000-4000-8000-000000000010',
  location: '28900000-0000-4000-8000-000000000011',
  raceWarehouse: '28900000-0000-4000-8000-000000000012',
  raceLocation: '28900000-0000-4000-8000-000000000013',
  product: '28900000-0000-4000-8000-000000000020',
}
const actorEmail = 'manager@example.com'
const inventoryItemId = 'gid://shopify/InventoryItem/2890001'
const inventoryStateNames = Object.freeze([
  'available',
  'incoming',
  'committed',
  'damaged',
  'on_hand',
  'quality_control',
  'reserved',
  'safety_stock',
])
const runtime = {
  organizationId: ids.organization,
  integrationAccountId: ids.account,
  globalId: 'gia2890001',
  provider: 'shopify',
  environment: 'sandbox',
  externalAccountId: 'gid://shopify/Shop/2890001',
  status: 'active',
  credentialVersion: 1,
  verificationStatus: 'verified',
  encrypted: {},
  configuration: {},
}
const runtimeTwo = {
  ...runtime,
  integrationAccountId: ids.accountTwo,
  globalId: 'gia2890002',
  environment: 'production',
  externalAccountId: 'gid://shopify/Shop/2890002',
}

function providerLocation(id, name, overrides = {}) {
  return {
    id,
    name,
    isActive: true,
    shipsInventory: true,
    fulfillsOnlineOrders: true,
    hasActiveInventory: true,
    addressVerified: true,
    isFulfillmentService: false,
    fulfillmentService: null,
    address: {
      line1: '100 Test Lane',
      line2: 'Suite 2',
      city: 'Trumbull',
      region: 'Connecticut',
      regionCode: 'CT',
      postalCode: '06611',
      country: 'United States',
      countryCode: 'US',
    },
    ...overrides,
  }
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex')
}

function inventorySnapshot(location, label, input) {
  const quantities = {
    available: input.available,
    incoming: 0,
    committed: input.committed,
    damaged: 0,
    on_hand: input.onHand,
    quality_control: 0,
    reserved: 0,
    safety_stock: 0,
  }
  const updatedAt = `2026-08-14T12:${String(input.minute).padStart(2, '0')}:00.000Z`
  const level = {
    id: `gid://shopify/InventoryLevel/${label}`,
    locationId: location.id,
    inventoryItemId,
    sku: 'SHOPIFY-ZERO-1',
    tracked: input.tracked,
    updatedAt,
    quantities,
    quantityEvidence: Object.fromEntries(
      inventoryStateNames.map((name, index) => [name, {
        id: `gid://shopify/InventoryQuantity/${label}-${index}`,
        quantity: quantities[name],
        updatedAt,
      }]),
    ),
    equationMatches: input.equationMatches,
    providerWeightGrams: 454,
    providerDimensionsMm: null,
    productSnapshot: {
      productId: 'gid://shopify/Product/2890001',
      variantId: 'gid://shopify/ProductVariant/2890001',
      title: 'Shopify zeroing fixture',
    },
    sourceHash: sha(`level:${label}`),
  }
  return {
    fetchedAt: updatedAt,
    location,
    levels: [level],
    pageCount: 1,
    enrichment: {
      unitCostAvailable: false,
      productDimensionKeys: {},
      variantDimensionKeys: {},
      ambiguousDimensionDefinitions: [],
    },
    snapshotHash: sha(`snapshot:${label}`),
  }
}

async function applyInventorySnapshotResult(input) {
  const requestHash = sha(`request:${input.label}`)
  const idempotencyKey = `shopify-zeroing-${input.label}`
  const attempt = await input.persistence.prepareShopifyInventoryReadInPostgres({
    runtime,
    target: input.target,
    idempotencyKey,
    requestHash,
    actorEmail,
    providerReadAuthority: 'automatic',
  })
  const capture = await input.persistence
    .captureShopifyInventorySnapshotInPostgres({
      runtime,
      target: input.target,
      attempt,
      requestHash,
      snapshot: input.snapshot || inventorySnapshot(
          input.providerLocation,
          input.label,
          input.state,
        ),
      actorEmail,
      providerReadLease: {
        id: randomUUID(),
        organizationId: runtime.organizationId,
        integrationAccountId: runtime.integrationAccountId,
        authorityKind: 'automatic',
        readKind: 'shopify_inventory',
        controlRevision: 1,
        activationRevision: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
  const applied = await input.persistence
    .applyShopifyInventorySnapshotInPostgres({
      runtime,
      target: input.target,
      attempt,
      capture,
      providerLocation: input.providerLocation,
      mappingMethod: 'automatic_exact_address',
      idempotencyKey,
      requestHash,
      actorEmail,
    })
  return applied
}

async function applyInventorySnapshot(input) {
  return (await applyInventorySnapshotResult(input)).runGlobalId
}

async function exerciseLevelSetReuse(input) {
  const stableSnapshot = inventorySnapshot(
    input.providerLocation,
    'storage-guard-stable',
    {
      tracked: true,
      available: 14,
      committed: 2,
      onHand: 16,
      equationMatches: true,
      minute: 20,
    },
  )
  const before = await input.pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_inventory_levels
        WHERE organization_id = $1::uuid) AS levels,
       (SELECT count(*)::integer
        FROM crm_reference_registry
        WHERE reference_code LIKE 'giil%') AS level_ids`,
    [ids.organization],
  )
  const full = await applyInventorySnapshotResult({
    ...input,
    label: 'storage-guard-full',
    snapshot: stableSnapshot,
  })
  assert.equal(full.levelSetReused, false)
  const afterFull = await input.pool.query(
    `SELECT count(*)::integer AS levels
     FROM operations_commerce_inventory_levels
     WHERE organization_id = $1::uuid`,
    [ids.organization],
  )
  assert.equal(afterFull.rows[0].levels, before.rows[0].levels + 1)

  const firstReuse = await applyInventorySnapshotResult({
    ...input,
    label: 'storage-guard-reuse-1',
    snapshot: {
      ...stableSnapshot,
      fetchedAt: '2026-08-14T12:21:00.000Z',
    },
  })
  const secondReuse = await applyInventorySnapshotResult({
    ...input,
    label: 'storage-guard-reuse-2',
    snapshot: {
      ...stableSnapshot,
      fetchedAt: '2026-08-14T12:22:00.000Z',
    },
  })
  assert.equal(firstReuse.levelSetReused, true)
  assert.equal(secondReuse.levelSetReused, true)
  const afterReuse = await input.pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_inventory_levels
        WHERE organization_id = $1::uuid) AS levels,
       (SELECT count(*)::integer
        FROM crm_reference_registry
        WHERE reference_code LIKE 'giil%') AS level_ids,
       (SELECT count(*)::integer
        FROM operations_commerce_inventory_sync_runs
        WHERE organization_id = $1::uuid
          AND source_level_set_run_id IS NOT NULL) AS aliases,
       (SELECT count(*)::integer
        FROM operations_commerce_inventory_levels level
        WHERE level.sync_run_id = (
          SELECT COALESCE(source_level_set_run_id, id)
          FROM operations_commerce_inventory_sync_runs
          WHERE organization_id = $1::uuid
            AND global_id = $2
        )) AS resolved_levels`,
    [ids.organization, secondReuse.runGlobalId],
  )
  assert.equal(afterReuse.rows[0].levels, afterFull.rows[0].levels)
  assert.equal(afterReuse.rows[0].level_ids, before.rows[0].level_ids + 1)
  assert.equal(afterReuse.rows[0].aliases, 2)
  assert.equal(afterReuse.rows[0].resolved_levels, 1)

  const changed = await applyInventorySnapshotResult({
    ...input,
    label: 'storage-guard-changed',
    state: {
      tracked: true,
      available: 15,
      committed: 2,
      onHand: 17,
      equationMatches: true,
      minute: 23,
    },
  })
  assert.equal(changed.levelSetReused, false)
  const afterChange = await input.pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_inventory_levels
        WHERE organization_id = $1::uuid) AS levels,
       (SELECT count(*)::integer
        FROM crm_reference_registry
        WHERE reference_code LIKE 'giil%') AS level_ids`,
    [ids.organization],
  )
  assert.equal(afterChange.rows[0].levels, afterFull.rows[0].levels + 1)
  assert.equal(afterChange.rows[0].level_ids, before.rows[0].level_ids + 2)

  // Rebuild one legacy inline capture from the canonical content. Conversion
  // must reuse that content row even though PostgreSQL's jsonb serialization
  // byte count can differ from the original JavaScript JSON byte count.
  const canonical = await input.pool.query(
    `SELECT capture.*, content.snapshot_content,
            capture.snapshot_content_id AS expected_content_id
     FROM operations_commerce_inventory_sync_runs run
     JOIN operations_commerce_inventory_captures capture
       ON capture.organization_id = run.organization_id
      AND capture.integration_account_id = run.integration_account_id
      AND capture.id = run.capture_id
     JOIN operations_commerce_inventory_snapshot_contents content
       ON content.organization_id = capture.organization_id
      AND content.integration_account_id = capture.integration_account_id
      AND content.id = capture.snapshot_content_id
     WHERE run.organization_id = $1::uuid
       AND run.global_id = $2`,
    [ids.organization, full.runGlobalId],
  )
  assert.equal(canonical.rowCount, 1)
  const legacyCaptureId = randomUUID()
  const legacyAttemptId = randomUUID()
  const client = await input.pool.connect()
  try {
    await client.query(`SET session_replication_role = 'replica'`)
    await client.query(
      `INSERT INTO operations_commerce_inventory_captures (
         id, organization_id, integration_account_id, provider_attempt_id,
         warehouse_id, location_id, provider, adapter_version,
         credential_version, request_hash, snapshot_hash,
         provider_location_id, provider_fetched_at, level_count,
         captured_snapshot, snapshot_bytes, created_by, created_at
       )
       SELECT
         $1::uuid, capture.organization_id, capture.integration_account_id,
         $2::uuid, capture.warehouse_id, capture.location_id,
         capture.provider, capture.adapter_version,
         capture.credential_version, $3, capture.snapshot_hash,
         capture.provider_location_id, capture.provider_fetched_at,
         capture.level_count,
         content.snapshot_content || jsonb_build_object(
           'fetchedAt', capture.provider_fetched_at,
           'pageCount', 999999999999::numeric
         ),
         octet_length(convert_to((
           content.snapshot_content || jsonb_build_object(
             'fetchedAt', capture.provider_fetched_at,
             'pageCount', 999999999999::numeric
           )
         )::text, 'UTF8')),
         capture.created_by, now() - interval '1 day'
       FROM operations_commerce_inventory_captures capture
       JOIN operations_commerce_inventory_snapshot_contents content
         ON content.organization_id = capture.organization_id
        AND content.integration_account_id = capture.integration_account_id
        AND content.id = capture.snapshot_content_id
       WHERE capture.id = $4::uuid`,
      [
        legacyCaptureId,
        legacyAttemptId,
        sha('storage-guard-legacy-request'),
        canonical.rows[0].id,
      ],
    )
  } finally {
    await client.query(`SET session_replication_role = 'origin'`)
    client.release()
  }
  const contentCountBefore = await input.pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_inventory_snapshot_contents
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND id = $3::uuid`,
    [
      ids.organization,
      ids.account,
      canonical.rows[0].expected_content_id,
    ],
  )
  const conversion = await input.pool.query(
    `SELECT converted_rows, converted_bytes::text
     FROM convert_operations_commerce_inventory_legacy_captures(25)`,
  )
  assert.ok(conversion.rows[0].converted_rows >= 1)
  assert.ok(Number(conversion.rows[0].converted_bytes) > 0)
  const legacyAfter = await input.pool.query(
    `SELECT captured_snapshot, snapshot_content_id, provider_page_count
     FROM operations_commerce_inventory_captures
     WHERE id = $1::uuid`,
    [legacyCaptureId],
  )
  assert.equal(legacyAfter.rows[0].captured_snapshot, null)
  assert.equal(
    legacyAfter.rows[0].snapshot_content_id,
    canonical.rows[0].expected_content_id,
  )
  assert.equal(legacyAfter.rows[0].provider_page_count, 400)
  const contentCountAfter = await input.pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_inventory_snapshot_contents
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND id = $3::uuid`,
    [
      ids.organization,
      ids.account,
      canonical.rows[0].expected_content_id,
    ],
  )
  assert.deepEqual(contentCountAfter.rows[0], contentCountBefore.rows[0])
}

async function exerciseProjectionZeroing(input) {
  const transitions = [
    {
      label: 'untracked',
      projected: {
        tracked: true,
        available: 8,
        committed: 2,
        onHand: 10,
        equationMatches: true,
      },
      ineligible: {
        tracked: false,
        available: 8,
        committed: 2,
        onHand: 10,
        equationMatches: true,
      },
      projectionState: 'untracked',
      metric: 'levels_untracked',
    },
    {
      label: 'inconsistent',
      projected: {
        tracked: true,
        available: 9,
        committed: 3,
        onHand: 12,
        equationMatches: true,
      },
      ineligible: {
        tracked: true,
        available: 9,
        committed: 3,
        onHand: 13,
        equationMatches: false,
      },
      projectionState: 'inconsistent',
      metric: 'equation_mismatch_levels',
    },
    {
      label: 'negative',
      projected: {
        tracked: true,
        available: 4,
        committed: 2,
        onHand: 6,
        equationMatches: true,
      },
      ineligible: {
        tracked: true,
        available: -1,
        committed: 2,
        onHand: 1,
        equationMatches: true,
      },
      projectionState: 'negative_available',
      metric: 'negative_available_levels',
    },
  ]
  let minute = 1
  for (const transition of transitions) {
    const projectedRunGlobalId = await applyInventorySnapshot({
      ...input,
      label: `${transition.label}-projected`,
      state: { ...transition.projected, minute: minute++ },
    })
    const projected = await input.pool.query(
      `SELECT position.on_hand_quantity::text,
              position.reserved_quantity::text,
              run.positions_created, run.positions_updated,
              run.positions_zeroed
       FROM operations_inventory_positions position
       JOIN operations_commerce_inventory_sync_runs run
         ON run.organization_id = position.organization_id
        AND run.global_id = $5
       WHERE position.organization_id = $1::uuid
         AND position.warehouse_id = $2::uuid
         AND position.location_id = $3::uuid
         AND position.product_id = $4::uuid
         AND position.source_authority = 'shopify'`,
      [
        ids.organization,
        input.target.warehouse.id,
        input.target.location.id,
        ids.product,
        projectedRunGlobalId,
      ],
    )
    assert.equal(projected.rowCount, 1)
    assert.equal(
      Number(projected.rows[0].on_hand_quantity),
      transition.projected.onHand,
    )
    assert.equal(
      Number(projected.rows[0].reserved_quantity),
      transition.projected.committed,
    )
    assert.equal(projected.rows[0].positions_zeroed, 0)

    const zeroedRunGlobalId = await applyInventorySnapshot({
      ...input,
      label: `${transition.label}-ineligible`,
      state: { ...transition.ineligible, minute: minute++ },
    })
    const zeroed = await input.pool.query(
      `SELECT position.on_hand_quantity::text,
              position.reserved_quantity::text,
              run.positions_zeroed,
              run.levels_untracked,
              run.negative_available_levels,
              run.equation_mismatch_levels,
              level.projection_state,
              level.inventory_position_id::text,
              level.external_inventory_item_id
       FROM operations_commerce_inventory_sync_runs run
       JOIN operations_commerce_inventory_levels level
         ON level.organization_id = run.organization_id
        AND level.sync_run_id = run.id
       JOIN operations_inventory_positions position
         ON position.organization_id = run.organization_id
        AND position.warehouse_id = run.warehouse_id
        AND position.location_id = run.location_id
        AND position.product_id = $4::uuid
        AND position.source_authority = 'shopify'
       WHERE run.organization_id = $1::uuid
         AND run.warehouse_id = $2::uuid
         AND run.location_id = $3::uuid
         AND run.global_id = $5`,
      [
        ids.organization,
        input.target.warehouse.id,
        input.target.location.id,
        ids.product,
        zeroedRunGlobalId,
      ],
    )
    assert.equal(zeroed.rowCount, 1)
    assert.equal(Number(zeroed.rows[0].on_hand_quantity), 0)
    assert.equal(Number(zeroed.rows[0].reserved_quantity), 0)
    assert.equal(zeroed.rows[0].positions_zeroed, 1)
    assert.equal(zeroed.rows[0][transition.metric], 1)
    assert.equal(
      zeroed.rows[0].projection_state,
      transition.projectionState,
    )
    assert.equal(zeroed.rows[0].inventory_position_id, null)
    assert.equal(zeroed.rows[0].external_inventory_item_id, inventoryItemId)
    const zeroLedger = await input.pool.query(
      `SELECT on_hand_after::text, reserved_after::text, reason
       FROM operations_inventory_ledger
       WHERE organization_id = $1::uuid
         AND source_global_id = $2
       ORDER BY id`,
      [ids.organization, zeroedRunGlobalId],
    )
    assert.equal(zeroLedger.rowCount, 1)
    assert.equal(Number(zeroLedger.rows[0].on_hand_after), 0)
    assert.equal(Number(zeroLedger.rows[0].reserved_after), 0)
    assert.equal(
      zeroLedger.rows[0].reason,
      'Complete Shopify snapshot no longer reports an eligible inventory level',
    )
  }
}

async function seed(client) {
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO workspace_organizations (id, name)
       VALUES ($1::uuid, 'Shopify location mapping fixture')`,
      [ids.organization],
    )
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'admin', 'active')`,
      [actorEmail],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, workspace_organization_id, is_default
       ) VALUES (
         $1::uuid, 'Shopify mapping pipeline', $2, $3::uuid, true
       )`,
      [ids.pipeline, actorEmail, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision, updated_by
       ) VALUES ($1::uuid, $2::uuid, 'read_only', 1, $3)`,
      [ids.organization, ids.pipeline, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES (
         $1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'sandbox',
         'Shopify mapping fixture', 'active', '{}'::jsonb,
         'gid://shopify/Shop/2890001', 1
       )`,
      [ids.account, runtime.globalId, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES (
         $1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'production',
         'Second Shopify mapping fixture', 'active', '{}'::jsonb,
         'gid://shopify/Shop/2890002', 1
       )`,
      [ids.accountTwo, runtimeTwo.globalId, ids.organization],
    )
    await client.query(
      `INSERT INTO operations_commerce_store_sync_controls (
         organization_id, integration_account_id, desired_state,
         explicit_choice, revision, reason, created_by, updated_by
       ) VALUES
       ($1::uuid, $2::uuid, 'running', true, 1,
        'Shopify mapping fixture Running', $4, $4),
       ($1::uuid, $3::uuid, 'running', true, 1,
        'Second Shopify mapping fixture Running', $4, $4)`,
      [ids.organization, ids.account, ids.accountTwo, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status
       ) VALUES (
         $1::uuid, $2::uuid, 'gid://shopify/Shop/2890001',
         'shopify_client_credentials', decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '0001', 'verified', clock_timestamp(), 'unverified'
       )`,
      [ids.organization, ids.account],
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status
       ) VALUES (
         $1::uuid, $2::uuid, 'gid://shopify/Shop/2890002',
         'shopify_client_credentials', decode('02', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '0002', 'verified', clock_timestamp(), 'unverified'
       )`,
      [ids.organization, ids.accountTwo],
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, facility_type,
         timezone, address, status, created_by, updated_by
       ) VALUES (
         $1::uuid, 'gwh2890001', $2::uuid, 'EXISTING',
         'Existing warehouse', 'distribution_center', 'America/New_York',
         '{"line1":"1 Existing Way","city":"Trumbull","region":"CT","postalCode":"06611","country":"US"}'::jsonb,
         'active', $3, $3
       )`,
      [ids.warehouse, ids.organization, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_locations (
         id, global_id, organization_id, warehouse_id, code, zone,
         location_type, topology_level, pick_sequence, active,
         storage_function, created_by, updated_by
       ) VALUES (
         $1::uuid, 'gwl2890001', $2::uuid, $3::uuid, 'RESERVE-01',
         'STORAGE', 'storage', 'bin', 100, true, 'reserve', $4, $4
       )`,
      [ids.location, ids.organization, ids.warehouse, actorEmail],
    )
    await client.query(
      `INSERT INTO crm_products (
         id, pipeline_id, source_key, name, sku, source_hash,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify-zeroing-product',
         'Shopify zeroing product', 'SHOPIFY-ZERO-1', $3, $4, $4
       )`,
      [
        ids.product,
        ids.pipeline,
        sha('shopify-zeroing-product'),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_product_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
         channel_sku, external_product_id, external_variant_id,
         external_inventory_item_id, mapping_method,
         mapping_source_revision, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SHOPIFY-ZERO-1',
         'gid://shopify/Product/2890001',
         'gid://shopify/ProductVariant/2890001', $5,
         'exact_variant', 'shopify-zeroing-postgres-v1', true, $6
       )`,
      [
        ids.organization,
        ids.account,
        ids.pipeline,
        ids.product,
        inventoryItemId,
        actorEmail,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

async function exercise(pool) {
  const client = await pool.connect()
  try {
    await seed(client)
  } finally {
    client.release()
  }

  const persistence = loadPersistence(pool)
  const firstLocation = providerLocation(
    'gid://shopify/Location/2890001',
    'Existing location',
  )
  const mapped = await persistence.mapShopifyInventoryLocationInPostgres({
    runtime,
    providerLocation: firstLocation,
    warehouseGlobalId: 'gwh2890001',
    locationGlobalId: 'gwl2890001',
    expectedMappingGlobalId: null,
    expectedRowVersion: null,
    idempotencyKey: 'shopify-map-postgres-2890001',
    actorEmail,
  })
  assert.equal(mapped.providerWrites, 0)
  assert.equal(mapped.replayed, false)
  assert.equal(mapped.mapping.externalLocationId, firstLocation.id)
  assert.equal(mapped.mapping.warehouseGlobalId, 'gwh2890001')
  assert.equal(mapped.mapping.locationGlobalId, 'gwl2890001')

  const replay = await persistence.mapShopifyInventoryLocationInPostgres({
    runtime,
    providerLocation: firstLocation,
    warehouseGlobalId: 'gwh2890001',
    locationGlobalId: 'gwl2890001',
    expectedMappingGlobalId: null,
    expectedRowVersion: null,
    idempotencyKey: 'shopify-map-postgres-2890001',
    actorEmail,
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.mapping.globalId, mapped.mapping.globalId)
  assert.equal(
    (await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_commerce_inventory_location_mappings
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.account],
    )).rows[0].count,
    1,
  )
  const target = await persistence.readShopifyInventoryTargetFromPostgres({
    runtime,
    mappingGlobalId: mapped.mapping.globalId,
  })
  await exerciseProjectionZeroing({
    pool,
    persistence,
    target,
    providerLocation: firstLocation,
  })
  await exerciseLevelSetReuse({
    pool,
    persistence,
    target,
    providerLocation: firstLocation,
  })

  await assert.rejects(
    persistence.mapShopifyInventoryLocationInPostgres({
      runtime,
      providerLocation: firstLocation,
      warehouseGlobalId: 'gwh2890001',
      locationGlobalId: 'gwl2899999',
      expectedMappingGlobalId: null,
      expectedRowVersion: null,
      idempotencyKey: 'shopify-map-postgres-2890001',
      actorEmail,
    }),
    (error) => error.code === 'SHOPIFY_INVENTORY_MAPPING_IDEMPOTENCY_CONFLICT',
  )

  await assert.rejects(
    persistence.mapShopifyInventoryLocationInPostgres({
      runtime,
      providerLocation: providerLocation(
        'gid://shopify/Location/2890002',
        'App managed location',
        {
          isFulfillmentService: true,
          fulfillmentService: {
            id: 'gid://shopify/FulfillmentService/2890002',
            handle: 'other-app',
            serviceName: 'Other app',
            type: 'THIRD_PARTY',
            inventoryManagement: true,
          },
        },
      ),
      warehouseGlobalId: 'gwh2890001',
      locationGlobalId: 'gwl2890001',
      expectedMappingGlobalId: null,
      expectedRowVersion: null,
      idempotencyKey: 'shopify-map-postgres-2890002',
      actorEmail,
    }),
    (error) => (
      error.code
      === 'SHOPIFY_INVENTORY_FULFILLMENT_SERVICE_LOCATION_FORBIDDEN'
    ),
  )

  const secondLocation = providerLocation(
    'gid://shopify/Location/2890003',
    'New provider warehouse',
    {
      address: {
        line1: '200 Provider Road',
        line2: '',
        city: 'Shelton',
        region: 'Connecticut',
        regionCode: 'CT',
        postalCode: '06484',
        country: 'United States',
        countryCode: 'US',
      },
    },
  )
  await assert.rejects(
    persistence.createShopifyInventoryWarehouseAndMappingInPostgres({
      runtime,
      providerLocation: providerLocation(
        'gid://shopify/Location/2890004',
        'Incomplete address',
        {
          address: {
            line1: '',
            line2: '',
            city: 'Shelton',
            region: 'Connecticut',
            regionCode: 'CT',
            postalCode: '06484',
            country: 'United States',
            countryCode: 'US',
          },
        },
      ),
      warehouse: {
        code: 'INCOMPLETE',
        name: 'Incomplete address',
        facilityType: 'distribution_center',
        timezone: 'America/New_York',
      },
      idempotencyKey: 'shopify-create-postgres-2890004',
      actorEmail,
    }),
    (error) => (
      error.code === 'SHOPIFY_INVENTORY_LOCATION_ADDRESS_INCOMPLETE'
    ),
  )
  const created =
    await persistence.createShopifyInventoryWarehouseAndMappingInPostgres({
      runtime,
      providerLocation: secondLocation,
      warehouse: {
        code: 'SHOPIFY-TWO',
        name: 'Shopify two',
        facilityType: 'distribution_center',
        timezone: 'America/New_York',
      },
      idempotencyKey: 'shopify-create-postgres-2890003',
      actorEmail,
    })
  assert.equal(created.providerWrites, 0)
  assert.equal(created.replayed, false)
  assert.equal(created.warehouse.code, 'SHOPIFY-TWO')
  assert.equal(created.warehouse.inventoryLocationCode, 'RESERVE-01')
  assert.equal(created.mapping.externalLocationId, secondLocation.id)
  const createdEvidence = await pool.query(
    `SELECT warehouse.address, count(location.id)::integer AS location_count,
            bool_or(location.global_id = $3) AS mapped_location_exists
     FROM operations_warehouses warehouse
     JOIN operations_locations location
       ON location.organization_id = warehouse.organization_id
      AND location.warehouse_id = warehouse.id
     WHERE warehouse.organization_id = $1::uuid
       AND warehouse.global_id = $2
     GROUP BY warehouse.address`,
    [
      ids.organization,
      created.warehouse.globalId,
      created.warehouse.inventoryLocationGlobalId,
    ],
  )
  assert.equal(createdEvidence.rows[0].location_count, 13)
  assert.equal(createdEvidence.rows[0].mapped_location_exists, true)
  assert.deepEqual(createdEvidence.rows[0].address, {
    name: 'Shopify two',
    line1: '200 Provider Road',
    city: 'Shelton',
    region: 'CT',
    postalCode: '06484',
    country: 'US',
  })

  const createdReplay =
    await persistence.createShopifyInventoryWarehouseAndMappingInPostgres({
      runtime,
      providerLocation: secondLocation,
      warehouse: {
        code: 'SHOPIFY-TWO',
        name: 'Shopify two',
        facilityType: 'distribution_center',
        timezone: 'America/New_York',
      },
      idempotencyKey: 'shopify-create-postgres-2890003',
      actorEmail,
    })
  assert.equal(createdReplay.replayed, true)
  assert.equal(createdReplay.warehouse.globalId, created.warehouse.globalId)
  await assert.rejects(
    persistence.createShopifyInventoryWarehouseAndMappingInPostgres({
      runtime,
      providerLocation: providerLocation(
        'gid://shopify/Location/2890005',
        'Atomic rollback location',
      ),
      warehouse: {
        code: 'EXISTING',
        name: 'Duplicate code must roll back',
        facilityType: 'distribution_center',
        timezone: 'America/New_York',
      },
      idempotencyKey: 'shopify-create-postgres-2890005',
      actorEmail,
    }),
    (error) => error.code === 'SHOPIFY_INVENTORY_WAREHOUSE_CODE_EXISTS',
  )
  const atomicCounts = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_warehouses
        WHERE organization_id = $1::uuid) AS warehouses,
       (SELECT count(*)::integer
        FROM operations_commerce_inventory_location_mappings
        WHERE organization_id = $1::uuid
          AND integration_account_id = $2::uuid) AS mappings,
       (SELECT count(*)::integer
        FROM operations_commerce_inventory_location_mappings
        WHERE organization_id = $1::uuid
          AND integration_account_id = $2::uuid
          AND external_location_id =
              'gid://shopify/Location/2890005') AS rollback_mappings`,
    [ids.organization, ids.account],
  )
  assert.deepEqual(atomicCounts.rows[0], {
    warehouses: 2,
    mappings: 2,
    rollback_mappings: 0,
  })
  const zeroWrites = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_command_receipts
     WHERE organization_id = $1::uuid
       AND status = 'succeeded'
       AND (result_payload ->> 'providerWrites')::integer = 0`,
    [ids.organization],
  )
  assert.equal(zeroWrites.rows[0].count, 2)

  const raceWarehouse = await pool.query(
    `INSERT INTO operations_warehouses (
       id, organization_id, code, name, facility_type,
       timezone, address, status, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'RACE-TARGET',
       'Cross-account race target', 'distribution_center',
       'America/New_York',
       '{"line1":"3 Race Way","city":"Trumbull","region":"CT","postalCode":"06611","country":"US"}'::jsonb,
       'active', $3, $3
     )
     RETURNING global_id`,
    [ids.raceWarehouse, ids.organization, actorEmail],
  )
  const raceLocation = await pool.query(
    `INSERT INTO operations_locations (
       id, organization_id, warehouse_id, code, zone,
       location_type, topology_level, pick_sequence, active,
       storage_function, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'RESERVE-01',
       'STORAGE', 'storage', 'bin', 100, true, 'reserve', $4, $4
     )
     RETURNING global_id`,
    [ids.raceLocation, ids.organization, ids.raceWarehouse, actorEmail],
  )
  const competingMappings = await Promise.allSettled([
    persistence.mapShopifyInventoryLocationInPostgres({
      runtime,
      providerLocation: providerLocation(
        'gid://shopify/Location/2890101',
        'Sandbox store race location',
      ),
      warehouseGlobalId: raceWarehouse.rows[0].global_id,
      locationGlobalId: raceLocation.rows[0].global_id,
      expectedMappingGlobalId: null,
      expectedRowVersion: null,
      idempotencyKey: 'shopify-map-race-sandbox-2890101',
      actorEmail,
    }),
    persistence.mapShopifyInventoryLocationInPostgres({
      runtime: runtimeTwo,
      providerLocation: providerLocation(
        'gid://shopify/Location/2890102',
        'Production store race location',
      ),
      warehouseGlobalId: raceWarehouse.rows[0].global_id,
      locationGlobalId: raceLocation.rows[0].global_id,
      expectedMappingGlobalId: null,
      expectedRowVersion: null,
      idempotencyKey: 'shopify-map-race-production-2890102',
      actorEmail,
    }),
  ])
  assert.equal(
    competingMappings.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  const rejectedMapping = competingMappings.find(
    (result) => result.status === 'rejected',
  )
  assert.ok(rejectedMapping && rejectedMapping.status === 'rejected')
  assert.ok([
    'SHOPIFY_INVENTORY_LOCATION_MAPPING_CONFLICT',
    'SHOPIFY_INVENTORY_PROJECTION_AUTHORITY_CONFLICT',
  ].includes(rejectedMapping.reason?.code))
  const raceTarget = await pool.query(
    `SELECT count(*)::integer AS mapping_count,
            count(DISTINCT integration_account_id)::integer AS account_count
     FROM operations_commerce_inventory_location_mappings
     WHERE organization_id = $1::uuid
       AND warehouse_id = $2::uuid
       AND location_id = $3::uuid
       AND active = true
       AND inventory_import_enabled = true`,
    [ids.organization, ids.raceWarehouse, ids.raceLocation],
  )
  assert.deepEqual(raceTarget.rows[0], {
    mapping_count: 1,
    account_count: 1,
  })
}

async function main() {
  const suppliedDatabaseUrl = String(process.env.DATABASE_URL || '').trim()
  if (suppliedDatabaseUrl) {
    const parsed = new URL(suppliedDatabaseUrl)
    assert.ok(
      ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname),
      'Supplied mapping-test database must be a local disposable database',
    )
    await waitForPostgres(suppliedDatabaseUrl)
    applyMigrations(suppliedDatabaseUrl)
    const pool = new Pool({ connectionString: suppliedDatabaseUrl, max: 4 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
    console.log('Shopify multi-location mapping PostgreSQL tests passed')
    return
  }
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-shopify-location-map-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  let started = false
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shopify_mapping',
      '-e', 'POSTGRES_DB=shopify_mapping',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    started = true
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:shopify_mapping@127.0.0.1:'
      + `${port}/shopify_mapping`
    )
    await waitForPostgres(databaseUrl)
    applyMigrations(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 4 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
  } finally {
    if (started) {
      command('docker', ['stop', container], { timeout: 30_000 })
    }
  }
  console.log('Shopify multi-location mapping PostgreSQL tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
