import crypto from 'crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  BARCODE_LABEL_MEDIA,
  BARCODE_LABEL_TEMPLATE_VERSION,
  barcodeLabelRequestHash,
  internalProductBarcode,
  locationBarcode,
  providerBarcodeIdentity,
  renderBarcodeLabelsPreviewHtml,
  renderBarcodeLabelsZpl,
  type BarcodeLabelBatchSnapshot,
  type BarcodeLabelItem,
  type BarcodeLabelMedia,
  type BarcodeLabelTargetType,
} from '@/lib/operations/barcodeLabels'
import { listOperationsPrinterProfilesInPostgres } from '@/lib/persistence/operationPrinting'
import {
  readWearableLocationScanPoliciesFromPostgres,
  type WearableLocationScanPolicy,
} from '@/lib/persistence/wearableLocationScanPolicy'
import { OperationsRequestError } from '@/lib/persistence/operations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const SHA256 = /^[a-f0-9]{64}$/
const PRODUCT_GLOBAL_ID = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const LOCATION_GLOBAL_ID = /^gwl(?:[0-9]{7}|[0-9a-v]{12})$/
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/
const BATCH_GLOBAL_ID = /^gbl(?:[0-9]{7}|[0-9a-v]{12})$/
const ARTIFACT_GLOBAL_ID = /^gpf(?:[0-9]{7}|[0-9a-v]{12})$/

export type BarcodeLabelSelection = { globalId: string; copies: number }

export type OperationsBarcodeLabelProduct = {
  globalId: string
  name: string
  sku: string | null
  barcodeValue: string | null
  symbology: BarcodeLabelItem['symbology'] | null
  sourceIdentity: BarcodeLabelItem['sourceIdentity'] | null
  barcodeSource: 'provider' | 'internal' | 'unassigned'
}

export type OperationsBarcodeLabelLocation = {
  globalId: string
  warehouseGlobalId: string
  warehouseName: string
  code: string
  zone: string
  locationType: string
  barcodeValue: string
}

export type OperationsBarcodeLabelBatch = {
  globalId: string
  artifactGlobalId: string
  warehouseGlobalId: string
  warehouseName: string
  targetType: BarcodeLabelTargetType
  media: BarcodeLabelMedia
  labelCount: number
  items: BarcodeLabelItem[]
  templateVersion: string
  contentSha256: string
  byteLength: number
  printJobGlobalId: string | null
  printJobStatus: string | null
  createdBy: string | null
  createdAt: string
}

export type OperationsBarcodeLabelWorkspace = {
  organizationId: string
  capabilities: { canView: boolean; canManage: boolean; canExecute: boolean }
  warehouses: Array<{
    id: string
    globalId: string
    name: string
    locationScanPolicy: WearableLocationScanPolicy
  }>
  products: OperationsBarcodeLabelProduct[]
  locations: OperationsBarcodeLabelLocation[]
  printers: Array<{
    globalId: string
    warehouseGlobalId: string
    name: string
    status: string
    supportedMedia: BarcodeLabelMedia[]
    durableConfigured: boolean
    supportsProductLabels: boolean
    supportsLocationLabels: boolean
  }>
  batches: OperationsBarcodeLabelBatch[]
  generatedAt: string
}

type ProductRow = QueryResultRow & {
  id: string
  pipeline_id: string
  global_id: string
  name: string
  sku: string | null
  provider_barcodes: unknown
  assigned_barcode: string | null
  assigned_symbology: BarcodeLabelItem['symbology'] | null
  assigned_source_identity: BarcodeLabelItem['sourceIdentity'] | null
  assigned_barcode_source: 'provider' | 'internal' | null
}

type LocationRow = QueryResultRow & {
  id: string
  global_id: string
  warehouse_id: string
  warehouse_global_id: string
  warehouse_name: string
  code: string
  zone: string
  location_type: string
}

type BatchRow = QueryResultRow & {
  global_id: string
  artifact_global_id: string
  warehouse_global_id: string
  warehouse_name: string
  target_type: BarcodeLabelTargetType
  media_size: BarcodeLabelMedia
  label_count: number
  items_snapshot: unknown
  template_version: string
  content_sha256: string
  byte_length: string
  print_job_global_id: string | null
  print_job_status: string | null
  created_by: string | null
  created_at: string | Date
}

