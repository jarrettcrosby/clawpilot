import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { loadTypeScriptModule } from './test-commerce-order-revisions-postgres.mjs'

// Invoked by the full-migration disposable PostgreSQL suite, never a live DB.
export async function verifyCommerceOrderTrackingUrlRuntime({ pool, persistence, ids, createLease }) {
  const externalOrderId = `gid://shopify/Order/url-repair-${randomUUID()}`
  const revision = new Date(Date.now() - 86_400_000).toISOString()
  const scope = { organizationId: ids.organization, integrationAccountId: ids.integration,
    accountGlobalId: 'gia0009301', provider: 'shopify', credentialGeneration: 1, externalOrderId }
  const observation = (url, overrides = {}) => ({
    observationKind: 'manual_exact_read', externalOrderId, orderNumber: '#URL-REPAIR',
    sourceRevision: revision, sourceHash: 'a'.repeat(64),
    canonicalLifecycleState: 'closed', canonicalPaymentState: 'paid',
    canonicalFulfillmentState: 'fulfilled', canonicalReturnState: 'none',
    providerCreatedAt: revision, providerUpdatedAt: revision, observedAt: new Date().toISOString(), providerReadCount: 3,
    lines: [{ externalLineId: 'url-line', originalQuantity: 1, currentQuantity: 1, fulfilledQuantity: 1, unfulfilledQuantity: 0 }],
    events: [{ externalEventId: 'url-tracking:0', externalSubjectId: 'url-fulfillment',
      eventKind: 'tracking_updated', attributionSource: 'provider_staff', providerActorFingerprint: 'c'.repeat(64),
      trackingCarrier: 'UPS', trackingNumber: 'URL-FIXTURE-PACKAGE', trackingUrl: url, occurredAt: revision }],
    ...overrides,
  })
  const leaseInput = (lease) => ({ id: lease.id, authorityKind: 'manual_read_only', readKind: 'order_history',
    intentFingerprintSha256: lease.intentFingerprintSha256, controlRevision: lease.control_revision,
    activationRevision: lease.activation_revision, expiresAt: lease.expires_at.toISOString() })
  const append = (value, lease) => persistence.appendCommerceOrderWorkbenchExactReadInPostgres({
    ...scope, providerReadLease: leaseInput(lease), observation: value,
  })
  const close = (lease) => pool.query(`UPDATE operations_commerce_store_sync_read_leases
    SET released_at=clock_timestamp(),release_reason='completed' WHERE id=$1`, [lease.id])
  const fresh = () => createLease(`url-repair-${randomUUID()}`)
  const urlOne = 'https://carrier.example/track/first'
  const urlTwo = 'https://carrier.example/track/second'
  const originalRead = observation(null)
  const originalLease = await fresh()
  assert.equal((await append(originalRead, originalLease)).eventsAppended, 1)
  await close(originalLease)
  const original = (await pool.query(`SELECT * FROM operations_commerce_order_observations
    WHERE external_order_id=$1 ORDER BY observed_at,id LIMIT 1`, [externalOrderId])).rows[0]
  const base = (await pool.query(`SELECT * FROM operations_commerce_order_event_observations
    WHERE external_order_id=$1`, [externalOrderId])).rows[0]

  // Seed the real legacy failure: URL-aware hash retained, but duplicate base
  // event skipped. Use ordinary active lineage; never disable DB triggers.
  const poisonedRead = observation(urlOne)
  const poisonedHash = persistence.normalizeCommerceOrderObservationInput(poisonedRead).sourceHash
  const poisonLease = await fresh()
  const poisoned = (await pool.query(`INSERT INTO operations_commerce_order_observations
    SELECT (jsonb_populate_record(NULL::operations_commerce_order_observations,
      to_jsonb(original) || jsonb_build_object('id',gen_random_uuid(),
        'global_id',allocate_global_reference('gcoo'),'source_hash',$2::text,
        'observed_at',$3::timestamptz,'created_at',clock_timestamp(),
        'manual_provider_read_lease_id',$4::uuid))).*
    FROM operations_commerce_order_observations original WHERE id=$1
    RETURNING id::text`, [original.id, poisonedHash, poisonedRead.observedAt, poisonLease.id])).rows[0]
  await close(poisonLease)
  const before = (await pool.query(`SELECT to_jsonb(observation) AS row
    FROM operations_commerce_order_observations observation WHERE id=ANY($1::uuid[]) ORDER BY id`,
  [[original.id, poisoned.id]])).rows
  const repairRead = observation(urlOne)
  const repairLease = await fresh()
  const repaired = await append(repairRead, repairLease)
  assert.equal(repaired.appended, 1, 'poisoned sealed parent must be replaced by a fresh current-read observation')
  assert.equal(repaired.eventsAppended, 0, 'URL enrichment is not another provider event')
  assert.equal((await append(repairRead, repairLease)).preserved, 1, 'same request replay must succeed')
  await close(repairLease)
  const evidence = (await pool.query(`SELECT * FROM operations_commerce_order_tracking_url_evidence
    WHERE base_event_id=$1`, [base.id])).rows
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].tracking_url, urlOne)
  assert.notEqual(evidence[0].observation_id, poisoned.id)
  assert.equal(evidence[0].sensitive_evidence_expires_at.toISOString(), base.sensitive_evidence_expires_at.toISOString())
  assert.deepEqual((await pool.query(`SELECT * FROM operations_commerce_order_event_observations WHERE id=$1`, [base.id])).rows[0], base)
  assert.deepEqual((await pool.query(`SELECT to_jsonb(observation) AS row FROM operations_commerce_order_observations observation
    WHERE id=ANY($1::uuid[]) ORDER BY id`, [[original.id, poisoned.id]])).rows, before)

  const omittedRead = observation(null)
  const omittedLease = await fresh()
  await append(omittedRead, omittedLease)
  assert.equal((await append(omittedRead, omittedLease)).preserved, 1)
  await close(omittedLease)
  const timeline = await persistence.readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres(scope)
  assert.equal(timeline.items.filter((event) => event.eventKind === 'tracking_updated').length, 1)
  assert.equal(timeline.items.find((event) => event.eventKind === 'tracking_updated').payload.trackingUrl, urlOne)

  const nextRevision = new Date(new Date(revision).getTime() + 1000).toISOString()
  const next = observation(urlTwo, { providerUpdatedAt: nextRevision, sourceRevision: nextRevision })
  const nextLease = await fresh()
  await append(next, nextLease)
  await append(next, nextLease)
  await close(nextLease)
  const conflictLease = await fresh()
  for (const change of [
    observation('https://carrier.example/track/unversioned', { providerUpdatedAt: nextRevision, sourceRevision: nextRevision }),
    observation('https://carrier.example/track/unknown', { providerUpdatedAt: null, sourceRevision: 'provider:opaque' }),
    { ...next, events: [{ ...next.events[0], trackingNumber: 'DIFFERENT-PACKAGE' }] },
    { ...next, events: [{ ...next.events[0], providerActorFingerprint: 'd'.repeat(64) }] },
  ]) await assert.rejects(append(change, conflictLease), (error) => error.code === 'COMMERCE_ORDER_SYNC_SENSITIVE_REVISION_CONFLICT')
  await close(conflictLease)

  // Two fresh exact reads still carry independent lease lineage, but cannot
  // create duplicate URL evidence for the same event/revision.
  const concurrentRevision = new Date(new Date(nextRevision).getTime() + 1000).toISOString()
  const concurrentRead = observation('https://carrier.example/track/third', {
    providerUpdatedAt: concurrentRevision, sourceRevision: concurrentRevision,
  })
  const concurrentLeases = await Promise.all([fresh(), fresh()])
  await Promise.all(concurrentLeases.map((lease) => append(concurrentRead, lease)))
  await Promise.all(concurrentLeases.map(close))
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM operations_commerce_order_tracking_url_evidence
    WHERE base_event_id=$1`, [base.id])).rows[0].count, 3)

  const helper = loadTypeScriptModule('app_src/lib/persistence/commerceOrderTrackingUrlEvidence.ts', {
    '@/lib/auditWriter': { async recordAuditEvent() {} },
  })
  const historicalProjection = await pool.query(`SELECT ${helper.COMMERCE_ORDER_TRACKING_URL_VALUE_SQL} AS url
    FROM operations_commerce_order_event_observations event
    ${helper.commerceOrderTrackingUrlEvidenceJoinSql('url_observation.observed_at <= $2::timestamptz')}
    WHERE event.id=$1`, [base.id, originalRead.observedAt])
  assert.equal(historicalProjection.rows[0].url, null, 'a later enrichment must not leak into an earlier exact-read boundary')

  // A second legacy shape stored the URL-aware hash on the original parent
  // itself, but did not retain the optional URL on its base event.
  const sameHashRead = observation(urlOne, { externalOrderId: `${externalOrderId}-same-hash` })
  const sameHashNormalized = persistence.normalizeCommerceOrderObservationInput(sameHashRead)
  const sameHashLease = await fresh()
  const sameHashParent = (await pool.query(`INSERT INTO operations_commerce_order_observations
    SELECT (jsonb_populate_record(NULL::operations_commerce_order_observations,
      to_jsonb(original) || jsonb_build_object('id',gen_random_uuid(),
        'global_id',allocate_global_reference('gcoo'),'external_order_id',$2::text,'source_hash',$3::text,
        'observed_at',$4::timestamptz,'created_at',clock_timestamp(),'manual_provider_read_lease_id',$5::uuid))).*
    FROM operations_commerce_order_observations original WHERE id=$1 RETURNING id::text`,
  [original.id, sameHashRead.externalOrderId, sameHashNormalized.sourceHash, sameHashRead.observedAt, sameHashLease.id])).rows[0]
  const sameHashBase = (await pool.query(`INSERT INTO operations_commerce_order_event_observations
    SELECT (jsonb_populate_record(NULL::operations_commerce_order_event_observations,
      to_jsonb(original) || jsonb_build_object('id',gen_random_uuid(),
        'global_id',allocate_global_reference('gcoe'),'external_order_id',$2::text,
        'event_hash',$3::text,'observation_id',$4::uuid,'created_at',clock_timestamp()))).*
    FROM operations_commerce_order_event_observations original WHERE id=$1 RETURNING id::text`,
  [base.id, sameHashRead.externalOrderId, sameHashNormalized.events[0].eventHash, sameHashParent.id])).rows[0]
  await close(sameHashLease)
  const sameHashRepairLease = await fresh()
  const sameHashArgs = { ...scope, externalOrderId: sameHashRead.externalOrderId,
    providerReadLease: leaseInput(sameHashRepairLease), observation: { ...sameHashRead, observedAt: new Date().toISOString() } }
  assert.equal((await persistence.appendCommerceOrderWorkbenchExactReadInPostgres(sameHashArgs)).appended, 1)
  assert.equal((await persistence.appendCommerceOrderWorkbenchExactReadInPostgres(sameHashArgs)).preserved, 1)
  await close(sameHashRepairLease)
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM operations_commerce_order_tracking_url_evidence
    WHERE base_event_id=$1`, [sameHashBase.id])).rows[0].count, 1)
  const highClock = new Date(new Date(revision).getTime() + 10_000).toISOString()
  const middleClock = new Date(new Date(revision).getTime() + 5_000).toISOString()
  for (const [url, clock] of [[null, highClock], [urlTwo, middleClock]]) {
    const lease = await fresh()
    const value = observation(url, { externalOrderId: sameHashRead.externalOrderId,
      providerUpdatedAt: clock, sourceRevision: clock })
    await persistence.appendCommerceOrderWorkbenchExactReadInPostgres({ ...scope,
      externalOrderId: value.externalOrderId, providerReadLease: leaseInput(lease), observation: value })
    await close(lease)
  }
  const olderExactSnapshot = await persistence.readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
    ...scope, externalOrderId: sameHashRead.externalOrderId, providerObservationKinds: ['manual_exact_read'],
  })
  assert.equal(olderExactSnapshot.items.find((event) => event.eventKind === 'tracking_updated').payload.trackingUrl,
    urlOne, 'a later receipt with a lower provider clock cannot enrich an older exact snapshot')

  // A historically expired base must stay redacted even when fetched again.
  const expiredRevision = new Date(Date.now() - 401 * 86_400_000).toISOString()
  const expired = observation(null, { externalOrderId: `${externalOrderId}-expired`, sourceRevision: expiredRevision,
    providerCreatedAt: expiredRevision, providerUpdatedAt: expiredRevision,
    events: [{ ...originalRead.events[0], occurredAt: expiredRevision }] })
  const expiredLease = await fresh()
  const expiredScope = { ...scope, externalOrderId: expired.externalOrderId, providerReadLease: leaseInput(expiredLease) }
  await persistence.appendCommerceOrderWorkbenchExactReadInPostgres({ ...expiredScope, observation: expired })
  await close(expiredLease)
  const expiredRefreshLease = await fresh()
  await persistence.appendCommerceOrderWorkbenchExactReadInPostgres({ ...expiredScope, providerReadLease: leaseInput(expiredRefreshLease),
    observation: { ...expired, events: [{ ...expired.events[0], trackingUrl: urlOne }] } })
  await close(expiredRefreshLease)
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM operations_commerce_order_tracking_url_evidence
    WHERE external_order_id=$1`, [expired.externalOrderId])).rows[0].count, 0)
  console.log('Tracking URL runtime: sealed poison repair, replay, omission, replacement, conflicts, concurrency, snapshot and expiry passed')
}
