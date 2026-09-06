#!/usr/bin/env node

/**
 * Offline, receipt-bound PostgreSQL workspace retirement.
 *
 * This command never calls SuiteCRM, a commerce provider, a carrier, Google,
 * or any other external system.  With no explicit command it is plan-only.
 * Apply requires the private plan artifact, its exact SHA-256 digest, the same
 * exact target allowlist, and independent Railway/database endpoint evidence.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SCRIPT_VERSION = 'workspace-tenant-retirement-v1'
export const PLAN_FORMAT = 'clawpilot-workspace-tenant-retirement-plan-v1'
export const RECEIPT_FORMAT = 'clawpilot-workspace-tenant-retirement-receipt-v1'
export const PRODUCTION_DATABASE_IDENTITY = '0474a18c-649c-491b-bea1-7da006d21d81'
export const PRODUCTION_RAILWAY_PROJECT_ID = 'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const PRODUCTION_RAILWAY_ENVIRONMENT_ID = '058ce52f-1d3b-44bb-afe2-0df2bf24efb9'
export const CONFIRMED_OPERATOR_EMAIL = 'jarrett@suburbiasandwichco.com'
export const PLAN_MAX_AGE_MS = 30 * 60 * 1000
export const PLAN_MAX_FUTURE_SKEW_MS = 5 * 1000

export const APPROVED_TARGETS = Object.freeze([
  Object.freeze({
    key: 'ag-alchemy',
    organizationId: '33785418-9927-4e10-a492-d3a44b9b6f21',
    referenceCode: 'ga42g1438l4j2s',
    name: 'AG Alchemy',
  }),
  Object.freeze({
    key: 'french-florist',
    organizationId: '3b9ceada-a4ff-4363-8e78-6069dee76328',
    referenceCode: 'gakrnoh15krp9n',
    name: 'French Florist',
  }),
  Object.freeze({
    key: 'test-pro-bakery-bites',
    organizationId: 'c8fcf491-cf8c-469a-b03c-0026a762752c',
    referenceCode: 'gac10cb46e3rpl',
    name: 'Test Pro Bakery Bites',
  }),
])

const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const REFERENCE = /^g[a-z]{1,4}(?:[0-9]{7}|[0-9a-v]{12})$/u
const DIRECT_SCOPE_COLUMNS = new Set([
  'organization_id',
  'workspace_organization_id',
  'organization_root_id',
  'root_organization_id',
])
const PRESERVED_TABLES = new Set([
  'app_settings',
  'app_users',
  'audit_events',
  'crm_reference_number_registry',
  'crm_reference_registry',
  'global_reference_entity_types',
  'schema_migrations',
  'short_links',
  'workspace_tenant_retirement_receipts',
])
// These preserved relations have a dedicated, reviewed retirement path. Their
// restrictive FKs are safe because apply tombstones/detaches them while all
// affected relations remain ACCESS EXCLUSIVE locked.
const SPECIAL_PRESERVED_FK_HANDLERS = new Set(['short_links'])
// Preserved audit history remains intentionally tenant-addressable by its
// historical UUID. The immutable retirement receipt records that exception.
const POST_DELETE_UUID_SCAN_EXCLUSIONS = new Set(PRESERVED_TABLES)
const DELETE_ACTION = Object.freeze({
  a: 'no_action',
  r: 'restrict',
  c: 'cascade',
  n: 'set_null',
  d: 'set_default',
})

function fail(message) {
  throw new Error(message)
}

function text(value) {
  return String(value ?? '').trim()
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function canonicalize(value) {
  if (Buffer.isBuffer(value)) {
    return { $binarySha256: sha256(value), $binaryBytes: value.length }
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    )
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function digest(value) {
  return sha256(canonicalJson(value))
}

export function manifestDigest(manifest) {
  const copy = structuredClone(manifest)
  delete copy.manifestDigest
  return digest(copy)
}

export function databaseEndpointFingerprint(connectionString) {
  let parsed
  try {
    parsed = new URL(text(connectionString))
  } catch {
    fail('DATABASE_URL must be a PostgreSQL URL')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail('DATABASE_URL must be a PostgreSQL URL')
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''))
  if (!database || !parsed.hostname) fail('DATABASE_URL must include a host and database')
  return digest({
    protocol: parsed.protocol.toLowerCase(),
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || '5432',
    database,
    user: decodeURIComponent(parsed.username || ''),
  })
}

export function quoteIdentifier(value) {
  const normalized = text(value)
  if (!normalized || normalized.includes('\u0000')) fail('Unsafe SQL identifier')
  return `"${normalized.replaceAll('"', '""')}"`
}

function qualified(relation) {
  return `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`
}

function requireSingle(values, flag) {
  if (values.length !== 1 || !text(values[0])) fail(`${flag} requires exactly one value`)
  return text(values[0])
}

function validatedEmail(value, label) {
  const email = text(value).toLowerCase()
  if (!EMAIL.test(email) || email.length > 320) fail(`${label} is invalid`)
  return email
}

function exactTargetValue(target) {
  return `${target.organizationId}|${target.referenceCode}|${target.name}`
}

export function validateTargetArguments(values) {
  if (values.length !== APPROVED_TARGETS.length) {
    fail(`Exactly ${APPROVED_TARGETS.length} --target values are required`)
  }
  const supplied = values.map((value) => {
    const parts = String(value).split('|')
    if (parts.length !== 3) {
      fail('--target must use organization-uuid|reference-code|exact-name')
    }
    return {
      organizationId: text(parts[0]).toLowerCase(),
      referenceCode: text(parts[1]).toLowerCase(),
      name: text(parts[2]),
    }
  })
  const byId = new Map(supplied.map((target) => [target.organizationId, target]))
  if (byId.size !== supplied.length) fail('--target organization UUIDs must be unique')
  for (const approved of APPROVED_TARGETS) {
    const target = byId.get(approved.organizationId)
    if (!target || canonicalJson(target) !== canonicalJson({
      organizationId: approved.organizationId,
      referenceCode: approved.referenceCode,
      name: approved.name,
    })) {
      fail(`Target allowlist mismatch; required: ${exactTargetValue(approved)}`)
    }
  }
  return APPROVED_TARGETS.map((target) => ({ ...target }))
}

function parseFlags(args, allowed) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!allowed.has(flag)) fail(`Unsupported argument: ${flag || '(empty)'}`)
    if (value === undefined || String(value).startsWith('--')) {
      fail(`${flag} requires a value`)
    }
    const existing = values.get(flag) || []
    existing.push(value)
    values.set(flag, existing)
  }
  return values
}

export function parseArguments(argv) {
  const args = [...argv]
  const explicit = ['plan', 'apply', 'verify'].includes(args[0]) ? args.shift() : null
  const command = explicit || 'plan'
  const common = [
    '--actor', '--environment', '--railway-project-id',
    '--railway-environment-id', '--target',
  ]
  const allowed = new Set(command === 'plan'
    ? [...common, '--output']
    : command === 'apply'
      ? [
          ...common, '--manifest', '--confirm-digest', '--receipt-output',
          '--acknowledge-suitecrm-retained',
        ]
      : [...common, '--manifest', '--confirm-digest'])
  const flags = parseFlags(args, allowed)
  const actor = validatedEmail(requireSingle(flags.get('--actor') || [], '--actor'), '--actor')
  if (actor !== CONFIRMED_OPERATOR_EMAIL) {
    fail(`--actor must be the confirmed production operator ${CONFIRMED_OPERATOR_EMAIL}`)
  }
  const environment = requireSingle(flags.get('--environment') || [], '--environment')
  if (environment !== 'production') fail('--environment must equal production')
  const railwayProjectId = requireSingle(
    flags.get('--railway-project-id') || [], '--railway-project-id',
  ).toLowerCase()
  const railwayEnvironmentId = requireSingle(
    flags.get('--railway-environment-id') || [], '--railway-environment-id',
  ).toLowerCase()
  if (railwayProjectId !== PRODUCTION_RAILWAY_PROJECT_ID) {
    fail('--railway-project-id does not match the approved ClawPilot project')
  }
  if (railwayEnvironmentId !== PRODUCTION_RAILWAY_ENVIRONMENT_ID) {
    fail('--railway-environment-id does not match the approved production environment')
  }
  const targets = validateTargetArguments(flags.get('--target') || [])
  const commonResult = {
    command,
    actor,
    environment,
    railwayProjectId,
    railwayEnvironmentId,
    targets,
  }
  if (command === 'plan') {
    return {
      ...commonResult,
      output: path.resolve(requireSingle(flags.get('--output') || [], '--output')),
    }
  }
  const confirmDigest = requireSingle(
    flags.get('--confirm-digest') || [], '--confirm-digest',
  ).toLowerCase()
  if (!SHA256.test(confirmDigest)) fail('--confirm-digest must be a SHA-256 digest')
  const result = {
    ...commonResult,
    manifest: path.resolve(requireSingle(flags.get('--manifest') || [], '--manifest')),
    confirmDigest,
  }
  if (command === 'apply') {
    const acknowledgement = flags.get('--acknowledge-suitecrm-retained') || []
    return {
      ...result,
      receiptOutput: path.resolve(requireSingle(
        flags.get('--receipt-output') || [], '--receipt-output',
      )),
      suiteCrmAcknowledgement: acknowledgement.length
        ? requireSingle(acknowledgement, '--acknowledge-suitecrm-retained').toLowerCase()
        : null,
    }
  }
  return result
}

function ensureSafeOutputPath(output) {
  if (fs.existsSync(output)) fail(`Refusing to overwrite existing file: ${output}`)
  const parent = path.dirname(output)
  if (!fs.statSync(parent).isDirectory()) fail(`Output parent is not a directory: ${parent}`)
}

function writePrivateJson(output, value) {
  ensureSafeOutputPath(output)
  const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, output)
    fs.chmodSync(output, 0o600)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

function readPrivateJson(input, label) {
  const stat = fs.statSync(input)
  if (!stat.isFile()) fail(`${label} is not a file`)
  if ((stat.mode & 0o077) !== 0) fail(`${label} must not be accessible by group or other users`)
  return JSON.parse(fs.readFileSync(input, 'utf8'))
}

export function assertRuntimeEnvironment(options, environment) {
  if (!environment.DATABASE_URL) fail('DATABASE_URL is required')
  if (text(environment.RAILWAY_PROJECT_ID).toLowerCase() !== options.railwayProjectId) {
    fail('Runtime RAILWAY_PROJECT_ID does not match the independently supplied project')
  }
  if (text(environment.RAILWAY_ENVIRONMENT_ID).toLowerCase() !== options.railwayEnvironmentId) {
    fail('Runtime RAILWAY_ENVIRONMENT_ID does not match the independently supplied environment')
  }
  if (text(environment.RAILWAY_ENVIRONMENT_NAME).toLowerCase() !== 'production') {
    fail('Runtime RAILWAY_ENVIRONMENT_NAME must equal production')
  }
  const expectedEndpoint = text(
    environment.CLAWPILOT_TENANT_RETIRE_DATABASE_ENDPOINT_SHA256,
  ).toLowerCase()
  if (!SHA256.test(expectedEndpoint)) {
    fail('CLAWPILOT_TENANT_RETIRE_DATABASE_ENDPOINT_SHA256 is required')
  }
  const observedEndpoint = databaseEndpointFingerprint(environment.DATABASE_URL)
  if (observedEndpoint !== expectedEndpoint) {
    fail('DATABASE_URL does not match the independently reviewed endpoint fingerprint')
  }
  return { endpointSha256: observedEndpoint }
}

function loadPg() {
  const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
  return requireFromApp('pg')
}

function poolFor(environment) {
  const { Pool } = loadPg()
  const sslMode = text(environment.PGSSLMODE || environment.DATABASE_SSL).toLowerCase()
  return new Pool({
    connectionString: environment.DATABASE_URL,
    ssl: sslMode === 'disable' ? undefined : { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10 * 60_000,
    statement_timeout: 10 * 60_000,
    application_name: SCRIPT_VERSION,
  })
}

async function databaseIdentity(client) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
            current_user AS database_user,
            value->>'id' AS database_identity
     FROM app_settings
     WHERE key = 'deployment.database.identity'
     LIMIT 1`,
  )
  const row = result.rows[0]
  if (!row || row.database_identity !== PRODUCTION_DATABASE_IDENTITY) {
    fail('Connected database is not the verified ClawPilot production database')
  }
  return row
}

async function assertReceiptMigration(client) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM schema_migrations
       WHERE filename = '0360_workspace_tenant_retirement_receipts.sql'
     ) AS migrated,
     to_regclass('public.workspace_tenant_retirement_receipts') IS NOT NULL AS present`,
  )
  if (result.rows[0]?.migrated !== true || result.rows[0]?.present !== true) {
    fail('Migration 0360_workspace_tenant_retirement_receipts.sql is required')
  }
}

async function loadCatalog(client) {
  const relationsResult = await client.query(
    `SELECT relation.oid::text AS oid, namespace.nspname AS schema,
            relation.relname AS name, relation.relkind::text AS kind
     FROM pg_catalog.pg_class relation
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind = 'r'
     ORDER BY namespace.nspname, relation.relname`,
  )
  const columnsResult = await client.query(
    `SELECT relation.oid::text AS table_oid, attribute.attname AS name,
            attribute.atttypid::text AS type_oid,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type
     FROM pg_catalog.pg_class relation
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
     WHERE namespace.nspname = 'public'
       AND relation.relkind = 'r'
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY relation.oid, attribute.attnum`,
  )
  const foreignKeysResult = await client.query(
    `SELECT constraint_row.oid::text AS oid,
            constraint_row.conname AS name,
            child.oid::text AS child_oid,
            parent.oid::text AS parent_oid,
            constraint_row.confdeltype::text AS delete_action,
            constraint_row.condeferrable AS deferrable,
            constraint_row.condeferred AS initially_deferred,
            array_agg(child_attribute.attname::text ORDER BY child_key.ordinality) AS child_columns,
            array_agg(parent_attribute.attname::text ORDER BY child_key.ordinality) AS parent_columns
     FROM pg_catalog.pg_constraint constraint_row
     JOIN pg_catalog.pg_class child ON child.oid = constraint_row.conrelid
     JOIN pg_catalog.pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
     JOIN pg_catalog.pg_class parent ON parent.oid = constraint_row.confrelid
     JOIN pg_catalog.pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
     CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY
       AS child_key(attribute_number, ordinality)
     JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY
       AS parent_key(attribute_number, ordinality)
       ON parent_key.ordinality = child_key.ordinality
     JOIN pg_catalog.pg_attribute child_attribute
       ON child_attribute.attrelid = child.oid
      AND child_attribute.attnum = child_key.attribute_number
     JOIN pg_catalog.pg_attribute parent_attribute
       ON parent_attribute.attrelid = parent.oid
      AND parent_attribute.attnum = parent_key.attribute_number
     WHERE constraint_row.contype = 'f'
       AND child_namespace.nspname = 'public'
       AND parent_namespace.nspname = 'public'
     GROUP BY constraint_row.oid, constraint_row.conname, child.oid, parent.oid,
              constraint_row.confdeltype, constraint_row.condeferrable,
              constraint_row.condeferred
     ORDER BY child.oid, parent.oid, constraint_row.conname`,
  )
  const triggersResult = await client.query(
    `SELECT trigger_row.oid::text AS oid, trigger_row.tgrelid::text AS table_oid,
            trigger_row.tgname AS name, trigger_row.tgenabled AS enabled,
            pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition
     FROM pg_catalog.pg_trigger trigger_row
     JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgconstraint = 0
       AND (trigger_row.tgtype::integer & 8) = 8
     ORDER BY trigger_row.tgrelid, trigger_row.tgname`,
  )
  const relations = relationsResult.rows.map((row) => ({
    ...row,
    columns: columnsResult.rows
      .filter((column) => column.table_oid === row.oid)
      .map((column) => ({ name: column.name, typeOid: column.type_oid, type: column.type })),
  }))
  const relationByOid = new Map(relations.map((relation) => [relation.oid, relation]))
  const foreignKeys = foreignKeysResult.rows.map((row) => ({
    ...row,
    childColumns: row.child_columns,
    parentColumns: row.parent_columns,
    deleteAction: DELETE_ACTION[row.delete_action] || row.delete_action,
  }))
  const triggers = triggersResult.rows.map((row) => ({
    tableOid: row.table_oid,
    table: relationByOid.get(row.table_oid)?.name || null,
    name: row.name,
    enabled: row.enabled,
    definition: row.definition,
    definitionDigest: sha256(row.definition),
  }))
  const catalogProjection = {
    relations: relations.map((relation) => ({
      schema: relation.schema,
      name: relation.name,
      kind: relation.kind,
      columns: relation.columns,
    })),
    foreignKeys: foreignKeys.map((foreignKey) => ({
      name: foreignKey.name,
      child: relationByOid.get(foreignKey.child_oid)?.name,
      parent: relationByOid.get(foreignKey.parent_oid)?.name,
      childColumns: foreignKey.childColumns,
      parentColumns: foreignKey.parentColumns,
      deleteAction: foreignKey.deleteAction,
      deferrable: foreignKey.deferrable,
      initiallyDeferred: foreignKey.initially_deferred,
    })),
    deleteTriggers: triggers.map(({ table, name, enabled, definitionDigest }) => ({
      table, name, enabled, definitionDigest,
    })),
  }
  return {
    relations,
    relationByOid,
    foreignKeys,
    triggers,
    digest: digest(catalogProjection),
  }
}

async function exactTargets(client, targets) {
  const ids = targets.map((target) => target.organizationId)
  const result = await client.query(
    `SELECT id::text, reference_code, name, organization_type, parent_id::text
     FROM workspace_organizations
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [ids],
  )
  if (result.rows.length !== targets.length) {
    fail(`Expected ${targets.length} exact production scaffold organizations; found ${result.rows.length}`)
  }
  const byId = new Map(result.rows.map((row) => [row.id, row]))
  for (const expected of targets) {
    const observed = byId.get(expected.organizationId)
    if (!observed
      || observed.reference_code !== expected.referenceCode
      || observed.name !== expected.name) {
      fail(`Production scaffold identity mismatch for ${expected.key}`)
    }
  }
  return result.rows
}

async function assertOperatorOwnsTargets(client, actor, targets) {
  const result = await client.query(
    `SELECT organization_id::text, role, status
     FROM app_user_organization_memberships
     WHERE lower(user_email) = $1
       AND organization_id = ANY($2::uuid[])
     ORDER BY organization_id`,
    [actor, targets.map((target) => target.organizationId)],
  )
  if (result.rows.length !== targets.length
    || result.rows.some((row) => row.status !== 'active' || !['owner', 'admin'].includes(row.role))) {
    fail('Operator must hold one active owner/admin membership in every target')
  }
}

function relationSeedPredicate(relation) {
  const predicates = []
  for (const column of relation.columns) {
    if (column.typeOid === '2950' && DIRECT_SCOPE_COLUMNS.has(column.name)) {
      predicates.push(
        `candidate.${quoteIdentifier(column.name)} = ANY(scope_input.target_ids)`,
      )
    }
    if (column.typeOid === '2950' && column.name === 'pipeline_id') {
      predicates.push(
        `candidate.${quoteIdentifier(column.name)} = ANY(scope_input.pipeline_ids)`,
      )
    }
  }
  return predicates.length ? `(${predicates.join(' OR ')})` : null
}

async function pipelineIds(client, targets) {
  const result = await client.query(
    `SELECT id::text, name
     FROM pipeline_spaces
     WHERE workspace_organization_id = ANY($1::uuid[])
     ORDER BY id`,
    [targets.map((target) => target.organizationId)],
  )
  return result.rows
}

async function prepareScope(client, catalog, targets, pipelines) {
  await client.query('DROP TABLE IF EXISTS pg_temp.workspace_tenant_retirement_scope')
  await client.query(
    `CREATE TEMP TABLE workspace_tenant_retirement_scope (
       table_oid oid NOT NULL,
       row_tid text NOT NULL,
       PRIMARY KEY (table_oid, row_tid)
     ) ON COMMIT DROP`,
  )
  const targetIds = targets.map((target) => target.organizationId)
  const pipelineIdValues = pipelines.map((pipeline) => pipeline.id)
  for (const relation of catalog.relations) {
    if (PRESERVED_TABLES.has(relation.name)) continue
    const predicate = relationSeedPredicate(relation)
    if (!predicate) continue
    await client.query(
      `WITH scope_input AS (
         SELECT $1::uuid[] AS target_ids, $2::uuid[] AS pipeline_ids,
                $3::oid AS table_oid
       )
       INSERT INTO workspace_tenant_retirement_scope (table_oid, row_tid)
       SELECT scope_input.table_oid, candidate.ctid::text
       FROM ${qualified(relation)} candidate
       CROSS JOIN scope_input
       WHERE ${predicate}
       ON CONFLICT DO NOTHING`,
      [targetIds, pipelineIdValues, relation.oid],
    )
  }
  // The anchor is deliberately explicit even if a future schema renames its
  // tenancy column conventions.
  const workspace = catalog.relations.find((relation) => relation.name === 'workspace_organizations')
  if (!workspace) fail('workspace_organizations is missing from the runtime catalog')
  await client.query(
    `INSERT INTO workspace_tenant_retirement_scope (table_oid, row_tid)
     SELECT $2::oid, candidate.ctid::text
     FROM public.workspace_organizations candidate
     WHERE candidate.id = ANY($1::uuid[])
     ON CONFLICT DO NOTHING`,
    [targetIds, workspace.oid],
  )
  // Runtime FK closure catches tables that do not repeat a tenant or pipeline
  // column.  Preserved global/audit tables are never admitted to this scope.
  const maxRounds = Math.max(4, catalog.relations.length + 1)
  let converged = false
  for (let round = 0; round < maxRounds; round += 1) {
    let inserted = 0
    for (const foreignKey of catalog.foreignKeys) {
      const child = catalog.relationByOid.get(foreignKey.child_oid)
      const parent = catalog.relationByOid.get(foreignKey.parent_oid)
      if (!child || !parent || PRESERVED_TABLES.has(child.name)) continue
      const joins = foreignKey.childColumns.map((column, index) => (
        `child.${quoteIdentifier(column)} = parent.${quoteIdentifier(foreignKey.parentColumns[index])}`
      )).join(' AND ')
      const result = await client.query(
        `INSERT INTO workspace_tenant_retirement_scope (table_oid, row_tid)
         SELECT $1::oid, child.ctid::text
         FROM ${qualified(child)} child
         JOIN ${qualified(parent)} parent ON ${joins}
         JOIN workspace_tenant_retirement_scope selected_parent
           ON selected_parent.table_oid = $2::oid
          AND selected_parent.row_tid = parent.ctid::text
         ON CONFLICT DO NOTHING`,
        [child.oid, parent.oid],
      )
      inserted += result.rowCount || 0
    }
    if (inserted === 0) {
      converged = true
      break
    }
  }
  if (!converged) fail('Runtime FK scope did not converge')
  await seedAggregateReferences(client, catalog)
  return scopeSummary(client, catalog, targets)
}

async function seedAggregateReferences(client, catalog) {
  await client.query('DROP TABLE IF EXISTS pg_temp.workspace_tenant_retirement_identifiers')
  await client.query(
    `CREATE TEMP TABLE workspace_tenant_retirement_identifiers (
       value text PRIMARY KEY
     ) ON COMMIT DROP`,
  )
  for (const relation of catalog.relations) {
    const columns = relation.columns.filter((column) => (
      ['id', 'global_id', 'reference_code'].includes(column.name)
    ))
    for (const column of columns) {
      await client.query(
        `INSERT INTO workspace_tenant_retirement_identifiers (value)
         SELECT candidate.${quoteIdentifier(column.name)}::text
         FROM ${qualified(relation)} candidate
         JOIN workspace_tenant_retirement_scope selected
           ON selected.table_oid = $1::oid
          AND selected.row_tid = candidate.ctid::text
         WHERE candidate.${quoteIdentifier(column.name)} IS NOT NULL
         ON CONFLICT DO NOTHING`,
        [relation.oid],
      )
    }
  }
  const outbox = catalog.relations.find((relation) => relation.name === 'sync_outbox')
  if (outbox && !PRESERVED_TABLES.has(outbox.name)) {
    await client.query(
      `INSERT INTO workspace_tenant_retirement_scope (table_oid, row_tid)
       SELECT $1::oid, candidate.ctid::text
       FROM public.sync_outbox candidate
       JOIN workspace_tenant_retirement_identifiers identifier
         ON identifier.value = candidate.aggregate_id
       ON CONFLICT DO NOTHING`,
      [outbox.oid],
    )
  }
}

async function selectedCount(client, relation) {
  const result = await client.query(
    `SELECT count(*)::integer AS count
     FROM workspace_tenant_retirement_scope
     WHERE table_oid = $1::oid`,
    [relation.oid],
  )
  return Number(result.rows[0]?.count || 0)
}

async function selectedReferences(client, catalog) {
  const references = new Set()
  for (const relation of catalog.relations) {
    for (const column of relation.columns.filter((item) => (
      ['reference_code', 'global_id'].includes(item.name)
    ))) {
      const result = await client.query(
        `SELECT DISTINCT candidate.${quoteIdentifier(column.name)}::text AS value
         FROM ${qualified(relation)} candidate
         JOIN workspace_tenant_retirement_scope selected
           ON selected.table_oid = $1::oid
          AND selected.row_tid = candidate.ctid::text
         WHERE candidate.${quoteIdentifier(column.name)} IS NOT NULL
         ORDER BY value`,
        [relation.oid],
      )
      for (const row of result.rows) {
        if (REFERENCE.test(row.value)) references.add(row.value)
      }
    }
  }
  if (references.size === 0) fail('Target scope contains no permanent Global IDs')
  const registry = await client.query(
    `SELECT reference_code, canonical_code, status
     FROM crm_reference_registry
     WHERE reference_code = ANY($1::text[])
        OR canonical_code = ANY($1::text[])
     ORDER BY reference_code`,
    [[...references]],
  )
  const registered = new Set(registry.rows.map((row) => row.reference_code))
  for (const reference of references) {
    if (!registered.has(reference)) fail(`Global ID is absent from the permanent registry: ${reference}`)
  }
  return registry.rows
}

async function selectedSuiteCrmRecords(client, catalog) {
  const records = []
  for (const relation of catalog.relations) {
    if (!relation.columns.some((column) => column.name === 'suitecrm_id')) continue
    const idColumn = relation.columns.find((column) => column.name === 'id')?.name
    const refColumn = relation.columns.find((column) => column.name === 'reference_code')?.name
    const result = await client.query(
      `SELECT candidate.suitecrm_id::text AS suitecrm_id,
              ${idColumn ? `candidate.${quoteIdentifier(idColumn)}::text` : 'NULL::text'} AS local_id,
              ${refColumn ? `candidate.${quoteIdentifier(refColumn)}::text` : 'NULL::text'} AS reference_code
       FROM ${qualified(relation)} candidate
       JOIN workspace_tenant_retirement_scope selected
         ON selected.table_oid = $1::oid
        AND selected.row_tid = candidate.ctid::text
       WHERE candidate.suitecrm_id IS NOT NULL
       ORDER BY candidate.suitecrm_id::text`,
      [relation.oid],
    )
    records.push(...result.rows.map((row) => ({
      table: relation.name,
      localId: row.local_id,
      referenceCode: row.reference_code,
      suiteCrmId: row.suitecrm_id,
    })))
  }
  return records.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
}

function deletionOrder(relations, foreignKeys) {
  const nodes = new Map(relations.map((relation) => [relation.oid, relation]))
  const edges = new Map([...nodes.keys()].map((oid) => [oid, new Set()]))
  const indegree = new Map([...nodes.keys()].map((oid) => [oid, 0]))
  for (const foreignKey of foreignKeys) {
    if (foreignKey.child_oid === foreignKey.parent_oid) continue
    if (!nodes.has(foreignKey.child_oid) || !nodes.has(foreignKey.parent_oid)) continue
    if (!edges.get(foreignKey.child_oid).has(foreignKey.parent_oid)) {
      edges.get(foreignKey.child_oid).add(foreignKey.parent_oid)
      indegree.set(foreignKey.parent_oid, indegree.get(foreignKey.parent_oid) + 1)
    }
  }
  const ready = [...nodes.keys()].filter((oid) => indegree.get(oid) === 0)
    .sort((left, right) => nodes.get(left).name.localeCompare(nodes.get(right).name))
  const ordered = []
  while (ready.length) {
    const oid = ready.shift()
    ordered.push(nodes.get(oid))
    for (const parent of edges.get(oid)) {
      indegree.set(parent, indegree.get(parent) - 1)
      if (indegree.get(parent) === 0) {
        ready.push(parent)
        ready.sort((left, right) => nodes.get(left).name.localeCompare(nodes.get(right).name))
      }
    }
  }
  const cycles = [...nodes.keys()]
    .filter((oid) => !ordered.some((relation) => relation.oid === oid))
    .map((oid) => nodes.get(oid).name)
    .sort()
  return { ordered, cycles }
}

export function computeDeletionOrder(relationNames, edges) {
  const relations = relationNames.map((name, index) => ({ oid: String(index + 1), name }))
  const byName = new Map(relations.map((relation) => [relation.name, relation]))
  return deletionOrder(relations, edges.map(([child, parent]) => ({
    child_oid: byName.get(child).oid,
    parent_oid: byName.get(parent).oid,
  })))
}

async function selfReferentialBlockers(client, catalog, selectedOids) {
  const blockers = []
  for (const foreignKey of catalog.foreignKeys) {
    if (foreignKey.child_oid !== foreignKey.parent_oid
      || !selectedOids.has(foreignKey.child_oid)
      || ['cascade', 'set_null', 'set_default'].includes(foreignKey.deleteAction)) continue
    const relation = catalog.relationByOid.get(foreignKey.child_oid)
    const joins = foreignKey.childColumns.map((column, index) => (
      `child.${quoteIdentifier(column)} = parent.${quoteIdentifier(foreignKey.parentColumns[index])}`
    )).join(' AND ')
    const result = await client.query(
      `SELECT count(*)::integer AS count
       FROM ${qualified(relation)} child
       JOIN ${qualified(relation)} parent ON ${joins}
       JOIN workspace_tenant_retirement_scope selected_child
         ON selected_child.table_oid = $1::oid
        AND selected_child.row_tid = child.ctid::text
       JOIN workspace_tenant_retirement_scope selected_parent
         ON selected_parent.table_oid = $1::oid
        AND selected_parent.row_tid = parent.ctid::text`,
      [relation.oid],
    )
    if (Number(result.rows[0]?.count || 0) > 0) {
      blockers.push({ table: relation.name, constraint: foreignKey.name, count: result.rows[0].count })
    }
  }
  return blockers
}

async function preservedRestrictBlockers(client, catalog, selectedOids) {
  const blockers = []
  for (const foreignKey of catalog.foreignKeys) {
    const child = catalog.relationByOid.get(foreignKey.child_oid)
    const parent = catalog.relationByOid.get(foreignKey.parent_oid)
    if (!child || !parent || !selectedOids.has(parent.oid)
      || selectedOids.has(child.oid)
      || !PRESERVED_TABLES.has(child.name)
      || SPECIAL_PRESERVED_FK_HANDLERS.has(child.name)
      || !['restrict', 'no_action'].includes(foreignKey.deleteAction)) continue
    const joins = foreignKey.childColumns.map((column, index) => (
      `child.${quoteIdentifier(column)} = parent.${quoteIdentifier(foreignKey.parentColumns[index])}`
    )).join(' AND ')
    const result = await client.query(
      `SELECT count(*)::integer AS count
       FROM ${qualified(child)} child
       JOIN ${qualified(parent)} parent ON ${joins}
       JOIN workspace_tenant_retirement_scope selected_parent
         ON selected_parent.table_oid = $1::oid
        AND selected_parent.row_tid = parent.ctid::text`,
      [parent.oid],
    )
    if (Number(result.rows[0]?.count || 0) > 0) {
      blockers.push({
        child: child.name,
        parent: parent.name,
        constraint: foreignKey.name,
        count: result.rows[0].count,
      })
    }
  }
  return blockers
}

async function crossTenantScopeBlockers(client, catalog, selectedRelations, targets) {
  const blockers = []
  const targetIds = targets.map((target) => target.organizationId)
  for (const relation of selectedRelations) {
    for (const column of relation.columns.filter((item) => (
      item.typeOid === '2950' && DIRECT_SCOPE_COLUMNS.has(item.name)
    ))) {
      const result = await client.query(
        `SELECT count(*)::integer AS count
         FROM ${qualified(relation)} candidate
         JOIN workspace_tenant_retirement_scope selected
           ON selected.table_oid = $1::oid
          AND selected.row_tid = candidate.ctid::text
         JOIN workspace_organizations scoped_workspace
           ON scoped_workspace.id = candidate.${quoteIdentifier(column.name)}
         WHERE NOT scoped_workspace.id = ANY($2::uuid[])`,
        [relation.oid, targetIds],
      )
      const count = Number(result.rows[0]?.count || 0)
      if (count > 0) blockers.push({ table: relation.name, column: column.name, count })
    }
    if (relation.columns.some((item) => item.typeOid === '2950' && item.name === 'pipeline_id')) {
      const result = await client.query(
        `SELECT count(*)::integer AS count
         FROM ${qualified(relation)} candidate
         JOIN workspace_tenant_retirement_scope selected
           ON selected.table_oid = $1::oid
          AND selected.row_tid = candidate.ctid::text
         JOIN pipeline_spaces scoped_pipeline
           ON scoped_pipeline.id = candidate.pipeline_id
         WHERE NOT scoped_pipeline.workspace_organization_id = ANY($2::uuid[])`,
        [relation.oid, targetIds],
      )
      const count = Number(result.rows[0]?.count || 0)
      if (count > 0) blockers.push({ table: relation.name, column: 'pipeline_id', count })
    }
  }
  return blockers
}

async function scopeSummary(client, catalog, targets) {
  const counts = {}
  const selectedRelations = []
  for (const relation of catalog.relations) {
    const count = await selectedCount(client, relation)
    if (count > 0) {
      counts[relation.name] = count
      selectedRelations.push(relation)
    }
  }
  const workspaceCount = counts.workspace_organizations || 0
  if (workspaceCount !== targets.length) {
    fail('FK closure expanded to an unapproved parent/child workspace organization')
  }
  const selectedOids = new Set(selectedRelations.map((relation) => relation.oid))
  const order = deletionOrder(selectedRelations, catalog.foreignKeys)
  const selfReferences = await selfReferentialBlockers(client, catalog, selectedOids)
  const preservedRestricts = await preservedRestrictBlockers(client, catalog, selectedOids)
  const crossTenantRows = await crossTenantScopeBlockers(
    client, catalog, selectedRelations, targets,
  )
  const triggers = catalog.triggers.filter((trigger) => (
    selectedOids.has(trigger.tableOid) && trigger.enabled !== 'D'
  )).map(({ table, name, enabled, definitionDigest }) => ({
    table, name, enabled, definitionDigest,
  }))
  const registryRows = await selectedReferences(client, catalog)
  const suiteCrmRecords = await selectedSuiteCrmRecords(client, catalog)
  const shortLinks = await client.query(
    `SELECT id::text, slug, organization_root_id::text
     FROM short_links
     WHERE organization_root_id = ANY($1::uuid[])
        OR slug = ANY($2::text[])
     ORDER BY id`,
    [
      targets.map((target) => target.organizationId),
      registryRows.map((row) => row.reference_code),
    ],
  )
  const shortLinkClicks = await client.query(
    `SELECT count(*)::integer AS count
     FROM short_link_clicks
     WHERE short_link_id = ANY($1::uuid[])`,
    [shortLinks.rows.map((row) => row.id)],
  )
  const audits = await client.query(
    `SELECT count(*)::integer AS count
     FROM audit_events
     WHERE organization_id = ANY($1::uuid[])`,
    [targets.map((target) => target.organizationId)],
  )
  const affectedUsers = await client.query(
    `SELECT count(*)::integer AS count
     FROM app_users
     WHERE organization_id = ANY($1::uuid[])`,
    [targets.map((target) => target.organizationId)],
  )
  const blockers = {
    relationCycles: order.cycles,
    selfReferences,
    preservedRestricts,
    crossTenantRows,
  }
  const specialCounts = {
    shortLinksRetired: shortLinks.rows.length,
    shortLinkClicksDeleted: Number(shortLinkClicks.rows[0]?.count || 0),
    preservedAuditEvents: Number(audits.rows[0]?.count || 0),
    applicationUsersReassignedOrDetached: Number(affectedUsers.rows[0]?.count || 0),
  }
  const references = registryRows.map((row) => row.reference_code)
  const scopeProjection = {
    counts,
    specialCounts,
    shortLinks: shortLinks.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      organizationRootId: row.organization_root_id,
    })),
    references,
    registryStatuses: registryRows,
    suiteCrmRecords,
    deleteOrder: order.ordered.map((relation) => relation.name),
    disabledDeleteTriggers: triggers,
    blockers,
  }
  return {
    ...scopeProjection,
    scopeDigest: digest(scopeProjection),
    selectedRelations,
    applyReady: Object.values(blockers).every((items) => items.length === 0),
    suiteCrmDigest: digest(suiteCrmRecords),
  }
}

function publicScope(scope) {
  return {
    counts: scope.counts,
    specialCounts: scope.specialCounts,
    shortLinks: scope.shortLinks,
    references: scope.references,
    registryStatuses: scope.registryStatuses,
    suiteCrmRecords: scope.suiteCrmRecords,
    suiteCrmDigest: scope.suiteCrmDigest,
    deleteOrder: scope.deleteOrder,
    disabledDeleteTriggers: scope.disabledDeleteTriggers,
    blockers: scope.blockers,
    scopeDigest: scope.scopeDigest,
    applyReady: scope.applyReady,
  }
}

async function buildPlan(client, options, endpointProof) {
  const identity = await databaseIdentity(client)
  await assertReceiptMigration(client)
  const observedTargets = await exactTargets(client, options.targets)
  await assertOperatorOwnsTargets(client, options.actor, options.targets)
  const pipelines = await pipelineIds(client, options.targets)
  const catalog = await loadCatalog(client)
  const scope = await prepareScope(client, catalog, options.targets, pipelines)
  const plan = {
    format: PLAN_FORMAT,
    scriptVersion: SCRIPT_VERSION,
    createdAt: new Date().toISOString(),
    environment: options.environment,
    railwayProjectId: options.railwayProjectId,
    railwayEnvironmentId: options.railwayEnvironmentId,
    database: {
      identity: identity.database_identity,
      name: identity.database_name,
      user: identity.database_user,
      endpointSha256: endpointProof.endpointSha256,
    },
    actor: options.actor,
    targets: options.targets,
    observedTargets,
    pipelines,
    catalogDigest: catalog.digest,
    scope: publicScope(scope),
    externalSystems: {
      suiteCrm: {
        action: 'not_called',
        projectedRecordsRetainedExternally: scope.suiteCrmRecords.length,
        acknowledgementDigest: scope.suiteCrmDigest,
      },
      commerceAndCarrierProviders: { action: 'not_called' },
      googleWorkspace: { action: 'not_called' },
    },
    applyReady: scope.applyReady,
  }
  plan.manifestDigest = manifestDigest(plan)
  return { plan, catalog, scope }
}

function assertManifest(manifest, options, endpointProof) {
  if (manifest?.format !== PLAN_FORMAT || manifest?.scriptVersion !== SCRIPT_VERSION) {
    fail('Manifest format or script version is not supported')
  }
  if (manifestDigest(manifest) !== manifest.manifestDigest
    || manifest.manifestDigest !== options.confirmDigest) {
    fail('Manifest confirmation digest does not match the reviewed plan')
  }
  const createdAt = Date.parse(manifest.createdAt)
  const age = Date.now() - createdAt
  if (!Number.isFinite(createdAt)
    || age > PLAN_MAX_AGE_MS
    || age < -PLAN_MAX_FUTURE_SKEW_MS) {
    fail('Reviewed retirement plan is stale or future-dated')
  }
  if (manifest.environment !== 'production'
    || manifest.railwayProjectId !== options.railwayProjectId
    || manifest.railwayEnvironmentId !== options.railwayEnvironmentId
    || manifest.database?.identity !== PRODUCTION_DATABASE_IDENTITY
    || manifest.database?.endpointSha256 !== endpointProof.endpointSha256
    || manifest.actor !== options.actor
    || canonicalJson(manifest.targets) !== canonicalJson(options.targets)) {
    fail('Manifest execution boundary does not match the supplied production proof')
  }
  if (manifest.applyReady !== true || manifest.scope?.applyReady !== true) {
    fail('Reviewed retirement plan is not apply-ready')
  }
}

function assertScopeUnchanged(manifest, current, catalog) {
  if (manifest.catalogDigest !== catalog.digest
    || manifest.scope.scopeDigest !== current.scopeDigest
    || canonicalJson(manifest.scope) !== canonicalJson(publicScope(current))) {
    fail('Tenant retirement scope changed after plan approval')
  }
}

async function lockApplyRelations(client, manifest) {
  const names = new Set([
    ...manifest.scope.deleteOrder,
    'app_users',
    'audit_events',
    'crm_reference_registry',
    'short_link_clicks',
    'short_links',
    'workspace_tenant_retirement_receipts',
  ])
  const ordered = [...names].sort()
  if (ordered.length) {
    await client.query(
      `LOCK TABLE ${ordered.map((name) => `public.${quoteIdentifier(name)}`).join(', ')}
       IN ACCESS EXCLUSIVE MODE`,
    )
  }
}

function restoreTriggerSql(trigger) {
  const mode = trigger.enabled === 'A' ? 'ENABLE ALWAYS'
    : trigger.enabled === 'R' ? 'ENABLE REPLICA'
      : 'ENABLE'
  return `ALTER TABLE public.${quoteIdentifier(trigger.table)} ${mode} TRIGGER ${quoteIdentifier(trigger.name)}`
}

async function disableDeleteTriggers(client, triggers) {
  for (const trigger of triggers) {
    await client.query(
      `ALTER TABLE public.${quoteIdentifier(trigger.table)} DISABLE TRIGGER ${quoteIdentifier(trigger.name)}`,
    )
  }
}

async function restoreDeleteTriggers(client, triggers) {
  for (const trigger of [...triggers].reverse()) {
    await client.query(restoreTriggerSql(trigger))
  }
}

async function retireShortLinks(client, shortLinks) {
  const linkIds = shortLinks.map((link) => link.id)
  const clicks = await client.query(
    `DELETE FROM short_link_clicks
     WHERE short_link_id = ANY($1::uuid[])`,
    [linkIds],
  )
  const links = await client.query(
    `UPDATE short_links
     SET disabled_at = COALESCE(disabled_at, clock_timestamp()),
         deleted_at = COALESCE(deleted_at, clock_timestamp()),
         organization_root_id = NULL,
         updated_at = clock_timestamp()
     WHERE id = ANY($1::uuid[])`,
    [linkIds],
  )
  return { links: links.rowCount || 0, clicks: clicks.rowCount || 0 }
}

async function retireReferences(client, references) {
  const result = await client.query(
    `UPDATE crm_reference_registry
     SET status = 'retired', retired_at = COALESCE(retired_at, clock_timestamp())
     WHERE reference_code = ANY($1::text[])
     RETURNING reference_code`,
    [references],
  )
  if (result.rows.length !== references.length) {
    fail('Permanent Global ID retirement count changed during apply')
  }
}

async function affectedUserReplacements(client, targets) {
  const result = await client.query(
    `SELECT app_user.email,
            replacement.organization_id::text AS replacement_organization_id,
            replacement.organization_name AS replacement_organization_name
     FROM app_users app_user
     LEFT JOIN LATERAL (
       SELECT membership.organization_id, organization.name AS organization_name
       FROM app_user_organization_memberships membership
       JOIN workspace_organizations organization ON organization.id = membership.organization_id
       WHERE membership.user_email = app_user.email
         AND membership.status = 'active'
         AND NOT membership.organization_id = ANY($1::uuid[])
       ORDER BY membership.is_default DESC, membership.updated_at DESC, membership.organization_id
       LIMIT 1
     ) replacement ON true
     WHERE app_user.organization_id = ANY($1::uuid[])
     ORDER BY app_user.email`,
    [targets.map((target) => target.organizationId)],
  )
  return result.rows
}

async function applyUserReplacements(client, replacements) {
  for (const replacement of replacements) {
    if (replacement.replacement_organization_id) {
      await client.query(
        `UPDATE app_user_organization_memberships
         SET is_default = true, updated_at = clock_timestamp()
         WHERE user_email = $1 AND organization_id = $2::uuid`,
        [replacement.email, replacement.replacement_organization_id],
      )
    }
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid,
           organization_name = $3,
           updated_at = clock_timestamp()
       WHERE email = $1`,
      [
        replacement.email,
        replacement.replacement_organization_id,
        replacement.replacement_organization_name,
      ],
    )
  }
}

async function deleteScopedRows(client, catalog, scope) {
  const deleted = {}
  for (const tableName of scope.deleteOrder) {
    const relation = catalog.relations.find((item) => item.name === tableName)
    if (!relation) fail(`Apply relation disappeared: ${tableName}`)
    const result = await client.query(
      `DELETE FROM ${qualified(relation)} candidate
       USING workspace_tenant_retirement_scope selected
       WHERE selected.table_oid = $1::oid
         AND selected.row_tid = candidate.ctid::text`,
      [relation.oid],
    )
    deleted[tableName] = result.rowCount || 0
    if (deleted[tableName] !== scope.counts[tableName]) {
      fail(`Deleted row count changed for ${tableName}`)
    }
  }
  return deleted
}

async function relationalAbsence(client, catalog, targets, references, shortLinks) {
  const targetIds = targets.map((target) => target.organizationId)
  const uuidOccurrences = []
  const referenceOccurrences = []
  for (const relation of catalog.relations) {
    if (POST_DELETE_UUID_SCAN_EXCLUSIONS.has(relation.name)) continue
    for (const column of relation.columns.filter((item) => item.typeOid === '2950')) {
      const result = await client.query(
        `SELECT count(*)::integer AS count
         FROM ${qualified(relation)}
         WHERE ${quoteIdentifier(column.name)} = ANY($1::uuid[])`,
        [targetIds],
      )
      const count = Number(result.rows[0]?.count || 0)
      if (count > 0) uuidOccurrences.push({ table: relation.name, column: column.name, count })
    }
    if (['crm_reference_registry', 'workspace_tenant_retirement_receipts'].includes(relation.name)) {
      continue
    }
    for (const column of relation.columns.filter((item) => (
      ['reference_code', 'global_id'].includes(item.name)
    ))) {
      const result = await client.query(
        `SELECT count(*)::integer AS count
         FROM ${qualified(relation)}
         WHERE ${quoteIdentifier(column.name)} = ANY($1::text[])`,
        [references],
      )
      const count = Number(result.rows[0]?.count || 0)
      if (count > 0) referenceOccurrences.push({ table: relation.name, column: column.name, count })
    }
  }
  const organizations = await client.query(
    `SELECT count(*)::integer AS count FROM workspace_organizations
     WHERE id = ANY($1::uuid[])`,
    [targetIds],
  )
  const applicationUsers = await client.query(
    `SELECT count(*)::integer AS count FROM app_users
     WHERE organization_id = ANY($1::uuid[])`,
    [targetIds],
  )
  const registry = await client.query(
    `SELECT count(*)::integer AS total,
            count(*) FILTER (WHERE status = 'retired' AND retired_at IS NOT NULL)::integer AS retired
     FROM crm_reference_registry
     WHERE reference_code = ANY($1::text[])`,
    [references],
  )
  const links = await client.query(
    `SELECT count(*)::integer AS total,
            count(*) FILTER (
              WHERE disabled_at IS NOT NULL AND deleted_at IS NOT NULL
                AND organization_root_id IS NULL
            )::integer AS retired
     FROM short_links
     WHERE id = ANY($1::uuid[])`,
    [shortLinks.map((link) => link.id)],
  )
  const linkClicks = await client.query(
    `SELECT count(*)::integer AS count
     FROM short_link_clicks
     WHERE short_link_id = ANY($1::uuid[])`,
    [shortLinks.map((link) => link.id)],
  )
  return {
    organizationsRemaining: Number(organizations.rows[0]?.count || 0),
    applicationUsersRemaining: Number(applicationUsers.rows[0]?.count || 0),
    uuidOccurrences,
    referenceOccurrences,
    registry: {
      total: Number(registry.rows[0]?.total || 0),
      retired: Number(registry.rows[0]?.retired || 0),
      expected: references.length,
    },
    shortLinks: {
      total: Number(links.rows[0]?.total || 0),
      retired: Number(links.rows[0]?.retired || 0),
      expected: shortLinks.length,
      clicksRemaining: Number(linkClicks.rows[0]?.count || 0),
    },
  }
}

function absenceReady(absence) {
  return absence.organizationsRemaining === 0
    && absence.applicationUsersRemaining === 0
    && absence.uuidOccurrences.length === 0
    && absence.referenceOccurrences.length === 0
    && absence.registry.total === absence.registry.expected
    && absence.registry.retired === absence.registry.expected
    && absence.shortLinks.total === absence.shortLinks.expected
    && absence.shortLinks.retired === absence.shortLinks.expected
    && absence.shortLinks.clicksRemaining === 0
}

function receiptProjection(manifest, scope, endpointProof, deleted, absence) {
  return {
    format: RECEIPT_FORMAT,
    scriptVersion: SCRIPT_VERSION,
    planDigest: manifest.manifestDigest,
    environment: manifest.environment,
    railwayProjectId: manifest.railwayProjectId,
    railwayEnvironmentId: manifest.railwayEnvironmentId,
    databaseIdentity: manifest.database.identity,
    databaseEndpointSha256: endpointProof.endpointSha256,
    actorEmail: manifest.actor,
    targets: manifest.targets,
    scopeDigest: scope.scopeDigest,
    scopeCounts: scope.counts,
    retiredReferences: scope.references,
    retiredShortLinks: scope.shortLinks,
    disabledDeleteTriggers: scope.disabledDeleteTriggers,
    suiteCrmRecords: scope.suiteCrmRecords,
    deleted,
    verification: absence,
    externalSystemDisposition: manifest.externalSystems,
  }
}

async function insertReceipt(client, receipt) {
  const receiptDigest = digest(receipt)
  const result = await client.query(
    `INSERT INTO workspace_tenant_retirement_receipts (
       plan_digest, receipt_digest, script_version, environment,
       railway_project_id, railway_environment_id, database_identity,
       database_endpoint_sha256, actor_email, target_organizations,
       scope_digest, scope_counts, retired_references,
       disabled_delete_triggers, retired_short_links, suitecrm_records,
       external_system_disposition, verification
     ) VALUES (
       $1, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8, $9,
       $10::jsonb, $11, $12::jsonb, $13::text[], $14::jsonb,
       $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb
     )
     RETURNING id::text, completed_at`,
    [
      receipt.planDigest,
      receiptDigest,
      receipt.scriptVersion,
      receipt.environment,
      receipt.railwayProjectId,
      receipt.railwayEnvironmentId,
      receipt.databaseIdentity,
      receipt.databaseEndpointSha256,
      receipt.actorEmail,
      JSON.stringify(receipt.targets),
      receipt.scopeDigest,
      JSON.stringify(receipt.scopeCounts),
      receipt.retiredReferences,
      JSON.stringify(receipt.disabledDeleteTriggers),
      JSON.stringify(receipt.retiredShortLinks),
      JSON.stringify(receipt.suiteCrmRecords),
      JSON.stringify(receipt.externalSystemDisposition),
      JSON.stringify(receipt.verification),
    ],
  )
  const row = result.rows[0]
  await client.query(
    `INSERT INTO audit_events (
       actor, event_type, event_key, aggregate_type, aggregate_id,
       subject, organization_id, is_system, payload
     ) VALUES (
       'system:tenant-retirement',
       'workspace.tenant.retired_by_operator',
       'workspace-tenant-retirement:' || $1::text,
       'workspace_tenant_retirement_receipt', $2::text, $3::text, NULL, true,
       jsonb_build_object(
         'receiptId', $2::text,
         'planDigest', $1::text,
         'receiptDigest', $4::text,
         'operatorEmail', $3::text,
         'targetOrganizationIds', $5::jsonb,
         'scopeDigest', $6::text
       )
     )`,
    [
      receipt.planDigest,
      row.id,
      receipt.actorEmail,
      receiptDigest,
      JSON.stringify(receipt.targets.map((target) => target.organizationId)),
      receipt.scopeDigest,
    ],
  )
  return { id: row.id, completedAt: row.completed_at, receiptDigest }
}

async function applyManifest(client, manifest, options, endpointProof) {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    await client.query(`SET LOCAL statement_timeout = '10min'`)
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [SCRIPT_VERSION],
    )
    for (const target of options.targets) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`workspace-tenant-retirement:${target.organizationId}`],
      )
    }
    await lockApplyRelations(client, manifest)
    await databaseIdentity(client)
    await assertReceiptMigration(client)
    const existingReceipt = await client.query(
      `SELECT id::text FROM workspace_tenant_retirement_receipts WHERE plan_digest = $1`,
      [manifest.manifestDigest],
    )
    if (existingReceipt.rows.length) fail('This retirement plan already has a committed receipt')
    await exactTargets(client, options.targets)
    await assertOperatorOwnsTargets(client, options.actor, options.targets)
    const pipelines = await pipelineIds(client, options.targets)
    const catalog = await loadCatalog(client)
    const scope = await prepareScope(client, catalog, options.targets, pipelines)
    assertScopeUnchanged(manifest, scope, catalog)
    if (scope.suiteCrmRecords.length > 0
      && options.suiteCrmAcknowledgement !== scope.suiteCrmDigest) {
      fail(`SuiteCRM is not called; --acknowledge-suitecrm-retained=${scope.suiteCrmDigest} is required`)
    }
    const replacements = await affectedUserReplacements(client, options.targets)
    await disableDeleteTriggers(client, scope.disabledDeleteTriggers)
    const shortLinks = await retireShortLinks(client, scope.shortLinks)
    if (shortLinks.links !== scope.specialCounts.shortLinksRetired
      || shortLinks.clicks !== scope.specialCounts.shortLinkClicksDeleted) {
      fail('Short-link retirement scope changed during apply')
    }
    await retireReferences(client, scope.references)
    const deleted = await deleteScopedRows(client, catalog, scope)
    await applyUserReplacements(client, replacements)
    await restoreDeleteTriggers(client, scope.disabledDeleteTriggers)
    const absence = await relationalAbsence(
      client, catalog, options.targets, scope.references, scope.shortLinks,
    )
    if (!absenceReady(absence)) fail('Post-delete relational absence verification failed')
    const receipt = receiptProjection(
      manifest, scope, endpointProof, deleted, absence,
    )
    const committed = await insertReceipt(client, receipt)
    await client.query('COMMIT')
    return { receipt: { ...receipt, ...committed } }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function verifyCommitted(client, manifest, options, endpointProof) {
  await databaseIdentity(client)
  await assertReceiptMigration(client)
  const result = await client.query(
    `SELECT id::text, plan_digest, receipt_digest, script_version, environment,
            railway_project_id::text, railway_environment_id::text,
            database_identity::text, database_endpoint_sha256, actor_email,
            target_organizations, scope_digest, scope_counts,
            retired_references, disabled_delete_triggers, retired_short_links,
            suitecrm_records,
            external_system_disposition, verification, completed_at
     FROM workspace_tenant_retirement_receipts
     WHERE plan_digest = $1`,
    [manifest.manifestDigest],
  )
  if (result.rows.length !== 1) fail('No unique committed retirement receipt exists')
  const row = result.rows[0]
  if (row.environment !== 'production'
    || row.railway_project_id !== options.railwayProjectId
    || row.railway_environment_id !== options.railwayEnvironmentId
    || row.database_identity !== PRODUCTION_DATABASE_IDENTITY
    || row.database_endpoint_sha256 !== endpointProof.endpointSha256
    || row.actor_email !== options.actor
    || row.scope_digest !== manifest.scope.scopeDigest
    || canonicalJson(row.target_organizations) !== canonicalJson(options.targets)) {
    fail('Committed retirement receipt does not match the reviewed boundary')
  }
  const catalog = await loadCatalog(client)
  const absence = await relationalAbsence(
    client, catalog, options.targets, row.retired_references, row.retired_short_links,
  )
  if (!absenceReady(absence)) fail('Committed tenant retirement no longer verifies')
  const audit = await client.query(
    `SELECT count(*)::integer AS count
     FROM audit_events
     WHERE event_key = 'workspace-tenant-retirement:' || $1
       AND aggregate_id = $2`,
    [manifest.manifestDigest, row.id],
  )
  if (Number(audit.rows[0]?.count || 0) !== 1) {
    fail('Durable retirement audit event is missing or duplicated')
  }
  return {
    ok: true,
    receiptId: row.id,
    receiptDigest: row.receipt_digest,
    completedAt: row.completed_at,
    targets: options.targets,
    retiredReferences: row.retired_references.length,
    suiteCrmRecordsRetainedExternally: row.suitecrm_records.length,
    verification: absence,
  }
}

export async function run(argv = process.argv.slice(2), environment = process.env, runtime = {}) {
  const options = parseArguments(argv)
  const endpointProof = assertRuntimeEnvironment(options, environment)
  if (options.command === 'plan') ensureSafeOutputPath(options.output)
  if (options.command === 'apply') ensureSafeOutputPath(options.receiptOutput)
  const pool = runtime.pool || poolFor(environment)
  const ownsPool = !runtime.pool
  try {
    if (options.command === 'plan') {
      const client = await pool.connect()
      try {
        // PostgreSQL classifies writes to temporary scope tables as writes, so
        // this cannot be a READ ONLY transaction. The plan path deliberately
        // rolls the entire repeatable-read transaction back after analysis;
        // no durable mutation can commit from plan mode.
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        const { plan } = await buildPlan(client, options, endpointProof)
        await client.query('ROLLBACK')
        writePrivateJson(options.output, plan)
        return {
          command: 'plan',
          output: options.output,
          manifestDigest: plan.manifestDigest,
          applyReady: plan.applyReady,
          counts: plan.scope.counts,
          suiteCrmRecordsRetainedExternally:
            plan.externalSystems.suiteCrm.projectedRecordsRetainedExternally,
          suiteCrmAcknowledgementDigest:
            plan.externalSystems.suiteCrm.acknowledgementDigest,
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
    const manifest = readPrivateJson(options.manifest, 'Retirement manifest')
    assertManifest(manifest, options, endpointProof)
    if (options.command === 'apply') {
      const client = await pool.connect()
      let applied
      try {
        applied = await applyManifest(client, manifest, options, endpointProof)
      } finally {
        client.release()
      }
      const verifier = await pool.connect()
      let verification
      try {
        await verifier.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        verification = await verifyCommitted(
          verifier, manifest, options, endpointProof,
        )
        await verifier.query('COMMIT')
      } catch (error) {
        await verifier.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        verifier.release()
      }
      const artifact = {
        ...applied.receipt,
        postCommitVerification: verification,
      }
      writePrivateJson(options.receiptOutput, artifact)
      return { command: 'apply', receiptOutput: options.receiptOutput, ...verification }
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const result = await verifyCommitted(client, manifest, options, endpointProof)
      await client.query('COMMIT')
      return { command: 'verify', ...result }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  } finally {
    if (ownsPool) await pool.end()
  }
}

function safeOutput(result) {
  return JSON.stringify(result, null, 2)
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  try {
    const result = await run(argv, environment)
    process.stdout.write(`${safeOutput(result)}\n`)
  } catch (error) {
    process.stderr.write(
      `tenants:retire failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