function required(value: unknown, label: string, maximum = 200) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new OperationsRequestError(
      'OPERATIONS_BARCODE_LABEL_REQUEST_INVALID',
      `${label} is invalid`,
    )
  }
  return normalized
}

function validOrganization(value: unknown) {
  const normalized = required(value, 'Organization', 40)
  if (!/^[0-9a-f-]{36}$/i.test(normalized)) {
    throw new OperationsRequestError('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Organization is invalid')
  }
  return normalized
}

function iso(value: string | Date) {
  return new Date(value).toISOString()
}

function providerCandidates(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map((candidate) => String(candidate ?? '').trim()).filter(Boolean)
}

function resolvedProductBarcode(row: ProductRow) {
  if (
    row.assigned_barcode
    && row.assigned_symbology
    && row.assigned_source_identity
    && row.assigned_barcode_source
  ) {
    return {
      value: row.assigned_barcode,
      symbology: row.assigned_symbology,
      sourceIdentity: row.assigned_source_identity,
      source: row.assigned_barcode_source,
      assigned: true,
    }
  }
  for (const candidate of providerCandidates(row.provider_barcodes)) {
    const provider = providerBarcodeIdentity(candidate)
    if (provider) return { ...provider, source: 'provider' as const, assigned: false }
  }
  return null
}

function itemsSnapshot(value: unknown): BarcodeLabelItem[] {
  if (!Array.isArray(value)) {
    throw new OperationsRequestError(
      'OPERATIONS_BARCODE_LABEL_EVIDENCE_INVALID',
      'Barcode label batch evidence is invalid',
      500,
    )
  }
  return value as BarcodeLabelItem[]
}

function batch(row: BatchRow): OperationsBarcodeLabelBatch {
  return {
    globalId: row.global_id,
    artifactGlobalId: row.artifact_global_id,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseName: row.warehouse_name,
    targetType: row.target_type,
    media: row.media_size,
    labelCount: Number(row.label_count),
    items: itemsSnapshot(row.items_snapshot),
    templateVersion: row.template_version,
    contentSha256: row.content_sha256,
    byteLength: Number(row.byte_length),
    printJobGlobalId: row.print_job_global_id,
    printJobStatus: row.print_job_status,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  }
}

function execute<T extends QueryResultRow>(
  client: PoolClient | undefined,
  text: string,
  values: unknown[],
) {
  return client ? client.query<T>(text, values) : query<T>(text, values)
}

const BATCH_SELECT = `
  SELECT label_batch.global_id,
         artifact.global_id AS artifact_global_id,
         warehouse.global_id AS warehouse_global_id,
         warehouse.name AS warehouse_name,
         label_batch.target_type,
         label_batch.media_size,
         label_batch.label_count,
         label_batch.items_snapshot,
         label_batch.template_version,
         artifact.content_sha256,
         artifact.byte_length::text,
         latest_job.global_id AS print_job_global_id,
         latest_job.status AS print_job_status,
         label_batch.created_by,
         label_batch.created_at
  FROM operations_barcode_label_batches label_batch
  JOIN operations_warehouses warehouse
    ON warehouse.organization_id = label_batch.organization_id
   AND warehouse.id = label_batch.warehouse_id
  JOIN operations_print_artifacts artifact
    ON artifact.organization_id = label_batch.organization_id
   AND artifact.source_barcode_label_batch_id = label_batch.id
  LEFT JOIN LATERAL (
    SELECT job.global_id, job.status
    FROM operations_print_jobs job
    WHERE job.organization_id = artifact.organization_id
      AND job.artifact_id = artifact.id
    ORDER BY job.created_at DESC, job.id DESC
    LIMIT 1
  ) latest_job ON true
`

async function recentBatches(organizationId: string, client?: PoolClient) {
  const result = await execute<BatchRow>(client,
    `${BATCH_SELECT}
     WHERE label_batch.organization_id = $1::uuid
     ORDER BY label_batch.created_at DESC, label_batch.id DESC
     LIMIT 50`,
    [organizationId],
  )
  return result.rows.map(batch)
}

