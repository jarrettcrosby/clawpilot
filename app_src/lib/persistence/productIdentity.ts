import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  stageCrmRecordWithClient,
} from '@/lib/persistence/crm'
import {
  syncPipelineProductDropdownCatalogInPostgres,
} from '@/lib/persistence/pipeline'
import { query, withTransaction } from '@/lib/persistence/postgres'

export type ProductIdentityEvidenceType =
  | 'exact_sku'
  | 'exact_gtin'
  | 'exact_barcode'
  | 'operator_confirmed'

export type ProductIdentityPackProfileEvidence = {
  profileGlobalId: string
  profileName: string
  packageLevel: 'each' | 'inner_pack' | 'case' | 'pallet'
  baseEachQuantity: number | null
  dimensionsMm: {
    length: number
    width: number
    height: number
  } | null
  dimensionBasis: 'inner' | 'outer' | 'unspecified' | null
  lifecycleState: string | null
  evidenceType: string | null
}

export type ProductIdentityPackEvidence = {
  status: 'known' | 'unknown'
  profiles: ProductIdentityPackProfileEvidence[]
}

export type ProductIdentitySuggestion = {
  key: string
  displayName: string
  confidence: 'identifier_match' | 'operator_review'
  evidenceType: ProductIdentityEvidenceType
  evidenceValues: string[]
  canonical: ProductIdentityRecord
  duplicate: ProductIdentityRecord
  canApply: boolean
  blockers: string[]
}

export type ProductIdentityRecord = {
  id: string
  globalId: string
  name: string
  sku: string | null
  sourceHash: string
  updatedAt: string
  providers: Array<'shopify' | 'faire'>
  mappingGlobalIds: string[]
  channelSkus: string[]
  barcodes: string[]
  packEvidence: ProductIdentityPackEvidence
  operationalReferenceCount: number
}

type ProductIdentityAggregate = ProductIdentityRecord & {
  requestedName: string
}

type ProductIdentityRow = {
  id: string
  reference_code: string
  name: string
  sku: string | null
  source_hash: string
  source_payload: Record<string, unknown> | null
  updated_at: string
  provider: 'shopify' | 'faire'
  mapping_global_id: string
  channel_sku: string | null
  barcode_snapshot: string | null
  inventory_positions: string
  inventory_levels: string
  order_lines: string
  receipt_lines: string
  opportunity_products: string
  location_product_rules: string
  replenishment_tasks: string
  legacy_pack_profiles: string
  pack_profiles: string
  pack_profile_evidence: unknown
}

type LockedProductRow = {
  id: string
  reference_code: string
  pipeline_id: string
  source_key: string
  suitecrm_id: string | null
  name: string
  sku: string | null
  product_type: string
  category: string | null
  status: string
  price: string
  cost: string
  currency: string
  url: string | null
  description: string
  active: boolean
  source_payload: Record<string, unknown> | null
  source_hash: string
  updated_at: string
}

type ActiveMappingRow = {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  pipeline_id: string
  channel_sku: string | null
  external_product_id: string | null
  external_variant_id: string
  external_inventory_item_id: string | null
  mapping_source_revision: string | null
}

type LatestMappingCandidateRow = {
  product_id: string
  mapping_global_id: string
  candidate_global_id: string | null
  barcode_snapshot: string | null
  source_revision: string | null
  source_hash: string | null
}

type ExistingAliasRow = {
  global_id: string
  canonical_product_id: string
  evidence: Record<string, unknown>
}

function clean(value: unknown) {
  return String(value ?? '').trim()
}

function cleanOptional(value: unknown) {
  const normalized = clean(value)
  return normalized || null
}

function normalizedIdentifier(value: unknown) {
  return clean(value).toLocaleLowerCase('en-US')
}

function isValidGtin(value: unknown) {
  const digits = clean(value)
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) {
    return false
  }
  const body = digits.slice(0, -1)
  const checkDigit = Number(digits.at(-1))
  const sum = [...body].reverse().reduce((total, digit, index) => (
    total + Number(digit) * (index % 2 === 0 ? 3 : 1)
  ), 0)
  return (10 - (sum % 10)) % 10 === checkDigit
}

function normalizedDisplayName(value: unknown) {
  return clean(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function requestedProductName(row: ProductIdentityRow) {
  const payload = row.source_payload
  const localCatalog = payload && typeof payload === 'object'
    ? payload.localCatalog
    : null
  if (localCatalog && typeof localCatalog === 'object') {
    const requested = clean(
      (localCatalog as Record<string, unknown>).requestedName,
    )
    if (requested) return requested
  }
  return row.name.replace(
    /\s+·\s+(?:Shopify|Faire)(?:\s+·\s+[a-f0-9]+)?$/iu,
    '',
  ).trim()
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.map(clean).filter(Boolean))]
}

function number(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function productPackEvidence(
  value: unknown,
): ProductIdentityPackEvidence {
  if (!Array.isArray(value) || value.length === 0) {
    return { status: 'unknown', profiles: [] }
  }
  const profiles = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const row = candidate as Record<string, unknown>
    const packageLevel = clean(row.packageLevel)
    if (!['each', 'inner_pack', 'case', 'pallet'].includes(packageLevel)) {
      return []
    }
    const length = Number(row.lengthMm)
    const width = Number(row.widthMm)
    const height = Number(row.heightMm)
    const dimensionsMm = (
      Number.isFinite(length)
      && length > 0
      && Number.isFinite(width)
      && width > 0
      && Number.isFinite(height)
      && height > 0
    )
      ? { length, width, height }
      : null
    const baseEachQuantity = Number(row.baseEachQuantity)
    return [{
      profileGlobalId: clean(row.profileGlobalId),
      profileName: clean(row.profileName) || 'Unnamed pack profile',
      packageLevel:
        packageLevel as ProductIdentityPackProfileEvidence['packageLevel'],
      baseEachQuantity: Number.isInteger(baseEachQuantity)
        && baseEachQuantity > 0
        ? baseEachQuantity
        : null,
      dimensionsMm,
      dimensionBasis: (
        ['inner', 'outer', 'unspecified'].includes(clean(row.dimensionBasis))
          ? clean(row.dimensionBasis)
          : null
      ) as ProductIdentityPackProfileEvidence['dimensionBasis'],
      lifecycleState: cleanOptional(row.lifecycleState),
      evidenceType: cleanOptional(row.evidenceType),
    }]
  })
  return profiles.length > 0
    ? { status: 'known', profiles }
    : { status: 'unknown', profiles: [] }
}

