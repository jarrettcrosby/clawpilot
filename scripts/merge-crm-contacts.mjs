#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const CONTACT_REFERENCE = /^gc[0-9]{7}$/
const DEFAULT_REASON = 'Consolidate a duplicate CRM Contact while preserving its source and public identities'

function usage() {
  return `Usage:
  node scripts/merge-crm-contacts.mjs --survivor gc5912585 --duplicate gc9694701
  node scripts/merge-crm-contacts.mjs --survivor gc5912585 --duplicate gc9694701 \\
    --apply --actor operator@example.com \\
    --confirm merge:gc9694701:into:gc5912585

The command is dry-run by default. A mutation requires all three of:
  --apply
  --actor <active ClawPilot user email>
  --confirm merge:<duplicate>:into:<survivor>

Options:
  --survivor <gc...>   Canonical Contact reference to keep
  --duplicate <gc...>  Duplicate Contact reference to remove
  --actor <email>       Audit actor; required with --apply
  --reason <text>       Merge reason (maximum 500 characters)
  --apply               Commit the transaction
  --confirm <token>     Exact mutation confirmation token
  --help                Show this help`
}

function parseArgs(argv) {
  const parsed = {
    survivor: '',
    duplicate: '',
    actor: '',
    reason: DEFAULT_REASON,
    confirm: '',
    apply: false,
    help: false,
  }
  const valued = new Set(['survivor', 'duplicate', 'actor', 'reason', 'confirm'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--apply') {
      parsed.apply = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      parsed.help = true
      continue
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const separator = argument.indexOf('=')
    const key = argument.slice(2, separator === -1 ? undefined : separator)
    if (!valued.has(key)) throw new Error(`Unknown option: --${key}`)
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1)
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`)
    parsed[key] = value
  }
  return parsed
}

function clean(value) {
  return String(value ?? '').trim()
}

function nullable(value) {
  return clean(value) || null
}

function normalizeName(value) {
  return clean(value).toLowerCase().replace(/\s+/g, ' ')
}

function normalizeEmail(value) {
  return clean(value).toLowerCase()
}

function preferText(primary, fallback) {
  return nullable(primary) ?? nullable(fallback)
}

function combineText(primary, fallback) {
  const values = [clean(primary), clean(fallback)].filter(Boolean)
  return [...new Set(values)].join('\n\n') || null
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function confirmationToken(survivorReference, duplicateReference) {
  return `merge:${duplicateReference}:into:${survivorReference}`
}

function replaceExactStrings(value, replacements, state = { count: 0 }) {
  if (typeof value === 'string') {
    const replacement = replacements.get(value)
    if (replacement !== undefined && replacement !== value) {
      state.count += 1
      return replacement
    }
    return value
  }
  if (Array.isArray(value)) return value.map((item) => replaceExactStrings(item, replacements, state))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceExactStrings(item, replacements, state)]),
    )
  }
  return value
}

function dedupeRelationships(payload) {
  if (!Array.isArray(payload.relationships)) return payload
  const seen = new Set()
  const relationships = payload.relationships.filter((relationship) => {
    if (!relationship || typeof relationship !== 'object') return false
    const key = [
      clean(relationship.linkFieldName),
      clean(relationship.relatedModuleName),
      clean(relationship.relatedBeanId),
    ].join(':')
    if (!clean(relationship.relatedBeanId) || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { ...payload, relationships }
}

async function assertMigrationInstalled(client) {
  const result = await client.query(
    `SELECT
       to_regclass('crm_contact_source_aliases') IS NOT NULL AS source_aliases,
       to_regclass('crm_reference_aliases') IS NOT NULL AS reference_aliases,
       to_regclass('crm_contact_merges') IS NOT NULL AS merges,
       to_regclass('crm_contact_merge_outbox_dependencies') IS NOT NULL AS dependencies`,
  )
  if (!Object.values(result.rows[0] || {}).every(Boolean)) {
    throw new Error('Migration 0096_crm_contact_identity_aliases.sql must be applied before this command')
  }
}

async function readContacts(client, survivorReference, duplicateReference) {
  return client.query(
    `SELECT contact.*,
       organization.name AS organization_name,
       organization.suitecrm_id AS organization_suitecrm_id,
       owner.suitecrm_user_id AS owner_suitecrm_user_id,
       pipeline.owner_email AS pipeline_owner_email
     FROM crm_contacts contact
     JOIN crm_organizations organization
       ON organization.pipeline_id = contact.pipeline_id
      AND organization.id = contact.organization_id
     JOIN pipeline_spaces pipeline ON pipeline.id = contact.pipeline_id
     LEFT JOIN app_users owner ON owner.email = contact.owner_email
     WHERE contact.reference_code = ANY($1::text[])
     ORDER BY contact.reference_code
     FOR UPDATE OF contact`,
    [[survivorReference, duplicateReference]],
  )
}

async function readAlreadyMerged(client, survivorReference, duplicateReference) {
  const result = await client.query(
    `SELECT merge.id::text, merge.pipeline_id::text, merge.survivor_contact_id::text,
       merge.duplicate_contact_id::text, merge.survivor_reference_code,
       merge.duplicate_reference_code, merge.survivor_suitecrm_id,
       merge.duplicate_suitecrm_id, merge.rewired_counts, merge.survivor_outbox_id::text,
       merge.duplicate_delete_outbox_id::text, merge.merged_by, merge.reason,
       merge.merged_at::text, alias.canonical_code
     FROM crm_contact_merges merge
     JOIN crm_reference_aliases alias
       ON alias.alias_code = merge.duplicate_reference_code
      AND alias.canonical_code = merge.survivor_reference_code
     WHERE merge.duplicate_reference_code = $1
       AND merge.survivor_reference_code = $2
     LIMIT 1`,
    [duplicateReference, survivorReference],
  )
  return result.rows[0] || null
}

function validateContactPair(survivor, duplicate) {
  if (survivor.pipeline_id !== duplicate.pipeline_id) {
    throw new Error('The survivor and duplicate must belong to the same pipeline')
  }
  if (survivor.organization_id !== duplicate.organization_id) {
    throw new Error('The survivor and duplicate must belong to the same CRM organization')
  }
  if (normalizeName(survivor.full_name) !== normalizeName(duplicate.full_name)) {
    throw new Error('Contact names do not match after normalization')
  }
  const survivorEmail = normalizeEmail(survivor.email)
  const duplicateEmail = normalizeEmail(duplicate.email)
  if (survivorEmail && duplicateEmail && survivorEmail !== duplicateEmail) {
    throw new Error('Contacts have different non-empty email addresses')
  }
  if (!survivorEmail && duplicateEmail) {
    throw new Error('The duplicate has the stronger email identity; choose it as the survivor')
  }
  if (duplicate.app_user_email) {
    throw new Error('The duplicate is linked to a ClawPilot user and cannot be removed by this utility')
  }
  if (String(survivor.source_payload?.archived || '').toLowerCase() === 'true') {
    throw new Error('The survivor Contact is archived')
  }
  if (String(duplicate.source_payload?.archived || '').toLowerCase() === 'true') {
    throw new Error('The duplicate Contact is archived')
  }
  if (duplicate.suitecrm_id && !survivor.suitecrm_id) {
    throw new Error('The duplicate has a SuiteCRM ID but the survivor does not')
  }
}

async function validateAppUserReferences(client, survivor, duplicate) {
  const duplicateReferenceUsers = await client.query(
    `SELECT email
     FROM app_users
     WHERE contact_reference_code = $1
        OR reference_code = $1`,
    [duplicate.reference_code],
  )
  if (duplicateReferenceUsers.rowCount > 0) {
    throw new Error(
      `The duplicate reference belongs to an app user (${duplicateReferenceUsers.rows.map((row) => row.email).join(', ')})`,
    )
  }
  if (survivor.app_user_email) {
    const survivorUser = await client.query(
      `SELECT email FROM app_users
       WHERE email = $1 AND contact_reference_code = $2`,
      [survivor.app_user_email, survivor.reference_code],
    )
    if (survivorUser.rowCount !== 1) {
      throw new Error('The survivor Contact has an inconsistent ClawPilot user identity')
    }
  }
}

async function validateReferenceState(client, survivor, duplicate) {
  const registries = await client.query(
    `SELECT reference_code, status
     FROM crm_reference_registry
     WHERE reference_code = ANY($1::text[])
     FOR UPDATE`,
    [[survivor.reference_code, duplicate.reference_code]],
  )
  if (registries.rowCount !== 2) throw new Error('Both Contact references must exist in the reference registry')
  const registryByReference = new Map(
    registries.rows.map((row) => [row.reference_code, row]),
  )
  if (registryByReference.get(survivor.reference_code)?.status !== 'active') {
    throw new Error('The survivor reference is not active in the reference registry')
  }
  if (registryByReference.get(duplicate.reference_code)?.status !== 'active') {
    throw new Error('The duplicate reference is not active in the reference registry')
  }
  const survivorAlias = await client.query(
    `SELECT canonical_code FROM crm_reference_aliases WHERE alias_code = $1`,
    [survivor.reference_code],
  )
  if (survivorAlias.rowCount > 0) throw new Error('The requested survivor reference is itself an alias')
  const duplicateAlias = await client.query(
    `SELECT canonical_code FROM crm_reference_aliases WHERE alias_code = $1`,
    [duplicate.reference_code],
  )
  if (duplicateAlias.rowCount > 0 && duplicateAlias.rows[0].canonical_code !== survivor.reference_code) {
    throw new Error(`The duplicate reference already aliases ${duplicateAlias.rows[0].canonical_code}`)
  }
}

async function validateForeignKeyCoverage(client, duplicate) {
  const result = await client.query(
    `SELECT source.relname AS table_name, source_column.attname AS column_name,
       constraint_row.conname AS constraint_name
     FROM pg_constraint constraint_row
     JOIN pg_class source ON source.oid = constraint_row.conrelid
     JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS source_key(attnum, position) ON true
     JOIN unnest(constraint_row.confkey) WITH ORDINALITY AS target_key(attnum, position)
       ON target_key.position = source_key.position
     JOIN pg_attribute source_column
       ON source_column.attrelid = constraint_row.conrelid
      AND source_column.attnum = source_key.attnum
     JOIN pg_attribute target_column
       ON target_column.attrelid = constraint_row.confrelid
      AND target_column.attnum = target_key.attnum
     WHERE constraint_row.contype = 'f'
       AND constraint_row.confrelid = 'crm_contacts'::regclass
       AND target_column.attname = 'id'
     ORDER BY source.relname, source_column.attname`,
  )
  const supported = new Set([
    'crm_campaign_recipients.contact_id',
    'crm_contact_merges.survivor_contact_id',
    'crm_contact_source_aliases.contact_id',
    'crm_inbound_messages.contact_id',
    'crm_interaction_contacts.contact_id',
    'crm_interactions.contact_id',
    'crm_leads.converted_contact_id',
    'crm_meetings.contact_id',
    'crm_opportunities.owner_contact_id',
    'crm_opportunity_contacts.contact_id',
  ])
  const unsupported = result.rows.filter((row) => !supported.has(`${row.table_name}.${row.column_name}`))
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Contact reference(s) must be reviewed before merging: ${
        unsupported.map((row) => `${row.table_name}.${row.column_name}`).join(', ')
      }`,
    )
  }
  const priorSurvivor = await client.query(
    `SELECT duplicate_reference_code
     FROM crm_contact_merges
     WHERE pipeline_id = $1::uuid AND survivor_contact_id = $2::uuid
     LIMIT 1`,
    [duplicate.pipeline_id, duplicate.id],
  )
  if (priorSurvivor.rowCount > 0) {
    throw new Error(
      `The duplicate is already a merge survivor for ${priorSurvivor.rows[0].duplicate_reference_code}; chained merges are not automatic`,
    )
  }
}

