#!/usr/bin/env node

/**
 * Offline, receipt-bound PostgreSQL workspace retirement.
 *
 * This command never calls SuiteCRM, a commerce provider, a carrier, Google,
 * or any other external system.  With no explicit command it is plan-only.
 * Apply requires the private plan artifact, its exact SHA-256 digest, the same
 * exact target allowlist, validated-backup attestation, and independent
 * Railway/database endpoint evidence.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SCRIPT_VERSION = 'workspace-tenant-retirement-v3'
export const PLAN_FORMAT = 'clawpilot-workspace-tenant-retirement-plan-v3'
export const RECEIPT_FORMAT = 'clawpilot-workspace-tenant-retirement-receipt-v3'
export const PRODUCTION_DATABASE_IDENTITY = '0474a18c-649c-491b-bea1-7da006d21d81'
export const PRODUCTION_DATABASE_NAME = 'railway'
export const PRODUCTION_DATABASE_USER = 'postgres'
export const PRODUCTION_POSTGRES_SYSTEM_IDENTIFIER = '7645434341173309484'
export const PRODUCTION_RAILWAY_PROJECT_ID = 'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const PRODUCTION_RAILWAY_ENVIRONMENT_ID = '058ce52f-1d3b-44bb-afe2-0df2bf24efb9'
export const PRODUCTION_RAILWAY_SERVICE_ID = 'f3fdf47c-6645-42ff-9a28-52843f8e4da2'
export const CONFIRMED_OPERATOR_EMAIL = 'jarrett@suburbiasandwichco.com'
export const PLAN_MAX_AGE_MS = 30 * 60 * 1000
export const PLAN_MAX_FUTURE_SKEW_MS = 5 * 1000

export const APPROVED_TARGETS = Object.freeze([
  Object.freeze({
    key: 'ag-alchemy',
    organizationId: '33785418-9927-4e10-a492-d3a44b9b6f21',
    referenceCode: 'ga42g1438l4j2s',
    name: 'AG Alchemy, LLC',
    organizationType: 'root',
    parentId: null,
    pipelineId: 'd0d002ce-d073-4ff1-a5cd-0c8cdd28529d',
    crmOrganizationId: '37b757cb-fc11-49e5-b668-5e97ce94fbab',
    suiteCrmAccountId: '006d4b9e-b4db-5d5c-8440-6e6fbcbfb35a',
    crmContactId: '371ba6cb-a322-4822-9f75-36abf2582c8e',
    crmContactReferenceCode: 'gc3327424',
    suiteCrmContactId: 'a03eecca-abe6-55eb-8cb7-366eac3892fa',
  }),
  Object.freeze({
    key: 'french-florist',
    organizationId: '3b9ceada-a4ff-4363-8e78-6069dee76328',
    referenceCode: 'gakrnoh15krp9n',
    name: 'French Florist',
    organizationType: 'root',
    parentId: null,
    pipelineId: '7d82a005-80dc-441e-95e8-3a23ac968ea0',
    crmOrganizationId: '1a546db3-b584-4890-9d1f-0311a1cd1723',
    suiteCrmAccountId: 'b8f39084-452b-5b2a-ace1-3851e27c3ab0',
    crmContactId: '94d4db5a-c6bd-4c63-84ee-0344c1857c9a',
    crmContactReferenceCode: 'gc3327424',
    suiteCrmContactId: 'a03eecca-abe6-55eb-8cb7-366eac3892fa',
  }),
  Object.freeze({
    key: 'test-pro-bakery-bites',
    organizationId: 'c8fcf491-cf8c-469a-b03c-0026a762752c',
    referenceCode: 'gac10cb46e3rpl',
    name: 'Test Pro Bakery Bites',
    organizationType: 'root',
    parentId: null,
    pipelineId: '8f43d061-057d-42a2-844b-85f89421854d',
    crmOrganizationId: '85ecfa66-f07d-4745-8136-9b7abc1bfd9a',
    suiteCrmAccountId: 'e4bfc539-0f56-5214-81da-03eff5b06664',
    crmContactId: 'ab3939b1-5f86-47ea-81d4-11cdf09dd020',
    crmContactReferenceCode: 'gc3327424',
    suiteCrmContactId: 'a03eecca-abe6-55eb-8cb7-366eac3892fa',
  }),
])

export const PROTECTED_LEGACY_CRM_ORGANIZATIONS = Object.freeze([
  Object.freeze({
    key: 'ag-alchemy-legacy-customer',
    crmOrganizationId: 'bd8f9426-5bd7-4276-a7af-9583e704b190',
    pipelineId: 'b614e65d-250e-40a9-bb1e-fdbd18a1ec2c',
    suiteCrmAccountId: '9ba59957-0553-59c6-8a93-c657bf518a84',
    contactCount: 4,
    interactionCount: 3,
    opportunityCount: 1,
  }),
  Object.freeze({
    key: 'french-florist-legacy-customer',
    crmOrganizationId: '1aa7df96-aa92-4e59-8352-03863c76fee7',
    pipelineId: 'b614e65d-250e-40a9-bb1e-fdbd18a1ec2c',
    suiteCrmAccountId: '8022145b-3a4d-591d-a0f7-1b102b515c3d',
    contactCount: 2,
    interactionCount: 20,
    opportunityCount: 1,
  }),
])
export const PROTECTED_SHARED_PIPELINE = Object.freeze({
  workspaceOrganizationId: 'ded21d68-746c-42e1-88ee-b1315afe6b84',
  pipelineId: 'b614e65d-250e-40a9-bb1e-fdbd18a1ec2c',
})
export const PRESERVED_SHARED_REFERENCE_CODES = Object.freeze(['gc3327424'])
export const EXPECTED_PRESERVED_USER_COUNTS = Object.freeze({
  appUsers: 1,
  memberships: 7,
  retainedMemberships: 4,
  userMatonCredentials: 1,
  userMatonConnections: 17,
  crmIntegrationCursors: 5,
})
export const EXPECTED_SELECTED_SCOPE_COUNTS = Object.freeze({
  app_documents: 117,
  app_sessions: 3,
  app_user_organization_memberships: 3,
  crm_board_cards: 6,
  crm_board_projections: 3,
  crm_contact_source_aliases: 6,
  crm_contacts: 3,
  crm_organizations: 3,
  operations_activation_scopes: 2,
  pipeline_dropdown_catalogs: 3,
  pipeline_spaces: 3,
  project_boards: 6,
  sync_outbox: 3,
  workspace_organizations: 3,
})
export const EXPECTED_SPECIAL_SCOPE_COUNTS = Object.freeze({
  shortLinksRetired: 5,
  preservedAuditEvents: 37,
})
export const PRODUCTION_DATABASE_BOUNDARY = Object.freeze({
  databaseIdentity: PRODUCTION_DATABASE_IDENTITY,
  databaseName: PRODUCTION_DATABASE_NAME,
  databaseUser: PRODUCTION_DATABASE_USER,
  postgresSystemIdentifier: PRODUCTION_POSTGRES_SYSTEM_IDENTIFIER,
})

const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const REFERENCE = /^g[a-z]{1,4}(?:[0-9]{7}|[0-9a-v]{12})$/u
// These UUIDs identify CRM accounts inside a workspace, not workspace tenants.
// Every other organization-like UUID column must be proven reachable from
// workspace_organizations.id through runtime foreign-key column mappings. A
// new unclassified role is therefore a plan blocker, not an implicit guess.
const REVIEWED_NON_TENANT_ORGANIZATION_COLUMNS = new Set([
  'crm_contacts.organization_id',
  'crm_interactions.organization_id',
  'crm_leads.organization_id',
  'crm_meetings.organization_id',
  'crm_opportunities.organization_id',
  'crm_organizations.parent_organization_id',
  // Audit history is deliberately retained and verified separately.
  'audit_events.organization_id',
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
const SPECIAL_PRESERVED_FK_HANDLERS = new Set([
  'app_users.organization_id:set_null->workspace_organizations.id',
  'short_links.organization_root_id:restrict->workspace_organizations.id',
])
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
  if (parsed.searchParams.has('options')) {
    fail('DATABASE_URL must not override PostgreSQL startup options')
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

function relationColumnKey(tableOid, column) {
  return `${tableOid}:${column}`
}

function isOrganizationLikeUuid(column) {
  return column.typeOid === '2950'
    && /(?:^|_)organization(?:_[a-z0-9]+)*_id$/u.test(column.name)
}

function relationDescriptor(relation) {
  return { schema: relation.schema, name: relation.name, kind: relation.kind }
}

export function deriveOrganizationOwnership(relations, foreignKeys) {
  const relationByOid = new Map(relations.map((relation) => [relation.oid, relation]))
  const workspace = relations.find((relation) => (
    relation.schema === 'public' && relation.name === 'workspace_organizations'
  ))
  if (!workspace?.columns.some((column) => column.name === 'id' && column.typeOid === '2950')) {
    fail('workspace_organizations.id UUID ownership root is missing')
  }

  const paths = new Map([[relationColumnKey(workspace.oid, 'id'), [
    'workspace_organizations.id',
  ]]])
  let changed = true
  while (changed) {
    changed = false
    for (const foreignKey of foreignKeys) {
      const child = relationByOid.get(foreignKey.child_oid)
      const parent = relationByOid.get(foreignKey.parent_oid)
      if (!child || !parent) continue
      foreignKey.childColumns.forEach((childColumn, index) => {
        const parentColumn = foreignKey.parentColumns[index]
        const parentKey = relationColumnKey(parent.oid, parentColumn)
        const childKey = relationColumnKey(child.oid, childColumn)
        if (!paths.has(parentKey) || paths.has(childKey)) return
        paths.set(childKey, [
          ...paths.get(parentKey),
          `${foreignKey.name}:${child.name}.${childColumn}`,
        ])
        changed = true
      })
    }
  }

  const roles = []
  const reviewedNonTenant = []
  const unclassified = []
  for (const relation of relations) {
    for (const column of relation.columns.filter(isOrganizationLikeUuid)) {
      const key = relationColumnKey(relation.oid, column.name)
      const display = `${relation.name}.${column.name}`
      if (paths.has(key)) {
        roles.push({ table: relation.name, column: column.name, path: paths.get(key) })
        continue
      }
      const nonTenantForeignKey = foreignKeys.find((foreignKey) => (
        foreignKey.child_oid === relation.oid
        && foreignKey.childColumns.some((childColumn, index) => (
          childColumn === column.name
          && !paths.has(relationColumnKey(
            foreignKey.parent_oid,
            foreignKey.parentColumns[index],
          ))
        ))
      ))
      if (nonTenantForeignKey) {
        const parent = relationByOid.get(nonTenantForeignKey.parent_oid)
        reviewedNonTenant.push({
          table: relation.name,
          column: column.name,
          reason: `foreign_entity:${parent?.name || 'unknown'}:${nonTenantForeignKey.name}`,
        })
      } else if (REVIEWED_NON_TENANT_ORGANIZATION_COLUMNS.has(display)) {
        reviewedNonTenant.push({
          table: relation.name,
          column: column.name,
          reason: 'explicit_preserved_or_hierarchy_review',
        })
      } else {
        unclassified.push({ table: relation.name, column: column.name })
      }
    }
  }
  const compare = (left, right) => (
    left.table.localeCompare(right.table) || left.column.localeCompare(right.column)
  )
  roles.sort(compare)
  reviewedNonTenant.sort(compare)
  unclassified.sort(compare)
  return { roles, reviewedNonTenant, unclassified }
}

async function loadLockCatalog(client) {
  const result = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS name,
            relation.relkind::text AS kind
     FROM pg_catalog.pg_class relation
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p')
       AND relation.relpersistence <> 't'
     ORDER BY namespace.nspname, relation.relname, relation.relkind`,
  )
  const relations = result.rows.map(relationDescriptor)
  return { relations, digest: digest(relations) }
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
    '--railway-environment-id', '--railway-service-id', '--target',
    '--validated-backup-sha256', '--validated-backup-bytes',
  ]
  const allowed = new Set(command === 'plan'
    ? [...common, '--output']
    : command === 'apply'
      ? [
          ...common, '--manifest', '--confirm-digest', '--receipt-output',
          '--acknowledge-suitecrm-retained', '--acknowledge-delete-triggers',
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
  const railwayServiceId = requireSingle(
    flags.get('--railway-service-id') || [], '--railway-service-id',
  ).toLowerCase()
  if (railwayServiceId !== PRODUCTION_RAILWAY_SERVICE_ID) {
    fail('--railway-service-id does not match the approved ClawPilot app service')
  }
  const targets = validateTargetArguments(flags.get('--target') || [])
  const backupDigestValues = flags.get('--validated-backup-sha256') || []
  const backupBytesValues = flags.get('--validated-backup-bytes') || []
  let backupEvidence = null
  if (command !== 'verify' || backupDigestValues.length || backupBytesValues.length) {
    const backupSha256 = requireSingle(
      backupDigestValues, '--validated-backup-sha256',
    ).toLowerCase()
    if (!SHA256.test(backupSha256)) {
      fail('--validated-backup-sha256 must be a SHA-256 digest')
    }
    const backupBytesText = requireSingle(backupBytesValues, '--validated-backup-bytes')
    if (!/^[1-9][0-9]*$/u.test(backupBytesText)) {
      fail('--validated-backup-bytes must be a positive integer')
    }
    const backupBytes = Number(backupBytesText)
    if (!Number.isSafeInteger(backupBytes)) {
      fail('--validated-backup-bytes exceeds the safe integer range')
    }
    backupEvidence = { sha256: backupSha256, bytes: backupBytes }
  }
  const commonResult = {
    command,
    actor,
    environment,
    railwayProjectId,
    railwayEnvironmentId,
    railwayServiceId,
    backupEvidence,
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
    const triggerAcknowledgement = flags.get('--acknowledge-delete-triggers') || []
    const suiteCrmAcknowledgement = acknowledgement.length
      ? requireSingle(acknowledgement, '--acknowledge-suitecrm-retained').toLowerCase()
      : null
    const deleteTriggerAcknowledgement = triggerAcknowledgement.length
      ? requireSingle(triggerAcknowledgement, '--acknowledge-delete-triggers').toLowerCase()
      : null
    if (suiteCrmAcknowledgement && !SHA256.test(suiteCrmAcknowledgement)) {
      fail('--acknowledge-suitecrm-retained must be a SHA-256 digest')
    }
    if (deleteTriggerAcknowledgement && !SHA256.test(deleteTriggerAcknowledgement)) {
      fail('--acknowledge-delete-triggers must be a SHA-256 digest')
    }
    return {
      ...result,
      receiptOutput: path.resolve(requireSingle(
        flags.get('--receipt-output') || [], '--receipt-output',
      )),
      suiteCrmAcknowledgement,
      deleteTriggerAcknowledgement,
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
  if (text(environment.RAILWAY_SERVICE_ID).toLowerCase() !== options.railwayServiceId) {
    fail('Runtime RAILWAY_SERVICE_ID does not match the independently supplied app service')
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

function resolveDatabaseBoundary(runtime, environment) {
  if (!runtime.testDatabaseBoundary) return PRODUCTION_DATABASE_BOUNDARY
  let hostname
  try {
    hostname = new URL(text(environment.DATABASE_URL)).hostname.toLowerCase()
  } catch {
    fail('Test database boundary requires a valid DATABASE_URL')
  }
  if (!runtime.pool || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    fail('Test database boundary overrides are restricted to an injected loopback pool')
  }
  const boundary = runtime.testDatabaseBoundary
  for (const key of Object.keys(PRODUCTION_DATABASE_BOUNDARY)) {
    if (!text(boundary[key])) fail(`Test database boundary is missing ${key}`)
  }
  return boundary
}

async function databaseIdentity(client, expectedBoundary) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
            current_user AS database_user,
            value->>'id' AS database_identity,
            (SELECT system_identifier::text FROM pg_control_system())
              AS postgres_system_identifier
     FROM app_settings
     WHERE key = 'deployment.database.identity'
     LIMIT 1`,
  )
  const row = result.rows[0]
  if (!row
    || row.database_identity !== expectedBoundary.databaseIdentity
    || row.database_name !== expectedBoundary.databaseName
    || row.database_user !== expectedBoundary.databaseUser
    || row.postgres_system_identifier !== expectedBoundary.postgresSystemIdentifier) {
    fail('Connected database is not the verified ClawPilot production database')
  }
  return row
}

async function assertReceiptMigration(client) {
  const baseFilename = '0360_workspace_tenant_retirement_receipts.sql'
  const boundaryFilename =
    '0362_workspace_tenant_retirement_receipt_boundary_evidence.sql'
  const baseChecksum = sha256(fs.readFileSync(
    new URL(`../db/migrations/${baseFilename}`, import.meta.url),
  ))
  const boundaryChecksum = sha256(fs.readFileSync(
    new URL(`../db/migrations/${boundaryFilename}`, import.meta.url),
  ))
  const result = await client.query(
    `SELECT NOT EXISTS (
       SELECT 1
       FROM (VALUES ($1::text, $2::text), ($3::text, $4::text))
         expected(filename, checksum)
       LEFT JOIN schema_migrations applied USING (filename)
       WHERE applied.checksum IS DISTINCT FROM expected.checksum
     ) AS migrated,
     to_regclass('public.workspace_tenant_retirement_receipts') IS NOT NULL AS present,
     NOT EXISTS (
       SELECT required.column_name
       FROM unnest(ARRAY[
         'railway_service_id', 'database_name', 'database_user', 'postgres_system_identifier',
         'backup_evidence', 'lock_catalog_digest', 'locked_relations', 'deleted_counts'
       ]) required(column_name)
       WHERE NOT EXISTS (
         SELECT 1 FROM information_schema.columns column_row
         WHERE column_row.table_schema = 'public'
           AND column_row.table_name = 'workspace_tenant_retirement_receipts'
           AND column_row.column_name = required.column_name
       )
     ) AS columns_present,
     EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger trigger_row
       JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_proc function_row ON function_row.oid = trigger_row.tgfoid
       JOIN pg_catalog.pg_namespace function_namespace
         ON function_namespace.oid = function_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'workspace_tenant_retirement_receipts'
         AND trigger_row.tgname = 'reject_workspace_tenant_retirement_receipt_write'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype::integer = 27
         AND function_namespace.nspname = 'public'
         AND function_row.proname = 'reject_workspace_tenant_retirement_receipt_mutation'
         AND function_row.prosecdef = false
         AND function_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
         AND regexp_replace(function_row.prosrc, '\\s+', ' ', 'g') =
           ' BEGIN RAISE EXCEPTION ''Workspace tenant retirement receipts are immutable''; END; '
     ) AS immutable`,
    [baseFilename, baseChecksum, boundaryFilename, boundaryChecksum],
  )
  if (result.rows[0]?.migrated !== true
    || result.rows[0]?.present !== true
    || result.rows[0]?.columns_present !== true
    || result.rows[0]?.immutable !== true) {
    fail(
      'Migrations 0360_workspace_tenant_retirement_receipts.sql and '
      + '0362_workspace_tenant_retirement_receipt_boundary_evidence.sql are required',
    )
  }
}

async function loadCatalog(client) {
  const unsupportedResult = await client.query(
    `SELECT relation.relname AS name, relation.relkind::text AS kind,
            relation.relrowsecurity AS row_security,
            relation.relforcerowsecurity AS force_row_security,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_inherits inheritance
              WHERE inheritance.inhrelid = relation.oid
                 OR inheritance.inhparent = relation.oid
            ) AS uses_inheritance
     FROM pg_catalog.pg_class relation
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND (
         relation.relkind IN ('f', 'm', 'p')
         OR relation.relrowsecurity
         OR relation.relforcerowsecurity
         OR EXISTS (
           SELECT 1 FROM pg_catalog.pg_inherits inheritance
           WHERE inheritance.inhrelid = relation.oid
              OR inheritance.inhparent = relation.oid
         )
       )
     ORDER BY relation.relname`,
  )
  if (unsupportedResult.rows.length > 0) {
    fail(`Unsupported public storage/security topology: ${canonicalJson(unsupportedResult.rows)}`)
  }
  const relationsResult = await client.query(
    `SELECT relation.oid::text AS oid, namespace.nspname AS schema,
            relation.relname AS name, relation.relkind::text AS kind
     FROM pg_catalog.pg_class relation
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p')
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
       AND relation.relkind IN ('r', 'p')
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
  const organizationOwnership = deriveOrganizationOwnership(relations, foreignKeys)
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
    organizationOwnership,
  }
  return {
    relations,
    relationByOid,
    foreignKeys,
    triggers,
    organizationOwnership,
    digest: digest(catalogProjection),
  }
}

export async function inspectRuntimeCatalog(client) {
  return loadCatalog(client)
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
      || observed.name !== expected.name
      || observed.organization_type !== expected.organizationType
      || observed.parent_id !== expected.parentId) {
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

function relationSeedPredicate(relation, ownership) {
  const predicates = []
  const roleColumns = new Set(
    ownership.roles
      .filter((role) => role.table === relation.name)
      .map((role) => role.column),
  )
  for (const column of relation.columns) {
    if (column.typeOid === '2950' && roleColumns.has(column.name)) {
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

async function exactTargetGraph(client, targets) {
  const pipelineResult = await client.query(
    `SELECT id::text, name, workspace_organization_id::text,
            crm_provider, sync_enabled, provisioning_status, sheet_id,
            drive_folder_id, provisioning_sheet_id,
            google_service_account_email, google_shared_drive_id
     FROM pipeline_spaces
     WHERE workspace_organization_id = ANY($1::uuid[])
     ORDER BY id`,
    [targets.map((target) => target.organizationId)],
  )
  const observedPipelines = pipelineResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    workspaceOrganizationId: row.workspace_organization_id,
    crmProvider: row.crm_provider,
    syncEnabled: row.sync_enabled,
    provisioningStatus: row.provisioning_status,
    sheetId: row.sheet_id,
    driveFolderId: row.drive_folder_id,
    provisioningSheetId: row.provisioning_sheet_id,
    googleServiceAccountEmail: row.google_service_account_email,
    googleSharedDriveId: row.google_shared_drive_id,
  }))
  const expectedPipelines = targets.map((target) => ({
    id: target.pipelineId,
    workspaceOrganizationId: target.organizationId,
    crmProvider: 'suitecrm',
    syncEnabled: false,
    provisioningStatus: 'not_requested',
    sheetId: null,
    driveFolderId: null,
    provisioningSheetId: null,
    googleServiceAccountEmail: null,
    googleSharedDriveId: null,
  })).sort((left, right) => left.id.localeCompare(right.id))
  const comparablePipelines = observedPipelines.map(({ name: _name, ...pipeline }) => pipeline)
  if (canonicalJson(comparablePipelines) !== canonicalJson(expectedPipelines)) {
    fail('Audited target pipeline identity/count mismatch')
  }

  const organizationResult = await client.query(
    `SELECT id::text, pipeline_id::text, reference_code, suitecrm_id, name
     FROM crm_organizations
     WHERE pipeline_id = ANY($1::uuid[])
     ORDER BY id`,
    [targets.map((target) => target.pipelineId)],
  )
  const observedOrganizations = organizationResult.rows.map((row) => ({
    id: row.id,
    pipelineId: row.pipeline_id,
    referenceCode: row.reference_code,
    suiteCrmId: row.suitecrm_id,
    name: row.name,
  }))
  const expectedOrganizations = targets.map((target) => ({
    id: target.crmOrganizationId,
    pipelineId: target.pipelineId,
    referenceCode: target.referenceCode,
    suiteCrmId: target.suiteCrmAccountId,
    name: target.name,
  })).sort((left, right) => left.id.localeCompare(right.id))
  if (canonicalJson(observedOrganizations) !== canonicalJson(expectedOrganizations)) {
    fail('Audited target CRM organization identity/count mismatch')
  }

  const contactResult = await client.query(
    `SELECT id::text, pipeline_id::text, organization_id::text,
            reference_code, suitecrm_id, full_name
     FROM crm_contacts
     WHERE pipeline_id = ANY($1::uuid[])
     ORDER BY id`,
    [targets.map((target) => target.pipelineId)],
  )
  const observedContacts = contactResult.rows.map((row) => ({
    id: row.id,
    pipelineId: row.pipeline_id,
    organizationId: row.organization_id,
    referenceCode: row.reference_code,
    suiteCrmId: row.suitecrm_id,
    fullName: row.full_name,
  }))
  const expectedContacts = targets.map((target) => ({
    id: target.crmContactId,
    pipelineId: target.pipelineId,
    organizationId: target.crmOrganizationId,
    referenceCode: target.crmContactReferenceCode,
    suiteCrmId: target.suiteCrmContactId,
  })).sort((left, right) => left.id.localeCompare(right.id))
  const comparableContacts = observedContacts.map(({
    id, pipelineId, organizationId, referenceCode, suiteCrmId,
  }) => ({ id, pipelineId, organizationId, referenceCode, suiteCrmId }))
  if (canonicalJson(comparableContacts) !== canonicalJson(expectedContacts)) {
    fail('Audited target CRM contact identity/count mismatch')
  }

  return {
    pipelines: observedPipelines,
    crmOrganizations: observedOrganizations,
    crmContacts: observedContacts,
  }
}

async function preservationSnapshot(client, { afterRetirement = false } = {}) {
  const sharedPipelineResult = await client.query(
    `SELECT id::text, workspace_organization_id::text
     FROM pipeline_spaces
     WHERE id = $1::uuid`,
    [PROTECTED_SHARED_PIPELINE.pipelineId],
  )
  const legacyResult = await client.query(
    `SELECT id::text, pipeline_id::text, suitecrm_id
     FROM crm_organizations
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [PROTECTED_LEGACY_CRM_ORGANIZATIONS.map((record) => record.crmOrganizationId)],
  )
  const legacyDescendantResult = await client.query(
    `SELECT protected.id::text AS crm_organization_id,
            (SELECT count(*)::integer FROM crm_contacts contact
             WHERE contact.organization_id = protected.id) AS contact_count,
            (SELECT count(*)::integer FROM crm_interactions interaction
             WHERE interaction.organization_id = protected.id) AS interaction_count,
            (SELECT count(*)::integer FROM crm_opportunities opportunity
             WHERE opportunity.organization_id = protected.id) AS opportunity_count
     FROM crm_organizations protected
     WHERE protected.id = ANY($1::uuid[])
     ORDER BY protected.id`,
    [PROTECTED_LEGACY_CRM_ORGANIZATIONS.map((record) => record.crmOrganizationId)],
  )
  const userResult = await client.query(
    `SELECT email, contact_reference_code
     FROM app_users
     WHERE email = $1`,
    [CONFIRMED_OPERATOR_EMAIL],
  )
  const matonResult = await client.query(
    `SELECT count(*)::integer AS count
     FROM user_maton_connections
     WHERE owner_email = $1`,
    [CONFIRMED_OPERATOR_EMAIL],
  )
  const cursorResult = await client.query(
    `SELECT count(*)::integer AS count
     FROM crm_integration_cursors
     WHERE owner_email = $1`,
    [CONFIRMED_OPERATOR_EMAIL],
  )
  const membershipResult = await client.query(
    `SELECT count(*)::integer AS memberships,
            count(*) FILTER (
              WHERE NOT organization_id = ANY($2::uuid[])
            )::integer AS retained_memberships
     FROM app_user_organization_memberships
     WHERE user_email = $1`,
    [CONFIRMED_OPERATOR_EMAIL, APPROVED_TARGETS.map((target) => target.organizationId)],
  )
  const credentialResult = await client.query(
    `SELECT count(*)::integer AS count
     FROM user_maton_credentials
     WHERE owner_email = $1`,
    [CONFIRMED_OPERATOR_EMAIL],
  )
  const sharedReferenceResult = await client.query(
    `SELECT reference_code, canonical_code, status
     FROM crm_reference_registry
     WHERE reference_code = ANY($1::text[])
     ORDER BY reference_code`,
    [PRESERVED_SHARED_REFERENCE_CODES],
  )
  const observed = {
    sharedPipeline: sharedPipelineResult.rows.map((row) => ({
      pipelineId: row.id,
      workspaceOrganizationId: row.workspace_organization_id,
    })),
    legacyCrmOrganizations: legacyResult.rows.map((row) => ({
      crmOrganizationId: row.id,
      pipelineId: row.pipeline_id,
      suiteCrmAccountId: row.suitecrm_id,
    })),
    legacyDescendantCounts: legacyDescendantResult.rows.map((row) => ({
      crmOrganizationId: row.crm_organization_id,
      contactCount: Number(row.contact_count),
      interactionCount: Number(row.interaction_count),
      opportunityCount: Number(row.opportunity_count),
    })),
    operator: userResult.rows.map((row) => ({
      email: row.email,
      contactReferenceCode: row.contact_reference_code,
    })),
    counts: {
      appUsers: userResult.rows.length,
      memberships: Number(membershipResult.rows[0]?.memberships || 0),
      retainedMemberships: Number(membershipResult.rows[0]?.retained_memberships || 0),
      userMatonCredentials: Number(credentialResult.rows[0]?.count || 0),
      userMatonConnections: Number(matonResult.rows[0]?.count || 0),
      crmIntegrationCursors: Number(cursorResult.rows[0]?.count || 0),
    },
    sharedReferences: sharedReferenceResult.rows.map((row) => ({
      referenceCode: row.reference_code,
      canonicalCode: row.canonical_code,
      status: row.status,
    })),
  }
  const expected = {
    sharedPipeline: [PROTECTED_SHARED_PIPELINE],
    legacyCrmOrganizations: PROTECTED_LEGACY_CRM_ORGANIZATIONS.map((record) => ({
      crmOrganizationId: record.crmOrganizationId,
      pipelineId: record.pipelineId,
      suiteCrmAccountId: record.suiteCrmAccountId,
    })).sort((left, right) => left.crmOrganizationId.localeCompare(right.crmOrganizationId)),
    legacyDescendantCounts: PROTECTED_LEGACY_CRM_ORGANIZATIONS.map((record) => ({
      crmOrganizationId: record.crmOrganizationId,
      contactCount: record.contactCount,
      interactionCount: record.interactionCount,
      opportunityCount: record.opportunityCount,
    })).sort((left, right) => left.crmOrganizationId.localeCompare(right.crmOrganizationId)),
    operator: [{
      email: CONFIRMED_OPERATOR_EMAIL,
      contactReferenceCode: PRESERVED_SHARED_REFERENCE_CODES[0],
    }],
    counts: {
      ...EXPECTED_PRESERVED_USER_COUNTS,
      memberships: afterRetirement
        ? EXPECTED_PRESERVED_USER_COUNTS.retainedMemberships
        : EXPECTED_PRESERVED_USER_COUNTS.memberships,
    },
    sharedReferences: PRESERVED_SHARED_REFERENCE_CODES.map((referenceCode) => ({
      referenceCode,
      canonicalCode: referenceCode,
      status: 'active',
    })),
  }
  return { observed, expected, ready: canonicalJson(observed) === canonicalJson(expected) }
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
    const predicate = relationSeedPredicate(relation, catalog.organizationOwnership)
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
  // column. Aggregate outbox rows are discovered from scoped identifiers, then
  // closure runs again so any outbox dependants are also selected. Preserved
  // global/audit tables are never admitted to this scope.
  const maxRounds = Math.max(8, (catalog.relations.length * 2) + 2)
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
    inserted += await seedAggregateReferences(client, catalog)
    if (inserted === 0) {
      converged = true
      break
    }
  }
  if (!converged) fail('Runtime FK scope did not converge')
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
           AND candidate.${quoteIdentifier(column.name)}::text <> ALL($2::text[])
         ON CONFLICT DO NOTHING`,
        [relation.oid, PRESERVED_SHARED_REFERENCE_CODES],
      )
    }
  }
  const outbox = catalog.relations.find((relation) => relation.name === 'sync_outbox')
  if (outbox && !PRESERVED_TABLES.has(outbox.name)) {
    const result = await client.query(
      `INSERT INTO workspace_tenant_retirement_scope (table_oid, row_tid)
       SELECT $1::oid, candidate.ctid::text
       FROM public.sync_outbox candidate
       JOIN workspace_tenant_retirement_identifiers identifier
         ON identifier.value = candidate.aggregate_id
       ON CONFLICT DO NOTHING`,
      [outbox.oid],
    )
    return result.rowCount || 0
  }
  return 0
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

async function selectedContentDigest(client, relation) {
  const result = await client.query(
    `SELECT encode(public.digest(
              COALESCE(string_agg(scoped.row_json, E'\\n' ORDER BY scoped.row_json), ''),
              'sha256'
            ), 'hex') AS content_digest
     FROM (
       SELECT to_jsonb(candidate)::text AS row_json
       FROM ${qualified(relation)} candidate
       JOIN workspace_tenant_retirement_scope selected
         ON selected.table_oid = $1::oid
        AND selected.row_tid = candidate.ctid::text
     ) scoped`,
    [relation.oid],
  )
  const contentDigest = result.rows[0]?.content_digest
  if (!SHA256.test(contentDigest || '')) {
    fail(`Could not bind selected row content for ${relation.name}`)
  }
  return contentDigest
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

async function preservedForeignKeyBlockers(client, catalog, selectedOids) {
  const blockers = []
  for (const foreignKey of catalog.foreignKeys) {
    const child = catalog.relationByOid.get(foreignKey.child_oid)
    const parent = catalog.relationByOid.get(foreignKey.parent_oid)
    const handlerIdentity = child && parent
      ? `${child.name}.${foreignKey.childColumns.join(',')}:${foreignKey.deleteAction}->${parent.name}.${foreignKey.parentColumns.join(',')}`
      : ''
    if (!child || !parent || !selectedOids.has(parent.oid)
      || selectedOids.has(child.oid)
      || !PRESERVED_TABLES.has(child.name)
      || SPECIAL_PRESERVED_FK_HANDLERS.has(handlerIdentity)) continue
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
        deleteAction: foreignKey.deleteAction,
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
    const roleColumns = new Set(
      catalog.organizationOwnership.roles
        .filter((role) => role.table === relation.name)
        .map((role) => role.column),
    )
    for (const column of relation.columns.filter((item) => (
      item.typeOid === '2950' && roleColumns.has(item.name)
    ))) {
      const result = await client.query(
        `SELECT count(*)::integer AS count
         FROM ${qualified(relation)} candidate
         JOIN workspace_tenant_retirement_scope selected
           ON selected.table_oid = $1::oid
          AND selected.row_tid = candidate.ctid::text
         WHERE candidate.${quoteIdentifier(column.name)} IS NOT NULL
           AND NOT candidate.${quoteIdentifier(column.name)} = ANY($2::uuid[])`,
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

async function protectedScopeBlockers(client, catalog) {
  const blockers = []
  for (const protectedGroup of [
    {
      table: 'pipeline_spaces',
      ids: [PROTECTED_SHARED_PIPELINE.pipelineId],
    },
    {
      table: 'crm_organizations',
      ids: PROTECTED_LEGACY_CRM_ORGANIZATIONS.map((record) => record.crmOrganizationId),
    },
  ]) {
    const relation = catalog.relations.find((candidate) => candidate.name === protectedGroup.table)
    if (!relation) {
      blockers.push({ table: protectedGroup.table, reason: 'protected_table_missing' })
      continue
    }
    const result = await client.query(
      `SELECT candidate.id::text
       FROM ${qualified(relation)} candidate
       JOIN workspace_tenant_retirement_scope selected
         ON selected.table_oid = $1::oid
        AND selected.row_tid = candidate.ctid::text
       WHERE candidate.id = ANY($2::uuid[])
       ORDER BY candidate.id`,
      [relation.oid, protectedGroup.ids],
    )
    blockers.push(...result.rows.map((row) => ({
      table: protectedGroup.table,
      id: row.id,
      reason: 'protected_row_entered_scope',
    })))
  }
  return blockers
}

async function selectedOutboxRecords(client, catalog) {
  const relation = catalog.relations.find((candidate) => candidate.name === 'sync_outbox')
  if (!relation) fail('sync_outbox is missing from the runtime catalog')
  const result = await client.query(
    `SELECT candidate.id::text, candidate.aggregate_type, candidate.aggregate_id,
            candidate.operation, candidate.target_system, candidate.status
     FROM public.sync_outbox candidate
     JOIN workspace_tenant_retirement_scope selected
       ON selected.table_oid = $1::oid
      AND selected.row_tid = candidate.ctid::text
     ORDER BY candidate.id`,
    [relation.oid],
  )
  return result.rows.map((row) => ({
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    operation: row.operation,
    targetSystem: row.target_system,
    status: row.status,
  }))
}

function unexpectedOutboxRecords(records, targets) {
  const expectedAggregateIds = targets.map((target) => target.crmOrganizationId).sort()
  const observedAggregateIds = records.map((record) => record.aggregateId).sort()
  if (canonicalJson(observedAggregateIds) !== canonicalJson(expectedAggregateIds)) {
    return [{
      reason: 'audited_outbox_identity_multiset_mismatch',
      expected: expectedAggregateIds,
      observed: observedAggregateIds,
    }]
  }
  const expectedAggregateIdSet = new Set(expectedAggregateIds)
  return records.filter((record) => (
    record.aggregateType !== 'crm_organizations'
      || !expectedAggregateIdSet.has(record.aggregateId)
      || record.operation !== 'upsert_record'
      || record.targetSystem !== 'suitecrm'
      || record.status !== 'succeeded'
  )).map((record) => ({ ...record, reason: 'audited_outbox_identity_mismatch' }))
}

async function scopeSummary(client, catalog, targets) {
  const counts = {}
  const selectedContentDigests = {}
  const selectedRelations = []
  for (const relation of catalog.relations) {
    const count = await selectedCount(client, relation)
    if (count > 0) {
      counts[relation.name] = count
      selectedContentDigests[relation.name] = await selectedContentDigest(client, relation)
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
  const preservedForeignKeys = await preservedForeignKeyBlockers(client, catalog, selectedOids)
  const crossTenantRows = await crossTenantScopeBlockers(
    client, catalog, selectedRelations, targets,
  )
  const protectedRows = await protectedScopeBlockers(client, catalog)
  const preservation = await preservationSnapshot(client)
  const outboxRecords = await selectedOutboxRecords(client, catalog)
  const unexpectedOutbox = unexpectedOutboxRecords(outboxRecords, targets)
  const unexpectedExpectedCounts = Object.entries(EXPECTED_SELECTED_SCOPE_COUNTS)
    .filter(([table, expected]) => (counts[table] || 0) !== expected)
    .map(([table, expected]) => ({ table, expected, observed: counts[table] || 0 }))
  const expectedSelectedRelations = new Set(Object.keys(EXPECTED_SELECTED_SCOPE_COUNTS))
  const unexpectedSelectedRelations = Object.keys(counts)
    .filter((table) => !expectedSelectedRelations.has(table))
    .map((table) => ({ table, observed: counts[table] }))
  const triggers = catalog.triggers.filter((trigger) => (
    (selectedOids.has(trigger.tableOid) || trigger.table === 'short_link_clicks')
      && trigger.enabled !== 'D'
  )).map(({ table, name, enabled, definitionDigest }) => ({
    table, name, enabled, definitionDigest,
  }))
  const registryRows = await selectedReferences(client, catalog)
  const preservedReferenceSet = new Set(PRESERVED_SHARED_REFERENCE_CODES)
  const preservedReferences = registryRows
    .filter((row) => preservedReferenceSet.has(row.reference_code))
    .map((row) => row.reference_code)
  const references = registryRows
    .filter((row) => !preservedReferenceSet.has(row.reference_code))
    .map((row) => row.reference_code)
  const suiteCrmRecords = await selectedSuiteCrmRecords(client, catalog)
  const shortLinks = await client.query(
    `SELECT id::text, slug, organization_root_id::text
     FROM short_links
     WHERE organization_root_id = ANY($1::uuid[])
        OR slug = ANY($2::text[])
     ORDER BY id`,
    [
      targets.map((target) => target.organizationId),
      references,
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
  const userReplacements = (await affectedUserReplacements(client, targets)).map((row) => ({
    email: row.email,
    replacementOrganizationId: row.replacement_organization_id,
    replacementOrganizationName: row.replacement_organization_name,
  }))
  const specialCounts = {
    shortLinksRetired: shortLinks.rows.length,
    shortLinkClicksDeleted: Number(shortLinkClicks.rows[0]?.count || 0),
    preservedAuditEvents: Number(audits.rows[0]?.count || 0),
    applicationUsersReassignedOrDetached: userReplacements.length,
  }
  const unexpectedSpecialCounts = Object.entries(EXPECTED_SPECIAL_SCOPE_COUNTS)
    .filter(([field, expected]) => specialCounts[field] !== expected)
    .map(([field, expected]) => ({ field, expected, observed: specialCounts[field] }))
  const blockers = {
    unclassifiedOrganizationRoles: catalog.organizationOwnership.unclassified,
    relationCycles: order.cycles,
    selfReferences,
    preservedForeignKeys,
    crossTenantRows,
    protectedRows,
    protectedRecordDrift: preservation.ready ? [] : [{ reason: 'protected_record_drift' }],
    unexpectedOutbox,
    unexpectedExpectedCounts,
    unexpectedSelectedRelations,
    unexpectedSpecialCounts,
  }
  const scopeProjection = {
    counts,
    selectedContentDigests,
    specialCounts,
    shortLinks: shortLinks.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      organizationRootId: row.organization_root_id,
    })),
    references,
    preservedReferences,
    registryStatuses: registryRows,
    preservation,
    outboxRecords,
    userReplacements,
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
    deleteTriggerDigest: digest(triggers),
  }
}

function publicScope(scope) {
  return {
    counts: scope.counts,
    selectedContentDigests: scope.selectedContentDigests,
    specialCounts: scope.specialCounts,
    shortLinks: scope.shortLinks,
    references: scope.references,
    preservedReferences: scope.preservedReferences,
    registryStatuses: scope.registryStatuses,
    preservation: scope.preservation,
    outboxRecords: scope.outboxRecords,
    userReplacements: scope.userReplacements,
    suiteCrmRecords: scope.suiteCrmRecords,
    suiteCrmDigest: scope.suiteCrmDigest,
    deleteTriggerDigest: scope.deleteTriggerDigest,
    deleteOrder: scope.deleteOrder,
    disabledDeleteTriggers: scope.disabledDeleteTriggers,
    blockers: scope.blockers,
    scopeDigest: scope.scopeDigest,
    applyReady: scope.applyReady,
  }
}

async function buildPlan(client, options, endpointProof, databaseBoundary) {
  const identity = await databaseIdentity(client, databaseBoundary)
  await assertReceiptMigration(client)
  const observedTargets = await exactTargets(client, options.targets)
  await assertOperatorOwnsTargets(client, options.actor, options.targets)
  const targetGraph = await exactTargetGraph(client, options.targets)
  const pipelines = targetGraph.pipelines
  const lockCatalog = await loadLockCatalog(client)
  const catalog = await loadCatalog(client)
  const scope = await prepareScope(client, catalog, options.targets, pipelines)
  const plan = {
    format: PLAN_FORMAT,
    scriptVersion: SCRIPT_VERSION,
    createdAt: new Date().toISOString(),
    environment: options.environment,
    railwayProjectId: options.railwayProjectId,
    railwayEnvironmentId: options.railwayEnvironmentId,
    railwayServiceId: options.railwayServiceId,
    database: {
      identity: identity.database_identity,
      name: identity.database_name,
      user: identity.database_user,
      postgresSystemIdentifier: identity.postgres_system_identifier,
      endpointSha256: endpointProof.endpointSha256,
    },
    validatedBackup: options.backupEvidence,
    actor: options.actor,
    targets: options.targets,
    observedTargets,
    targetGraph,
    lockCatalogDigest: lockCatalog.digest,
    lockedRelations: lockCatalog.relations,
    catalogDigest: catalog.digest,
    organizationOwnership: catalog.organizationOwnership,
    scope: publicScope(scope),
    externalSystems: {
      suiteCrm: {
        action: 'not_called',
        projectedRecordsRetainedExternally: scope.suiteCrmRecords.length,
        acknowledgementDigest: scope.suiteCrmDigest,
        limitation: 'Local deletion does not delete or anonymize SuiteCRM records.',
      },
      commerceAndCarrierProviders: { action: 'not_called' },
      googleWorkspace: { action: 'not_called' },
      retainedHistory: {
        action: 'preserved_not_anonymized',
        auditEvents: scope.specialCounts.preservedAuditEvents,
        nonForeignKeyPayloadScan: 'not_performed',
        knownPotentialLocalResidueColumns: [
          'app_settings.value',
          'audit_events.payload',
          'data_checkpoints.snapshot',
          'pipeline_sheet_rows.payload',
          'pipeline_sheet_rows.sheet_values',
          'sync_outbox.payload',
        ],
        limitation: 'Historical payloads and provider records remain intentionally unmodified; this operation does not prove no-trace erasure across history, backups, source code, or external systems.',
      },
    },
    applyReady: scope.applyReady,
  }
  plan.manifestDigest = manifestDigest(plan)
  return { plan, catalog, scope }
}

function assertManifest(manifest, options, endpointProof, { requireFresh, databaseBoundary }) {
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
    || age < -PLAN_MAX_FUTURE_SKEW_MS) {
    fail('Reviewed retirement plan is invalid or future-dated')
  }
  if (requireFresh && age > PLAN_MAX_AGE_MS) {
    fail('Reviewed retirement plan is stale')
  }
  if (manifest.environment !== 'production'
    || manifest.railwayProjectId !== options.railwayProjectId
    || manifest.railwayEnvironmentId !== options.railwayEnvironmentId
    || manifest.railwayServiceId !== options.railwayServiceId
    || manifest.database?.identity !== databaseBoundary.databaseIdentity
    || manifest.database?.name !== databaseBoundary.databaseName
    || manifest.database?.user !== databaseBoundary.databaseUser
    || manifest.database?.postgresSystemIdentifier !== databaseBoundary.postgresSystemIdentifier
    || manifest.database?.endpointSha256 !== endpointProof.endpointSha256
    || (options.backupEvidence
      && canonicalJson(manifest.validatedBackup) !== canonicalJson(options.backupEvidence))
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
  if (!Array.isArray(manifest.lockedRelations) || manifest.lockedRelations.length === 0
    || digest(manifest.lockedRelations) !== manifest.lockCatalogDigest) {
    fail('Reviewed full relation lock catalog is missing or invalid')
  }
  const normalized = manifest.lockedRelations.map((relation) => ({
    schema: relation?.schema,
    name: relation?.name,
    kind: relation?.kind,
  }))
  if (normalized.some((relation) => (
    relation.schema !== 'public'
      || !text(relation.name)
      || !['r', 'p'].includes(relation.kind)
  ))) {
    fail('Reviewed full relation lock catalog is not canonical')
  }
  const sorted = [...normalized].sort((left, right) => (
    left.schema.localeCompare(right.schema)
      || left.name.localeCompare(right.name)
      || left.kind.localeCompare(right.kind)
  ))
  if (new Set(normalized.map((relation) => `${relation.schema}.${relation.name}`)).size
    !== normalized.length
    || canonicalJson(normalized) !== canonicalJson(sorted)) {
    fail('Reviewed full relation lock catalog is not canonical')
  }
  const ordered = manifest.lockedRelations.map((relation) => (
    `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`
  ))
  // This is intentionally the first snapshot-relevant apply operation. Every
  // ordinary/partitioned public relation, including empty tenant tables and
  // preserved handlers, is locked before the runtime scope is recomputed.
  await client.query(
    `LOCK TABLE ${ordered.join(', ')} IN ACCESS EXCLUSIVE MODE`,
  )
  const observed = await loadLockCatalog(client)
  if (observed.digest !== manifest.lockCatalogDigest
    || canonicalJson(observed.relations) !== canonicalJson(manifest.lockedRelations)) {
    fail('Runtime relation lock catalog drifted after plan approval')
  }
  return observed
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

async function detachUsersFromTargets(client, replacements) {
  for (const replacement of replacements) {
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid,
           organization_name = $3,
           updated_at = clock_timestamp()
       WHERE email = $1`,
      [
        replacement.email,
        replacement.replacementOrganizationId,
        replacement.replacementOrganizationName,
      ],
    )
  }
}

async function promoteUserReplacementMemberships(client, replacements) {
  for (const replacement of replacements) {
    if (!replacement.replacementOrganizationId) continue
    await client.query(
      `UPDATE app_user_organization_memberships
       SET is_default = true, updated_at = clock_timestamp()
       WHERE user_email = $1 AND organization_id = $2::uuid`,
      [replacement.email, replacement.replacementOrganizationId],
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
  const retiredUuidIds = targets.flatMap((target) => [
    target.organizationId,
    target.pipelineId,
    target.crmOrganizationId,
    target.crmContactId,
  ])
  const uuidOccurrences = []
  const referenceOccurrences = []
  for (const relation of catalog.relations) {
    if (POST_DELETE_UUID_SCAN_EXCLUSIONS.has(relation.name)) continue
    for (const column of relation.columns.filter((item) => item.typeOid === '2950')) {
      const result = await client.query(
        `SELECT count(*)::integer AS count
         FROM ${qualified(relation)}
         WHERE ${quoteIdentifier(column.name)} = ANY($1::uuid[])`,
        [retiredUuidIds],
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
  const audits = await client.query(
    `SELECT count(*)::integer AS count
     FROM audit_events
     WHERE organization_id = ANY($1::uuid[])`,
    [targetIds],
  )
  const preservation = await preservationSnapshot(client, { afterRetirement: true })
  return {
    organizationsRemaining: Number(organizations.rows[0]?.count || 0),
    applicationUsersRemaining: Number(applicationUsers.rows[0]?.count || 0),
    uuidOccurrences,
    referenceOccurrences,
    preservedAuditEvents: Number(audits.rows[0]?.count || 0),
    preservation,
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
    && absence.preservedAuditEvents === EXPECTED_SPECIAL_SCOPE_COUNTS.preservedAuditEvents
    && absence.preservation.ready === true
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
    railwayServiceId: manifest.railwayServiceId,
    databaseIdentity: manifest.database.identity,
    databaseName: manifest.database.name,
    databaseUser: manifest.database.user,
    postgresSystemIdentifier: manifest.database.postgresSystemIdentifier,
    databaseEndpointSha256: endpointProof.endpointSha256,
    validatedBackup: manifest.validatedBackup,
    actorEmail: manifest.actor,
    targets: manifest.targets,
    lockCatalogDigest: manifest.lockCatalogDigest,
    lockedRelations: manifest.lockedRelations,
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
       railway_project_id, railway_environment_id, railway_service_id, database_identity,
       database_name, database_user, postgres_system_identifier,
       database_endpoint_sha256, backup_evidence, actor_email, target_organizations,
       lock_catalog_digest, locked_relations, scope_digest, scope_counts, retired_references,
       disabled_delete_triggers, retired_short_links, suitecrm_records,
       external_system_disposition, deleted_counts, verification
     ) VALUES (
       $1, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10, $11,
       $12, $13::jsonb, $14, $15::jsonb, $16, $17::jsonb, $18, $19::jsonb,
       $20::text[], $21::jsonb, $22::jsonb, $23::jsonb, $24::jsonb, $25::jsonb,
       $26::jsonb
     )
     RETURNING id::text, completed_at`,
    [
      receipt.planDigest,
      receiptDigest,
      receipt.scriptVersion,
      receipt.environment,
      receipt.railwayProjectId,
      receipt.railwayEnvironmentId,
      receipt.railwayServiceId,
      receipt.databaseIdentity,
      receipt.databaseName,
      receipt.databaseUser,
      receipt.postgresSystemIdentifier,
      receipt.databaseEndpointSha256,
      JSON.stringify(receipt.validatedBackup),
      receipt.actorEmail,
      JSON.stringify(receipt.targets),
      receipt.lockCatalogDigest,
      JSON.stringify(receipt.lockedRelations),
      receipt.scopeDigest,
      JSON.stringify(receipt.scopeCounts),
      receipt.retiredReferences,
      JSON.stringify(receipt.disabledDeleteTriggers),
      JSON.stringify(receipt.retiredShortLinks),
      JSON.stringify(receipt.suiteCrmRecords),
      JSON.stringify(receipt.externalSystemDisposition),
      JSON.stringify(receipt.deleted),
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

async function applyManifest(client, manifest, options, endpointProof, databaseBoundary) {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await client.query(`SET LOCAL search_path = pg_catalog, public`)
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    await client.query(`SET LOCAL statement_timeout = '10min'`)
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('clawpilot-schema-migrations'))`,
    )
    await lockApplyRelations(client, manifest)
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
    await databaseIdentity(client, databaseBoundary)
    await assertReceiptMigration(client)
    const existingReceipt = await client.query(
      `SELECT id::text FROM workspace_tenant_retirement_receipts WHERE plan_digest = $1`,
      [manifest.manifestDigest],
    )
    if (existingReceipt.rows.length) {
      await client.query('ROLLBACK')
      return { alreadyApplied: true, receipt: { id: existingReceipt.rows[0].id } }
    }
    assertManifest(manifest, options, endpointProof, {
      requireFresh: true,
      databaseBoundary,
    })
    await exactTargets(client, options.targets)
    await assertOperatorOwnsTargets(client, options.actor, options.targets)
    const targetGraph = await exactTargetGraph(client, options.targets)
    const pipelines = targetGraph.pipelines
    const catalog = await loadCatalog(client)
    const lockedCatalogCheck = await loadLockCatalog(client)
    if (lockedCatalogCheck.digest !== manifest.lockCatalogDigest) {
      fail('Runtime relation lock catalog changed while recomputing scope')
    }
    const scope = await prepareScope(client, catalog, options.targets, pipelines)
    assertScopeUnchanged(manifest, scope, catalog)
    if (scope.suiteCrmRecords.length > 0
      && options.suiteCrmAcknowledgement !== scope.suiteCrmDigest) {
      fail(`SuiteCRM is not called; --acknowledge-suitecrm-retained=${scope.suiteCrmDigest} is required`)
    }
    if (scope.disabledDeleteTriggers.length > 0
      && options.deleteTriggerAcknowledgement !== scope.deleteTriggerDigest) {
      fail(`Delete triggers are bypassed; --acknowledge-delete-triggers=${scope.deleteTriggerDigest} is required`)
    }
    await disableDeleteTriggers(client, scope.disabledDeleteTriggers)
    await detachUsersFromTargets(client, scope.userReplacements)
    const shortLinks = await retireShortLinks(client, scope.shortLinks)
    if (shortLinks.links !== scope.specialCounts.shortLinksRetired
      || shortLinks.clicks !== scope.specialCounts.shortLinkClicksDeleted) {
      fail('Short-link retirement scope changed during apply')
    }
    await retireReferences(client, scope.references)
    const deleted = await deleteScopedRows(client, catalog, scope)
    await promoteUserReplacementMemberships(client, scope.userReplacements)
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

export function storedReceiptProjection(row) {
  return {
    format: RECEIPT_FORMAT,
    scriptVersion: row.script_version,
    planDigest: row.plan_digest,
    environment: row.environment,
    railwayProjectId: row.railway_project_id,
    railwayEnvironmentId: row.railway_environment_id,
    railwayServiceId: row.railway_service_id,
    databaseIdentity: row.database_identity,
    databaseName: row.database_name,
    databaseUser: row.database_user,
    postgresSystemIdentifier: row.postgres_system_identifier,
    databaseEndpointSha256: row.database_endpoint_sha256,
    validatedBackup: row.backup_evidence,
    actorEmail: row.actor_email,
    targets: row.target_organizations,
    lockCatalogDigest: row.lock_catalog_digest,
    lockedRelations: row.locked_relations,
    scopeDigest: row.scope_digest,
    scopeCounts: row.scope_counts,
    retiredReferences: row.retired_references,
    retiredShortLinks: row.retired_short_links,
    disabledDeleteTriggers: row.disabled_delete_triggers,
    suiteCrmRecords: row.suitecrm_records,
    deleted: row.deleted_counts,
    verification: row.verification,
    externalSystemDisposition: row.external_system_disposition,
  }
}

async function verifyCommitted(client, manifest, options, endpointProof, databaseBoundary) {
  await databaseIdentity(client, databaseBoundary)
  await assertReceiptMigration(client)
  const result = await client.query(
    `SELECT id::text, plan_digest, receipt_digest, script_version, environment,
            railway_project_id::text, railway_environment_id::text,
            railway_service_id::text, database_identity::text, database_name, database_user,
            postgres_system_identifier, database_endpoint_sha256, backup_evidence, actor_email,
            target_organizations, lock_catalog_digest, locked_relations,
            scope_digest, scope_counts,
            retired_references, disabled_delete_triggers, retired_short_links,
            suitecrm_records, external_system_disposition, deleted_counts,
            verification, completed_at
     FROM workspace_tenant_retirement_receipts
     WHERE plan_digest = $1`,
    [manifest.manifestDigest],
  )
  if (result.rows.length !== 1) fail('No unique committed retirement receipt exists')
  const row = result.rows[0]
  const storedProjection = storedReceiptProjection(row)
  if (digest(storedProjection) !== row.receipt_digest) {
    fail('Committed retirement receipt digest is invalid')
  }
  if (row.plan_digest !== manifest.manifestDigest
    || row.script_version !== SCRIPT_VERSION
    || row.environment !== 'production'
    || row.railway_project_id !== options.railwayProjectId
    || row.railway_environment_id !== options.railwayEnvironmentId
    || row.railway_service_id !== options.railwayServiceId
    || row.database_identity !== databaseBoundary.databaseIdentity
    || row.database_name !== databaseBoundary.databaseName
    || row.database_user !== databaseBoundary.databaseUser
    || row.postgres_system_identifier !== databaseBoundary.postgresSystemIdentifier
    || row.database_endpoint_sha256 !== endpointProof.endpointSha256
    || canonicalJson(row.backup_evidence) !== canonicalJson(manifest.validatedBackup)
    || row.actor_email !== options.actor
    || row.lock_catalog_digest !== manifest.lockCatalogDigest
    || canonicalJson(row.locked_relations) !== canonicalJson(manifest.lockedRelations)
    || row.scope_digest !== manifest.scope.scopeDigest
    || canonicalJson(row.scope_counts) !== canonicalJson(manifest.scope.counts)
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
    artifactReceipt: {
      ...storedProjection,
      id: row.id,
      completedAt: row.completed_at,
      receiptDigest: row.receipt_digest,
    },
  }
}

export async function run(argv = process.argv.slice(2), environment = process.env, runtime = {}) {
  const options = parseArguments(argv)
  const endpointProof = assertRuntimeEnvironment(options, environment)
  const databaseBoundary = resolveDatabaseBoundary(runtime, environment)
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
        await client.query(`SET LOCAL search_path = pg_catalog, public`)
        const { plan } = await buildPlan(
          client, options, endpointProof, databaseBoundary,
        )
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
          deleteTriggerAcknowledgementDigest: plan.scope.deleteTriggerDigest,
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
    const manifest = readPrivateJson(options.manifest, 'Retirement manifest')
    assertManifest(manifest, options, endpointProof, {
      requireFresh: false,
      databaseBoundary,
    })
    if (options.command === 'apply') {
      const client = await pool.connect()
      let applied
      try {
        applied = await applyManifest(
          client, manifest, options, endpointProof, databaseBoundary,
        )
      } finally {
        client.release()
      }
      const verifier = await pool.connect()
      let verification
      try {
        await verifier.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await verifier.query(`SET LOCAL search_path = pg_catalog, public`)
        verification = await verifyCommitted(
          verifier, manifest, options, endpointProof, databaseBoundary,
        )
        await verifier.query('COMMIT')
      } catch (error) {
        await verifier.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        verifier.release()
      }
      const { artifactReceipt, ...publicVerification } = verification
      const artifact = {
        ...(applied.alreadyApplied ? artifactReceipt : applied.receipt),
        idempotentReplay: applied.alreadyApplied === true,
        postCommitVerification: publicVerification,
      }
      writePrivateJson(options.receiptOutput, artifact)
      return { command: 'apply', receiptOutput: options.receiptOutput, ...publicVerification }
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query(`SET LOCAL search_path = pg_catalog, public`)
      const result = await verifyCommitted(
        client, manifest, options, endpointProof, databaseBoundary,
      )
      await client.query('COMMIT')
      const { artifactReceipt: _artifactReceipt, ...publicResult } = result
      return { command: 'verify', ...publicResult }
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