function normalizedIdentifierSet(values: Array<string | null | undefined>) {
  return unique(values)
    .map(normalizedIdentifier)
    .filter(Boolean)
    .sort()
}

function knownIdentifiersConflict(
  left: Array<string | null | undefined>,
  right: Array<string | null | undefined>,
) {
  const normalizedLeft = normalizedIdentifierSet(left)
  const normalizedRight = normalizedIdentifierSet(right)
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return false
  }
  return normalizedLeft.length !== normalizedRight.length
    || normalizedLeft.some((value, index) => (
      value !== normalizedRight[index]
    ))
}

function sameIdentifierSet(left: string[], right: string[]) {
  const normalizedLeft = [...new Set(left.map(clean).filter(Boolean))].sort()
  const normalizedRight = [...new Set(right.map(clean).filter(Boolean))].sort()
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => (
      value === normalizedRight[index]
    ))
}

export function archivedProductIdentityName(input: {
  originalName: string
  duplicateGlobalId: string
}) {
  const suffix = ` · Merged · ${clean(input.duplicateGlobalId)}`
  const base = clean(input.originalName) || 'Product'
  return `${base.slice(0, Math.max(1, 500 - suffix.length)).trim()}${suffix}`
}

function stableKey(input: {
  pipelineId: string
  canonicalGlobalId: string
  duplicateGlobalId: string
}) {
  return createHash('sha256')
    .update('clawpilot:crm-product-identity:v1')
    .update('\0')
    .update(input.pipelineId)
    .update('\0')
    .update(input.canonicalGlobalId)
    .update('\0')
    .update(input.duplicateGlobalId)
    .digest('hex')
}

function productReferenceCount(row: ProductIdentityRow) {
  return number(row.inventory_positions)
    + number(row.inventory_levels)
    + number(row.order_lines)
    + number(row.receipt_lines)
    + number(row.opportunity_products)
    + number(row.location_product_rules)
    + number(row.replenishment_tasks)
    + number(row.legacy_pack_profiles)
    + number(row.pack_profiles)
}

function buildProductRecords(rows: ProductIdentityRow[]) {
  const records = new Map<string, ProductIdentityAggregate>()
  for (const row of rows) {
    const current = records.get(row.id) || {
      id: row.id,
      globalId: row.reference_code,
      name: row.name,
      requestedName: requestedProductName(row),
      sku: cleanOptional(row.sku),
      sourceHash: row.source_hash,
      updatedAt: new Date(row.updated_at).toISOString(),
      providers: [],
      mappingGlobalIds: [],
      channelSkus: [],
      barcodes: [],
      packEvidence: productPackEvidence(row.pack_profile_evidence),
      operationalReferenceCount: productReferenceCount(row),
    }
    current.providers = [
      ...new Set([...current.providers, row.provider]),
    ]
    current.mappingGlobalIds = unique([
      ...current.mappingGlobalIds,
      row.mapping_global_id,
    ])
    current.channelSkus = unique([
      ...current.channelSkus,
      row.channel_sku,
    ])
    current.barcodes = unique([
      ...current.barcodes,
      row.barcode_snapshot,
    ])
    current.operationalReferenceCount = Math.max(
      current.operationalReferenceCount,
      productReferenceCount(row),
    )
    records.set(row.id, current)
  }
  return [...records.values()]
}

function identifierIntersection(
  left: Array<string | null | undefined>,
  right: Array<string | null | undefined>,
) {
  const normalizedRight = new Set(
    right.map(normalizedIdentifier).filter(Boolean),
  )
  return unique(left.filter((value) => (
    normalizedRight.has(normalizedIdentifier(value))
  )))
}

function preferredCanonical(
  left: ProductIdentityAggregate,
  right: ProductIdentityAggregate,
) {
  if (
    left.operationalReferenceCount
    !== right.operationalReferenceCount
  ) {
    return left.operationalReferenceCount > right.operationalReferenceCount
      ? left
      : right
  }
  if (
    left.providers.includes('shopify')
    !== right.providers.includes('shopify')
  ) {
    return left.providers.includes('shopify') ? left : right
  }
  return left.globalId.localeCompare(right.globalId) <= 0 ? left : right
}