async function productRows(organizationId: string, globalIds?: string[], client?: PoolClient) {
  return execute<ProductRow>(client,
    `SELECT product.id::text,
            product.pipeline_id::text,
            product.reference_code AS global_id,
            product.name,
            NULLIF(btrim(product.sku), '') AS sku,
            COALESCE(provider.barcodes, '[]'::jsonb) AS provider_barcodes,
            assigned.barcode_value AS assigned_barcode,
            assigned.symbology AS assigned_symbology,
            assigned.source_identity AS assigned_source_identity,
            assigned.barcode_source AS assigned_barcode_source
     FROM crm_products product
     JOIN pipeline_spaces pipeline
       ON pipeline.id = product.pipeline_id
      AND pipeline.workspace_organization_id = $1::uuid
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(candidate.provider_barcode ORDER BY candidate.observed_at DESC) AS barcodes
       FROM (
         SELECT channel.provider_barcode, max(channel.observed_at) AS observed_at
         FROM operations_product_channel_states channel
         WHERE channel.organization_id = $1::uuid
           AND channel.pipeline_id = product.pipeline_id
           AND channel.product_id = product.id
           AND channel.provider_active = true
           AND NULLIF(btrim(channel.provider_barcode), '') IS NOT NULL
         GROUP BY channel.provider_barcode
         ORDER BY max(channel.observed_at) DESC
         LIMIT 20
       ) candidate
     ) provider ON true
     LEFT JOIN operations_product_barcodes assigned
       ON assigned.organization_id = $1::uuid
      AND assigned.pipeline_id = product.pipeline_id
      AND assigned.product_id = product.id
     WHERE product.active = true
       AND ($2::text[] IS NULL OR product.reference_code = ANY($2::text[]))
     ORDER BY lower(product.name), product.id
     LIMIT 2000`,
    [organizationId, globalIds || null],
  )
}

async function locationRows(organizationId: string, globalIds?: string[], client?: PoolClient) {
  return execute<LocationRow>(client,
    `SELECT location.id::text,
            location.global_id,
            location.warehouse_id::text,
            warehouse.global_id AS warehouse_global_id,
            warehouse.name AS warehouse_name,
            location.code,
            location.zone,
            location.location_type
     FROM operations_locations location
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = location.organization_id
      AND warehouse.id = location.warehouse_id
     WHERE location.organization_id = $1::uuid
       AND location.active = true
       AND warehouse.status = 'active'
       AND ($2::text[] IS NULL OR location.global_id = ANY($2::text[]))
     ORDER BY lower(warehouse.name), location.pick_sequence, lower(location.code), location.id
     LIMIT 5000`,
    [organizationId, globalIds || null],
  )
}

