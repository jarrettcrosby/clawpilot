#!/usr/bin/env node
'use strict'

// Exact-scope metadata inspection only. No application imports, HTTP/provider
// calls, login, row locks, mail bodies/subjects, recovery, or publication. The
// output is a stale-able observation, NEVER a recovery digest or approval.
const crypto = require('node:crypto')
const tls = require('node:tls')
// Observed through authenticated SSH to the exact production Postgres service,
// not obtained from the unverified database connection. Refuse silent rotation.
const REVIEWED_POSTGRES_LEAF = '41:16:8E:D7:A8:76:AD:39:A9:F6:D1:CB:48:61:F4:BD:6A:C6:B4:6F:FA:52:34:46:2E:70:F1:D0:B3:94:B8:FE'
const SCOPE = Object.freeze({
  projectId: 'b5169ebd-8166-4b96-9a81-7cc8adaa9270',
  environmentId: '058ce52f-1d3b-44bb-afe2-0df2bf24efb9',
  workspaceId: 'c6c49765-9bf6-4223-9261-7553499f5d92',
  pipelineId: '587c8746-ecf6-40ae-8c50-e456f99ad555',
  ownerEmail: 'jarrett@suburbiasandwichco.com',
  connectionId: 'eb13a0fd-c0b2-4ad1-99b7-3bbda178a027',
  threadId: '1a179e9e2743f926',
  messageIds: Object.freeze(['1a17e730c78d319c', '1a17f5004f29592c', '1a17f5d46a224e0a',
    '1a18e03ea586cd7e', '1a18f01749eb87a6']),
  primaryOrganizationReference: 'gagmco24va588e',
  organizationReferences: Object.freeze(['gagmco24va588e', 'gajl1dq5i03jga']),
})
function validateReadOnlyPostgresTrust(value, expectedLeaf = REVIEWED_POSTGRES_LEAF) {
  const keys=['version','projectId','environmentId','service','caPem','leafPem']
  if (!value || typeof value!=='object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort())!==JSON.stringify(keys.sort())
    || value.version!==1 || value.projectId!==SCOPE.projectId || value.environmentId!==SCOPE.environmentId
    || value.service!=='Postgres' || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(expectedLeaf)
    || [value.caPem,value.leafPem].some(pem=>typeof pem!=='string'||pem.length>16000
      || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem))) throw new Error('READONLY_TLS_TRUST_INVALID')
  let root,leaf
  try {root=new crypto.X509Certificate(value.caPem);leaf=new crypto.X509Certificate(value.leafPem)}
  catch {throw new Error('READONLY_TLS_TRUST_INVALID')}
  const now=Date.now()
  if (!root.ca || leaf.ca || root.issuer!==root.subject || !root.verify(root.publicKey)
    || leaf.issuer!==root.subject || !leaf.verify(root.publicKey) || leaf.checkHost('localhost')!=='localhost'
    || [root,leaf].some(cert=>!Number.isFinite(Date.parse(cert.validFrom))||!Number.isFinite(Date.parse(cert.validTo))
      || Date.parse(cert.validFrom)>now || Date.parse(cert.validTo)<=now)) throw new Error('READONLY_TLS_TRUST_INVALID')
  if (leaf.fingerprint256!==expectedLeaf) throw new Error('READONLY_TLS_TRUST_CHANGED')
  return {caPem:value.caPem,leafFingerprint256:leaf.fingerprint256,rootFingerprint256:root.fingerprint256,serverName:'localhost'}
}