async function productIdentityRows(pipelineId: string) {
  const result = await query<ProductIdentityRow>(
    `SELECT
       product.id::text,
       product.reference_code,
       product.name,
       product.sku,
       product.source_hash,
       product.source_payload,
       product.updated_at::text,
       account.provider,
       mapping.global_id AS mapping_global_id,
       mapping.channel_sku,
       latest_candidate.barcode_snapshot,
       (
         SELECT count(*)::text
         FROM operations_inventory_positions position
         WHERE position.pipeline_id = product.pipeline_id
           AND position.product_id = product.id
       ) AS inventory_positions,
       (
         SELECT count(*)::text
         FROM operations_commerce_inventory_levels level
         WHERE level.pipeline_id = product.pipeline_id
           AND level.product_id = product.id
       ) AS inventory_levels,
       (
         SELECT count(*)::text
         FROM operations_current_order_lines line
         WHERE line.pipeline_id = product.pipeline_id
           AND line.product_id = product.id
       ) AS order_lines,
       (
         SELECT count(*)::text
         FROM operations_receipt_lines line
         WHERE line.pipeline_id = product.pipeline_id
           AND line.product_id = product.id
       ) AS receipt_lines,
       (
         SELECT count(*)::text
         FROM crm_opportunity_products relation
         WHERE relation.pipeline_id = product.pipeline_id
           AND relation.product_id = product.id
       ) AS opportunity_products,
       (
         SELECT count(*)::text
         FROM operations_location_product_rules rule
         WHERE rule.pipeline_id = product.pipeline_id
           AND rule.product_id = product.id
       ) AS location_product_rules,
       (
         SELECT count(*)::text
         FROM operations_replenishment_tasks task
         WHERE task.pipeline_id = product.pipeline_id
           AND task.product_id = product.id
       ) AS replenishment_tasks,
       (
         SELECT count(*)::text
         FROM operations_product_package_profiles profile
         WHERE profile.pipeline_id = product.pipeline_id
           AND profile.product_id = product.id
       ) AS legacy_pack_profiles,
       (
         SELECT count(*)::text
         FROM operations_product_pack_profiles profile
         WHERE profile.pipeline_id = product.pipeline_id
           AND profile.product_id = product.id
       ) AS pack_profiles,
       COALESCE((
         SELECT jsonb_agg(
           jsonb_build_object(
             'profileGlobalId', profile.global_id,
             'profileName', profile.profile_name,
             'packageLevel', profile.package_level,
             'baseEachQuantity', version.base_each_quantity,
             'lengthMm', version.length_mm,
             'widthMm', version.width_mm,
             'heightMm', version.height_mm,
             'dimensionBasis', version.dimension_basis,
             'lifecycleState', version.lifecycle_state,
             'evidenceType', version.evidence_type
           )
           ORDER BY
             profile.package_level,
             profile.profile_key,
             profile.id
         )
         FROM operations_product_pack_profiles AS profile
         LEFT JOIN LATERAL (
           SELECT
             current_version.base_each_quantity,
             current_version.length_mm,
             current_version.width_mm,
             current_version.height_mm,
             current_version.dimension_basis,
             current_version.lifecycle_state,
             current_version.evidence_type
           FROM operations_product_pack_profile_versions AS current_version
           WHERE current_version.organization_id = profile.organization_id
             AND current_version.pipeline_id = profile.pipeline_id
             AND current_version.product_id = profile.product_id
             AND current_version.profile_id = profile.id
             AND current_version.is_current = true
           ORDER BY
             current_version.version_number DESC,
             current_version.id DESC
           LIMIT 1
         ) AS version ON true
         WHERE profile.pipeline_id = product.pipeline_id
           AND profile.product_id = product.id
           AND profile.status <> 'retired'
       ), '[]'::jsonb) AS pack_profile_evidence
     FROM crm_products AS product
     JOIN operations_product_mappings AS mapping
       ON mapping.pipeline_id = product.pipeline_id
      AND mapping.product_id = product.id
      AND mapping.active = true
      AND mapping.external_variant_id IS NOT NULL
     JOIN operations_integration_accounts AS account
       ON account.organization_id = mapping.organization_id
      AND account.id = mapping.integration_account_id
     LEFT JOIN LATERAL (
       SELECT candidate.barcode_snapshot
       FROM operations_commerce_product_candidates AS candidate
       WHERE candidate.organization_id = mapping.organization_id
         AND candidate.integration_account_id =
           mapping.integration_account_id
         AND candidate.pipeline_id = mapping.pipeline_id
         AND candidate.external_variant_id = mapping.external_variant_id
       ORDER BY
         candidate.provider_updated_at DESC NULLS LAST,
         candidate.observed_at DESC,
         candidate.created_at DESC,
         candidate.id DESC
       LIMIT 1
     ) AS latest_candidate ON true
     WHERE product.pipeline_id = $1::uuid
       AND product.active = true
       AND COALESCE(
         lower(product.source_payload->>'archived'),
         'false'
       ) NOT IN ('true', '1', 'yes')
       AND NOT EXISTS (
         SELECT 1
         FROM crm_product_identity_aliases alias
         WHERE alias.pipeline_id = product.pipeline_id
           AND alias.alias_product_id = product.id
       )
     ORDER BY lower(product.name), product.id, account.provider`,
    [pipelineId],
  )
  return result.rows
}

function crossProviderIdentityPair(
  left: ProductIdentityAggregate,
  right: ProductIdentityAggregate,
) {
  return (
    left.providers.includes('shopify')
    && right.providers.includes('faire')
  ) || (
    left.providers.includes('faire')
    && right.providers.includes('shopify')
  )
}

function productIdentityPairKey(
  left: ProductIdentityAggregate,
  right: ProductIdentityAggregate,
) {
  return [left.id, right.id].sort().join(':')
}

export function buildProductIdentitySuggestions(input: {
  pipelineId: string
  records: ProductIdentityAggregate[]
}) {
  const records = input.records
  const groups = new Map<string, typeof records>()
  for (const record of records) {
    const key = normalizedDisplayName(record.requestedName)
    if (!key) continue
    groups.set(key, [...(groups.get(key) || []), record])
  }
  const pairs = new Map<
    string,
    [ProductIdentityAggregate, ProductIdentityAggregate]
  >()
  const registerPair = (
    left: ProductIdentityAggregate,
    right: ProductIdentityAggregate,
  ) => {
    if (left.id === right.id || !crossProviderIdentityPair(left, right)) {
      return
    }
    const ordered = left.id.localeCompare(right.id) <= 0
      ? [left, right] as [
          ProductIdentityAggregate,
          ProductIdentityAggregate,
        ]
      : [right, left] as [
          ProductIdentityAggregate,
          ProductIdentityAggregate,
        ]
    pairs.set(productIdentityPairKey(left, right), ordered)
  }
  const suggestions: ProductIdentitySuggestion[] = []
  for (const group of groups.values()) {
    const shopify = group.filter((record) => (
      record.providers.includes('shopify')
    ))
    const faire = group.filter((record) => (
      record.providers.includes('faire')
    ))
    if (shopify.length !== 1 || faire.length !== 1) continue
    registerPair(shopify[0], faire[0])
  }

  const exactIdentityGroups = new Map<string, typeof records>()
  for (const record of records) {
    for (const sku of normalizedIdentifierSet([
      record.sku,
      ...record.channelSkus,
    ])) {
      const key = `sku:${sku}`
      exactIdentityGroups.set(
        key,
        [...(exactIdentityGroups.get(key) || []), record],
      )
    }
    for (const barcode of normalizedIdentifierSet(record.barcodes)) {
      const key = `barcode:${barcode}`
      exactIdentityGroups.set(
        key,
        [...(exactIdentityGroups.get(key) || []), record],
      )
    }
  }
  const ambiguousExactIdentityProductIds = new Set<string>()
  for (const group of exactIdentityGroups.values()) {
    const uniqueProducts = [
      ...new Map(group.map((record) => [record.id, record])).values(),
    ]
    const shopify = uniqueProducts.filter((record) => (
      record.providers.includes('shopify')
    ))
    const faire = uniqueProducts.filter((record) => (
      record.providers.includes('faire')
    ))
    if (
      uniqueProducts.length === 2
      && shopify.length === 1
      && faire.length === 1
      && shopify[0].id !== faire[0].id
    ) {
      registerPair(shopify[0], faire[0])
      continue
    }
    if (shopify.length > 0 && faire.length > 0) {
      for (const record of uniqueProducts) {
        ambiguousExactIdentityProductIds.add(record.id)
      }
    }
  }

  for (const [left, right] of pairs.values()) {
    const canonical = preferredCanonical(left, right)
    const duplicate = canonical.id === left.id ? right : left
    const skuMatches = identifierIntersection(
      [canonical.sku, ...canonical.channelSkus],
      [duplicate.sku, ...duplicate.channelSkus],
    )
    const barcodeMatches = identifierIntersection(
      canonical.barcodes,
      duplicate.barcodes,
    )
    const gtinMatches = barcodeMatches.filter(isValidGtin)
    const conflictingBarcodes = knownIdentifiersConflict(
      canonical.barcodes,
      duplicate.barcodes,
    )
    const evidenceType: ProductIdentityEvidenceType = skuMatches.length > 0
      ? 'exact_sku'
      : gtinMatches.length > 0
        ? 'exact_gtin'
        : barcodeMatches.length > 0
          ? 'exact_barcode'
        : 'operator_confirmed'
    const blockers = [
      ...(duplicate.operationalReferenceCount > 0
        ? ['duplicate_has_operational_references']
        : []),
      ...(conflictingBarcodes
        ? ['conflicting_barcodes']
        : []),
      ...(
        ambiguousExactIdentityProductIds.has(canonical.id)
        || ambiguousExactIdentityProductIds.has(duplicate.id)
          ? ['ambiguous_exact_identifier']
          : []
      ),
    ]
    const canonicalRecord = { ...canonical }
    const duplicateRecord = { ...duplicate }
    delete (canonicalRecord as Partial<ProductIdentityAggregate>)
      .requestedName
    delete (duplicateRecord as Partial<ProductIdentityAggregate>)
      .requestedName
    suggestions.push({
      key: stableKey({
        pipelineId: input.pipelineId,
        canonicalGlobalId: canonical.globalId,
        duplicateGlobalId: duplicate.globalId,
      }),
      displayName: canonical.requestedName,
      confidence: evidenceType === 'operator_confirmed'
        ? 'operator_review'
        : 'identifier_match',
      evidenceType,
      evidenceValues: evidenceType === 'exact_sku'
        ? skuMatches
        : evidenceType === 'exact_gtin'
          ? gtinMatches
        : evidenceType === 'exact_barcode'
          ? barcodeMatches
          : [],
      canonical: canonicalRecord,
      duplicate: duplicateRecord,
      canApply: blockers.length === 0,
      blockers,
    })
  }
  return suggestions.sort((left, right) => (
    left.displayName.localeCompare(right.displayName)
  ))
}

