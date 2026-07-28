#!/usr/bin/env node
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

export const SCRIPT_VERSION =
  'ag-alchemy-commerce-product-name-reconciliation-v1'
export const NAME_POLICY_VERSION = 'commerce-product-name-v2'
export const EXECUTION_CONFIRMATION =
  'reconcile-ag-alchemy-commerce-product-names-v1'
export const SYSTEM_ACTOR = 'system'
export const SYSTEM_AUDIT_ATTRIBUTION = Object.freeze({
  actor: SYSTEM_ACTOR,
  isSystem: true,
})
export const TRUSTED_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
export const TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT =
  '750aa268-0e31-4065-a99c-4016e4d4fab1'
export const TARGET_ORGANIZATION_NAME = 'AG Alchemy, LLC'

const MAX_PRODUCT_NAME_LENGTH = 255
const GENERATED_SOURCES = new Set([
  'commerce_catalog_automatic_creation',
  'commerce_catalog_explicit_creation',
])
const PROVIDER_LABELS = Object.freeze({
  shopify: 'Shopify',
  faire: 'Faire',
})
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fail(message) {
  throw new Error(message)
}

function environmentValue(name) {
  return String(process.env[name] || '').trim()
}

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function comparable(value) {
  return compact(value).normalize('NFKC').toLocaleLowerCase('en-US')
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    )
  }
  return value
}

function stableDigest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)), 'utf8')
    .digest('hex')
}

function commandHash(value) {
  const canonicalJson = (item) => {
    if (Array.isArray(item)) {
      return `[${item.map(canonicalJson).join(',')}]`
    }
    if (item && typeof item === 'object') {
      return `{${Object.keys(item).sort().map((key) => (
        `${JSON.stringify(key)}:${canonicalJson(item[key])}`
      )).join(',')}}`
    }
    if (typeof item === 'bigint') return JSON.stringify(item.toString())
    return JSON.stringify(item) ?? 'null'
  }
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function isDefaultVariant(value) {
  const normalized = comparable(value)
    .replace(/[\s._/-]+/g, ' ')
    .trim()
  return normalized === 'default' || normalized === 'default title'
}

function stripProductTitlePrefix(productTitle, variantTitle) {
  if (!productTitle || variantTitle.length < productTitle.length) {
    return variantTitle
  }
  const rawPrefix = variantTitle.slice(0, productTitle.length)
  if (comparable(rawPrefix) !== comparable(productTitle)) return variantTitle
  const rawRemainder = variantTitle.slice(productTitle.length)
  if (
    rawRemainder
    && !/^[\s·:|/–—-]/u.test(rawRemainder)
  ) {
    return variantTitle
  }
  return rawRemainder.replace(/^[\s·:|/–—-]+/u, '').trim()
}

export function commerceVariantLabel(input) {
  const productTitle = compact(input.productTitle)
  const optionValues = (input.selectedOptions || [])
    .map((option) => compact(option?.value))
    .filter((value) => value && !isDefaultVariant(value))
  const distinctOptionValues = optionValues.filter((value, index) => (
    optionValues.findIndex((candidate) => (
      comparable(candidate) === comparable(value)
    )) === index
  ))
  if (distinctOptionValues.length > 0) {
    return distinctOptionValues.join(' / ')
  }
  const variantTitle = compact(input.variantTitle)
  if (!variantTitle || isDefaultVariant(variantTitle)) return null
  if (comparable(variantTitle) === comparable(productTitle)) return null
  const suffix = stripProductTitlePrefix(productTitle, variantTitle)
  if (!suffix || isDefaultVariant(suffix)) return null
  return suffix
}

export function commerceProductDisplayName(input) {
  const productTitle = compact(input.productTitle)
  const variantLabel = commerceVariantLabel(input)
  return variantLabel ? `${productTitle} · ${variantLabel}` : productTitle
}

function generatedLegacyName(productTitle, variantTitle) {
  const title = compact(productTitle)
  const variant = compact(variantTitle)
  const raw = variant && variant !== title
    ? `${title} · ${variant}`
    : title
  if (raw.length <= MAX_PRODUCT_NAME_LENGTH) return raw
  const suffix = ` · ${commandHash(raw).slice(0, 12)}`
  return `${raw.slice(0, MAX_PRODUCT_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`
}

function boundedName(baseValue, suffixValue, stableKey) {
  const base = compact(baseValue)
  const suffix = compact(suffixValue)
    ? ` · ${compact(suffixValue)}`
    : ''
  const raw = `${base}${suffix}`
  if (raw.length <= MAX_PRODUCT_NAME_LENGTH) return raw
  const hashSuffix = ` · ${stableDigest(stableKey).slice(0, 12)}`
  const available = MAX_PRODUCT_NAME_LENGTH - suffix.length - hashSuffix.length
  if (available < 1) fail('Product name suffix exceeds the CRM name limit')
  return `${base.slice(0, available).trimEnd()}${suffix}${hashSuffix}`
}

function sourceSnapshot(row) {
  const payload = row.source_payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const snapshot = payload.providerSnapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null
  }
  return {
    source: compact(payload.source),
    integrationAccountGlobalId:
      compact(payload.integrationAccountGlobalId),
    candidateGlobalId: compact(payload.candidateGlobalId),
    productTitle: compact(snapshot.productTitle),
    variantTitle: compact(snapshot.variantTitle) || null,
    providerSku: compact(snapshot.sku) || null,
    providerBarcode: compact(snapshot.barcode) || null,
    reconciliation: payload.nameReconciliation
      && typeof payload.nameReconciliation === 'object'
      && !Array.isArray(payload.nameReconciliation)
      ? payload.nameReconciliation
      : null,
  }
}