function readOnlyDatabaseConfig(env) {
  if (env.CLAWPILOT_BPO_READONLY_PUBLIC_ENDPOINT) throw new Error('INSECURE_DIAGNOSTIC_MODE_REMOVED')
  if (!env.CLAWPILOT_BPO_READONLY_TLS_TRUST) throw new Error('READONLY_TLS_TRUST_REQUIRED')
  let bundle
  try {if(env.CLAWPILOT_BPO_READONLY_TLS_TRUST.length>33000)throw Error();bundle=JSON.parse(env.CLAWPILOT_BPO_READONLY_TLS_TRUST)}
  catch {throw new Error('READONLY_TLS_TRUST_INVALID')}
  const trust=validateReadOnlyPostgresTrust(bundle)
  const endpoint=new URL(env.DATABASE_URL)
  if (!['postgres:','postgresql:'].includes(endpoint.protocol)||!endpoint.hostname.endsWith('.railway.internal')) throw new Error('EXACT_PRIVATE_ENDPOINT_REQUIRED')
  // pg's connection-string SSL options can replace an explicit ssl object.
  // Remove them and supply verified service-specific TLS independently.
  for (const key of [...endpoint.searchParams.keys()]) if (/^ssl/i.test(key)) endpoint.searchParams.delete(key)
  return {config:{connectionString:endpoint.toString(),connectionTimeoutMillis:5000,
    application_name:'bpo_exact_recovery_readonly',ssl:{ca:trust.caPem,rejectUnauthorized:true,servername:trust.serverName,
      checkServerIdentity(_host,cert){
        if(cert.fingerprint256!==trust.leafFingerprint256)return new Error('READONLY_TLS_PEER_MISMATCH')
        return tls.checkServerIdentity(trust.serverName,cert)
      }}},trust:{leafFingerprint256:trust.leafFingerprint256,rootFingerprint256:trust.rootFingerprint256,
      serverName:trust.serverName,source:'authenticated-exact-service-ssh'}}
}
const TABLES = ['pipeline_spaces', 'workspace_organizations', 'app_users', 'app_user_organization_memberships',
  'pipeline_space_members', 'user_maton_connections', 'crm_inbound_messages', 'crm_contacts', 'crm_leads',
  'crm_organizations', 'crm_interactions', 'crm_interaction_contacts', 'crm_inbound_message_links',
  'sync_outbox', 'quickbooks_crm_links', 'crm_email_mailboxes', 'crm_email_mailbox_bindings', 'crm_email_sources',
  'crm_interaction_organizations', 'crm_email_review_decisions', 'crm_native_email_publication_control',
  'crm_native_email_publication_admissions', 'crm_native_email_publication_work']
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalized = value => typeof value === 'string' ? value.trim().toLowerCase() : ''
const address = value => {
  const text = normalized(value)
  return text.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : ''
}
const active = alias => `COALESCE(lower(${alias}.source_payload->>'archived'),'false') NOT IN ('true','1','yes')`

// Snapshot counterpart of reviewedEmailAudienceUnderNativeControlWithClient.
// Unlike admission this deliberately takes no authority lock; a later exact
// transaction/native policy read MUST revalidate the entire audience.
function audienceSnapshot(scope, readers) {
  const holds = [], emails = new Set(), nativeIds = new Set(), effectiveReaders = [], observations = []
  if (scope.length !== 1 || scope[0].workspace_id !== SCOPE.workspaceId
    || scope[0].owner_email !== SCOPE.ownerEmail || scope[0].is_demo !== false) holds.push('target_scope_changed')
  if (!readers.length || readers.length > 500) holds.push('audience_count_invalid')
  for (const reader of readers) {
    const permissions = reader.membership_permissions
    const appOnly = reader.suitecrm_user_id === null && reader.native_identity_count === 0
    const identityValid = appOnly || typeof reader.suitecrm_user_id === 'string'
      && /^[a-z0-9][a-z0-9-]{0,35}(?![\s\S])/i.test(reader.suitecrm_user_id)
      && Number(reader.native_identity_count) === 1
    // Keep all intended members in this observation. Match the shared native
    // eligibility helper: explicit denial is not a missing identity, and an
    // inactive member must still have a complete, unambiguous preimage.
    const valid = typeof reader.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(reader.email)
      && reader.email === reader.email.toLowerCase()
      && ['active', 'invited', 'disabled'].includes(String(reader.status))
      && ['active', 'invited', 'disabled'].includes(String(reader.membership_status))
      && (reader.membership_trashed_at === null || typeof reader.membership_trashed_at === 'string'
        && Number.isFinite(Date.parse(reader.membership_trashed_at)))
      && identityValid
      && ['owner', 'admin', 'member'].includes(String(reader.membership_role))
      && permissions && typeof permissions === 'object' && !Array.isArray(permissions)
      && (permissions.viewCrm === undefined || typeof permissions.viewCrm === 'boolean')
    const eligible = Boolean(valid && !appOnly && reader.status === 'active' && reader.membership_status === 'active'
      && reader.membership_trashed_at === null && (reader.membership_role === 'owner' || permissions.viewCrm !== false))
    if (!valid || emails.has(reader.email) || reader.suitecrm_user_id !== null && nativeIds.has(reader.suitecrm_user_id)
      || (reader.email !== scope[0]?.owner_email && !['viewer', 'editor'].includes(reader.access_role || ''))) holds.push('ambiguous_or_malformed_pipeline_reader')
    emails.add(reader.email)
    if (reader.suitecrm_user_id !== null) nativeIds.add(reader.suitecrm_user_id)
    if (eligible) effectiveReaders.push(reader)
    observations.push({ email: reader.email, nativeId: reader.suitecrm_user_id,
      userStatus: reader.status, membershipStatus: reader.membership_status,
      membershipRole: reader.membership_role, membershipTrashedAt: reader.membership_trashed_at,
      pipelineAccess: reader.access_role, nativeIdentityCount: reader.native_identity_count,
      effectiveReader: eligible, eligibility: valid ? (appOnly ? 'app-only' : eligible ? 'eligible' : 'excluded') : 'unverified' })
  }
  const owner = effectiveReaders.find(reader => reader.email === scope[0]?.owner_email)
  if (!owner || owner.suitecrm_user_id !== scope[0]?.owner_native_id) holds.push('owner_native_identity_missing_or_ineligible')
  const audience = holds.length ? null : { policy: 'pipeline-internal', ownerSuiteCrmId: scope[0].owner_native_id,
    allowedSuiteCrmUserIds: effectiveReaders.map(row => row.suitecrm_user_id).sort(), workspaceId: SCOPE.workspaceId, pipelineId: SCOPE.pipelineId }
  return { holds: [...new Set(holds)], audience: audience && { ...audience, fingerprint: sha(audience) },
    readers: observations }
}

