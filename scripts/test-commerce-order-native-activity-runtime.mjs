import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { loadTypeScriptModule } from './test-commerce-order-revisions-postgres.mjs'

export async function verifyCommerceOrderNativeActivityRuntime({ pool, persistence, ids, createLease }) {
  const externalOrderId = `gid://shopify/Order/native-${randomUUID()}`
  const revision = new Date(Date.now() - 86_400_000).toISOString()
  const scope = { organizationId: ids.organization, integrationAccountId: ids.integration,
    accountGlobalId: 'gia0009301', provider: 'shopify', credentialGeneration: 1, externalOrderId }
  const observation = (message, actor = 'Provider Staff') => ({
    observationKind: 'manual_exact_read', externalOrderId, orderNumber: '#NATIVE-ACTIVITY',
    sourceRevision: revision, sourceHash: 'a'.repeat(64), providerCreatedAt: revision, providerUpdatedAt: revision,
    observedAt: new Date().toISOString(), providerReadCount: 5,
    canonicalLifecycleState: 'open', canonicalPaymentState: 'paid', canonicalFulfillmentState: 'unfulfilled',
    canonicalReturnState: 'none', lines: [], nativeActivityState: 'complete', nativeActivityReason: null,
    nativeActivityFetchedCount: 1, events: [{ externalEventId: 'gid://shopify/BasicEvent/native-one',
      externalSubjectId: externalOrderId, eventKind: 'provider_activity', eventStatus: 'comment',
      attributionSource: 'unavailable', providerMessage: message, providerActorDisplayName: actor, occurredAt: revision }],
  })
  const leaseInput = (lease) => ({ id: lease.id, authorityKind: 'manual_read_only', readKind: 'order_history',
    intentFingerprintSha256: lease.intentFingerprintSha256, controlRevision: lease.control_revision,
    activationRevision: lease.activation_revision, expiresAt: lease.expires_at.toISOString() })
  const close = (lease) => pool.query(`UPDATE operations_commerce_store_sync_read_leases
    SET released_at=clock_timestamp(),release_reason='completed' WHERE id=$1`, [lease.id])
  const first = observation('Original provider note')
  const changed = observation('Edited provider note', 'Corrected Provider Name')
  changed.events[0].eventStatus = 'updated-comment'
  const firstNormalized = persistence.normalizeCommerceOrderObservationInput(first)
  const changedNormalized = persistence.normalizeCommerceOrderObservationInput(changed)
  assert.equal(firstNormalized.sourceHash, changedNormalized.sourceHash, 'mutable text/name cannot enter durable source hash')
  assert.equal(firstNormalized.events[0].eventHash, changedNormalized.events[0].eventHash)
  const captures = []
  for (const value of [first, changed, observation('Original provider note')]) {
    const lease = await createLease(`native-${randomUUID()}`)
    // Each simulated read has its actual later capture clock, not an invented provider revision.
    value.observedAt = new Date().toISOString()
    captures.push(value.observedAt)
    const args = { ...scope, providerReadLease: leaseInput(lease), observation: value }
    const result = await persistence.appendCommerceOrderWorkbenchExactReadInPostgres(args)
    assert.equal(result.providerReads, 5, 'actual bounded reads must not be hardcoded to three')
    assert.equal((await persistence.appendCommerceOrderWorkbenchExactReadInPostgres(args)).preserved, 1)
    await close(lease)
  }
  const base = (await pool.query(`SELECT * FROM operations_commerce_order_event_observations WHERE external_order_id=$1`, [externalOrderId])).rows
  assert.equal(base.length, 1)
  assert.equal(base[0].event_kind, 'provider_activity')
  assert.equal(base[0].actor_email, null)
  assert.equal(base[0].event_status, null)
  assert.equal(base[0].attribution_source, 'unavailable')
  const snapshots = (await pool.query(`SELECT * FROM operations_commerce_order_native_activity_evidence
    WHERE base_event_id=$1 ORDER BY observed_at,id`, [base[0].id])).rows
  assert.equal(snapshots.length, 3, 'A→B→A native edits must append snapshots without another base event')
  assert.ok(snapshots.every((row) => row.sensitive_evidence_expires_at.toISOString() === base[0].sensitive_evidence_expires_at.toISOString()))
  const timeline = await persistence.readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres(scope)
  const native = timeline.items.filter((event) => event.eventKind === 'provider_activity')
  assert.equal(native.length, 1)
  assert.equal(native[0].payload.providerMessage, 'Original provider note')
  assert.equal(native[0].actorEmail, null, 'a provider display name must never impersonate a ClawPilot actor')
  const helper = loadTypeScriptModule('app_src/lib/persistence/commerceOrderNativeActivity.ts', {
    '@/lib/auditWriter': { async recordAuditEvent() {} },
  })
  const anchored = (await pool.query(`SELECT ${helper.COMMERCE_ORDER_NATIVE_MESSAGE_SQL} AS message,
      ${helper.COMMERCE_ORDER_NATIVE_ACTOR_SQL} AS actor
    FROM operations_commerce_order_event_observations event
    ${helper.commerceOrderNativeActivityJoinSql('native_observation.observed_at <= $2::timestamptz')}
    WHERE event.id=$1`, [base[0].id, captures[1]])).rows[0]
  assert.deepEqual(anchored, { message: 'Edited provider note', actor: 'Corrected Provider Name' })

  const staleClock = new Date(new Date(revision).getTime() - 1000).toISOString()
  const laterCapture = { ...observation('Later capture with an older core clock'),
    providerUpdatedAt: staleClock, sourceRevision: staleClock }
  laterCapture.events.push({ ...laterCapture.events[0],
    externalEventId: 'gid://shopify/BasicEvent/native-later-discovered', providerMessage: 'Later discovered activity' })
  laterCapture.nativeActivityFetchedCount = 2
  const laterLease = await createLease(`native-later-capture-${randomUUID()}`)
  await persistence.appendCommerceOrderWorkbenchExactReadInPostgres({ ...scope,
    providerReadLease: leaseInput(laterLease), observation: laterCapture })
  await close(laterLease)
  const captureBound = (await pool.query(`SELECT ${helper.COMMERCE_ORDER_NATIVE_MESSAGE_SQL} AS message
    FROM operations_commerce_order_event_observations event
    ${helper.commerceOrderNativeActivityJoinSql(`
      (COALESCE(native_observation.provider_updated_at,native_observation.observed_at),native_observation.observed_at)
        <= ($3::timestamptz,$2::timestamptz)
      AND native_observation.observed_at <= $2::timestamptz`)}
    WHERE event.id=$1`, [base[0].id, captures[1], revision])).rows[0]
  assert.equal(captureBound.message, 'Edited provider note', 'later evidence with an older provider clock cannot leak into an earlier snapshot')
  const selectedSnapshot = await persistence.readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
    ...scope, providerObservationKinds: ['manual_exact_read'],
  })
  const selectedNative = selectedSnapshot.items.filter((event) => event.eventKind === 'provider_activity')
  assert.equal(selectedNative.length, 1, 'a newly discovered native base event cannot leak into an earlier exact snapshot')
  assert.equal(selectedNative[0].payload.providerMessage, 'Original provider note')

  const unavailable = { ...observation(null), events: [], nativeActivityState: 'unavailable',
    nativeActivityReason: 'provider_access_unavailable', nativeActivityFetchedCount: 0, providerReadCount: 4 }
  const unavailableLease = await createLease(`native-unavailable-${randomUUID()}`)
  await persistence.appendCommerceOrderWorkbenchExactReadInPostgres({ ...scope,
    providerReadLease: leaseInput(unavailableLease), observation: unavailable })
  await close(unavailableLease)
  const unavailableTimeline = await persistence.readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres(scope)
  const coverage = unavailableTimeline.items.find((event) => event.eventKind === 'order_lines_snapshot').payload
  assert.equal(coverage.nativeActivityState, 'unavailable')
  assert.equal(coverage.nativeActivityFetchedCount, 0)
  assert.equal(unavailableTimeline.items.filter((event) => event.eventKind === 'provider_activity').length, 2)
  const expiredRevision = new Date(Date.now() - 401 * 86_400_000).toISOString()
  const expired = observation('Expired provider message must never rehydrate')
  expired.externalOrderId = `${externalOrderId}-expired`
  expired.events[0].externalSubjectId = expired.externalOrderId
  expired.events[0].occurredAt = expiredRevision
  expired.providerCreatedAt = expiredRevision
  expired.providerUpdatedAt = expiredRevision
  expired.sourceRevision = expiredRevision
  const expiredLease = await createLease(`native-expired-${randomUUID()}`)
  await persistence.appendCommerceOrderWorkbenchExactReadInPostgres({ ...scope,
    externalOrderId: expired.externalOrderId, providerReadLease: leaseInput(expiredLease), observation: expired })
  await close(expiredLease)
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM operations_commerce_order_native_activity_evidence
    WHERE external_order_id=$1`, [expired.externalOrderId])).rows[0].count, 0)
  console.log('Native activity runtime: five-read capture, immutable identity, A→B→A, replay, as-of authorship and unavailable coverage passed')
}
