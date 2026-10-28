#!/usr/bin/env node

// Real SQL integration coverage, deliberately limited to one disposable local
// database and synthetic Gmail messages. Never reads application credentials,
// loads .env files, refreshes provider data, or runs the full migration suite.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { decodeHtmlEntities } from '../app_src/lib/htmlEntities.mjs'
import { globalIdFragment } from '../app_src/lib/globalIds.mjs'
import {
  disposablePostgresDockerArgs,
  disposablePostgresDockerCleanupArgs,
} from './lib/disposable-postgres-docker.mjs'
import { runStorageGuard } from './local-storage-guard.mjs'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const unexpected = name => { throw new Error(`Unexpected external dependency: ${name}`) }

// An explicit opt-in for an already-created, private local fixture. This is not
// a general DATABASE_URL override: the database, port, owner and SSL behavior
// remain fixed, and no application environment or credentials are loaded.
const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 1 && args[0].startsWith('--native-socket=')),
  'Only --native-socket=/tmp/clawpilot-bpo-crm-pg.<id> is supported')
const nativeSocket = args[0]?.slice('--native-socket='.length)
if (nativeSocket !== undefined) {
  assert.match(nativeSocket, /^\/tmp\/clawpilot-bpo-crm-pg\.[A-Za-z0-9]+$/u,
    'Native socket must be an explicit disposable fixture path')
  const socketDirectory = lstatSync(nativeSocket)
  assert.ok(socketDirectory.isDirectory() && !socketDirectory.isSymbolicLink(),
    'Native fixture socket path must be a real directory')
  assert.equal(socketDirectory.uid, process.getuid(), 'Native fixture must belong to the current user')
  assert.equal(socketDirectory.mode & 0o077, 0, 'Native fixture must be private to the current user')
  assert.equal(realpathSync(nativeSocket), `${realpathSync('/tmp')}/${nativeSocket.split('/').at(-1)}`,
    'Native fixture may not traverse a symlink')
  assert.ok(process.env.USER, 'Native fixture requires the current local USER')
  assert.equal(runStorageGuard({ argv: ['--preflight'] }), 0, 'Local disk guard must pass')
}

function loadModule(path, dependencies = {}, extraSource = '') {
  const module = { exports: {} }
  const output = ts.transpileModule(`${read(path)}\n${extraSource}`, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    },
  }).outputText
  vm.runInNewContext(output, {
    Buffer, Error, TextDecoder, URL, URLSearchParams, Response, AbortSignal,
    process: { env: { CLAWPILOT_ARCHIVE_EMAIL: 'archive@example.test' } },
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name === 'node:crypto') return nodeRequire(name)
      return unexpected(name)
    },
  }, { filename: path })
  return module.exports
}

// Run the actual production persistence declarations, including relationship
// validation and the transaction wrapper. Only unrelated CRM entity branches
// are left out. The fixture's real is_demo flag suppresses provider outbox work;
// this test does not pretend to prove SuiteCRM delivery.
function loadCrmPersistence(query, withTransaction) {
  const path = 'app_src/lib/persistence/crm.ts'
  const parsed = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  const names = [
    'ENTITY_TABLE', 'activeCrmRecordSql', 'clean', 'nullable', 'isoTimestamp',
    'normalizedInteractionType', 'interactionSuiteCrmModule', 'interactionActivityStatus',
    'interactionDurationMinutes', 'uniqueUuidList', 'normalizeStageCrmRecordInput',
    'stageInteraction', 'stageCrmRecordWithClient', 'stageCrmRecordInPostgres',
    'enrichCrmEmailInteractionParticipantsInPostgres',
    'REVIEWED_GMAIL_RELATIONSHIPS', 'reviewedGmailContentFingerprint',
    'readReviewedGmailInteractionWithClient', 'prepareReviewedGmailInteractionWithClient',
    'applyReviewedGmailInteractionWithClient', 'stageReviewedGmailInteractionsInPostgres',
    'stageReviewedGmailInteractionInPostgres',
    'crmReferenceDestination', 'crmReferenceShortUrl', 'ensureCrmReferenceShortLink',
    'crmEntityForReferenceCode', 'resolveCrmReferenceCode', 'readCrmRecordReference',
    'readCrmRecordByReference',
  ]
  const declarations = names.map(name => {
    const declaration = parsed.statements.find(statement => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body
    ) || (
      ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(item => item.name.getText(parsed) === name)
    ))
    assert.ok(declaration, `Production declaration ${name} must exist`)
    return declaration.getText(parsed).replace(/^export\s+/u, '')
  }).join('\n')
  const output = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const stableId = loadModule('app_src/lib/crm/stableId.ts')
  const context = {
    query, withTransaction, ...stableId, URL, Error,
    crmParticipantEmailCandidatesSql: loadModule('app_src/lib/crm/participantEligibility.ts').crmParticipantEmailCandidatesSql,
    isPostgresStorageEnabled: () => true,
    appPublicUrl: () => 'http://localhost:4002',
    shortLinkUrl: code => `https://example.test/s/${code}`,
  }
  vm.runInNewContext(`${output}\nglobalThis.persistence = {
    stageCrmRecordInPostgres, readCrmRecordByReference, enrichCrmEmailInteractionParticipantsInPostgres,
    stageReviewedGmailInteractionsInPostgres, stageReviewedGmailInteractionInPostgres,
  }`, context, { filename: path })
  return context.persistence
}

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const OWNER = 'operator@example.test'
const OTHER_OWNER = 'other-owner@example.test'
const MAILBOX = 'mailbox@example.test'
const ALIAS = 'operator@business.example.test'
const PRIMARY = id(1)
const BUSINESS = id(2)
const FOREIGN = id(3)
const DISABLED_MEMBERSHIP = id(4)
const DISABLED_REFERENCES = id(5)
const CUSTOMER_PRIMARY = id(21)
const CUSTOMER_BUSINESS = id(22)
const CONTACT_PRIMARY = id(31)
const CONTACT_BUSINESS = id(32)
const LEAD_BUSINESS = id(33)
const CONNECTION = 'synthetic-gmail-connection'
const mailbox = { owner_email: OWNER, connection_id: CONNECTION, account_email: MAILBOX }
const providerMessages = new Map()
const providerCalls = []

function gmailMessage(messageId, overrides = {}) {
  const { from = 'business-contact@customer.example.test', to = MAILBOX, cc,
    threadId = `thread-${messageId}`, labels = ['INBOX'], body = 'Synthetic customer correspondence.' } = overrides
  const raw = {
    id: messageId, threadId,
    internalDate: String(Date.parse('2026-09-17T12:00:00.000Z')),
    labelIds: labels,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from }, { name: 'To', value: to },
        { name: 'Subject', value: `Synthetic routing ${messageId}` },
        ...(cc ? [{ name: 'Cc', value: cc }] : []),
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  }
  providerMessages.set(messageId, raw)
  return raw
}