function evidenceBlockers(row) {
  const snapshot = sourceSnapshot(row)
  const blockers = []
  if (!snapshot || !GENERATED_SOURCES.has(snapshot.source)) {
    blockers.push('source_payload_not_commerce_generated')
    return blockers
  }
  if (!snapshot.productTitle) blockers.push('source_product_title_missing')
  if (snapshot.integrationAccountGlobalId !== row.account_global_id) {
    blockers.push('integration_account_evidence_mismatch')
  }
  if (snapshot.candidateGlobalId !== row.candidate_global_id) {
    blockers.push('creation_candidate_evidence_mismatch')
  }
  if (snapshot.productTitle !== compact(row.product_title_snapshot)) {
    blockers.push('product_title_evidence_mismatch')
  }
  if (
    compact(snapshot.variantTitle)
    !== compact(row.variant_title_snapshot)
  ) {
    blockers.push('variant_title_evidence_mismatch')
  }
  if (row.mapping_source_revision !== row.candidate_source_revision) {
    blockers.push('mapping_revision_evidence_mismatch')
  }
  if (row.product_mapping_count !== 1) {
    blockers.push('product_mapping_cardinality_changed')
  } else if (
    row.product_active_mappings?.[0]?.mapping_id
    !== row.product_mapping_id
  ) {
    blockers.push('creation_mapping_is_not_only_active_mapping')
  }
  if (!UUID_PATTERN.test(row.product_id || '')) {
    blockers.push('product_identity_invalid')
  }
  if (!UUID_PATTERN.test(row.product_mapping_id || '')) {
    blockers.push('product_mapping_identity_invalid')
  }
  if (!UUID_PATTERN.test(row.candidate_id || '')) {
    blockers.push('candidate_identity_invalid')
  }
  if (!row.suitecrm_id || !UUID_PATTERN.test(row.suitecrm_id)) {
    blockers.push('suitecrm_identity_missing')
  }
  return blockers
}

function planFingerprint(records) {
  return stableDigest(records.map((record) => ({
    productId: record.product_id,
    productGlobalId: record.product_global_id,
    productSourceHash: record.product_source_hash,
    productUpdatedAt: record.product_updated_at,
    currentName: record.current_name,
    finalName: record.final_name,
    action: record.action,
    provider: record.provider,
    accountGlobalId: record.account_global_id,
    mappingId: record.product_mapping_id,
    mappingGlobalId: record.mapping_global_id,
    mappingSourceRevision: record.mapping_source_revision,
    productActiveMappings: record.product_active_mappings,
    externalProductId: record.external_product_id,
    externalVariantId: record.external_variant_id,
    externalInventoryItemId: record.external_inventory_item_id,
    candidateId: record.candidate_id,
    candidateGlobalId: record.candidate_global_id,
    candidateSourceHash: record.candidate_source_hash,
    candidateSourceRevision: record.candidate_source_revision,
    blockers: record.blockers,
  })))
}

