#!/usr/bin/env node
// Disposable PostgreSQL only. Never accepts an application database URL.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  actorEmail, applyMigration, command, migrations, orderIds,
  seedBeforeRevisionMigration, waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'
import {
  OPERATIONS_TRACKING_URL_EVIDENCE_ARTIFACT_COUNT,
  OPERATIONS_TRACKING_URL_EVIDENCE_ARTIFACT_HASH,
  OPERATIONS_TRACKING_URL_EVIDENCE_FINGERPRINT_SQL,
  OPERATIONS_TRACKING_URL_EVIDENCE_HEALTH_SQL,
  OPERATIONS_NATIVE_ACTIVITY_EVIDENCE_ARTIFACT_COUNT,
  OPERATIONS_NATIVE_ACTIVITY_EVIDENCE_ARTIFACT_HASH,
  OPERATIONS_NATIVE_ACTIVITY_EVIDENCE_FINGERPRINT_SQL,
  OPERATIONS_NATIVE_ACTIVITY_EVIDENCE_HEALTH_SQL,
  OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_FINGERPRINT_SQL,
} from '../app_src/lib/persistence/operationsOrderEditingReleaseHealth.ts'
import {
  OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL,
} from '../app_src/lib/persistence/commerceStoreSyncHealth.ts'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const migration = '0347_operations_commerce_order_tracking_url_evidence.sql'
const table = 'operations_commerce_order_tracking_url_evidence'

async function rejected(client, sql, values, pattern) {
  await assert.rejects(client.query(sql, values), pattern)
}

async function rollback(client, fn) {
  await client.query('BEGIN')
  try { await fn() } finally { await client.query('ROLLBACK') }
}