const fixtureSchema = `
  CREATE TABLE workspace_organizations (id uuid PRIMARY KEY, is_demo boolean NOT NULL);
  CREATE TABLE app_users (
    email text PRIMARY KEY, status text NOT NULL, display_name text,
    suitecrm_user_id text, crm_user_enabled boolean, reference_code text
  );
  CREATE TABLE pipeline_spaces (
    id uuid PRIMARY KEY, owner_email text NOT NULL REFERENCES app_users(email),
    workspace_organization_id uuid NOT NULL REFERENCES workspace_organizations(id),
    is_default boolean DEFAULT false, reference_access_disabled boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE app_user_organization_memberships (
    organization_id uuid REFERENCES workspace_organizations(id), user_email text REFERENCES app_users(email),
    status text NOT NULL, PRIMARY KEY (organization_id,user_email)
  );
  CREATE TABLE pipeline_space_members (pipeline_id uuid, user_email text);
  CREATE TABLE user_maton_connections (
    owner_email text, connection_id text, account_email text,
    app text, status text, source text, is_selected boolean
  );
  CREATE TABLE organization_communication_bindings (
    credential_owner_email text, maton_connection_id text, account_email text,
    identity_email text, app text, status text, verified_at timestamptz
  );
  CREATE TABLE crm_organizations (
    id uuid PRIMARY KEY, pipeline_id uuid REFERENCES pipeline_spaces(id),
    name text, suitecrm_id text, reference_code text, source_key text,
    email text, source_payload jsonb DEFAULT '{}', UNIQUE (pipeline_id,id)
  );
  CREATE TABLE crm_contacts (
    id uuid PRIMARY KEY, pipeline_id uuid REFERENCES pipeline_spaces(id),
    organization_id uuid, full_name text, email text, suitecrm_id text,
    reference_code text, source_key text, source_payload jsonb DEFAULT '{}',
    UNIQUE (pipeline_id,id), FOREIGN KEY (pipeline_id,organization_id)
      REFERENCES crm_organizations(pipeline_id,id)
  );
  CREATE TABLE crm_leads (LIKE crm_contacts INCLUDING ALL);
  CREATE TABLE quickbooks_crm_links (
    organization_id uuid, pipeline_id uuid, provider_entity_type text,
    provider_entity_id text, crm_entity_type text, crm_record_id uuid
  );
  CREATE TABLE crm_products (id uuid, pipeline_id uuid, reference_code text);
  CREATE TABLE crm_product_identity_aliases (pipeline_id uuid, alias_product_id uuid, canonical_product_id uuid);
  CREATE TABLE crm_reference_registry (reference_code text, canonical_code text);
  CREATE TABLE crm_reference_aliases (alias_code text, canonical_code text);
  CREATE TABLE crm_opportunities (id uuid, pipeline_id uuid, organization_id uuid, suitecrm_id text);
  CREATE TABLE crm_meetings (id uuid, pipeline_id uuid, organization_id uuid);
  CREATE SEQUENCE fixture_crm_reference;
  CREATE FUNCTION allocate_crm_reference(prefix text) RETURNS text LANGUAGE SQL AS
    $$ SELECT prefix || lpad(nextval('fixture_crm_reference')::text,7,'0') $$;
  CREATE TABLE crm_interactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid REFERENCES pipeline_spaces(id),
    organization_id uuid, contact_id uuid, lead_id uuid, opportunity_id uuid, meeting_id uuid, campaign_id uuid,
    suitecrm_id text, source_key text, reference_code text, source_sheet_id text, source_row_number integer,
    interaction_type text, suitecrm_module text, activity_status text, duration_minutes integer,
    subject text, agent_email text, agent_name text, occurred_at timestamptz, description text, direction text,
    delivery_status text, provider_message_id text, provider_thread_id text, metadata jsonb,
    source_payload jsonb DEFAULT '{}', source_hash text, sync_status text, sync_error text,
    created_by text, updated_by text, updated_at timestamptz DEFAULT now(), suitecrm_synced_at timestamptz,
    UNIQUE (pipeline_id,source_key), UNIQUE (pipeline_id,id),
    FOREIGN KEY (pipeline_id,organization_id) REFERENCES crm_organizations(pipeline_id,id),
    FOREIGN KEY (pipeline_id,contact_id) REFERENCES crm_contacts(pipeline_id,id),
    FOREIGN KEY (pipeline_id,lead_id) REFERENCES crm_leads(pipeline_id,id)
  );
  CREATE TABLE crm_interaction_contacts (
    pipeline_id uuid, interaction_id uuid, contact_id uuid, is_primary boolean, sort_order integer,
    created_by text, updated_at timestamptz,
    PRIMARY KEY (interaction_id,contact_id),
    FOREIGN KEY (pipeline_id,interaction_id) REFERENCES crm_interactions(pipeline_id,id),
    FOREIGN KEY (pipeline_id,contact_id) REFERENCES crm_contacts(pipeline_id,id)
  );
  CREATE TABLE crm_inbound_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_email text REFERENCES app_users(email),
    pipeline_id uuid REFERENCES pipeline_spaces(id), external_message_id text, external_thread_id text,
    sender_email text, recipient_emails text[], subject text, received_at timestamptz,
    snippet text, body_text text, marker_references text[], raw_metadata jsonb, created_at timestamptz,
    interaction_id uuid REFERENCES crm_interactions(id), organization_id uuid, contact_id uuid, lead_id uuid,
    UNIQUE (owner_email,external_message_id)
  );
  CREATE TABLE crm_inbound_message_links (
    inbound_message_id uuid REFERENCES crm_inbound_messages(id), reference_code text,
    aggregate_type text, aggregate_id uuid, interaction_id uuid REFERENCES crm_interactions(id),
    created_at timestamptz, PRIMARY KEY (inbound_message_id,reference_code)
  );
`