async function collectAffectedAggregates(client, duplicate) {
  const result = await client.query(
    `SELECT DISTINCT affected.aggregate_type, affected.aggregate_id::text,
       affected.suitecrm_id
     FROM (
       SELECT 'crm_interactions'::text AS aggregate_type, interaction.id AS aggregate_id,
         interaction.suitecrm_id
       FROM crm_interactions interaction
       WHERE interaction.pipeline_id = $1::uuid
         AND (
           interaction.contact_id = $2::uuid
           OR EXISTS (
             SELECT 1 FROM crm_interaction_contacts linked
             WHERE linked.pipeline_id = interaction.pipeline_id
               AND linked.interaction_id = interaction.id
               AND linked.contact_id = $2::uuid
           )
         )
       UNION ALL
       SELECT 'crm_meetings', meeting.id, meeting.suitecrm_id
       FROM crm_meetings meeting
       WHERE meeting.pipeline_id = $1::uuid AND meeting.contact_id = $2::uuid
       UNION ALL
       SELECT 'crm_opportunities', opportunity.id, opportunity.suitecrm_id
       FROM crm_opportunities opportunity
       WHERE opportunity.pipeline_id = $1::uuid
         AND (
           opportunity.owner_contact_id = $2::uuid
           OR EXISTS (
             SELECT 1 FROM crm_opportunity_contacts linked
             WHERE linked.pipeline_id = opportunity.pipeline_id
               AND linked.opportunity_id = opportunity.id
               AND linked.contact_id = $2::uuid
           )
         )
     ) affected
     ORDER BY 1, 2`,
    [duplicate.pipeline_id, duplicate.id],
  )
  return result.rows
}