export async function listProductIdentitySuggestionsInPostgres(input: {
  pipelineId: string
}) {
  return buildProductIdentitySuggestions({
    pipelineId: input.pipelineId,
    records: buildProductRecords(
      await productIdentityRows(input.pipelineId),
    ),
  })
}

function sourceHash(input: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
}

function productFields(row: LockedProductRow, input: {
  name: string
  sku: string | null
}) {
  return {
    name: input.name,
    ...(input.sku ? { sku: input.sku } : {}),
    productType: row.product_type,
    ...(row.category ? { category: row.category } : {}),
    status: row.status,
    price: Number(row.price),
    cost: Number(row.cost),
    currency: row.currency,
    ...(row.url ? { url: row.url } : {}),
    description: row.description,
    active: row.active,
  }
}

async function queueSuiteCrmDelete(
  client: PoolClient,
  input: {
    product: LockedProductRow
    actorEmail: string
  },
) {
  await client.query(
    `UPDATE sync_outbox
     SET status = 'dead',
         last_error =
           'Cancelled before duplicate product identity deletion',
         processed_at = now(),
         locked_at = NULL,
         lock_token = NULL,
         updated_at = now()
     WHERE target_system = 'suitecrm'
       AND aggregate_type = 'crm_products'
       AND aggregate_id = $1
       AND operation = 'upsert_record'
       AND status IN ('queued', 'failed')`,
    [input.product.id],
  )
  if (!input.product.suitecrm_id) return null
  const idempotencyKey =
    `crm-product-identity-delete:v1:${input.product.id}`
  const payload = {
    entity: 'products',
    pipelineId: input.product.pipeline_id,
    localId: input.product.id,
    suiteCrmId: input.product.suitecrm_id,
    attributes: {},
  }
  const queued = await client.query<{ idempotency_key: string }>(
    `INSERT INTO sync_outbox (
       aggregate_type, aggregate_id, operation, target_system, payload,
       status, idempotency_key, attempts, created_at, available_at,
       updated_at
     ) VALUES (
       'crm_products', $1, 'delete_record', 'suitecrm', $2::jsonb,
       'queued', $3, 0, now(), now(), now()
     )
     ON CONFLICT (target_system, idempotency_key)
     WHERE idempotency_key IS NOT NULL
     DO UPDATE SET
       payload = CASE
         WHEN sync_outbox.status IN ('queued', 'failed')
           THEN EXCLUDED.payload
         ELSE sync_outbox.payload
       END,
       status = CASE
         WHEN sync_outbox.status IN ('queued', 'failed') THEN 'queued'
         ELSE sync_outbox.status
       END,
       attempts = CASE
         WHEN sync_outbox.status IN ('queued', 'failed') THEN 0
         ELSE sync_outbox.attempts
       END,
       last_error = CASE
         WHEN sync_outbox.status IN ('queued', 'failed') THEN NULL
         ELSE sync_outbox.last_error
       END,
       available_at = CASE
         WHEN sync_outbox.status IN ('queued', 'failed') THEN now()
         ELSE sync_outbox.available_at
       END,
       processed_at = CASE
         WHEN sync_outbox.status IN ('queued', 'failed') THEN NULL
         ELSE sync_outbox.processed_at
       END,
       locked_at = CASE
         WHEN sync_outbox.status IN ('queued', 'failed') THEN NULL
         ELSE sync_outbox.locked_at
       END,
       lock_token = CASE
         WHEN sync_outbox.status IN ('queued', 'failed') THEN NULL
         ELSE sync_outbox.lock_token
       END,
       updated_at = CASE
         WHEN sync_outbox.status IN ('queued', 'failed') THEN now()
         ELSE sync_outbox.updated_at
       END
     RETURNING idempotency_key`,
    [input.product.id, JSON.stringify(payload), idempotencyKey],
  )
  return queued.rows[0]?.idempotency_key || null
}

