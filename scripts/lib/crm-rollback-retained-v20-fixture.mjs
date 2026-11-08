import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { applyMigrationSqlForTest } from './postgres-test-migrations.mjs'

const LAST = '0412_crm_calendar_occurrence_claims.sql'
const PRODUCT_CAPABILITY = '0373_fractional_crm_product_read.sql'
const PRODUCT_CHECKSUM = '0e01f96a2862c22e785cd16a49a5079d0e9492f7503e155941b45e111b64a764'
const FOLDER_CAPABILITY = '0403_fractional_crm_customer_folder_capability.sql'
const hash = value => createHash('sha256').update(value).digest('hex')
const denied = code => error => error?.code === code
const one = result => {
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

// Called only with the rolling runner's second blank owned database, not a
// connection string or an environment-selected target. The caller owns it.
export async function checkRetainedV21({ pool, read, migrationPaths, loadCrmPersistence, loadOccurrenceClaims, loadFractionalGateway }) {
  const query = (sql, values) => pool.query(sql, values)
  async function transaction(fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  assert.equal(one(await query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'")).count, 0)
  assert.ok(Array.isArray(migrationPaths) && migrationPaths.length > 1)
  assert.ok(migrationPaths.every(path => /^db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u.test(path)))
  assert.deepEqual(migrationPaths, [...new Set(migrationPaths)].sort())
  assert.equal(basename(migrationPaths.at(-1)), LAST)
  assert.ok(migrationPaths.includes(`db/migrations/${PRODUCT_CAPABILITY}`))
  assert.ok(migrationPaths.includes(`db/migrations/${FOLDER_CAPABILITY}`))
  const ledger = []
  const retainedCredential = randomUUID(), retainedGatewayInstance = randomUUID(), retainedGatewayDeployment = randomUUID()
  const retainedGatewayWorkspace = randomUUID(), retainedGatewayPipeline = randomUUID(), retainedGatewayRoot = randomUUID()
  const retainedGatewayOwner = 'retained-fractional-gateway@example.invalid'
  const retainedToken = `fcg_${retainedCredential.replaceAll('-','')}_${'R'.repeat(43)}`
  const credentialRows = async client => (await client.query(`SELECT to_jsonb(c) AS row
    FROM fractional_crm_gateway_credentials c ORDER BY c.id`)).rows
  let beforeFolderUpgrade, retainedGatewayReference
  const migrationClient = await pool.connect()
  try {
    await migrationClient.query(`CREATE TABLE schema_migrations (
      filename text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())`)
    for (const path of migrationPaths) {
      const filename = basename(path), sql = read(path), checksum = hash(sql)
      assert.ok(sql.trim(), `Empty fixture migration: ${filename}`)
      if (filename === PRODUCT_CAPABILITY) assert.equal(checksum, PRODUCT_CHECKSUM, 'Do not rewrite the published product migration')
      if (filename === FOLDER_CAPABILITY) {
        // A preexisting, enabled product grant exercises the real upgrade,
        // unlike a fresh schema on which there are no rows to invalidate.
        assert.equal(one(await migrationClient.query('SELECT checksum FROM schema_migrations WHERE filename=$1', [PRODUCT_CAPABILITY])).checksum,
          PRODUCT_CHECKSUM)
        const { auth } = loadFractionalGateway(query, transaction)
        await migrationClient.query("INSERT INTO app_users(email,role,status,activated_at) VALUES($1,'owner','active',now())", [retainedGatewayOwner])
        retainedGatewayReference = one(await migrationClient.query(`INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by)
          VALUES($1,'Synthetic Fractional retained workspace','root',$2,$2) RETURNING reference_code`, [retainedGatewayWorkspace, retainedGatewayOwner])).reference_code
        await migrationClient.query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,created_by,updated_by)
          VALUES($1,$2,'owner','active',$1,$1)`, [retainedGatewayOwner, retainedGatewayWorkspace])
        await migrationClient.query(`INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id,is_default)
          VALUES($1,'Synthetic Fractional retained pipeline',$2,$3,true)`, [retainedGatewayPipeline, retainedGatewayOwner, retainedGatewayWorkspace])
        await migrationClient.query(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,source_key,identity_key,reference_code,name,
          source_hash,workspace_organization_id,relationship_type,created_by,updated_by)
          VALUES($1::uuid,$2,$1::text,'retained-fractional-root','retained-fractional-root',$3,'Synthetic Fractional retained root',
          'root',$4,'workspace_root',$5,$5)`, [retainedGatewayRoot, retainedGatewayPipeline, retainedGatewayReference, retainedGatewayWorkspace, retainedGatewayOwner])
        await migrationClient.query(`INSERT INTO fractional_crm_gateway_credentials(id,token_hash,source_instance_id,workspace_organization_id,
          pipeline_id,root_company_global_id,capabilities,fractional_deployment_id,fractional_organization_id,actor_email,expires_at,enabled)
          VALUES($1,$2,$3,$4,$5,$6,ARRAY['crm.product.read'],$7,'synthetic-retained-fractional',$8,now()+interval '1 hour',true)`,
        [retainedCredential, auth.hashFractionalCrmGatewayToken(retainedToken), retainedGatewayInstance, retainedGatewayWorkspace,
          retainedGatewayPipeline, retainedGatewayReference, retainedGatewayDeployment, retainedGatewayOwner])
        beforeFolderUpgrade = await credentialRows(migrationClient)
        assert.equal(beforeFolderUpgrade.length, 1)
        assert.deepEqual(beforeFolderUpgrade[0].row.capabilities, ['crm.product.read'])
        assert.equal(beforeFolderUpgrade[0].row.enabled, true)
        assert.equal(beforeFolderUpgrade[0].row.revoked_at, null)
      }
      await applyMigrationSqlForTest(migrationClient, filename, sql, { checksum })
      ledger.push({ filename, checksum, applied: true })
      if (filename === FOLDER_CAPABILITY) assert.deepEqual(await credentialRows(migrationClient), beforeFolderUpgrade)
    }
  } finally { migrationClient.release() }
  const readLedger = async () => (await query(`SELECT filename,checksum,applied_at IS NOT NULL AS applied
    FROM schema_migrations ORDER BY filename COLLATE "C"`)).rows
  assert.deepEqual(await readLedger(), ledger)
  assert.ok(beforeFolderUpgrade)
  assert.deepEqual(await credentialRows(pool), beforeFolderUpgrade)
  const checks = ['full_migration_checksum_ledger']

  const owner = 'retained-v20@example.invalid'
  const workspace = randomUUID(), pipeline = randomUUID(), mailbox = randomUUID(), canonical = randomUUID()
  const customer = randomUUID(), supplier = randomUUID(), customerContact = randomUUID(), supplierContact = randomUUID()
  const email = randomUUID(), native = randomUUID(), terminal = randomUUID(), terminalNative = randomUUID(), deadJob = randomUUID()
  const message = 'a07c12001', thread = 'a07c12fff', sourceKey = 'retained-v20:canonical-email'
  const occurrenceKey = hash('synthetic retained Calendar occurrence'), meetingId = randomUUID(), discovery = randomUUID()
  const calendarId = 'retained-v20-calendar@example.invalid', externalEventId = 'retainedv20calendaroccurrence'
  const retainedOccurrence = { pipelineId: pipeline, meetingId, calendarId, externalEventId, occurrenceKey }
  const fixtureDigest = hash('synthetic retained v20 fixture')
  const controlState = async () => one(await query(`SELECT to_jsonb(control) AS publication,
    (SELECT count(*)::int FROM crm_native_email_publication_admissions) AS admissions,
    (SELECT count(*)::int FROM crm_native_email_authority_transitions) AS transitions,
    (SELECT count(*)::int FROM crm_native_email_initial_enrollments) AS enrollments,
    (SELECT count(*)::int FROM crm_native_email_initial_reservations) AS reservations,
    (SELECT count(*)::int FROM crm_legacy_email_recovery_holds) AS holds,
    (SELECT count(*)::int FROM crm_legacy_email_recovery_releases) AS releases,
    (SELECT count(*)::int FROM crm_legacy_email_recovery_settlements) AS settlements,
    (SELECT count(*)::int FROM crm_legacy_email_recovery_stages) AS stages,
    (SELECT count(*)::int FROM crm_legacy_email_retirement.verified_batch) AS batches,
    (SELECT count(*)::int FROM crm_legacy_email_retirement.review) AS reviews,
    (SELECT count(*)::int FROM crm_legacy_email_retirement.retained) AS retained,
    (SELECT count(*)::int FROM crm_legacy_email_retirement.consumed) AS consumed,
    (SELECT count(*)::int FROM crm_legacy_email_retirement.account_repair_approvals) AS repair_approvals,
    (SELECT count(*)::int FROM crm_legacy_email_retirement.account_repairs) AS repairs
    FROM crm_native_email_publication_control control WHERE singleton`))
  const initialControl = await controlState()
  assert.equal(initialControl.publication.enabled, false)
  for (const column of ['active_operation_id', 'active_transition_id', 'active_initial_enrollment_id', 'activation_receipt_hash']) {
    assert.equal(initialControl.publication[column], null)
  }
  assert.ok(Object.entries(initialControl).filter(([key]) => key !== 'publication').every(([, value]) => value === 0))

  await transaction(async client => {
    await client.query("INSERT INTO app_users(email,role,status,activated_at) VALUES ($1,'owner','active',now())", [owner])
    await client.query(`INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by)
      VALUES($1,'Synthetic retained organization','root',$2,$2)`, [workspace, owner])
    await client.query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,created_by,updated_by)
      VALUES($1,$2,'owner','active',$1,$1)`, [owner, workspace])
    await client.query(`INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id,is_default)
      VALUES($1,'Synthetic retained pipeline',$2,$3,true)`, [pipeline, owner, workspace])
    for (const [company, contact, role] of [[customer, customerContact, 'customer'], [supplier, supplierContact, 'supplier']]) {
      await client.query(`INSERT INTO crm_organizations(id,pipeline_id,name,account_type,suitecrm_id,identity_key,source_key,source_hash,reference_code)
        VALUES($1,$2,$3,$3,$4,$5,$5,$6,allocate_crm_reference('ga'))`,
      [company, pipeline, role, randomUUID(), `customer:name:${role}`, fixtureDigest])
      const contactEmail = `${role}@example.invalid`
      await client.query(`INSERT INTO crm_contacts(id,pipeline_id,organization_id,full_name,email,suitecrm_id,identity_key,source_key,source_hash,reference_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,allocate_crm_reference('gc'))`,
      [contact, pipeline, company, `${role}-contact`, contactEmail, randomUUID(), `contact:email:${contactEmail}`, fixtureDigest])
    }
    await client.query(`INSERT INTO crm_email_mailboxes(id,owner_email,provider,provider_account_id,account_email,verified_at)
      VALUES($1,$2,'gmail','synthetic-retained-mailbox',$2,now())`, [mailbox, owner])
    await client.query(`INSERT INTO crm_email_sources(id,mailbox_id,owner_email,provider_message_id,provider_thread_id,intake_pipeline_id,
      intake_workspace_id,observed_connection_id,observed_account_email,evidence,evidence_hash,provenance)
      VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-retained-connection',$3,'{}',$8,'{}')`,
    [canonical, mailbox, owner, message, thread, pipeline, workspace, fixtureDigest])
    // Seed an already-reviewed retained placement, not a new recovery. All
    // subsequent interaction changes go through the real compatible writer.
    await client.query("SELECT set_config('clawpilot.crm_shared_write_v1','on',true)")
    await client.query(`INSERT INTO crm_interactions(id,pipeline_id,organization_id,contact_id,suitecrm_id,reference_code,source_key,
      interaction_type,suitecrm_module,subject,description,agent_email,agent_name,occurred_at,direction,delivery_status,
      provider_message_id,provider_thread_id,canonical_source_id,metadata,source_payload,source_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,allocate_crm_reference('gi'),$6,'email','Emails','Synthetic retained Email','Synthetic retained body',
      $7,'Retained Operator','2026-10-01T12:00:00.123Z','inbound','received',$8,$9,$10,$11,$12,$13,$7,$7)`,
    [email, pipeline, customer, customerContact, native, sourceKey, owner, message, thread, canonical,
      { canonicalSourceId: canonical }, { source: 'synthetic-retained-v20' }, fixtureDigest])
    for (const [company, contact, primary, sort] of [[customer, customerContact, true, 0], [supplier, supplierContact, false, 1]]) {
      await client.query(`INSERT INTO crm_interaction_organizations(pipeline_id,interaction_id,organization_id,is_primary,sort_order,created_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(interaction_id,organization_id) DO NOTHING`, [pipeline, email, company, primary, sort, owner])
      await client.query(`INSERT INTO crm_interaction_contacts(pipeline_id,interaction_id,contact_id,is_primary,sort_order,created_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(interaction_id,contact_id) DO NOTHING`, [pipeline, email, contact, primary, sort, owner])
    }
    const terminalRef = one(await client.query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,
      suitecrm_module,reference_code,interaction_type,sync_status)
      VALUES($1,$2,'retained-v20:dead-email','Synthetic terminal Email',$3,$4,'Emails',allocate_crm_reference('gi'),'email','failed')
      RETURNING reference_code`, [terminal, pipeline, fixtureDigest, terminalNative])).reference_code
    await client.query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,status,attempts,
      last_error,processed_at,idempotency_key) VALUES($1,'suitecrm','crm_interactions',$2,'upsert_record',$3,'dead',8,
      'Synthetic unresolved provider outcome',now(),$4)`, [deadJob, terminal,
      { entity: 'interactions', pipelineId: pipeline, localId: terminal, suiteCrmId: terminalNative, suiteCrmModule: 'Emails',
        attributes: { global_id_c: terminalRef } }, `crm:interactions:v4:${terminal}:Emails:${fixtureDigest}`])
    await client.query(`INSERT INTO crm_calendar_discovery_sources(id,pipeline_id,workspace_organization_id,credential_owner_email,
      connection_id,calendar_id,account_email,verified_at) VALUES($1,$2,$3,$4,'retained-calendar-connection',$5,$4,now())`,
    [discovery, pipeline, workspace, owner, calendarId])
  })
  // The new operator, membership and pipeline are source-inventory changes;
  // while disabled the real fence invalidates the prior authority generation.
  // Start the retained comparison after that fixture-only provisioning and
  // require every other control and ledger value to remain identical.
  const retainedControl = await controlState()
  const { generation, updated_at, ...retainedPublication } = retainedControl.publication
  const { generation: initialGeneration, updated_at: initialUpdatedAt, ...initialPublication } = initialControl.publication
  assert.ok(Number.isSafeInteger(generation) && generation >= initialGeneration)
  assert.ok(Date.parse(updated_at) >= Date.parse(initialUpdatedAt))
  assert.deepEqual({ ...retainedControl, publication: retainedPublication }, { ...initialControl, publication: initialPublication })

  const emailSnapshot = async () => one(await query(`SELECT i.id,i.reference_code,i.suitecrm_id,i.source_key,i.canonical_source_id,
    i.provider_message_id,i.provider_thread_id,i.organization_id,i.contact_id,i.agent_email,i.agent_name,i.occurred_at::text,
    i.description,i.direction,i.delivery_status,i.source_payload,i.subject,
    (SELECT to_jsonb(s) FROM crm_email_sources s WHERE s.id=i.canonical_source_id) AS canonical,
    ARRAY(SELECT organization_id::text FROM crm_interaction_organizations o WHERE o.interaction_id=i.id
      ORDER BY sort_order,organization_id) AS organizations,
    ARRAY(SELECT organization_id::text FROM crm_interaction_organizations o WHERE o.interaction_id=i.id AND is_primary) AS primary_organizations,
    ARRAY(SELECT contact_id::text FROM crm_interaction_contacts c WHERE c.interaction_id=i.id ORDER BY sort_order,contact_id) AS contacts,
    ARRAY(SELECT contact_id::text FROM crm_interaction_contacts c WHERE c.interaction_id=i.id AND is_primary) AS primary_contacts
    FROM crm_interactions i WHERE i.pipeline_id=$1 AND (i.canonical_source_id=$2 OR i.provider_message_id=$3 OR i.source_key=$4)`,
  [pipeline, canonical, message, sourceKey]))
  const terminalSnapshot = async () => one(await query(`SELECT to_jsonb(o) AS job,to_jsonb(i) AS interaction
    FROM sync_outbox o JOIN crm_interactions i ON i.id::text=o.aggregate_id WHERE o.id=$1`, [deadJob]))
  const queue = async () => (await query('SELECT to_jsonb(o) AS row FROM sync_outbox o ORDER BY id')).rows
  const calendarSnapshot = async () => ({
    meetings: (await query('SELECT to_jsonb(m) AS row FROM crm_meetings m WHERE pipeline_id=$1 ORDER BY id', [pipeline])).rows,
    claims: (await query('SELECT to_jsonb(c) AS row FROM crm_calendar_occurrence_claims c WHERE pipeline_id=$1 ORDER BY occurrence_key', [pipeline])).rows,
    bindings: (await query('SELECT to_jsonb(b) AS row FROM crm_calendar_occurrence_bindings b WHERE pipeline_id=$1 ORDER BY calendar_id,external_event_id', [pipeline])).rows,
    mappings: (await query('SELECT to_jsonb(d) AS row FROM crm_calendar_discovery_events d WHERE pipeline_id=$1 ORDER BY calendar_id,external_event_id', [pipeline])).rows,
  })
  const insertDiscoveryMeeting = (client, id, event) => client.query(`INSERT INTO crm_meetings(id,pipeline_id,source_key,
    reference_code,subject,starts_at,ends_at,provider,external_event_id,source_payload,source_hash,status)
    VALUES($1,$2,$3,allocate_crm_reference('gm'),'Synthetic retained Calendar meeting','2026-10-02T13:00:00Z',
      '2026-10-02T14:00:00Z','google-calendar',$4,$5,$6,'scheduled')`, [id, pipeline, `calendar-discovery:${event}`, event,
    { source: 'google_calendar_discovery', calendarId }, fixtureDigest])
  const edit = (subject, fields = {}) => ({ entity: 'interactions', pipelineId: pipeline, localId: email, sourceKey,
    actorEmail: owner, emitSuiteCrmOutbox: false, fields: { subject, description: 'Synthetic retained body', ...fields } })
  const expected = await emailSnapshot(), savedTerminal = await terminalSnapshot(), savedQueue = await queue()
  assert.deepEqual(expected.organizations, [customer, supplier])
  assert.deepEqual(expected.primary_organizations, [customer])
  assert.deepEqual(expected.contacts, [customerContact, supplierContact])
  assert.deepEqual(expected.primary_contacts, [customerContact])
  assert.equal(expected.canonical.id, canonical)
  assert.equal(savedTerminal.job.status, 'dead')
  assert.equal(savedTerminal.job.attempts, 8)

  const currentWriter = loadCrmPersistence(query, transaction)
  const currentClaims = loadOccurrenceClaims()
  const written = await currentWriter.stageCrmRecordInPostgres(edit('Compatible retained-v20 writer'))
  assert.equal(written.id, email)
  assert.deepEqual(await emailSnapshot(), { ...expected, subject: 'Compatible retained-v20 writer' })
  await transaction(async client => {
    await currentClaims.lockCalendarOccurrencePipeline(client, pipeline)
    await insertDiscoveryMeeting(client, meetingId, externalEventId)
    assert.equal(await currentClaims.claimVerifiedCalendarOccurrence(client, retainedOccurrence), 'claimed')
    await client.query(`INSERT INTO crm_calendar_discovery_events(pipeline_id,source_id,calendar_id,external_event_id,meeting_id,event_hash)
      VALUES($1,$2,$3,$4,$5,$6)`, [pipeline, discovery, calendarId, externalEventId, meetingId, fixtureDigest])
  })
  const originalCalendar = await calendarSnapshot()
  assert.ok(Object.values(originalCalendar).every(rows => rows.length === 1))

  const reopenedWriter = loadCrmPersistence(query, transaction)
  const reopenedClaims = loadOccurrenceClaims()
  assert.notEqual(reopenedWriter.stageCrmRecordInPostgres, currentWriter.stageCrmRecordInPostgres)
  assert.notEqual(reopenedClaims.claimVerifiedCalendarOccurrence, currentClaims.claimVerifiedCalendarOccurrence)
  const result = await reopenedWriter.stageCrmRecordInPostgres(edit('Reopened retained-v20 writer'))
  assert.deepEqual([result.id, result.suiteCrmId, result.referenceCode], [email, native, expected.reference_code])
  const reopenedEmail = { ...expected, subject: 'Reopened retained-v20 writer' }
  assert.deepEqual(await emailSnapshot(), reopenedEmail)
  await assert.rejects(() => reopenedWriter.stageCrmRecordInPostgres(edit('Must not change identity', { providerMessageId: 'a07c12002' })),
    /Canonical Email provider identity must be preserved/u)
  await assert.rejects(() => reopenedWriter.stageCrmRecordInPostgres(edit('Must not change placement', { organizationId: supplier })),
    /Canonical Email associations require a reviewed correction/u)
  assert.deepEqual(await emailSnapshot(), reopenedEmail)
  checks.push('reloaded_email_preserves_single_identity_and_links')

  await transaction(async client => {
    await reopenedClaims.lockCalendarOccurrencePipeline(client, pipeline)
    assert.equal(await reopenedClaims.readVerifiedCalendarOccurrence(client, retainedOccurrence), occurrenceKey)
    assert.equal(await reopenedClaims.claimVerifiedCalendarOccurrence(client, retainedOccurrence), 'unchanged')
    assert.equal(await reopenedClaims.calendarOccurrenceCreationHeld(client, pipeline), false)
  })
  await assert.rejects(() => transaction(async client => {
    const copyMeetingId = randomUUID(), copyEvent = 'retainedv20secondcalendarcopy'
    await reopenedClaims.lockCalendarOccurrencePipeline(client, pipeline)
    await insertDiscoveryMeeting(client, copyMeetingId, copyEvent)
    assert.equal(await reopenedClaims.claimVerifiedCalendarOccurrence(client, {
      ...retainedOccurrence, meetingId: copyMeetingId, externalEventId: copyEvent,
    }), 'conflict')
    // Even a writer that ignores the conflict cannot commit the duplicate.
    await client.query(`INSERT INTO crm_calendar_discovery_events(pipeline_id,source_id,calendar_id,external_event_id,meeting_id,event_hash)
      VALUES($1,$2,$3,$4,$5,$6)`, [pipeline, discovery, calendarId, copyEvent, copyMeetingId, fixtureDigest])
  }), denied('55000'))
  await assert.rejects(() => query(`DELETE FROM crm_calendar_occurrence_bindings WHERE pipeline_id=$1 AND meeting_id=$2`,
    [pipeline, meetingId]), denied('55000'))
  assert.deepEqual(await calendarSnapshot(), originalCalendar)
  checks.push('reloaded_calendar_preserves_single_occurrence')

  await assert.rejects(() => query(`INSERT INTO crm_legacy_email_recovery_holds(outbox_id,retired_outbox_id,operation_id,local_id,pipeline_id,
    native_id,global_id,retirement_receipt_hash,release_intent_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [deadJob, randomUUID(), randomUUID(), terminal, pipeline, terminalNative, savedTerminal.interaction.reference_code,
    fixtureDigest, hash('synthetic disabled hold refusal')]), error => denied('55000')(error) && /idle verified authority/u.test(error.message))
  assert.equal((await reopenedWriter.claimSuiteCrmOutboxInPostgres()).length, 0, 'Ordinary worker must not requeue a retained terminal Email')
  assert.deepEqual(await terminalSnapshot(), savedTerminal)
  assert.deepEqual(await queue(), savedQueue)
  assert.deepEqual(await controlState(), retainedControl)
  assert.deepEqual(await readLedger(), ledger)
  const capability = one(await query("SELECT current_setting('clawpilot.crm_shared_write_v1',true) AS flag")).flag
  assert.notEqual(capability, 'on', 'Current writer capability must be transaction-local')
  checks.push('retained_native_authority_and_recovery_controls_unchanged')

  const product = one(await query(`INSERT INTO crm_products(pipeline_id,source_key,name,product_type,price,currency,active,source_hash)
    VALUES($1,$2,'Synthetic retained Fractional service','Service',12.34,'USD',true,$3) RETURNING id,reference_code`,
  [retainedGatewayPipeline, randomUUID(), fixtureDigest]))
  const { auth, gateway } = loadFractionalGateway(query, transaction)
  const origin = 'https://clawpilot.example.invalid'
  const authenticate = capability => auth.authenticateFractionalCrmGateway(new Request(`${origin}/api/integrations/fractional-crm/v1/products`, {
    headers: { authorization: `Bearer ${retainedToken}` },
  }), { origin, sourceInstanceId: retainedGatewayInstance }, gateway.readFractionalCrmCredential, capability)
  const gatewayEffects = async () => one(await query(`SELECT (SELECT count(*) FROM fractional_crm_gateway_operations) AS operations,
    (SELECT count(*) FROM crm_fractional_customer_folders) AS folders,(SELECT count(*) FROM sync_outbox) AS outbox`))
  const effectsBeforeRead = await gatewayEffects()
  const principal = await authenticate('crm.product.read')
  assert.deepEqual([principal.credentialId, principal.pipelineId, principal.sourceInstanceId, principal.capabilities],
    [retainedCredential, retainedGatewayPipeline, retainedGatewayInstance, ['crm.product.read']])
  const catalogProduct = await gateway.readFractionalCrmProduct(principal, product.reference_code)
  assert.equal(catalogProduct.recordId, product.id)
  assert.equal(catalogProduct.scope.workspaceOrganizationId, retainedGatewayWorkspace)
  assert.equal(catalogProduct.invoiceDefaultVerified, false)
  assert.deepEqual((await gateway.listFractionalCrmProducts(principal, { limit: 10 })).items.map(item => item.globalId), [product.reference_code])
  await assert.rejects(() => authenticate('crm.customer-folder.write'), denied('CAPABILITY_DENIED'))
  await assert.rejects(() => gateway.readFractionalCrmCustomerFolder(principal, retainedGatewayReference, 'synthetic-retained-customer'),
    denied('CAPABILITY_DENIED'))
  assert.deepEqual(await credentialRows(pool), beforeFolderUpgrade)
  assert.deepEqual(await gatewayEffects(), effectsBeforeRead)
  assert.deepEqual(await readLedger(), ledger)
  checks.push('retained_fractional_product_credential_and_scope_unchanged')
  return { migrationCount: ledger.length, lastMigration: migrationPaths.at(-1), checks }
}