async function assertNoInFlightWork(client, survivor, duplicate, affected) {
  const aggregates = [
    { aggregate_type: 'crm_contacts', aggregate_id: survivor.id },
    { aggregate_type: 'crm_contacts', aggregate_id: duplicate.id },
    ...affected,
  ]
  const processing = await client.query(
    `SELECT id::text, aggregate_type, aggregate_id, operation
     FROM sync_outbox
     WHERE target_system = 'suitecrm'
       AND status = 'processing'
       AND (aggregate_type, aggregate_id) IN (
         SELECT item->>'aggregateType', item->>'aggregateId'
         FROM jsonb_array_elements($1::jsonb) item
       )
     ORDER BY created_at`,
    [JSON.stringify(aggregates.map((row) => ({
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
    })))],
  )
  if (processing.rowCount > 0) {
    throw new Error(
      `SuiteCRM work is currently processing for the merge set: ${
        processing.rows.map((row) => `${row.aggregate_type}/${row.aggregate_id}`).join(', ')
      }`,
    )
  }
  const survivorDelete = await client.query(
    `SELECT id::text
     FROM sync_outbox
     WHERE target_system = 'suitecrm'
       AND aggregate_type = 'crm_contacts'
       AND aggregate_id = $1
       AND operation = 'delete_record'
       AND status IN ('queued', 'failed', 'processing')
     LIMIT 1`,
    [survivor.id],
  )
  if (survivorDelete.rowCount > 0) throw new Error('The survivor has a pending SuiteCRM deletion')
  const action = await client.query(
    `SELECT id::text
     FROM crm_integration_actions
     WHERE pipeline_id = $1::uuid
       AND status = 'processing'
       AND (
         reference_code = $2
         OR (aggregate_type IN ('contact', 'contacts', 'crm_contacts') AND aggregate_id = $3)
         OR payload::text LIKE '%' || $2 || '%'
         OR payload::text LIKE '%' || $3 || '%'
         OR ($4::text IS NOT NULL AND payload::text LIKE '%' || $4 || '%')
       )
     LIMIT 1`,
    [duplicate.pipeline_id, duplicate.reference_code, duplicate.id, duplicate.suitecrm_id],
  )
  if (action.rowCount > 0) throw new Error('An integration action for the duplicate Contact is currently processing')
}