export function buildNamePlan(rows, reservedRows = []) {
  const records = rows.map((row) => {
    const snapshot = sourceSnapshot(row)
    const blockers = evidenceBlockers(row)
    const canonicalName = snapshot?.productTitle
      ? commerceProductDisplayName({
          productTitle: snapshot.productTitle,
          variantTitle: snapshot.variantTitle,
          selectedOptions: Array.isArray(row.normalized_options)
            ? row.normalized_options
            : [],
        })
      : ''
    const legacyName = snapshot?.productTitle
      ? generatedLegacyName(
          snapshot.productTitle,
          snapshot.variantTitle,
        )
      : ''
    const reconciliation = snapshot?.reconciliation
    const alreadyReconciled = (
      reconciliation?.policyVersion === NAME_POLICY_VERSION
      && compact(reconciliation?.finalName) === compact(row.current_name)
    )
    const generatedNameStillPresent = row.current_name === legacyName
    const manuallyChanged = (
      blockers.length === 0
      && !alreadyReconciled
      && !generatedNameStillPresent
    )
    return {
      ...row,
      current_name: row.current_name,
      canonical_name: canonicalName,
      legacy_name: legacyName,
      final_name: row.current_name,
      blockers,
      already_reconciled: alreadyReconciled,
      manually_changed: manuallyChanged,
      action: blockers.length > 0
        ? 'blocked'
        : manuallyChanged
          ? 'preserve_manual'
          : 'pending',
    }
  })

  const canonicalGroups = new Map()
  for (const record of records) {
    if (!record.canonical_name) continue
    const key = comparable(record.canonical_name)
    const group = canonicalGroups.get(key) || []
    group.push(record)
    canonicalGroups.set(key, group)
  }

  const used = new Set(
    reservedRows.map((row) => comparable(row.name)).filter(Boolean),
  )
  for (const record of records) {
    if (
      record.action === 'blocked'
      || record.action === 'preserve_manual'
    ) {
      used.add(comparable(record.current_name))
    }
  }

  for (const group of [...canonicalGroups.values()].sort((left, right) => (
    comparable(left[0].canonical_name)
      .localeCompare(comparable(right[0].canonical_name))
  ))) {
    const ordered = [...group].sort((left, right) => (
      `${left.provider}:${left.product_global_id}`
        .localeCompare(`${right.provider}:${right.product_global_id}`)
    ))
    const providerCounts = new Map()
    for (const record of ordered) {
      providerCounts.set(
        record.provider,
        (providerCounts.get(record.provider) || 0) + 1,
      )
    }
    for (const record of ordered) {
      if (
        record.action === 'blocked'
        || record.action === 'preserve_manual'
      ) continue
      const collision = ordered.length > 1
      const providerLabel = PROVIDER_LABELS[record.provider]
        || compact(record.provider)
        || 'Commerce'
      const providerRepeated = (
        providerCounts.get(record.provider) || 0
      ) > 1
      let suffix = collision ? providerLabel : ''
      if (providerRepeated) {
        suffix = `${providerLabel} ${
          stableDigest(record.external_variant_id).slice(0, 8)
        }`
      }
      let finalName = boundedName(
        record.canonical_name,
        suffix,
        {
          provider: record.provider,
          externalVariantId: record.external_variant_id,
        },
      )
      if (used.has(comparable(finalName))) {
        finalName = boundedName(
          record.canonical_name,
          `${providerLabel} ${
            stableDigest(record.external_variant_id).slice(0, 12)
          }`,
          {
            provider: record.provider,
            externalVariantId: record.external_variant_id,
            productGlobalId: record.product_global_id,
          },
        )
      }
      if (used.has(comparable(finalName))) {
        record.blockers.push('final_product_name_collision')
        record.action = 'blocked'
        used.add(comparable(record.current_name))
        continue
      }
      record.final_name = finalName
      record.action = record.current_name === finalName
        ? 'unchanged'
        : 'rename'
      used.add(comparable(finalName))
    }
  }

  for (const record of records) {
    if (record.action === 'pending') {
      record.blockers.push('canonical_name_not_planned')
      record.action = 'blocked'
    }
  }
  const fingerprint = planFingerprint(records)
  return {
    fingerprint,
    records,
    summary: {
      total: records.length,
      rename: records.filter((record) => record.action === 'rename').length,
      unchanged: records.filter((record) => (
        record.action === 'unchanged'
      )).length,
      preserveManual: records.filter((record) => (
        record.action === 'preserve_manual'
      )).length,
      blocked: records.filter((record) => (
        record.action === 'blocked'
      )).length,
      naturalNames: records.filter((record) => (
        record.action === 'rename'
        && !record.final_name.endsWith(' · Shopify')
        && !record.final_name.endsWith(' · Faire')
      )).length,
      sourceQualifiedNames: records.filter((record) => (
        record.action === 'rename'
        && (
          record.final_name.endsWith(' · Shopify')
          || record.final_name.endsWith(' · Faire')
        )
      )).length,
      collisionGroups: [...canonicalGroups.values()]
        .filter((group) => group.length > 1).length,
    },
  }
}

function requireTrustedDevelopmentEnvironment() {
  if (
    environmentValue('RAILWAY_PROJECT_ID') !== TRUSTED_RAILWAY_PROJECT_ID
    || environmentValue('RAILWAY_ENVIRONMENT_ID')
      !== TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
    || environmentValue('RAILWAY_ENVIRONMENT_NAME') !== 'development'
  ) {
    fail(
      'This command is restricted to the trusted ClawPilot development environment',
    )
  }
}

async function loadDatabaseIdentity(client) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
       (
         SELECT value ->> 'id'
         FROM app_settings
         WHERE key = 'deployment.database.identity'
       ) AS database_fingerprint`,
  )
  const identity = result.rows[0]
  if (
    !UUID_PATTERN.test(identity?.database_fingerprint || '')
    || identity.database_fingerprint
      !== TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT
  ) {
    fail(
      'Connected database is not the trusted ClawPilot development database',
    )
  }
  return identity
}

async function loadTarget(client, lock = false) {
  const organizationResult = await client.query(
    `SELECT id::text, name, reference_code
     FROM workspace_organizations
     WHERE lower(name) = lower($1)
     ORDER BY id`,
    [TARGET_ORGANIZATION_NAME],
  )
  if (organizationResult.rowCount !== 1) {
    fail(`Expected exactly one ${TARGET_ORGANIZATION_NAME} organization`)
  }
  const organization = organizationResult.rows[0]
  const pipelineResult = await client.query(
    `SELECT id::text, name, sync_enabled, sheet_id
     FROM pipeline_spaces
     WHERE workspace_organization_id = $1::uuid
       AND COALESCE(reference_access_disabled, false) = false
     ORDER BY created_at, id
     ${lock ? 'FOR UPDATE' : ''}`,
    [organization.id],
  )
  if (pipelineResult.rowCount !== 1) {
    fail('AG Alchemy must have exactly one accessible CRM pipeline')
  }
  const pipeline = pipelineResult.rows[0]
  if (pipeline.sync_enabled || pipeline.sheet_id) {
    fail(
      'The AG Alchemy name reconciler does not support a Sheet-backed pipeline',
    )
  }
  return {
    organization,
    pipeline,
  }
}

const TARGET_PRODUCTS_SQL = `
  SELECT
    product.id::text AS product_id,
    product.reference_code AS product_global_id,
    product.pipeline_id::text,
    product.suitecrm_id,
    product.source_key,
    product.name AS current_name,
    product.sku,
    product.product_type,
    product.category,
    product.status,
    product.price::text,
    product.cost::text,
    product.currency,
    product.url,
    product.description,
    product.active,
    product.source_payload,
    product.source_hash AS product_source_hash,
    product.updated_at::text AS product_updated_at,
    account.provider,
    account.global_id AS account_global_id,
    mapping.id::text AS product_mapping_id,
    mapping.global_id AS mapping_global_id,
    mapping.external_product_id,
    mapping.external_variant_id,
    mapping.external_inventory_item_id,
    mapping.mapping_source_revision,
    candidate.id::text AS candidate_id,
    candidate.global_id AS candidate_global_id,
    candidate.product_title_snapshot,
    candidate.variant_title_snapshot,
    candidate.normalized_options,
    candidate.source_hash AS candidate_source_hash,
    candidate.source_revision AS candidate_source_revision
  FROM crm_products product
  JOIN operations_product_mappings mapping
    ON mapping.pipeline_id = product.pipeline_id
   AND mapping.product_id = product.id
   AND mapping.organization_id = $1::uuid
   AND mapping.active = true
  JOIN operations_integration_accounts account
    ON account.organization_id = mapping.organization_id
   AND account.id = mapping.integration_account_id
  JOIN operations_commerce_product_candidates candidate
    ON candidate.organization_id = mapping.organization_id
   AND candidate.integration_account_id = mapping.integration_account_id
   AND candidate.pipeline_id = product.pipeline_id
   AND candidate.product_id = product.id
   AND candidate.global_id = product.source_payload->>'candidateGlobalId'
  WHERE product.pipeline_id = $2::uuid
    AND product.source_payload->>'source' IN (
      'commerce_catalog_automatic_creation',
      'commerce_catalog_explicit_creation'
    )
  ORDER BY product.reference_code, mapping.global_id
