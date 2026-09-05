#!/usr/bin/env node

/**
 * Selectively migrate the approved CRM/catalog/warehouse configuration from
 * the verified ClawPilot development database into three already-provisioned
 * production workspaces.
 *
 * This is deliberately not a database-clone tool. It never reads source
 * credential, cursor, order, webhook-payload, provider-attempt, or outbox
 * payload tables. It creates disabled, credential-free sales and shipping
 * placeholders and queues canonical target SuiteCRM projections. Provider
 * reconnection remains in guarded target-side workflows.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SCRIPT_VERSION = 'sales-shipping-workspace-production-migration-v3'
export const MANIFEST_FORMAT = 'clawpilot-sales-shipping-workspace-migration-plan-v3'
export const MAPPING_FORMAT = 'clawpilot-sales-shipping-workspace-migration-mapping-v3'
export const SOURCE_DATABASE_IDENTITY = '750aa268-0e31-4065-a99c-4016e4d4fab1'
export const TARGET_DATABASE_IDENTITY = '0474a18c-649c-491b-bea1-7da006d21d81'
export const CONFIRMED_OWNER_EMAIL = 'jarrett@suburbiasandwichco.com'
export const FORBIDDEN_ALIAS_USER = 'jarrett@bposupplychain.com'

const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u
const SUITECRM_NAMESPACE = 'ad5d6a0f-5942-5dc0-aab9-d9cba48a16b1'
const AG_MANAGED_CARRIER_DELEGATION = 'ag-alchemy-episcs-sandbox-rating-delegation'

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
      excludedAccounts: Object.freeze([
        Object.freeze({
          id: 'f28ae7bf-1874-41bf-87a4-311511dfec63',
          globalId: 'gia9iduqbikp5et',
          provider: 'mock-commerce',
          integrationType: 'commerce',
          environment: 'mock',
        }),
      ]),
      accounts: Object.freeze([
        Object.freeze({
          id: '03696a20-aaf4-4049-b0e3-051d9b937749',
          globalId: 'gia5156705',
          provider: 'faire',
          integrationType: 'commerce',
          environment: 'production',
          displayName: 'Pro Bakery Bites by Ag-Alchemy',
          externalAccountIdSha256: '9ebe274c5db9782fd0da927e41329d428e62aa68a6028ebe22e32810d42f88a2',
          reconnectEligible: true,
        }),
        Object.freeze({
          id: 'da56c6d6-fddd-47c0-bf26-66cdfc42ae2c',
          globalId: 'gia9286799',
          provider: 'shopify',
          integrationType: 'commerce',
          environment: 'sandbox',
          displayName: 'AG Alchemy',
          externalAccountIdSha256: '68308a772f11b6110d48de3da8a1360827c1dd616dfb5777992c49544a33d848',
          reconnectEligible: true,
        }),
        Object.freeze({
          id: '010fd720-bfe8-4a4c-9f8d-581eb4b6b456',
          globalId: 'gia3106288',
          provider: 'fedex_rest',
          integrationType: 'carrier',
          environment: 'sandbox',
          displayName: 'FedEx sandbox fulfillment diagnostics via EPISCS',
          reconnectEligible: true,
          carrierAccount: Object.freeze({
            id: '52fdba26-1dea-4649-9b40-1f93aee573f2',
            globalId: 'gac3534106',
            displayName: 'FedEx sandbox fulfillment diagnostics account',
            senderName: 'Ag-Alchemy',
            sourceAccountNumberFingerprint: '1b11796e05536ea569b2a51c2ac31976e2281844ae95f37c05581cfbe5dfb042',
            sourceAddressFingerprint: '36d1e561f153afd9690c5d4ba7644abf18971bf3c6089cca900c5ce3ad57d2cb',
          }),
          sourceAuthority: Object.freeze({
            organizationReference: 'ga5122758',
            integrationGlobalId: 'gia7335302',
            carrierAccountGlobalId: 'gac2368052',
            accountNumberLastFour: '1073',
            registeredAddressLine1: '101 Jegs Place',
          }),
        }),
        Object.freeze({
          id: '72acd52d-a547-43f9-a78d-bb96e33e0525',
          globalId: 'gia5910262',
          provider: 'ups_rest',
          integrationType: 'carrier',
          environment: 'sandbox',
          displayName: 'UPS sandbox fulfillment diagnostics via EPISCS',
          reconnectEligible: true,
          carrierAccount: Object.freeze({
            id: 'b1856b57-6522-46b2-a2f2-d7c622fdb2b0',
            globalId: 'gac9576332',
            displayName: 'UPS sandbox fulfillment diagnostics account',
            senderName: 'Ag-Alchemy',
            sourceAccountNumberFingerprint: '248d58d287b5ab2906e94ccf5662a38c288797831ab3481138a4b66f52995ddd',
            sourceAddressFingerprint: '36d1e561f153afd9690c5d4ba7644abf18971bf3c6089cca900c5ce3ad57d2cb',
          }),
          sourceAuthority: Object.freeze({
            organizationReference: 'ga5122758',
            integrationGlobalId: 'gia2057284',
            carrierAccountGlobalId: 'gac5139730',
            accountNumberLastFour: '3574',
            registeredAddressLine1: '101 Jegs Place',
          }),
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
      excludedAccounts: Object.freeze([]),
      accounts: Object.freeze([
        Object.freeze({
          id: 'c13e4e64-edae-4e73-9ae0-c116c1419688',
          globalId: 'gia585rig3qiq7j',
          provider: 'shopify',
          integrationType: 'commerce',
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
      excludedAccounts: Object.freeze([]),
      accounts: Object.freeze([
        Object.freeze({
          id: '28038134-b624-4b52-8518-e9740785e5c3',
          globalId: 'giah34fedoa5b1o',
          provider: 'shopify',
          integrationType: 'commerce',
          environment: 'sandbox',
          displayName: 'Test Pro Bakery Bites',
          externalAccountIdSha256: 'f47f0e6cc3e525a5d5604d8d499ef93381e843ff1cee9100c4283625b9cd0954',
          reconnectEligible: true,
        }),
        Object.freeze({
          id: 'c8aa9ff7-35f4-44e9-9419-e54b7c977002',
          globalId: 'gia4h85q2nhuig0',
          provider: 'ups_rest',
          integrationType: 'carrier',
          environment: 'production',
          displayName: 'UPS production',
          reconnectEligible: true,
          carrierAccount: Object.freeze({
            id: 'fe5953e0-ee8e-4b5b-8629-46a57d8282f4',
            globalId: 'gacdf85s635a8sq',
            displayName: "Rotella's Bakery",
            senderName: "Warehouse Rotella's Bakery",
            sourceAccountNumberFingerprint: '2c3fb57b1479db90951719c5870ee91b1fd413c17bd7e955a2405a5cd9117a68',
            sourceAddressFingerprint: '0863d99a3b63ef27377c5de5992a6906546659f20eb8a2355429b00592fb1e7c',
          }),
        }),
        Object.freeze({
          id: '8abcaaa5-a2a6-4800-9a4d-941bd3761a8c',
          globalId: 'gia83f2h5i45ud6',
          provider: 'ups_rest',
          integrationType: 'carrier',
          environment: 'sandbox',
          displayName: 'UPS sandbox',
          reconnectEligible: true,
          carrierAccount: Object.freeze({
            id: '05b50351-d29f-4954-b3a1-c08203289279',
            globalId: 'gacljo93c7qtd42',
            displayName: "Rotella's Bakery",
            senderName: "Warehouse Rotella's Bakery",
            sourceAccountNumberFingerprint: '319a420658fcb7d5df25ac0477f1d0ebe14b76abdf619e74c7fc95fc0b30483a',
            sourceAddressFingerprint: '0863d99a3b63ef27377c5de5992a6906546659f20eb8a2355429b00592fb1e7c',
          }),
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
  'operations_carrier_account_migration_placeholders',
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
  operations_carrier_account_migration_placeholders: ['global_id', 'gac'],
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
  operations_carrier_account_migration_placeholders: 'id',
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
  'operations_commerce_workspace_migration_cutover_fences',
  'operations_commerce_migration_provider_identity_fences',
])

export const TARGET_SCOPE_COLUMN = Object.freeze({
  workspace_organization_preferences: 'organization_id',
  operations_shipping_scopes: 'organization_id',
  crm_product_categories: 'pipeline_id',
  operations_integration_accounts: 'organization_id',
  operations_carrier_account_migration_placeholders: 'organization_id',
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
  operations_commerce_workspace_migration_cutover_fences: 'organization_id',
  operations_commerce_migration_provider_identity_fences: 'organization_id',
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
  if (!['plan', 'apply', 'receipt-export'].includes(command)) {
    fail('First argument must be plan, apply, or receipt-export')
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
  const parent = path.dirname(output)
  const temporary = path.join(
    parent,
    `.${path.basename(output)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  const handle = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
    fs.fchmodSync(handle, 0o600)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  try {
    if (fs.existsSync(output)) fail(`Refusing to overwrite existing file: ${output}`)
    fs.renameSync(temporary, output)
    const directoryHandle = fs.openSync(parent, 'r')
    try { fs.fsyncSync(directoryHandle) } finally { fs.closeSync(directoryHandle) }
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch {}
    throw error
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

const SAFE_PLACEHOLDER_CONFIGURATION_KEYS = Object.freeze({
  commerce: Object.freeze([
    'accountName',
    'adapterVersion',
    'apiVersion',
    'authMode',
    'classification',
    'shopDomain',
  ]),
  carrier: Object.freeze([
    'accountOwnerType',
    'authMode',
  ]),
})

export function safePlaceholderConfiguration(source) {
  const integrationType = text(source.integration_type)
  const sourceConfiguration = source.configuration
    && typeof source.configuration === 'object'
    && !Array.isArray(source.configuration)
    ? source.configuration
    : {}
  const allowed = SAFE_PLACEHOLDER_CONFIGURATION_KEYS[integrationType]
  if (!allowed) fail(`Unsupported placeholder integration type: ${integrationType}`)
  const configuration = {}
  for (const key of allowed) {
    const value = sourceConfiguration[key]
    if (value !== undefined && value !== null) configuration[key] = sanitizeJson(value)
  }
  if (integrationType === 'carrier') {
    const requested = Array.isArray(sourceConfiguration.allowedCapabilities)
      ? sourceConfiguration.allowedCapabilities
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
        .sort()
      : []
    configuration.allowedCapabilities = []
    if (requested.length) configuration.rebindRequestedCapabilities = [...new Set(requested)]
  }
  configuration.migrationRequiresCredentialRebind = true
  configuration.migrationRequiresProviderIdentityVerification = true
  return configuration
}

function sourceManagedCarrierPlaceholderConfiguration(
  source,
  expected,
  senderOriginWarehouseGlobalId,
) {
  if (!expected.sourceAuthority) {
    fail(`${expected.globalId} lacks its required production source authority`)
  }
  const sourceConfiguration = source.configuration || {}
  if (
    sourceConfiguration.managedBy !== AG_MANAGED_CARRIER_DELEGATION
    || sourceConfiguration.credentialRevealAllowed !== false
    || !['sandbox_rating_only', 'sandbox_fulfillment_diagnostic']
      .includes(sourceConfiguration.authorizationScope)
  ) {
    fail(`${expected.globalId} source-managed carrier policy changed`)
  }
  const requestedCapabilities = Array.isArray(sourceConfiguration.allowedCapabilities)
    ? sourceConfiguration.allowedCapabilities
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : []
  const expectedCapabilities = sourceConfiguration.authorizationScope === 'sandbox_rating_only'
    ? ['sandbox_rate']
    : ['sandbox_rate', 'sandbox_label']
  if (canonicalJson(requestedCapabilities) !== canonicalJson(expectedCapabilities)) {
    fail(`${expected.globalId} source-managed carrier capabilities changed`)
  }
  return {
    ...safePlaceholderConfiguration(source),
    managedBy: AG_MANAGED_CARRIER_DELEGATION,
    authorizationScope: sourceConfiguration.authorizationScope,
    credentialRevealAllowed: false,
    delegatedFromOrganizationReferenceCode:
      expected.sourceAuthority.organizationReference,
    sourceIntegrationGlobalId: expected.sourceAuthority.integrationGlobalId,
    sourceCarrierAccountGlobalId: expected.sourceAuthority.carrierAccountGlobalId,
    senderOriginWarehouseGlobalId,
    allowedCapabilities: [],
    rebindRequestedCapabilities: [...new Set(requestedCapabilities)].sort(),
    migrationRequiresSourceAuthorityRebind: true,
  }
}

export function buildCredentialFreePlaceholder(source, target, actor) {
  assert.ok(['commerce', 'carrier'].includes(source.integration_type))
  if (source.integration_type === 'commerce') {
    assert.ok(['shopify', 'faire'].includes(source.provider))
  } else {
    assert.ok(['ups_rest', 'fedex_rest'].includes(source.provider))
  }
  assert.ok(['sandbox', 'production'].includes(source.environment))
  return {
    id: target.id,
    global_id: target.globalId,
    organization_id: target.organizationId,
    provider: source.provider,
    integration_type: source.integration_type,
    environment: source.environment,
    external_account_id: null,
    display_name: source.display_name,
    status: 'disabled',
    configuration: target.configuration || safePlaceholderConfiguration(source),
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

export function databaseEndpointFingerprint(connectionString) {
  const parsed = new URL(validatedUrl(connectionString, 'database endpoint'))
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''))
  if (!databaseName) fail('Database endpoint must include a database name')
  return digest({
    protocol: parsed.protocol.toLowerCase(),
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || '5432',
    database: databaseName,
    user: decodeURIComponent(parsed.username || ''),
  })
}

function validatedEndpointBindings(environment, sourceUrl, targetUrl, requireSource = true) {
  const sourceExpected = text(environment.SOURCE_DATABASE_ENDPOINT_SHA256).toLowerCase()
  const targetExpected = text(environment.TARGET_DATABASE_ENDPOINT_SHA256).toLowerCase()
  if (requireSource && !SHA256.test(sourceExpected)) {
    fail('SOURCE_DATABASE_ENDPOINT_SHA256 is required and must be a SHA-256 digest')
  }
  if (!SHA256.test(targetExpected)) {
    fail('TARGET_DATABASE_ENDPOINT_SHA256 is required and must be a SHA-256 digest')
  }
  const sourceObserved = requireSource ? databaseEndpointFingerprint(sourceUrl) : null
  const targetObserved = databaseEndpointFingerprint(targetUrl)
  if (requireSource && sourceObserved !== sourceExpected) {
    fail('SOURCE_DATABASE_URL does not match the independently reviewed source endpoint binding')
  }
  if (targetObserved !== targetExpected) {
    fail('TARGET_DATABASE_URL does not match the independently reviewed target endpoint binding')
  }
  if (requireSource && sourceObserved === targetObserved) {
    fail('Source and target endpoint bindings must be different')
  }
  return { source: sourceObserved, target: targetObserved }
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

async function assertDatabaseIdentities(source, target, endpointBindings) {
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
  return {
    source: { ...sourceIdentity, endpoint_sha256: endpointBindings.source },
    target: { ...targetIdentity, endpoint_sha256: endpointBindings.target },
  }
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
  const boardCount = await client.query(
    `SELECT count(*)::integer AS count
     FROM project_boards
     WHERE workspace_organization_id = $1::uuid`,
    [scope.organizationId],
  )
  if (Number(boardCount.rows[0]?.count) !== boardIds.length) {
    fail(`${workspace.key} ${side} board scaffold contains unexpected boards`)
  }
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

const SAFE_SOURCE_CONFIGURATION_SQL = `jsonb_strip_nulls(jsonb_build_object(
  'accountName', account.configuration->'accountName',
  'adapterVersion', account.configuration->'adapterVersion',
  'apiVersion', account.configuration->'apiVersion',
  'authMode', account.configuration->'authMode',
  'classification', account.configuration->'classification',
  'shopDomain', account.configuration->'shopDomain',
  'accountOwnerType', account.configuration->'accountOwnerType',
  'allowedCapabilities', account.configuration->'allowedCapabilities',
  'managedBy', account.configuration->'managedBy',
  'authorizationScope', account.configuration->'authorizationScope',
  'credentialRevealAllowed', account.configuration->'credentialRevealAllowed',
  'delegatedFromOrganizationReferenceCode',
    account.configuration->'delegatedFromOrganizationReferenceCode',
  'sourceIntegrationGlobalId', account.configuration->'sourceIntegrationGlobalId',
  'sourceCarrierAccountGlobalId',
    account.configuration->'sourceCarrierAccountGlobalId',
  'senderOriginWarehouseGlobalId',
    account.configuration->'senderOriginWarehouseGlobalId'
))`

async function assertSourceAccounts(client, workspace) {
  const selectedAccounts = workspace.source.accounts
  const excludedAccounts = workspace.source.excludedAccounts || []
  const inventory = [...selectedAccounts, ...excludedAccounts]
  const result = await client.query(
    `SELECT id::text, global_id, provider, integration_type, environment,
            display_name, external_account_id IS NOT NULL AS external_account_id_present,
            encode(digest(coalesce(external_account_id, ''), 'sha256'), 'hex')
              AS external_account_id_sha256,
            ${SAFE_SOURCE_CONFIGURATION_SQL} AS configuration
     FROM operations_integration_accounts account
     WHERE organization_id = $1::uuid
       AND integration_type IN ('commerce', 'carrier')
     ORDER BY id`,
    [workspace.source.organizationId],
  )
  if (result.rowCount !== inventory.length) {
    fail(`${workspace.key} source sales/shipping account inventory changed`)
  }
  for (const expected of inventory) {
    const observed = result.rows.find((row) => row.id === expected.id)
    if (
      !observed
      || observed.global_id !== expected.globalId
      || observed.provider !== expected.provider
      || observed.integration_type !== expected.integrationType
      || observed.environment !== expected.environment
    ) {
      fail(`${workspace.key} source account ${expected.globalId} identity changed`)
    }
    if (expected.integrationType === 'commerce' && expected.environment !== 'mock' && (
      observed.external_account_id_present !== true
      || observed.external_account_id_sha256 !== expected.externalAccountIdSha256
      || observed.external_account_id_sha256 === sha256('')
    )) fail(`${workspace.key} source account ${expected.globalId} provider identity changed`)
    if (expected.environment === 'mock' && observed.external_account_id_present) {
      fail(`${workspace.key} excluded mock account ${expected.globalId} acquired a provider identity`)
    }
  }
  const carrierAccounts = selectedAccounts.filter((account) => account.integrationType === 'carrier')
  const carrierRows = carrierAccounts.length
    ? await rows(client,
      `SELECT id::text, global_id, integration_account_id::text,
              display_name, sender_name, account_number_last_four,
              account_number_fingerprint,
              registered_address_fingerprint
       FROM operations_carrier_accounts
       WHERE organization_id = $1::uuid
         AND integration_account_id = ANY($2::uuid[])
       ORDER BY integration_account_id, id`,
      [workspace.source.organizationId, carrierAccounts.map((account) => account.id)])
    : []
  if (carrierRows.length !== carrierAccounts.length) {
    fail(`${workspace.key} source carrier-account mapping set is incomplete`)
  }
  for (const account of carrierAccounts) {
    const expected = account.carrierAccount
    const observed = carrierRows.find((row) => row.integration_account_id === account.id)
    if (
      !expected
      || !observed
      || observed.id !== expected.id
      || observed.global_id !== expected.globalId
      || observed.display_name !== expected.displayName
      || observed.sender_name !== expected.senderName
      || !/^[\x20-\x7e]{4}$/u.test(observed.account_number_last_four || '')
      || observed.account_number_fingerprint !== expected.sourceAccountNumberFingerprint
      || observed.registered_address_fingerprint !== expected.sourceAddressFingerprint
    ) fail(`${workspace.key} source carrier mapping for ${account.globalId} changed`)
    if (account.sourceAuthority) {
      const configuration = result.rows.find((row) => row.id === account.id)?.configuration || {}
      const expectedCapabilities = configuration.authorizationScope === 'sandbox_rating_only'
        ? ['sandbox_rate']
        : ['sandbox_rate', 'sandbox_label']
      if (
        configuration.managedBy !== AG_MANAGED_CARRIER_DELEGATION
        || configuration.credentialRevealAllowed !== false
        || !['sandbox_rating_only', 'sandbox_fulfillment_diagnostic']
          .includes(configuration.authorizationScope)
        || !Array.isArray(configuration.allowedCapabilities)
        || canonicalJson(configuration.allowedCapabilities)
          !== canonicalJson(expectedCapabilities)
        || observed.account_number_last_four
          !== account.sourceAuthority.accountNumberLastFour
      ) fail(`${workspace.key} source-managed carrier delegation ${account.globalId} changed`)
    }
  }
  return result.rows.filter((row) => (
    selectedAccounts.some((account) => account.id === row.id)
  ))
}

function selectedAccountIds(workspace) {
  return workspace.source.accounts.map((account) => account.id)
}

function selectedCommerceAccountIds(workspace) {
  return workspace.source.accounts
    .filter((account) => account.integrationType === 'commerce')
    .map((account) => account.id)
}

function selectedCarrierAccountIds(workspace) {
  return workspace.source.accounts
    .filter((account) => account.integrationType === 'carrier')
    .map((account) => account.id)
}

async function targetSourceAuthorityDependencies(client, workspace, lock = false) {
  const dependencies = []
  for (const account of workspace.source.accounts.filter((candidate) => (
    candidate.integrationType === 'carrier' && candidate.sourceAuthority
  ))) {
    const required = account.sourceAuthority
    const result = await client.query(
      `SELECT authority_org.id::text AS authority_organization_id,
              authority_integration.id::text AS authority_integration_account_id,
              authority_integration.global_id AS authority_integration_global_id,
              authority_integration.provider,
              authority_integration.integration_type,
              authority_integration.environment,
              authority_integration.status AS integration_status,
              authority_account.id::text AS authority_carrier_account_id,
              authority_account.global_id AS authority_carrier_account_global_id,
              authority_account.account_number_last_four,
              authority_account.registered_address_fingerprint,
              authority_account.address_verification,
              authority_account.allow_sender_billing,
              authority_account.status AS carrier_account_status,
              lower(regexp_replace(
                btrim(authority_account.registered_address->>'line1'),
                '\\s+', ' ', 'g'
              )) AS registered_address_line1,
              authority_credential.verification_status AS credential_verification_status
       FROM workspace_organizations authority_org
       JOIN operations_integration_accounts authority_integration
         ON authority_integration.organization_id = authority_org.id
        AND authority_integration.global_id = $2
       JOIN operations_carrier_accounts authority_account
         ON authority_account.organization_id = authority_org.id
        AND authority_account.integration_account_id = authority_integration.id
        AND authority_account.global_id = $3
       JOIN operations_carrier_credentials authority_credential
         ON authority_credential.organization_id = authority_org.id
        AND authority_credential.integration_account_id = authority_integration.id
       WHERE authority_org.reference_code = $1
       LIMIT 2
       ${lock
    ? 'FOR SHARE OF authority_org, authority_integration, authority_account, authority_credential'
    : ''}`,
      [
        required.organizationReference,
        required.integrationGlobalId,
        required.carrierAccountGlobalId,
      ],
    )
    const observed = result.rows[0]
    const expectedLine1 = required.registeredAddressLine1
      .trim().replace(/\s+/gu, ' ').toLowerCase()
    const ready = result.rowCount === 1
      && observed.provider === account.provider
      && observed.integration_type === 'carrier'
      && observed.environment === account.environment
      && observed.integration_status === 'active'
      && observed.carrier_account_status === 'active'
      && observed.credential_verification_status === 'verified'
      && observed.account_number_last_four === required.accountNumberLastFour
      && observed.registered_address_line1 === expectedLine1
      && observed.registered_address_fingerprint
        === account.carrierAccount.sourceAddressFingerprint
      && ['operator_attested', 'provider_verified']
        .includes(observed.address_verification)
      && observed.allow_sender_billing === true
    dependencies.push({
      targetIntegrationSourceGlobalId: account.globalId,
      provider: account.provider,
      environment: account.environment,
      requiredOrganizationReference: required.organizationReference,
      requiredIntegrationGlobalId: required.integrationGlobalId,
      requiredCarrierAccountGlobalId: required.carrierAccountGlobalId,
      requiredAccountNumberLastFour: required.accountNumberLastFour,
      requiredRegisteredAddressFingerprint:
        account.carrierAccount.sourceAddressFingerprint,
      authorityOrganizationId: observed?.authority_organization_id || null,
      authorityIntegrationAccountId: observed?.authority_integration_account_id || null,
      authorityCarrierAccountId: observed?.authority_carrier_account_id || null,
      ready,
      blocker: ready
        ? null
        : 'required production source carrier authority is absent, inactive, unverified, or identity-mismatched',
    })
  }
  return dependencies.sort((left, right) => (
    left.targetIntegrationSourceGlobalId.localeCompare(right.targetIntegrationSourceGlobalId)
  ))
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
  const commerceAccounts = selectedCommerceAccountIds(workspace)
  const carrierAccounts = selectedCarrierAccountIds(workspace)
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
            ${SAFE_SOURCE_CONFIGURATION_SQL} AS configuration,
            created_by, updated_by, created_at, updated_at
     FROM operations_integration_accounts account
     WHERE organization_id = $1::uuid AND id = ANY($2::uuid[])
     ORDER BY id`, [org, accounts])
  data.operations_carrier_account_migration_placeholders = carrierAccounts.length
    ? await rows(client,
      `SELECT carrier_account.id, carrier_account.global_id,
              carrier_account.organization_id,
              carrier_account.integration_account_id,
              integration.provider, integration.environment,
              carrier_account.display_name, carrier_account.sender_name,
              carrier_account.account_number_last_four
                AS source_account_number_last_four,
              carrier_account.account_number_fingerprint
                AS source_account_number_fingerprint,
              carrier_account.registered_address_fingerprint
                AS source_registered_address_fingerprint,
              carrier_account.id AS source_carrier_account_id,
              carrier_account.global_id AS source_carrier_account_global_id
       FROM operations_carrier_accounts carrier_account
       JOIN operations_integration_accounts integration
         ON integration.organization_id = carrier_account.organization_id
        AND integration.id = carrier_account.integration_account_id
       WHERE carrier_account.organization_id = $1::uuid
         AND carrier_account.integration_account_id = ANY($2::uuid[])
       ORDER BY carrier_account.integration_account_id, carrier_account.id`,
      [org, carrierAccounts])
    : []
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
     ORDER BY id`, [org, pipeline, commerceAccounts, selectedProductIds])
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
     ORDER BY id`, [org, pipeline, commerceAccounts, selectedProductIds, selectedMappingIds])
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
     ORDER BY id`, [org, pipeline, commerceAccounts, selectedProductIds, versionIds])
  data.operations_external_identifiers = await rows(client,
    `SELECT * FROM operations_external_identifiers
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($3::uuid[])
       AND entity_type = 'crm.organization'
       AND entity_global_id = ANY($2::text[])
     ORDER BY integration_account_id, entity_type, external_id`,
    [org, selectedOrganizationReferences, commerceAccounts])
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
  const commerceAccounts = selectedCommerceAccountIds(workspace)
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
     ORDER BY account.id`, [org, commerceAccounts])
  const activeLeases = await rows(client,
    `SELECT integration_account_id::text, count(*)::integer AS count
     FROM operations_commerce_store_sync_read_leases
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
       AND released_at IS NULL AND expires_at > clock_timestamp()
     GROUP BY integration_account_id ORDER BY integration_account_id`, [org, commerceAccounts])
  const continuations = await rows(client,
    `SELECT integration_account_id::text, count(*)::integer AS count
     FROM operations_commerce_intake_continuations
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
       AND cursor_state = 'available' AND expires_at > clock_timestamp()
     GROUP BY integration_account_id ORDER BY integration_account_id`, [org, commerceAccounts])
  const externalEffects = await rows(client,
    `SELECT integration_account_id::text, global_id, action, state, error_code
     FROM operations_commerce_external_effect_intents
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
       AND state IN ('pending', 'claimed', 'unknown')
     ORDER BY integration_account_id, global_id`, [org, commerceAccounts])
  const webhooks = await rows(client,
    `SELECT integration_account_id::text, state, count(*)::integer AS count
     FROM operations_commerce_webhook_receipts
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
       AND state IN ('held', 'queued', 'processing', 'failed', 'dead_letter')
     GROUP BY integration_account_id, state
     ORDER BY integration_account_id, state`, [org, commerceAccounts])
  const cutoverFences = await rows(client,
    `SELECT integration_account_id::text, migration_name, state, frozen_at
     FROM operations_commerce_workspace_migration_cutover_fences
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
     ORDER BY integration_account_id`, [org, accounts])
  const dirtyReconciliationDefinitions = [
    'operations_shopify_order_webhook_targets',
    'operations_shopify_catalog_refresh_states',
    'operations_shopify_inventory_refresh_watermarks',
  ]
  const dirtyReconciliation = []
  for (const table of dirtyReconciliationDefinitions) {
    if (!await tableExists(client, table)) {
      dirtyReconciliation.push({ table, missing: true, rows: [] })
      continue
    }
    const selected = await rows(client,
      `SELECT integration_account_id::text, count(*)::integer AS count
       FROM ${quotedIdentifier(table)}
       WHERE organization_id = $1::uuid
         AND integration_account_id = ANY($2::uuid[])
         AND dirty_version > reconciled_version
       GROUP BY integration_account_id
       ORDER BY integration_account_id`, [org, commerceAccounts])
    dirtyReconciliation.push({ table, missing: false, rows: selected })
  }
  const heldWorkDefinitions = [
    ['operations_commerce_intake_read_intents', 'intent_state', [
      'prepared', 'reading', 'captured', 'uncertain',
    ]],
    ['operations_commerce_intake_runs', 'workflow_state', [
      'held', 'resolving', 'ready', 'failed',
    ]],
    ['operations_commerce_provider_attempts', 'state', [
      'prepared', 'failed', 'unknown', 'dead_letter',
    ]],
    ['operations_commerce_catalog_sync_jobs', 'status', ['pending', 'processing', 'failed', 'dead']],
    ['operations_shopify_inventory_refresh_jobs', 'status', [
      'pending', 'processing', 'failed', 'dead',
      'mapped_pending', 'mapped_processing', 'mapped_failed', 'mapped_dead',
    ]],
    ['operations_commerce_product_image_import_jobs', 'state', ['waiting_mapping', 'queued', 'claimed', 'retry', 'dead']],
    ['operations_faire_inventory_poll_jobs', 'status', ['pending', 'processing', 'failed', 'dead']],
  ]
  const heldWork = []
  for (const [table, stateColumn, states] of heldWorkDefinitions) {
    if (!await tableExists(client, table)) {
      heldWork.push({ table, missing: true, rows: [] })
      continue
    }
    const selected = await rows(client,
      `SELECT integration_account_id::text, ${quotedIdentifier(stateColumn)} AS state,
              count(*)::integer AS count
       FROM ${quotedIdentifier(table)}
       WHERE organization_id = $1::uuid
         AND integration_account_id = ANY($2::uuid[])
         AND ${quotedIdentifier(stateColumn)} = ANY($3::text[])
       GROUP BY integration_account_id, ${quotedIdentifier(stateColumn)}
       ORDER BY integration_account_id, ${quotedIdentifier(stateColumn)}`,
      [org, commerceAccounts, states])
    heldWork.push({ table, missing: false, rows: selected })
  }
  const revisionWork = await rows(client,
    `SELECT integration_account_id::text, claim_state AS state,
            count(*)::integer AS count
     FROM operations_commerce_order_revision_targets
     WHERE organization_id = $1::uuid
       AND integration_account_id = ANY($2::uuid[])
       AND (
         material_state <> 'current'
         OR claim_state IN ('pending', 'processing', 'failed', 'dead_letter')
       )
     GROUP BY integration_account_id, claim_state
     ORDER BY integration_account_id, claim_state`, [org, commerceAccounts])
  const paused = controls.length === commerceAccounts.length && controls.every((control) => (
    control.desired_state === 'paused'
    && control.explicit_choice === true
    && control.effective_running === false
  ))
  const fenced = cutoverFences.length === accounts.length
    && cutoverFences.every((fence) => (
      fence.migration_name === SCRIPT_VERSION && fence.state === 'frozen'
    ))
  return {
    controls,
    activeLeases,
    availableContinuations: continuations,
    unresolvedExternalEffects: externalEffects,
    actionableWebhooks: webhooks,
    cutoverFences,
    dirtyReconciliation,
    heldWork,
    revisionWork,
    ready: paused
      && fenced
      && activeLeases.length === 0
      && continuations.length === 0
      && externalEffects.length === 0
      && webhooks.length === 0
      && dirtyReconciliation.every((item) => !item.missing && item.rows.length === 0)
      && heldWork.every((item) => !item.missing && item.rows.length === 0)
      && revisionWork.length === 0,
  }
}

const SOURCE_CUTOVER_LOCK_TABLES = Object.freeze([
  ...DATASET_ORDER.filter((table) => table !== 'operations_carrier_account_migration_placeholders'),
  'operations_carrier_accounts',
  'operations_commerce_store_sync_controls',
  'operations_commerce_workspace_migration_cutover_fences',
  'operations_commerce_store_sync_read_leases',
  'operations_commerce_intake_continuations',
  'operations_commerce_external_effect_intents',
  'operations_commerce_webhook_receipts',
  'operations_shopify_order_webhook_targets',
  'operations_shopify_catalog_refresh_states',
  'operations_shopify_inventory_refresh_watermarks',
  'operations_commerce_intake_read_intents',
  'operations_commerce_intake_runs',
  'operations_commerce_provider_attempts',
  'operations_commerce_catalog_sync_jobs',
  'operations_shopify_inventory_refresh_jobs',
  'operations_commerce_product_image_import_jobs',
  'operations_faire_inventory_poll_jobs',
  'operations_commerce_order_revision_targets',
])

async function acquireSourceCutoverLocks(client) {
  const missing = []
  for (const table of [...new Set(SOURCE_CUTOVER_LOCK_TABLES)]) {
    if (!await tableExists(client, table)) missing.push(table)
  }
  if (missing.length) {
    fail(`Source is missing cutover-lock tables: ${missing.join(', ')}`)
  }
  await client.query(
    `LOCK TABLE ${[...new Set(SOURCE_CUTOVER_LOCK_TABLES)]
      .map(quotedIdentifier).join(', ')} IN SHARE MODE NOWAIT`,
  )
}

const TARGET_GLOBAL_SAFE_TABLES = new Set([
  'workspace_organizations',
  'app_users',
  'pipeline_spaces',
  'project_boards',
  'app_user_organization_memberships',
  'pipeline_space_members',
  'project_board_members',
  'app_user_workspace_preferences',
  'operations_activation_scopes',
  'workspace_organization_preferences',
  'operations_shipping_scopes',
  'audit_events',
  'crm_integration_cursors',
  'crm_reference_aliases',
  'crm_reference_number_registry',
  'crm_reference_registry',
  'crm_suitecrm_product_image_ingestion_worker_heartbeat',
  'operations_commerce_product_image_import_worker_heartbeat',
])

const TARGET_SCOPE_ANCHORS = Object.freeze({
  workspace_organizations: Object.freeze({ columns: Object.freeze(['id']) }),
  pipeline_spaces: Object.freeze({
    columns: Object.freeze(['workspace_organization_id']),
  }),
  project_boards: Object.freeze({
    columns: Object.freeze(['workspace_organization_id']),
  }),
})

const TARGET_SCAFFOLD_BASELINE = Object.freeze([
  Object.freeze({ table: 'workspace_organizations', column: 'id', scope: 'organization' }),
  Object.freeze({ table: 'app_users', column: 'email', scope: 'actor' }),
  Object.freeze({ table: 'pipeline_spaces', column: 'workspace_organization_id', scope: 'organization' }),
  Object.freeze({ table: 'project_boards', column: 'workspace_organization_id', scope: 'organization' }),
  Object.freeze({ table: 'app_user_organization_memberships', column: 'organization_id', scope: 'organization' }),
  Object.freeze({ table: 'pipeline_space_members', column: 'pipeline_id', scope: 'pipeline' }),
  Object.freeze({ table: 'project_board_members', column: 'board_id', scope: 'boards' }),
  Object.freeze({ table: 'app_user_workspace_preferences', column: 'workspace_organization_id', scope: 'organization' }),
  Object.freeze({ table: 'operations_activation_scopes', column: 'organization_id', scope: 'organization' }),
  Object.freeze({ table: 'workspace_organization_preferences', column: 'organization_id', scope: 'organization' }),
  Object.freeze({ table: 'operations_shipping_scopes', column: 'organization_id', scope: 'organization' }),
  Object.freeze({ table: 'audit_events', column: 'organization_id', scope: 'organization' }),
])

function isTargetMigrationDomainTable(table) {
  return table.startsWith('crm_')
    || table.startsWith('operations_')
    || table.startsWith('project_board_')
    || table === 'project_boards'
    || table === 'pipeline_spaces'
    || table === 'workspace_organizations'
    || table === 'workspace_organization_preferences'
    || table === 'sync_outbox'
}

function appendTargetScopePredicate(table, alias, columns, workspace, params) {
  const names = new Set(columns)
  const add = (value) => {
    params.push(value)
    return `$${params.length}`
  }
  if (table === 'workspace_organizations') {
    return `${alias}.id = ${add(workspace.target.organizationId)}::uuid`
  }
  if (table === 'sync_outbox') {
    const pipeline = add(workspace.target.pipelineId)
    const organization = add(workspace.target.organizationId)
    const boards = add(Object.values(workspace.target.boardMap))
    return `(
      ${alias}.payload->>'pipelineId' = ${pipeline}
      OR ${alias}.payload->>'organizationId' = ${organization}
      OR ${alias}.payload->>'workspaceOrganizationId' = ${organization}
      OR ${alias}.payload->>'organizationRootId' = ${organization}
      OR ${alias}.payload->>'boardId' = ANY(${boards}::text[])
      OR ${alias}.aggregate_id = ${pipeline}
      OR ${alias}.aggregate_id = ${organization}
      OR ${alias}.aggregate_id = ANY(${boards}::text[])
    )`
  }
  const predicates = []
  if (names.has('pipeline_id')) {
    predicates.push(`${alias}.pipeline_id = ${add(workspace.target.pipelineId)}::uuid`)
  }
  // crm_*.organization_id points at a CRM account rather than the workspace.
  // Operations rows use organization_id as the workspace boundary even when
  // they also carry a nullable or stale pipeline_id, so both predicates must
  // participate in the exact empty-target scan.
  if (names.has('organization_id') && !table.startsWith('crm_')) {
    predicates.push(`${alias}.organization_id = ${add(workspace.target.organizationId)}::uuid`)
  }
  if (names.has('workspace_organization_id')) {
    predicates.push(
      `${alias}.workspace_organization_id = ${add(workspace.target.organizationId)}::uuid`,
    )
  }
  if (names.has('organization_root_id')) {
    predicates.push(`${alias}.organization_root_id = ${add(workspace.target.organizationId)}::uuid`)
  }
  if (names.has('board_id')) {
    predicates.push(
      `${alias}.board_id = ANY(${add(Object.values(workspace.target.boardMap))}::uuid[])`,
    )
  }
  if (!predicates.length) fail(`Cannot derive target empty scope for ${table}`)
  return predicates.length === 1 ? predicates[0] : `(${predicates.join(' OR ')})`
}

async function targetForeignKeys(client) {
  return rows(client,
    `SELECT child.relname AS child_table,
            parent.relname AS parent_table,
            array_agg(child_attribute.attname::text ORDER BY child_key.ordinality)::text[] AS child_columns,
            array_agg(parent_attribute.attname::text ORDER BY child_key.ordinality)::text[] AS parent_columns
     FROM pg_constraint constraint_row
     JOIN pg_class child ON child.oid = constraint_row.conrelid
     JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
     JOIN pg_class parent ON parent.oid = constraint_row.confrelid
     JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
     JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY
       AS child_key(attribute_number, ordinality) ON true
     JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY
       AS parent_key(attribute_number, ordinality)
       ON parent_key.ordinality = child_key.ordinality
     JOIN pg_attribute child_attribute
       ON child_attribute.attrelid = child.oid
      AND child_attribute.attnum = child_key.attribute_number
     JOIN pg_attribute parent_attribute
       ON parent_attribute.attrelid = parent.oid
      AND parent_attribute.attnum = parent_key.attribute_number
     WHERE constraint_row.contype = 'f'
       AND child_namespace.nspname = 'public'
       AND parent_namespace.nspname = 'public'
       AND child.relkind IN ('r', 'p')
       AND parent.relkind IN ('r', 'p')
     GROUP BY constraint_row.oid, child.relname, parent.relname
     ORDER BY child.relname, parent.relname, constraint_row.oid`)
}

function targetScopePaths(rootTable, directTables, edgesByChild) {
  const queue = [{ table: rootTable, path: [] }]
  const visited = new Set([rootTable])
  while (queue.length) {
    const candidate = queue.shift()
    if (candidate.path.length && directTables.has(candidate.table)) {
      return [candidate.path]
    }
    for (const edge of edgesByChild.get(candidate.table) || []) {
      if (visited.has(edge.parent_table)) continue
      visited.add(edge.parent_table)
      queue.push({
        table: edge.parent_table,
        path: [...candidate.path, edge],
      })
    }
  }
  return []
}

function scopePathDescriptor(pathRows) {
  return pathRows.map((edge) => ({
    childTable: edge.child_table,
    childColumns: edge.child_columns,
    parentTable: edge.parent_table,
    parentColumns: edge.parent_columns,
  }))
}

export async function targetScopeAudit(client, workspace) {
  const ownsSession = typeof client.release !== 'function'
  const session = ownsSession ? await client.connect() : client
  if (ownsSession) await session.query('BEGIN')
  try {
  const scopedTables = await rows(session,
    `SELECT table_info.table_name,
            array_agg(table_info.column_name::text ORDER BY table_info.column_name)::text[] AS columns
     FROM information_schema.columns table_info
     JOIN information_schema.tables table_catalog
       ON table_catalog.table_schema = table_info.table_schema
      AND table_catalog.table_name = table_info.table_name
      AND table_catalog.table_type = 'BASE TABLE'
     WHERE table_info.table_schema = 'public'
       AND table_info.column_name = ANY($1::text[])
     GROUP BY table_info.table_name
     ORDER BY table_info.table_name`, [[
      'organization_id',
      'workspace_organization_id',
      'organization_root_id',
      'pipeline_id',
      'board_id',
    ]])
  const output = {}
  const directByTable = new Map(scopedTables
    .filter((selected) => {
      if (
        !isTargetMigrationDomainTable(selected.table_name)
        || TARGET_GLOBAL_SAFE_TABLES.has(selected.table_name)
      ) return false
      const columns = new Set(selected.columns)
      return columns.has('pipeline_id')
        || columns.has('workspace_organization_id')
        || columns.has('organization_root_id')
        || columns.has('board_id')
        || (columns.has('organization_id') && !selected.table_name.startsWith('crm_'))
    })
    .map((selected) => [
      selected.table_name,
      { columns: selected.columns },
    ]))
  for (const [table, spec] of Object.entries(TARGET_SCOPE_ANCHORS)) {
    if (await tableExists(session, table)) directByTable.set(table, spec)
  }
  if (await tableExists(session, 'sync_outbox')) {
    directByTable.set('sync_outbox', { columns: [] })
  }
  const baseTables = (await rows(session,
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`)).map((row) => row.table_name)
  const foreignKeys = await targetForeignKeys(session)
  const edgesByChild = new Map()
  for (const edge of foreignKeys) {
    const existing = edgesByChild.get(edge.child_table) || []
    existing.push(edge)
    edgesByChild.set(edge.child_table, existing)
  }
  const directTables = new Set(directByTable.keys())
  const scopeReachableTables = new Set(directTables)
  let reachabilityChanged = true
  while (reachabilityChanged) {
    reachabilityChanged = false
    for (const edge of foreignKeys) {
      if (
        scopeReachableTables.has(edge.parent_table)
        && isTargetMigrationDomainTable(edge.child_table)
        && !TARGET_GLOBAL_SAFE_TABLES.has(edge.child_table)
        && !scopeReachableTables.has(edge.child_table)
      ) {
        scopeReachableTables.add(edge.child_table)
        reachabilityChanged = true
      }
    }
  }

  const temporaryScopeTable = `migration_target_scope_${crypto.randomBytes(8).toString('hex')}`
  await session.query(
    `CREATE TEMP TABLE ${quotedIdentifier(temporaryScopeTable)} (
       table_name text NOT NULL,
       row_tid tid NOT NULL,
       PRIMARY KEY (table_name, row_tid)
     ) ON COMMIT DROP`,
  )
  for (const [table, direct] of directByTable) {
    if (!scopeReachableTables.has(table)) continue
    const params = []
    const predicate = appendTargetScopePredicate(
      table,
      'direct_row',
      direct.columns,
      workspace,
      params,
    )
    await session.query(
      `INSERT INTO ${quotedIdentifier(temporaryScopeTable)} (table_name, row_tid)
       SELECT $${params.length + 1}, direct_row.ctid
       FROM ${quotedIdentifier(table)} direct_row
       WHERE ${predicate}
       ON CONFLICT DO NOTHING`,
      [...params, table],
    )
  }

  const propagationEdges = foreignKeys.filter((edge) => (
    scopeReachableTables.has(edge.child_table)
    && scopeReachableTables.has(edge.parent_table)
  ))
  let propagated
  do {
    propagated = 0
    for (let offset = 0; offset < propagationEdges.length; offset += 40) {
      const group = propagationEdges.slice(offset, offset + 40)
      const selects = group.map((edge, index) => {
        const childAlias = `child_${index}`
        const parentAlias = `parent_${index}`
        const scopedAlias = `scope_${index}`
        const link = edge.child_columns.map((column, columnIndex) => (
          `${childAlias}.${quotedIdentifier(column)}`
          + ` = ${parentAlias}.${quotedIdentifier(edge.parent_columns[columnIndex])}`
        )).join(' AND ')
        return `SELECT ${quotedLiteral(edge.child_table)}::text AS table_name,
                       ${childAlias}.ctid AS row_tid
                FROM ${quotedIdentifier(edge.child_table)} ${childAlias}
                JOIN ${quotedIdentifier(edge.parent_table)} ${parentAlias}
                  ON ${link}
                JOIN ${quotedIdentifier(temporaryScopeTable)} ${scopedAlias}
                  ON ${scopedAlias}.table_name = ${quotedLiteral(edge.parent_table)}
                 AND ${scopedAlias}.row_tid = ${parentAlias}.ctid`
      })
      if (!selects.length) continue
      const inserted = await session.query(
        `INSERT INTO ${quotedIdentifier(temporaryScopeTable)} (table_name, row_tid)
         ${selects.join('\nUNION ALL\n')}
         ON CONFLICT DO NOTHING`,
      )
      propagated += inserted.rowCount || 0
    }
  } while (propagated > 0)

  const scopedCounts = new Map((await rows(session,
    `SELECT table_name, count(*)::bigint AS count
     FROM ${quotedIdentifier(temporaryScopeTable)}
     GROUP BY table_name`,
  )).map((row) => [row.table_name, Number(row.count)]))
  const classifications = []
  const denied = []
  for (const table of baseTables) {
    if (!isTargetMigrationDomainTable(table)) continue
    if (TARGET_GLOBAL_SAFE_TABLES.has(table)) {
      classifications.push({
        table,
        classification: 'global-safe',
        strategy: 'compiled-allowlist',
      })
      continue
    }
    let classification
    if (directTables.has(table)) {
      const direct = directByTable.get(table)
      classification = {
        table,
        classification: 'scoped',
        strategy: table === 'sync_outbox' ? 'explicit-json' : 'direct',
        scopeColumns: table === 'sync_outbox' ? ['payload', 'aggregate_id'] : direct.columns,
      }
    } else {
      const paths = targetScopePaths(table, directTables, edgesByChild)
      if (!paths.length) {
        const deniedClassification = {
          table,
          classification: 'denied',
          strategy: 'unclassifiable',
          reason: 'no compiled global-safe rule, direct scope, explicit JSON rule, or foreign-key scope path',
        }
        classifications.push(deniedClassification)
        denied.push(table)
        continue
      }
      classification = {
        table,
        classification: 'scoped',
        strategy: 'indirect',
        paths: paths.map(scopePathDescriptor),
      }
    }
    output[table] = scopedCounts.get(table) || 0
    classifications.push(classification)
  }
  const counts = Object.fromEntries(
    Object.entries(output).sort(([left], [right]) => left.localeCompare(right)),
  )
  classifications.sort((left, right) => left.table.localeCompare(right.table))
  const result = {
    counts,
    classifications,
    classificationDigest: digest(classifications),
    denied: denied.sort(),
  }
  if (ownsSession) await session.query('COMMIT')
  return result
  } catch (error) {
    if (ownsSession) await session.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    if (ownsSession) session.release()
  }
}

export async function targetCounts(client, workspace) {
  const audit = await targetScopeAudit(client, workspace)
  if (audit.denied.length) {
    fail(`Target scope classification denied candidate tables: ${audit.denied.join(', ')}`)
  }
  return audit.counts
}

function targetIsEmpty(counts, denied = []) {
  return denied.length === 0 && Object.values(counts).every((count) => count === 0)
}

async function targetConfigurationBaseline(client, workspace, actor, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : ''
  const projection = {}
  for (const spec of TARGET_SCAFFOLD_BASELINE) {
    let value
    let cast
    if (spec.scope === 'actor') {
      value = actor
      cast = 'text'
    } else if (spec.scope === 'pipeline') {
      value = workspace.target.pipelineId
      cast = 'uuid'
    } else if (spec.scope === 'boards') {
      value = Object.values(workspace.target.boardMap)
      cast = 'uuid[]'
    } else {
      value = workspace.target.organizationId
      cast = 'uuid'
    }
    const comparison = spec.scope === 'boards'
      ? `${quotedIdentifier(spec.column)} = ANY($1::${cast})`
      : `${quotedIdentifier(spec.column)} = $1::${cast}`
    projection[spec.table] = (await rows(client,
      `SELECT * FROM ${quotedIdentifier(spec.table)}
       WHERE ${comparison}${suffix}`,
      [value]))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  }
  return {
    rowCounts: Object.fromEntries(Object.entries(projection).map(([table, selected]) => (
      [table, selected.length]
    ))),
    digest: digest(projection),
  }
}

function safeAccountPlan(account, observed, carrierRow = null, sourceAuthority = null) {
  const plan = {
    sourceId: account.id,
    sourceGlobalId: account.globalId,
    provider: account.provider,
    integrationType: account.integrationType,
    environment: account.environment,
    displayName: observed.display_name,
    safeConfiguration: safePlaceholderConfiguration({
      integration_type: account.integrationType,
      configuration: observed.configuration,
    }),
    reconnectEligible: account.reconnectEligible,
    productionDisposition: account.environment === 'sandbox'
      ? 'disabled_sandbox_placeholder_rebind_and_verify_before_activation'
      : 'disabled_production_placeholder_rebind_and_verify_before_activation',
  }
  if (account.integrationType === 'commerce') {
    plan.externalAccountIdSha256 = account.externalAccountIdSha256
  } else {
    plan.carrierAccount = {
      sourceId: account.carrierAccount.id,
      sourceGlobalId: account.carrierAccount.globalId,
      displayName: account.carrierAccount.displayName,
      senderName: account.carrierAccount.senderName,
      sourceAccountNumberFingerprint: account.carrierAccount.sourceAccountNumberFingerprint,
      sourceAddressFingerprint: account.carrierAccount.sourceAddressFingerprint,
      sourceAccountNumberLastFour: carrierRow?.source_account_number_last_four || null,
      rebindMode: account.sourceAuthority ? 'source_authority' : 'direct_credential',
      productionDisposition: account.sourceAuthority
        ? 'identity_only_placeholder_blocked_until_verified_production_source_authority_rebind'
        : 'identity_only_placeholder_materialized_after_target_credential_and_shipper_rebind',
    }
    if (account.sourceAuthority) plan.sourceAuthority = sourceAuthority
  }
  return plan
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

async function buildPlan(source, target, actor, endpointBindings, workspaces = WORKSPACES) {
  const identities = await assertDatabaseIdentities(source, target, endpointBindings)
  const capabilities = await targetCapabilities(target)
  const storage = await targetStorageBaseline(target, capabilities)
  const workspacePlans = []
  for (const workspace of workspaces) {
    const [sourceScaffold, targetScaffold, accountRows] = await Promise.all([
      assertScaffold(source, workspace, actor, 'source'),
      assertScaffold(target, workspace, actor, 'target'),
      assertSourceAccounts(source, workspace),
    ])
    const data = await loadWorkspaceData(source, workspace, { includeImageBytes: false })
    validateDatasetClosure(data, workspace)
    const blockers = await sourceBlockers(source, workspace)
    const sourceAuthorityDependencies = await targetSourceAuthorityDependencies(
      target,
      workspace,
    )
    const targetScope = await targetScopeAudit(target, workspace)
    const emptyCounts = targetScope.counts
    const configurationBaseline = await targetConfigurationBaseline(target, workspace, actor)
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
        data.operations_carrier_account_migration_placeholders
          .find((row) => row.integration_account_id === account.id),
        sourceAuthorityDependencies.find((dependency) => (
          dependency.targetIntegrationSourceGlobalId === account.globalId
        )),
      )),
      counts: datasetCounts(data),
      sourceStateDigest: digest(projected),
      sourceBlockers: blockers,
      sourceAuthorityDependencies,
      sourceAuthorityDependencyDigest: digest(sourceAuthorityDependencies),
      targetCounts: emptyCounts,
      targetScopeClassifications: targetScope.classifications,
      targetScopeClassificationDigest: targetScope.classificationDigest,
      targetScopeDenied: targetScope.denied,
      targetConfigurationBaseline: configurationBaseline,
      targetEmpty: targetIsEmpty(emptyCounts, targetScope.denied),
      ready: blockers.ready
        && sourceAuthorityDependencies.every((dependency) => dependency.ready)
        && targetIsEmpty(emptyCounts, targetScope.denied),
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
      sourceSuiteCrmIdsAndOutbox: true,
      targetSuiteCrmProjectionQueued: true,
      providerReconnectsAndWrites: true,
      carrierCredentialAndEncryptedAccountMaterial: true,
      carrierIdentityMappingsRetainedAsDisabledPlaceholders: true,
      printerAccounts: true,
      providerOperationalState: true,
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
    targetScopeClassificationDigest: workspace.targetScopeClassificationDigest,
    targetScopeDenied: workspace.targetScopeDenied,
    sourceAuthorityDependencyDigest: workspace.sourceAuthorityDependencyDigest,
    targetConfigurationBaseline: workspace.targetConfigurationBaseline,
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

function quotedLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
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
    `SELECT app_user.email, app_user.reference_code, app_user.display_name,
            app_user.suitecrm_user_id
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

function stableSuiteCrmId(pipelineId, entity, sourceKey) {
  const namespace = Buffer.from(SUITECRM_NAMESPACE.replaceAll('-', ''), 'hex')
  const hash = crypto.createHash('sha1')
    .update(namespace)
    .update(`${pipelineId}:${entity}:${sourceKey}`)
    .digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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
  for (const [table, entity] of [
    ['crm_organizations', 'organizations'],
    ['crm_contacts', 'contacts'],
    ['crm_products', 'products'],
  ]) {
    for (const sourceRow of data[table] || []) {
      const targetIdentity = byTable.get(table)?.get(sourceRow.id)
      const sourceKey = sanitizeJson(
        sourceRow.identity_key || sourceRow.source_key,
        replacements,
      )
      if (!targetIdentity || !sourceKey) fail(`${table} lacks a canonical SuiteCRM identity`)
      const globallyStable = (
        table === 'crm_organizations' && sourceRow.workspace_organization_id
      ) || (
        table === 'crm_contacts' && sourceRow.app_user_email
      )
      targetIdentity.suiteCrmId = stableSuiteCrmId(
        globallyStable ? 'global' : workspace.target.pipelineId,
        entity,
        sourceKey,
      )
    }
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
  operations_carrier_account_migration_placeholders: Object.freeze({
    integration_account_id: ['operations_integration_accounts', false],
  }),
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

function cleanCrmValue(value) {
  return String(value ?? '').trim()
}

function crmNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function crmProjectionForRow(table, row, sourceRow, identityMaps, workspace, owner) {
  const identity = identityMaps.byTable.get(table)?.get(sourceRow.id)
  if (!identity?.suiteCrmId) fail(`${table} lacks a preallocated SuiteCRM identity`)
  const sourcePayload = row.source_payload || {}
  let entity
  let fields
  let attributes
  let currencyCode
  if (table === 'crm_organizations') {
    entity = 'organizations'
    const parentSuiteCrmId = sourceRow.parent_organization_id
      ? identityMaps.byTable.get('crm_organizations')?.get(sourceRow.parent_organization_id)?.suiteCrmId
      : null
    fields = {
      parentOrganizationId: row.parent_organization_id,
      parentOrganizationSuiteCrmId: parentSuiteCrmId,
      workspaceOrganizationId: row.workspace_organization_id,
      workspaceOrganizationReferenceCode: row.workspace_organization_id
        ? workspace.target.organizationReference
        : null,
      relationshipType: row.relationship_type,
      priority: row.priority,
      name: row.name,
      accountType: row.account_type,
      accountManager: row.account_manager,
      website: row.website,
      linkedinUrl: row.linkedin_url,
      phone: row.phone,
      email: row.email,
      emailOptOut: row.email_opt_out === true,
      address: row.billing_address_street,
      city: row.billing_address_city,
      state: row.billing_address_state,
      postalCode: row.billing_address_postal_code,
      country: row.billing_address_country,
      description: row.description,
    }
    attributes = {
      global_id_c: row.reference_code,
      name: cleanCrmValue(fields.name),
      account_type: cleanCrmValue(fields.accountType),
      website: cleanCrmValue(fields.website),
      email1: cleanCrmValue(fields.email),
      phone_office: cleanCrmValue(fields.phone),
      billing_address_street: cleanCrmValue(fields.address),
      billing_address_city: cleanCrmValue(fields.city),
      billing_address_state: cleanCrmValue(fields.state),
      billing_address_postalcode: cleanCrmValue(fields.postalCode),
      billing_address_country: cleanCrmValue(fields.country),
      parent_id: cleanCrmValue(fields.parentOrganizationSuiteCrmId),
      description: cleanCrmValue(fields.description),
    }
  } else if (table === 'crm_contacts') {
    entity = 'contacts'
    const organizationSuiteCrmId = identityMaps.byTable
      .get('crm_organizations')?.get(sourceRow.organization_id)?.suiteCrmId
    if (!organizationSuiteCrmId) fail('CRM contact lacks its selected organization SuiteCRM identity')
    fields = {
      organizationId: row.organization_id,
      organizationSuiteCrmId,
      appUserEmail: row.app_user_email,
      appUserContactReferenceCode: row.app_user_email ? row.reference_code : null,
      priority: row.priority,
      firstName: row.first_name,
      lastName: row.last_name,
      fullName: row.full_name,
      contactType: row.contact_type,
      accountManager: row.account_manager,
      ownerUserReferenceCode: row.owner_user_reference_code,
      ownerEmail: row.owner_email,
      ownerDisplayName: row.owner_display_name,
      ...(row.owner_email && owner.suitecrm_user_id
        ? { ownerSuiteCrmUserId: owner.suitecrm_user_id }
        : {}),
      jobTitle: row.job_title,
      email: row.email,
      linkedinUrl: row.linkedin_url,
      phoneWork: row.phone_work,
      phoneMobile: row.phone_mobile,
      address: row.primary_address_street,
      city: row.primary_address_city,
      state: row.primary_address_state,
      postalCode: row.primary_address_postal_code,
      country: row.primary_address_country,
      description: row.description,
      emailOptOut: row.email_opt_out === true,
      pipelineUser: row.pipeline_user === true,
    }
    attributes = {
      global_id_c: row.reference_code,
      first_name: cleanCrmValue(fields.firstName),
      last_name: cleanCrmValue(fields.lastName) || cleanCrmValue(fields.fullName),
      title: cleanCrmValue(fields.jobTitle),
      email1: cleanCrmValue(fields.email),
      phone_work: cleanCrmValue(fields.phoneWork),
      phone_mobile: cleanCrmValue(fields.phoneMobile),
      primary_address_street: cleanCrmValue(fields.address),
      primary_address_city: cleanCrmValue(fields.city),
      primary_address_state: cleanCrmValue(fields.state),
      primary_address_postalcode: cleanCrmValue(fields.postalCode),
      primary_address_country: cleanCrmValue(fields.country),
      account_id: organizationSuiteCrmId,
      ...(fields.ownerSuiteCrmUserId === undefined
        ? {}
        : { assigned_user_id: cleanCrmValue(fields.ownerSuiteCrmUserId) }),
      description: cleanCrmValue(fields.description),
    }
  } else if (table === 'crm_products') {
    entity = 'products'
    fields = {
      name: row.name,
      sku: row.sku,
      productType: row.product_type,
      categoryId: row.category_id,
      category: row.category,
      status: row.status,
      price: Number(row.price),
      cost: Number(row.cost),
      currency: row.currency,
      url: row.url,
      description: row.description,
      active: row.active === true,
    }
    attributes = {
      global_id_c: row.reference_code,
      name: cleanCrmValue(fields.name),
      part_number: cleanCrmValue(fields.sku),
      type: cleanCrmValue(fields.productType) || 'Good',
      category: cleanCrmValue(fields.category),
      cost: crmNumber(fields.cost),
      price: crmNumber(fields.price),
      url: cleanCrmValue(fields.url),
      description: cleanCrmValue(fields.description),
    }
    const normalizedCurrency = cleanCrmValue(fields.currency).toUpperCase()
    currencyCode = /^[A-Z]{3}$/u.test(normalizedCurrency) ? normalizedCurrency : 'USD'
  } else {
    return null
  }
  const sourceHash = sha256(JSON.stringify({ fields, sourcePayload }))
  const payload = {
    entity,
    pipelineId: workspace.target.pipelineId,
    localId: row.id,
    suiteCrmId: identity.suiteCrmId,
    attributes,
    ...(currencyCode ? { currencyCode } : {}),
  }
  return {
    entity,
    suiteCrmId: identity.suiteCrmId,
    sourceHash,
    payload,
    idempotencyKey: `crm:${entity}:v4:${row.id}:default:${sourceHash}`,
  }
}

async function enqueueMigratedSuiteCrmProjection(client, projection) {
  const result = await client.query(
    `INSERT INTO sync_outbox (
       aggregate_type, aggregate_id, operation, target_system, payload,
       status, idempotency_key, created_at, available_at, updated_at
     ) VALUES (
       $1, $2, 'upsert_record', 'suitecrm', $3::jsonb,
       'queued', $4, clock_timestamp(), clock_timestamp(), clock_timestamp()
     )
     ON CONFLICT (target_system, idempotency_key)
     WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING idempotency_key`,
    [
      `crm_${projection.entity}`,
      projection.payload.localId,
      JSON.stringify(projection.payload),
      projection.idempotencyKey,
    ],
  )
  if (result.rowCount !== 1) fail(`SuiteCRM migration outbox identity already exists: ${projection.idempotencyKey}`)
}

function suiteCrmOutboxReceiptDescriptor(projection) {
  return {
    idempotencyKey: projection.idempotencyKey,
    aggregateType: `crm_${projection.entity}`,
    aggregateId: projection.payload.localId,
    operation: 'upsert_record',
    targetSystem: 'suitecrm',
    entity: projection.entity,
    pipelineId: projection.payload.pipelineId,
    localId: projection.payload.localId,
    suiteCrmId: projection.payload.suiteCrmId,
    sourceHash: projection.sourceHash,
    payloadDigest: digest(projection.payload),
  }
}

function transformRow(
  table,
  sourceRow,
  identityMaps,
  workspace,
  actor,
  owner,
  workspacePlan,
) {
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
    const projection = crmProjectionForRow(table, row, sourceRow, identityMaps, workspace, owner)
    row.suitecrm_id = projection.suiteCrmId
    row.source_sheet_id = null
    row.source_row_number = null
    row.sync_status = 'pending'
    row.sync_error = null
    row.suitecrm_synced_at = null
    row.source_payload = sanitizeJson(sourceRow.source_payload || {}, identityMaps.replacements)
    row.source_hash = crmProjectionForRow(
      table,
      row,
      sourceRow,
      identityMaps,
      workspace,
      owner,
    ).sourceHash
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
      migrationProviderIdentityFence: true,
    }
    row.status = 'stale'
    row.last_verified_at = sourceRow.last_verified_at
      || sourceRow.updated_at
      || sourceRow.created_at
      || new Date(0).toISOString()
  }
  if (table === 'operations_carrier_account_migration_placeholders') {
    const expectedIntegration = workspace.source.accounts.find((account) => (
      account.id === sourceRow.integration_account_id
    ))
    if (!expectedIntegration?.carrierAccount) {
      fail(`${workspace.key} carrier placeholder lacks a compiled integration identity`)
    }
    const sourceAuthority = workspacePlan.sourceAuthorityDependencies?.find((dependency) => (
      dependency.targetIntegrationSourceGlobalId === expectedIntegration.globalId
    )) || null
    row.source_carrier_account_id = sourceRow.id
    row.source_carrier_account_global_id = sourceRow.global_id
    row.rebind_mode = expectedIntegration.sourceAuthority
      ? 'source_authority'
      : 'direct_credential'
    row.required_source_authority_organization_id = sourceAuthority?.authorityOrganizationId || null
    row.required_source_authority_integration_account_id =
      sourceAuthority?.authorityIntegrationAccountId || null
    row.required_source_authority_carrier_account_id =
      sourceAuthority?.authorityCarrierAccountId || null
    row.required_source_organization_reference =
      expectedIntegration.sourceAuthority?.organizationReference || null
    row.required_source_integration_global_id =
      expectedIntegration.sourceAuthority?.integrationGlobalId || null
    row.required_source_carrier_account_global_id =
      expectedIntegration.sourceAuthority?.carrierAccountGlobalId || null
    row.state = 'awaiting_credential_rebind'
    row.target_account_number_fingerprint = null
    row.materialized_by = null
    row.materialized_at = null
    row.created_by = actor
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
  const carrierPlaceholders = data.operations_carrier_account_migration_placeholders || []
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
  assertSelectedReference(
    carrierPlaceholders,
    'integration_account_id',
    accounts,
    'operations_carrier_account_migration_placeholders.integration_account_id',
  )
  const expectedCarrierAccounts = workspace.source.accounts
    .filter((account) => account.integrationType === 'carrier')
  if (
    carrierPlaceholders.length !== expectedCarrierAccounts.length
    || carrierPlaceholders.some((row) => !expectedCarrierAccounts.some((account) => (
      account.id === row.integration_account_id
      && account.carrierAccount?.id === row.id
      && account.carrierAccount?.globalId === row.global_id
    )))
  ) fail(`${workspace.key} carrier-account mapping closure changed`)
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

async function insertProviderIdentityFence(
  client,
  workspace,
  sourceAccount,
  carrierSourceRow,
  targetAccountId,
  actor,
  workspacePlan,
) {
  const expected = workspace.source.accounts.find((account) => account.id === sourceAccount.id)
  if (!expected) fail(`${workspace.key} source account is outside the compiled provider identity fence`)
  const sourceProviderIdentitySha256 = expected.integrationType === 'commerce'
    ? expected.externalAccountIdSha256
    : digest({
      provider: expected.provider,
      environment: expected.environment,
      carrierAccountGlobalId: expected.carrierAccount.globalId,
      sourceAccountNumberLastFour: carrierSourceRow?.source_account_number_last_four,
      sourceAccountNumberFingerprint: expected.carrierAccount.sourceAccountNumberFingerprint,
      sourceRegisteredAddressFingerprint: expected.carrierAccount.sourceAddressFingerprint,
    })
  const result = await client.query(
    `INSERT INTO operations_commerce_migration_provider_identity_fences (
       organization_id, integration_account_id, provider, integration_type,
       identity_kind, environment,
       source_database_identity, source_database_endpoint_sha256,
       target_database_endpoint_sha256, source_account_global_id,
       source_provider_identity_sha256,
       expected_external_account_id_sha256, reconnect_eligible,
       verification_state, migration_event_key, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9, $10,
       $11, $12, $13, 'awaiting_provider_identity', $14, $15
     )
     RETURNING integration_type, source_provider_identity_sha256,
               expected_external_account_id_sha256, verification_state`,
    [
      workspace.target.organizationId,
      targetAccountId,
      expected.provider,
      expected.integrationType,
      expected.integrationType === 'commerce'
        ? 'external_account_id'
        : 'carrier_shipper_account',
      expected.environment,
      SOURCE_DATABASE_IDENTITY,
      workspacePlan.sourceEndpointSha256,
      workspacePlan.targetEndpointSha256,
      expected.globalId,
      sourceProviderIdentitySha256,
      expected.integrationType === 'commerce' ? expected.externalAccountIdSha256 : null,
      expected.reconnectEligible,
      receiptEventKey(workspace, workspacePlan.sourceStateDigest),
      actor,
    ],
  )
  if (
    result.rowCount !== 1
    || result.rows[0].integration_type !== expected.integrationType
    || result.rows[0].source_provider_identity_sha256 !== sourceProviderIdentitySha256
    || result.rows[0].expected_external_account_id_sha256
      !== (expected.integrationType === 'commerce' ? expected.externalAccountIdSha256 : null)
    || result.rows[0].verification_state !== 'awaiting_provider_identity'
  ) fail(`${workspace.key} provider identity fence was not created`)
}

async function insertWorkspaceData(client, data, workspace, actor, workspacePlan) {
  const owner = await targetOwnerIdentity(client, workspace, actor)
  const identityMaps = await preallocateIdentityMaps(client, data, workspace, owner)
  const columnCache = new Map()
  const inserted = {}
  const suiteCrmOutbox = []
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
        const expected = workspace.source.accounts.find((account) => account.id === sourceRow.id)
        if (!expected) fail(`${workspace.key} selected integration lacks a compiled identity`)
        let configuration
        if (expected.sourceAuthority) {
          const targetWarehouseGlobalId = identityMaps.byTable
            .get('operations_warehouses')
            ?.get((data.operations_warehouses || []).find((warehouse) => (
              warehouse.global_id === workspace.source.warehouseGlobalId
            ))?.id)?.reference
          if (!targetWarehouseGlobalId) {
            fail(`${workspace.key} source-managed carrier lacks its migrated origin warehouse`)
          }
          configuration = sourceManagedCarrierPlaceholderConfiguration(
            sourceRow,
            expected,
            targetWarehouseGlobalId,
          )
        }
        transformed = buildCredentialFreePlaceholder(sourceRow, {
          ...targetIdentity,
          globalId: targetIdentity.reference,
          organizationId: workspace.target.organizationId,
          configuration,
        }, actor)
      } else {
        transformed = transformRow(
          table,
          sourceRow,
          identityMaps,
          workspace,
          actor,
          owner,
          workspacePlan,
        )
      }
      const insertedRow = await insertRow(client, table, transformed, columnCache)
      inserted[table].push(insertedRow)
      if (['crm_organizations', 'crm_contacts', 'crm_products'].includes(table)) {
        const projection = crmProjectionForRow(
          table,
          transformed,
          sourceRow,
          identityMaps,
          workspace,
          owner,
        )
        if (insertedRow.suitecrm_id !== projection.suiteCrmId
          || insertedRow.source_hash !== projection.sourceHash) {
          fail(`${table} canonical CRM projection changed during insert`)
        }
        await enqueueMigratedSuiteCrmProjection(client, projection)
        suiteCrmOutbox.push(suiteCrmOutboxReceiptDescriptor(projection))
      }
      if (table === 'operations_product_channel_states') {
        identityMaps.targetPackEvidenceByVariant.set(
          variantEvidenceKey(sourceRow),
          insertedRow.pack_evidence_hash,
        )
      }
      if (table === 'operations_integration_accounts') {
        if (sourceRow.integration_type === 'commerce') {
          await setPlaceholderPaused(client, workspace, insertedRow.id, actor)
        }
        await insertProviderIdentityFence(
          client,
          workspace,
          sourceRow,
          data.operations_carrier_account_migration_placeholders
            .find((row) => row.integration_account_id === sourceRow.id),
          insertedRow.id,
          actor,
          workspacePlan,
        )
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
  return {
    inserted,
    mapping,
    suiteCrmOutbox: suiteCrmOutbox.sort((left, right) => (
      left.idempotencyKey.localeCompare(right.idempotencyKey)
    )),
  }
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

function receiptIdentityDigest(payload) {
  const identity = structuredClone(payload)
  delete identity.receiptIdentityDigest
  return digest(identity)
}

async function providerIdentityFenceProjection(client, organizationId) {
  return rows(client,
    `SELECT integration_account_id::text, provider, integration_type,
            identity_kind, environment, source_provider_identity_sha256,
            expected_external_account_id_sha256, reconnect_eligible,
            source_database_identity::text,
            source_database_endpoint_sha256, target_database_endpoint_sha256,
            source_account_global_id
     FROM operations_commerce_migration_provider_identity_fences
     WHERE organization_id = $1::uuid
     ORDER BY integration_account_id`, [organizationId])
}

function validateReceiptPayload(payload, workspace, manifest) {
  if (!payload || typeof payload !== 'object') fail(`${workspace.key} migration receipt payload is invalid`)
  if (payload.scriptVersion !== SCRIPT_VERSION || payload.manifestDigest !== manifest.manifestDigest) {
    fail(`${workspace.key} migration receipt belongs to a different reviewed migration`)
  }
  if (
    payload.source?.databaseIdentity !== SOURCE_DATABASE_IDENTITY
    || payload.source?.endpointSha256 !== manifest.sourceDatabase?.endpoint_sha256
    || payload.source?.organizationId !== workspace.source.organizationId
    || payload.source?.organizationReference !== workspace.source.organizationReference
    || payload.source?.pipelineId !== workspace.source.pipelineId
    || payload.source?.sourceStateDigest !== manifest.workspaces
      ?.find((candidate) => candidate.key === workspace.key)?.sourceStateDigest
    || payload.target?.databaseIdentity !== TARGET_DATABASE_IDENTITY
    || payload.target?.endpointSha256 !== manifest.targetDatabase?.endpoint_sha256
    || payload.target?.organizationId !== workspace.target.organizationId
    || payload.target?.organizationReference !== workspace.target.organizationReference
    || payload.target?.pipelineId !== workspace.target.pipelineId
  ) fail(`${workspace.key} migration receipt identity boundary is invalid`)
  if (!payload.mapping || typeof payload.mapping !== 'object') {
    fail(`${workspace.key} migration receipt is missing its idempotent identity mapping`)
  }
  for (const [table, tableMapping] of Object.entries(payload.mapping)) {
    if (!TABLE_ID_COLUMN[table] || !tableMapping || typeof tableMapping !== 'object') {
      fail(`${workspace.key} migration receipt has an unknown identity mapping table`)
    }
    const targetIds = []
    for (const [sourceId, targetIdentity] of Object.entries(tableMapping)) {
      if (!UUID.test(sourceId) || !UUID.test(targetIdentity?.id || '')) {
        fail(`${workspace.key} migration receipt identity mapping is malformed`)
      }
      targetIds.push(targetIdentity.id)
    }
    if (new Set(targetIds).size !== targetIds.length) {
      fail(`${workspace.key} migration receipt identity mapping contains duplicate target IDs`)
    }
  }
  if (!payload.counts || typeof payload.counts !== 'object'
    || !Array.isArray(payload.suiteCrmOutbox)
    || !Array.isArray(payload.imageAssets)
    || payload.counts.sync_outbox !== payload.suiteCrmOutbox.length
    || payload.providerConnectionsCreated !== 0
    || payload.credentialRowsCopied !== 0
    || payload.carrierAccountSecretRowsCopied !== 0
    || !SHA256.test(payload.providerIdentityFenceDigest || '')
    || !SHA256.test(payload.sourceAuthorityDependencyDigest || '')
    || !Array.isArray(payload.sourceAuthorityDependencies)
    || digest(payload.sourceAuthorityDependencies)
      !== payload.sourceAuthorityDependencyDigest
    || canonicalJson(payload.sourceAuthorityDependencies)
      !== canonicalJson(manifest.workspaces
        ?.find((candidate) => candidate.key === workspace.key)
        ?.sourceAuthorityDependencies || [])) {
    fail(`${workspace.key} migration receipt materialization contract is invalid`)
  }
  const outboxKeys = new Set()
  for (const projection of payload.suiteCrmOutbox) {
    if (
      !['organizations', 'contacts', 'products'].includes(projection?.entity)
      || !UUID.test(projection?.localId || '')
      || !UUID.test(projection?.suiteCrmId || '')
      || projection.pipelineId !== workspace.target.pipelineId
      || projection.aggregateType !== `crm_${projection.entity}`
      || projection.aggregateId !== projection.localId
      || projection.operation !== 'upsert_record'
      || projection.targetSystem !== 'suitecrm'
      || !SHA256.test(projection.sourceHash || '')
      || !SHA256.test(projection.payloadDigest || '')
      || projection.idempotencyKey
        !== `crm:${projection.entity}:v4:${projection.localId}:default:${projection.sourceHash}`
      || outboxKeys.has(projection.idempotencyKey)
    ) fail(`${workspace.key} migration receipt SuiteCRM projection is invalid`)
    outboxKeys.add(projection.idempotencyKey)
  }
  const imageIds = new Set()
  for (const image of payload.imageAssets) {
    if (!UUID.test(image?.id || '') || !SHA256.test(image?.contentSha256 || '')
      || !Number.isSafeInteger(image?.byteLength) || image.byteLength < 1
      || imageIds.has(image.id)) {
      fail(`${workspace.key} migration receipt image identity is invalid`)
    }
    imageIds.add(image.id)
  }
  if (!SHA256.test(payload.receiptIdentityDigest || '')
    || receiptIdentityDigest(payload) !== payload.receiptIdentityDigest) {
    fail(`${workspace.key} migration receipt identity digest is invalid`)
  }
  return payload
}

async function assertReceiptMaterialization(client, workspace, payload) {
  for (const [table, tableMapping] of Object.entries(payload.mapping)) {
    const idColumn = TABLE_ID_COLUMN[table]
    if (!idColumn || !tableMapping || typeof tableMapping !== 'object') continue
    const ids = Object.values(tableMapping).map((entry) => entry?.id).filter(Boolean)
    if (!ids.length) continue
    const count = Number((await client.query(
      `SELECT count(*)::integer AS count
       FROM ${quotedIdentifier(table)}
       WHERE ${quotedIdentifier(idColumn)} = ANY($1::uuid[])`, [ids])).rows[0].count)
    if (count !== ids.length) fail(`${workspace.key} receipt references missing ${table} rows`)
  }
  for (const image of payload.imageAssets || []) {
    const observed = await client.query(
      `SELECT content_sha256, byte_length,
              encode(digest(content_bytes, 'sha256'), 'hex') AS observed_sha256,
              octet_length(content_bytes)::integer AS observed_bytes
       FROM crm_product_image_assets
       WHERE id = $1::uuid AND pipeline_id = $2::uuid`,
      [image.id, workspace.target.pipelineId],
    )
    const row = observed.rows[0]
    if (!row
      || row.content_sha256 !== image.contentSha256
      || Number(row.byte_length) !== image.byteLength
      || row.observed_sha256 !== image.contentSha256
      || Number(row.observed_bytes) !== image.byteLength) {
      fail(`${workspace.key} receipt image materialization failed integrity validation`)
    }
  }
  for (const expected of payload.suiteCrmOutbox || []) {
    const crmTable = {
      organizations: 'crm_organizations',
      contacts: 'crm_contacts',
      products: 'crm_products',
    }[expected.entity]
    const crmIdentity = await client.query(
      `SELECT suitecrm_id
       FROM ${quotedIdentifier(crmTable)}
       WHERE id = $1::uuid AND pipeline_id = $2::uuid`,
      [expected.localId, workspace.target.pipelineId],
    )
    if (crmIdentity.rowCount !== 1
      || crmIdentity.rows[0].suitecrm_id !== expected.suiteCrmId) {
      fail(`${workspace.key} SuiteCRM migration identity changed`)
    }
    const result = await client.query(
      `SELECT aggregate_type, aggregate_id, operation, target_system,
              payload, idempotency_key
       FROM sync_outbox
       WHERE target_system = 'suitecrm' AND idempotency_key = $1
       LIMIT 2`,
      [expected.idempotencyKey],
    )
    if (result.rows.length !== 1) {
      fail(`${workspace.key} receipt references a missing or duplicate SuiteCRM outbox projection`)
    }
    const observed = result.rows[0]
    const expectedIdempotencyKey = `crm:${expected.entity}:v4:${expected.localId}:default:${expected.sourceHash}`
    if (
      expected.idempotencyKey !== expectedIdempotencyKey
      || expected.aggregateType !== `crm_${expected.entity}`
      || expected.aggregateId !== expected.localId
      || expected.operation !== 'upsert_record'
      || expected.targetSystem !== 'suitecrm'
      || observed.idempotency_key !== expected.idempotencyKey
      || observed.aggregate_type !== expected.aggregateType
      || observed.aggregate_id !== expected.aggregateId
      || observed.operation !== expected.operation
      || observed.target_system !== expected.targetSystem
      || observed.payload?.entity !== expected.entity
      || observed.payload?.pipelineId !== expected.pipelineId
      || observed.payload?.localId !== expected.localId
      || observed.payload?.suiteCrmId !== expected.suiteCrmId
      || digest(observed.payload) !== expected.payloadDigest
    ) {
      fail(`${workspace.key} SuiteCRM migration outbox projection changed`)
    }
  }
  const fences = await providerIdentityFenceProjection(
    client,
    workspace.target.organizationId,
  )
  if (digest(fences) !== payload.providerIdentityFenceDigest) {
    fail(`${workspace.key} migrated provider identity fence materialization changed`)
  }
  const sourceAuthorities = await targetSourceAuthorityDependencies(client, workspace)
  if (
    sourceAuthorities.some((dependency) => !dependency.ready)
    || digest(sourceAuthorities) !== payload.sourceAuthorityDependencyDigest
    || canonicalJson(sourceAuthorities)
      !== canonicalJson(payload.sourceAuthorityDependencies)
  ) fail(`${workspace.key} migrated source carrier authority dependency changed`)
}

async function assertPlaceholderPostState(client, workspace) {
  const expectedAccounts = workspace.source.accounts
  const expectedCommerceAccounts = expectedAccounts.filter((account) => (
    account.integrationType === 'commerce'
  ))
  const expectedCarrierAccounts = expectedAccounts.filter((account) => (
    account.integrationType === 'carrier'
  ))
  const accounts = await rows(client,
    `SELECT id::text, global_id, provider, integration_type, environment, status,
            external_account_id, credential_reference,
            commerce_credential_generation, receipt_intake_enabled,
            configuration
     FROM operations_integration_accounts
     WHERE organization_id = $1::uuid
       AND integration_type IN ('commerce', 'carrier')
     ORDER BY integration_type, provider, environment`, [workspace.target.organizationId])
  if (accounts.length !== expectedAccounts.length) {
    fail(`${workspace.key} target account count changed during apply`)
  }
  for (const account of accounts) {
    const expected = expectedAccounts.find((candidate) => (
      candidate.provider === account.provider
      && candidate.integrationType === account.integration_type
      && candidate.environment === account.environment
    ))
    if (
      !expected
      || account.status !== 'disabled'
      || account.external_account_id !== null
      || account.credential_reference !== null
      || Number(account.commerce_credential_generation) !== 0
      || account.receipt_intake_enabled !== false
      || account.configuration?.migrationRequiresCredentialRebind !== true
      || account.configuration?.migrationRequiresProviderIdentityVerification !== true
    ) fail(`${workspace.key} target placeholder ${account.global_id} is not fail-closed`)
  }
  const controls = await rows(client,
    `SELECT desired_state, explicit_choice,
            operations_commerce_store_sync_is_running(organization_id, integration_account_id) AS effective_running
     FROM operations_commerce_store_sync_controls
     WHERE organization_id = $1::uuid`, [workspace.target.organizationId])
  if (
    controls.length !== expectedCommerceAccounts.length
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
  const fences = await rows(client,
    `SELECT provider, integration_type, environment,
            expected_external_account_id_sha256,
            reconnect_eligible, verification_state,
            verified_external_account_id_sha256, verified_carrier_account_id,
            verified_carrier_account_identity_sha256
     FROM operations_commerce_migration_provider_identity_fences
     WHERE organization_id = $1::uuid
     ORDER BY provider, environment`, [workspace.target.organizationId])
  if (
    fences.length !== expectedAccounts.length
    || fences.some((fence) => (
      fence.verification_state !== 'awaiting_provider_identity'
      || fence.verified_external_account_id_sha256 !== null
      || fence.verified_carrier_account_id !== null
      || fence.verified_carrier_account_identity_sha256 !== null
    ))
  ) fail(`${workspace.key} migrated provider identity fences are not fail-closed`)
  const carrierPlaceholders = await rows(client,
    `SELECT integration_account_id::text, rebind_mode, state,
            target_account_number_fingerprint, materialized_by, materialized_at
     FROM operations_carrier_account_migration_placeholders
     WHERE organization_id = $1::uuid
     ORDER BY integration_account_id`, [workspace.target.organizationId])
  if (
    carrierPlaceholders.length !== expectedCarrierAccounts.length
    || carrierPlaceholders.some((placeholder) => (
      placeholder.state !== 'awaiting_credential_rebind'
      || placeholder.target_account_number_fingerprint !== null
      || placeholder.materialized_by !== null
      || placeholder.materialized_at !== null
    ))
  ) fail(`${workspace.key} migrated carrier account placeholders are not fail-closed`)
  const carrierSecrets = await client.query(
    `SELECT
       (SELECT count(*)::integer FROM operations_carrier_credentials
        WHERE organization_id = $1::uuid) AS credentials,
       (SELECT count(*)::integer FROM operations_carrier_accounts
        WHERE organization_id = $1::uuid) AS accounts`,
    [workspace.target.organizationId],
  )
  if (
    carrierSecrets.rows[0].credentials !== 0
    || carrierSecrets.rows[0].accounts !== 0
  ) fail(`${workspace.key} carrier credentials or encrypted account material was copied`)
  const identifiers = await rows(client,
    `SELECT status, last_verified_at, match_evidence
     FROM operations_external_identifiers
     WHERE organization_id = $1::uuid`, [workspace.target.organizationId])
  if (identifiers.some((identifier) => (
    identifier.status !== 'stale'
    || identifier.last_verified_at == null
    || identifier.match_evidence?.migrationProviderIdentityFence !== true
  ))) fail(`${workspace.key} migrated external identifiers are not stale-safe`)
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

async function recordMigrationReceipt(
  client,
  workspace,
  plan,
  counts,
  mapping,
  suiteCrmOutbox,
  imageAssets,
  actor,
) {
  const eventKey = receiptEventKey(workspace, plan.sourceStateDigest)
  const providerFences = await providerIdentityFenceProjection(
    client,
    workspace.target.organizationId,
  )
  const payload = {
    scriptVersion: SCRIPT_VERSION,
    manifestDigest: plan.manifestDigest,
    source: {
      databaseIdentity: SOURCE_DATABASE_IDENTITY,
      endpointSha256: plan.sourceEndpointSha256,
      organizationId: workspace.source.organizationId,
      organizationReference: workspace.source.organizationReference,
      pipelineId: workspace.source.pipelineId,
      sourceStateDigest: plan.sourceStateDigest,
    },
    target: {
      databaseIdentity: TARGET_DATABASE_IDENTITY,
      endpointSha256: plan.targetEndpointSha256,
      organizationId: workspace.target.organizationId,
      organizationReference: workspace.target.organizationReference,
      pipelineId: workspace.target.pipelineId,
    },
    counts,
    mapping,
    suiteCrmOutbox: [...suiteCrmOutbox].sort((left, right) => (
      left.idempotencyKey.localeCompare(right.idempotencyKey)
    )),
    imageAssets: imageAssets.map((image) => ({
      id: image.id,
      contentSha256: image.content_sha256,
      byteLength: Number(image.byte_length),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    providerIdentityFenceDigest: digest(providerFences),
    sourceAuthorityDependencies: plan.sourceAuthorityDependencies,
    sourceAuthorityDependencyDigest: plan.sourceAuthorityDependencyDigest,
    providerConnectionsCreated: 0,
    credentialRowsCopied: 0,
    carrierAccountSecretRowsCopied: 0,
  }
  payload.receiptIdentityDigest = receiptIdentityDigest(payload)
  const result = await client.query(
    `INSERT INTO audit_events (
       actor, event_type, aggregate_type, aggregate_id, payload, event_key,
       subject, organization_id, is_system
     ) VALUES (
       $1, 'operations.commerce_workspace_migration.completed',
       'workspace_organization', $2::text, $3::jsonb, $4, $1, $2::uuid, false
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
    const sourceAuthorityDependencies = await targetSourceAuthorityDependencies(
      target,
      workspace,
      true,
    )
    if (
      sourceAuthorityDependencies.some((dependency) => !dependency.ready)
      || digest(sourceAuthorityDependencies)
        !== workspacePlan.sourceAuthorityDependencyDigest
      || canonicalJson(sourceAuthorityDependencies)
        !== canonicalJson(workspacePlan.sourceAuthorityDependencies)
    ) {
      fail(`${workspace.key} production source carrier authority changed after the reviewed plan`)
    }
    const eventKey = receiptEventKey(workspace, workspacePlan.sourceStateDigest)
    const existing = await readReceipt(target, eventKey)
    if (existing) {
      const payload = validateReceiptPayload(existing.payload, workspace, manifest)
      await assertReceiptMaterialization(target, workspace, payload)
      await target.query('COMMIT')
      return {
        key: workspace.key,
        disposition: 'already_applied',
        receiptIdentityDigest: payload.receiptIdentityDigest,
        counts: payload.counts,
        mapping: payload.mapping,
      }
    }
    if (await countWorkspaceReceipts(target, workspace)) {
      fail(`${workspace.key} has a migration receipt from a different source state`)
    }
    const currentConfiguration = await targetConfigurationBaseline(target, workspace, actor, true)
    if (canonicalJson(currentConfiguration) !== canonicalJson(workspacePlan.targetConfigurationBaseline)) {
      fail(`${workspace.key} target configuration changed after the reviewed plan`)
    }
    const beforeScope = await targetScopeAudit(target, workspace)
    if (
      beforeScope.classificationDigest !== workspacePlan.targetScopeClassificationDigest
      || canonicalJson(beforeScope.classifications)
        !== canonicalJson(workspacePlan.targetScopeClassifications)
    ) {
      fail(`${workspace.key} target scope classification changed after the reviewed plan`)
    }
    const beforeCounts = beforeScope.counts
    if (!targetIsEmpty(beforeCounts, beforeScope.denied)) {
      fail(`${workspace.key} target contains selected rows without an exact migration receipt`)
    }
    const migrationWorkspacePlan = {
      ...workspacePlan,
      sourceEndpointSha256: manifest.sourceDatabase.endpoint_sha256,
      targetEndpointSha256: manifest.targetDatabase.endpoint_sha256,
    }
    const { inserted, mapping, suiteCrmOutbox } = await insertWorkspaceData(
      target, data, workspace, actor, migrationWorkspacePlan)
    await assertPlaceholderPostState(target, workspace)
    const commerceAccountCount = workspace.source.accounts.filter((account) => (
      account.integrationType === 'commerce'
    )).length
    const counts = {
      ...Object.fromEntries(Object.entries(inserted).map(([table, selected]) => [table, selected.length])),
      operations_commerce_store_sync_controls: commerceAccountCount,
      operations_commerce_migration_provider_identity_fences: workspace.source.accounts.length,
      sync_outbox: suiteCrmOutbox.length,
    }
    const receipt = await recordMigrationReceipt(
      target,
      workspace,
      {
        ...workspacePlan,
        manifestDigest: manifest.manifestDigest,
        sourceEndpointSha256: manifest.sourceDatabase.endpoint_sha256,
        targetEndpointSha256: manifest.targetDatabase.endpoint_sha256,
      },
      counts,
      mapping,
      suiteCrmOutbox,
      inserted.crm_product_image_assets,
      actor,
    )
    await target.query('COMMIT')
    return {
      key: workspace.key,
      disposition: 'applied',
      receiptIdentityDigest: receipt.payload.receiptIdentityDigest,
      counts,
      mapping,
    }
  } catch (error) {
    await target.query('ROLLBACK')
    throw error
  }
}

function assertManifestBoundary(manifest, options, endpointBindings, workspaces = WORKSPACES) {
  if (manifest.manifestDigest !== options.confirmDigest) {
    fail('--confirm-digest must exactly match the reviewed manifest digest')
  }
  if (manifest.actor !== options.actor) fail('Manifest actor does not match --actor')
  if (
    manifest.sourceDatabase?.database_identity !== SOURCE_DATABASE_IDENTITY
    || manifest.targetDatabase?.database_identity !== TARGET_DATABASE_IDENTITY
  ) fail('Manifest database identities do not match the compiled DEV to PROD boundary')
  if (
    manifest.sourceDatabase?.endpoint_sha256 !== endpointBindings.source
    || manifest.targetDatabase?.endpoint_sha256 !== endpointBindings.target
  ) fail('Manifest database endpoint bindings do not match this execution')
  if (!manifest.applyReady) fail('Reviewed manifest is not apply-ready; create a fresh plan after clearing every blocker')
  if (manifest.workspaces?.length !== workspaces.length) fail('Manifest workspace count is invalid')
  for (let index = 0; index < workspaces.length; index += 1) {
    assertManifestWorkspace(manifest.workspaces[index], workspaces[index])
  }
}

function mappingArtifact(manifest, results) {
  return {
    format: MAPPING_FORMAT,
    scriptVersion: SCRIPT_VERSION,
    manifestDigest: manifest.manifestDigest,
    exportedAt: new Date().toISOString(),
    sourceDatabaseIdentity: SOURCE_DATABASE_IDENTITY,
    targetDatabaseIdentity: TARGET_DATABASE_IDENTITY,
    sourceEndpointSha256: manifest.sourceDatabase.endpoint_sha256,
    targetEndpointSha256: manifest.targetDatabase.endpoint_sha256,
    results,
  }
}

async function applyManifest(source, target, manifest, options, endpointBindings, workspaces = WORKSPACES) {
  assertManifestBoundary(manifest, options, endpointBindings, workspaces)
  ensureSafeOutputPath(options.mappingOutput)
  await assertDatabaseIdentities(source, target, endpointBindings)
  const capabilities = await targetCapabilities(target)
  if (!capabilitiesReady(capabilities)) {
    fail('Production lacks the required history-cutoff and 0351 storage-retention capabilities')
  }
  const results = []
  for (let index = 0; index < workspaces.length; index += 1) {
    const workspace = workspaces[index]
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
  const artifact = mappingArtifact(manifest, results)
  writePrivateJson(options.mappingOutput, artifact)
  return artifact
}

async function exportReceipts(target, manifest, options, endpointBindings, workspaces = WORKSPACES) {
  assertManifestBoundary(manifest, options, {
    source: manifest.sourceDatabase?.endpoint_sha256,
    target: endpointBindings.target,
  }, workspaces)
  ensureSafeOutputPath(options.mappingOutput)
  const targetIdentity = await databaseIdentity(target)
  if (targetIdentity?.database_identity !== TARGET_DATABASE_IDENTITY) {
    fail('TARGET_DATABASE_URL is not the verified ClawPilot production database')
  }
  const results = []
  for (let index = 0; index < workspaces.length; index += 1) {
    const workspace = workspaces[index]
    const workspacePlan = manifest.workspaces[index]
    const receipt = await readReceipt(
      target,
      receiptEventKey(workspace, workspacePlan.sourceStateDigest),
    )
    if (!receipt) fail(`${workspace.key} has no committed migration receipt to export`)
    const payload = validateReceiptPayload(receipt.payload, workspace, manifest)
    await assertReceiptMaterialization(target, workspace, payload)
    results.push({
      key: workspace.key,
      disposition: 'receipt_exported',
      receiptIdentityDigest: payload.receiptIdentityDigest,
      counts: payload.counts,
      mapping: payload.mapping,
    })
  }
  const artifact = mappingArtifact(manifest, results)
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
        missingCutoverFences: workspace.accounts.length
          - workspace.sourceBlockers.cutoverFences.filter((fence) => (
            fence.migration_name === SCRIPT_VERSION && fence.state === 'frozen'
          )).length,
        dirtyReconciliation: workspace.sourceBlockers.dirtyReconciliation
          .reduce((sum, item) => (
            sum + item.rows.reduce((inner, row) => inner + row.count, 0)
          ), 0),
        missingDirtyReconciliationTables: workspace.sourceBlockers.dirtyReconciliation
          .filter((item) => item.missing).length,
        heldWork: workspace.sourceBlockers.heldWork.reduce((sum, item) => (
          sum + item.rows.reduce((inner, row) => inner + row.count, 0)
        ), 0),
        missingHeldWorkTables: workspace.sourceBlockers.heldWork
          .filter((item) => item.missing).length,
        revisionWork: workspace.sourceBlockers.revisionWork
          .reduce((sum, row) => sum + row.count, 0),
      },
    })),
  }
}

export async function main(
  argv = process.argv.slice(2),
  environment = process.env,
  runtime = { workspaces: WORKSPACES },
) {
  const options = parseArguments(argv)
  const workspaces = runtime.workspaces || WORKSPACES
  const targetUrl = validatedUrl(environment.TARGET_DATABASE_URL, 'TARGET_DATABASE_URL')
  if (options.command === 'receipt-export') {
    const endpointBindings = validatedEndpointBindings(environment, '', targetUrl, false)
    const targetPool = poolFor(targetUrl)
    const target = await targetPool.connect()
    try {
      await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const manifest = readManifest(options.manifest)
      const result = await exportReceipts(target, manifest, options, endpointBindings, workspaces)
      await target.query('COMMIT')
      console.log(JSON.stringify({
        command: 'receipt-export',
        manifestDigest: manifest.manifestDigest,
        mappingOutputWritten: true,
        workspaces: result.results.map(({ key, receiptIdentityDigest }) => ({
          key, receiptIdentityDigest,
        })),
      }, null, 2))
      return result
    } catch (error) {
      try { await target.query('ROLLBACK') } catch {}
      throw error
    } finally {
      target.release()
      await targetPool.end()
    }
  }
  const sourceUrl = validatedUrl(environment.SOURCE_DATABASE_URL, 'SOURCE_DATABASE_URL')
  const endpointBindings = validatedEndpointBindings(environment, sourceUrl, targetUrl)
  const sourcePool = poolFor(sourceUrl)
  const targetPool = poolFor(targetUrl)
  const source = await sourcePool.connect()
  const target = await targetPool.connect()
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await acquireSourceCutoverLocks(source)
    if (options.command === 'plan') {
      // Exact transitive target-scope discovery uses an ON COMMIT DROP temp
      // table; this transaction never mutates durable target state.
      await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      try {
        const plan = await buildPlan(source, target, options.actor, endpointBindings, workspaces)
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
    const result = await applyManifest(
      source, target, manifest, options, endpointBindings, workspaces)
    await source.query('COMMIT')
    console.log(JSON.stringify({
      command: 'apply',
      manifestDigest: manifest.manifestDigest,
      mappingOutputWritten: true,
      workspaces: result.results.map(({ key, disposition, counts, receiptIdentityDigest }) => ({
        key, disposition, counts, receiptIdentityDigest,
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
