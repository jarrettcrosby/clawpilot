#!/usr/bin/env node

/**
 * Selectively migrate the approved CRM/catalog/warehouse configuration from
 * the verified ClawPilot development database into three already-provisioned
 * production workspaces.
 *
 * This is deliberately not a database-clone tool. It never reads credential,
 * cursor, order, webhook-payload, provider-attempt, or SuiteCRM outbox tables.
 * It creates disabled, credential-free sales-channel placeholders and leaves
 * provider reconnection to the supported application workflow.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SCRIPT_VERSION = 'commerce-workspace-production-migration-v1'
export const MANIFEST_FORMAT = 'clawpilot-commerce-workspace-migration-plan-v1'
export const SOURCE_DATABASE_IDENTITY = '750aa268-0e31-4065-a99c-4016e4d4fab1'
export const TARGET_DATABASE_IDENTITY = '0474a18c-649c-491b-bea1-7da006d21d81'
export const CONFIRMED_OWNER_EMAIL = 'jarrett@suburbiasandwichco.com'
export const FORBIDDEN_ALIAS_USER = 'jarrett@bposupplychain.com'

const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u

export const WORKSPACES = Object.freeze([
  Object.freeze({
    key: 'ag-alchemy',
    source: Object.freeze({
      organizationId: '60832306-9876-4384-98e8-e179b427c3c1',
      organizationReference: 'ga4166777',
      pipelineId: '660a9afc-8052-4fb6-bcb9-6347e377b079',
      boards: Object.freeze([
        '1848b3bf-f19a-40f9-b34e-50e3d64a7686',
        'dade3fda-1c75-4b04-8480-d2dc1a87b57c',
      ]),
      warehouseGlobalId: 'gwh5366613',
      excludedOrganizationReferences: Object.freeze([
        'ga9029131', 'ga7935541', 'ga8489525', 'ga5551361',
        'ga9100713', 'ga5649471',
      ]),
      excludedContactReferences: Object.freeze(['gc01v7g9ahm4b4']),
      excludedWarehouseGlobalIds: Object.freeze(['gwhg4dpsfmjp9dm']),
      accounts: Object.freeze([
        Object.freeze({
          id: '03696a20-aaf4-4049-b0e3-051d9b937749',
          globalId: 'gia5156705',
          provider: 'faire',
          environment: 'production',
          displayName: 'Pro Bakery Bites by Ag-Alchemy',
          externalAccountIdSha256: '9ebe274c5db9782fd0da927e41329d428e62aa68a6028ebe22e32810d42f88a2',
          reconnectEligible: true,
        }),
        Object.freeze({
          id: 'da56c6d6-fddd-47c0-bf26-66cdfc42ae2c',
          globalId: 'gia9286799',
          provider: 'shopify',
          environment: 'sandbox',
          displayName: 'AG Alchemy',
          externalAccountIdSha256: '68308a772f11b6110d48de3da8a1360827c1dd616dfb5777992c49544a33d848',
          reconnectEligible: false,
        }),
      ]),
    }),
    target: Object.freeze({
      organizationId: '33785418-9927-4e10-a492-d3a44b9b6f21',
      organizationReference: 'ga42g1438l4j2s',
      pipelineId: 'd0d002ce-d073-4ff1-a5cd-0c8cdd28529d',
      boardMap: Object.freeze({
        '1848b3bf-f19a-40f9-b34e-50e3d64a7686': '207be742-d993-4b23-9a05-5102d05d99d4',
        'dade3fda-1c75-4b04-8480-d2dc1a87b57c': 'b3af8ab9-1ca0-4590-b0c5-ece8e7faebb6',
      }),
    }),
  }),
  Object.freeze({
    key: 'french-florist',
    source: Object.freeze({
      organizationId: 'ae747fcb-eb5f-426c-afff-ee56cf7aeb90',
      organizationReference: 'gaorvsskfp0mbn',
      pipelineId: '57683fcc-6092-4a56-b0b3-e1d6c7b4b79c',
      boards: Object.freeze([
        'fa4f5aad-fbf9-45f5-b12d-78477f61d6e9',
        'd1d26d06-f2d8-45c2-80d6-0669995e3333',
      ]),
      warehouseGlobalId: 'gwhld2uijvt4hib',
      excludedOrganizationReferences: Object.freeze([]),
      excludedContactReferences: Object.freeze([]),
      excludedWarehouseGlobalIds: Object.freeze([]),
      accounts: Object.freeze([
        Object.freeze({
          id: 'c13e4e64-edae-4e73-9ae0-c116c1419688',
          globalId: 'gia585rig3qiq7j',
          provider: 'shopify',
          environment: 'production',
          displayName: 'French Florist',
          externalAccountIdSha256: '3f38b0416975b74695e498db78b878a487b61d406cd2d1ab5deb59438358df12',
          reconnectEligible: true,
        }),
      ]),
    }),
    target: Object.freeze({
      organizationId: '3b9ceada-a4ff-4363-8e78-6069dee76328',
      organizationReference: 'gakrnoh15krp9n',
      pipelineId: '7d82a005-80dc-441e-95e8-3a23ac968ea0',
      boardMap: Object.freeze({
        'fa4f5aad-fbf9-45f5-b12d-78477f61d6e9': 'bd9dd954-885a-4adc-8dcf-26fd276d688e',
        'd1d26d06-f2d8-45c2-80d6-0669995e3333': '530490f7-f24f-4f99-80f5-58f688388a1f',
      }),
    }),
  }),
  Object.freeze({
    key: 'test-pro-bakery-bites',
    source: Object.freeze({
      organizationId: 'c6c8e6e7-fffa-4969-9526-e99da0ab2754',
      organizationReference: 'gauf1348k686f3',
      pipelineId: 'd8ece48b-ba40-44a0-9954-0dbf58723aa8',
      boards: Object.freeze([
        '466ab961-d659-464c-a925-d7ee7fb4f638',
        '1be5a9a9-97d4-4fe8-840c-99c6f205ff0d',
      ]),
      warehouseGlobalId: 'gwhsqvqg0bdpvra',
      excludedOrganizationReferences: Object.freeze(['ga4dac0p3as51t']),
      excludedContactReferences: Object.freeze([]),
      excludedWarehouseGlobalIds: Object.freeze([]),
      accounts: Object.freeze([
        Object.freeze({
          id: '28038134-b624-4b52-8518-e9740785e5c3',
          globalId: 'giah34fedoa5b1o',
          provider: 'shopify',
          environment: 'sandbox',
          displayName: 'Test Pro Bakery Bites',
          externalAccountIdSha256: 'f47f0e6cc3e525a5d5604d8d499ef93381e843ff1cee9100c4283625b9cd0954',
          reconnectEligible: false,
        }),
      ]),
    }),
    target: Object.freeze({
      organizationId: 'c8fcf491-cf8c-469a-b03c-0026a762752c',
      organizationReference: 'gac10cb46e3rpl',
      pipelineId: '8f43d061-057d-42a2-844b-85f89421854d',
      boardMap: Object.freeze({
        '466ab961-d659-464c-a925-d7ee7fb4f638': '41c08e83-f7f1-40f3-a4d2-0766b47add58',
        '1be5a9a9-97d4-4fe8-840c-99c6f205ff0d': '96256e68-bbbc-4ae3-8019-4a6ac3875853',
      }),
    }),
  }),
])

export const DATASET_ORDER = Object.freeze([
  'workspace_organization_preferences',
  'operations_shipping_scopes',
  'crm_product_categories',
  'operations_integration_accounts',
  'crm_organizations',
  'crm_contacts',
  'crm_contact_source_aliases',
  'crm_products',
  'operations_product_mappings',
  'operations_product_channel_states',
  'operations_warehouses',
  'operations_locations',
  'operations_packaging_materials',
  'operations_packaging_material_stock',
  'operations_product_pack_profiles',
  'operations_product_pack_profile_versions',
  'operations_product_pack_relationships',
  'operations_approved_pack_recipes',
  'operations_product_barcodes',
  'operations_product_package_profiles',
  'operations_commerce_variant_pack_mappings',
  'operations_external_identifiers',
  'crm_product_image_assets',
])

export const GENERATED_REFERENCE_PREFIX = Object.freeze({
  crm_organizations: ['reference_code', 'ga'],
  crm_contacts: ['reference_code', 'gc'],
  crm_products: ['reference_code', 'gp'],
  operations_integration_accounts: ['global_id', 'gia'],
  operations_product_mappings: ['global_id', 'gpm'],
  operations_product_channel_states: ['global_id', 'gpcs'],
  operations_warehouses: ['global_id', 'gwh'],
  operations_locations: ['global_id', 'gwl'],
  operations_packaging_materials: ['global_id', 'gmat'],
  operations_packaging_material_stock: ['global_id', 'gmas'],
  operations_product_pack_profiles: ['global_id', 'gpph'],
  operations_product_pack_profile_versions: ['global_id', 'gppv'],
  operations_product_pack_relationships: ['global_id', 'gphr'],
  operations_approved_pack_recipes: ['global_id', 'gpre'],
  operations_product_package_profiles: ['global_id', 'gpp'],
  operations_commerce_variant_pack_mappings: ['global_id', 'gcvm'],
})

const TABLE_ID_COLUMN = Object.freeze({
  crm_product_categories: 'id',
  operations_integration_accounts: 'id',
  crm_organizations: 'id',
  crm_contacts: 'id',
  crm_products: 'id',
  operations_product_mappings: 'id',
  operations_product_channel_states: 'id',
  operations_warehouses: 'id',
  operations_locations: 'id',
  operations_packaging_materials: 'id',
  operations_packaging_material_stock: 'id',
  operations_product_pack_profiles: 'id',
  operations_product_pack_profile_versions: 'id',
  operations_product_pack_relationships: 'id',
  operations_approved_pack_recipes: 'id',
  operations_product_package_profiles: 'id',
  operations_commerce_variant_pack_mappings: 'id',
  crm_product_image_assets: 'id',
})

const TARGET_SCOPE_TABLES = Object.freeze([
  ...DATASET_ORDER,
  'operations_commerce_store_sync_controls',
  'operations_commerce_order_history_policies',
])

export const TARGET_SCOPE_COLUMN = Object.freeze({
  workspace_organization_preferences: 'organization_id',
  operations_shipping_scopes: 'organization_id',
  crm_product_categories: 'pipeline_id',
  operations_integration_accounts: 'organization_id',
  crm_organizations: 'pipeline_id',
  // crm_contacts.organization_id is a CRM-account FK, not a workspace FK.
  crm_contacts: 'pipeline_id',
  crm_contact_source_aliases: 'pipeline_id',
  crm_products: 'pipeline_id',
  operations_product_mappings: 'pipeline_id',
  operations_product_channel_states: 'pipeline_id',
  operations_warehouses: 'organization_id',
  operations_locations: 'organization_id',
  operations_packaging_materials: 'organization_id',
  operations_packaging_material_stock: 'organization_id',
  operations_product_pack_profiles: 'pipeline_id',
  operations_product_pack_profile_versions: 'pipeline_id',
  operations_product_pack_relationships: 'pipeline_id',
  operations_approved_pack_recipes: 'pipeline_id',
  operations_product_barcodes: 'pipeline_id',
  operations_product_package_profiles: 'pipeline_id',
  operations_commerce_variant_pack_mappings: 'pipeline_id',
  operations_external_identifiers: 'organization_id',
  crm_product_image_assets: 'pipeline_id',
  operations_commerce_store_sync_controls: 'organization_id',
  operations_commerce_order_history_policies: 'organization_id',
})

const REQUIRED_TARGET_FUNCTIONS = Object.freeze([
  'guard_commerce_order_history_lease_exclusion',
  'purge_operations_commerce_intake_read_payloads',
  'convert_operations_commerce_inventory_legacy_captures',
  'purge_operations_commerce_inventory_observation_aliases',
  'purge_operations_commerce_inventory_level_evidence',
  'operations_commerce_storage_bloat_health',
])

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
    return {
      $binarySha256: sha256(value),
      $binaryBytes: value.length,
    }
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

function validatedEmail(value, label) {
  const email = text(value).toLowerCase()
  if (!EMAIL.test(email) || email.length > 320) fail(`${label} is invalid`)
  return email
}

function validatedUrl(value, label) {
  const normalized = text(value)
  let parsed
  try { parsed = new URL(normalized) } catch { fail(`${label} must be a PostgreSQL URL`) }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail(`${label} must be a PostgreSQL URL`)
  }
  return normalized
}

function requireValue(args, name) {
  const index = args.indexOf(name)
  if (index < 0 || !text(args[index + 1]) || args[index + 1].startsWith('--')) {
    fail(`${name} requires exactly one value`)
  }
  if (args.indexOf(name, index + 1) >= 0) fail(`${name} may appear only once`)
  return args[index + 1]
}

export function parseArguments(argv) {
  const args = [...argv]
  const command = args.shift()
  if (!['plan', 'apply'].includes(command)) {
    fail('First argument must be plan or apply')
  }
  const allowed = command === 'plan'
    ? new Set(['--actor', '--images', '--output'])
    : new Set(['--actor', '--manifest', '--confirm-digest', '--mapping-output'])
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index])) fail(`Unsupported argument: ${args[index] || '(empty)'}`)
    if (index + 1 >= args.length) fail(`${args[index]} requires a value`)
  }
  const actor = validatedEmail(requireValue(args, '--actor'), '--actor')
  if (actor !== CONFIRMED_OWNER_EMAIL) {
    fail(`--actor must be the confirmed production owner ${CONFIRMED_OWNER_EMAIL}`)
  }
  if (command === 'plan') {
    const images = requireValue(args, '--images')
    if (images !== 'current') fail('--images must equal current')
    return {
      command,
      actor,
      images,
      output: path.resolve(requireValue(args, '--output')),
    }
  }
  const confirmation = requireValue(args, '--confirm-digest').toLowerCase()
  if (!SHA256.test(confirmation)) fail('--confirm-digest must be a SHA-256 digest')
  return {
    command,
    actor,
    manifest: path.resolve(requireValue(args, '--manifest')),
    confirmDigest: confirmation,
    mappingOutput: path.resolve(requireValue(args, '--mapping-output')),
  }
}

export function manifestDigest(manifest) {
  const clone = structuredClone(manifest)
  delete clone.manifestDigest
  return digest(clone)
}

function ensureSafeOutputPath(output) {
  if (fs.existsSync(output)) fail(`Refusing to overwrite existing file: ${output}`)
  const parent = path.dirname(output)
  const stat = fs.statSync(parent)
  if (!stat.isDirectory()) fail(`Output parent is not a directory: ${parent}`)
}

function writePrivateJson(output, value) {
  ensureSafeOutputPath(output)
  const handle = fs.openSync(output, 'wx', 0o600)
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
    fs.fchmodSync(handle, 0o600)
  } finally {
    fs.closeSync(handle)
  }
}

function readManifest(input) {
  const stat = fs.statSync(input)
  if (!stat.isFile()) fail(`Manifest is not a file: ${input}`)
  if ((stat.mode & 0o077) !== 0) fail('Manifest must not be group- or world-accessible')
  const value = JSON.parse(fs.readFileSync(input, 'utf8'))
  if (value.format !== MANIFEST_FORMAT || value.scriptVersion !== SCRIPT_VERSION) {
    fail('Manifest format or script version does not match this tool')
  }
  if (!SHA256.test(value.manifestDigest || '')) fail('Manifest digest is invalid')
  if (manifestDigest(value) !== value.manifestDigest) fail('Manifest contents do not match its digest')
  return value
}

export function topologicalRows(rows, parentColumn, label) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const pending = new Map(byId)
  const ordered = []
  while (pending.size) {
    let progressed = false
    for (const [id, row] of pending) {
      const parent = row[parentColumn]
      if (!parent || !byId.has(parent) || ordered.some((item) => item.id === parent)) {
        if (parent && !byId.has(parent)) fail(`${label} row ${id} has an unselected parent ${parent}`)
        ordered.push(row)
        pending.delete(id)
        progressed = true
      }
    }
    if (!progressed) fail(`${label} contains a parent cycle`)
  }
  return ordered
}

const STRIP_JSON_KEY = /suite.?crm|candidate.?global.?id/iu

export function sanitizeJson(value, replacements = new Map()) {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, replacements))
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      if (STRIP_JSON_KEY.test(key)) continue
      output[key] = sanitizeJson(item, replacements)
    }
    return output
  }
  if (typeof value !== 'string') return value
  let result = value
  const entries = [...replacements.entries()].sort((left, right) => right[0].length - left[0].length)
  for (const [source, target] of entries) result = result.split(source).join(target)
  return result
}

export function buildCredentialFreePlaceholder(source, target, actor) {
  assert.equal(source.integration_type, 'commerce')
  assert.ok(['shopify', 'faire'].includes(source.provider))
  assert.ok(['sandbox', 'production'].includes(source.environment))
  return {
    id: target.id,
    global_id: target.globalId,
    organization_id: target.organizationId,
    provider: source.provider,
    integration_type: 'commerce',
    environment: source.environment,
    external_account_id: null,
    display_name: source.display_name,
    status: 'disabled',
    configuration: {},
    credential_reference: null,
    commerce_credential_generation: 0,
    receipt_intake_enabled: false,
    created_by: actor,
    updated_by: actor,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function loadPg() {
  const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
  return requireFromApp('pg')
}

function poolFor(connectionString) {
  const { Pool } = loadPg()
  return new Pool({
    connectionString,
    ssl: String(process.env.PGSSLMODE || '').toLowerCase() === 'disable'
      ? undefined
      : { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
    statement_timeout: 120_000,
    application_name: SCRIPT_VERSION,
  })
}

async function databaseIdentity(client) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
            value->>'id' AS database_identity
     FROM app_settings
     WHERE key = 'deployment.database.identity'
     LIMIT 1`,
  )
  return result.rows[0] || null
}

async function assertDatabaseIdentities(source, target) {
  const [sourceIdentity, targetIdentity] = await Promise.all([
    databaseIdentity(source),
    databaseIdentity(target),
  ])
  if (sourceIdentity?.database_identity !== SOURCE_DATABASE_IDENTITY) {
    fail('SOURCE_DATABASE_URL is not the verified ClawPilot development database')
  }
  if (targetIdentity?.database_identity !== TARGET_DATABASE_IDENTITY) {
    fail('TARGET_DATABASE_URL is not the verified ClawPilot production database')
  }
  if (sourceIdentity.database_identity === targetIdentity.database_identity) {
    fail('Source and target databases must be different')
  }
  return { source: sourceIdentity, target: targetIdentity }
}

async function tableExists(client, table) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`])
  return result.rows[0]?.present === true
}

async function targetCapabilities(client) {
  const tableRows = await client.query(
    `SELECT requested.name,
            to_regclass('public.' || requested.name) IS NOT NULL AS present
     FROM unnest($1::text[]) AS requested(name)
     ORDER BY requested.name`,
    [[...new Set(TARGET_SCOPE_TABLES)]],
  )
  const functionRows = await client.query(
    `SELECT requested.name,
            EXISTS (
              SELECT 1 FROM pg_proc routine
              JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
              WHERE namespace.nspname = 'public'
                AND routine.proname = requested.name
            ) AS present
     FROM unnest($1::text[]) AS requested(name)
     ORDER BY requested.name`,
    [REQUIRED_TARGET_FUNCTIONS],
  )
  const purgeColumn = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'operations_commerce_intake_read_intents'
         AND column_name = 'response_purged_at'
     ) AS present`,
  )
  const historyExclusionColumns = await client.query(
    `SELECT count(*)::integer AS count
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operations_commerce_store_sync_read_leases'
       AND column_name = ANY($1::text[])`,
    [[
      'history_exclusion_code',
      'history_excluded_external_order_id',
      'history_excluded_provider_created_at',
    ]],
  )
  return {
    tables: Object.fromEntries(tableRows.rows.map((row) => [row.name, row.present])),
    functions: Object.fromEntries(functionRows.rows.map((row) => [row.name, row.present])),
    intakePayloadRedactionColumn: purgeColumn.rows[0]?.present === true,
    historyLeaseExclusionColumns: historyExclusionColumns.rows[0]?.count === 3,
  }
}

function capabilitiesReady(capabilities) {
  return Object.values(capabilities.tables).every(Boolean)
    && Object.values(capabilities.functions).every(Boolean)
    && capabilities.intakePayloadRedactionColumn
    && capabilities.historyLeaseExclusionColumns
}

async function assertScaffold(client, workspace, actor, side) {
  const scope = workspace[side]
  const organization = await client.query(
    `SELECT id::text, reference_code, name
     FROM workspace_organizations
     WHERE id = $1::uuid AND reference_code = $2`,
    [scope.organizationId, scope.organizationReference],
  )
  if (organization.rowCount !== 1) fail(`${workspace.key} ${side} organization scaffold is missing`)
  const pipeline = await client.query(
    `SELECT id::text, workspace_organization_id::text, sheet_id, sync_enabled
     FROM pipeline_spaces
     WHERE id = $1::uuid AND workspace_organization_id = $2::uuid`,
    [scope.pipelineId, scope.organizationId],
  )
  if (pipeline.rowCount !== 1) fail(`${workspace.key} ${side} pipeline scaffold is missing`)
  const boardIds = side === 'source'
    ? workspace.source.boards
    : Object.values(workspace.target.boardMap)
  const boards = await client.query(
    `SELECT id::text FROM project_boards
     WHERE workspace_organization_id = $1::uuid AND id = ANY($2::uuid[])
     ORDER BY id`,
    [scope.organizationId, boardIds],
  )
  if (boards.rowCount !== boardIds.length) fail(`${workspace.key} ${side} board scaffold is incomplete`)
  if (side === 'target') {
    if (pipeline.rows[0].sheet_id !== null || pipeline.rows[0].sync_enabled !== false) {
      fail(`${workspace.key} target pipeline must remain sheet-free with sync disabled`)
    }
    const access = await client.query(
      `SELECT app_user.email,
              app_user.status AS user_status,
              membership.role,
              membership.status AS membership_status
       FROM app_users app_user
       JOIN app_user_organization_memberships membership
         ON membership.user_email = app_user.email
       WHERE app_user.email = $1 AND membership.organization_id = $2::uuid`,
      [actor, scope.organizationId],
    )
    if (
      access.rowCount !== 1
      || access.rows[0].user_status !== 'active'
      || access.rows[0].role !== 'owner'
      || access.rows[0].membership_status !== 'active'
    ) {
      fail(`${workspace.key} target owner membership is not active owner access`)
    }
    const forbidden = await client.query('SELECT 1 FROM app_users WHERE email = $1', [FORBIDDEN_ALIAS_USER])
    if (forbidden.rowCount) {
      fail(`${FORBIDDEN_ALIAS_USER} unexpectedly exists as a production app user; stop for review`)
    }
  }
  return {
    organizationName: organization.rows[0].name,
    pipelineSheetId: pipeline.rows[0].sheet_id,
    pipelineSyncEnabled: pipeline.rows[0].sync_enabled,
  }
}

async function assertSourceAccounts(client, workspace) {
  const ids = workspace.source.accounts.map((account) => account.id)
  const result = await client.query(
    `SELECT id::text, global_id, provider, integration_type, environment,
            display_name,
            encode(digest(coalesce(external_account_id, ''), 'sha256'), 'hex')
              AS external_account_id_sha256
     FROM operations_integration_accounts
     WHERE organization_id = $1::uuid AND id = ANY($2::uuid[])
     ORDER BY id`,
    [workspace.source.organizationId, ids],
  )
  if (result.rowCount !== ids.length) fail(`${workspace.key} source integration account set is incomplete`)
  for (const expected of workspace.source.accounts) {
    const observed = result.rows.find((row) => row.id === expected.id)
    if (
      !observed
      || observed.global_id !== expected.globalId
      || observed.provider !== expected.provider
      || observed.integration_type !== 'commerce'
      || observed.environment !== expected.environment
      || observed.external_account_id_sha256 !== expected.externalAccountIdSha256
    ) {
      fail(`${workspace.key} source account ${expected.globalId} identity changed`)
    }
  }
  return result.rows
}

function selectedAccountIds(workspace) {
  return workspace.source.accounts.map((account) => account.id)
}

async function rows(client, sql, params = []) {
  return (await client.query(sql, params)).rows
}

export function sourceSnapshotProjection(data) {
  const projection = {}
  for (const table of DATASET_ORDER) {
    projection[table] = (data[table] || []).map((row) => {
      if (table !== 'crm_product_image_assets') return row
      const copy = { ...row }
      delete copy.content_bytes
      return copy
    })
  }
  return projection
}

export function datasetCounts(data) {
  return Object.fromEntries(DATASET_ORDER.map((table) => [table, data[table]?.length || 0]))
}

async function loadWorkspaceData(client, workspace, options = {}) {
  const org = workspace.source.organizationId
  const pipeline = workspace.source.pipelineId
  const accounts = selectedAccountIds(workspace)
  const excludedOrganizations = workspace.source.excludedOrganizationReferences
  const excludedContacts = workspace.source.excludedContactReferences
  const warehouseGlobalId = workspace.source.warehouseGlobalId
  const data = {}

  data.workspace_organization_preferences = await rows(client,
    `SELECT * FROM workspace_organization_preferences
     WHERE organization_id = $1::uuid ORDER BY organization_id`, [org])
  data.operations_shipping_scopes = await rows(client,
    `SELECT * FROM operations_shipping_scopes
     WHERE organization_id = $1::uuid ORDER BY organization_id`, [org])
  data.crm_product_categories = await rows(client,
    `SELECT * FROM crm_product_categories
     WHERE pipeline_id = $1::uuid ORDER BY id`, [pipeline])
  data.operations_integration_accounts = await rows(client,
    `SELECT id, global_id, organization_id, provider, integration_type,
            environment, display_name, status,
            created_by, updated_by, created_at, updated_at
     FROM operations_integration_accounts
     WHERE organization_id = $1::uuid AND id = ANY($2::uuid[])
     ORDER BY id`, [org, accounts])
  data.crm_organizations = await rows(client,
    `SELECT * FROM crm_organizations
     WHERE pipeline_id = $1::uuid
       AND NOT (reference_code = ANY($2::text[]))
     ORDER BY id`, [pipeline, excludedOrganizations])
  const selectedOrganizationIds = data.crm_organizations.map((row) => row.id)
  const selectedOrganizationReferences = data.crm_organizations.map((row) => row.reference_code)
  data.crm_contacts = await rows(client,
    `SELECT * FROM crm_contacts
     WHERE pipeline_id = $1::uuid
       AND organization_id = ANY($2::uuid[])
       AND NOT (reference_code = ANY($3::text[]))
     ORDER BY id`, [pipeline, selectedOrganizationIds, excludedContacts])
  const selectedContactIds = data.crm_contacts.map((row) => row.id)
  data.crm_contact_source_aliases = await rows(client,
    `SELECT alias.* FROM crm_contact_source_aliases alias
     WHERE alias.pipeline_id = $1::uuid
       AND alias.contact_id = ANY($2::uuid[])
     ORDER BY alias.source_key`, [pipeline, selectedContactIds])
  data.crm_products = await rows(client,
    `SELECT * FROM crm_products
     WHERE pipeline_id = $1::uuid ORDER BY id`, [pipeline])
  const selectedProductIds = data.crm_products.map((row) => row.id)
  data.operations_product_mappings = await rows(client,
    `SELECT * FROM operations_product_mappings
     WHERE organization_id = $1::uuid
       AND pipeline_id = $2::uuid
       AND integration_account_id = ANY($3::uuid[])
       AND product_id = ANY($4::uuid[])
     ORDER BY id`, [org, pipeline, accounts, selectedProductIds])
  const selectedMappingIds = data.operations_product_mappings.map((row) => row.id)
  data.operations_product_channel_states = await rows(client,
    `SELECT * FROM operations_product_channel_states
     WHERE organization_id = $1::uuid
       AND pipeline_id = $2::uuid
       AND integration_account_id = ANY($3::uuid[])
       AND (
         (product_id IS NULL AND product_mapping_id IS NULL)
         OR (product_id = ANY($4::uuid[]) AND product_mapping_id = ANY($5::uuid[]))
       )
     ORDER BY id`, [org, pipeline, accounts, selectedProductIds, selectedMappingIds])
  data.operations_warehouses = await rows(client,
    `SELECT * FROM operations_warehouses
     WHERE organization_id = $1::uuid AND global_id = $2 ORDER BY id`,
    [org, warehouseGlobalId])
  if (data.operations_warehouses.length !== 1) {
    fail(`${workspace.key} must have exactly one selected real warehouse`)
  }
  const warehouseId = data.operations_warehouses[0].id
  data.operations_locations = await rows(client,
    `SELECT * FROM operations_locations
     WHERE organization_id = $1::uuid AND warehouse_id = $2::uuid ORDER BY id`,
    [org, warehouseId])
  data.operations_packaging_materials = await rows(client,
    `SELECT * FROM operations_packaging_materials
     WHERE organization_id = $1::uuid ORDER BY id`, [org])
  const invalidMaterials = data.operations_packaging_materials
    .filter((row) => row.source_integration_account_id != null)
  if (invalidMaterials.length) {
    fail(`${workspace.key} packaging materials unexpectedly depend on an integration account`)
  }
  const materialIds = data.operations_packaging_materials.map((row) => row.id)
  data.operations_packaging_material_stock = await rows(client,
    `SELECT * FROM operations_packaging_material_stock
     WHERE organization_id = $1::uuid
       AND warehouse_id = $2::uuid
       AND packaging_material_id = ANY($3::uuid[])
     ORDER BY id`, [org, warehouseId, materialIds])
  data.operations_product_pack_profiles = await rows(client,
    `SELECT * FROM operations_product_pack_profiles
     WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
       AND product_id = ANY($3::uuid[])
     ORDER BY id`, [org, pipeline, selectedProductIds])
  const profileIds = data.operations_product_pack_profiles.map((row) => row.id)
  data.operations_product_pack_profile_versions = await rows(client,
    `SELECT * FROM operations_product_pack_profile_versions
     WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
       AND profile_id = ANY($3::uuid[])
     ORDER BY id`, [org, pipeline, profileIds])
  const versionIds = data.operations_product_pack_profile_versions.map((row) => row.id)
  data.operations_product_pack_relationships = await rows(client,
    `SELECT * FROM operations_product_pack_relationships
     WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
       AND parent_profile_version_id = ANY($3::uuid[])
       AND child_profile_version_id = ANY($3::uuid[])
     ORDER BY id`, [org, pipeline, versionIds])
  data.operations_approved_pack_recipes = await rows(client,
    `SELECT * FROM operations_approved_pack_recipes
     WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
       AND input_pack_profile_version_id = ANY($3::uuid[])
       AND output_pack_profile_version_id = ANY($3::uuid[])
       AND packaging_material_id = ANY($4::uuid[])
     ORDER BY id`, [org, pipeline, versionIds, materialIds])
  data.operations_product_barcodes = await rows(client,
    `SELECT * FROM operations_product_barcodes
     WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
       AND product_id = ANY($3::uuid[])
     ORDER BY product_id`, [org, pipeline, selectedProductIds])
  data.operations_product_package_profiles = await rows(client,
    `SELECT * FROM operations_product_package_profiles
     WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
       AND product_id = ANY($3::uuid[])
     ORDER BY id`, [org, pipeline, selectedProductIds])
  data.operations_commerce_variant_pack_mappings = await rows(client,
    `SELECT * FROM operations_commerce_variant_pack_mappings
     WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
       AND integration_account_id = ANY($3::uuid[])
       AND product_id = ANY($4::uuid[])
       AND default_pack_profile_version_id = ANY($5::uuid[])
       AND mapping_purpose = 'catalog'
     ORDER BY id`, [org, pipeline, accounts, selectedProductIds, versionIds])
  data.operations_external_identifiers = await rows(client,
    `SELECT * FROM operations_external_identifiers
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($3::uuid[])
       AND entity_type = 'crm.organization'
       AND entity_global_id = ANY($2::text[])
     ORDER BY integration_account_id, entity_type, external_id`,
    [org, selectedOrganizationReferences, accounts])
  data.crm_product_image_assets = await rows(client,
    `SELECT ${options.includeImageBytes ? 'selected.*' : 'selected.id, selected.organization_id, selected.pipeline_id, selected.product_id, selected.asset_revision, selected.mime_type, selected.content_sha256, selected.byte_length, selected.pixel_width, selected.pixel_height, selected.alt_text, selected.source, selected.is_primary, selected.row_version, selected.created_by, selected.updated_by, selected.created_at, selected.updated_at'}
     FROM (
       SELECT DISTINCT ON (image.pipeline_id, image.product_id) image.*
       FROM crm_product_image_assets image
       WHERE image.organization_id = $1::uuid
         AND image.pipeline_id = $2::uuid
         AND image.product_id = ANY($3::uuid[])
       ORDER BY image.pipeline_id, image.product_id,
                image.is_primary DESC, image.asset_revision DESC, image.id
     ) selected
     ORDER BY selected.product_id`, [org, pipeline, selectedProductIds])

  for (const table of DATASET_ORDER) {
    if (!Array.isArray(data[table])) fail(`Internal error: ${table} was not selected`)
  }
  return data
}

async function sourceBlockers(client, workspace) {
  const org = workspace.source.organizationId
  const accounts = selectedAccountIds(workspace)
  const controls = await rows(client,
    `SELECT account.id::text AS integration_account_id,
            account.global_id,
            control.desired_state,
            control.explicit_choice,
            operations_commerce_store_sync_is_running(account.organization_id, account.id) AS effective_running
     FROM operations_integration_accounts account
     LEFT JOIN operations_commerce_store_sync_controls control
       ON control.organization_id = account.organization_id
      AND control.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid AND account.id = ANY($2::uuid[])
     ORDER BY account.id`, [org, accounts])
  const activeLeases = await rows(client,
    `SELECT integration_account_id::text, count(*)::integer AS count
     FROM operations_commerce_store_sync_read_leases
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
       AND released_at IS NULL AND expires_at > clock_timestamp()
     GROUP BY integration_account_id ORDER BY integration_account_id`, [org, accounts])
  const continuations = await rows(client,
    `SELECT integration_account_id::text, count(*)::integer AS count
     FROM operations_commerce_intake_continuations
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
       AND cursor_state = 'available' AND expires_at > clock_timestamp()
     GROUP BY integration_account_id ORDER BY integration_account_id`, [org, accounts])
  const externalEffects = await rows(client,
    `SELECT integration_account_id::text, global_id, action, state, error_code
     FROM operations_commerce_external_effect_intents
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
       AND state IN ('pending', 'claimed', 'unknown')
     ORDER BY integration_account_id, global_id`, [org, accounts])
  const webhooks = await rows(client,
    `SELECT integration_account_id::text, state, count(*)::integer AS count
     FROM operations_commerce_webhook_receipts
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
       AND state IN ('held', 'queued', 'processing', 'failed')
     GROUP BY integration_account_id, state
     ORDER BY integration_account_id, state`, [org, accounts])
  const paused = controls.length === accounts.length && controls.every((control) => (
    control.desired_state === 'paused'
    && control.explicit_choice === true
    && control.effective_running === false
  ))
  return {
    controls,
    activeLeases,
    availableContinuations: continuations,
    unresolvedExternalEffects: externalEffects,
    actionableWebhooks: webhooks,
    ready: paused
      && activeLeases.length === 0
      && continuations.length === 0
      && externalEffects.length === 0
      && webhooks.length === 0,
  }
}

const NONEMPTY_GUARD_TABLES = DATASET_ORDER.filter((table) => ![
  'workspace_organization_preferences',
  'operations_shipping_scopes',
].includes(table))

async function scopedTargetCount(client, table, workspace) {
  if (!IDENTIFIER.test(table)) fail(`Unsafe table identifier: ${table}`)
  const columns = await rows(client,
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`, [table])
  const names = new Set(columns.map((row) => row.column_name))
  if (!names.size) return 0
  const scopeColumn = TARGET_SCOPE_COLUMN[table]
  if (!scopeColumn || !names.has(scopeColumn)) {
    fail(`Cannot derive exact target scope for ${table}`)
  }
  const scopeValue = scopeColumn === 'pipeline_id'
    ? workspace.target.pipelineId
    : workspace.target.organizationId
  return Number((await client.query(
    `SELECT count(*)::bigint AS count FROM ${quotedIdentifier(table)}
     WHERE ${quotedIdentifier(scopeColumn)} = $1::uuid`,
    [scopeValue],
  )).rows[0].count)
}

async function targetCounts(client, workspace) {
  const output = {}
  for (const table of NONEMPTY_GUARD_TABLES) output[table] = await scopedTargetCount(client, table, workspace)
  return output
}

function targetIsEmpty(counts) {
  return Object.values(counts).every((count) => count === 0)
}

function safeAccountPlan(account, observed) {
  return {
    sourceId: account.id,
    sourceGlobalId: account.globalId,
    provider: account.provider,
    environment: account.environment,
    displayName: observed.display_name,
    externalAccountIdSha256: account.externalAccountIdSha256,
    reconnectEligible: account.reconnectEligible,
    productionDisposition: account.reconnectEligible
      ? 'disabled_placeholder_reconnect_after_cutover_gates'
      : 'disabled_placeholder_do_not_connect_without_production_identity_proof',
  }
}

async function targetStorageBaseline(client, capabilities) {
  const database = (await client.query(
    `SELECT current_database() AS database_name,
            pg_database_size(current_database())::bigint AS database_bytes,
            clock_timestamp() AS checked_at`,
  )).rows[0]
  const relationNames = [
    'operations_commerce_intake_read_intents',
    'operations_commerce_inventory_captures',
    'operations_commerce_inventory_sync_runs',
    'operations_commerce_inventory_levels',
  ]
  const relations = {}
  for (const relation of relationNames) {
    if (!await tableExists(client, relation)) {
      relations[relation] = null
      continue
    }
    relations[relation] = (await client.query(
      `SELECT count(*)::bigint AS row_count,
              pg_total_relation_size($1::regclass)::bigint AS total_bytes`,
      [relation],
    )).rows[0]
  }
  const guardHealth = capabilities.functions.operations_commerce_storage_bloat_health
    ? (await client.query(
      'SELECT operations_commerce_storage_bloat_health(1000) AS health',
    )).rows[0]?.health || null
    : null
  return {
    databaseName: database.database_name,
    databaseBytes: database.database_bytes,
    checkedAt: database.checked_at,
    relations,
    guardHealth,
  }
}

async function buildPlan(source, target, actor) {
  const identities = await assertDatabaseIdentities(source, target)
  const capabilities = await targetCapabilities(target)
  const storage = await targetStorageBaseline(target, capabilities)
  const workspacePlans = []
  for (const workspace of WORKSPACES) {
    const [sourceScaffold, targetScaffold, accountRows] = await Promise.all([
      assertScaffold(source, workspace, actor, 'source'),
      assertScaffold(target, workspace, actor, 'target'),
      assertSourceAccounts(source, workspace),
    ])
    const data = await loadWorkspaceData(source, workspace, { includeImageBytes: false })
    validateDatasetClosure(data, workspace)
    const blockers = await sourceBlockers(source, workspace)
    const emptyCounts = await targetCounts(target, workspace)
    const projected = sourceSnapshotProjection(data)
    workspacePlans.push({
      key: workspace.key,
      source: {
        organizationId: workspace.source.organizationId,
        organizationReference: workspace.source.organizationReference,
        pipelineId: workspace.source.pipelineId,
        organizationName: sourceScaffold.organizationName,
      },
      target: {
        organizationId: workspace.target.organizationId,
        organizationReference: workspace.target.organizationReference,
        pipelineId: workspace.target.pipelineId,
        organizationName: targetScaffold.organizationName,
      },
      accounts: workspace.source.accounts.map((account) => safeAccountPlan(
        account,
        accountRows.find((row) => row.id === account.id),
      )),
      counts: datasetCounts(data),
      sourceStateDigest: digest(projected),
      sourceBlockers: blockers,
      targetCounts: emptyCounts,
      targetEmpty: targetIsEmpty(emptyCounts),
      ready: blockers.ready && targetIsEmpty(emptyCounts),
    })
  }
  const plan = {
    format: MANIFEST_FORMAT,
    scriptVersion: SCRIPT_VERSION,
    createdAt: new Date().toISOString(),
    actor,
    images: 'current',
    sourceDatabase: identities.source,
    targetDatabase: identities.target,
    targetCapabilities: capabilities,
    targetCapabilitiesReady: capabilitiesReady(capabilities),
    targetStorageBaseline: storage,
    exclusions: {
      credentials: true,
      cursorsAndContinuationSecrets: true,
      ordersAndImmutableProviderEvidence: true,
      suiteCrmIdsAndOutbox: true,
      providerReconnectsAndWrites: true,
      carrierAndPrinterAccounts: true,
      developmentFixtures: true,
    },
    workspaces: workspacePlans,
  }
  plan.applyReady = plan.targetCapabilitiesReady && workspacePlans.every((workspace) => workspace.ready)
  plan.countFingerprint = digest(workspacePlans.map((workspace) => ({
    key: workspace.key,
    counts: workspace.counts,
    sourceStateDigest: workspace.sourceStateDigest,
    targetCounts: workspace.targetCounts,
  })))
  plan.manifestDigest = manifestDigest(plan)
  return plan
}

async function writableColumns(client, table) {
  if (!IDENTIFIER.test(table)) fail(`Unsafe table identifier: ${table}`)
  const result = await client.query(
    `SELECT column_name, is_generated, is_identity
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`, [table])
  if (!result.rowCount) fail(`Required target table is missing: ${table}`)
  return {
    all: new Set(result.rows.map((row) => row.column_name)),
    writable: new Set(result.rows
      .filter((row) => row.is_generated === 'NEVER' && row.is_identity === 'NO')
      .map((row) => row.column_name)),
  }
}

function quotedIdentifier(value) {
  if (!IDENTIFIER.test(value)) fail(`Unsafe SQL identifier: ${value}`)
  return `"${value}"`
}

async function insertRow(client, table, input, columnCache) {
  const columnInfo = columnCache.get(table) || await writableColumns(client, table)
  columnCache.set(table, columnInfo)
  const unknown = Object.keys(input).filter((column) => !columnInfo.all.has(column))
  if (unknown.length) {
    fail(`${table} target schema is missing source columns: ${unknown.join(', ')}`)
  }
  const entries = Object.entries(input).filter(([column, value]) => (
    value !== undefined && columnInfo.writable.has(column)
  ))
  if (!entries.length) fail(`Refusing empty insert into ${table}`)
  const sql = `INSERT INTO ${quotedIdentifier(table)} (${entries.map(([key]) => quotedIdentifier(key)).join(', ')})
    VALUES (${entries.map((_, index) => `$${index + 1}`).join(', ')})
    RETURNING *`
  return (await client.query(sql, entries.map(([, value]) => value))).rows[0]
}

async function upsertWorkspacePreference(client, sourceRow, workspace, actor) {
  if (!sourceRow) return null
  return (await client.query(
    `INSERT INTO workspace_organization_preferences (
       organization_id, measurement_system, revision, updated_by, created_at, updated_at,
       currency_code
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (organization_id) DO UPDATE SET
       measurement_system = EXCLUDED.measurement_system,
       currency_code = EXCLUDED.currency_code,
       revision = GREATEST(workspace_organization_preferences.revision + 1, EXCLUDED.revision),
       updated_by = EXCLUDED.updated_by,
       updated_at = clock_timestamp()
     RETURNING *`,
    [
      workspace.target.organizationId,
      sourceRow.measurement_system,
      sourceRow.revision,
      actor,
      sourceRow.created_at,
      sourceRow.updated_at,
      sourceRow.currency_code,
    ],
  )).rows[0]
}

async function upsertShippingScope(client, sourceRow, workspace) {
  if (!sourceRow) return null
  return (await client.query(
    `INSERT INTO operations_shipping_scopes (
       organization_id, data_pipeline_id, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3, $4)
     ON CONFLICT (organization_id) DO UPDATE SET
       data_pipeline_id = EXCLUDED.data_pipeline_id,
       updated_at = clock_timestamp()
     RETURNING *`,
    [
      workspace.target.organizationId,
      workspace.target.pipelineId,
      sourceRow.created_at,
      sourceRow.updated_at,
    ],
  )).rows[0]
}

async function allocateReferences(client, prefix, count) {
  if (!count) return []
  const result = await client.query(
    `SELECT ordinal, allocate_global_reference($1) AS reference
     FROM generate_series(1, $2::integer) AS ordinal
     ORDER BY ordinal`, [prefix, count])
  if (result.rowCount !== count) fail(`Failed to allocate ${count} ${prefix} references`)
  return result.rows.map((row) => row.reference)
}

async function targetOwnerIdentity(client, workspace, actor) {
  const result = await client.query(
    `SELECT app_user.email, app_user.reference_code, app_user.display_name
     FROM app_users app_user
     JOIN app_user_organization_memberships membership
       ON membership.user_email = app_user.email
      AND membership.organization_id = $2::uuid
     WHERE app_user.email = $1
       AND app_user.status = 'active'
       AND membership.status = 'active'
       AND membership.role = 'owner'`,
    [actor, workspace.target.organizationId])
  if (result.rowCount !== 1) fail(`${workspace.key} confirmed target owner is not available`)
  return result.rows[0]
}

async function preallocateIdentityMaps(client, data, workspace, owner) {
  const byTable = new Map()
  const replacements = new Map([
    [workspace.source.organizationId, workspace.target.organizationId],
    [workspace.source.organizationReference, workspace.target.organizationReference],
    [workspace.source.pipelineId, workspace.target.pipelineId],
    ...Object.entries(workspace.target.boardMap),
  ])
  for (const table of DATASET_ORDER) {
    const idColumn = TABLE_ID_COLUMN[table]
    if (!idColumn) continue
    const tableMap = new Map()
    const rowsForTable = data[table] || []
    const referenceSpec = GENERATED_REFERENCE_PREFIX[table]
    let references = []
    if (referenceSpec) {
      const [referenceColumn, prefix] = referenceSpec
      const special = rowsForTable.filter((row) => (
        (table === 'crm_organizations'
          && row.workspace_organization_id === workspace.source.organizationId
          && row[referenceColumn] === workspace.source.organizationReference)
        || (table === 'crm_contacts'
          && String(row.app_user_email || '').toLowerCase() === owner.email)
      )).length
      references = await allocateReferences(client, prefix, rowsForTable.length - special)
    }
    let referenceIndex = 0
    for (const row of rowsForTable) {
      const targetIdentity = { id: crypto.randomUUID() }
      if (referenceSpec) {
        const [referenceColumn] = referenceSpec
        if (
          table === 'crm_organizations'
          && row.workspace_organization_id === workspace.source.organizationId
          && row[referenceColumn] === workspace.source.organizationReference
        ) {
          targetIdentity.reference = workspace.target.organizationReference
        } else if (
          table === 'crm_contacts'
          && String(row.app_user_email || '').toLowerCase() === owner.email
        ) {
          targetIdentity.reference = owner.reference_code
        } else {
          targetIdentity.reference = references[referenceIndex++]
        }
        replacements.set(row[referenceColumn], targetIdentity.reference)
      }
      tableMap.set(row[idColumn], targetIdentity)
      replacements.set(row[idColumn], targetIdentity.id)
    }
    byTable.set(table, tableMap)
  }
  return { byTable, replacements, targetPackEvidenceByVariant: new Map() }
}

function requiredMappedId(identityMaps, table, sourceId, label, nullable = false) {
  if (sourceId == null && nullable) return null
  const mapped = identityMaps.byTable.get(table)?.get(sourceId)?.id
  if (!mapped) fail(`${label} references an unselected ${table} row ${sourceId}`)
  return mapped
}

const FK_REMAP = Object.freeze({
  crm_product_categories: Object.freeze({ parent_id: ['crm_product_categories', true] }),
  crm_organizations: Object.freeze({ parent_organization_id: ['crm_organizations', true] }),
  crm_contacts: Object.freeze({ organization_id: ['crm_organizations', false] }),
  crm_contact_source_aliases: Object.freeze({ contact_id: ['crm_contacts', false] }),
  crm_products: Object.freeze({ category_id: ['crm_product_categories', true] }),
  operations_product_mappings: Object.freeze({
    integration_account_id: ['operations_integration_accounts', false],
    product_id: ['crm_products', false],
  }),
  operations_product_channel_states: Object.freeze({
    integration_account_id: ['operations_integration_accounts', false],
    product_id: ['crm_products', true],
    product_mapping_id: ['operations_product_mappings', true],
  }),
  operations_locations: Object.freeze({
    warehouse_id: ['operations_warehouses', false],
    parent_location_id: ['operations_locations', true],
  }),
  operations_packaging_material_stock: Object.freeze({
    packaging_material_id: ['operations_packaging_materials', false],
    warehouse_id: ['operations_warehouses', false],
  }),
  operations_product_pack_profiles: Object.freeze({ product_id: ['crm_products', false] }),
  operations_product_pack_profile_versions: Object.freeze({
    product_id: ['crm_products', false],
    profile_id: ['operations_product_pack_profiles', false],
    provider_weight_channel_state_id: ['operations_product_channel_states', true],
  }),
  operations_product_pack_relationships: Object.freeze({
    product_id: ['crm_products', false],
    parent_profile_version_id: ['operations_product_pack_profile_versions', false],
    child_profile_version_id: ['operations_product_pack_profile_versions', false],
  }),
  operations_approved_pack_recipes: Object.freeze({
    product_id: ['crm_products', false],
    input_pack_profile_version_id: ['operations_product_pack_profile_versions', false],
    output_pack_profile_version_id: ['operations_product_pack_profile_versions', false],
    packaging_material_id: ['operations_packaging_materials', false],
  }),
  operations_product_barcodes: Object.freeze({
    product_id: ['crm_products', false],
    pack_profile_version_id: ['operations_product_pack_profile_versions', true],
  }),
  operations_product_package_profiles: Object.freeze({ product_id: ['crm_products', false] }),
  operations_commerce_variant_pack_mappings: Object.freeze({
    integration_account_id: ['operations_integration_accounts', false],
    product_id: ['crm_products', false],
    default_pack_profile_version_id: ['operations_product_pack_profile_versions', false],
  }),
  operations_external_identifiers: Object.freeze({
    integration_account_id: ['operations_integration_accounts', false],
  }),
  crm_product_image_assets: Object.freeze({ product_id: ['crm_products', false] }),
})

function variantEvidenceKey(row) {
  return [
    row.integration_account_id,
    row.provider,
    row.external_product_id,
    row.external_variant_id,
  ].join(':')
}

function transformRow(table, sourceRow, identityMaps, workspace, actor, owner) {
  const row = sanitizeJson(sourceRow, identityMaps.replacements)
  const identity = TABLE_ID_COLUMN[table]
    ? identityMaps.byTable.get(table)?.get(sourceRow[TABLE_ID_COLUMN[table]])
    : null
  if (TABLE_ID_COLUMN[table]) row.id = identity.id
  const referenceSpec = GENERATED_REFERENCE_PREFIX[table]
  if (referenceSpec) row[referenceSpec[0]] = identity.reference
  if ('organization_id' in row) row.organization_id = workspace.target.organizationId
  if ('pipeline_id' in row) row.pipeline_id = workspace.target.pipelineId
  if ('data_pipeline_id' in row) row.data_pipeline_id = workspace.target.pipelineId
  for (const [column, [targetTable, nullable]] of Object.entries(FK_REMAP[table] || {})) {
    if (column in row) {
      row[column] = requiredMappedId(
        identityMaps,
        targetTable,
        sourceRow[column],
        `${table}.${column}`,
        nullable,
      )
    }
  }
  if ('workspace_organization_id' in row) {
    row.workspace_organization_id = sourceRow.workspace_organization_id == null
      ? null
      : workspace.target.organizationId
  }
  for (const column of [
    'created_by',
    'updated_by',
    'confirmed_by',
    'assigned_by',
    'dimension_confirmed_by',
    'rated_outer_dimension_confirmed_by',
  ]) {
    if (column in row && row[column] != null) row[column] = actor
  }
  if ('app_user_email' in row && row.app_user_email != null) row.app_user_email = actor
  if ('owner_email' in row && row.owner_email != null) row.owner_email = actor
  if ('owner_user_reference_code' in row && row.owner_user_reference_code != null) {
    row.owner_user_reference_code = owner.reference_code
  }
  if ('owner_display_name' in row && row.owner_display_name != null) {
    row.owner_display_name = owner.display_name
  }
  if (['crm_organizations', 'crm_contacts', 'crm_products'].includes(table)) {
    row.suitecrm_id = null
    row.source_sheet_id = null
    row.source_row_number = null
    row.sync_status = 'pending'
    row.sync_error = null
    row.suitecrm_synced_at = null
    row.source_payload = sanitizeJson(sourceRow.source_payload || {}, identityMaps.replacements)
    row.source_hash = sha256(JSON.stringify(row.source_payload))
  }
  if (table === 'crm_contact_source_aliases') {
    row.source_sheet_id = null
    row.source_row_number = null
    row.source_payload = sanitizeJson(sourceRow.source_payload || {}, identityMaps.replacements)
  }
  if (table === 'operations_external_identifiers') {
    const targetReference = identityMaps.replacements.get(sourceRow.entity_global_id)
    if (!targetReference) fail(`External identifier references unselected entity ${sourceRow.entity_global_id}`)
    row.entity_global_id = targetReference
    row.match_evidence = {
      source: SCRIPT_VERSION,
      sourceEntityGlobalIdSha256: sha256(sourceRow.entity_global_id),
    }
    row.last_verified_at = null
  }
  if (
    table === 'operations_product_barcodes'
    && row.barcode_source === 'internal'
  ) {
    const productReference = identityMaps.byTable
      .get('crm_products')?.get(sourceRow.product_id)?.reference
    if (!productReference) fail(`Barcode references unselected product ${sourceRow.product_id}`)
    row.barcode_value = `CP1P-${productReference.toUpperCase()}`
  }
  if (table === 'crm_product_image_assets') {
    row.created_by = actor
    row.updated_by = actor
  }
  if (table === 'operations_commerce_variant_pack_mappings') {
    const evidenceKey = variantEvidenceKey(sourceRow)
    const targetPackEvidence = identityMaps.targetPackEvidenceByVariant.get(evidenceKey)
    if (sourceRow.pack_evidence_hash != null && !targetPackEvidence) {
      fail(`Variant pack mapping lacks selected target channel evidence for ${sourceRow.external_variant_id}`)
    }
    if (targetPackEvidence) row.pack_evidence_hash = targetPackEvidence
  }
  return row
}

function orderedRowsForInsert(table, rowsForTable) {
  if (table === 'crm_product_categories') {
    return topologicalRows(rowsForTable, 'parent_id', table)
  }
  if (table === 'crm_organizations') {
    return topologicalRows(rowsForTable, 'parent_organization_id', table)
  }
  if (table === 'operations_locations' && rowsForTable.some((row) => 'parent_location_id' in row)) {
    return topologicalRows(rowsForTable, 'parent_location_id', table)
  }
  return rowsForTable
}

function selectedIds(data, table) {
  return new Set((data[table] || []).map((row) => row.id))
}

function assertSelectedReference(rowsForTable, column, selected, label, nullable = false) {
  for (const row of rowsForTable || []) {
    const value = row[column]
    if (value == null && nullable) continue
    if (!selected.has(value)) fail(`${label} references an unselected row ${value}`)
  }
}

export function validateDatasetClosure(data, workspace) {
  orderedRowsForInsert('crm_product_categories', data.crm_product_categories)
  orderedRowsForInsert('crm_organizations', data.crm_organizations)
  orderedRowsForInsert('operations_locations', data.operations_locations)

  const accounts = selectedIds(data, 'operations_integration_accounts')
  const organizations = selectedIds(data, 'crm_organizations')
  const contacts = selectedIds(data, 'crm_contacts')
  const categories = selectedIds(data, 'crm_product_categories')
  const products = selectedIds(data, 'crm_products')
  const mappings = selectedIds(data, 'operations_product_mappings')
  const channelStates = selectedIds(data, 'operations_product_channel_states')
  const warehouses = selectedIds(data, 'operations_warehouses')
  const materials = selectedIds(data, 'operations_packaging_materials')
  const profiles = selectedIds(data, 'operations_product_pack_profiles')
  const versions = selectedIds(data, 'operations_product_pack_profile_versions')

  assertSelectedReference(data.crm_contacts, 'organization_id', organizations, 'crm_contacts.organization_id')
  assertSelectedReference(data.crm_contact_source_aliases, 'contact_id', contacts, 'crm_contact_source_aliases.contact_id')
  assertSelectedReference(data.crm_products, 'category_id', categories, 'crm_products.category_id', true)
  assertSelectedReference(data.operations_product_mappings, 'integration_account_id', accounts, 'operations_product_mappings.integration_account_id')
  assertSelectedReference(data.operations_product_mappings, 'product_id', products, 'operations_product_mappings.product_id')
  assertSelectedReference(data.operations_product_channel_states, 'integration_account_id', accounts, 'operations_product_channel_states.integration_account_id')
  assertSelectedReference(data.operations_product_channel_states, 'product_id', products, 'operations_product_channel_states.product_id', true)
  assertSelectedReference(data.operations_product_channel_states, 'product_mapping_id', mappings, 'operations_product_channel_states.product_mapping_id', true)
  assertSelectedReference(data.operations_locations, 'warehouse_id', warehouses, 'operations_locations.warehouse_id')
  assertSelectedReference(data.operations_packaging_material_stock, 'packaging_material_id', materials, 'operations_packaging_material_stock.packaging_material_id')
  assertSelectedReference(data.operations_packaging_material_stock, 'warehouse_id', warehouses, 'operations_packaging_material_stock.warehouse_id')
  assertSelectedReference(data.operations_product_pack_profiles, 'product_id', products, 'operations_product_pack_profiles.product_id')
  assertSelectedReference(data.operations_product_pack_profile_versions, 'product_id', products, 'operations_product_pack_profile_versions.product_id')
  assertSelectedReference(data.operations_product_pack_profile_versions, 'profile_id', profiles, 'operations_product_pack_profile_versions.profile_id')
  assertSelectedReference(data.operations_product_pack_profile_versions, 'provider_weight_channel_state_id', channelStates, 'operations_product_pack_profile_versions.provider_weight_channel_state_id', true)
  for (const table of ['operations_product_pack_relationships', 'operations_approved_pack_recipes']) {
    assertSelectedReference(data[table], 'product_id', products, `${table}.product_id`)
  }
  assertSelectedReference(data.operations_product_pack_relationships, 'parent_profile_version_id', versions, 'operations_product_pack_relationships.parent_profile_version_id')
  assertSelectedReference(data.operations_product_pack_relationships, 'child_profile_version_id', versions, 'operations_product_pack_relationships.child_profile_version_id')
  assertSelectedReference(data.operations_approved_pack_recipes, 'input_pack_profile_version_id', versions, 'operations_approved_pack_recipes.input_pack_profile_version_id')
  assertSelectedReference(data.operations_approved_pack_recipes, 'output_pack_profile_version_id', versions, 'operations_approved_pack_recipes.output_pack_profile_version_id')
  assertSelectedReference(data.operations_approved_pack_recipes, 'packaging_material_id', materials, 'operations_approved_pack_recipes.packaging_material_id')
  assertSelectedReference(data.operations_product_barcodes, 'product_id', products, 'operations_product_barcodes.product_id')
  if ((data.operations_product_barcodes || []).some((row) => 'pack_profile_version_id' in row)) {
    assertSelectedReference(data.operations_product_barcodes, 'pack_profile_version_id', versions, 'operations_product_barcodes.pack_profile_version_id', true)
  }
  assertSelectedReference(data.operations_product_package_profiles, 'product_id', products, 'operations_product_package_profiles.product_id')
  assertSelectedReference(data.operations_commerce_variant_pack_mappings, 'integration_account_id', accounts, 'operations_commerce_variant_pack_mappings.integration_account_id')
  assertSelectedReference(data.operations_commerce_variant_pack_mappings, 'product_id', products, 'operations_commerce_variant_pack_mappings.product_id')
  assertSelectedReference(data.operations_commerce_variant_pack_mappings, 'default_pack_profile_version_id', versions, 'operations_commerce_variant_pack_mappings.default_pack_profile_version_id')
  assertSelectedReference(data.operations_external_identifiers, 'integration_account_id', accounts, 'operations_external_identifiers.integration_account_id')
  assertSelectedReference(data.crm_product_image_assets, 'product_id', products, 'crm_product_image_assets.product_id')

  const selectedEntityReferences = new Set(data.crm_organizations.map((row) => row.reference_code))
  for (const identifier of data.operations_external_identifiers) {
    if (!selectedEntityReferences.has(identifier.entity_global_id)) {
      fail(`operations_external_identifiers.entity_global_id references an unselected CRM organization ${identifier.entity_global_id}`)
    }
  }
  const packEvidenceKeys = new Set(data.operations_product_channel_states.map(variantEvidenceKey))
  for (const mapping of data.operations_commerce_variant_pack_mappings) {
    if (mapping.pack_evidence_hash != null && !packEvidenceKeys.has(variantEvidenceKey(mapping))) {
      fail(`${workspace.key} variant mapping lacks selected channel-state evidence for ${mapping.external_variant_id}`)
    }
  }
  return true
}

async function setPlaceholderPaused(client, workspace, targetAccountId, actor) {
  const result = await client.query(
    `UPDATE operations_commerce_store_sync_controls
     SET desired_state = 'paused',
         explicit_choice = true,
         revision = revision + 1,
         reason = $3,
         updated_by = $4,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
     RETURNING desired_state, explicit_choice, revision`,
    [
      workspace.target.organizationId,
      targetAccountId,
      'Production migration placeholder remains paused until provider identity is reverified',
      actor,
    ])
  if (
    result.rowCount !== 1
    || result.rows[0].desired_state !== 'paused'
    || result.rows[0].explicit_choice !== true
  ) fail(`${workspace.key} placeholder Store sync control was not paused`)
}

async function insertWorkspaceData(client, data, workspace, actor) {
  const owner = await targetOwnerIdentity(client, workspace, actor)
  const identityMaps = await preallocateIdentityMaps(client, data, workspace, owner)
  const columnCache = new Map()
  const inserted = {}
  inserted.workspace_organization_preferences = []
  inserted.operations_shipping_scopes = []
  const preference = await upsertWorkspacePreference(
    client, data.workspace_organization_preferences[0], workspace, actor)
  if (preference) inserted.workspace_organization_preferences.push(preference)
  const shipping = await upsertShippingScope(
    client, data.operations_shipping_scopes[0], workspace)
  if (shipping) inserted.operations_shipping_scopes.push(shipping)

  for (const table of DATASET_ORDER) {
    if (['workspace_organization_preferences', 'operations_shipping_scopes'].includes(table)) continue
    inserted[table] = []
    for (const sourceRow of orderedRowsForInsert(table, data[table])) {
      let transformed
      if (table === 'operations_integration_accounts') {
        const targetIdentity = identityMaps.byTable.get(table).get(sourceRow.id)
        transformed = buildCredentialFreePlaceholder(sourceRow, {
          ...targetIdentity,
          globalId: targetIdentity.reference,
          organizationId: workspace.target.organizationId,
        }, actor)
      } else {
        transformed = transformRow(table, sourceRow, identityMaps, workspace, actor, owner)
      }
      const insertedRow = await insertRow(client, table, transformed, columnCache)
      inserted[table].push(insertedRow)
      if (table === 'operations_product_channel_states') {
        identityMaps.targetPackEvidenceByVariant.set(
          variantEvidenceKey(sourceRow),
          insertedRow.pack_evidence_hash,
        )
      }
      if (table === 'operations_integration_accounts') {
        await setPlaceholderPaused(client, workspace, insertedRow.id, actor)
      }
    }
  }
  const mapping = {}
  for (const [table, tableMap] of identityMaps.byTable) {
    mapping[table] = Object.fromEntries([...tableMap.entries()].map(([sourceId, targetIdentity]) => [
      sourceId,
      targetIdentity,
    ]))
  }
  return { inserted, mapping }
}

async function loadTargetState(client, workspace) {
  const state = {}
  for (const table of DATASET_ORDER) {
    const columns = await rows(client,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`, [table])
    const names = new Set(columns.map((row) => row.column_name))
    if (!names.size) fail(`Required target table is missing: ${table}`)
    let sql
    let params
    const selection = table === 'crm_product_image_assets'
      ? 'id, organization_id, pipeline_id, product_id, asset_revision, mime_type, content_sha256, byte_length, pixel_width, pixel_height, alt_text, source, is_primary, row_version, created_by, updated_by, created_at, updated_at'
      : '*'
    const scopeColumn = TARGET_SCOPE_COLUMN[table]
    if (!scopeColumn || !names.has(scopeColumn)) {
      fail(`Cannot derive target scope for ${table}`)
    }
    sql = `SELECT ${selection} FROM ${quotedIdentifier(table)}
      WHERE ${quotedIdentifier(scopeColumn)} = $1::uuid`
    params = [scopeColumn === 'pipeline_id'
      ? workspace.target.pipelineId
      : workspace.target.organizationId]
    const selected = await rows(client, sql, params)
    state[table] = selected.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  }
  for (const table of [
    'operations_commerce_store_sync_controls',
    'operations_commerce_order_history_policies',
  ]) {
    state[table] = (await rows(client,
      `SELECT * FROM ${quotedIdentifier(table)} WHERE organization_id = $1::uuid`,
      [workspace.target.organizationId]))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  }
  return state
}

function receiptEventKey(workspace, sourceStateDigest) {
  return `commerce-workspace-migration:${SCRIPT_VERSION}:${workspace.target.organizationId}:${sourceStateDigest}`
}

async function readReceipt(client, eventKey) {
  const result = await client.query(
    `SELECT event_key, payload
     FROM audit_events
     WHERE event_key = $1
       AND event_type = 'operations.commerce_workspace_migration.completed'
     LIMIT 1`, [eventKey])
  return result.rows[0] || null
}

async function countWorkspaceReceipts(client, workspace) {
  const result = await client.query(
    `SELECT count(*)::integer AS count
     FROM audit_events
     WHERE organization_id = $1::uuid
       AND event_type = 'operations.commerce_workspace_migration.completed'`,
    [workspace.target.organizationId],
  )
  return result.rows[0]?.count || 0
}

async function assertPlaceholderPostState(client, workspace, expectedAccounts) {
  const accounts = await rows(client,
    `SELECT id::text, global_id, provider, environment, status,
            external_account_id, credential_reference,
            commerce_credential_generation, receipt_intake_enabled
     FROM operations_integration_accounts
     WHERE organization_id = $1::uuid AND integration_type = 'commerce'
     ORDER BY provider, environment`, [workspace.target.organizationId])
  if (accounts.length !== expectedAccounts) fail(`${workspace.key} target account count changed during apply`)
  for (const account of accounts) {
    if (
      account.status !== 'disabled'
      || account.external_account_id !== null
      || account.credential_reference !== null
      || Number(account.commerce_credential_generation) !== 0
      || account.receipt_intake_enabled !== false
    ) fail(`${workspace.key} target placeholder ${account.global_id} is not fail-closed`)
  }
  const controls = await rows(client,
    `SELECT desired_state, explicit_choice,
            operations_commerce_store_sync_is_running(organization_id, integration_account_id) AS effective_running
     FROM operations_commerce_store_sync_controls
     WHERE organization_id = $1::uuid`, [workspace.target.organizationId])
  if (
    controls.length !== expectedAccounts
    || controls.some((control) => (
      control.desired_state !== 'paused'
      || control.explicit_choice !== true
      || control.effective_running !== false
    ))
  ) fail(`${workspace.key} target Store sync controls are not explicitly paused`)
  const historyPolicies = await client.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_order_history_policies
     WHERE organization_id = $1::uuid`, [workspace.target.organizationId])
  if (historyPolicies.rows[0].count !== 0) {
    fail(`${workspace.key} placeholder unexpectedly acquired an order-history policy before provider verification`)
  }
}

function assertManifestWorkspace(manifestWorkspace, workspace) {
  if (
    manifestWorkspace?.key !== workspace.key
    || manifestWorkspace.source?.organizationId !== workspace.source.organizationId
    || manifestWorkspace.source?.pipelineId !== workspace.source.pipelineId
    || manifestWorkspace.target?.organizationId !== workspace.target.organizationId
    || manifestWorkspace.target?.pipelineId !== workspace.target.pipelineId
  ) fail(`Manifest workspace identity does not match compiled scope for ${workspace.key}`)
}

async function recordMigrationReceipt(client, workspace, plan, stateDigest, counts, mapping, actor) {
  const eventKey = receiptEventKey(workspace, plan.sourceStateDigest)
  const payload = {
    scriptVersion: SCRIPT_VERSION,
    manifestDigest: plan.manifestDigest,
    source: {
      databaseIdentity: SOURCE_DATABASE_IDENTITY,
      organizationReference: workspace.source.organizationReference,
      sourceStateDigest: plan.sourceStateDigest,
    },
    target: {
      databaseIdentity: TARGET_DATABASE_IDENTITY,
      organizationReference: workspace.target.organizationReference,
      targetStateDigest: stateDigest,
    },
    counts,
    mapping,
    providerConnectionsCreated: 0,
    credentialRowsCopied: 0,
  }
  const result = await client.query(
    `INSERT INTO audit_events (
       actor, event_type, aggregate_type, aggregate_id, payload, event_key,
       subject, organization_id, is_system
     ) VALUES (
       $1, 'operations.commerce_workspace_migration.completed',
       'workspace_organization', $2, $3::jsonb, $4, $1, $2::uuid, false
     )
     ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING
     RETURNING event_key`,
    [actor, workspace.target.organizationId, JSON.stringify(payload), eventKey])
  if (result.rowCount !== 1) fail(`${workspace.key} migration receipt was not inserted`)
  return { eventKey, payload }
}

async function applyWorkspace(target, workspace, data, workspacePlan, manifest, actor) {
  await target.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await target.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [`${SCRIPT_VERSION}:${workspace.target.organizationId}`],
    )
    await assertScaffold(target, workspace, actor, 'target')
    const eventKey = receiptEventKey(workspace, workspacePlan.sourceStateDigest)
    const existing = await readReceipt(target, eventKey)
    if (existing) {
      if (existing.payload?.manifestDigest !== manifest.manifestDigest) {
        fail(`${workspace.key} was applied from a different reviewed manifest`)
      }
      if (!existing.payload?.mapping || typeof existing.payload.mapping !== 'object') {
        fail(`${workspace.key} migration receipt is missing its idempotent identity mapping`)
      }
      const currentStateDigest = digest(await loadTargetState(target, workspace))
      if (currentStateDigest !== existing.payload?.target?.targetStateDigest) {
        fail(`${workspace.key} has a migration receipt but its selected target state has drifted`)
      }
      await target.query('COMMIT')
      return {
        key: workspace.key,
        disposition: 'already_applied',
        targetStateDigest: currentStateDigest,
        counts: existing.payload.counts,
        mapping: existing.payload.mapping,
      }
    }
    if (await countWorkspaceReceipts(target, workspace)) {
      fail(`${workspace.key} has a migration receipt from a different source state`)
    }
    const beforeCounts = await targetCounts(target, workspace)
    if (!targetIsEmpty(beforeCounts)) {
      fail(`${workspace.key} target contains selected rows without an exact migration receipt`)
    }
    const { mapping } = await insertWorkspaceData(target, data, workspace, actor)
    await assertPlaceholderPostState(target, workspace, workspace.source.accounts.length)
    const targetState = await loadTargetState(target, workspace)
    const stateDigest = digest(targetState)
    const counts = Object.fromEntries(Object.entries(targetState).map(([table, selected]) => [table, selected.length]))
    await recordMigrationReceipt(
      target,
      workspace,
      { ...workspacePlan, manifestDigest: manifest.manifestDigest },
      stateDigest,
      counts,
      mapping,
      actor,
    )
    await target.query('COMMIT')
    return {
      key: workspace.key,
      disposition: 'applied',
      targetStateDigest: stateDigest,
      counts,
      mapping,
    }
  } catch (error) {
    await target.query('ROLLBACK')
    throw error
  }
}

async function applyManifest(source, target, manifest, options) {
  if (manifest.manifestDigest !== options.confirmDigest) {
    fail('--confirm-digest must exactly match the reviewed manifest digest')
  }
  if (manifest.actor !== options.actor) fail('Manifest actor does not match --actor')
  if (
    manifest.sourceDatabase?.database_identity !== SOURCE_DATABASE_IDENTITY
    || manifest.targetDatabase?.database_identity !== TARGET_DATABASE_IDENTITY
  ) fail('Manifest database identities do not match the compiled DEV to PROD boundary')
  if (!manifest.applyReady) fail('Reviewed manifest is not apply-ready; create a fresh plan after clearing every blocker')
  if (manifest.workspaces?.length !== WORKSPACES.length) fail('Manifest workspace count is invalid')
  for (let index = 0; index < WORKSPACES.length; index += 1) {
    assertManifestWorkspace(manifest.workspaces[index], WORKSPACES[index])
  }
  ensureSafeOutputPath(options.mappingOutput)
  await assertDatabaseIdentities(source, target)
  const capabilities = await targetCapabilities(target)
  if (!capabilitiesReady(capabilities)) {
    fail('Production lacks the required history-cutoff and 0351 storage-retention capabilities')
  }
  const results = []
  for (let index = 0; index < WORKSPACES.length; index += 1) {
    const workspace = WORKSPACES[index]
    const workspacePlan = manifest.workspaces[index]
    await assertScaffold(source, workspace, options.actor, 'source')
    await assertSourceAccounts(source, workspace)
    const blockers = await sourceBlockers(source, workspace)
    if (!blockers.ready) fail(`${workspace.key} source is not quiescent at apply time`)
    const data = await loadWorkspaceData(source, workspace, { includeImageBytes: true })
    validateDatasetClosure(data, workspace)
    for (const image of data.crm_product_image_assets) {
      if (!Buffer.isBuffer(image.content_bytes)) fail(`${workspace.key} image payload is not binary`)
      if (sha256(image.content_bytes) !== image.content_sha256 || image.content_bytes.length !== image.byte_length) {
        fail(`${workspace.key} image ${image.id} failed content integrity validation`)
      }
    }
    const currentDigest = digest(sourceSnapshotProjection(data))
    if (
      currentDigest !== workspacePlan.sourceStateDigest
      || canonicalJson(datasetCounts(data)) !== canonicalJson(workspacePlan.counts)
    ) fail(`${workspace.key} source selection changed after the reviewed plan`)
    results.push(await applyWorkspace(
      target, workspace, data, workspacePlan, manifest, options.actor))
  }
  const artifact = {
    format: 'clawpilot-commerce-workspace-migration-mapping-v1',
    scriptVersion: SCRIPT_VERSION,
    manifestDigest: manifest.manifestDigest,
    appliedAt: new Date().toISOString(),
    sourceDatabaseIdentity: SOURCE_DATABASE_IDENTITY,
    targetDatabaseIdentity: TARGET_DATABASE_IDENTITY,
    results,
  }
  writePrivateJson(options.mappingOutput, artifact)
  return artifact
}

function safeSummary(plan) {
  return {
    command: 'plan',
    outputWritten: true,
    manifestDigest: plan.manifestDigest,
    countFingerprint: plan.countFingerprint,
    applyReady: plan.applyReady,
    targetCapabilitiesReady: plan.targetCapabilitiesReady,
    targetStorageBaseline: plan.targetStorageBaseline,
    workspaces: plan.workspaces.map((workspace) => ({
      key: workspace.key,
      ready: workspace.ready,
      targetEmpty: workspace.targetEmpty,
      counts: workspace.counts,
      blockerCounts: {
        controlsNotPaused: workspace.sourceBlockers.controls.filter((control) => (
          control.desired_state !== 'paused'
          || control.explicit_choice !== true
          || control.effective_running !== false
        )).length,
        activeLeases: workspace.sourceBlockers.activeLeases.reduce((sum, row) => sum + row.count, 0),
        availableContinuations: workspace.sourceBlockers.availableContinuations.reduce((sum, row) => sum + row.count, 0),
        unresolvedExternalEffects: workspace.sourceBlockers.unresolvedExternalEffects.length,
        actionableWebhooks: workspace.sourceBlockers.actionableWebhooks.reduce((sum, row) => sum + row.count, 0),
      },
    })),
  }
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv)
  const sourceUrl = validatedUrl(environment.SOURCE_DATABASE_URL, 'SOURCE_DATABASE_URL')
  const targetUrl = validatedUrl(environment.TARGET_DATABASE_URL, 'TARGET_DATABASE_URL')
  const sourcePool = poolFor(sourceUrl)
  const targetPool = poolFor(targetUrl)
  const source = await sourcePool.connect()
  const target = await targetPool.connect()
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    if (options.command === 'plan') {
      await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        const plan = await buildPlan(source, target, options.actor)
        writePrivateJson(options.output, plan)
        await target.query('COMMIT')
        await source.query('COMMIT')
        console.log(JSON.stringify(safeSummary(plan), null, 2))
        return plan
      } catch (error) {
        await target.query('ROLLBACK')
        throw error
      }
    }
    const manifest = readManifest(options.manifest)
    const result = await applyManifest(source, target, manifest, options)
    await source.query('COMMIT')
    console.log(JSON.stringify({
      command: 'apply',
      manifestDigest: manifest.manifestDigest,
      mappingOutputWritten: true,
      workspaces: result.results.map(({ key, disposition, counts, targetStateDigest }) => ({
        key, disposition, counts, targetStateDigest,
      })),
    }, null, 2))
    return result
  } catch (error) {
    try { await source.query('ROLLBACK') } catch {}
    throw error
  } finally {
    target.release()
    source.release()
    await Promise.allSettled([targetPool.end(), sourcePool.end()])
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Migration failed: ${error.message}`)
    process.exitCode = 1
  })
}