function messagePlan(message, candidates, companies) {
  const holds = []
  const headers = message.headers
  if (!headers || headers.version !== 1 || !Array.isArray(headers.from) || headers.from.length !== 1) holds.push('actual_header_evidence_missing')
  if (['from', 'to', 'cc', 'bcc'].some(kind => headers?.[kind] != null
    && (!Array.isArray(headers[kind]) || headers[kind].length > 100 || headers[kind].some(value => !address(value?.address))))) holds.push('invalid_header_addresses')
  const participants = [...new Set(['from', 'to', 'cc', 'bcc'].flatMap(kind =>
    Array.isArray(headers?.[kind]) ? headers[kind].map(value => address(value?.address)).filter(Boolean) : []))].sort()
  const matches = candidates.filter(row => participants.includes(row.email))
  const contacts = matches.filter(row => row.pipeline_id === SCOPE.pipelineId && row.entity === 'contacts')
  if (message.thread_id !== SCOPE.threadId || message.provider !== 'gmail' || !message.source_owner_active) holds.push('cached_identity_or_source_scope_changed')
  if (message.excluded_label === true) holds.push('excluded_gmail_label')
  if (!contacts.length || contacts.length > 25 || matches.length !== contacts.length
    || new Set(contacts.map(row => row.id)).size !== contacts.length
    || new Set(contacts.map(row => row.email)).size !== contacts.length) holds.push('participant_crm_mapping_ambiguous')
  const selectedCompanies = companies.filter(row => contacts.some(contact => contact.organization_id === row.id))
  if (contacts.some(contact => !selectedCompanies.some(company => company.id === contact.organization_id))
    || selectedCompanies.some(row => row.active !== true)
    || selectedCompanies.map(row => row.reference_code).sort().join() !== [...SCOPE.organizationReferences].sort().join()) holds.push('legacy_two_company_scope_not_proven')
  return { messageId: message.message_id, threadId: message.thread_id, cacheId: message.id,
    intakePipelineId: message.pipeline_id, receivedAt: message.received_at, mailboxId: message.mailbox_id,
    canonicalSourceId: message.canonical_source_id, existingCacheInteractionId: message.interaction_id,
    participantEmails: participants, contactCandidates: matches, holds,
    reviewedAssociationDraft: holds.length ? null : { messageId: message.message_id, threadId: message.thread_id,
      primaryOrganizationReference: SCOPE.primaryOrganizationReference,
      contactReferences: contacts.map(row => row.reference_code).sort() } }
}