async function run(pool) {
  const query = (text, values) => pool.query(text, values)
  const withTransaction = async callback => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
  const persistence = loadCrmPersistence(query, withTransaction)
  const recoveryAudits = []
  let beforeReferenceRead
  const addressHeaders = loadModule('app_src/lib/crm/emailAddressHeaders.ts')
  const ingestion = loadModule('app_src/lib/crm/emailIngestion.ts', {
    '@/lib/htmlEntities.mjs': { decodeHtmlEntities },
    '@/lib/globalIds.mjs': { globalIdFragment },
    '@/lib/crm/emailAddressHeaders': addressHeaders,
    '@/lib/crm/participantEligibility': loadModule('app_src/lib/crm/participantEligibility.ts'),
    '@/lib/persistence/crm': { ...persistence, readCrmRecordByReference: async input => {
      await beforeReferenceRead?.()
      return persistence.readCrmRecordByReference(input)
    } },
    '@/lib/persistence/postgres': { query },
    '@/lib/tenancy': { resolvePipelineSpaceAccess: () => unexpected('tenancy fallback') },
    '@/lib/auditWriter': { recordAuditEvent: async (entry) => { recoveryAudits.push(entry) } },
    '@/lib/maton': { matonFetch: async (path, request, scope) => {
      assert.equal(request.method, 'GET', 'Integration test may never send email')
      assert.equal(scope.ownerEmail, OWNER)
      assert.equal(scope.boundConnectionId, CONNECTION)
      const match = path.match(/^\/google-mail\/gmail\/v1\/users\/me\/messages\/([a-f0-9]+)\?format=full$/u)
      assert.ok(match, 'Only exact synthetic message fetches are allowed, not mailbox listing')
      const message = providerMessages.get(match[1])
      assert.ok(message, 'No unknown provider message can be fetched')
      providerCalls.push(match[1])
      return Response.json(message)
    } },
  }, 'export { ownedPipelines, configuredMailboxAddresses, selectedMailboxes, getGmailMessage, referenceTargets, processMessage };')

  await query(fixtureSchema)
  await query(read('db/migrations/0374_crm_interaction_organizations.sql'))
  await query(`INSERT INTO app_users VALUES ($1,'active','Synthetic Operator',NULL,true,'gu1234567'),
    ($2,'active','Synthetic Other',NULL,true,'gu7654321')`, [OWNER, OTHER_OWNER])
  for (const [index, pipeline] of [PRIMARY, BUSINESS, FOREIGN, DISABLED_MEMBERSHIP, DISABLED_REFERENCES].entries()) {
    const workspace = id(11 + index)
    const owner = pipeline === FOREIGN ? OTHER_OWNER : OWNER
    await query('INSERT INTO workspace_organizations VALUES ($1,true)', [workspace])
    await query(`INSERT INTO pipeline_spaces (id,owner_email,workspace_organization_id,is_default,reference_access_disabled)
      VALUES ($1,$2,$3,$4,$5)`, [pipeline, owner, workspace, pipeline === PRIMARY, pipeline === DISABLED_REFERENCES])
    await query('INSERT INTO app_user_organization_memberships VALUES ($1,$2,$3)',
      [workspace, owner, pipeline === DISABLED_MEMBERSHIP ? 'disabled' : 'active'])
  }
  await query(`INSERT INTO user_maton_connections VALUES ($1,$2,$3,'google-mail','ACTIVE','maton',true)`,
    [OWNER, CONNECTION, MAILBOX])
  await query(`INSERT INTO organization_communication_bindings VALUES
    ($1,$2,$3,$4,'google-mail','active',now()),
    ($1,'other-connection',$3,'unrelated-alias@example.test','google-mail','active',now()),
    ($1,$2,$3,'unverified@example.test','google-mail','active',NULL)`, [OWNER, CONNECTION, MAILBOX, ALIAS])
  await query(`INSERT INTO crm_organizations (id,pipeline_id,name,reference_code,source_key)
    VALUES ($1,$2,'Primary customer','ga1234567','primary-customer'),
    ($3,$4,'Business customer','ga2345678','business-customer')`,
  [CUSTOMER_PRIMARY, PRIMARY, CUSTOMER_BUSINESS, BUSINESS])
  const insertRecord = async (entity, recordId, pipeline, reference, email, organization = null, archived = false) => {
    assert.ok(['crm_contacts', 'crm_leads'].includes(entity))
    await query(`INSERT INTO ${entity}
      (id,pipeline_id,organization_id,full_name,email,reference_code,source_key,source_payload)
      VALUES ($1,$2,$3,'Synthetic customer',$4,$5,$5,$6::jsonb)`,
    [recordId, pipeline, organization, email, reference, JSON.stringify({ archived })])
  }
  await insertRecord('crm_contacts', CONTACT_PRIMARY, PRIMARY, 'gc1234567', 'primary-contact@customer.example.test', CUSTOMER_PRIMARY)
  await insertRecord('crm_contacts', CONTACT_BUSINESS, BUSINESS, 'gc2345678', 'business-contact@customer.example.test', CUSTOMER_BUSINESS)
  await insertRecord('crm_leads', LEAD_BUSINESS, BUSINESS, 'gl3456789', 'business-lead@customer.example.test', CUSTOMER_BUSINESS)
  await insertRecord('crm_contacts', id(40), FOREIGN, 'gc4567890', 'business-contact@customer.example.test')
  await insertRecord('crm_contacts', id(41), DISABLED_MEMBERSHIP, 'gc4567891', 'business-contact@customer.example.test')
  await insertRecord('crm_contacts', id(42), DISABLED_REFERENCES, 'gc4567892', 'business-contact@customer.example.test')
  await insertRecord('crm_contacts', id(43), PRIMARY, 'gc4567893', ALIAS, CUSTOMER_PRIMARY)
  await insertRecord('crm_contacts', id(44), BUSINESS, 'gc4567894', 'business-contact@customer.example.test', CUSTOMER_BUSINESS, true)
  await insertRecord('crm_leads', id(45), BUSINESS, 'gl4567895', 'business-contact@customer.example.test', CUSTOMER_BUSINESS, '1')
  await insertRecord('crm_contacts', id(46), PRIMARY, 'gc4567896', 'business-contact@customer.example.test', CUSTOMER_PRIMARY, 'YES')
  await insertRecord('crm_contacts', id(47), BUSINESS, 'gc4567897', 'archived-only@example.test', CUSTOMER_BUSINESS, true)
  await insertRecord('crm_contacts', id(48), FOREIGN, 'gc4567898', 'foreign-only@example.test')

  let passed = 0
  const check = async (name, callback) => { await callback(); passed += 1; console.log(`ok ${passed} - ${name}`) }
  const messageInput = async (messageId, overrides = {}, defaultPipelineId = PRIMARY) => {
    gmailMessage(messageId, overrides)
    return {
      ownerEmail: OWNER, mailboxEmail: MAILBOX, defaultPipelineId,
      ownedPipelines: await ingestion.ownedPipelines(OWNER, defaultPipelineId),
      selfAddresses: await ingestion.configuredMailboxAddresses(mailbox),
      message: ingestion.parseGmailMessage(await ingestion.getGmailMessage(mailbox, messageId)),
    }
  }
  const process = async (messageId, overrides, pipeline) => ingestion.processMessage(await messageInput(messageId, overrides, pipeline))
  const count = async table => Number((await query(`SELECT count(*) FROM ${table}`)).rows[0].count)
  const linksFor = async messageId => (await query(`SELECT link.reference_code,link.interaction_id::text
    FROM crm_inbound_message_links link JOIN crm_inbound_messages message ON message.id=link.inbound_message_id
    WHERE message.owner_email=$1 AND message.external_message_id=$2 ORDER BY link.reference_code`, [OWNER, messageId])).rows
  const stageSent = (messageId, pipeline = BUSINESS, thread = null, fields = {}) => persistence.stageCrmRecordInPostgres({
    entity: 'interactions', pipelineId: pipeline, actorEmail: OWNER, sourceKey: `synthetic-sent:${messageId}:${randomUUID()}`,
    fields: { interactionType: 'email', subject: 'Synthetic sent mail', agentEmail: OWNER,
      occurredAt: '2026-09-17T12:00:00.000Z', direction: 'outbound', deliveryStatus: 'sent',
      providerMessageId: messageId, providerThreadId: thread, ...fields },
  })

  await check('real ownership SQL excludes foreign, disabled membership, and disabled-reference pipelines', async () => {
    assert.deepEqual(Array.from(await ingestion.ownedPipelines(OWNER, PRIMARY), row => row.id), [PRIMARY, BUSINESS])
    await assert.rejects(ingestion.ownedPipelines(OWNER, DISABLED_MEMBERSHIP), /unavailable/)
    await assert.rejects(ingestion.ownedPipelines(OWNER, DISABLED_REFERENCES), /unavailable/)
    const selected = await ingestion.selectedMailboxes()
    assert.equal(selected.length, 1)
    assert.equal(selected[0].connection_id, CONNECTION)
    assert.deepEqual(Array.from(await ingestion.configuredMailboxAddresses(mailbox)), [MAILBOX, ALIAS])
  })
  await check('received mail reaches the matching second owned pipeline using real CRM staging and links', async () => {
    const result = await process('a1')
    assert.equal(result.interactions, 1)
    assert.equal(result.links, 1)
    const row = (await query('SELECT * FROM crm_interactions WHERE provider_message_id=$1', ['a1'])).rows[0]
    assert.equal(row.pipeline_id, BUSINESS)
    assert.equal(row.organization_id, CUSTOMER_BUSINESS)
    assert.equal(row.contact_id, CONTACT_BUSINESS)
    assert.equal(row.direction, 'inbound')
    assert.equal(row.description, 'Synthetic customer correspondence.')
    assert.equal(row.suitecrm_module, 'Emails')
    assert.equal((await linksFor('a1'))[0].reference_code, 'gc2345678')
    assert.equal(await count('crm_interaction_contacts'), 1)
  })
  await check('same provider message replay is idempotent at cache, interaction, and relation tables', async () => {
    const before = await Promise.all(['crm_inbound_messages', 'crm_interactions', 'crm_inbound_message_links', 'crm_interaction_contacts'].map(count))
    const replay = await process('a1')
    assert.equal(replay.inserted, false)
    assert.equal(replay.interactions, 0)
    assert.equal(replay.links, 0)
    assert.deepEqual(await Promise.all(['crm_inbound_messages', 'crm_interactions', 'crm_inbound_message_links', 'crm_interaction_contacts'].map(count)), before)
  })
  await check('sent contact plus lead participants produce one interaction with both CRM references', async () => {
    const result = await process('a2', { from: ALIAS, to: 'business-contact@customer.example.test',
      cc: 'business-lead@customer.example.test', labels: ['SENT'] })
    assert.equal(result.interactions, 1)
    assert.equal(result.links, 2)
    const links = await linksFor('a2')
    assert.deepEqual(links.map(row => row.reference_code), ['gc2345678', 'gl3456789'])
    assert.equal(new Set(links.map(row => row.interaction_id)).size, 1)
    const row = (await query('SELECT pipeline_id,direction,delivery_status FROM crm_interactions WHERE id=$1', [links[0].interaction_id])).rows[0]
    assert.deepEqual(row, { pipeline_id: BUSINESS, direction: 'outbound', delivery_status: 'sent' })
  })
  await check('lead-only mail stages a real lead relationship in its own pipeline', async () => {
    const result = await process('a3', { from: 'business-lead@customer.example.test' })
    assert.equal(result.interactions, 1)
    const row = (await query('SELECT lead_id,organization_id,contact_id FROM crm_interactions WHERE provider_message_id=$1', ['a3'])).rows[0]
    assert.deepEqual(row, { lead_id: LEAD_BUSINESS, organization_id: CUSTOMER_BUSINESS, contact_id: null })
  })
  await check('a primary-pipeline customer still routes there; unrelated alias contacts cannot steal outbound mail', async () => {
    await process('a4', { from: ALIAS, to: 'primary-contact@customer.example.test', labels: ['SENT'] })
    assert.deepEqual((await linksFor('a4')).map(row => row.reference_code), ['gc1234567'])
    assert.equal((await query('SELECT pipeline_id FROM crm_interactions WHERE provider_message_id=$1', ['a4'])).rows[0].pipeline_id, PRIMARY)
  })
  await check('archived-only and other-tenant contacts produce no CRM activity or links', async () => {
    const before = await count('crm_interactions')
    for (const [messageId, from] of [['a5', 'archived-only@example.test'], ['a6', 'foreign-only@example.test']]) {
      const result = await process(messageId, { from })
      assert.equal(result.unmatched, true)
      assert.equal(result.interactions, 0)
      assert.equal((await linksFor(messageId)).length, 0)
    }
    assert.equal(await count('crm_interactions'), before)
  })
  await check('real SQL refuses ambiguity across two owned pipelines or duplicate active contacts', async () => {
    await insertRecord('crm_contacts', id(50), PRIMARY, 'gc5678901', 'business-contact@customer.example.test', CUSTOMER_PRIMARY)
    assert.equal((await process('a7')).unmatched, true)
    await query('DELETE FROM crm_contacts WHERE id=$1', [id(50)])
    await insertRecord('crm_contacts', id(51), BUSINESS, 'gc5678902', 'business-contact@customer.example.test', CUSTOMER_BUSINESS)
    assert.equal((await process('a8')).unmatched, true)
    await query('DELETE FROM crm_contacts WHERE id=$1', [id(51)])
    assert.equal((await linksFor('a7')).length + (await linksFor('a8')).length, 0)
  })
  await check('authoritative accounting-only mirrors cannot block the actual CRM conversation', async () => {
    const mirrorId = id(60)
    const payload = { provider: 'quickbooks', customerId: 'qb-customer-1', customer: { Id: 'qb-customer-1' } }
    await insertRecord('crm_contacts', mirrorId, PRIMARY, 'gc6789012', 'business-contact@customer.example.test', CUSTOMER_PRIMARY)
    // Contact identity normalization deliberately does not retain a QuickBooks
    // source-key prefix. The routing policy must use producer/link provenance.
    await query(`UPDATE crm_contacts SET source_key=$2,source_payload=$3::jsonb WHERE id=$1`,
      [mirrorId, 'contact:email:business-contact@customer.example.test', JSON.stringify(payload)])
    await query(`INSERT INTO quickbooks_crm_links VALUES ($1,$2,'customer',$3,'contact',$4)`,
      [id(11), PRIMARY, payload.customerId, mirrorId])
    const received = await process('af')
    assert.equal(received.interactions, 1)
    assert.deepEqual((await linksFor('af')).map(row => row.reference_code), ['gc2345678'])
    const sent = await process('b0', { from: ALIAS, to: 'business-contact@customer.example.test', labels: ['SENT'] })
    assert.equal(sent.interactions, 1)
    assert.equal((await query('SELECT pipeline_id FROM crm_interactions WHERE provider_message_id=$1', ['b0'])).rows[0].pipeline_id, BUSINESS)

    for (const [messageId, changed] of [
      ['b1', { ...payload, source: 'clawpilot' }],
      ['b2', { ...payload, source: 'suitecrm' }],
      ['b3', { ...payload, reviewedBy: OWNER }],
      ['b4', { ...payload, customer: { Id: 'different-customer' } }],
    ]) {
      await query('UPDATE crm_contacts SET source_payload=$2::jsonb WHERE id=$1', [mirrorId, JSON.stringify(changed)])
      assert.equal((await process(messageId)).unmatched, true, 'Adopted or uncertain accounting provenance must remain real CRM ambiguity')
      assert.equal((await linksFor(messageId)).length, 0)
    }
    await query('UPDATE crm_contacts SET source_payload=$2::jsonb WHERE id=$1', [mirrorId, JSON.stringify(payload)])
    await query('DELETE FROM quickbooks_crm_links WHERE crm_record_id=$1', [mirrorId])
    assert.equal((await process('b5')).unmatched, true, 'A provider-shaped payload without authoritative linkage is not a confirmed mirror')
    await query(`INSERT INTO quickbooks_crm_links VALUES ($1,$2,'customer',$3,'contact',$4)`,
      [id(12), PRIMARY, payload.customerId, mirrorId])
    assert.equal((await process('b6')).unmatched, true, 'A link in another workspace cannot authorize mirror suppression')
    await query('DELETE FROM quickbooks_crm_links WHERE crm_record_id=$1', [mirrorId])
    await query('DELETE FROM crm_contacts WHERE id=$1', [mirrorId])
  })
  await check('standalone QuickBooks contacts remain eligible without an independent CRM replacement', async () => {
    const mirrorId = id(61)
    const payload = { provider: 'quickbooks', customerId: 'qb-customer-2', customer: { Id: 'qb-customer-2' } }
    await insertRecord('crm_contacts', mirrorId, PRIMARY, 'gc6789013', 'standalone-accounting@example.test', CUSTOMER_PRIMARY)
    await query('UPDATE crm_contacts SET source_payload=$2::jsonb WHERE id=$1', [mirrorId, JSON.stringify(payload)])
    await query(`INSERT INTO quickbooks_crm_links VALUES ($1,$2,'customer',$3,'contact',$4)`,
      [id(11), PRIMARY, payload.customerId, mirrorId])
    assert.equal((await process('b7', { from: 'standalone-accounting@example.test' })).interactions, 1)
    assert.deepEqual((await linksFor('b7')).map(row => row.reference_code), ['gc6789013'])
  })
  await check('legacy null-thread exact provider message is reused without duplicating the sent interaction', async () => {
    const staged = await stageSent('a9')
    const before = await count('crm_interactions')
    const result = await process('a9', { from: ALIAS, to: 'business-contact@customer.example.test', labels: ['SENT'] })
    assert.equal(result.interactions, 0)
    assert.equal(result.links, 1)
    assert.equal((await linksFor('a9'))[0].interaction_id, staged.id)
    assert.equal(await count('crm_interactions'), before)
    assert.equal((await process('a9', { from: ALIAS, to: 'business-contact@customer.example.test', labels: ['SENT'] })).links, 0)
  })
  await check('late same-account contacts enrich native relationships once without replacing the original sent email', async () => {
    const lateContact = id(70)
    const messageId = 'c1'
    const staged = await stageSent(messageId, BUSINESS, `thread-${messageId}`, {
      organizationId: CUSTOMER_BUSINESS, contactIds: [CONTACT_BUSINESS], leadId: LEAD_BUSINESS,
      occurredAt: '2026-09-17T12:00:00.123Z',
      description: 'Preserve authored sent body', metadata: { source: 'app-send', retained: true },
    })
    const options = { from: ALIAS, to: 'business-contact@customer.example.test', cc: 'late-contact@example.test', labels: ['SENT'] }
    await process(messageId, options)
    const readRetained = async () => (await query(`SELECT id,suitecrm_id,reference_code,source_key,
      source_sheet_id,source_row_number,subject,description,occurred_at,direction,delivery_status,
      provider_message_id,provider_thread_id,metadata,source_payload,lead_id,created_by
      FROM crm_interactions WHERE id=$1`, [staged.id])).rows[0]
    const original = await readRetained()
    await insertRecord('crm_contacts', lateContact, BUSINESS, 'gc7890123', 'late-contact@example.test', CUSTOMER_BUSINESS)
    const before = await count('crm_interactions')
    const result = await process(messageId, options)
    assert.equal(result.interactions, 0)
    assert.equal(result.links, 1)
    assert.equal(await count('crm_interactions'), before)
    assert.deepEqual(await readRetained(), original)
    const relationships = (await query(`SELECT contact_id::text,is_primary FROM crm_interaction_contacts
      WHERE interaction_id=$1 ORDER BY sort_order`, [staged.id])).rows
    assert.deepEqual(relationships, [{ contact_id: CONTACT_BUSINESS, is_primary: true }, { contact_id: lateContact, is_primary: false }])
    const snapshot = (await query('SELECT source_hash,updated_at FROM crm_interactions WHERE id=$1', [staged.id])).rows[0]
    const replay = await process(messageId, options)
    assert.equal(replay.interactions, 0)
    assert.equal(replay.links, 0)
    assert.deepEqual((await query('SELECT source_hash,updated_at FROM crm_interactions WHERE id=$1', [staged.id])).rows[0], snapshot,
      'Unchanged replay must not restage the email or enqueue another projection')
  })
  await check('locked enrichment rejects stale target email, wrong owner/workspace and archived customer evidence', async () => {
    const staged = await stageSent('c2')
    const selection = { pipelineId: BUSINESS, interactionId: staged.id, ownerEmail: OWNER,
      providerMessageId: 'c2', providerThreadId: 'thread-c2', apply: true,
      targets: [{ id: CONTACT_BUSINESS, entity: 'contacts', referenceCode: 'gc2345678',
        organizationId: CUSTOMER_BUSINESS, email: 'business-contact@customer.example.test' }] }
    const snapshot = (await query('SELECT * FROM crm_interactions WHERE id=$1', [staged.id])).rows[0]
    await query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [CONTACT_BUSINESS, 'changed-after-routing@example.test'])
    await assert.rejects(persistence.enrichCrmEmailInteractionParticipantsInPostgres(selection), /conflicting CRM participant evidence/)
    await query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [CONTACT_BUSINESS, 'business-contact@customer.example.test'])
    for (const override of [{ ownerEmail: OTHER_OWNER }, { pipelineId: PRIMARY }]) {
      await assert.rejects(persistence.enrichCrmEmailInteractionParticipantsInPostgres({ ...selection, ...override }), /conflicting CRM participant evidence/)
    }
    await query(`UPDATE crm_organizations SET source_payload='{"archived":true}'::jsonb WHERE id=$1`, [CUSTOMER_BUSINESS])
    await assert.rejects(persistence.enrichCrmEmailInteractionParticipantsInPostgres(selection), /conflicting CRM participant evidence/)
    await query(`UPDATE crm_organizations SET source_payload='{}'::jsonb WHERE id=$1`, [CUSTOMER_BUSINESS])
    assert.deepEqual((await query('SELECT * FROM crm_interactions WHERE id=$1', [staged.id])).rows[0], snapshot)
    assert.equal((await query('SELECT count(*) FROM crm_interaction_contacts WHERE interaction_id=$1', [staged.id])).rows[0].count, '0')
  })
  await check('participant lookup retains its positive email proof across the later reference read', async () => {
    beforeReferenceRead = async () => {
      beforeReferenceRead = undefined
      await query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [CONTACT_BUSINESS, 'changed-before-reference-read@example.test'])
    }
    const result = await process('c6')
    assert.equal(result.unmatched, true)
    assert.equal(result.interactions, 0)
    assert.equal((await linksFor('c6')).length, 0)
    await query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [CONTACT_BUSINESS, 'business-contact@customer.example.test'])
  })
  await check('native enrichment preserves unset, renamed and inactive historic agent assignments', async () => {
    for (const [messageId, email, name] of [
      ['c7', null, 'Synthetic Operator'], ['c8', OWNER, 'Original display name'],
      ['c9', OTHER_OWNER, 'Inactive historic agent'],
    ]) {
      const staged = await stageSent(messageId)
      await query('UPDATE crm_interactions SET agent_email=$2,agent_name=$3 WHERE id=$1', [staged.id, email, name])
      if (messageId === 'c9') await query("UPDATE app_users SET status='disabled' WHERE email=$1", [OTHER_OWNER])
      const result = await process(messageId)
      assert.equal(result.interactions, 0)
      assert.deepEqual((await query('SELECT agent_email,agent_name FROM crm_interactions WHERE id=$1', [staged.id])).rows[0],
        { agent_email: email, agent_name: name })
      if (messageId === 'c9') await query("UPDATE app_users SET status='active' WHERE email=$1", [OTHER_OWNER])
    }
  })
  await check('archived emails and wrong-account native mappings cannot be revived or silently reparented', async () => {
    const otherAccount = id(23), otherContact = id(71)
    await query(`INSERT INTO crm_organizations (id,pipeline_id,name,reference_code,source_key)
      VALUES ($1,$2,'Synthetic partner','ga7890123','synthetic-partner')`, [otherAccount, BUSINESS])
    await insertRecord('crm_contacts', otherContact, BUSINESS, 'gc7890124', 'partner@example.test', otherAccount)
    const wrong = await stageSent('c3', BUSINESS, null, { organizationId: otherAccount, contactIds: [otherContact] })
    const archived = await stageSent('c4')
    await query(`UPDATE crm_interactions SET source_payload='{"archived":true}'::jsonb WHERE id=$1`, [archived.id])
    const before = await count('crm_interactions')
    for (const messageId of ['c3', 'c4']) {
      await assert.rejects(process(messageId), /conflicting CRM participant evidence/)
      assert.equal((await linksFor(messageId)).length, 0)
      assert.equal((await query('SELECT count(*) FROM crm_inbound_messages WHERE external_message_id=$1', [messageId])).rows[0].count, '0')
    }
    assert.equal(await count('crm_interactions'), before)
    assert.equal((await query('SELECT organization_id FROM crm_interactions WHERE id=$1', [wrong.id])).rows[0].organization_id, otherAccount)
    assert.equal((await query('SELECT source_payload FROM crm_interactions WHERE id=$1', [archived.id])).rows[0].source_payload.archived, true)
    const result = await process('c5', { cc: 'partner@example.test' })
    assert.equal(result.unmatched, true, 'Actual multi-account threads must continue to fail closed')
    await assert.rejects(ingestion.reconcileGmailMessages({ ownerEmail: OWNER, connectionId: CONNECTION,
      pipelineId: BUSINESS, messageIds: ['c5'] }), /ambiguous/)
    assert.equal((await linksFor('c5')).length, 0)
  })
  await check('same provider ID in another pipeline is not reused for a second-pipeline customer', async () => {
    const unrelated = await stageSent('aa', PRIMARY)
    const result = await process('aa')
    assert.equal(result.interactions, 1)
    assert.notEqual((await linksFor('aa'))[0].interaction_id, unrelated.id)
  })
  await check('conflicting thread and duplicate provider IDs fail closed without adding CRM activity', async () => {
    await stageSent('ab', BUSINESS, 'another-thread')
    await stageSent('ac')
    await stageSent('ac')
    const before = await count('crm_interactions')
    await assert.rejects(process('ab'), /conflicting CRM thread identity/)
    await assert.rejects(process('ac'), /ambiguous CRM interactions/)
    assert.equal(await count('crm_interactions'), before)
    assert.equal((await linksFor('ab')).length + (await linksFor('ac')).length, 0)
  })
  await check('disabled membership is re-read from PostgreSQL and immediately prevents new routing', async () => {
    await query("UPDATE app_user_organization_memberships SET status='disabled' WHERE user_email=$1 AND organization_id=$2", [OWNER, id(12)])
    assert.equal((await process('ad')).unmatched, true)
    assert.equal((await linksFor('ad')).length, 0)
    await query("UPDATE app_user_organization_memberships SET status='active' WHERE user_email=$1 AND organization_id=$2", [OWNER, id(12)])
    assert.equal((await process('ae')).interactions, 1)
  })

  const reviewedCompany = id(90), reviewedContact = id(91), extraContact = id(92)
  await query(`INSERT INTO crm_organizations (id,pipeline_id,name,reference_code,source_key)
    VALUES ($1,$2,'Synthetic reviewed company','ga9012345','reviewed-company')`, [reviewedCompany, BUSINESS])
  await insertRecord('crm_contacts', reviewedContact, BUSINESS, 'gc9012345', 'reviewed-partner@example.test', reviewedCompany)
  await insertRecord('crm_contacts', extraContact, BUSINESS, 'gc9012346', 'unselected-participant@example.test', reviewedCompany)
  const cacheReviewed = async (messageId, overrides = {}) => {
    const result = await process(messageId, { cc: 'reviewed-partner@example.test', threadId: `f${messageId}`, ...overrides })
    assert.equal(result.unmatched, true, 'Automatic cross-company routing must remain held')
    assert.equal((await linksFor(messageId)).length, 0)
  }
  const reviewedSelection = (messageIds, extra = {}) => ({
    ownerEmail: OWNER, connectionId: CONNECTION, pipelineId: BUSINESS, messageIds,
    reviewedAssociations: messageIds.map(messageId => ({ messageId, threadId: providerMessages.get(messageId).threadId,
      primaryOrganizationReference: 'ga9012345', contactReferences: ['gc2345678', 'gc9012345'] })),
    ...extra,
  })
  const recoveryCounts = () => Promise.all(['crm_interactions', 'crm_interaction_contacts',
    'crm_interaction_organizations', 'crm_inbound_message_links', 'crm_inbound_messages'].map(count))

  await check('reviewed mixed-company preview is read-only and apply uses one email with two exact company relationships', async () => {
    await cacheReviewed('d1', { cc: 'reviewed-partner@example.test, unselected-participant@example.test' })
    const before = await recoveryCounts(), selection = reviewedSelection(['d1'])
    const preview = await ingestion.reconcileGmailMessages(selection)
    assert.deepEqual(await recoveryCounts(), before)
    assert.equal(recoveryAudits.length, 0, 'Preview must not write an audit record')
    assert.deepEqual(Array.from(preview.messages[0].contactReferences), ['gc2345678', 'gc9012345'])
    const applied = await ingestion.reconcileGmailMessages({ ...selection, apply: true, expectedDigest: preview.digest })
    assert.equal(applied.interactions, 1)
    const rows = (await query('SELECT * FROM crm_interactions WHERE pipeline_id=$1 AND provider_message_id=$2', [BUSINESS, 'd1'])).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].organization_id, reviewedCompany)
    assert.equal(rows[0].contact_id, reviewedContact, 'Primary company must be represented by the primary contact')
    assert.equal(rows[0].provider_thread_id, 'fd1')
    assert.equal(rows[0].suitecrm_module, 'Emails')
    assert.deepEqual((await query(`SELECT organization_id::text FROM crm_interaction_organizations
      WHERE interaction_id=$1 ORDER BY sort_order`, [rows[0].id])).rows.map(row => row.organization_id), [reviewedCompany, CUSTOMER_BUSINESS])
    assert.deepEqual(new Set((await query('SELECT contact_id::text FROM crm_interaction_contacts WHERE interaction_id=$1',
      [rows[0].id])).rows.map(row => row.contact_id)), new Set([CONTACT_BUSINESS, reviewedContact]))
    assert.deepEqual((await linksFor('d1')).map(row => row.reference_code), ['ga2345678', 'ga9012345', 'gc2345678', 'gc9012345'])
    assert.equal((await query('SELECT count(*) FROM crm_interaction_contacts WHERE interaction_id=$1 AND contact_id=$2',
      [rows[0].id, extraContact])).rows[0].count, '0', 'Unselected actual participants must not become associations')
    const cache = (await query('SELECT pipeline_id,id::text FROM crm_inbound_messages WHERE external_message_id=$1', ['d1'])).rows[0]
    assert.equal(cache.pipeline_id, PRIMARY, 'Owned default cache is not reparented to the reviewed target pipeline')
    assert.equal(rows[0].metadata.inboundMessageId, cache.id)
    const identities = [rows[0].id, rows[0].suitecrm_id, rows[0].source_key, rows[0].reference_code]
    const after = await recoveryCounts()
    const replay = await ingestion.reconcileGmailMessages({ ...selection, apply: true, expectedDigest: preview.digest })
    assert.equal(replay.interactions, 0)
    assert.equal(replay.links, 0)
    assert.deepEqual(await recoveryCounts(), after)
    const current = (await query('SELECT * FROM crm_interactions WHERE id=$1', [rows[0].id])).rows[0]
    assert.deepEqual([current.id, current.suitecrm_id, current.source_key, current.reference_code], identities)
    assert.equal(recoveryAudits.length, 2, 'Synthetic audit captures requested applies without external delivery')
  })

  await check('reviewed recovery rejects uncached, unknown, duplicate-email, foreign and unrepresented-primary associations', async () => {
    gmailMessage('d2', { cc: 'reviewed-partner@example.test', threadId: 'fd2' })
    const uncached = reviewedSelection(['d2'])
    const before = await recoveryCounts()
    await assert.rejects(ingestion.reconcileGmailMessages(uncached), /existing owned cached/)
    await cacheReviewed('d3')
    const base = reviewedSelection(['d3'])
    for (const association of [
      { ...base.reviewedAssociations[0], contactReferences: ['gc2345678', 'gc9999999'] },
      { ...base.reviewedAssociations[0], contactReferences: ['gc2345678'] },
      { ...base.reviewedAssociations[0], contactReferences: ['gc2345678', 'gc4567890'] },
      { ...base.reviewedAssociations[0], threadId: 'other-thread' },
    ]) await assert.rejects(ingestion.reconcileGmailMessages({ ...base, reviewedAssociations: [association] }))
    await insertRecord('crm_contacts', id(93), BUSINESS, 'gc9012347', 'reviewed-partner@example.test', reviewedCompany)
    await assert.rejects(ingestion.reconcileGmailMessages(base), /unambiguous/)
    await query('DELETE FROM crm_contacts WHERE id=$1', [id(93)])
    assert.equal((await linksFor('d3')).length, 0)
    assert.deepEqual((await recoveryCounts()).slice(0, 4), before.slice(0, 4))
  })

  await check('reviewed preview digest rejects current provider, contact, account, membership and connection drift before writes', async () => {
    await cacheReviewed('d4')
    const selection = reviewedSelection(['d4'])
    const variants = [
      [async () => { providerMessages.get('d4').payload.headers.push({ name: 'X-Synthetic-Review', value: 'changed' }) },
        async () => { providerMessages.get('d4').payload.headers.pop() }],
      [async () => { providerMessages.get('d4').payload.body.data = Buffer.from('Changed provider body').toString('base64url') },
        async () => { providerMessages.get('d4').payload.body.data = Buffer.from('Synthetic customer correspondence.').toString('base64url') }],
      [() => query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [reviewedContact, 'changed@example.test']),
        () => query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [reviewedContact, 'reviewed-partner@example.test'])],
      [() => query('UPDATE crm_contacts SET organization_id=$2 WHERE id=$1', [reviewedContact, CUSTOMER_BUSINESS]),
        () => query('UPDATE crm_contacts SET organization_id=$2 WHERE id=$1', [reviewedContact, reviewedCompany])],
      [() => query("UPDATE app_user_organization_memberships SET status='disabled' WHERE user_email=$1 AND organization_id=$2", [OWNER, id(12)]),
        () => query("UPDATE app_user_organization_memberships SET status='active' WHERE user_email=$1 AND organization_id=$2", [OWNER, id(12)])],
      [() => query('UPDATE user_maton_connections SET is_selected=false WHERE connection_id=$1', [CONNECTION]),
        () => query('UPDATE user_maton_connections SET is_selected=true WHERE connection_id=$1', [CONNECTION])],
      [() => query('UPDATE pipeline_spaces SET workspace_organization_id=$2 WHERE id=$1', [BUSINESS, id(11)]),
        () => query('UPDATE pipeline_spaces SET workspace_organization_id=$2 WHERE id=$1', [BUSINESS, id(12)])],
    ]
    for (const [change, restore] of variants) {
      const preview = await ingestion.reconcileGmailMessages(selection)
      const before = await recoveryCounts(), audits = recoveryAudits.length
      await change()
      try {
        await assert.rejects(ingestion.reconcileGmailMessages({ ...selection, apply: true, expectedDigest: preview.digest }))
        assert.deepEqual(await recoveryCounts(), before)
        assert.equal(recoveryAudits.length, audits)
      } finally { await restore() }
    }
  })

  await check('reviewed helper refuses duplicate provider IDs and rolls back a batch when any fingerprint is stale', async () => {
    await cacheReviewed('d5')
    const duplicateA = await stageSent('d5'), duplicateB = await stageSent('d5')
    await assert.rejects(ingestion.reconcileGmailMessages(reviewedSelection(['d5'])), /evidence/)
    await query('DELETE FROM crm_interactions WHERE id=ANY($1::uuid[])', [[duplicateA.id, duplicateB.id]])
    for (const messageId of ['d6', 'd7']) await cacheReviewed(messageId)
    const entries = ['d6', 'd7'].map(providerMessageId => ({
      ownerEmail: OWNER, pipelineId: BUSINESS, connectionId: CONNECTION, providerMessageId,
      providerThreadId: `f${providerMessageId}`, participantEmails: ['business-contact@customer.example.test', 'reviewed-partner@example.test'],
      primaryOrganization: { id: reviewedCompany, referenceCode: 'ga9012345' },
      contactTargets: [
        { id: CONTACT_BUSINESS, referenceCode: 'gc2345678', email: 'business-contact@customer.example.test', organizationId: CUSTOMER_BUSINESS },
        { id: reviewedContact, referenceCode: 'gc9012345', email: 'reviewed-partner@example.test', organizationId: reviewedCompany },
      ],
      interaction: { entity: 'interactions', pipelineId: BUSINESS, actorEmail: OWNER, sourceKey: `synthetic-reviewed:${providerMessageId}`,
        fields: { interactionType: 'email', subject: 'Synthetic reviewed email', providerMessageId, providerThreadId: `f${providerMessageId}` } },
    }))
    const previews = await persistence.stageReviewedGmailInteractionsInPostgres({ messages: entries })
    const before = await recoveryCounts()
    await assert.rejects(persistence.stageReviewedGmailInteractionsInPostgres({ messages: entries.map((entry, index) => ({
      ...entry, expectedExistingInteractionId: previews[index].interactionId,
      expectedTargetFingerprint: index === 1 ? 'stale-fingerprint' : previews[index].targetFingerprint,
    })), apply: true }), /evidence/)
    assert.deepEqual(await recoveryCounts(), before, 'No first-message stage may escape a rejected later fingerprint')
    assert.equal((await linksFor('d6')).length + (await linksFor('d7')).length, 0)
  })
  assert.ok(providerCalls.length > 0)
  assert.equal((await query(`SELECT count(*) FROM crm_interactions WHERE pipeline_id IN ($1,$2,$3)`,
    [FOREIGN, DISABLED_MEMBERSHIP, DISABLED_REFERENCES])).rows[0].count, '0')
  console.log(`PASS: ${passed} PostgreSQL email routing checks; production routing/staging/link SQL, synthetic Gmail only`)
}