`

function activeMappingSnapshot(row) {
  return {
    mapping_id: row.mapping_id,
    mapping_global_id: row.mapping_global_id,
    product_id: row.product_id,
    integration_account_id: row.integration_account_id,
    account_global_id: row.account_global_id,
    provider: row.provider,
    pipeline_id: row.pipeline_id,
    channel_sku: row.channel_sku,
    external_product_id: row.external_product_id,
    external_variant_id: row.external_variant_id,
    external_inventory_item_id: row.external_inventory_item_id,
    mapping_method: row.mapping_method,
    mapping_source_revision: row.mapping_source_revision,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function attachActiveMappingFences(targetRows, activeMappingRows) {
  const activeMappingsByProduct = new Map()
  for (const row of activeMappingRows) {
    const mappings = activeMappingsByProduct.get(row.product_id) || []
    mappings.push(activeMappingSnapshot(row))
    activeMappingsByProduct.set(row.product_id, mappings)
  }
  for (const mappings of activeMappingsByProduct.values()) {
    mappings.sort((left, right) => (
      `${left.provider}:${left.mapping_global_id}`
        .localeCompare(`${right.provider}:${right.mapping_global_id}`)
    ))
  }
  return targetRows.map((row) => {
    const productActiveMappings = activeMappingsByProduct.get(row.product_id)
      || []
    return {
      ...row,
      product_active_mappings: productActiveMappings,
      product_mapping_count: productActiveMappings.length,
    }
  })
}

async function loadNamePlan(client, target, lock = false) {
  if (lock) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`pipeline-catalog-products:${target.pipeline.id}`],
    )
  }
  const targetResult = await client.query(
    `${TARGET_PRODUCTS_SQL}${lock ? ' FOR UPDATE OF product, mapping, candidate' : ''}`,
    [target.organization.id, target.pipeline.id],
  )
  if (targetResult.rowCount < 1) {
    fail('AG Alchemy has no generated commerce products to reconcile')
  }
  const targetIds = [...new Set(
    targetResult.rows.map((row) => row.product_id),
  )]
  const activeMappings = await client.query(
    `SELECT
       mapping.id::text AS mapping_id,
       mapping.global_id AS mapping_global_id,
       mapping.product_id::text,
       mapping.integration_account_id::text,
       account.global_id AS account_global_id,
       account.provider,
       mapping.pipeline_id::text,
       mapping.channel_sku,
       mapping.external_product_id,
       mapping.external_variant_id,
       mapping.external_inventory_item_id,
       mapping.mapping_method,
       mapping.mapping_source_revision,
       mapping.active,
       mapping.created_at::text,
       mapping.updated_at::text
     FROM operations_product_mappings mapping
     JOIN operations_integration_accounts account
       ON account.organization_id = mapping.organization_id
      AND account.id = mapping.integration_account_id
     WHERE mapping.organization_id = $1::uuid
       AND mapping.pipeline_id = $2::uuid
       AND mapping.product_id = ANY($3::uuid[])
       AND mapping.active = true
     ORDER BY mapping.product_id, account.provider, mapping.global_id
     ${lock ? 'FOR UPDATE OF mapping' : ''}`,
    [target.organization.id, target.pipeline.id, targetIds],
  )
  const targetRows = attachActiveMappingFences(
    targetResult.rows,
    activeMappings.rows,
  )
  const reserved = await client.query(
    `SELECT reference_code, name
     FROM crm_products
     WHERE pipeline_id = $1::uuid
       AND NOT (id = ANY($2::uuid[]))
     ORDER BY reference_code
     ${lock ? 'FOR UPDATE' : ''}`,
    [target.pipeline.id, targetIds],
  )
  return buildNamePlan(targetRows, reserved.rows)
}

function preservationDigest(records) {
  return stableDigest(records.map((record) => ({
    productId: record.product_id,
    productGlobalId: record.product_global_id,
    suiteCrmId: record.suitecrm_id,
    sourceKey: record.source_key,
    sku: record.sku,
    provider: record.provider,
    accountGlobalId: record.account_global_id,
    mappingId: record.product_mapping_id,
    mappingGlobalId: record.mapping_global_id,
    externalProductId: record.external_product_id,
    externalVariantId: record.external_variant_id,
    externalInventoryItemId: record.external_inventory_item_id,
    mappingSourceRevision: record.mapping_source_revision,
    productActiveMappings: record.product_active_mappings,
    candidateId: record.candidate_id,
    candidateGlobalId: record.candidate_global_id,
    candidateSourceHash: record.candidate_source_hash,
    candidateSourceRevision: record.candidate_source_revision,
  })))
}

function crmProductFields(record, name) {
  return {
    name,
    sku: record.sku || undefined,
    productType: record.product_type || undefined,
    category: record.category || undefined,
    status: record.status || undefined,
    price: Number(record.price),
    cost: Number(record.cost),
    currency: record.currency,
    url: record.url || undefined,
    description: record.description || undefined,
    active: record.active,
  }
}

function suiteCrmProductPayload(record, name) {
  return {
    entity: 'products',
    pipelineId: record.pipeline_id,
    localId: record.product_id,
    suiteCrmId: record.suitecrm_id,
    attributes: {
      global_id_c: record.product_global_id,
      name,
      part_number: compact(record.sku),
      type: compact(record.product_type) || 'Good',
      category: compact(record.category),
      cost: Math.max(0, Number(record.cost) || 0),
      price: Math.max(0, Number(record.price) || 0),
      url: compact(record.url),
      description: compact(record.description),
    },
  }
}

async function queueSuiteCrmProduct(client, record, name, sourceHash) {
  const idempotencyKey =
    `crm:products:v4:${record.product_id}:default:${sourceHash}`
  const payload = suiteCrmProductPayload(record, name)
  const result = await client.query(
    `INSERT INTO sync_outbox (
       aggregate_type, aggregate_id, operation, target_system, payload,
       status, idempotency_key, created_at, available_at, updated_at
     ) VALUES (
       'crm_products', $1, 'upsert_record', 'suitecrm', $2::jsonb,
       'queued', $3, now(), now(), now()
     )
     ON CONFLICT (target_system, idempotency_key)
     WHERE idempotency_key IS NOT NULL
     DO UPDATE SET
       payload = EXCLUDED.payload,
       status = 'queued',
       attempts = 0,
       last_error = NULL,
       available_at = now(),
       processed_at = NULL,
       locked_at = NULL,
       lock_token = NULL,
       updated_at = now()
     WHERE sync_outbox.status IN ('succeeded', 'dead')
     RETURNING idempotency_key`,
    [
      record.product_id,
      JSON.stringify(payload),
      idempotencyKey,
    ],
  )
  if (result.rowCount !== 1) {
    fail(`SuiteCRM outbox could not be queued for ${record.product_global_id}`)
  }
  return idempotencyKey
}

async function refreshProductDropdown(client, target, appliedAt) {
  const current = await client.query(
    `SELECT catalog
     FROM pipeline_dropdown_catalogs
     WHERE pipeline_id = $1::uuid
     LIMIT 1
     FOR UPDATE`,
    [target.pipeline.id],
  )
  const products = await client.query(
    `SELECT name
     FROM crm_products
     WHERE pipeline_id = $1::uuid AND active = true
     ORDER BY lower(name), name, id`,
    [target.pipeline.id],
  )
  const seen = new Set()
  const names = products.rows.map((row) => compact(row.name)).filter((name) => {
    const key = comparable(name)
    if (!name || seen.has(key)) return false
    seen.add(key)
    return true
  })
  const original = current.rows[0]?.catalog
    && typeof current.rows[0].catalog === 'object'
    ? current.rows[0].catalog
    : {}
  const catalog = {
    ...original,
    syncedAt: appliedAt,
    source: 'app',
    dropdowns: {
      ...(original.dropdowns || {}),
      product: names.map((name, index) => ({
        value: name,
        label: name,
        active: true,
        sort_order: index,
      })),
    },
  }
  await client.query(
    `INSERT INTO pipeline_dropdown_catalogs (
       pipeline_id, catalog, source, updated_by, created_at, updated_at
     ) VALUES ($1::uuid, $2::jsonb, 'app', NULL, now(), now())
     ON CONFLICT (pipeline_id) DO UPDATE SET
       catalog = EXCLUDED.catalog,
       source = EXCLUDED.source,
       updated_by = NULL,
       updated_at = now()`,
    [
      target.pipeline.id,
      JSON.stringify(catalog),
    ],
  )
  await client.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = EXCLUDED.updated_at`,
    [
      `pipeline.dropdowns.current:${target.pipeline.id}`,
      JSON.stringify(catalog),
    ],
  )
  return names.length
}