async function prepareDependentOutbox(client, survivor, duplicate, affected) {
  if (!duplicate.suitecrm_id) return []
  const replacements = new Map([
    [duplicate.id, survivor.id],
    [duplicate.reference_code, survivor.reference_code],
    [duplicate.suitecrm_id, survivor.suitecrm_id],
  ])
  const prepared = []
  for (const aggregate of affected) {
    if (!aggregate.suitecrm_id) continue
    const latest = await client.query(
      `SELECT id::text, operation, payload, status
       FROM sync_outbox
       WHERE target_system = 'suitecrm'
         AND aggregate_type = $1
         AND aggregate_id = $2
         AND operation IN ('upsert_record', 'reproject_record')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [aggregate.aggregate_type, aggregate.aggregate_id],
    )
    if (!latest.rows[0]) {
      throw new Error(
        `Cannot safely reconstruct SuiteCRM relationship payload for ${aggregate.aggregate_type}/${aggregate.aggregate_id}`,
      )
    }
    const state = { count: 0 }
    const replaced = replaceExactStrings(latest.rows[0].payload, replacements, state)
    if (state.count === 0) {
      throw new Error(
        `Latest SuiteCRM payload does not identify the duplicate for ${aggregate.aggregate_type}/${aggregate.aggregate_id}`,
      )
    }
    prepared.push({
      ...aggregate,
      operation: latest.rows[0].operation,
      payload: dedupeRelationships(replaced),
      source_outbox_id: latest.rows[0].id,
    })
  }
  return prepared
}

function mergedContactValues(survivor, duplicate, actorEmail) {
  const survivorHasOwner = Boolean(survivor.owner_user_reference_code)
  const duplicateHasOwner = Boolean(duplicate.owner_user_reference_code)
  const owner = survivorHasOwner ? survivor : duplicateHasOwner ? duplicate : null
  const sourcePayload = {
    ...asObject(survivor.source_payload),
    contactMerge: {
      absorbedContactId: duplicate.id,
      absorbedReferenceCode: duplicate.reference_code,
      absorbedSourceKey: duplicate.source_key,
      absorbedIdentityKey: duplicate.identity_key,
      mergedBy: actorEmail,
      mergedAt: new Date().toISOString(),
    },
  }
  const fields = {
    priority: preferText(survivor.priority, duplicate.priority),
    first_name: preferText(survivor.first_name, duplicate.first_name),
    last_name: preferText(survivor.last_name, duplicate.last_name),
    full_name: preferText(survivor.full_name, duplicate.full_name),
    contact_type: preferText(survivor.contact_type, duplicate.contact_type),
    account_manager: owner
      ? preferText(owner.account_manager, owner.owner_display_name)
      : preferText(survivor.account_manager, duplicate.account_manager),
    job_title: preferText(survivor.job_title, duplicate.job_title),
    email: preferText(survivor.email, duplicate.email),
    linkedin_url: preferText(survivor.linkedin_url, duplicate.linkedin_url),
    phone_work: preferText(survivor.phone_work, duplicate.phone_work),
    phone_mobile: preferText(survivor.phone_mobile, duplicate.phone_mobile),
    primary_address_street: preferText(survivor.primary_address_street, duplicate.primary_address_street),
    primary_address_city: preferText(survivor.primary_address_city, duplicate.primary_address_city),
    primary_address_state: preferText(survivor.primary_address_state, duplicate.primary_address_state),
    primary_address_postal_code: preferText(
      survivor.primary_address_postal_code,
      duplicate.primary_address_postal_code,
    ),
    primary_address_country: preferText(survivor.primary_address_country, duplicate.primary_address_country),
    description: combineText(survivor.description, duplicate.description),
    owner_user_reference_code: owner?.owner_user_reference_code || null,
    owner_email: owner?.owner_email || null,
    owner_display_name: owner?.owner_display_name || null,
    app_user_email: survivor.app_user_email || null,
    source_sheet_id: preferText(survivor.source_sheet_id, duplicate.source_sheet_id),
    source_row_number: survivor.source_row_number ?? duplicate.source_row_number ?? null,
    source_payload: sourcePayload,
    email_opt_out: survivor.email_opt_out === true || duplicate.email_opt_out === true,
    pipeline_user: survivor.pipeline_user === true || duplicate.pipeline_user === true,
  }
  return {
    ...fields,
    source_hash: hashJson({ fields, sourcePayload }),
  }
}

async function updateSurvivor(client, survivor, duplicate, actorEmail) {
  const values = mergedContactValues(survivor, duplicate, actorEmail)
  const result = await client.query(
    `UPDATE crm_contacts
     SET priority = $3,
       first_name = $4,
       last_name = $5,
       full_name = $6,
       contact_type = $7,
       account_manager = $8,
       job_title = $9,
       email = $10,
       linkedin_url = $11,
       phone_work = $12,
       phone_mobile = $13,
       primary_address_street = $14,
       primary_address_city = $15,
       primary_address_state = $16,
       primary_address_postal_code = $17,
       primary_address_country = $18,
       description = $19,
       owner_user_reference_code = $20,
       owner_email = $21,
       owner_display_name = $22,
       app_user_email = $23,
       source_sheet_id = $24,
       source_row_number = $25,
       source_payload = $26::jsonb,
       source_hash = $27,
       email_opt_out = $28,
       pipeline_user = $29,
       sync_status = 'pending',
       sync_error = NULL,
       updated_by = $30,
       updated_at = now()
     WHERE pipeline_id = $1::uuid AND id = $2::uuid
     RETURNING *`,
    [
      survivor.pipeline_id,
      survivor.id,
      values.priority,
      values.first_name,
      values.last_name,
      values.full_name,
      values.contact_type,
      values.account_manager,
      values.job_title,
      values.email,
      values.linkedin_url,
      values.phone_work,
      values.phone_mobile,
      values.primary_address_street,
      values.primary_address_city,
      values.primary_address_state,
      values.primary_address_postal_code,
      values.primary_address_country,
      values.description,
      values.owner_user_reference_code,
      values.owner_email,
      values.owner_display_name,
      values.app_user_email,
      values.source_sheet_id,
      values.source_row_number,
      JSON.stringify(values.source_payload),
      values.source_hash,
      values.email_opt_out,
      values.pipeline_user,
      actorEmail,
    ],
  )
  return {
    ...result.rows[0],
    organization_suitecrm_id: survivor.organization_suitecrm_id,
    owner_suitecrm_user_id: values.owner_email === survivor.owner_email
      ? survivor.owner_suitecrm_user_id
      : duplicate.owner_suitecrm_user_id,
  }
}

async function rewireRelationshipTable(
  client,
  { table, aggregateColumn, pipelineId, survivorId, duplicateId },
) {
  const result = await client.query(
    `WITH moved AS (
       DELETE FROM ${table}
       WHERE pipeline_id = $1::uuid AND contact_id = $3::uuid
       RETURNING *
     ), merged AS (
       INSERT INTO ${table} (
         pipeline_id, ${aggregateColumn}, contact_id, is_primary, sort_order,
         created_by, created_at, updated_at
       )
       SELECT pipeline_id, ${aggregateColumn}, $2::uuid, is_primary, sort_order,
         created_by, created_at, now()
       FROM moved
       ON CONFLICT (${aggregateColumn}, contact_id) DO UPDATE SET
         is_primary = ${table}.is_primary OR EXCLUDED.is_primary,
         sort_order = LEAST(${table}.sort_order, EXCLUDED.sort_order),
         updated_at = now()
       RETURNING 1
     )
     SELECT (SELECT count(*)::integer FROM moved) AS moved,
       (SELECT count(*)::integer FROM merged) AS merged`,
    [pipelineId, survivorId, duplicateId],
  )
  return result.rows[0]?.moved || 0
}

async function rewireContactReferences(client, survivor, duplicate) {
  const counts = {}
  const update = async (name, sql, params = [survivor.id, duplicate.id, survivor.pipeline_id]) => {
    const result = await client.query(sql, params)
    counts[name] = result.rowCount || 0
  }

  counts.interactionContacts = await rewireRelationshipTable(client, {
    table: 'crm_interaction_contacts',
    aggregateColumn: 'interaction_id',
    pipelineId: survivor.pipeline_id,
    survivorId: survivor.id,
    duplicateId: duplicate.id,
  })
  counts.opportunityContacts = await rewireRelationshipTable(client, {
    table: 'crm_opportunity_contacts',
    aggregateColumn: 'opportunity_id',
    pipelineId: survivor.pipeline_id,
    survivorId: survivor.id,
    duplicateId: duplicate.id,
  })
  await update(
    'interactions',
    `UPDATE crm_interactions SET contact_id = $1::uuid, updated_at = now()
     WHERE pipeline_id = $3::uuid AND contact_id = $2::uuid`,
  )
  await update(
    'meetings',
    `UPDATE crm_meetings SET contact_id = $1::uuid, updated_at = now()
     WHERE pipeline_id = $3::uuid AND contact_id = $2::uuid`,
  )
  await update(
    'convertedLeads',
    `UPDATE crm_leads SET converted_contact_id = $1::uuid, updated_at = now()
     WHERE pipeline_id = $3::uuid AND converted_contact_id = $2::uuid`,
  )
  await update(
    'ownedOpportunities',
    `UPDATE crm_opportunities SET owner_contact_id = $1::uuid, updated_at = now()
     WHERE pipeline_id = $3::uuid AND owner_contact_id = $2::uuid`,
  )
  await update(
    'campaignRecipients',
    `UPDATE crm_campaign_recipients
     SET contact_id = $1::uuid,
       merge_data = CASE
         WHEN merge_data->>'referenceCode' = $4
           THEN jsonb_set(merge_data, '{referenceCode}', to_jsonb($5::text), false)
         ELSE merge_data
       END,
       updated_at = now()
     WHERE pipeline_id = $3::uuid AND contact_id = $2::uuid`,
    [survivor.id, duplicate.id, survivor.pipeline_id, duplicate.reference_code, survivor.reference_code],
  )
  await update(
    'inboundMessages',
    `UPDATE crm_inbound_messages SET contact_id = $1::uuid
     WHERE pipeline_id = $3::uuid AND contact_id = $2::uuid`,
  )
  await update(
    'inboundMessageLinks',
    `UPDATE crm_inbound_message_links link
     SET aggregate_id = $1::uuid
     FROM crm_inbound_messages message
     WHERE message.id = link.inbound_message_id
       AND message.pipeline_id = $3::uuid
       AND link.aggregate_type IN ('contact', 'contacts', 'crm_contacts')
       AND link.aggregate_id = $2::uuid`,
  )
  await update(
    'quickBooksLinks',
    `UPDATE quickbooks_crm_links SET crm_record_id = $1::uuid, updated_at = now()
     WHERE pipeline_id = $3::uuid
       AND crm_entity_type = 'contact'
       AND crm_record_id = $2::uuid`,
  )
  const sourceAliases = await client.query(
    `UPDATE crm_contact_source_aliases
     SET contact_id = $1::uuid
     WHERE pipeline_id = $3::uuid AND contact_id = $2::uuid`,
    [survivor.id, duplicate.id, survivor.pipeline_id],
  )
  counts.existingSourceAliases = sourceAliases.rowCount || 0

  const actions = await client.query(
    `SELECT id::text, aggregate_type, aggregate_id, reference_code, payload
     FROM crm_integration_actions
     WHERE pipeline_id = $1::uuid
       AND status IN ('queued', 'failed')
       AND (
         reference_code = $2
         OR (aggregate_type IN ('contact', 'contacts', 'crm_contacts') AND aggregate_id = $3)
         OR payload::text LIKE '%' || $2 || '%'
         OR payload::text LIKE '%' || $3 || '%'
         OR ($4::text IS NOT NULL AND payload::text LIKE '%' || $4 || '%')
       )
     FOR UPDATE`,
    [survivor.pipeline_id, duplicate.reference_code, duplicate.id, duplicate.suitecrm_id],
  )
  const replacements = new Map([
    [duplicate.id, survivor.id],
    [duplicate.reference_code, survivor.reference_code],
    ...(duplicate.suitecrm_id && survivor.suitecrm_id
      ? [[duplicate.suitecrm_id, survivor.suitecrm_id]]
      : []),
  ])
  for (const action of actions.rows) {
    const payload = replaceExactStrings(action.payload, replacements)
    await client.query(
      `UPDATE crm_integration_actions
       SET aggregate_id = CASE
           WHEN aggregate_type IN ('contact', 'contacts', 'crm_contacts') AND aggregate_id = $2
             THEN $3
           ELSE aggregate_id
         END,
         reference_code = CASE WHEN reference_code = $4 THEN $5 ELSE reference_code END,
         payload = $6::jsonb,
         updated_at = now()
       WHERE id = $1::uuid`,
      [
        action.id,
        duplicate.id,
        survivor.id,
        duplicate.reference_code,
        survivor.reference_code,
        JSON.stringify(payload),
      ],
    )
  }
  counts.integrationActions = actions.rowCount || 0

  const boardCards = await client.query(
    `DELETE FROM crm_board_cards
     WHERE pipeline_id = $1::uuid
       AND entity_type = 'contacts'
       AND entity_id = $2::uuid`,
    [survivor.pipeline_id, duplicate.id],
  )
  counts.boardCards = boardCards.rowCount || 0

  const shortLinks = await client.query(
    `UPDATE short_links
     SET destination_url = replace(
           destination_url,
           '/crm/' || $1,
           '/crm/' || $2
         ),
       tags = ARRAY(
         SELECT DISTINCT tag
         FROM unnest(tags || ARRAY['crm-alias', $1, $2]::text[]) tag
       ),
       deleted_at = NULL,
       disabled_at = NULL,
       updated_at = now()
     WHERE source_app = 'clawpilot-crm'
       AND slug = ANY(ARRAY[$1, 'mail-' || $1]::text[])`,
    [duplicate.reference_code, survivor.reference_code],
  )
  counts.shortLinks = shortLinks.rowCount || 0
  return counts
}

async function recordSourceAliases(client, survivor, duplicate, actorEmail) {
  const candidates = [
    {
      sourceKey: survivor.source_key,
      kind: 'source',
      sourceSheetId: survivor.source_sheet_id,
      sourceRowNumber: survivor.source_row_number,
      payload: asObject(survivor.source_payload),
    },
    {
      sourceKey: survivor.identity_key,
      kind: 'former_identity',
      sourceSheetId: survivor.source_sheet_id,
      sourceRowNumber: survivor.source_row_number,
      payload: asObject(survivor.source_payload),
    },
    {
      sourceKey: asObject(survivor.source_payload)['ClawPilot Record ID'],
      kind: 'source',
      sourceSheetId: survivor.source_sheet_id,
      sourceRowNumber: survivor.source_row_number,
      payload: asObject(survivor.source_payload),
    },
    {
      sourceKey: duplicate.source_key,
      kind: 'merged_contact',
      sourceSheetId: duplicate.source_sheet_id,
      sourceRowNumber: duplicate.source_row_number,
      payload: asObject(duplicate.source_payload),
    },
    {
      sourceKey: duplicate.identity_key,
      kind: 'former_identity',
      sourceSheetId: duplicate.source_sheet_id,
      sourceRowNumber: duplicate.source_row_number,
      payload: asObject(duplicate.source_payload),
    },
    {
      sourceKey: asObject(duplicate.source_payload)['ClawPilot Record ID'],
      kind: 'merged_contact',
      sourceSheetId: duplicate.source_sheet_id,
      sourceRowNumber: duplicate.source_row_number,
      payload: asObject(duplicate.source_payload),
    },
  ]
    .map((candidate) => ({ ...candidate, sourceKey: clean(candidate.sourceKey) }))
    .filter((candidate) => candidate.sourceKey)
  const unique = new Map()
  for (const candidate of candidates) {
    const existing = unique.get(candidate.sourceKey)
    if (!existing || candidate.kind === 'merged_contact') unique.set(candidate.sourceKey, candidate)
  }
  const keys = [...unique.keys()]
  if (keys.length === 0) throw new Error('Contacts have no source identities to preserve')
  const conflicts = await client.query(
    `SELECT source_key, contact_id::text
     FROM crm_contact_source_aliases
     WHERE pipeline_id = $1::uuid
       AND source_key = ANY($2::text[])
       AND contact_id <> ALL($3::uuid[])`,
    [survivor.pipeline_id, keys, [survivor.id, duplicate.id]],
  )
  if (conflicts.rowCount > 0) {
    throw new Error(
      `Source identity is already assigned to another Contact: ${
        conflicts.rows.map((row) => row.source_key).join(', ')
      }`,
    )
  }
  for (const candidate of unique.values()) {
    await client.query(
      `INSERT INTO crm_contact_source_aliases (
         pipeline_id, source_key, contact_id, alias_kind, source_sheet_id,
         source_row_number, source_payload, created_by, created_at
       )
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8, now())
       ON CONFLICT (pipeline_id, source_key) DO UPDATE SET
         contact_id = EXCLUDED.contact_id`,
      [
        survivor.pipeline_id,
        candidate.sourceKey,
        survivor.id,
        candidate.kind,
        candidate.sourceSheetId,
        candidate.sourceRowNumber,
        JSON.stringify(candidate.payload),
        actorEmail,
      ],
    )
  }
  return keys.length
}

function contactSuiteCrmPayload(contact) {
  return {
    entity: 'contacts',
    pipelineId: contact.pipeline_id,
    localId: contact.id,
    suiteCrmId: contact.suitecrm_id,
    attributes: {
      global_id_c: contact.reference_code,
      first_name: clean(contact.first_name),
      last_name: clean(contact.last_name) || clean(contact.full_name),
      title: clean(contact.job_title),
      email1: clean(contact.email),
      phone_work: clean(contact.phone_work),
      phone_mobile: clean(contact.phone_mobile),
      primary_address_street: clean(contact.primary_address_street),
      primary_address_city: clean(contact.primary_address_city),
      primary_address_state: clean(contact.primary_address_state),
      primary_address_postalcode: clean(contact.primary_address_postal_code),
      primary_address_country: clean(contact.primary_address_country),
      account_id: clean(contact.organization_suitecrm_id),
      ...(contact.owner_user_reference_code
        ? { assigned_user_id: clean(contact.owner_suitecrm_user_id) }
        : {}),
      description: clean(contact.description),
    },
  }
}

async function supersedeStaleOutbox(client, survivor, duplicate, affected) {
  const aggregates = [
    { aggregateType: 'crm_contacts', aggregateId: survivor.id },
    { aggregateType: 'crm_contacts', aggregateId: duplicate.id },
    ...affected.map((item) => ({
      aggregateType: item.aggregate_type,
      aggregateId: item.aggregate_id,
    })),
  ]
  const result = await client.query(
    `UPDATE sync_outbox
     SET status = 'dead',
       last_error = 'Superseded by guarded CRM Contact merge',
       processed_at = now(),
       locked_at = NULL,
       lock_token = NULL,
       updated_at = now()
     WHERE target_system = 'suitecrm'
       AND status IN ('queued', 'failed')
       AND (aggregate_type, aggregate_id) IN (
         SELECT item->>'aggregateType', item->>'aggregateId'
         FROM jsonb_array_elements($1::jsonb) item
       )`,
    [JSON.stringify(aggregates)],
  )
  return result.rowCount || 0
}

async function queueSuiteCrmItem(
  client,
  { aggregateType, aggregateId, operation, payload, idempotencyKey, held = false },
) {
  const result = await client.query(
    `INSERT INTO sync_outbox (
       aggregate_type, aggregate_id, operation, target_system, payload, status,
       attempts, idempotency_key, created_at, available_at, updated_at
     )
     VALUES ($1, $2, $3, 'suitecrm', $4::jsonb, 'queued', 0, $5, now(),
       CASE WHEN $6::boolean THEN 'infinity'::timestamptz ELSE now() END, now())
     ON CONFLICT (target_system, idempotency_key)
     WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING id::text`,
    [aggregateType, aggregateId, operation, JSON.stringify(payload), idempotencyKey, held],
  )
  if (!result.rows[0]) throw new Error(`Outbox idempotency key already exists: ${idempotencyKey}`)
  return result.rows[0].id
}

async function queueOrderedSuiteCrmWork(client, survivor, duplicate, affected) {
  const outbox = {
    survivor: null,
    dependents: [],
    duplicateDelete: null,
  }
  if (!survivor.suitecrm_id) return outbox
  outbox.survivor = await queueSuiteCrmItem(client, {
    aggregateType: 'crm_contacts',
    aggregateId: survivor.id,
    operation: 'upsert_record',
    payload: contactSuiteCrmPayload(survivor),
    idempotencyKey: `crm-contact-merge:survivor:v1:${duplicate.id}:${survivor.id}`,
  })
  for (const aggregate of affected) {
    const id = await queueSuiteCrmItem(client, {
      aggregateType: aggregate.aggregate_type,
      aggregateId: aggregate.aggregate_id,
      operation: aggregate.operation,
      payload: aggregate.payload,
      idempotencyKey: `crm-contact-merge:relationship:v1:${duplicate.id}:${aggregate.aggregate_type}:${aggregate.aggregate_id}`,
      held: true,
    })
    await client.query(
      `INSERT INTO crm_contact_merge_outbox_dependencies (
         dependent_outbox_id, prerequisite_outbox_id
       )
       VALUES ($1::uuid, $2::uuid)`,
      [id, outbox.survivor],
    )
    outbox.dependents.push({
      id,
      aggregateType: aggregate.aggregate_type,
      aggregateId: aggregate.aggregate_id,
      sourceOutboxId: aggregate.source_outbox_id,
    })
  }
  if (duplicate.suitecrm_id) {
    outbox.duplicateDelete = await queueSuiteCrmItem(client, {
      aggregateType: 'crm_contacts',
      aggregateId: duplicate.id,
      operation: 'delete_record',
      payload: {
        entity: 'contacts',
        pipelineId: duplicate.pipeline_id,
        localId: duplicate.id,
        suiteCrmId: duplicate.suitecrm_id,
        attributes: {},
      },
      idempotencyKey: `crm-contact-merge:delete:v1:${duplicate.id}:${survivor.id}`,
      held: true,
    })
    const prerequisites = outbox.dependents.length > 0
      ? outbox.dependents.map((item) => item.id)
      : [outbox.survivor]
    for (const prerequisite of prerequisites) {
      await client.query(
        `INSERT INTO crm_contact_merge_outbox_dependencies (
           dependent_outbox_id, prerequisite_outbox_id
         )
         VALUES ($1::uuid, $2::uuid)`,
        [outbox.duplicateDelete, prerequisite],
      )
    }
  }
  return outbox
}

async function recordPublicAlias(client, survivor, duplicate, actorEmail, reason) {
  await client.query(
    `INSERT INTO crm_reference_aliases (
       alias_code, canonical_code, reason, created_by, created_at
     )
     VALUES ($1, $2, $3, $4, now())`,
    [duplicate.reference_code, survivor.reference_code, reason, actorEmail],
  )
  await client.query(
    `UPDATE crm_reference_registry
     SET status = 'alias', retired_at = COALESCE(retired_at, now())
     WHERE reference_code = $1`,
    [duplicate.reference_code],
  )
}

async function performMerge(client, options) {
  await assertMigrationInstalled(client)
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['10s'])
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, ['60s'])
  const lockKey = [options.survivor, options.duplicate].sort().join(':')
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`crm-contact-merge:${lockKey}`])

  const contacts = await readContacts(client, options.survivor, options.duplicate)
  const byReference = new Map(contacts.rows.map((contact) => [contact.reference_code, contact]))
  const survivor = byReference.get(options.survivor)
  const duplicate = byReference.get(options.duplicate)
  if (survivor && !duplicate) {
    const prior = await readAlreadyMerged(client, options.survivor, options.duplicate)
    if (prior) return { alreadyMerged: true, prior }
  }
  if (!survivor || !duplicate) {
    const missing = [
      !survivor ? options.survivor : null,
      !duplicate ? options.duplicate : null,
    ].filter(Boolean)
    throw new Error(`CRM Contact reference not found: ${missing.join(', ')}`)
  }

  validateContactPair(survivor, duplicate)
  await validateAppUserReferences(client, survivor, duplicate)
  await validateReferenceState(client, survivor, duplicate)
  await validateForeignKeyCoverage(client, duplicate)

  const actorEmail = options.apply
    ? normalizeEmail(options.actor)
    : normalizeEmail(options.actor || survivor.updated_by || survivor.created_by || survivor.pipeline_owner_email)
  if (!actorEmail) throw new Error('No valid audit actor could be resolved')
  const actor = await client.query(
    `SELECT email FROM app_users WHERE email = $1 AND status = 'active' LIMIT 1`,
    [actorEmail],
  )
  if (actor.rowCount !== 1) throw new Error(`Audit actor is not an active ClawPilot user: ${actorEmail}`)

  const affected = await collectAffectedAggregates(client, duplicate)
  await assertNoInFlightWork(client, survivor, duplicate, affected)
  const dependentWork = await prepareDependentOutbox(client, survivor, duplicate, affected)
  const sourceAliasCount = await recordSourceAliases(client, survivor, duplicate, actorEmail)
  const updatedSurvivor = await updateSurvivor(client, survivor, duplicate, actorEmail)
  const rewiredCounts = await rewireContactReferences(client, survivor, duplicate)
  rewiredCounts.sourceIdentities = sourceAliasCount
  const staleOutboxItems = await supersedeStaleOutbox(client, survivor, duplicate, affected)
  rewiredCounts.supersededOutboxItems = staleOutboxItems
  const outbox = await queueOrderedSuiteCrmWork(client, updatedSurvivor, duplicate, dependentWork)

  await recordPublicAlias(client, survivor, duplicate, actorEmail, options.reason)
  const tombstone = await client.query(
    `INSERT INTO crm_contact_merges (
       pipeline_id, survivor_contact_id, duplicate_contact_id,
       survivor_reference_code, duplicate_reference_code,
       survivor_suitecrm_id, duplicate_suitecrm_id, duplicate_snapshot,
       rewired_counts, survivor_outbox_id, duplicate_delete_outbox_id,
       merged_by, reason, merged_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
       $10::uuid, $11::uuid, $12, $13, now()
     )
     RETURNING id::text, merged_at::text`,
    [
      survivor.pipeline_id,
      survivor.id,
      duplicate.id,
      survivor.reference_code,
      duplicate.reference_code,
      survivor.suitecrm_id,
      duplicate.suitecrm_id,
      JSON.stringify(duplicate),
      JSON.stringify(rewiredCounts),
      outbox.survivor,
      outbox.duplicateDelete,
      actorEmail,
      options.reason,
    ],
  )

  const deleted = await client.query(
    `DELETE FROM crm_contacts
     WHERE pipeline_id = $1::uuid AND id = $2::uuid
     RETURNING id::text`,
    [duplicate.pipeline_id, duplicate.id],
  )
  if (deleted.rowCount !== 1) throw new Error('Duplicate Contact was not deleted')

  await client.query(
    `INSERT INTO audit_events (
       actor, event_type, aggregate_type, aggregate_id, payload, created_at
     )
     VALUES ($1, 'crm.contact.merged_by_operator', 'crm_contacts', $2, $3::jsonb, now())`,
    [
      actorEmail,
      survivor.id,
      JSON.stringify({
        pipelineId: survivor.pipeline_id,
        survivorReferenceCode: survivor.reference_code,
        duplicateReferenceCode: duplicate.reference_code,
        duplicateContactId: duplicate.id,
        rewiredCounts,
        outbox,
        reason: options.reason,
      }),
    ],
  )

  return {
    alreadyMerged: false,
    mergeId: tombstone.rows[0].id,
    mergedAt: tombstone.rows[0].merged_at,
    actorEmail,
    pipelineId: survivor.pipeline_id,
    survivor: {
      id: survivor.id,
      referenceCode: survivor.reference_code,
      suiteCrmId: survivor.suitecrm_id,
      fullName: updatedSurvivor.full_name,
      email: updatedSurvivor.email,
      jobTitle: updatedSurvivor.job_title,
    },
    duplicate: {
      id: duplicate.id,
      referenceCode: duplicate.reference_code,
      suiteCrmId: duplicate.suitecrm_id,
      fullName: duplicate.full_name,
      email: duplicate.email,
      jobTitle: duplicate.job_title,
    },
    affectedSuiteCrmAggregates: dependentWork.map((item) => ({
      aggregateType: item.aggregate_type,
      aggregateId: item.aggregate_id,
      operation: item.operation,
    })),
    rewiredCounts,
    outbox,
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    console.error(usage())
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(usage())
    return
  }
  options.survivor = clean(options.survivor).toLowerCase()
  options.duplicate = clean(options.duplicate).toLowerCase()
  options.actor = normalizeEmail(options.actor)
  options.reason = clean(options.reason)
  if (!CONTACT_REFERENCE.test(options.survivor)) throw new Error('--survivor must be a gc reference')
  if (!CONTACT_REFERENCE.test(options.duplicate)) throw new Error('--duplicate must be a gc reference')
  if (options.survivor === options.duplicate) throw new Error('Survivor and duplicate references must differ')
  if (!options.reason || options.reason.length > 500) throw new Error('--reason must contain 1 to 500 characters')
  const expectedConfirmation = confirmationToken(options.survivor, options.duplicate)
  if (options.apply) {
    if (!options.actor) throw new Error('--actor is required with --apply')
    if (options.confirm !== expectedConfirmation) {
      throw new Error(`Mutation requires --confirm ${expectedConfirmation}`)
    }
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

  const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
    query_timeout: 65000,
    application_name: 'clawpilot-merge-crm-contacts',
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const result = await performMerge(client, options)
    if (options.apply) await client.query('COMMIT')
    else await client.query('ROLLBACK')
    console.log(JSON.stringify({
      dryRun: !options.apply,
      committed: options.apply,
      expectedConfirmation,
      ...result,
    }, null, 2))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(`merge-crm-contacts failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
