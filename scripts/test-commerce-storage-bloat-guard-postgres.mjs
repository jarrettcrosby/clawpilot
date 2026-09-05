#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim()
}

let disposableContainer = null
function stopDisposableContainer() {
  if (!disposableContainer) return
  try {
    command('docker', ['rm', '-f', disposableContainer], { timeout: 30_000 })
  } catch {}
  disposableContainer = null
}
process.once('exit', stopDisposableContainer)

let databaseUrl = String(process.env.DATABASE_URL || '').trim()
if (!databaseUrl) {
  command('docker', ['info'], { timeout: 30_000 })
  disposableContainer = (
    `clawpilot-commerce-storage-guard-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  // Docker Desktop can leave `docker run` waiting in Created state when the
  // host port is omitted. Pick an explicit high loopback port instead. The
  // random suffix keeps parallel local/CI runs extremely unlikely to collide.
  const port = 55_000 + Number.parseInt(randomUUID().slice(0, 4), 16) % 9_000
  command('docker', [
    'create', '--name', disposableContainer,
    '-e', 'POSTGRES_PASSWORD=commerce_guard',
    '-e', 'POSTGRES_DB=commerce_guard',
    '-p', `127.0.0.1:${port}:5432`,
    'pgvector/pgvector:pg16',
  ], { timeout: 60_000 })
  command('docker', ['start', disposableContainer], { timeout: 60_000 })
  databaseUrl = (
    `postgresql://postgres:commerce_guard@127.0.0.1:${port}/commerce_guard`
  )
  let ready = false
  let consecutiveExternalConnections = 0
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const readinessPool = new Pool({
      connectionString: databaseUrl,
      application_name: 'clawpilot-commerce-storage-bloat-guard-readiness',
      max: 1,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 1_000,
    })
    try {
      await readinessPool.query('SELECT 1')
      consecutiveExternalConnections += 1
      if (consecutiveExternalConnections >= 3) {
        ready = true
        break
      }
    } catch {
      consecutiveExternalConnections = 0
    } finally {
      await readinessPool.end().catch(() => {})
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  assert.equal(
    ready,
    true,
    'Disposable PostgreSQL did not accept three consecutive external connections',
  )
  command('npm', ['run', 'db:migrate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 180_000,
  })
}
const parsedUrl = new URL(databaseUrl)
if (!['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname)) {
  throw new Error(
    'Commerce storage guard PostgreSQL test only runs against local disposable databases.',
  )
}
const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//u, ''))
if (!(
  databaseName === 'commerce_guard'
  || /^clawpilot_storage_[a-z0-9_]+$/u.test(databaseName)
)) {
  throw new Error(
    'Commerce storage guard PostgreSQL test requires a dedicated disposable database.',
  )
}

const pool = new Pool({
  connectionString: parsedUrl.toString(),
  application_name: 'clawpilot-commerce-storage-bloat-guard-test',
  max: 4,
})

async function testConcurrentPreparedCaptureAndPurge() {
  const organizationId = randomUUID()
  const integrationAccountId = randomUUID()
  const providerAttemptId = randomUUID()
  const warehouseId = randomUUID()
  const locationId = randomUUID()
  const captureId = randomUUID()
  const contentIds = Array.from({ length: 40 }, () => randomUUID())
  const fixtureSuffix = randomUUID()
  const setup = await pool.connect()
  let oldestContent
  try {
    await setup.query('BEGIN')
    await setup.query(
      `INSERT INTO workspace_organizations (id, name)
       VALUES ($1::uuid, 'Concurrent storage guard fixture')`,
      [organizationId],
    )
    await setup.query(
      `INSERT INTO operations_integration_accounts (
         id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 'commerce', 'sandbox',
         'Concurrent storage guard account', 'active', '{}'::jsonb,
         $3, 1
       )`,
      [
        integrationAccountId,
        organizationId,
        `gid://shopify/Shop/${fixtureSuffix}`,
      ],
    )
    await setup.query(
      `INSERT INTO operations_warehouses (
         id, organization_id, code, name, timezone, address, status
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'Concurrent storage guard warehouse',
         'America/New_York', '{}'::jsonb, 'active'
       )`,
      [warehouseId, organizationId, `GUARD-${fixtureSuffix}`],
    )
    await setup.query(
      `INSERT INTO operations_locations (
         id, organization_id, warehouse_id, code, zone, location_type,
         pick_sequence, active
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'STORAGE', 'storage', 0, true
       )`,
      [locationId, organizationId, warehouseId, `BIN-${fixtureSuffix}`],
    )
    await setup.query(
      `INSERT INTO operations_commerce_provider_attempts (
         id, organization_id, integration_account_id,
         action, adapter_version, idempotency_key, request_hash,
         redacted_request, lease_token, lease_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'inventory.levels.read',
         'guard-concurrency-v1', $4, repeat('a', 64),
         '{"resource":"inventory","readOnly":true}'::jsonb,
         gen_random_uuid(), clock_timestamp() + interval '20 minutes'
       )`,
      [
        providerAttemptId,
        organizationId,
        integrationAccountId,
        `guard-concurrency-${providerAttemptId}`,
      ],
    )
    for (const [index, contentId] of contentIds.entries()) {
      const inserted = await setup.query(
        `WITH identity AS (
           SELECT encode(digest($6, 'sha256'), 'hex') AS snapshot_hash
         ), payload AS (
           SELECT snapshot_hash,
                  jsonb_build_object(
                    'location', jsonb_build_object('id', $5::text),
                    'levels', '[]'::jsonb,
                    'enrichment', '{}'::jsonb,
                    'snapshotHash', snapshot_hash
                  ) AS snapshot_content
           FROM identity
         )
         INSERT INTO operations_commerce_inventory_snapshot_contents (
           id, organization_id, integration_account_id, provider,
           adapter_version, provider_location_id, snapshot_hash,
           level_count, snapshot_content, content_bytes, created_at
         )
         SELECT $1::uuid, $2::uuid, $3::uuid, 'shopify', $4, $5::text,
                snapshot_hash, 0, snapshot_content,
                octet_length(convert_to(snapshot_content::text, 'UTF8')),
                clock_timestamp() - interval '1 hour'
                  + $7::integer * interval '1 second'
         FROM payload
         RETURNING id::text, snapshot_hash, content_bytes`,
        [
          contentId,
          organizationId,
          integrationAccountId,
          'guard-concurrency-v1',
          'guard-concurrency-location',
          `guard-concurrency-payload-${index}`,
          index,
        ],
      )
      if (index === 0) oldestContent = inserted.rows[0]
    }
    await setup.query('COMMIT')
  } catch (error) {
    await setup.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    setup.release()
  }

  const captureClient = await pool.connect()
  const purgeClient = await pool.connect()
  let purgePromise = null
  let captureTransactionOpen = false
  try {
    const identityKey = [
      'commerce-inventory-snapshot-content',
      organizationId,
      integrationAccountId,
      'shopify',
      'guard-concurrency-v1',
      'guard-concurrency-location',
      oldestContent.snapshot_hash,
    ].join(':')
    await captureClient.query('BEGIN')
    captureTransactionOpen = true
    await captureClient.query(`SET LOCAL statement_timeout = '5s'`)
    const productionEnforcement = await captureClient.query(`
      SELECT current_setting('session_replication_role') AS replication_role,
             EXISTS (
               SELECT 1
               FROM pg_trigger
               WHERE tgrelid =
                 'operations_commerce_inventory_captures'::regclass
                 AND tgname =
                   'validate_operations_commerce_inventory_capture_content_insert'
                 AND tgenabled = 'O'
             ) AS validation_trigger_enabled,
             EXISTS (
               SELECT 1
               FROM pg_constraint
               WHERE conrelid =
                 'operations_commerce_inventory_captures'::regclass
                 AND conname =
                   'operations_commerce_inventory_captures_snapshot_content_fkey'
             ) AS snapshot_content_fkey_exists
    `)
    assert.deepEqual(productionEnforcement.rows[0], {
      replication_role: 'origin',
      validation_trigger_enabled: true,
      snapshot_content_fkey_exists: true,
    })
    await captureClient.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [identityKey],
    )
    const purgeBackend = await purgeClient.query(
      'SELECT pg_backend_pid()::integer AS pid',
    )
    await purgeClient.query(`SET statement_timeout = '8s'`)
    purgePromise = purgeClient.query(
      `SELECT *
       FROM purge_operations_commerce_inventory_snapshot_payloads(1000)`,
    )
    let purgeWaitingOnIdentity = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await captureClient.query(
        `SELECT wait_event_type, wait_event
         FROM pg_stat_activity
         WHERE pid = $1::integer`,
        [purgeBackend.rows[0].pid],
      )
      purgeWaitingOnIdentity = (
        activity.rows[0]?.wait_event_type === 'Lock'
        && activity.rows[0]?.wait_event === 'advisory'
      )
      if (purgeWaitingOnIdentity) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    assert.equal(
      purgeWaitingOnIdentity,
      true,
      'Purge must reach the shared identity lock before capture inserts',
    )
    const insertedCapture = await captureClient.query(
      `INSERT INTO operations_commerce_inventory_captures (
         id, organization_id, integration_account_id,
         provider_attempt_id, warehouse_id, location_id, provider,
         adapter_version, credential_version, request_hash, snapshot_hash,
         provider_location_id, provider_fetched_at, level_count,
         captured_snapshot, snapshot_content_id, provider_page_count,
         snapshot_bytes
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         'shopify', 'guard-concurrency-v1', 1, repeat('a', 64), $7,
         'guard-concurrency-location', clock_timestamp(), 0,
         NULL, $8::uuid, 1, $9
       )
       RETURNING global_id`,
      [
        captureId,
        organizationId,
        integrationAccountId,
        providerAttemptId,
        warehouseId,
        locationId,
        oldestContent.snapshot_hash,
        oldestContent.id,
        oldestContent.content_bytes,
      ],
    )
    assert.match(
      insertedCapture.rows[0]?.global_id || '',
      /^gisc(?:[0-9]{7}|[0-9a-v]{12})$/,
    )
    await captureClient.query('COMMIT')
    captureTransactionOpen = false
    const purged = await purgePromise
    purgePromise = null
    assert.equal(
      purged.rows[0]?.purged_rows,
      7,
      'Purge must preserve the newly committed prepared capture payload',
    )
    const retained = await purgeClient.query(
      `SELECT content.snapshot_content IS NOT NULL AS payload_live,
              content.payload_purged_at IS NULL AS not_tombstoned,
              attempt.state
       FROM operations_commerce_inventory_captures capture
       JOIN operations_commerce_inventory_snapshot_contents content
         ON content.organization_id = capture.organization_id
        AND content.integration_account_id = capture.integration_account_id
        AND content.id = capture.snapshot_content_id
       JOIN operations_commerce_provider_attempts attempt
         ON attempt.organization_id = capture.organization_id
        AND attempt.integration_account_id = capture.integration_account_id
        AND attempt.id = capture.provider_attempt_id
       WHERE capture.id = $1::uuid`,
      [captureId],
    )
    assert.deepEqual(retained.rows[0], {
      payload_live: true,
      not_tombstoned: true,
      state: 'prepared',
    })
  } finally {
    if (captureTransactionOpen) {
      await captureClient.query('ROLLBACK').catch(() => {})
    }
    await purgePromise?.catch(() => {})
    captureClient.release()
    purgeClient.release()
    // Attempts and captures are production-immutable by design. The enclosing
    // database is therefore required to be disposable and is destroyed by the
    // test-owned container path or its external test harness.
  }
}

const client = await pool.connect()
try {
  const migration = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM schema_migrations
       WHERE filename = '0351_operations_commerce_storage_bloat_guard.sql'
     ) AS applied`,
  )
  assert.equal(migration.rows[0]?.applied, true, 'migration 0351 must be applied')
  const onlineMigration = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM schema_migrations
       WHERE filename =
         '0352_operations_commerce_storage_bloat_guard_online.sql'
     ) AS applied`,
  )
  assert.equal(
    onlineMigration.rows[0]?.applied,
    true,
    'online migration 0352 must be applied',
  )
  const onlineSchema = await client.query(`
    SELECT
      count(*) FILTER (WHERE index.indisvalid)::integer AS valid_indexes,
      bool_and(index.indisready) AS all_ready,
      (
        SELECT constraint_record.convalidated
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
          'operations_commerce_inventory_level_set_source_fkey'
      ) AS source_fkey_validated
    FROM pg_index index
    JOIN pg_class index_class ON index_class.oid = index.indexrelid
    WHERE index_class.relname = ANY(ARRAY[
      'commerce_intake_read_intents_payload_purge_idx',
      'operations_commerce_inventory_level_set_reuse_idx',
      'operations_commerce_inventory_level_set_source_idx',
      'operations_commerce_inventory_retention_idx',
      'operations_commerce_inventory_snapshot_contents_hash_unique',
      'operations_commerce_inventory_snapshot_payload_retention_idx'
    ])
  `)
  assert.deepEqual(onlineSchema.rows[0], {
    valid_indexes: 6,
    all_ready: true,
    source_fkey_validated: true,
  })

  await client.query('BEGIN')
  const registryBefore = await client.query(
    `SELECT count(*)::integer AS count
     FROM crm_reference_registry
     WHERE reference_code LIKE 'giil%'`,
  )

  // The fixture deliberately bypasses unrelated organization/provider foreign
  // keys. Normal trigger behavior is restored before exercising maintenance.
  await client.query(`SET LOCAL session_replication_role = 'replica'`)
  await client.query(`
    DO $$
    DECLARE
      fixture_org uuid := '10000000-0000-4000-8000-000000000001';
      fixture_account uuid := '10000000-0000-4000-8000-000000000002';
      fixture_mapping uuid := '10000000-0000-4000-8000-000000000003';
      fixture_warehouse uuid := '10000000-0000-4000-8000-000000000004';
      fixture_location uuid := '10000000-0000-4000-8000-000000000005';
      fixture_pool uuid := '10000000-0000-4000-8000-000000000006';
      base_time timestamptz := now() - interval '1 hour';
      run_id uuid;
      run_hash text;
      run_number integer;
    BEGIN
      FOR run_number IN 1..131 LOOP
        run_id := md5('guard-full-' || run_number::text)::uuid;
        run_hash := encode(
          digest('guard-state-' || run_number::text, 'sha256'),
          'hex'
        );
        INSERT INTO operations_commerce_inventory_sync_runs (
          id, organization_id, integration_account_id, provider_attempt_id,
          capture_id, location_mapping_id, warehouse_id, location_id,
          inventory_pool_id, provider, adapter_version, credential_version,
          idempotency_key, request_hash, snapshot_hash, status,
          provider_location_id, provider_location_name, provider_fetched_at,
          levels_seen, levels_mapped, levels_projected, levels_unmapped,
          levels_untracked, negative_available_levels,
          equation_mismatch_levels, provider_available_quantity,
          provider_committed_quantity, provider_on_hand_quantity,
          operational_available_quantity, positions_created,
          positions_updated, positions_zeroed, provider_writes,
          order_quantity_adjustment, created_at, completed_at,
          level_set_hash, source_level_set_run_id
        ) VALUES (
          run_id, fixture_org, fixture_account,
          md5('guard-attempt-' || run_number::text)::uuid,
          md5('guard-capture-' || run_number::text)::uuid,
          fixture_mapping, fixture_warehouse, fixture_location, fixture_pool,
          'shopify', 'guard-test-v1', 1,
          'guard-full-' || run_number::text, repeat('a', 64),
          repeat('b', 64), 'succeeded', 'guard-location', 'Guard location',
          base_time + run_number * interval '1 second',
          CASE WHEN run_number = 1 THEN 10000 ELSE 1 END,
          0, 0, CASE WHEN run_number = 1 THEN 10000 ELSE 1 END, 0, 0, 0,
          10 + run_number, 0, 10 + run_number, 0,
          0, 0, 0, 0, 0,
          base_time + run_number * interval '1 second',
          base_time + run_number * interval '1 second',
          run_hash, NULL
        );
        INSERT INTO operations_commerce_inventory_levels (
          organization_id, sync_run_id, integration_account_id,
          location_mapping_id, warehouse_id, location_id, inventory_pool_id,
          provider_location_id, external_inventory_item_id, tracked,
          mapping_state, projection_state, provider_available_quantity,
          provider_incoming_quantity, provider_committed_quantity,
          provider_damaged_quantity, provider_on_hand_quantity,
          provider_quality_control_quantity, provider_reserved_quantity,
          provider_safety_stock_quantity, provider_quantity_evidence,
          operational_available_quantity, equation_matches,
          product_snapshot, source_hash, created_at
        ) VALUES (
          fixture_org, run_id, fixture_account, fixture_mapping,
          fixture_warehouse, fixture_location, fixture_pool, 'guard-location',
          'inventory-item-' || run_number::text, true, 'unmapped', 'unmapped',
          10 + run_number, 0, 0, 0, 10 + run_number, 0, 0, 0,
          jsonb_build_object('available', 10 + run_number),
          0, true, '{}'::jsonb, repeat('c', 64),
          base_time + run_number * interval '1 second'
        );
        IF run_number = 1 THEN
          INSERT INTO operations_commerce_inventory_levels (
            organization_id, sync_run_id, integration_account_id,
            location_mapping_id, warehouse_id, location_id,
            inventory_pool_id, provider_location_id,
            external_inventory_item_id, tracked, mapping_state,
            projection_state, provider_available_quantity,
            provider_incoming_quantity, provider_committed_quantity,
            provider_damaged_quantity, provider_on_hand_quantity,
            provider_quality_control_quantity, provider_reserved_quantity,
            provider_safety_stock_quantity, provider_quantity_evidence,
            operational_available_quantity, equation_matches,
            product_snapshot, source_hash, created_at
          )
          SELECT
            fixture_org, run_id, fixture_account, fixture_mapping,
            fixture_warehouse, fixture_location, fixture_pool,
            'guard-location', 'inventory-item-1-' || level_number::text,
            true, 'unmapped', 'unmapped', level_number, 0, 0, 0,
            level_number, 0, 0, 0,
            jsonb_build_object('available', level_number),
            0, true, '{}'::jsonb, repeat('d', 64), base_time
          FROM generate_series(2, 10000) AS generated(level_number);
        END IF;
      END LOOP;

      -- Old A and B observations pin the first two full sets until the alias
      -- maintenance pass removes observations outside the hard 128-run cap.
      INSERT INTO operations_commerce_inventory_sync_runs (
        id, organization_id, integration_account_id, provider_attempt_id,
        capture_id, location_mapping_id, warehouse_id, location_id,
        inventory_pool_id, provider, adapter_version, credential_version,
        idempotency_key, request_hash, snapshot_hash, status,
        provider_location_id, provider_location_name, provider_fetched_at,
        levels_seen, levels_mapped, levels_projected, levels_unmapped,
        levels_untracked, negative_available_levels,
        equation_mismatch_levels, provider_available_quantity,
        provider_committed_quantity, provider_on_hand_quantity,
        operational_available_quantity, positions_created,
        positions_updated, positions_zeroed, provider_writes,
        order_quantity_adjustment, created_at, completed_at,
        level_set_hash, source_level_set_run_id
      )
      SELECT
        md5('guard-alias-' || source_number::text)::uuid,
        source.organization_id, source.integration_account_id,
        md5('guard-alias-attempt-' || source_number::text)::uuid,
        md5('guard-alias-capture-' || source_number::text)::uuid,
        source.location_mapping_id, source.warehouse_id, source.location_id,
        source.inventory_pool_id, source.provider, source.adapter_version,
        source.credential_version, 'guard-alias-' || source_number::text,
        source.request_hash, source.snapshot_hash, source.status,
        source.provider_location_id, source.provider_location_name,
        base_time + (source_number + 0.5) * interval '1 second',
        source.levels_seen, source.levels_mapped, source.levels_projected,
        source.levels_unmapped, source.levels_untracked,
        source.negative_available_levels, source.equation_mismatch_levels,
        source.provider_available_quantity, source.provider_committed_quantity,
        source.provider_on_hand_quantity,
        source.operational_available_quantity, 0, 0, 0, 0, 0,
        base_time + (source_number + 0.5) * interval '1 second',
        base_time + (source_number + 0.5) * interval '1 second',
        source.level_set_hash, source.id
      FROM unnest(ARRAY[1, 2]) AS selected(source_number)
      JOIN operations_commerce_inventory_sync_runs source
        ON source.id = md5('guard-full-' || source_number::text)::uuid;

      -- The current observation is an alias of the newest full set. Readers
      -- must retain current freshness while resolving levels from its source.
      INSERT INTO operations_commerce_inventory_sync_runs (
        id, organization_id, integration_account_id, provider_attempt_id,
        capture_id, location_mapping_id, warehouse_id, location_id,
        inventory_pool_id, provider, adapter_version, credential_version,
        idempotency_key, request_hash, snapshot_hash, status,
        provider_location_id, provider_location_name, provider_fetched_at,
        levels_seen, levels_mapped, levels_projected, levels_unmapped,
        levels_untracked, negative_available_levels,
        equation_mismatch_levels, provider_available_quantity,
        provider_committed_quantity, provider_on_hand_quantity,
        operational_available_quantity, positions_created,
        positions_updated, positions_zeroed, provider_writes,
        order_quantity_adjustment, created_at, completed_at,
        level_set_hash, source_level_set_run_id
      )
      SELECT
        md5('guard-current-alias')::uuid,
        source.organization_id, source.integration_account_id,
        md5('guard-current-attempt')::uuid,
        md5('guard-current-capture')::uuid,
        source.location_mapping_id, source.warehouse_id, source.location_id,
        source.inventory_pool_id, source.provider, source.adapter_version,
        source.credential_version, 'guard-current-alias', source.request_hash,
        source.snapshot_hash, source.status, source.provider_location_id,
        source.provider_location_name, base_time + interval '132 seconds',
        source.levels_seen, source.levels_mapped, source.levels_projected,
        source.levels_unmapped, source.levels_untracked,
        source.negative_available_levels, source.equation_mismatch_levels,
        source.provider_available_quantity, source.provider_committed_quantity,
        source.provider_on_hand_quantity,
        source.operational_available_quantity, 0, 0, 0, 0, 0,
        base_time + interval '132 seconds', base_time + interval '132 seconds',
        source.level_set_hash, source.id
      FROM operations_commerce_inventory_sync_runs source
      WHERE source.id = md5('guard-full-131')::uuid;
    END;
    $$;
  `)
  await client.query(`
    INSERT INTO workspace_organizations (id, name) VALUES (
      '10000000-0000-4000-8000-000000000001',
      'Commerce storage guard fixture'
    );
    INSERT INTO app_users (email, role, status) VALUES (
      'guard-test@example.com', 'admin', 'active'
    );
    INSERT INTO pipeline_spaces (
      id, name, owner_email, workspace_organization_id, is_default
    ) VALUES (
      '20000000-0000-4000-8000-000000000002',
      'Commerce storage guard pipeline', 'guard-test@example.com',
      '10000000-0000-4000-8000-000000000001', true
    );
    INSERT INTO operations_integration_accounts (
      id, global_id, organization_id, provider, integration_type,
      environment, display_name, status, configuration,
      external_account_id, commerce_credential_generation
    ) VALUES (
      '10000000-0000-4000-8000-000000000002', 'gia9999001',
      '10000000-0000-4000-8000-000000000001',
      'shopify', 'commerce', 'sandbox', 'Commerce storage guard account',
      'active', '{}'::jsonb, 'gid://shopify/Shop/9999001', 1
    );
    INSERT INTO operations_commerce_provider_attempts (
      id, global_id, organization_id, integration_account_id,
      action, adapter_version, idempotency_key, request_hash,
      state, completed_at, created_by
    ) VALUES
    (
      '20000000-0000-4000-8000-000000000003', 'gxa9999001',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      'commerce.intake.read', 'guard-test-v1', 'guard-staged',
      repeat('1', 64), 'succeeded', now(), 'guard-test@example.com'
    ),
    (
      '20000000-0000-4000-8000-000000000022', 'gxa9999002',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      'commerce.intake.read', 'guard-test-v1', 'guard-expired',
      repeat('4', 64), 'succeeded', now(), 'guard-test@example.com'
    ),
    (
      '20000000-0000-4000-8000-000000000032', 'gxa9999003',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      'commerce.intake.read', 'guard-test-v1', 'guard-retry-window',
      repeat('7', 64), 'succeeded', now(), 'guard-test@example.com'
    );

    INSERT INTO operations_commerce_intake_runs (
      id, global_id, organization_id, integration_account_id, pipeline_id,
      provider, resource, credential_version, provider_api_version,
      normalizer_version, idempotency_key, request_hash,
      provider_attempt_id, window_end, workflow_state,
      records_seen, records_staged, created_by, updated_by,
      created_at, updated_at, expires_at
    ) VALUES (
      '20000000-0000-4000-8000-000000000001', 'gcir9999001',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      'shopify', 'products_and_orders', 1, 'guard-test-v1',
      'guard-test-v1', 'guard-staged', repeat('1', 64),
      '20000000-0000-4000-8000-000000000003',
      now() - interval '2 days', 'held', 1, 1,
      'guard-test@example.com', 'guard-test@example.com',
      now() - interval '1 hour', now() - interval '1 hour',
      now() + interval '6 days'
    );

    INSERT INTO operations_commerce_intake_read_intents (
      id, organization_id, integration_account_id, pipeline_id,
      provider, resource, intake_action, idempotency_key, request_hash,
      credential_version, target_kind, session_id, batch_number,
      window_end, query_hash, intent_state, provider_attempt_id,
      response_ciphertext, response_iv, response_tag, response_hash,
      response_bytes, response_encryption_version, staged_run_id,
      row_version, created_by, updated_by, created_at, updated_at, expires_at
    ) VALUES
    (
      '20000000-0000-4000-8000-000000000010',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      'shopify', 'orders', 'fetch', 'guard-staged', repeat('1', 64),
      1, 'none', '20000000-0000-4000-8000-000000000011', 1,
      now() - interval '2 days', repeat('2', 64), 'staged',
      '20000000-0000-4000-8000-000000000003',
      decode('aabb', 'hex'), decode(repeat('11', 12), 'hex'),
      decode(repeat('22', 16), 'hex'), repeat('3', 64), 2, 1,
      '20000000-0000-4000-8000-000000000001', 5,
      'guard-test@example.com', 'guard-test@example.com',
      now() - interval '1 hour', now() - interval '1 hour',
      now() + interval '6 days'
    ),
    (
      '20000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      'shopify', 'orders', 'fetch', 'guard-expired', repeat('4', 64),
      1, 'none', '20000000-0000-4000-8000-000000000021', 1,
      now() - interval '3 days', repeat('5', 64), 'captured',
      '20000000-0000-4000-8000-000000000022',
      decode('ccdd', 'hex'), decode(repeat('33', 12), 'hex'),
      decode(repeat('44', 16), 'hex'), repeat('6', 64), 2, 1,
      NULL, 3, 'guard-test@example.com', 'guard-test@example.com',
      now() - interval '2 days', now() - interval '2 days',
      now() - interval '1 day'
    ),
    (
      '20000000-0000-4000-8000-000000000030',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      'shopify', 'orders', 'fetch', 'guard-retry-window', repeat('7', 64),
      1, 'none', '20000000-0000-4000-8000-000000000031', 1,
      now(), repeat('8', 64), 'captured',
      '20000000-0000-4000-8000-000000000032',
      decode('eeff', 'hex'), decode(repeat('55', 12), 'hex'),
      decode(repeat('66', 16), 'hex'), repeat('9', 64), 2, 1,
      NULL, 2, 'guard-test@example.com', 'guard-test@example.com',
      now() - interval '1 hour', now() - interval '1 hour',
      now() + interval '1 day'
    );
  `)
  await client.query(`SET LOCAL session_replication_role = 'origin'`)

  const intakePurged = await client.query(
    `SELECT * FROM purge_operations_commerce_intake_read_payloads(5000)`,
  )
  assert.deepEqual(intakePurged.rows[0], {
    purged_rows: 2,
    purged_bytes: '4',
  })
  const intakeProof = await client.query(`
    SELECT id, intent_state, response_ciphertext IS NOT NULL AS encrypted,
           response_hash, response_bytes, response_encryption_version,
           response_purged_at IS NOT NULL AS purged,
           staged_run_id, row_version, last_error_code
    FROM operations_commerce_intake_read_intents
    WHERE id IN (
      '20000000-0000-4000-8000-000000000010',
      '20000000-0000-4000-8000-000000000020',
      '20000000-0000-4000-8000-000000000030'
    )
    ORDER BY id
  `)
  assert.deepEqual(intakeProof.rows.map((row) => ({
    state: row.intent_state,
    encrypted: row.encrypted,
    hash: row.response_hash,
    bytes: row.response_bytes,
    encryptionVersion: row.response_encryption_version,
    purged: row.purged,
    stagedRunId: row.staged_run_id,
    rowVersion: Number(row.row_version),
    lastErrorCode: row.last_error_code,
  })), [
    {
      state: 'staged', encrypted: false, hash: '3'.repeat(64), bytes: 2,
      encryptionVersion: 1, purged: true,
      stagedRunId: '20000000-0000-4000-8000-000000000001',
      rowVersion: 6, lastErrorCode: null,
    },
    {
      state: 'expired', encrypted: false, hash: '6'.repeat(64), bytes: 2,
      encryptionVersion: 1, purged: true, stagedRunId: null,
      rowVersion: 4,
      lastErrorCode: 'COMMERCE_INTAKE_READ_INTENT_EXPIRED',
    },
    {
      state: 'captured', encrypted: true, hash: '9'.repeat(64), bytes: 2,
      encryptionVersion: 1, purged: false, stagedRunId: null,
      rowVersion: 2, lastErrorCode: null,
    },
  ])
  await client.query('SAVEPOINT restore_purged_payload')
  await assert.rejects(
    client.query(`
      UPDATE operations_commerce_intake_read_intents
      SET response_ciphertext = decode('aabb', 'hex'),
          response_iv = decode(repeat('11', 12), 'hex'),
          response_tag = decode(repeat('22', 16), 'hex'),
          response_purged_at = NULL,
          row_version = row_version + 1,
          updated_by = 'guard-test@example.com',
          updated_at = now()
      WHERE id = '20000000-0000-4000-8000-000000000010'
    `),
    /Purged commerce intake response evidence is immutable/,
  )
  await client.query('ROLLBACK TO SAVEPOINT restore_purged_payload')

  await client.query(`
    WITH snapshots AS (
      SELECT
        snapshot_number,
        encode(
          digest(
            'guard-snapshot-payload-' || snapshot_number::text,
            'sha256'
          ),
          'hex'
        ) AS snapshot_hash
      FROM generate_series(1, 40) AS generated(snapshot_number)
    ), payloads AS (
      SELECT
        snapshot_number,
        snapshot_hash,
        jsonb_build_object(
          'location', jsonb_build_object('id', 'guard-location'),
          'levels', '[]'::jsonb,
          'enrichment', '{}'::jsonb,
          'snapshotHash', snapshot_hash
        ) AS snapshot_content
      FROM snapshots
    )
    INSERT INTO operations_commerce_inventory_snapshot_contents (
      id, organization_id, integration_account_id, provider,
      adapter_version, provider_location_id, snapshot_hash, level_count,
      snapshot_content, content_bytes, created_by, created_at
    )
    SELECT
      md5('guard-snapshot-content-' || snapshot_number::text)::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      'shopify', 'guard-test-v1', 'guard-location', snapshot_hash, 0,
      snapshot_content,
      octet_length(convert_to(snapshot_content::text, 'UTF8')),
      'guard-test@example.com',
      now() - interval '1 hour' + snapshot_number * interval '1 second'
    FROM payloads
  `)
  await client.query(`
    INSERT INTO operations_commerce_provider_attempts (
      id, organization_id, integration_account_id, action, adapter_version,
      idempotency_key, request_hash, redacted_request,
      lease_token, lease_expires_at, created_by
    ) VALUES (
      '20000000-0000-4000-8000-000000000042'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      'inventory.levels.read', 'guard-test-v1',
      'guard-prepared-replay', repeat('f', 64),
      '{"resource":"inventory","readOnly":true}'::jsonb,
      '20000000-0000-4000-8000-000000000043'::uuid,
      clock_timestamp() + interval '20 minutes',
      'guard-test@example.com'
    )
  `)
  await client.query(`SET LOCAL session_replication_role = 'replica'`)
  await client.query(`
    INSERT INTO operations_commerce_inventory_captures (
      id, organization_id, integration_account_id, provider_attempt_id,
      warehouse_id, location_id, provider, adapter_version,
      credential_version, request_hash, snapshot_hash,
      provider_location_id, provider_fetched_at, level_count,
      captured_snapshot, snapshot_content_id, provider_page_count,
      snapshot_bytes, created_by
    )
    SELECT
      md5('guard-current-capture')::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      md5('guard-current-attempt')::uuid,
      '10000000-0000-4000-8000-000000000004'::uuid,
      '10000000-0000-4000-8000-000000000005'::uuid,
      'shopify', 'guard-test-v1', 1, repeat('e', 64),
      content.snapshot_hash, 'guard-location', now(), 0,
      NULL, content.id, 1, content.content_bytes,
      'guard-test@example.com'
    FROM operations_commerce_inventory_snapshot_contents content
    WHERE content.id = md5('guard-snapshot-content-1')::uuid
  `)
  await client.query(`
    INSERT INTO operations_commerce_inventory_captures (
      id, organization_id, integration_account_id, provider_attempt_id,
      warehouse_id, location_id, provider, adapter_version,
      credential_version, request_hash, snapshot_hash,
      provider_location_id, provider_fetched_at, level_count,
      captured_snapshot, snapshot_content_id, provider_page_count,
      snapshot_bytes, created_by
    )
    SELECT
      '20000000-0000-4000-8000-000000000044'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      '20000000-0000-4000-8000-000000000042'::uuid,
      '10000000-0000-4000-8000-000000000004'::uuid,
      '10000000-0000-4000-8000-000000000005'::uuid,
      'shopify', 'guard-test-v1', 1, repeat('f', 64),
      content.snapshot_hash, 'guard-location', now(), 0,
      NULL, content.id, 1, content.content_bytes,
      'guard-test@example.com'
    FROM operations_commerce_inventory_snapshot_contents content
    WHERE content.id = md5('guard-snapshot-content-2')::uuid
  `)
  await client.query(`SET LOCAL session_replication_role = 'origin'`)

  const snapshotPurged = await client.query(
    `SELECT *
     FROM purge_operations_commerce_inventory_snapshot_payloads(1000)`,
  )
  assert.equal(
    snapshotPurged.rows[0]?.purged_rows,
    7,
    'A capture owned by a prepared attempt must retain exact replay payload',
  )
  assert.ok(Number(snapshotPurged.rows[0]?.purged_bytes) > 0)
  const crashRetryReplay = await client.query(`
    SELECT content.snapshot_content, content.payload_purged_at
    FROM operations_commerce_inventory_captures capture
    JOIN operations_commerce_provider_attempts attempt
      ON attempt.organization_id = capture.organization_id
     AND attempt.integration_account_id = capture.integration_account_id
     AND attempt.id = capture.provider_attempt_id
    JOIN operations_commerce_inventory_snapshot_contents content
      ON content.organization_id = capture.organization_id
     AND content.integration_account_id = capture.integration_account_id
     AND content.id = capture.snapshot_content_id
    WHERE capture.id = '20000000-0000-4000-8000-000000000044'::uuid
      AND attempt.state = 'prepared'
  `)
  assert.equal(crashRetryReplay.rowCount, 1)
  assert.equal(crashRetryReplay.rows[0]?.payload_purged_at, null)
  assert.equal(
    crashRetryReplay.rows[0]?.snapshot_content?.location?.id,
    'guard-location',
  )
  await client.query(`
    UPDATE operations_commerce_provider_attempts
    SET state = 'succeeded',
        redacted_response = '{"inventoryApplied":true}'::jsonb,
        lease_token = NULL,
        lease_expires_at = NULL,
        completed_at = clock_timestamp()
    WHERE id = '20000000-0000-4000-8000-000000000042'::uuid
  `)
  const terminalSnapshotPurge = await client.query(
    `SELECT *
     FROM purge_operations_commerce_inventory_snapshot_payloads(1000)`,
  )
  assert.equal(
    terminalSnapshotPurge.rows[0]?.purged_rows,
    1,
    'Terminal attempts may release old optional replay payloads',
  )
  const snapshotProof = await client.query(`
    SELECT
      count(*) FILTER (WHERE snapshot_content IS NOT NULL)::integer
        AS live_rows,
      count(*) FILTER (WHERE payload_purged_at IS NOT NULL)::integer
        AS purged_rows,
      bool_and(
        snapshot_hash ~ '^[a-f0-9]{64}$'
        AND content_bytes >= 2
        AND level_count = 0
      ) FILTER (WHERE payload_purged_at IS NOT NULL) AS purged_proof_retained,
      bool_or(
        id = md5('guard-snapshot-content-1')::uuid
        AND snapshot_content IS NOT NULL
        AND payload_purged_at IS NULL
      ) AS current_payload_retained
    FROM operations_commerce_inventory_snapshot_contents
    WHERE organization_id = '10000000-0000-4000-8000-000000000001'
      AND integration_account_id =
        '10000000-0000-4000-8000-000000000002'
      AND provider_location_id = 'guard-location'
  `)
  assert.deepEqual(snapshotProof.rows[0], {
    live_rows: 32,
    purged_rows: 8,
    purged_proof_retained: true,
    current_payload_retained: true,
  })

  const purgedSnapshot = await client.query(`
    SELECT id::text, snapshot_hash, snapshot_content,
           payload_purged_at IS NOT NULL AS purged
    FROM operations_commerce_inventory_snapshot_contents
    WHERE organization_id =
          '10000000-0000-4000-8000-000000000001'::uuid
      AND integration_account_id =
          '10000000-0000-4000-8000-000000000002'::uuid
      AND provider_location_id = 'guard-location'
      AND payload_purged_at IS NOT NULL
    ORDER BY created_at, id
    LIMIT 1
  `)
  assert.equal(purgedSnapshot.rowCount, 1)
  await client.query('SAVEPOINT restore_purged_snapshot')
  await assert.rejects(
    client.query(
      `UPDATE operations_commerce_inventory_snapshot_contents
       SET snapshot_content = jsonb_build_object(
             'location', jsonb_build_object('id', provider_location_id),
             'levels', '[]'::jsonb,
             'enrichment', '{}'::jsonb,
             'snapshotHash', snapshot_hash
           ),
           payload_purged_at = NULL
       WHERE id = $1::uuid`,
      [purgedSnapshot.rows[0].id],
    ),
    /Commerce inventory evidence is immutable/,
  )
  await client.query('ROLLBACK TO SAVEPOINT restore_purged_snapshot')

  const recurringPayload = JSON.stringify({
    location: { id: 'guard-location' },
    levels: [],
    enrichment: {},
    snapshotHash: purgedSnapshot.rows[0].snapshot_hash,
  })
  await client.query(
    `INSERT INTO operations_commerce_inventory_snapshot_contents (
       organization_id, integration_account_id, provider,
       adapter_version, provider_location_id, snapshot_hash, level_count,
       snapshot_content, content_bytes, created_by
     ) VALUES (
       '10000000-0000-4000-8000-000000000001'::uuid,
       '10000000-0000-4000-8000-000000000002'::uuid,
       'shopify', 'guard-test-v1', 'guard-location', $1, 0,
       $2::jsonb, $3, 'guard-test@example.com'
     )`,
    [
      purgedSnapshot.rows[0].snapshot_hash,
      recurringPayload,
      Buffer.byteLength(recurringPayload, 'utf8'),
    ],
  )
  const recurringPurge = await client.query(
    `SELECT *
     FROM purge_operations_commerce_inventory_snapshot_payloads(1000)`,
  )
  assert.equal(recurringPurge.rows[0]?.purged_rows, 1)
  const recurringProof = await client.query(
    `SELECT
       count(*) FILTER (WHERE snapshot_content IS NOT NULL)::integer
         AS live_rows,
       count(*) FILTER (
         WHERE snapshot_hash = $1
           AND snapshot_content IS NOT NULL
       )::integer AS recurring_live_rows,
       count(*) FILTER (
         WHERE snapshot_hash = $1
           AND payload_purged_at IS NOT NULL
       )::integer AS recurring_purged_rows
     FROM operations_commerce_inventory_snapshot_contents
     WHERE organization_id =
       '10000000-0000-4000-8000-000000000001'::uuid
       AND integration_account_id =
         '10000000-0000-4000-8000-000000000002'::uuid
       AND provider_location_id = 'guard-location'`,
    [purgedSnapshot.rows[0].snapshot_hash],
  )
  assert.deepEqual(recurringProof.rows[0], {
    live_rows: 32,
    recurring_live_rows: 1,
    recurring_purged_rows: 1,
  })

  await client.query(`
    UPDATE operations_commerce_storage_maintenance_lanes
    SET next_run_at = clock_timestamp(),
        lease_token = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL
    WHERE lane_name = 'commerce-storage'
  `)
  const firstLease = await client.query(
    `SELECT claim_operations_commerce_storage_maintenance(
       'guard-postgres-primary', 10, 120
     )::text AS token`,
  )
  assert.match(firstLease.rows[0]?.token || '', /^[a-f0-9-]{36}$/)
  const competingLease = await client.query(
    `SELECT claim_operations_commerce_storage_maintenance(
       'guard-postgres-competing', 10, 120
     )::text AS token`,
  )
  assert.equal(competingLease.rows[0]?.token, null)
  const renewedLease = await client.query(
    `SELECT renew_operations_commerce_storage_maintenance(
       $1::uuid, 120
     ) AS renewed`,
    [firstLease.rows[0].token],
  )
  assert.equal(renewedLease.rows[0]?.renewed, true)
  const completedLease = await client.query(
    `SELECT complete_operations_commerce_storage_maintenance(
       $1::uuid, '{"status":"completed"}'::jsonb, NULL
     ) AS completed`,
    [firstLease.rows[0].token],
  )
  assert.equal(completedLease.rows[0]?.completed, true)
  const staleCompletion = await client.query(
    `SELECT complete_operations_commerce_storage_maintenance(
       $1::uuid, '{}'::jsonb, NULL
     ) AS completed`,
    [firstLease.rows[0].token],
  )
  assert.equal(staleCompletion.rows[0]?.completed, false)
  await client.query(`
    UPDATE operations_commerce_storage_maintenance_lanes
    SET next_run_at = clock_timestamp()
    WHERE lane_name = 'commerce-storage'
  `)
  const expiringLease = await client.query(
    `SELECT claim_operations_commerce_storage_maintenance(
       'guard-postgres-expiring', 10, 120
     )::text AS token`,
  )
  await client.query(`
    UPDATE operations_commerce_storage_maintenance_lanes
    SET lease_expires_at = clock_timestamp() - interval '1 second'
    WHERE lane_name = 'commerce-storage'
      AND lease_token = $1::uuid
  `, [expiringLease.rows[0].token])
  const expiredRenewal = await client.query(
    `SELECT renew_operations_commerce_storage_maintenance(
       $1::uuid, 120
     ) AS renewed`,
    [expiringLease.rows[0].token],
  )
  assert.equal(expiredRenewal.rows[0]?.renewed, false)
  const expiredCompletion = await client.query(
    `SELECT complete_operations_commerce_storage_maintenance(
       $1::uuid, '{"status":"completed"}'::jsonb, NULL
     ) AS completed`,
    [expiringLease.rows[0].token],
  )
  assert.equal(expiredCompletion.rows[0]?.completed, false)
  await client.query(`
    UPDATE operations_commerce_storage_maintenance_lanes
    SET next_run_at = clock_timestamp()
    WHERE lane_name = 'commerce-storage'
  `)
  const failedLease = await client.query(
    `SELECT claim_operations_commerce_storage_maintenance(
       'guard-postgres-failure', 10, 120
     )::text AS token`,
  )
  const failedCompletion = await client.query(
    `SELECT complete_operations_commerce_storage_maintenance(
       $1::uuid, '{"status":"failed"}'::jsonb,
       'SIMULATED_STORAGE_FAILURE'
     ) AS completed`,
    [failedLease.rows[0].token],
  )
  assert.equal(failedCompletion.rows[0]?.completed, true)
  const failedLaneState = await client.query(
    `SELECT lease_token, last_failed_at IS NOT NULL AS failed,
            last_error_code, last_result
     FROM operations_commerce_storage_maintenance_lanes
     WHERE lane_name = 'commerce-storage'`,
  )
  assert.deepEqual(failedLaneState.rows[0], {
    lease_token: null,
    failed: true,
    last_error_code: 'SIMULATED_STORAGE_FAILURE',
    last_result: { status: 'failed' },
  })
  await client.query(`
    UPDATE operations_commerce_storage_maintenance_lanes
    SET next_run_at = clock_timestamp()
    WHERE lane_name = 'commerce-storage'
  `)
  const recoveryLease = await client.query(
    `SELECT claim_operations_commerce_storage_maintenance(
       'guard-postgres-recovery', 10, 120
     )::text AS token`,
  )
  const recoveringLaneState = await client.query(
    `SELECT last_error_code
     FROM operations_commerce_storage_maintenance_lanes
     WHERE lane_name = 'commerce-storage'`,
  )
  assert.equal(
    recoveringLaneState.rows[0]?.last_error_code,
    'SIMULATED_STORAGE_FAILURE',
    'A recent failure must remain visible until recovery completes',
  )
  const recoveryCompletion = await client.query(
    `SELECT complete_operations_commerce_storage_maintenance(
       $1::uuid, '{"status":"completed"}'::jsonb, NULL
     ) AS completed`,
    [recoveryLease.rows[0].token],
  )
  assert.equal(recoveryCompletion.rows[0]?.completed, true)
  const recoveredLaneState = await client.query(
    `SELECT last_error_code
     FROM operations_commerce_storage_maintenance_lanes
     WHERE lane_name = 'commerce-storage'`,
  )
  assert.equal(recoveredLaneState.rows[0]?.last_error_code, null)

  const aliasesPurged = await client.query(
    `SELECT *
     FROM purge_operations_commerce_inventory_observation_aliases(5000)`,
  )
  assert.equal(aliasesPurged.rows[0]?.purged_rows, 2)

  const levelsPurged = await client.query(
    `SELECT * FROM purge_operations_commerce_inventory_level_evidence(10000)`,
  )
  assert.equal(
    levelsPurged.rows[0]?.purged_rows,
    10000,
    'One bounded pass must drain one maximum-size Shopify level set',
  )
  const levelsPurgedFollowUp = await client.query(
    `SELECT * FROM purge_operations_commerce_inventory_level_evidence(10000)`,
  )
  assert.equal(
    levelsPurgedFollowUp.rows[0]?.purged_rows,
    2,
    'The post-sync pass must drain backlog beyond the current poll maximum',
  )

  const proof = await client.query(`
    WITH latest AS (
      SELECT id, COALESCE(source_level_set_run_id, id) AS effective_run_id,
             source_level_set_run_id
      FROM operations_commerce_inventory_sync_runs
      WHERE organization_id = '10000000-0000-4000-8000-000000000001'
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    )
    SELECT
      (SELECT count(*)::integer
       FROM operations_commerce_inventory_sync_runs
       WHERE organization_id = '10000000-0000-4000-8000-000000000001'
         AND source_level_set_run_id IS NOT NULL) AS remaining_aliases,
      (SELECT count(*)::integer
       FROM operations_commerce_inventory_levels
       WHERE organization_id = '10000000-0000-4000-8000-000000000001')
        AS remaining_levels,
      (SELECT count(*)::integer
       FROM operations_commerce_inventory_levels
       WHERE sync_run_id IN (
         md5('guard-full-1')::uuid,
         md5('guard-full-2')::uuid,
         md5('guard-full-3')::uuid
       )) AS obsolete_levels,
      (SELECT source_level_set_run_id IS NOT NULL FROM latest)
        AS latest_is_alias,
      (SELECT count(*)::integer
       FROM operations_commerce_inventory_levels level
       JOIN latest ON latest.effective_run_id = level.sync_run_id)
        AS latest_effective_levels,
      (SELECT count(*)::integer
       FROM crm_reference_registry
       WHERE reference_code LIKE 'giil%') AS registry_after
  `)
  assert.deepEqual(
    {
      remainingAliases: proof.rows[0]?.remaining_aliases,
      remainingLevels: proof.rows[0]?.remaining_levels,
      obsoleteLevels: proof.rows[0]?.obsolete_levels,
      latestIsAlias: proof.rows[0]?.latest_is_alias,
      latestEffectiveLevels: proof.rows[0]?.latest_effective_levels,
      registryDelta:
        proof.rows[0]?.registry_after - registryBefore.rows[0]?.count,
    },
    {
      remainingAliases: 1,
      remainingLevels: 128,
      obsoleteLevels: 0,
      latestIsAlias: true,
      latestEffectiveLevels: 1,
      registryDelta: 10130,
    },
  )

  const secondPass = await client.query(
    `SELECT
       (SELECT purged_rows
        FROM purge_operations_commerce_inventory_observation_aliases(5000))
          AS aliases,
       (SELECT purged_rows
        FROM purge_operations_commerce_inventory_level_evidence(10000))
          AS levels`,
  )
  assert.deepEqual(secondPass.rows[0], { aliases: 0, levels: 0 })

  const health = await client.query(
    `SELECT operations_commerce_storage_bloat_health(1000) AS health`,
  )
  assert.equal(health.rows[0]?.health.inventoryObservationAliasBacklogRows, 0)
  assert.equal(health.rows[0]?.health.inventoryLevelBacklogRows, 0)
  assert.equal(
    health.rows[0]?.health.inventorySnapshotPayloadBacklogRows,
    0,
  )
  assert.equal(health.rows[0]?.health.inventorySnapshotLivePayloadRows, 32)
  assert.equal(
    health.rows[0]?.health.inventorySnapshotLivePayloadTruncated,
    false,
  )
  assert.ok(
    Number(health.rows[0]?.health.inventorySnapshotContentStorageBytes) > 0,
  )
  assert.equal(
    health.rows[0]?.health.storageMaintenance.lastResult.status,
    'completed',
  )

  await client.query('ROLLBACK')
  await testConcurrentPreparedCaptureAndPurge()
  console.log(
    'commerce storage guard PostgreSQL acceptance passed: staged and expired intake payloads purge one-way while retry-window payloads remain, prepared captures survive crash/retry and concurrent purge, raw snapshots retain at most 32 live payloads with one-way tombstones and recurring-hash support, maintenance renews and rejects stale completion, online indexes and deferred FK validation are ready, aliases are bounded, a 10,000-level poll drains plus follow-up backlog, current alias resolves to retained evidence, and public ID reservations remain',
  )
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  client.release()
  await pool.end()
  stopDisposableContainer()
}