export function requireExecutionConfirmation(value) {
  if (value !== EXECUTION_CONFIRMATION) {
    fail(`Apply requires confirmation ${EXECUTION_CONFIRMATION}`)
  }
}

async function applyPlan(
  client,
  target,
  plan,
  executionConfirmation,
) {
  requireExecutionConfirmation(executionConfirmation)
  if (plan.summary.blocked > 0) {
    fail('The product-name plan contains blocked rows and cannot be applied')
  }
  const appliedAt = new Date().toISOString()
  const renamed = plan.records.filter((record) => (
    record.action === 'rename'
  ))
  const beforeDigest = preservationDigest(plan.records)
  for (const record of renamed) {
    const temporaryName =
      `__commerce_name_reconcile__${record.product_global_id}`
    const temporary = await client.query(
      `UPDATE crm_products
       SET name = $2
       WHERE id = $1::uuid
         AND pipeline_id = $3::uuid
         AND name = $4
         AND source_hash = $5
         AND updated_at = $6::timestamptz
       RETURNING id::text`,
      [
        record.product_id,
        temporaryName,
        record.pipeline_id,
        record.current_name,
        record.product_source_hash,
        record.product_updated_at,
      ],
    )
    if (temporary.rowCount !== 1) {
      fail(`Product fence changed for ${record.product_global_id}`)
    }
  }

  for (const record of renamed) {
    const temporaryName =
      `__commerce_name_reconcile__${record.product_global_id}`
    const sourcePayload = {
      ...record.source_payload,
      nameReconciliation: {
        policyVersion: NAME_POLICY_VERSION,
        scriptVersion: SCRIPT_VERSION,
        source: 'creation_candidate_evidence',
        previousName: record.current_name,
        finalName: record.final_name,
        provider: record.provider,
        accountGlobalId: record.account_global_id,
        mappingGlobalId: record.mapping_global_id,
        candidateGlobalId: record.candidate_global_id,
        candidateSourceHash: record.candidate_source_hash,
        candidateSourceRevision: record.candidate_source_revision,
        appliedAt,
      },
    }
    const sourceHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        fields: crmProductFields(record, record.final_name),
        sourcePayload,
      }))
      .digest('hex')
    const updated = await client.query(
      `UPDATE crm_products
      SET name = $2,
           source_payload = $3::jsonb,
           source_hash = $4,
           sync_status = 'pending',
           sync_error = NULL,
           updated_by = NULL,
           updated_at = now()
       WHERE id = $1::uuid
         AND pipeline_id = $5::uuid
         AND name = $6
         AND source_hash = $7
         AND updated_at = $8::timestamptz
       RETURNING id::text`,
      [
        record.product_id,
        record.final_name,
        JSON.stringify(sourcePayload),
        sourceHash,
        record.pipeline_id,
        temporaryName,
        record.product_source_hash,
        record.product_updated_at,
      ],
    )
    if (updated.rowCount !== 1) {
      fail(`Final product update failed for ${record.product_global_id}`)
    }
    const outboxKey = await queueSuiteCrmProduct(
      client,
      record,
      record.final_name,
      sourceHash,
    )
    await client.query(
      `INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, payload,
         event_key, subject, organization_id, is_system
       ) VALUES (
        $1, 'commerce.catalog.product_name_reconciled',
         'crm_products', $2, $3::jsonb, $4, $5, $6::uuid, $7
       )
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      [
        SYSTEM_AUDIT_ATTRIBUTION.actor,
        record.product_id,
        JSON.stringify({
          productGlobalId: record.product_global_id,
          previousName: record.current_name,
          finalName: record.final_name,
          provider: record.provider,
          accountGlobalId: record.account_global_id,
          mappingGlobalId: record.mapping_global_id,
          candidateGlobalId: record.candidate_global_id,
          candidateSourceHash: record.candidate_source_hash,
          candidateSourceRevision: record.candidate_source_revision,
          namePolicyVersion: NAME_POLICY_VERSION,
          scriptVersion: SCRIPT_VERSION,
          executionActor: SYSTEM_ACTOR,
          suiteCrmOutboxKey: outboxKey,
          providerWrites: 0,
        }),
        `commerce-product-name:${record.product_global_id}:${
          NAME_POLICY_VERSION
        }:${sourceHash}`,
        record.final_name,
        target.organization.id,
        SYSTEM_AUDIT_ATTRIBUTION.isSystem,
      ],
    )
  }

  const dropdownProductCount = await refreshProductDropdown(
    client,
    target,
    appliedAt,
  )
  const afterPlan = await loadNamePlan(client, target, false)
  const afterDigest = preservationDigest(afterPlan.records)
  if (afterDigest !== beforeDigest) {
    fail('Product, mapping, or provider evidence identity changed during rename')
  }
  if (afterPlan.summary.rename !== 0 || afterPlan.summary.blocked !== 0) {
    fail('Product-name reconciliation postflight is not idempotent')
  }
  await client.query(
    `INSERT INTO audit_events (
       actor, event_type, aggregate_type, aggregate_id, payload,
       event_key, subject, organization_id, is_system
     ) VALUES (
       $1, 'commerce.catalog.product_name_reconciliation.completed',
       'workspace_organization', $2, $3::jsonb, $4, $5, $6::uuid, $7
     )
     ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    [
      SYSTEM_AUDIT_ATTRIBUTION.actor,
      target.organization.reference_code,
      JSON.stringify({
        planFingerprint: plan.fingerprint,
        renamedProducts: renamed.length,
        preservedManualNames: plan.summary.preserveManual,
        collisionGroups: plan.summary.collisionGroups,
        namePolicyVersion: NAME_POLICY_VERSION,
        scriptVersion: SCRIPT_VERSION,
        executionActor: SYSTEM_ACTOR,
        dropdownProductCount,
        providerWrites: 0,
        productIdentityDigest: beforeDigest,
      }),
      `commerce-product-name-reconciliation:${
        target.organization.reference_code
      }:${plan.fingerprint}`,
      TARGET_ORGANIZATION_NAME,
      target.organization.id,
      SYSTEM_AUDIT_ATTRIBUTION.isSystem,
    ],
  )
  return {
    applied: true,
    renamedProducts: renamed.length,
    dropdownProductCount,
    productIdentityDigest: beforeDigest,
  }
}