export async function readOperationsBarcodeLabelWorkspaceFromPostgres(input: {
  organizationId: string
  canView: boolean
  canManage: boolean
  canExecute: boolean
}): Promise<OperationsBarcodeLabelWorkspace> {
  const organizationId = validOrganization(input.organizationId)
  if (!input.canView) {
    throw new OperationsRequestError(
      'OPERATIONS_VIEW_REQUIRED',
      'Operations view permission is required to view barcode labels',
      403,
    )
  }
  const [warehouses, products, locations, printers, batches, locationScanPolicies] = await Promise.all([
    query<{ id: string; global_id: string; name: string }>(
      `SELECT id::text, global_id, name
       FROM operations_warehouses
       WHERE organization_id = $1::uuid AND status = 'active'
       ORDER BY lower(name), id`,
      [organizationId],
    ),
    productRows(organizationId),
    locationRows(organizationId),
    listOperationsPrinterProfilesInPostgres(organizationId),
    recentBatches(organizationId),
    readWearableLocationScanPoliciesFromPostgres({ organizationId }),
  ])
  const locationScanPolicyByWarehouse = new Map(
    locationScanPolicies.map((candidate) => [candidate.warehouseGlobalId, candidate]),
  )
  return {
    organizationId,
    capabilities: {
      canView: input.canView,
      canManage: input.canManage,
      canExecute: input.canExecute,
    },
    warehouses: warehouses.rows.map((warehouse) => ({
      id: warehouse.id,
      globalId: warehouse.global_id,
      name: warehouse.name,
      locationScanPolicy: locationScanPolicyByWarehouse.get(warehouse.global_id) || {
        warehouseId: warehouse.id,
        warehouseGlobalId: warehouse.global_id,
        warehouseName: warehouse.name,
        locationScanRequired: false,
        rowVersion: 0,
        updatedBy: null,
        updatedAt: null,
      },
    })),
    products: products.rows.map((product) => {
      const resolved = resolvedProductBarcode(product)
      return {
        globalId: product.global_id,
        name: product.name,
        sku: product.sku,
        barcodeValue: resolved?.value || null,
        symbology: resolved?.symbology || null,
        sourceIdentity: resolved?.sourceIdentity || null,
        barcodeSource: resolved?.source || 'unassigned',
      }
    }),
    locations: locations.rows.map((location) => ({
      globalId: location.global_id,
      warehouseGlobalId: location.warehouse_global_id,
      warehouseName: location.warehouse_name,
      code: location.code,
      zone: location.zone,
      locationType: location.location_type,
      barcodeValue: locationBarcode(location.global_id),
    })),
    printers: printers.map((printer) => ({
      globalId: printer.globalId,
      warehouseGlobalId: printer.warehouseGlobalId,
      name: printer.name,
      status: printer.status,
      supportedMedia: printer.supportedMedia.filter((candidate): candidate is BarcodeLabelMedia => (
        candidate === 'label_2x1'
        || candidate === 'label_3x1'
        || candidate === 'label_4x2'
        || candidate === 'label_4x6'
        || candidate === 'label_4x8'
      )),
      durableConfigured: printer.connectionMode === 'local_agent'
        && printer.localPrintAgentStatus === 'active',
      supportsProductLabels: printer.supportedFormats.includes('ZPL')
        && printer.supportedMedia.some((media) => (
          BARCODE_LABEL_MEDIA.includes(media as BarcodeLabelMedia)
        ))
        && printer.supportedDocumentTypes.includes('product_label'),
      supportsLocationLabels: printer.supportedFormats.includes('ZPL')
        && printer.supportedMedia.some((media) => (
          BARCODE_LABEL_MEDIA.includes(media as BarcodeLabelMedia)
        ))
        && printer.supportedDocumentTypes.includes('location_label'),
    })),
    batches,
    generatedAt: new Date().toISOString(),
  }
}

function validateSelections(value: BarcodeLabelSelection[], targetType: BarcodeLabelTargetType) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new OperationsRequestError(
      'OPERATIONS_BARCODE_LABEL_REQUEST_INVALID',
      'Select between 1 and 100 label targets',
    )
  }
  const pattern = targetType === 'product' ? PRODUCT_GLOBAL_ID : LOCATION_GLOBAL_ID
  const seen = new Set<string>()
  let total = 0
  return value.map((selection) => {
    const globalId = required(selection.globalId, 'Label target', 16).toLowerCase()
    const copies = Number(selection.copies)
    if (!pattern.test(globalId) || !Number.isSafeInteger(copies) || copies < 1 || copies > 100) {
      throw new OperationsRequestError(
        'OPERATIONS_BARCODE_LABEL_REQUEST_INVALID',
        'Label target or copy count is invalid',
      )
    }
    if (seen.has(globalId)) {
      throw new OperationsRequestError(
        'OPERATIONS_BARCODE_LABEL_REQUEST_INVALID',
        'Each label target may be selected once per batch',
      )
    }
    seen.add(globalId)
    total += copies
    return { globalId, copies }
  }).map((selection) => {
    if (total > 500) {
      throw new OperationsRequestError(
        'OPERATIONS_BARCODE_LABEL_REQUEST_INVALID',
        'A barcode label batch may contain at most 500 labels',
      )
    }
    return selection
  })
}

async function replayBatch(client: PoolClient, organizationId: string, idempotencyKey: string) {
  const result = await client.query<BatchRow>(
    `${BATCH_SELECT}
     WHERE label_batch.organization_id = $1::uuid
       AND label_batch.idempotency_key = $2
     LIMIT 1`,
    [organizationId, idempotencyKey],
  )
  return result.rows[0] || null
}

export async function generateOperationsBarcodeLabelBatchInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  warehouseGlobalId: string
  targetType: BarcodeLabelTargetType
  media: BarcodeLabelMedia
  selections: BarcodeLabelSelection[]
}): Promise<OperationsBarcodeLabelBatch> {
  const organizationId = validOrganization(input.organizationId)
  const actorEmail = required(input.actorEmail, 'Signed-in user').toLowerCase()
  const idempotencyKey = required(input.idempotencyKey, 'Idempotency-Key')
  const warehouseGlobalId = required(input.warehouseGlobalId, 'Warehouse', 16).toLowerCase()
  if (!WAREHOUSE_GLOBAL_ID.test(warehouseGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Warehouse is invalid')
  }
  if (input.targetType !== 'product' && input.targetType !== 'location') {
    throw new OperationsRequestError('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Label type is invalid')
  }
  if (
    input.media !== 'label_2x1'
    && input.media !== 'label_3x1'
    && input.media !== 'label_4x2'
    && input.media !== 'label_4x6'
    && input.media !== 'label_4x8'
  ) {
    throw new OperationsRequestError('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Label media is invalid')
  }
  const selections = validateSelections(input.selections, input.targetType)
  const requestHash = barcodeLabelRequestHash({
    warehouseGlobalId,
    targetType: input.targetType,
    media: input.media,
    selections,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:barcode-label-batch:${organizationId}:${idempotencyKey}`,
    )
    const prior = await replayBatch(client, organizationId, idempotencyKey)
    if (prior) {
      const request = await client.query<{ request_hash: string }>(
        `SELECT request_hash
         FROM operations_barcode_label_batches
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [organizationId, prior.global_id],
      )
      if (request.rows[0]?.request_hash !== requestHash) {
        throw new OperationsRequestError(
          'OPERATIONS_BARCODE_LABEL_IDEMPOTENCY_REUSED',
          'Idempotency-Key was already used for a different barcode label batch',
          409,
        )
      }
      return batch(prior)
    }
    const warehouse = await client.query<{ id: string; name: string }>(
      `SELECT id::text, name
       FROM operations_warehouses
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND status = 'active'
       FOR SHARE`,
      [organizationId, warehouseGlobalId],
    )
    if (!warehouse.rows[0]) {
      throw new OperationsRequestError(
        'OPERATIONS_BARCODE_LABEL_WAREHOUSE_INVALID',
        'Active warehouse was not found',
        404,
      )
    }
    const copiesByGlobalId = new Map(selections.map((selection) => [selection.globalId, selection.copies]))
    const selectedGlobalIds = selections.map((selection) => selection.globalId)
    const items: BarcodeLabelItem[] = []
    if (input.targetType === 'product') {
      const products = await productRows(organizationId, selectedGlobalIds, client)
      if (products.rows.length !== selections.length) {
        throw new OperationsRequestError(
          'OPERATIONS_BARCODE_LABEL_PRODUCT_INVALID',
          'One or more active products were not found in this organization',
          404,
        )
      }
      for (const product of products.rows) {
        let resolved = resolvedProductBarcode(product)
        if (!resolved?.assigned) {
          const candidate = resolved || {
            value: internalProductBarcode(product.global_id),
            symbology: 'CODE128' as const,
            sourceIdentity: 'CODE128' as const,
            source: 'internal' as const,
            assigned: false,
          }
          await acquireTransactionAdvisoryLock(
            client,
            `operations:product-barcode:${organizationId}:${candidate.value}`,
          )
          const conflicting = await client.query<{ product_id: string }>(
            `SELECT product_id::text
             FROM operations_product_barcodes
             WHERE organization_id = $1::uuid AND barcode_value = $2
             FOR SHARE`,
            [organizationId, candidate.value],
          )
          if (conflicting.rows[0] && conflicting.rows[0].product_id !== product.id) {
            throw new OperationsRequestError(
              'OPERATIONS_PRODUCT_BARCODE_CONFLICT',
              'The selected product barcode is already assigned to another product',
              409,
            )
          }
          await client.query(
            `INSERT INTO operations_product_barcodes (
               organization_id, pipeline_id, product_id, barcode_value,
               symbology, source_identity, barcode_source, assigned_by
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)
             ON CONFLICT (organization_id, pipeline_id, product_id) DO NOTHING`,
            [
              organizationId,
              product.pipeline_id,
              product.id,
              candidate.value,
              candidate.symbology,
              candidate.sourceIdentity,
              candidate.source,
              actorEmail,
            ],
          )
          const assigned = await client.query<{
            barcode_value: string
            symbology: BarcodeLabelItem['symbology']
            source_identity: BarcodeLabelItem['sourceIdentity']
            barcode_source: 'provider' | 'internal'
          }>(
            `SELECT barcode_value, symbology, source_identity, barcode_source
             FROM operations_product_barcodes
             WHERE organization_id = $1::uuid
               AND pipeline_id = $2::uuid
               AND product_id = $3::uuid
             FOR SHARE`,
            [organizationId, product.pipeline_id, product.id],
          )
          const assignedRow = assigned.rows[0]
          if (!assignedRow) {
            throw new OperationsRequestError(
              'OPERATIONS_PRODUCT_BARCODE_ASSIGNMENT_FAILED',
              'The scan-authoritative product barcode could not be assigned',
              500,
            )
          }
          resolved = {
            value: required(assignedRow.barcode_value, 'Assigned product barcode', 120),
            symbology: assignedRow.symbology,
            sourceIdentity: assignedRow.source_identity,
            source: assignedRow.barcode_source,
            assigned: true,
          }
        }
        items.push({
          targetGlobalId: product.global_id,
          displayName: product.name,
          humanCode: product.sku || product.global_id.toUpperCase(),
          barcodeValue: resolved.value,
          symbology: resolved.symbology,
          sourceIdentity: resolved.sourceIdentity,
          barcodeSource: resolved.source,
          copies: copiesByGlobalId.get(product.global_id) || 1,
        })
      }
    } else {
      const locations = await locationRows(organizationId, selectedGlobalIds, client)
      if (
        locations.rows.length !== selections.length
        || locations.rows.some((location) => location.warehouse_global_id !== warehouseGlobalId)
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_BARCODE_LABEL_LOCATION_INVALID',
          'Every selected location must be active in the selected warehouse',
          404,
        )
      }
      for (const location of locations.rows) {
        items.push({
          targetGlobalId: location.global_id,
          displayName: location.code,
          humanCode: `${location.zone} - ${location.location_type}`,
          barcodeValue: locationBarcode(location.global_id),
          symbology: 'CODE128',
          sourceIdentity: 'LOCATION',
          barcodeSource: 'location',
          copies: copiesByGlobalId.get(location.global_id) || 1,
        })
      }
    }
    items.sort((left, right) => (
      selectedGlobalIds.indexOf(left.targetGlobalId) - selectedGlobalIds.indexOf(right.targetGlobalId)
    ))
    const snapshot: BarcodeLabelBatchSnapshot = {
      targetType: input.targetType,
      warehouseGlobalId,
      warehouseName: warehouse.rows[0].name,
      media: input.media,
      items,
    }
    const zpl = Buffer.from(renderBarcodeLabelsZpl(snapshot), 'utf8')
    const contentSha256 = crypto.createHash('sha256').update(zpl).digest('hex')
    if (!SHA256.test(contentSha256) || zpl.byteLength < 1 || zpl.byteLength > 10 * 1024 * 1024) {
      throw new OperationsRequestError(
        'OPERATIONS_BARCODE_LABEL_RENDER_FAILED',
        'Barcode label artifact could not be rendered',
        500,
      )
    }
    const insertedBatch = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_barcode_label_batches (
         organization_id, warehouse_id, target_type, media_size,
         label_count, items_snapshot, template_version, request_hash,
         idempotency_key, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8, $9, $10
       )
       RETURNING id::text, global_id`,
      [
        organizationId,
        warehouse.rows[0].id,
        input.targetType,
        input.media,
        items.reduce((sum, item) => sum + item.copies, 0),
        JSON.stringify(items),
        BARCODE_LABEL_TEMPLATE_VERSION,
        requestHash,
        idempotencyKey,
        actorEmail,
      ],
    )
    const created = insertedBatch.rows[0]
    const documentType = input.targetType === 'product' ? 'product_label' : 'location_label'
    const artifact = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_print_artifacts (
         organization_id, source_barcode_label_batch_id, document_type,
         format, media_size, content_sha256, byte_length,
         storage_reference, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'ZPL', $4, $5, $6,
         $7, $8
       )
       RETURNING id::text, global_id`,
      [
        organizationId,
        created.id,
        documentType,
        input.media,
        contentSha256,
        zpl.byteLength,
        `clawpilot-document:barcode-label/${created.global_id}`,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_print_artifact_payloads (
         artifact_id, organization_id, mime_type, filename, payload,
         template_version, render_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, 'application/vnd.zebra-zpl', $3, $4, $5, $6::jsonb
       )`,
      [
        artifact.rows[0].id,
        organizationId,
        `${input.targetType}-barcode-labels-${created.global_id}.zpl`,
        zpl,
        BARCODE_LABEL_TEMPLATE_VERSION,
        JSON.stringify(snapshot),
      ],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.barcode_labels.generated',
      aggregateType: 'operations.barcode_label_batch',
      aggregateId: created.global_id,
      eventKey: `operations:barcode-labels:generated:${created.global_id}`,
      organizationId,
      payload: {
        batchGlobalId: created.global_id,
        artifactGlobalId: artifact.rows[0].global_id,
        targetType: input.targetType,
        warehouseGlobalId,
        media: input.media,
        labelCount: items.reduce((sum, item) => sum + item.copies, 0),
        targets: items.map((item) => ({
          targetGlobalId: item.targetGlobalId,
          barcodeSource: item.barcodeSource,
          symbology: item.symbology,
          copies: item.copies,
        })),
        requestHash,
        contentSha256,
        printerDeliveryQueued: false,
      },
    }, client)
    const result = await replayBatch(client, organizationId, idempotencyKey)
    if (!result) {
      throw new OperationsRequestError(
        'OPERATIONS_BARCODE_LABEL_RENDER_FAILED',
        'Generated barcode label evidence could not be read',
        500,
      )
    }
    return batch(result)
  })
}

export async function readOperationsBarcodeLabelBatchPreviewFromPostgres(input: {
  organizationId: string
  batchGlobalId: string
}) {
  const organizationId = validOrganization(input.organizationId)
  const batchGlobalId = required(input.batchGlobalId, 'Barcode label batch', 16).toLowerCase()
  if (!BATCH_GLOBAL_ID.test(batchGlobalId)) {
    throw new OperationsRequestError('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Barcode label batch is invalid')
  }
  const result = await query<{
    global_id: string
    target_type: BarcodeLabelTargetType
    media_size: BarcodeLabelMedia
    items_snapshot: unknown
    warehouse_global_id: string
    warehouse_name: string
  }>(
    `SELECT label_batch.global_id,
            label_batch.target_type,
            label_batch.media_size,
            label_batch.items_snapshot,
            warehouse.global_id AS warehouse_global_id,
            warehouse.name AS warehouse_name
     FROM operations_barcode_label_batches label_batch
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = label_batch.organization_id
      AND warehouse.id = label_batch.warehouse_id
     WHERE label_batch.organization_id = $1::uuid
       AND label_batch.global_id = $2`,
    [organizationId, batchGlobalId],
  )
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'OPERATIONS_BARCODE_LABEL_BATCH_NOT_FOUND',
      'Barcode label batch was not found',
      404,
    )
  }
  const row = result.rows[0]
  const snapshot: BarcodeLabelBatchSnapshot = {
    targetType: row.target_type,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseName: row.warehouse_name,
    media: row.media_size,
    items: itemsSnapshot(row.items_snapshot),
  }
  return {
    batchGlobalId,
    html: renderBarcodeLabelsPreviewHtml(batchGlobalId, snapshot),
  }
}

export function assertBarcodeArtifactGlobalId(value: unknown) {
  const globalId = required(value, 'Barcode label artifact', 16).toLowerCase()
  if (!ARTIFACT_GLOBAL_ID.test(globalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_BARCODE_LABEL_REQUEST_INVALID',
      'Barcode label artifact is invalid',
    )
  }
  return globalId
}