async function readLockedProducts(
  client: PoolClient,
  input: {
    pipelineId: string
    canonicalGlobalId: string
    duplicateGlobalId: string
  },
) {
  const result = await client.query<LockedProductRow>(
    `SELECT
       id::text, reference_code, pipeline_id::text, source_key,
       suitecrm_id, name, sku, product_type, category, status,
       price::text, cost::text, currency, url, description, active,
       source_payload, source_hash, updated_at::text
     FROM crm_products
     WHERE pipeline_id = $1::uuid
       AND reference_code = ANY($2::text[])
     ORDER BY reference_code
     FOR UPDATE`,
    [
      input.pipelineId,
      [input.canonicalGlobalId, input.duplicateGlobalId],
    ],
  )
  const canonical = result.rows.find((row) => (
    row.reference_code === input.canonicalGlobalId
  ))
  const duplicate = result.rows.find((row) => (
    row.reference_code === input.duplicateGlobalId
  ))
  if (!canonical || !duplicate) {
    throw new Error('Product identity records changed; reload the review')
  }
  return { canonical, duplicate }
}

async function duplicateOperationalReferenceCount(
  client: PoolClient,
  product: LockedProductRow,
) {
  const result = await client.query<{ reference_count: string }>(
    `SELECT (
       (SELECT count(*) FROM operations_inventory_positions
         WHERE pipeline_id = $1::uuid AND product_id = $2::uuid)
       + (SELECT count(*) FROM operations_commerce_inventory_levels
         WHERE pipeline_id = $1::uuid AND product_id = $2::uuid)
       + (SELECT count(*) FROM operations_current_order_lines
         WHERE pipeline_id = $1::uuid AND product_id = $2::uuid)
       + (SELECT count(*) FROM operations_receipt_lines
         WHERE pipeline_id = $1::uuid AND product_id = $2::uuid)
       + (SELECT count(*) FROM crm_opportunity_products
         WHERE pipeline_id = $1::uuid AND product_id = $2::uuid)
       + (SELECT count(*) FROM operations_location_product_rules
         WHERE pipeline_id = $1::uuid AND product_id = $2::uuid)
       + (SELECT count(*) FROM operations_replenishment_tasks
         WHERE pipeline_id = $1::uuid AND product_id = $2::uuid)
       + (SELECT count(*) FROM operations_product_package_profiles
         WHERE pipeline_id = $1::uuid AND product_id = $2::uuid)
       + (SELECT count(*) FROM operations_product_pack_profiles
         WHERE pipeline_id = $1::uuid AND product_id = $2::uuid)
     )::text AS reference_count`,
    [product.pipeline_id, product.id],
  )
  return Number(result.rows[0]?.reference_count || 0)
}

async function activeProductMappings(
  client: PoolClient,
  product: LockedProductRow,
) {
  const result = await client.query<ActiveMappingRow>(
    `SELECT
       id::text, global_id, organization_id::text,
       integration_account_id::text, pipeline_id::text, channel_sku,
       external_product_id, external_variant_id,
       external_inventory_item_id, mapping_source_revision
     FROM operations_product_mappings
     WHERE pipeline_id = $1::uuid
       AND product_id = $2::uuid
       AND active = true
       AND external_variant_id IS NOT NULL
     ORDER BY integration_account_id, external_variant_id
     FOR UPDATE`,
    [product.pipeline_id, product.id],
  )
  return result.rows
}

async function latestMappingCandidates(
  client: PoolClient,
  input: {
    pipelineId: string
    productIds: string[]
  },
) {
  const result = await client.query<LatestMappingCandidateRow>(
    `SELECT
       mapping.product_id::text,
       mapping.global_id AS mapping_global_id,
       latest_candidate.global_id AS candidate_global_id,
       latest_candidate.barcode_snapshot,
       latest_candidate.source_revision,
       latest_candidate.source_hash
     FROM operations_product_mappings AS mapping
     LEFT JOIN LATERAL (
       SELECT
         candidate.global_id,
         candidate.barcode_snapshot,
         candidate.source_revision,
         candidate.source_hash
       FROM operations_commerce_product_candidates AS candidate
       WHERE candidate.organization_id = mapping.organization_id
         AND candidate.integration_account_id =
           mapping.integration_account_id
         AND candidate.pipeline_id = mapping.pipeline_id
         AND candidate.external_variant_id = mapping.external_variant_id
       ORDER BY
         candidate.provider_updated_at DESC NULLS LAST,
         candidate.observed_at DESC,
         candidate.created_at DESC,
         candidate.id DESC
       LIMIT 1
     ) AS latest_candidate ON true
     WHERE mapping.pipeline_id = $1::uuid
       AND mapping.product_id = ANY($2::uuid[])
       AND mapping.active = true
       AND mapping.external_variant_id IS NOT NULL
     ORDER BY mapping.product_id, mapping.global_id`,
    [input.pipelineId, input.productIds],
  )
  return result.rows
}

async function readExistingProductIdentityAlias(
  client: PoolClient,
  input: {
    pipelineId: string
    duplicateProductId: string
  },
) {
  const result = await client.query<ExistingAliasRow>(
    `SELECT
       alias.global_id,
       alias.canonical_product_id::text,
       alias.evidence
     FROM crm_product_identity_aliases AS alias
     WHERE alias.pipeline_id = $1::uuid
       AND alias.alias_product_id = $2::uuid
     LIMIT 1
     FOR UPDATE`,
    [input.pipelineId, input.duplicateProductId],
  )
  return result.rows[0] || null
}

export async function resolveProductIdentityInPostgres(input: {
  pipelineId: string
  productGlobalId: string
}) {
  const result = await query<{
    requested_global_id: string
    canonical_global_id: string
    is_alias: boolean
  }>(
    `SELECT
       requested.reference_code AS requested_global_id,
       canonical.reference_code AS canonical_global_id,
       requested.id <> canonical.id AS is_alias
     FROM crm_products AS requested
     JOIN crm_products AS canonical
       ON canonical.pipeline_id = requested.pipeline_id
      AND canonical.id = resolve_crm_product_identity(
        requested.pipeline_id,
        requested.id
      )
     WHERE requested.pipeline_id = $1::uuid
       AND requested.reference_code = $2`,
    [input.pipelineId, input.productGlobalId],
  )
  const row = result.rows[0]
  if (!row) throw new Error('Product identity was not found')
  return {
    requestedGlobalId: row.requested_global_id,
    canonicalGlobalId: row.canonical_global_id,
    isAlias: row.is_alias,
  }
}

export async function finalizeCommittedProductIdentityResult<
  Result extends Record<string, unknown>,