async function collect(client) {
  const result = { kind: 'bpo-exact-email-recovery-readonly-v1', scope: SCOPE, readOnly: true, rolledBack: false,
    holds: [], proofBoundary: 'Database metadata snapshot only: not fresh Gmail content, native ACL, writer drain, a reviewed recovery digest, or approval to apply.',
    recoveryApplyAuthorizedByThisArtifact: false, previewRequestDraft: null }
  let began = false
  const q = async (sql, values = [], bound = 500) => {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\bFOR\s+(UPDATE|SHARE)\b|\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|CALL|DO)\b/i.test(sql)) throw new Error('NON_READ_QUERY_REFUSED')
    const rows = (await client.query(sql, values)).rows
    if (rows.length > bound) throw new Error('METADATA_BOUND_EXCEEDED')
    return rows
  }
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true
    await client.query("SET LOCAL statement_timeout='8s'")
    await client.query("SET LOCAL lock_timeout='2s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'")
    result.observation = (await q("SELECT now()::text AS captured_at,current_setting('transaction_read_only') AS transaction_read_only,current_setting('transaction_isolation') AS isolation", [], 1))[0]
    if (result.observation.transaction_read_only !== 'on') throw new Error('READ_ONLY_NOT_CONFIRMED')
    const present = new Set((await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'
      AND table_name=ANY($1::text[]) ORDER BY table_name`, [TABLES])).map(row => row.table_name))
    result.schema = Object.fromEntries(TABLES.map(table => [table, present.has(table)]))
    const required = TABLES.slice(0, 15)
    if (required.some(table => !present.has(table))) { result.holds.push('required_metadata_schema_missing'); return result }
    const scope = await q(`SELECT p.workspace_organization_id::text AS workspace_id,p.owner_email,
      u.suitecrm_user_id AS owner_native_id,w.is_demo FROM pipeline_spaces p
      JOIN workspace_organizations w ON w.id=p.workspace_organization_id
      JOIN app_users u ON u.email=p.owner_email
      WHERE p.id=$1::uuid AND NOT p.reference_access_disabled`, [SCOPE.pipelineId], 1)
    const readers = await q(`SELECT intended.email,u.status,m.status AS membership_status,u.suitecrm_user_id,
      m.role AS membership_role,m.permissions AS membership_permissions,
      m.trashed_at::text AS membership_trashed_at,pm.access_role,
      (SELECT count(*)::int FROM app_users identity_user WHERE identity_user.suitecrm_user_id=u.suitecrm_user_id) AS native_identity_count
      FROM pipeline_spaces p JOIN LATERAL (SELECT p.owner_email AS email UNION
        SELECT user_email FROM pipeline_space_members WHERE pipeline_id=p.id) intended ON true
      LEFT JOIN app_users u ON u.email=intended.email
      LEFT JOIN app_user_organization_memberships m ON m.user_email=intended.email AND m.organization_id=p.workspace_organization_id
      LEFT JOIN pipeline_space_members pm ON pm.pipeline_id=p.id AND pm.user_email=u.email
      WHERE p.id=$1::uuid ORDER BY intended.email LIMIT 501`, [SCOPE.pipelineId])
    result.audience = audienceSnapshot(scope, readers); result.holds.push(...result.audience.holds)
    result.connection = await q(`SELECT connection_id,account_email,status,is_selected,
      to_jsonb(c)->>'remote_updated_at' AS remote_updated_at FROM user_maton_connections c
      WHERE owner_email=$1 AND connection_id=$2 AND app='google-mail' AND source='maton'`, [SCOPE.ownerEmail, SCOPE.connectionId], 1)
    if (result.connection.length !== 1 || result.connection[0].status !== 'ACTIVE' || !result.connection[0].is_selected) result.holds.push('selected_connection_not_active')
    result.mailboxBindings = []
    if (present.has('crm_email_mailboxes') && present.has('crm_email_mailbox_bindings')) {
      result.mailboxBindings = await q(`SELECT mailbox.id::text AS mailbox_id,mailbox.provider,b.account_email,b.verified_at::text,
        mailbox.provider_account_id<>'' AS provider_identity_present,
        (lower(btrim(b.account_email))=lower(btrim(c.account_email))
          AND COALESCE((to_jsonb(c)->>'remote_updated_at')::timestamptz,'-infinity')<=b.verified_at
          AND c.status='ACTIVE' AND c.is_selected) AS current_binding_valid
        FROM crm_email_mailboxes mailbox JOIN crm_email_mailbox_bindings b ON b.mailbox_id=mailbox.id AND b.owner_email=mailbox.owner_email
        JOIN user_maton_connections c ON c.owner_email=b.owner_email AND c.connection_id=b.connection_id AND c.app='google-mail' AND c.source='maton'
        WHERE mailbox.owner_email=$1 AND b.connection_id=$2`, [SCOPE.ownerEmail, SCOPE.connectionId], 2)
    }
    if (result.mailboxBindings.length !== 1 || !result.mailboxBindings[0].current_binding_valid
      || !result.mailboxBindings[0].provider_identity_present || result.mailboxBindings[0].provider !== 'gmail') result.holds.push('verified_mailbox_identity_unavailable')
    const messages = await q(`SELECT m.id::text,m.pipeline_id::text,m.external_message_id AS message_id,m.external_thread_id AS thread_id,
      m.received_at::text,m.interaction_id::text,to_jsonb(m)->>'mailbox_id' AS mailbox_id,to_jsonb(m)->>'canonical_source_id' AS canonical_source_id,
      m.raw_metadata->>'provider' AS provider,
      jsonb_build_object('version',m.raw_metadata->'emailAddressHeaders'->'version',
        'from',m.raw_metadata->'emailAddressHeaders'->'from','to',m.raw_metadata->'emailAddressHeaders'->'to',
        'cc',m.raw_metadata->'emailAddressHeaders'->'cc','bcc',m.raw_metadata->'emailAddressHeaders'->'bcc') AS headers,
      EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.raw_metadata->'labelIds')='array'
        THEN m.raw_metadata->'labelIds' ELSE '[]'::jsonb END) label WHERE label IN ('DRAFT','SPAM','TRASH')) AS excluded_label,
      (p.owner_email=m.owner_email AND NOT p.reference_access_disabled AND u.status='active'
        AND membership.status='active' AND membership.trashed_at IS NULL) AS source_owner_active
      FROM crm_inbound_messages m JOIN pipeline_spaces p ON p.id=m.pipeline_id
      LEFT JOIN app_users u ON u.email=p.owner_email
      LEFT JOIN app_user_organization_memberships membership ON membership.organization_id=p.workspace_organization_id AND membership.user_email=p.owner_email
      WHERE m.owner_email=$1 AND m.external_message_id=ANY($2::text[]) ORDER BY m.external_message_id LIMIT 6`, [SCOPE.ownerEmail, SCOPE.messageIds], 5)
    if (messages.length !== SCOPE.messageIds.length
      || new Set(messages.map(row => row.message_id)).size !== SCOPE.messageIds.length) result.holds.push('exact_reviewed_cached_messages_unavailable')
    const participantEmails = [...new Set(messages.flatMap(row => ['from','to','cc','bcc'].flatMap(kind =>
      Array.isArray(row.headers?.[kind]) ? row.headers[kind].map(value => address(value?.address)).filter(Boolean) : [])))].sort()
    if (participantEmails.length > 100) throw new Error('PARTICIPANT_BOUND_EXCEEDED')
    // Exact automatic candidate policy: a QuickBooks mirror is excluded only
    // with both strict provenance and durable link evidence, and another real
    // CRM record for the same actual header address. Never infer from a name.
    const candidates = await q(`WITH eligible AS (
      SELECT p.id FROM pipeline_spaces p JOIN app_user_organization_memberships m ON m.organization_id=p.workspace_organization_id
        AND m.user_email=p.owner_email AND m.status='active'
      WHERE p.owner_email=$1 AND NOT p.reference_access_disabled
    ), candidates AS (
      SELECT c.id::text,c.pipeline_id::text,c.organization_id::text,c.reference_code,lower(btrim(c.email)) AS email,'contacts'::text AS entity,
        COALESCE(c.source_payload->>'provider'='quickbooks' AND COALESCE(btrim(c.source_payload->>'source'),'')=''
          AND c.source_payload-ARRAY['provider','customerId','customer']::text[]='{}'::jsonb
          AND COALESCE(btrim(c.source_payload->>'customerId'),'')<>''
          AND c.source_payload->'customer'->>'Id'=c.source_payload->>'customerId'
          AND EXISTS(SELECT 1 FROM quickbooks_crm_links l JOIN pipeline_spaces ap ON ap.id=l.pipeline_id AND ap.workspace_organization_id=l.organization_id
            WHERE l.pipeline_id=c.pipeline_id AND l.crm_record_id=c.id AND l.crm_entity_type='contact'
              AND l.provider_entity_type='customer' AND l.provider_entity_id=c.source_payload->>'customerId'),false) AS accounting_mirror
      FROM crm_contacts c WHERE c.pipeline_id IN (SELECT id FROM eligible) AND lower(btrim(c.email))=ANY($2::text[]) AND ${active('c')}
      UNION ALL SELECT l.id::text,l.pipeline_id::text,l.organization_id::text,l.reference_code,lower(btrim(l.email)),'leads',false
      FROM crm_leads l WHERE l.pipeline_id IN (SELECT id FROM eligible) AND lower(btrim(l.email))=ANY($2::text[]) AND ${active('l')}
    ) SELECT c.id,c.pipeline_id,c.organization_id,c.reference_code,c.email,c.entity FROM candidates c
      WHERE NOT c.accounting_mirror OR NOT EXISTS(SELECT 1 FROM candidates real_crm WHERE real_crm.email=c.email AND NOT real_crm.accounting_mirror)
      ORDER BY c.reference_code LIMIT 101`, [SCOPE.ownerEmail, participantEmails], 100)
    const companyIds = [...new Set(candidates.filter(row => row.pipeline_id === SCOPE.pipelineId).map(row => row.organization_id).filter(Boolean))]
    const companies = await q(`SELECT c.id::text,c.reference_code,c.suitecrm_id,${active('c')} AS active
      FROM crm_organizations c WHERE c.pipeline_id=$1::uuid AND c.id=ANY($2::uuid[]) ORDER BY c.id LIMIT 101`, [SCOPE.pipelineId, companyIds], 100)
    result.companies = companies
    result.messages = messages.map(message => messagePlan(message, candidates, companies))
    for (const message of result.messages) {
      if (message.mailboxId && message.mailboxId !== result.mailboxBindings[0]?.mailbox_id) message.holds.push('cached_mailbox_conflict')
      if (message.holds.length) result.holds.push('message_requires_review:' + message.messageId)
    }
    result.interactions = await q(`SELECT i.id::text,i.pipeline_id::text,i.reference_code,i.suitecrm_id,i.suitecrm_module,
      i.provider_message_id,i.provider_thread_id,i.organization_id::text,i.contact_id::text,i.sync_status,
      to_jsonb(i)->>'canonical_source_id' AS canonical_source_id,i.source_hash,i.suitecrm_synced_at::text,${active('i')} AS active,
      i.metadata->'suiteCrmEmailProjection'->>'version' AS native_projection_version,
      i.metadata ? 'reviewedGmailRecovery' AS has_reviewed_recovery,
      ARRAY(SELECT c.contact_id::text FROM crm_interaction_contacts c WHERE c.interaction_id=i.id ORDER BY c.sort_order,c.contact_id) AS contact_ids
      FROM crm_interactions i JOIN pipeline_spaces p ON p.id=i.pipeline_id
      WHERE p.owner_email=$1 AND i.provider_message_id=ANY($2::text[]) ORDER BY i.pipeline_id,i.provider_message_id,i.id LIMIT 31`, [SCOPE.ownerEmail, SCOPE.messageIds], 30)
    const localIds = result.interactions.map(row => row.id)
    for (const id of SCOPE.messageIds) {
      const rows = result.interactions.filter(row => row.provider_message_id === id)
      if (rows.length > 1) result.holds.push('existing_interaction_duplicates:' + id)
      if (rows.some(row => row.pipeline_id !== SCOPE.pipelineId || !row.active || row.provider_thread_id !== SCOPE.threadId)) result.holds.push('existing_interaction_scope_or_lifecycle_conflict:' + id)
    }
    result.links = await q(`SELECT l.inbound_message_id::text,l.reference_code,l.aggregate_type,l.aggregate_id::text,l.interaction_id::text,
      i.pipeline_id::text AS interaction_pipeline_id FROM crm_inbound_message_links l LEFT JOIN crm_interactions i ON i.id=l.interaction_id
      WHERE l.inbound_message_id=ANY($1::uuid[]) ORDER BY l.inbound_message_id,l.reference_code LIMIT 101`, [messages.map(row => row.id)], 100)
    result.outbox = await q(`SELECT o.id::text,o.aggregate_id,o.operation,o.status,o.attempts,o.created_at::text,o.processed_at::text,
      to_jsonb(o)->>'locked_at' AS locked_at,to_jsonb(o)->>'idempotency_key' AS idempotency_key,
      o.payload->>'module' AS module,o.payload->>'previousModule' AS previous_module,o.last_error IS NOT NULL AS has_error
      FROM sync_outbox o WHERE o.target_system='suitecrm' AND o.aggregate_type='crm_interactions'
      AND o.aggregate_id=ANY($1::text[]) ORDER BY o.aggregate_id,o.created_at LIMIT 101`, [localIds], 100)
    if (result.outbox.some(row => ['queued','processing','failed'].includes(row.status))) result.holds.push('existing_native_projection_pending')
    for (const [table, key, sql, values] of [
      ['crm_interaction_organizations','interactionCompanies',`SELECT interaction_id::text,organization_id::text,is_primary,sort_order FROM crm_interaction_organizations WHERE interaction_id=ANY($1::uuid[]) ORDER BY interaction_id,sort_order LIMIT 101`,[localIds]],
      ['crm_email_sources','canonicalSources',`SELECT id::text,mailbox_id::text,provider_message_id,provider_thread_id,intake_pipeline_id::text,intake_workspace_id::text,evidence_hash FROM crm_email_sources WHERE owner_email=$1 AND provider_message_id=ANY($2::text[]) ORDER BY provider_message_id,id LIMIT 31`,[SCOPE.ownerEmail,SCOPE.messageIds]],
      ['crm_email_review_decisions','decisions',`SELECT id::text,interaction_id::text,source_id::text,revision,kind,decision_hash,created_at::text,audience->>'fingerprint' AS audience_fingerprint FROM crm_email_review_decisions WHERE interaction_id=ANY($1::uuid[]) ORDER BY interaction_id,revision LIMIT 101`,[localIds]],
      ['crm_native_email_publication_control','publicationControl',`SELECT enabled,generation::text,verified_generation::text,active_operation_id,native_policy_fingerprint,activation_receipt_hash FROM crm_native_email_publication_control WHERE singleton`,[]],
      ['crm_native_email_publication_admissions','nativeAdmissions',`SELECT operation_id,local_id::text,native_id,global_id,state,generation::text,command_hash,audience_fingerprint,native_receipt IS NOT NULL AS has_receipt,created_at::text,updated_at::text FROM crm_native_email_publication_admissions WHERE local_id=ANY($1::uuid[]) OR operation_id=(SELECT active_operation_id FROM crm_native_email_publication_control WHERE singleton) ORDER BY created_at LIMIT 101`,[localIds]],
    ]) {
      if (present.has(table)) result[key] = await q(sql, values, 100)
      else result[key] = null
    }
    result.nativeWork = present.has('crm_native_email_publication_work') ? await q(`SELECT operation_id,work_kind,context_hash,
      lease_fence::text,lease_until::text,context->>'outboxId' AS outbox_id,context->>'sourceHash' AS source_hash,
      context->>'attempt' AS attempt FROM crm_native_email_publication_work WHERE operation_id=ANY($1::text[]) ORDER BY operation_id LIMIT 101`,
    [(result.nativeAdmissions || []).map(row => row.operation_id)], 100) : null
    for (const message of result.messages) {
      const local = result.interactions.filter(row => row.provider_message_id === message.messageId && row.pipeline_id === SCOPE.pipelineId)
      const references = new Set([...(message.reviewedAssociationDraft?.contactReferences || []), ...SCOPE.organizationReferences])
      if (message.existingCacheInteractionId && !local.some(row => row.id === message.existingCacheInteractionId)
        || result.links.some(link => link.inbound_message_id === message.cacheId && (!references.has(link.reference_code)
          || link.interaction_id && !local.some(row => row.id === link.interaction_id)))) result.holds.push('existing_cache_relationship_conflict:' + message.messageId)
      const sources = (result.canonicalSources || []).filter(source => source.provider_message_id === message.messageId)
      if (sources.some(source => source.mailbox_id !== result.mailboxBindings[0]?.mailbox_id || source.provider_thread_id !== SCOPE.threadId)
        || sources.length > 1 || message.canonicalSourceId && !sources.some(source => source.id === message.canonicalSourceId)) result.holds.push('canonical_source_identity_conflict:' + message.messageId)
    }
    if (!result.publicationControl?.length || !result.publicationControl[0].enabled) result.holds.push('native_publication_not_enabled')
    if (result.publicationControl?.[0]?.active_operation_id) result.holds.push('native_publication_unresolved_operation')
    if (!present.has('crm_email_sources') || !present.has('crm_interaction_organizations')) result.holds.push('shared_email_schema_not_installed')
    // This is only a fresh-provider DRY-RUN request draft. Do not attach an
    // expectedDigest or turn apply on. The endpoint revalidates all evidence.
    if (!result.audience.holds.length && result.messages.length === SCOPE.messageIds.length && result.messages.every(row => row.reviewedAssociationDraft && !row.holds.length)
      && !result.holds.some(value => /mailbox|connection|cached_messages|scope_or_lifecycle|duplicates|conflict/.test(value))) {
      result.previewRequestDraft = { method: 'POST', path: '/api/crm/email-recovery', body: {
        pipelineId: SCOPE.pipelineId, connectionId: SCOPE.connectionId, messageIds: [...SCOPE.messageIds], apply: false,
        reviewedAssociations: result.messages.map(row => row.reviewedAssociationDraft) } }
    }
    result.holds = [...new Set(result.holds)].sort()
    return result
  } finally {
    if (began) { await client.query('ROLLBACK'); result.rolledBack = true }
  }
}

function inspectionFailure(error, inspectionStage) {
  const localCodes = new Set(['EXPLICIT_READ_ONLY_MODE_REQUIRED','EXACT_PRODUCTION_ENVIRONMENT_REQUIRED',
    'DATABASE_CONFIGURATION_MISSING','EXACT_PRIVATE_ENDPOINT_REQUIRED','NON_READ_QUERY_REFUSED',
    'INSECURE_DIAGNOSTIC_MODE_REMOVED','READONLY_TLS_TRUST_REQUIRED','READONLY_TLS_TRUST_INVALID',
    'READONLY_TLS_TRUST_CHANGED','READONLY_TLS_PEER_MISMATCH',
    'METADATA_BOUND_EXCEEDED','READ_ONLY_NOT_CONFIRMED','PARTICIPANT_BOUND_EXCEEDED'])
  const runtimeCodes = new Set(['MODULE_NOT_FOUND','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','ECONNRESET'])
  return { kind:'bpo-exact-email-recovery-readonly-v1', failed:true,
    errorCode:localCodes.has(error?.message)?error.message:'READONLY_INSPECTION_FAILED',
    databaseCode:/^[A-Z0-9]{5}$/.test(error?.code||'')?error.code:null,
    runtimeCode:runtimeCodes.has(error?.code)?error.code:null,
    inspectionStage:['arguments','environment','driver','connect','metadata'].includes(inspectionStage)?inspectionStage:'unverified',
    noRecoveryOrPublicationAttempted:true }
}

async function main() {
  let client, inspectionStage='arguments'
  try {
    if (process.argv.filter(value => value === '--read-only').length !== 1
      || process.argv.some((value, index) => index > 1 && value !== '--read-only')) throw new Error('EXPLICIT_READ_ONLY_MODE_REQUIRED')
    inspectionStage='environment'
    if (process.env.RAILWAY_PROJECT_ID !== SCOPE.projectId || process.env.RAILWAY_ENVIRONMENT_ID !== SCOPE.environmentId) throw new Error('EXACT_PRODUCTION_ENVIRONMENT_REQUIRED')
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_CONFIGURATION_MISSING')
    inspectionStage='driver'
    const { Client } = require(require.resolve('pg', { paths: [process.cwd(), process.cwd() + '/app_src', '/app', '/app/app_src'] }))
    const database=readOnlyDatabaseConfig(process.env)
    client = new Client(database.config)
    inspectionStage='connect'
    await client.connect()
    inspectionStage='metadata'
    const result = await collect(client)
    result.tlsTrust=database.trust
    result.applicationCommit = process.env.RAILWAY_GIT_COMMIT_SHA || null
    result.metadataObservationSha256 = sha(result)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) {
    // Never emit provider/connection errors, SQL text, connection strings, raw
    // Error.message, driver detail, or email content on failures.
    process.stdout.write(JSON.stringify(inspectionFailure(error,inspectionStage)) + '\n')
    process.exitCode = 1
  } finally { if (client) await client.end().catch(() => {}) }
}

module.exports = { SCOPE, audienceSnapshot, messagePlan, collect, inspectionFailure,
  validateReadOnlyPostgresTrust,readOnlyDatabaseConfig,REVIEWED_POSTGRES_LEAF }
if (!module.parent) main()