async function rewrittenFunctionFingerprint(client) {
  const signatures = [...OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL
    .matchAll(/\('(public\.[^']+\([^']*\))'\)/gu)].map((match) => match[1])
  assert.equal(signatures.length, 21)
  return (await client.query(
    `WITH required(signature) AS (SELECT unnest($1::text[]))
     SELECT encode(digest(convert_to(string_agg(concat_ws(
       '|', required.signature,
       btrim(regexp_replace(installed.prosrc, '[[:space:]]+', ' ', 'g')),
       language.lanname, installed.provolatile::text,
       installed.proisstrict::text, installed.prosecdef::text,
       installed.proleakproof::text, installed.proparallel::text,
       COALESCE(array_to_string(installed.proconfig, ','), ''),
       pg_get_function_result(installed.oid)
     ), chr(10) ORDER BY required.signature), 'UTF8'), 'sha256'), 'hex') AS value
     FROM required JOIN pg_proc installed ON installed.oid=to_regprocedure(required.signature)
     JOIN pg_language language ON language.oid=installed.prolang`, [signatures],
  )).rows[0].value
}

async function verifyNativeReadBudgets(client, ids) {
  const lease = (await client.query(
    `WITH lease_clock AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS value)
     INSERT INTO operations_commerce_store_sync_read_leases (
       id, organization_id, integration_account_id, authority_kind, read_kind,
       intent_fingerprint_sha256, control_revision, activation_revision, acquired_by,
       acquired_at, heartbeat_at, expires_at, captured_at
     ) SELECT gen_random_uuid(),$1,$2,'manual_read_only','order_history',$3,
       control.revision,activation.revision,$4,lease_clock.value,lease_clock.value,
       lease_clock.value + interval '60 seconds',lease_clock.value
     FROM operations_commerce_store_sync_controls control
     JOIN operations_activation_scopes activation ON activation.organization_id=control.organization_id
     CROSS JOIN lease_clock WHERE control.organization_id=$1 AND control.integration_account_id=$2
     RETURNING id`, [ids.organization, ids.integration, digest('native-budget-fixture'), actorEmail],
  )).rows[0]
  assert.ok(lease)
  const insert = `INSERT INTO operations_commerce_order_observations (
    organization_id,integration_account_id,manual_provider_read_lease_id,provider,
    credential_generation,observation_kind,external_order_id,order_number,
    source_revision,source_hash,canonical_lifecycle_state,canonical_payment_state,
    canonical_fulfillment_state,canonical_return_state,provider_created_at,
    provider_updated_at,observed_at,provider_read_count
  ) VALUES ($1,$2,$3,'shopify',1,'manual_exact_read','gid://shopify/Order/987654321',
    '#budget','explicit-budget-revision',$4,'closed','paid','fulfilled','none',
    now()-interval '1 day',now()-interval '1 hour',clock_timestamp(),$5)`
  for (const count of [3, 4, 5]) {
    await rollback(client, async () => client.query(insert, [
      ids.organization, ids.integration, lease.id, digest(`budget-${count}`), count,
    ]))
  }
  for (const count of [2, 6]) {
    await rejected(client, insert, [ids.organization, ids.integration, lease.id,
      digest(`budget-${count}`), count], /manual exact-read lineage is invalid/)
  }
  const expression = (await client.query(
    `SELECT pg_get_expr(conbin,conrelid) AS value FROM pg_constraint
     WHERE conrelid='operations_shopify_order_webhook_reads'::regclass
       AND conname='shopify_order_webhook_read_count_native_activity_valid'`,
  )).rows[0].value
  const counts = (await client.query(
    `SELECT provider_read_count, (${expression}) AS accepted
     FROM generate_series(0,8) AS provider_read_count ORDER BY provider_read_count`,
  )).rows
  assert.deepEqual(counts.filter((row) => row.accepted).map((row) => row.provider_read_count), [3, 4, 5])
}

export async function verifyTrackingUrlEvidenceSchema(client, ids, pool) {
  await client.query(
    `INSERT INTO operations_commerce_order_sync_policies (
       organization_id, integration_account_id, historical_observation_enabled,
       continuous_observation_enabled, continuous_transport,
       provider_event_processor_state, revision, created_by, updated_by
     ) VALUES ($1, $2, true, true, 'scheduled_poll', 'processor_pending', 1, $3, $3)`,
    [ids.organization, ids.integration, actorEmail],
  )
  const session = (await client.query(
    `INSERT INTO operations_commerce_order_backfill_sessions (
       organization_id, integration_account_id, provider, session_kind,
       credential_generation, policy_revision, coverage_basis, status,
       requested_from, requested_through, idempotency_key,
       request_hash, query_hash, requested_by, reason
     ) VALUES ($1, $2, 'shopify', 'historical_backfill', 1, 1,
       'shopify_rolling_60_days', 'pending', now() - interval '60 days', now(),
       'tracking-url-schema-fixture', $3, $4, $5, 'Tracking URL schema acceptance')
     RETURNING id`,
    [ids.organization, ids.integration, digest('request'), digest('query'), actorEmail],
  )).rows[0].id
  await client.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status = 'processing', attempt_count = attempt_count + 1,
         locked_at = now(), locked_by = 'tracking-url-schema',
         lock_token = gen_random_uuid(), lease_expires_at = now() + interval '1 hour',
         started_at = now(), last_error_code = NULL, updated_at = now()
     WHERE id = $1`, [session],
  )
  const revision = new Date(Date.now() - 3_600_000).toISOString()
  const newer = new Date(Date.now() - 1_800_000).toISOString()
  const older = new Date(Date.now() - 7_200_000).toISOString()
  const order = 'gid://shopify/Order/tracking-url-schema'
  async function observation(providerUpdatedAt = revision, externalOrderId = order, coverage = {}) {
    return (await client.query(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id, backfill_session_id,
         provider, credential_generation, observation_kind, external_order_id,
         order_number, source_revision, source_hash, canonical_lifecycle_state,
         canonical_payment_state, canonical_fulfillment_state,
         canonical_return_state, provider_created_at, provider_updated_at,
         observed_at, provider_read_count, native_activity_state,
         native_activity_reason, native_activity_fetched_count
       ) VALUES ($1, $2, $3, 'shopify', 1, 'historical_backfill', $4,
         '#tracking-url-schema', 'explicit-fixture-revision', $5,
         'closed', 'paid', 'fulfilled', 'none', now() - interval '1 day',
         $6, date_trunc('milliseconds', clock_timestamp()), 1, $7, $8, $9)
       RETURNING *`,
      [ids.organization, ids.integration, session, externalOrderId,
        digest(randomUUID()), providerUpdatedAt, coverage.state ?? null,
        coverage.reason ?? null, coverage.count ?? null],
    )).rows[0]
  }
  async function baseEvent(parent, expires = 'clock_timestamp() + interval \'1 day\'', kind = 'tracking_updated') {
    return (await client.query(
      `INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id, provider,
         external_order_id, event_hash, event_kind, attribution_source,
         tracking_carrier, tracking_number, provider_actor_fingerprint,
         occurred_at, observed_at, sensitive_evidence_expires_at, external_event_id
       ) VALUES ($1, $2, $3, 'shopify', $4, $5, $7,
         'provider_staff', 'Synthetic carrier', 'SYNTHETIC-TRACKING-ONLY', $6,
         now() - interval '1 day', now(), date_trunc('milliseconds', ${expires}), $8) RETURNING *`,
      [ids.organization, ids.integration, parent.id, parent.external_order_id,
        digest(randomUUID()), digest('synthetic-provider-actor'), kind,
        kind === 'provider_activity' ? `gid://shopify/Event/${randomUUID()}` : null],
    )).rows[0]
  }
  const insert = `INSERT INTO ${table} (
    organization_id, integration_account_id, provider, external_order_id,
    base_event_id, observation_id, source_revision_hash, evidence_hash,
    tracking_url, tracking_number, provider_actor_fingerprint,
    sensitive_evidence_expires_at, observed_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`
  function evidence(base, parent, changes = {}) {
    return Object.values({
      organization: ids.organization, account: ids.integration, provider: 'shopify',
      order: parent.external_order_id, base: base.id, observation: parent.id,
      sourceHash: parent.source_hash, evidenceHash: digest(`${base.id}:${parent.source_hash}`),
      url: 'https://carrier.example/track/synthetic', number: base.tracking_number,
      fingerprint: base.provider_actor_fingerprint,
      expiry: base.sensitive_evidence_expires_at, observedAt: parent.observed_at,
      ...changes,
    })
  }
  const original = await observation()
  const base = await baseEvent(original)
  const before = (await client.query(
    'SELECT to_jsonb(event) AS value FROM operations_commerce_order_event_observations event WHERE id=$1',
    [base.id],
  )).rows[0].value
  const current = await observation()
  const values = evidence(base, current)
  for (const [changes, error] of [
    [{ organization: randomUUID() }, /base event scope mismatch/],
    [{ account: randomUUID() }, /base event scope mismatch/],
    [{ provider: 'faire' }, /base event scope mismatch/],
    [{ order: 'another-order' }, /base event scope mismatch/],
    [{ sourceHash: digest('different-source') }, /observation scope mismatch/],
    [{ observedAt: new Date(0) }, /observation scope mismatch/],
    [{ number: 'CHANGED' }, /changes retained event evidence/],
    [{ fingerprint: digest('changed-actor') }, /changes retained event evidence/],
    [{ expiry: new Date(Date.now() + 3 * 86_400_000) }, /changes retained event evidence/],
    [{ url: null }, /explicit provider URL/],
    [{ url: 'javascript:alert(1)' }, /commerce_order_tracking_url_value_valid/],
    [{ url: 'https://carrier.example/\nmalformed' }, /commerce_order_tracking_url_value_valid/],
  ]) {
    await rejected(client, insert, evidence(base, current, changes), error)
  }
  const differentOrder = await observation(revision, 'another-order')
  await rejected(client, insert, evidence(base, differentOrder, { order }), /observation scope mismatch/)
  const old = await observation(older)
  await rejected(client, insert, evidence(base, old), /non-regressing provider revision/)
  const unknown = await observation(null)
  await rejected(client, insert, evidence(base, unknown), /non-regressing provider revision/)

  const concurrentBase = await baseEvent(await observation())
  const concurrentParent = await observation()
  const secondParent = await observation()
  const second = await pool.connect()
  try {
    await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await second.query(`SELECT count(*) FROM ${table}`)
    await client.query('BEGIN')
    await client.query(insert, evidence(concurrentBase, concurrentParent))
    await second.query("SET LOCAL statement_timeout='5s'")
    let finished = false
    const pending = second.query(insert, evidence(concurrentBase, secondParent, {
      url: 'https://carrier.example/concurrent-same-revision',
    })).then(() => { finished = true; return null }, (error) => { finished = true; return error })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30))
    assert.equal(finished, false, 'Same-base append must wait for the first transaction')
    await client.query('COMMIT')
    const error = await pending
    assert.match(error?.message || '', /commerce_order_tracking_url_revision_unique|newer provider revision/,
      'Even an older repeatable-read snapshot cannot admit two URLs for one provider revision')
  } finally {
    await client.query('ROLLBACK')
    await second.query('ROLLBACK')
    second.release()
  }

  for (const statement of [
    `UPDATE operations_integration_accounts SET status='disabled' WHERE id='${ids.integration}'`,
    `UPDATE operations_commerce_credentials SET verification_status='unverified'
      WHERE organization_id='${ids.organization}' AND integration_account_id='${ids.integration}'`,
    `UPDATE operations_commerce_order_sync_policies SET historical_observation_enabled=false
      WHERE organization_id='${ids.organization}' AND integration_account_id='${ids.integration}'`,
  ]) {
    await rollback(client, async () => {
      await client.query(statement)
      await rejected(client, insert, values, /session is sealed/)
    })
  }
  const retained = (await client.query(insert, values)).rows[0]
  assert.equal(retained.tracking_url, 'https://carrier.example/track/synthetic')
  assert.equal(retained.base_event_id, base.id)
  assert.equal(retained.source_revision_hash, current.source_hash)
  assert.equal(retained.provider_updated_at.toISOString(), revision,
    'Explicit provider revision is derived from the authenticated parent')
  assert.equal(retained.sensitive_evidence_expires_at.getTime(), base.sensitive_evidence_expires_at.getTime())
  await rejected(client, insert, values, /must describe a change/)
  await rejected(client, insert, evidence(base, await observation(), {
    url: 'https://carrier.example/changed-same-revision',
  }), /newer provider revision/)
  const advanced = await observation(newer)
  const replacement = (await client.query(insert, evidence(base, advanced, {
    url: 'https://carrier.example/changed-new-revision',
  }))).rows[0]
  assert.notEqual(replacement.id, retained.id)
  await rejected(client, insert, evidence(base, await observation(revision), {
    url: 'https://carrier.example/backwards',
  }), /newer provider revision/)
  await rejected(client, `UPDATE ${table} SET tracking_url=$2 WHERE id=$1`,
    [retained.id, 'https://carrier.example/rewrite'], /evidence is immutable/)
  await rejected(client, `DELETE FROM ${table} WHERE id=$1`, [retained.id], /evidence is immutable/)
  await rejected(client, `UPDATE ${table} SET tracking_url=NULL, tracking_number=NULL,
    provider_actor_fingerprint=NULL, sensitive_evidence_redacted_at=now() WHERE id=$1`,
  [retained.id], /evidence is immutable/)
  await rejected(client, 'UPDATE operations_commerce_order_event_observations SET tracking_url=$2 WHERE id=$1',
    [base.id, 'https://carrier.example/forbidden-base-rewrite'], /evidence is immutable/)
  assert.deepEqual((await client.query(
    'SELECT to_jsonb(event) AS value FROM operations_commerce_order_event_observations event WHERE id=$1',
    [base.id],
  )).rows[0].value, before, 'Enrichment must preserve every immutable base field and hash')

  const nativeTable = 'operations_commerce_order_native_activity_evidence'
  const nativeInsert = `INSERT INTO ${nativeTable} (
    organization_id, integration_account_id, provider, external_order_id,
    base_event_id, observation_id, source_revision_hash, evidence_hash,
    provider_action, provider_message, provider_actor_display_name,
    sensitive_evidence_expires_at, observed_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`
  function nativeValues(nativeBase, parent, changes = {}) {
    return Object.values({
      organization: ids.organization, account: ids.integration, provider: 'shopify',
      order: parent.external_order_id, base: nativeBase.id, observation: parent.id,
      sourceHash: parent.source_hash, evidenceHash: digest(`${nativeBase.id}:${parent.id}`),
      action: 'commented', message: 'Synthetic provider comment', name: 'Synthetic provider staff',
      expiry: nativeBase.sensitive_evidence_expires_at, observedAt: parent.observed_at,
      ...changes,
    })
  }
  const nativeParent = await observation(revision, order, { state: 'complete', count: 2 })
  const nativeBase = await baseEvent(nativeParent, undefined, 'provider_activity')
  const nativeBefore = (await client.query(
    'SELECT to_jsonb(event) AS value FROM operations_commerce_order_event_observations event WHERE id=$1',
    [nativeBase.id],
  )).rows[0].value
  for (const [changes, error] of [
    [{ organization: randomUUID() }, /base event scope mismatch/],
    [{ account: randomUUID() }, /base event scope mismatch/],
    [{ provider: 'faire' }, /base event scope mismatch/],
    [{ order: 'wrong-order' }, /base event scope mismatch/],
    [{ base: base.id }, /base event scope mismatch/],
    [{ sourceHash: digest('wrong') }, /observation scope mismatch/],
    [{ observedAt: new Date(0) }, /observation scope mismatch/],
    [{ expiry: new Date(Date.now() + 3 * 86_400_000) }, /changes retained event expiry/],
    [{ message: 'x'.repeat(8001) }, /commerce_order_native_activity_text_valid/],
    [{ name: 'x'.repeat(256) }, /commerce_order_native_activity_text_valid/],
    [{ action: 'x'.repeat(256) }, /commerce_order_native_activity_text_valid/],
    [{ message: 'control\u0001' }, /commerce_order_native_activity_text_valid/],
    [{ action: null, message: null, name: null }, /requires provider content/],
  ]) {
    await rejected(client, nativeInsert, nativeValues(nativeBase, nativeParent, changes), error)
  }
  const native = (await client.query(nativeInsert, nativeValues(nativeBase, nativeParent))).rows[0]
  await rejected(client, nativeInsert, nativeValues(nativeBase, nativeParent), /commerce_order_native_activity_observation_unique/)
  const editedParent = await observation(revision, order, { state: 'partial', reason: 'page_limit', count: 500 })
  const edited = (await client.query(nativeInsert, nativeValues(nativeBase, editedParent, {
    message: 'Edited synthetic comment\nA second paragraph', name: 'Corrected provider label',
  }))).rows[0]
  assert.notEqual(native.id, edited.id, 'Mutable provider content appends a new receipt')
  assert.equal(edited.provider_message, 'Edited synthetic comment\nA second paragraph')
  assert.equal((await client.query(`SELECT provider_message FROM ${nativeTable} WHERE id=$1`, [native.id])).rows[0].provider_message,
    'Synthetic provider comment', 'Prior receipt remains exact')
  await rejected(client, `UPDATE ${nativeTable} SET provider_message=$2 WHERE id=$1`,
    [native.id, 'rewritten'], /evidence is immutable/)
  await rejected(client, `DELETE FROM ${nativeTable} WHERE id=$1`, [native.id], /evidence is immutable/)
  await rejected(client, `UPDATE ${nativeTable} SET provider_message=NULL, provider_action=NULL,
    provider_actor_display_name=NULL, sensitive_evidence_redacted_at=now() WHERE id=$1`,
  [native.id], /evidence is immutable/)
  assert.deepEqual((await client.query(
    'SELECT to_jsonb(event) AS value FROM operations_commerce_order_event_observations event WHERE id=$1',
    [nativeBase.id],
  )).rows[0].value, nativeBefore, 'Edited native content never rewrites stable base identity')
  await assert.rejects(observation(revision, order, { state: 'complete', count: 501 }),
    /commerce_order_observation_native_activity_valid/)
  await assert.rejects(observation(revision, order, { state: 'unknown', count: 0 }),
    /commerce_order_observation_native_activity_valid/)
  await assert.rejects(observation(revision, order, { reason: 'orphan-reason' }),
    /commerce_order_observation_native_activity_valid/)
  await assert.rejects(observation(revision, order, { count: 1 }),
    /commerce_order_observation_native_activity_valid/)
  assert.equal((await observation()).native_activity_state, null, 'Legacy coverage remains absent')

  const nativeExpiringParent = await observation()
  const nativeExpiringBase = await baseEvent(nativeExpiringParent,
    "clock_timestamp() + interval '1 second'", 'provider_activity')
  const nativeExpiring = (await client.query(nativeInsert,
    nativeValues(nativeExpiringBase, nativeExpiringParent))).rows[0]

  const expiringParent = await observation()
  const expiringBase = await baseEvent(expiringParent, "clock_timestamp() + interval '1 second'")
  const expiring = (await client.query(insert,
    evidence(expiringBase, await observation()))).rows[0]
  await client.query('SELECT pg_sleep(1.1)')
  await rejected(client, nativeInsert, nativeValues(nativeExpiringBase, await observation()), /retention has expired/)
  assert.equal((await client.query('SELECT redact_expired_commerce_order_native_activity_evidence(1) AS count')).rows[0].count, 1)
  const nativeRedacted = (await client.query(`SELECT * FROM ${nativeTable} WHERE id=$1`, [nativeExpiring.id])).rows[0]
  assert.equal(nativeRedacted.provider_message, null)
  assert.equal(nativeRedacted.provider_actor_display_name, null)
  assert.equal(nativeRedacted.provider_action, null)
  assert.ok(nativeRedacted.sensitive_evidence_redacted_at)
  assert.equal(nativeRedacted.evidence_hash, nativeExpiring.evidence_hash)
  await rejected(client, `UPDATE ${nativeTable} SET provider_message=$2,
    sensitive_evidence_redacted_at=NULL WHERE id=$1`, [nativeExpiring.id, 'resurrection'], /evidence is immutable/)
  await rejected(client, insert, evidence(expiringBase, await observation(newer), {
    url: 'https://carrier.example/resurrection',
  }), /retention has expired/)
  assert.equal((await client.query(
    'SELECT redact_expired_commerce_order_tracking_url_evidence(1) AS count',
  )).rows[0].count, 1)
  const redacted = (await client.query(`SELECT * FROM ${table} WHERE id=$1`, [expiring.id])).rows[0]
  assert.equal(redacted.tracking_url, null)
  assert.equal(redacted.tracking_number, null)
  assert.equal(redacted.provider_actor_fingerprint, null)
  assert.ok(redacted.sensitive_evidence_redacted_at)
  assert.equal(redacted.evidence_hash, expiring.evidence_hash)
  await rejected(client, `UPDATE ${table} SET tracking_url=$2,
    sensitive_evidence_redacted_at=NULL WHERE id=$1`,
  [expiring.id, 'https://carrier.example/resurrection'], /evidence is immutable/)

  await client.query(
    `UPDATE operations_commerce_order_backfill_sessions
     SET status='failed', locked_at=NULL, locked_by=NULL, lock_token=NULL,
         lease_expires_at=NULL, last_error_code='FIXTURE_SEALED', updated_at=now()
     WHERE id=$1`, [session],
  )
  await rejected(client, insert, evidence(base, advanced, {
    url: 'https://carrier.example/sealed-parent', evidenceHash: digest('sealed'),
  }), /session is sealed/)
  await rejected(client, nativeInsert, nativeValues(nativeBase, advanced), /session is sealed/)
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-tracking-url-schema-${process.pid}-${randomUUID().slice(0, 8)}`
  let pool
  try {
    command('docker', ['run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=tracking_url_schema', '-e', 'POSTGRES_DB=tracking_url_schema',
      '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16'], { timeout: 180_000 })
    const port = Number(command('docker', ['port', container, '5432/tcp']).match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0)
    const url = `postgresql://postgres:tracking_url_schema@127.0.0.1:${port}/tracking_url_schema`
    await waitForPostgres(url)
    pool = new Pool({ connectionString: url, max: 2 })
    const client = await pool.connect()
    try {
      const ids = orderIds()
      for (const file of migrations()) {
        if (file === '0273_operations_commerce_order_revisions.sql') {
          await seedBeforeRevisionMigration(client, ids)
        }
        await applyMigration(client, file)
      }
      const fingerprint = (await client.query(OPERATIONS_TRACKING_URL_EVIDENCE_FINGERPRINT_SQL)).rows[0]
      const nativeFingerprint = (await client.query(OPERATIONS_NATIVE_ACTIVITY_EVIDENCE_FINGERPRINT_SQL)).rows[0]
      if (process.argv.includes('--print-fingerprint')) {
        console.log(JSON.stringify({ trackingUrl: fingerprint, nativeActivity: nativeFingerprint,
          exactHistory: (await client.query(OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_FINGERPRINT_SQL)).rows[0],
          storeSyncRewritten: await rewrittenFunctionFingerprint(client),
        }))
        return
      }
      assert.deepEqual(fingerprint, {
        artifact_count: OPERATIONS_TRACKING_URL_EVIDENCE_ARTIFACT_COUNT,
        artifact_hash: OPERATIONS_TRACKING_URL_EVIDENCE_ARTIFACT_HASH,
      })
      assert.deepEqual(nativeFingerprint, {
        artifact_count: OPERATIONS_NATIVE_ACTIVITY_EVIDENCE_ARTIFACT_COUNT,
        artifact_hash: OPERATIONS_NATIVE_ACTIVITY_EVIDENCE_ARTIFACT_HASH,
      })
      const healthy = async () => (await client.query(
        `SELECT (${OPERATIONS_TRACKING_URL_EVIDENCE_HEALTH_SQL}) AS ready`,
      )).rows[0].ready
      assert.equal(await healthy(), true)
      const nativeHealthy = async () => (await client.query(
        `SELECT (${OPERATIONS_NATIVE_ACTIVITY_EVIDENCE_HEALTH_SQL}) AS ready`,
      )).rows[0].ready
      assert.equal(await nativeHealthy(), true)
      assert.equal((await client.query(
        `SELECT (${OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL}) AS ready`,
      )).rows[0].ready, true, 'Native read budgets preserve the attested Store-sync authority guards')
      await verifyNativeReadBudgets(client, ids)
      for (const sql of [
        `DELETE FROM schema_migrations WHERE filename='${migration}'`,
        `UPDATE schema_migrations SET checksum='wrong' WHERE filename='${migration}'`,
        `ALTER TABLE ${table} DROP CONSTRAINT commerce_order_tracking_url_event_fkey`,
        `ALTER TABLE ${table} DROP CONSTRAINT commerce_order_tracking_url_value_valid`,
        `ALTER TABLE ${table} DISABLE TRIGGER commerce_order_tracking_url_evidence_lineage_guard`,
        `ALTER TABLE ${table} DISABLE TRIGGER commerce_order_tracking_url_evidence_immutable`,
        `ALTER FUNCTION protect_commerce_order_tracking_url_evidence() SECURITY DEFINER`,
        `ALTER TABLE ${table} ADD COLUMN unreviewed_drift text`,
      ]) {
        await rollback(client, async () => {
          await client.query(sql)
          assert.equal(await healthy(), false, 'Health must reject absent or weakened evidence safeguards')
        })
      }
      for (const sql of [
        "DELETE FROM schema_migrations WHERE filename='0348_operations_commerce_native_activity_evidence.sql'",
        'ALTER TABLE operations_commerce_order_native_activity_evidence DROP CONSTRAINT commerce_order_native_activity_event_fkey',
        'ALTER TABLE operations_commerce_order_native_activity_evidence DROP CONSTRAINT commerce_order_native_activity_text_valid',
        'ALTER TABLE operations_commerce_order_native_activity_evidence DISABLE TRIGGER commerce_order_native_activity_evidence_lineage_guard',
        'ALTER TABLE operations_commerce_order_native_activity_evidence DISABLE TRIGGER commerce_order_native_activity_evidence_immutable',
        'ALTER FUNCTION protect_commerce_order_native_activity_evidence() SECURITY DEFINER',
        'ALTER TABLE operations_commerce_order_observations DROP CONSTRAINT commerce_order_observation_native_activity_valid',
        'ALTER TABLE operations_commerce_order_event_observations DROP CONSTRAINT commerce_order_event_kind_native_activity_valid',
        'ALTER TABLE operations_shopify_order_webhook_reads DROP CONSTRAINT shopify_order_webhook_read_count_native_activity_valid',
        'ALTER FUNCTION protect_shopify_order_webhook_target() SECURITY DEFINER',
        'ALTER FUNCTION protect_shopify_order_webhook_read() SECURITY DEFINER',
        'ALTER FUNCTION protect_commerce_order_observation_lineage() SECURITY DEFINER',
      ]) {
        await rollback(client, async () => {
          await client.query(sql)
          assert.equal(await nativeHealthy(), false, 'Native evidence health must fail closed on drift')
        })
      }
      await verifyTrackingUrlEvidenceSchema(client, ids, pool)
    } finally { client.release() }
  } finally {
    if (pool) await pool.end()
    spawnSync('docker', ['stop', '-t', '1', container], { encoding: 'utf8', timeout: 20_000 })
  }
  console.log('Tracking URL evidence schema disposable-PostgreSQL acceptance passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