>(input: {
  result: Result
  refreshDropdown: boolean
  syncDropdown: () => Promise<unknown>
}) {
  if (!input.refreshDropdown) {
    return {
      ...input.result,
      dropdownSync: 'not_requested' as const,
      warning: null,
    }
  }
  try {
    await input.syncDropdown()
    return {
      ...input.result,
      dropdownSync: 'succeeded' as const,
      warning: null,
    }
  } catch (error) {
    return {
      ...input.result,
      dropdownSync: 'deferred' as const,
      warning: error instanceof Error
        ? `Product reconciliation committed; dropdown refresh is pending: ${error.message}`
        : 'Product reconciliation committed; dropdown refresh is pending',
    }
  }
}

export type ReconcileProductIdentityInput = {
  pipelineId: string
  canonicalGlobalId: string
  duplicateGlobalId: string
  expectedCanonicalSourceHash: string
  expectedDuplicateSourceHash: string
  expectedCanonicalUpdatedAt: string
  expectedDuplicateUpdatedAt: string
  expectedCanonicalMappingGlobalIds: string[]
  expectedDuplicateMappingGlobalIds: string[]
  evidenceType: ProductIdentityEvidenceType
  operatorConfirmed: boolean
  actorEmail: string
  refreshDropdown?: boolean
}