export async function run({
  apply = false,
  expectedPlanFingerprint = null,
  executionConfirmation = null,
  pool = null,
} = {}) {
  requireTrustedDevelopmentEnvironment()
  const databaseUrl = environmentValue('DATABASE_PUBLIC_URL')
    || environmentValue('DATABASE_URL')
  if (!databaseUrl) fail('DATABASE_PUBLIC_URL or DATABASE_URL is required')
  const normalizedDatabaseUrl = new URL(databaseUrl)
  normalizedDatabaseUrl.searchParams.delete('sslmode')
  const ownedPool = pool || new Pool({
    connectionString: normalizedDatabaseUrl.toString(),
    ssl: normalizedDatabaseUrl.hostname.endsWith('rlwy.net')
      ? { rejectUnauthorized: false }
      : undefined,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  })
  const client = await ownedPool.connect()
  try {
    await client.query(
      apply
        ? 'BEGIN ISOLATION LEVEL SERIALIZABLE'
        : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    )
    try {
      const database = await loadDatabaseIdentity(client)
      const target = await loadTarget(client, apply)
      const plan = await loadNamePlan(client, target, apply)
      if (
        apply
        && (
          !expectedPlanFingerprint
          || expectedPlanFingerprint !== plan.fingerprint
        )
      ) {
        fail(
          'Apply requires the exact current plan fingerprint from a fresh plan',
        )
      }
      const result = apply
        ? await applyPlan(
            client,
            target,
            plan,
            executionConfirmation,
          )
        : {
            applied: false,
            renamedProducts: 0,
            dropdownProductCount: null,
            productIdentityDigest: preservationDigest(plan.records),
          }
      if (apply) await client.query('COMMIT')
      else await client.query('ROLLBACK')
      return {
        ok: true,
        scriptVersion: SCRIPT_VERSION,
        namePolicyVersion: NAME_POLICY_VERSION,
        mode: apply ? 'apply' : 'plan',
        database: {
          fingerprint: database.database_fingerprint,
          trustedDevelopmentDatabase: true,
        },
        organization: {
          name: target.organization.name,
          referenceCode: target.organization.reference_code,
        },
        pipeline: {
          id: target.pipeline.id,
          name: target.pipeline.name,
          sheetBacked: false,
        },
        plan: {
          fingerprint: plan.fingerprint,
          ...plan.summary,
          sample: plan.records
            .filter((record) => record.action !== 'unchanged')
            .slice(0, 20)
            .map((record) => ({
              productGlobalId: record.product_global_id,
              provider: record.provider,
              action: record.action,
              currentName: record.current_name,
              finalName: record.final_name,
              candidateGlobalId: record.candidate_global_id,
              blockers: record.blockers,
            })),
        },
        result,
        providerWrites: 0,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  } finally {
    client.release()
    if (!pool) await ownedPool.end()
  }
}

function fixtureRow({
  productGlobalId,
  provider,
  currentName,
  productTitle,
  variantTitle,
  selectedOptions = [],
}) {
  const discriminator = stableDigest(productGlobalId).slice(0, 12)
  return {
    product_id: `11111111-1111-4111-8111-${discriminator}`,
    product_global_id: productGlobalId,
    pipeline_id: '22222222-2222-4222-8222-222222222222',
    suitecrm_id: `33333333-3333-4333-8333-${discriminator}`,
    source_key: `commerce:${productGlobalId}`,
    current_name: currentName,
    sku: null,
    product_type: 'Good',
    category: null,
    status: 'Active',
    price: '1.00',
    cost: '0.00',
    currency: 'USD',
    url: null,
    description: null,
    active: true,
    source_payload: {
      source: 'commerce_catalog_automatic_creation',
      integrationAccountGlobalId:
        provider === 'shopify' ? 'gia1111111' : 'gia2222222',
      candidateGlobalId:
        provider === 'shopify' ? `gcpc1${discriminator.slice(0, 6)}`
          : `gcpc2${discriminator.slice(0, 6)}`,
      providerSnapshot: {
        productTitle,
        variantTitle,
        sku: null,
        barcode: null,
      },
    },
    product_source_hash: stableDigest(`product:${productGlobalId}`),
    product_updated_at: '2026-07-28T12:00:00.000Z',
    provider,
    account_global_id:
      provider === 'shopify' ? 'gia1111111' : 'gia2222222',
    product_mapping_id: `44444444-4444-4444-8444-${discriminator}`,
    mapping_global_id:
      provider === 'shopify' ? `gpm1${discriminator.slice(0, 6)}`
        : `gpm2${discriminator.slice(0, 6)}`,
    external_product_id: `${provider}:product:${productGlobalId}`,
    external_variant_id: `${provider}:variant:${productGlobalId}`,
    external_inventory_item_id: null,
    mapping_source_revision: `revision:${productGlobalId}`,
    candidate_id: `55555555-5555-4555-8555-${discriminator}`,
    candidate_global_id:
      provider === 'shopify' ? `gcpc1${discriminator.slice(0, 6)}`
        : `gcpc2${discriminator.slice(0, 6)}`,
    product_title_snapshot: productTitle,
    variant_title_snapshot: variantTitle,
    normalized_options: selectedOptions,
    candidate_source_hash: stableDigest(`candidate:${productGlobalId}`),
    candidate_source_revision: `revision:${productGlobalId}`,
    product_mapping_count: 1,
    product_active_mappings: [{
      mapping_id: `44444444-4444-4444-8444-${discriminator}`,
      mapping_global_id:
        provider === 'shopify' ? `gpm1${discriminator.slice(0, 6)}`
          : `gpm2${discriminator.slice(0, 6)}`,
      product_id: `11111111-1111-4111-8111-${discriminator}`,
      integration_account_id: `66666666-6666-4666-8666-${discriminator}`,
      account_global_id:
        provider === 'shopify' ? 'gia1111111' : 'gia2222222',
      provider,
      pipeline_id: '22222222-2222-4222-8222-222222222222',
      channel_sku: null,
      external_product_id: `${provider}:product:${productGlobalId}`,
      external_variant_id: `${provider}:variant:${productGlobalId}`,
      external_inventory_item_id: null,
      mapping_method: 'product_created',
      mapping_source_revision: `revision:${productGlobalId}`,
      active: true,
      created_at: '2026-07-28T12:00:00.000Z',
      updated_at: '2026-07-28T12:00:00.000Z',
    }],
  }
}

export function selfTest() {
  const rows = [
    fixtureRow({
      productGlobalId: 'gp1111111',
      provider: 'shopify',
      currentName:
        'Apple Crisp 10lb · Apple Crisp 10lb - Default Title',
      productTitle: 'Apple Crisp 10lb',
      variantTitle: 'Apple Crisp 10lb - Default Title',
      selectedOptions: [{ name: 'Title', value: 'Default Title' }],
    }),
    fixtureRow({
      productGlobalId: 'gp2222222',
      provider: 'faire',
      currentName: 'Apple Crisp 10lb · default',
      productTitle: 'Apple Crisp 10lb',
      variantTitle: 'default',
    }),
    fixtureRow({
      productGlobalId: 'gp3333333',
      provider: 'shopify',
      currentName: 'Kids Shirt · Kids Shirt - Medium',
      productTitle: 'Kids Shirt',
      variantTitle: 'Kids Shirt - Medium',
      selectedOptions: [{ name: 'Size', value: 'Medium' }],
    }),
    fixtureRow({
      productGlobalId: 'gp4444444',
      provider: 'shopify',
      currentName: 'Operator Custom Name',
      productTitle: 'Manual Product',
      variantTitle: 'Default Title',
      selectedOptions: [{ name: 'Title', value: 'Default Title' }],
    }),
  ]
  const plan = buildNamePlan(rows)
  const byGlobalId = new Map(plan.records.map((record) => (
    [record.product_global_id, record]
  )))
  if (
    plan.summary.rename !== 3
    || plan.summary.preserveManual !== 1
    || plan.summary.blocked !== 0
    || plan.summary.collisionGroups !== 1
    || byGlobalId.get('gp1111111')?.final_name
      !== 'Apple Crisp 10lb · Shopify'
    || byGlobalId.get('gp2222222')?.final_name
      !== 'Apple Crisp 10lb · Faire'
    || byGlobalId.get('gp3333333')?.final_name
      !== 'Kids Shirt · Medium'
    || byGlobalId.get('gp4444444')?.action !== 'preserve_manual'
  ) {
    fail('Collision-aware product-name plan self-test failed')
  }
  if (
    commerceProductDisplayName({
      productTitle: 'Tea',
      variantTitle: 'Team Size',
    }) !== 'Tea · Team Size'
  ) {
    fail('Product-title prefix boundary self-test failed')
  }
  if (plan.fingerprint !== buildNamePlan(rows).fingerprint) {
    fail('Product-name plan fingerprint must be deterministic')
  }
  const mergedProduct = rows[0]
  const mergedMappings = attachActiveMappingFences(
    [mergedProduct],
    [
      ...mergedProduct.product_active_mappings,
      {
        ...mergedProduct.product_active_mappings[0],
        mapping_id: '77777777-7777-4777-8777-777777777777',
        mapping_global_id: 'gpm7777777',
        integration_account_id: '88888888-8888-4888-8888-888888888888',
        account_global_id: 'gia2222222',
        provider: 'faire',
        external_product_id: 'faire:product:merged',
        external_variant_id: 'faire:variant:merged',
      },
    ],
  )
  const mergedPlan = buildNamePlan(mergedMappings)
  if (
    mergedPlan.summary.blocked !== 1
    || !mergedPlan.records[0]?.blockers.includes(
      'product_mapping_cardinality_changed',
    )
  ) {
    fail('Cross-provider merged product mapping fence self-test failed')
  }
  let confirmationRejected = false
  try {
    requireExecutionConfirmation('not-confirmed')
  } catch {
    confirmationRejected = true
  }
  if (!confirmationRejected) {
    fail('Apply confirmation boundary self-test failed')
  }
  requireExecutionConfirmation(EXECUTION_CONFIRMATION)
  if (
    SYSTEM_AUDIT_ATTRIBUTION.actor !== 'system'
    || SYSTEM_AUDIT_ATTRIBUTION.isSystem !== true
  ) {
    fail('System audit attribution self-test failed')
  }
  return {
    ok: true,
    scriptVersion: SCRIPT_VERSION,
    namePolicyVersion: NAME_POLICY_VERSION,
    summary: plan.summary,
  }
}

function argumentValue(name) {
  return process.argv.find((value) => (
    value.startsWith(`--${name}=`)
  ))?.slice(name.length + 3) || null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) {
    console.log(JSON.stringify(selfTest(), null, 2))
  } else {
    const apply = process.argv.includes('--apply')
    const expectedPlanFingerprint = argumentValue('plan-fingerprint')
    const confirmation = argumentValue('confirm')
    if (apply) {
      if (confirmation !== EXECUTION_CONFIRMATION) {
        fail(`Apply requires --confirm=${EXECUTION_CONFIRMATION}`)
      }
      if (!/^[a-f0-9]{64}$/.test(expectedPlanFingerprint || '')) {
        fail('Apply requires --plan-fingerprint=<64 lowercase hex characters>')
      }
    }
    const result = await run({
      apply,
      expectedPlanFingerprint,
      executionConfirmation: confirmation,
    })
    console.log(JSON.stringify(result, null, 2))
  }
}