const container = `clawpilot-email-routing-test-${process.pid}-${randomUUID().slice(0, 8)}`
let started = false
let pool
try {
  if (nativeSocket) {
    pool = new Pool({ host: nativeSocket, port: 55473, user: process.env.USER, password: '',
      database: 'email_routing_test', ssl: false, max: 2, connectionTimeoutMillis: 1000, statement_timeout: 5000 })
    assert.equal((await pool.query(`SELECT count(*) FROM pg_tables WHERE schemaname='public'`)).rows[0].count,
      '0', 'Native email_routing_test fixture must be empty before use')
  } else {
    execFileSync('docker', disposablePostgresDockerArgs([
      'run', '--rm', '-d', '--name', container, '--pull', 'never',
      '-e', 'POSTGRES_PASSWORD=email_routing_test', '-e', 'POSTGRES_DB=email_routing_test',
      '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16',
    ], {
      environment: {
        ...process.env,
        CLAWPILOT_TEST_POSTGRES_MEMORY: '512m',
        CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE: '256m',
        CLAWPILOT_TEST_POSTGRES_CPUS: '1',
      },
    }), { timeout: 60_000, stdio: 'pipe' })
    started = true
    const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 10_000 })
      .match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
    assert.ok(port, 'Disposable PostgreSQL must only bind to loopback')
    pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'email_routing_test',
      database: 'email_routing_test', ssl: false, max: 2, connectionTimeoutMillis: 1000, statement_timeout: 5000 })
    const deadline = Date.now() + 30_000
    while (true) {
      try { await pool.query('SELECT 1'); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
  await run(pool)
} finally {
  try { if (pool) await pool.end() } finally {
    if (started) execFileSync('docker', disposablePostgresDockerCleanupArgs(container), { timeout: 30_000, stdio: 'pipe' })
  }
}