export async function reconcileProductIdentityInPostgres(
  input: ReconcileProductIdentityInput,
) {
  const result = await withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [
        `crm-product-identity:${input.pipelineId}:${
          [
            input.canonicalGlobalId,
            input.duplicateGlobalId,
          ].sort().join(':')
        }`,
      ],
    )
    const { canonical, duplicate } = await readLockedProducts(client, input)
    if (
      canonical.id === duplicate.id
      || canonical.pipeline_id !== duplicate.pipeline_id
    ) {
      throw new Error('Choose two distinct products in the same catalog')
    }
    const committedAlias = await readExistingProductIdentityAlias(
      client,
      {
        pipelineId: input.pipelineId,
        duplicateProductId: duplicate.id,
      },
    )
    if (committedAlias) {
      if (committedAlias.canonical_product_id !== canonical.id) {
        throw new Error(
          'This duplicate is already linked to a different canonical product',
        )
      }
      const replayResult = committedAlias.evidence.result
      const replay = (
        replayResult
        && typeof replayResult === 'object'
        && !Array.isArray(replayResult)
      )
        ? replayResult as Record<string, unknown>
        : {}
      return {
        canonicalProductGlobalId: canonical.reference_code,
        duplicateProductGlobalId: duplicate.reference_code,
        aliasGlobalId: committedAlias.global_id,
        displayName: clean(replay.displayName) || canonical.name,
        movedSalesChannelMappings: number(
          replay.movedSalesChannelMappings,
        ),
        providerWrites: 0,
        historicalRowsRewritten: 0,
        replayed: true,
      }
    }
    if (
      canonical.source_hash !== input.expectedCanonicalSourceHash
      || duplicate.source_hash !== input.expectedDuplicateSourceHash
      || new Date(canonical.updated_at).toISOString()
        !== new Date(input.expectedCanonicalUpdatedAt).toISOString()
      || new Date(duplicate.updated_at).toISOString()
        !== new Date(input.expectedDuplicateUpdatedAt).toISOString()
    ) {
      throw new Error('Product identity records changed; reload the review')
    }
    if (
      !canonical.active
      || !duplicate.active
      || clean(canonical.source_payload?.archived).toLowerCase() === 'true'
      || clean(duplicate.source_payload?.archived).toLowerCase() === 'true'
    ) {
      throw new Error('Only active, unmerged products can be reconciled')
    }
    if (
      await duplicateOperationalReferenceCount(client, duplicate) > 0
    ) {
      throw new Error(
        'The duplicate has inventory, packaging, order, or CRM references and cannot be merged automatically',
      )
    }
    const canonicalMappings = await activeProductMappings(client, canonical)
    const duplicateMappings = await activeProductMappings(client, duplicate)
    if (!canonicalMappings.length || !duplicateMappings.length) {
      throw new Error('Both products must have an active sales-channel mapping')
    }
    if (
      !sameIdentifierSet(
        canonicalMappings.map((mapping) => mapping.global_id),
        input.expectedCanonicalMappingGlobalIds,
      )
      || !sameIdentifierSet(
        duplicateMappings.map((mapping) => mapping.global_id),
        input.expectedDuplicateMappingGlobalIds,
      )
    ) {
      throw new Error(
        'The reviewed sales-channel mapping set changed; reload the review',
      )
    }
    const canonicalProviders = await client.query<{ provider: string }>(
      `SELECT DISTINCT account.provider
       FROM operations_product_mappings mapping
       JOIN operations_integration_accounts account
         ON account.organization_id = mapping.organization_id
        AND account.id = mapping.integration_account_id
       WHERE mapping.pipeline_id = $1::uuid
         AND mapping.product_id = $2::uuid
         AND mapping.active = true`,
      [input.pipelineId, canonical.id],
    )
    const duplicateProviders = await client.query<{ provider: string }>(
      `SELECT DISTINCT account.provider
       FROM operations_product_mappings mapping
       JOIN operations_integration_accounts account
         ON account.organization_id = mapping.organization_id
        AND account.id = mapping.integration_account_id
       WHERE mapping.pipeline_id = $1::uuid
         AND mapping.product_id = $2::uuid
         AND mapping.active = true`,
      [input.pipelineId, duplicate.id],
    )
    if (
      canonicalProviders.rows.some((left) => (
        duplicateProviders.rows.some((right) => (
          left.provider === right.provider
        ))
      ))
    ) {
      throw new Error(
        'The products overlap on the same sales channel and require variant-level review',
      )
    }
    const requestedCanonical = requestedProductName({
      ...canonical,
      provider: canonicalProviders.rows[0]?.provider as 'shopify' | 'faire',
      mapping_global_id: canonicalMappings[0].global_id,
      channel_sku: canonicalMappings[0].channel_sku,
      barcode_snapshot: null,
      inventory_positions: '0',
      inventory_levels: '0',
      order_lines: '0',
      receipt_lines: '0',
      opportunity_products: '0',
      location_product_rules: '0',
      replenishment_tasks: '0',
      legacy_pack_profiles: '0',
      pack_profiles: '0',
      pack_profile_evidence: [],
    })
    const requestedDuplicate = requestedProductName({
      ...duplicate,
      provider: duplicateProviders.rows[0]?.provider as 'shopify' | 'faire',
      mapping_global_id: duplicateMappings[0].global_id,
      channel_sku: duplicateMappings[0].channel_sku,
      barcode_snapshot: null,
      inventory_positions: '0',
      inventory_levels: '0',
      order_lines: '0',
      receipt_lines: '0',
      opportunity_products: '0',
      location_product_rules: '0',
      replenishment_tasks: '0',
      legacy_pack_profiles: '0',
      pack_profiles: '0',
      pack_profile_evidence: [],
    })
    if (
      input.evidenceType === 'operator_confirmed'
      && (
      normalizedDisplayName(requestedCanonical)
      !== normalizedDisplayName(requestedDuplicate)
      )
    ) {
      throw new Error(
        'Product names no longer identify the same sellable pack; reload the review',
      )
    }
    const skuMatches = identifierIntersection(
      [canonical.sku, ...canonicalMappings.map((row) => row.channel_sku)],
      [duplicate.sku, ...duplicateMappings.map((row) => row.channel_sku)],
    )
    const currentCandidates = await latestMappingCandidates(client, {
      pipelineId: input.pipelineId,
      productIds: [canonical.id, duplicate.id],
    })
    const canonicalCandidateRows = currentCandidates.filter((row) => (
      row.product_id === canonical.id
    ))
    const duplicateCandidateRows = currentCandidates.filter((row) => (
      row.product_id === duplicate.id
    ))
    const canonicalBarcodes = unique(
      canonicalCandidateRows.map((row) => row.barcode_snapshot),
    )
    const duplicateBarcodes = unique(
      duplicateCandidateRows.map((row) => row.barcode_snapshot),
    )
    if (input.evidenceType === 'exact_sku' && skuMatches.length === 0) {
      throw new Error('The matching SKU evidence changed; reload the review')
    }
    if (knownIdentifiersConflict(canonicalBarcodes, duplicateBarcodes)) {
      throw new Error(
        'The current sales-channel barcodes conflict and the products cannot be reconciled automatically',
      )
    }
    if (
      input.evidenceType === 'operator_confirmed'
      && input.operatorConfirmed !== true
    ) {
      throw new Error(
        'Confirm that both records are the same sellable product and pack level',
      )
    }
    const matchingCurrentIdentifiers = identifierIntersection(
      canonicalBarcodes,
      duplicateBarcodes,
    )
    const verifiedMatchingIdentifiers =
      input.evidenceType === 'exact_gtin'
        ? matchingCurrentIdentifiers.filter(isValidGtin)
        : matchingCurrentIdentifiers
    if (
      (
        input.evidenceType === 'exact_barcode'
        || input.evidenceType === 'exact_gtin'
      )
      && verifiedMatchingIdentifiers.length === 0
    ) {
        throw new Error(
          'The matching barcode evidence changed; reload the review',
        )
    }
    const mergeKey = stableKey({
      pipelineId: input.pipelineId,
      canonicalGlobalId: canonical.reference_code,
      duplicateGlobalId: duplicate.reference_code,
    })
    const mergedAt = new Date().toISOString()
    const reviewedCanonicalMappingGlobalIds = canonicalMappings
      .map((mapping) => mapping.global_id)
      .sort()
    const reviewedDuplicateMappingGlobalIds = duplicateMappings
      .map((mapping) => mapping.global_id)
      .sort()
    const evidence = {
      schemaVersion: 'crm-product-identity-v2',
      evidenceType: input.evidenceType,
      matchingSkus: skuMatches,
      matchingIdentifiers: verifiedMatchingIdentifiers,
      currentCandidateEvidence: currentCandidates.map((candidate) => ({
        productGlobalId: candidate.product_id === canonical.id
          ? canonical.reference_code
          : duplicate.reference_code,
        mappingGlobalId: candidate.mapping_global_id,
        candidateGlobalId: candidate.candidate_global_id,
        barcode: candidate.barcode_snapshot,
        sourceRevision: candidate.source_revision,
        sourceHash: candidate.source_hash,
      })),
      reviewedCanonicalMappingGlobalIds,
      reviewedDuplicateMappingGlobalIds,
      canonicalGlobalId: canonical.reference_code,
      duplicateGlobalId: duplicate.reference_code,
      canonicalProviders: canonicalProviders.rows.map((row) => row.provider),
      duplicateProviders: duplicateProviders.rows.map((row) => row.provider),
      confirmedBy: input.actorEmail,
      confirmedAt: mergedAt,
      mergeKey,
    }
    const alias = await client.query<{ global_id: string }>(
      `INSERT INTO crm_product_identity_aliases (
         pipeline_id, alias_product_id, canonical_product_id,
         evidence_type, evidence, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6
       )
       RETURNING global_id`,
      [
        input.pipelineId,
        duplicate.id,
        canonical.id,
        input.evidenceType,
        JSON.stringify(evidence),
        input.actorEmail,
      ],
    )
    const newMappingGlobalIds: string[] = []
    for (const mapping of duplicateMappings) {
      const deactivated = await client.query(
        `UPDATE operations_product_mappings
         SET active = false,
             updated_at = now()
         WHERE id = $1::uuid
           AND product_id = $2::uuid
           AND active = true`,
        [mapping.id, duplicate.id],
      )
      if (deactivated.rowCount !== 1) {
        throw new Error(
          'A sales-channel mapping changed; reload the review',
        )
      }
      const created = await client.query<{
        id: string
        global_id: string
      }>(
        `INSERT INTO operations_product_mappings (
           organization_id, integration_account_id, pipeline_id,
           product_id, channel_sku, external_product_id,
           external_variant_id, external_inventory_item_id,
           mapping_method, mapping_source_revision, active, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
           'exact_variant', $9, true, $10
         )
         RETURNING id::text, global_id`,
        [
          mapping.organization_id,
          mapping.integration_account_id,
          mapping.pipeline_id,
          canonical.id,
          mapping.channel_sku,
          mapping.external_product_id,
          mapping.external_variant_id,
          mapping.external_inventory_item_id,
          mapping.mapping_source_revision,
          input.actorEmail,
        ],
      )
      const channelState = await client.query(
        `UPDATE operations_product_channel_states
         SET product_id = $5::uuid,
             product_mapping_id = $6::uuid,
             row_version = row_version + 1,
             updated_by = $7,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND pipeline_id = $3::uuid
           AND external_variant_id = $4
           AND product_id = $8::uuid
           AND product_mapping_id = $9::uuid
         RETURNING id`,
        [
          mapping.organization_id,
          mapping.integration_account_id,
          mapping.pipeline_id,
          mapping.external_variant_id,
          canonical.id,
          created.rows[0].id,
          input.actorEmail,
          duplicate.id,
          mapping.id,
        ],
      )
      if (channelState.rowCount !== 1) {
        throw new Error(
          'The current sales-channel projection changed or is missing; reload the review',
        )
      }
      newMappingGlobalIds.push(created.rows[0].global_id)
    }
    const canonicalSku = cleanOptional(canonical.sku)
      || cleanOptional(duplicate.sku)
    const archivedName = archivedProductIdentityName({
      originalName: duplicate.name,
      duplicateGlobalId: duplicate.reference_code,
    })
    const duplicatePayload = {
      ...(duplicate.source_payload || {}),
      archived: true,
      archivedAt: mergedAt,
      archivedBy: input.actorEmail,
      archivedSource: 'product_identity_reconciliation',
      archivedOriginalName: duplicate.name,
      archivedName,
      productIdentity: {
        role: 'alias',
        aliasGlobalId: alias.rows[0].global_id,
        canonicalProductGlobalId: canonical.reference_code,
        evidence,
      },
    }
    const archived = await client.query(
      `UPDATE crm_products
       SET name = $3,
           sku = NULL,
           status = 'Merged',
           active = false,
           source_payload = $4::jsonb,
           source_hash = $5,
           sync_status = $6,
           sync_error = NULL,
           updated_by = $7,
           updated_at = now()
       WHERE pipeline_id = $1::uuid
         AND id = $2::uuid
       RETURNING id`,
      [
        input.pipelineId,
        duplicate.id,
        archivedName,
        JSON.stringify(duplicatePayload),
        sourceHash({
          fields: productFields(duplicate, {
            name: archivedName,
            sku: null,
          }),
          sourcePayload: duplicatePayload,
        }),
        duplicate.suitecrm_id ? 'pending' : 'synced',
        input.actorEmail,
      ],
    )
    if (archived.rowCount !== 1) {
      throw new Error('The duplicate product changed; reload the review')
    }
    const deleteOutboxKey = await queueSuiteCrmDelete(client, {
      product: duplicate,
      actorEmail: input.actorEmail,
    })
    const canonicalPayload = {
      ...(canonical.source_payload || {}),
      productIdentity: {
        role: 'canonical',
        latestAliasGlobalId: alias.rows[0].global_id,
        latestAliasProductGlobalId: duplicate.reference_code,
        latestReconciledAt: mergedAt,
        latestReconciledBy: input.actorEmail,
      },
    }
    await stageCrmRecordWithClient(client, {
      entity: 'products',
      pipelineId: input.pipelineId,
      localId: canonical.id,
      sourceKey: canonical.source_key,
      sourcePayload: canonicalPayload,
      actorEmail: input.actorEmail,
      fields: productFields(canonical, {
        name: requestedCanonical,
        sku: canonicalSku,
      }),
    })
    const committedResult = {
      canonicalProductGlobalId: canonical.reference_code,
      duplicateProductGlobalId: duplicate.reference_code,
      aliasGlobalId: alias.rows[0].global_id,
      displayName: requestedCanonical,
      archivedDuplicateName: archivedName,
      movedSalesChannelMappings: newMappingGlobalIds.length,
      providerWrites: 0,
      historicalRowsRewritten: 0,
      replayed: false,
    }
    await client.query(
      `UPDATE crm_product_identity_aliases
       SET evidence = $3::jsonb
       WHERE pipeline_id = $1::uuid
         AND global_id = $2`,
      [
        input.pipelineId,
        alias.rows[0].global_id,
        JSON.stringify({
          ...evidence,
          result: committedResult,
        }),
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'crm.product_identity.reconciled',
      aggregateType: 'crm_products',
      aggregateId: canonical.id,
      eventKey: `crm-product-identity:${mergeKey}`,
      payload: {
        pipelineId: input.pipelineId,
        canonicalProductGlobalId: canonical.reference_code,
        duplicateProductGlobalId: duplicate.reference_code,
        aliasGlobalId: alias.rows[0].global_id,
        evidenceType: input.evidenceType,
        oldMappingGlobalIds: duplicateMappings.map(
          (mapping) => mapping.global_id,
        ),
        newMappingGlobalIds,
        suiteCrmDeleteOutboxKey: deleteOutboxKey,
        archivedDuplicateName: archivedName,
        providerWrites: 0,
        historicalRowsRewritten: 0,
      },
    }, client)
    return committedResult
  })
  return finalizeCommittedProductIdentityResult({
    result,
    refreshDropdown: input.refreshDropdown !== false,
    syncDropdown: () => syncPipelineProductDropdownCatalogInPostgres({
      pipelineId: input.pipelineId,
      actorEmail: input.actorEmail,
    }),
  })
}

export async function reconcileProductIdentityBatchInPostgres(input: {
  pipelineId: string
  actorEmail: string
  items: Array<Omit<
    ReconcileProductIdentityInput,
    'pipelineId' | 'actorEmail' | 'refreshDropdown'
  >>
}) {
  if (input.items.some((item) => (
    item.evidenceType === 'operator_confirmed'
  ))) {
    throw new Error(
      'Name-only product identities must be reviewed and confirmed one pair at a time',
    )
  }
  const results: Awaited<
    ReturnType<typeof reconcileProductIdentityInPostgres>
  >[] = []
  const errors: Array<{
    canonicalGlobalId: string
    duplicateGlobalId: string
    error: string
  }> = []
  for (const item of input.items) {
    try {
      results.push(await reconcileProductIdentityInPostgres({
        ...item,
        pipelineId: input.pipelineId,
        actorEmail: input.actorEmail,
        refreshDropdown: false,
      }))
    } catch (error) {
      errors.push({
        canonicalGlobalId: item.canonicalGlobalId,
        duplicateGlobalId: item.duplicateGlobalId,
        error: error instanceof Error
          ? error.message
          : 'Product reconciliation failed',
      })
    }
  }
  return finalizeCommittedProductIdentityResult({
    result: {
      applied: results.length,
      failed: errors.length,
      results,
      errors,
    },
    refreshDropdown: results.length > 0,
    syncDropdown: () => syncPipelineProductDropdownCatalogInPostgres({
      pipelineId: input.pipelineId,
      actorEmail: input.actorEmail,
    }),
  })
}
