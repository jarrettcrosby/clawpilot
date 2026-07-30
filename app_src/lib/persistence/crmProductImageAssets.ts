import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  CRM_PRODUCT_IMAGE_MAX_BYTES,
  CRM_PRODUCT_IMAGE_MAX_DIMENSION,
  CRM_PRODUCT_IMAGE_MAX_PIXELS,
  CRM_PRODUCT_IMAGE_MIME_TYPES,
  CrmProductImageAssetError,
  validateCrmProductImage,
  type CrmProductImageMimeType,
} from '@/lib/crm/productImageAssets'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

export type CrmProductImageAssetSource =
  | 'manual_upload'
  | 'provider_import'
  | 'migration'

export type CrmProductImageAsset = {
  id: string
  productId: string
  assetRevision: number
  rowVersion: number
  mimeType: CrmProductImageMimeType
  contentSha256: string
  byteLength: number
  pixelWidth: number
  pixelHeight: number
  altText: string
  source: CrmProductImageAssetSource
  isPrimary: boolean
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export type CrmProductImageAssetState = {
  product: {
    id: string
    referenceCode: string
    pipelineId: string
    name: string
  }
  assets: CrmProductImageAsset[]
}

export type CrmProductImageAssetBytes = {
  bytes: Uint8Array
  mimeType: CrmProductImageMimeType
  contentSha256: string
  byteLength: number
  altText: string
}

type ProductRow = QueryResultRow & {
  id: string
  pipeline_id: string
  reference_code: string
  name: string
}

type AssetRow = QueryResultRow & {
  id: string
  product_id: string
  asset_revision: string | number
  row_version: string | number
  mime_type: string
  content_sha256: string
  byte_length: number
  pixel_width: number
  pixel_height: number
  alt_text: string
  source: string
  is_primary: boolean
  created_by: string
  updated_by: string
  created_at: Date | string
  updated_at: Date | string
}

const ASSET_PROJECTION = `
  SELECT
    asset.id::text,
    asset.product_id::text,
    asset.asset_revision::text,
    asset.row_version::text,
    asset.mime_type,
    asset.content_sha256,
    asset.byte_length,
    asset.pixel_width,
    asset.pixel_height,
    asset.alt_text,
    asset.source,
    asset.is_primary,
    asset.created_by,
    asset.updated_by,
    asset.created_at,
    asset.updated_at
  FROM crm_product_image_assets asset
`

function fail(code: string, message: string, status = 400): never {
  throw new CrmProductImageAssetError(code, message, status)
}

function safePositiveInteger(
  value: string | number,
  label: string,
): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(
      'CRM_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
      `Stored Product image ${label} is invalid`,
      500,
    )
  }
  return parsed
}

function iso(value: Date | string, label: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    fail(
      'CRM_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
      `Stored Product image ${label} is invalid`,
      500,
    )
  }
  return parsed.toISOString()
}

function toAsset(row: AssetRow): CrmProductImageAsset {
  if (
    !CRM_PRODUCT_IMAGE_MIME_TYPES.includes(
      row.mime_type as CrmProductImageMimeType,
    )
    || !/^[0-9a-f]{64}$/.test(row.content_sha256)
    || !Number.isSafeInteger(row.byte_length)
    || row.byte_length < 1
    || row.byte_length > CRM_PRODUCT_IMAGE_MAX_BYTES
    || !Number.isSafeInteger(row.pixel_width)
    || !Number.isSafeInteger(row.pixel_height)
    || row.pixel_width < 1
    || row.pixel_height < 1
    || row.pixel_width > CRM_PRODUCT_IMAGE_MAX_DIMENSION
    || row.pixel_height > CRM_PRODUCT_IMAGE_MAX_DIMENSION
    || row.pixel_width * row.pixel_height > CRM_PRODUCT_IMAGE_MAX_PIXELS
    || !row.alt_text.trim()
    || !['manual_upload', 'provider_import', 'migration'].includes(row.source)
    || typeof row.created_by !== 'string'
    || !row.created_by.trim()
    || typeof row.updated_by !== 'string'
    || !row.updated_by.trim()
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
      'Stored Product image evidence is invalid',
      500,
    )
  }
  return {
    id: row.id,
    productId: row.product_id,
    assetRevision: safePositiveInteger(row.asset_revision, 'revision'),
    rowVersion: safePositiveInteger(row.row_version, 'row version'),
    mimeType: row.mime_type as CrmProductImageMimeType,
    contentSha256: row.content_sha256,
    byteLength: row.byte_length,
    pixelWidth: row.pixel_width,
    pixelHeight: row.pixel_height,
    altText: row.alt_text,
    source: row.source as CrmProductImageAssetSource,
    isPrimary: row.is_primary === true,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at, 'creation timestamp'),
    updatedAt: iso(row.updated_at, 'update timestamp'),
  }
}

async function resolveProduct(
  client: PoolClient,
  organizationId: string,
  productId: string,
  lock: 'share' | 'update',
): Promise<ProductRow> {
  const result = await client.query<ProductRow>(
    `SELECT
       product.id::text,
       product.pipeline_id::text,
       product.reference_code,
       product.name
     FROM crm_products product
     JOIN pipeline_spaces pipeline
       ON pipeline.id = product.pipeline_id
      AND pipeline.workspace_organization_id = $1::uuid
     WHERE product.id = $2::uuid
     LIMIT 1
     ${lock === 'update' ? 'FOR UPDATE OF product' : 'FOR SHARE OF product'}`,
    [organizationId, productId],
  )
  if (!result.rows[0]) {
    fail(
      'CRM_PRODUCT_IMAGE_PRODUCT_NOT_FOUND',
      'Product was not found in the active organization',
      404,
    )
  }
  return result.rows[0]
}

async function listAssets(
  client: PoolClient,
  organizationId: string,
  product: ProductRow,
): Promise<CrmProductImageAsset[]> {
  const result = await client.query<AssetRow>(
    `${ASSET_PROJECTION}
     WHERE asset.organization_id = $1::uuid
       AND asset.pipeline_id = $2::uuid
       AND asset.product_id = $3::uuid
     ORDER BY asset.is_primary DESC, asset.asset_revision, asset.id`,
    [organizationId, product.pipeline_id, product.id],
  )
  const assets = result.rows.map(toAsset)
  if (assets.filter((asset) => asset.isPrimary).length > 1) {
    fail(
      'CRM_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
      'Stored Product image primary evidence is invalid',
      500,
    )
  }
  return assets
}

async function state(
  client: PoolClient,
  organizationId: string,
  product: ProductRow,
): Promise<CrmProductImageAssetState> {
  return {
    product: {
      id: product.id,
      referenceCode: product.reference_code,
      pipelineId: product.pipeline_id,
      name: product.name,
    },
    assets: await listAssets(client, organizationId, product),
  }
}

export async function listCrmProductImageAssetsInPostgres(input: {
  organizationId: string
  productId: string
}): Promise<CrmProductImageAssetState> {
  return withTransaction(async (client) => {
    const product = await resolveProduct(
      client,
      input.organizationId,
      input.productId,
      'share',
    )
    return state(client, input.organizationId, product)
  })
}

export async function readCrmProductImageAssetBytesInPostgres(input: {
  organizationId: string
  productId: string
  assetId: string
}): Promise<CrmProductImageAssetBytes> {
  return withTransaction(async (client) => {
    const product = await resolveProduct(
      client,
      input.organizationId,
      input.productId,
      'share',
    )
    const result = await client.query<{
      content_bytes: Buffer
      mime_type: string
      content_sha256: string
      byte_length: number
      pixel_width: number
      pixel_height: number
      alt_text: string
    }>(
      `SELECT
         content_bytes,
         mime_type,
         content_sha256,
         byte_length,
         pixel_width,
         pixel_height,
         alt_text
       FROM crm_product_image_assets
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND product_id = $3::uuid
         AND id = $4::uuid
       LIMIT 1
       FOR SHARE`,
      [
        input.organizationId,
        product.pipeline_id,
        product.id,
        input.assetId,
      ],
    )
    const row = result.rows[0]
    if (!row || !Buffer.isBuffer(row.content_bytes)) {
      fail(
        'CRM_PRODUCT_IMAGE_ASSET_NOT_FOUND',
        'Product image was not found for this Product',
        404,
      )
    }
    const validated = validateCrmProductImage({
      bytes: new Uint8Array(row.content_bytes),
      declaredMimeType: row.mime_type,
      altText: row.alt_text,
    })
    if (
      validated.contentSha256 !== row.content_sha256
      || validated.byteLength !== row.byte_length
      || validated.pixelWidth !== row.pixel_width
      || validated.pixelHeight !== row.pixel_height
    ) {
      fail(
        'CRM_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
        'Stored Product image bytes do not match their immutable evidence',
        500,
      )
    }
    return {
      bytes: validated.bytes,
      mimeType: validated.mimeType,
      contentSha256: validated.contentSha256,
      byteLength: validated.byteLength,
      altText: validated.altText,
    }
  })
}

export async function uploadCrmProductImageAssetInPostgres(input: {
  organizationId: string
  productId: string
  actorEmail: string
  bytes: Uint8Array
  declaredMimeType: unknown
  altText: unknown
  setPrimary: boolean
}): Promise<CrmProductImageAssetState> {
  const image = validateCrmProductImage({
    bytes: input.bytes,
    declaredMimeType: input.declaredMimeType,
    altText: input.altText,
  })
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `crm-product-images:${input.organizationId}:${input.productId}`,
    )
    const product = await resolveProduct(
      client,
      input.organizationId,
      input.productId,
      'update',
    )
    const duplicate = await client.query<{ id: string }>(
      `SELECT id::text
       FROM crm_product_image_assets
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND product_id = $3::uuid
         AND content_sha256 = $4
       LIMIT 1`,
      [
        input.organizationId,
        product.pipeline_id,
        product.id,
        image.contentSha256,
      ],
    )
    if (duplicate.rows[0]) {
      fail(
        'CRM_PRODUCT_IMAGE_DUPLICATE',
        'This Product image has already been uploaded',
        409,
      )
    }
    const current = await client.query<{
      next_revision: string
      has_primary: boolean
    }>(
      `SELECT
         (COALESCE(max(asset_revision), 0) + 1)::text AS next_revision,
         COALESCE(bool_or(is_primary), false) AS has_primary
       FROM crm_product_image_assets
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND product_id = $3::uuid`,
      [input.organizationId, product.pipeline_id, product.id],
    )
    const assetRevision = safePositiveInteger(
      current.rows[0]?.next_revision || 1,
      'next revision',
    )
    const makePrimary = input.setPrimary || current.rows[0]?.has_primary !== true
    let previousPrimaryAssetIds: string[] = []
    if (makePrimary) {
      const demoted = await client.query<{ id: string }>(
        `UPDATE crm_product_image_assets
         SET is_primary = false,
             row_version = row_version + 1,
             updated_by = $4,
             updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid
           AND pipeline_id = $2::uuid
           AND product_id = $3::uuid
           AND is_primary = true
         RETURNING id::text`,
        [
          input.organizationId,
          product.pipeline_id,
          product.id,
          input.actorEmail,
        ],
      )
      previousPrimaryAssetIds = demoted.rows.map((row) => row.id)
    }
    const inserted = await client.query<{ id: string; row_version: string }>(
      `INSERT INTO crm_product_image_assets (
         organization_id,
         pipeline_id,
         product_id,
         asset_revision,
         content_bytes,
         mime_type,
         content_sha256,
         byte_length,
         pixel_width,
         pixel_height,
         alt_text,
         source,
         is_primary,
         row_version,
         created_by,
         updated_by,
         created_at,
         updated_at
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11,
         'manual_upload',
         $12,
         1,
         $13,
         $13,
         clock_timestamp(),
         clock_timestamp()
       )
       RETURNING id::text, row_version::text`,
      [
        input.organizationId,
        product.pipeline_id,
        product.id,
        assetRevision,
        Buffer.from(image.bytes),
        image.mimeType,
        image.contentSha256,
        image.byteLength,
        image.pixelWidth,
        image.pixelHeight,
        image.altText,
        makePrimary,
        input.actorEmail,
      ],
    )
    const saved = inserted.rows[0]
    if (!saved) {
      fail(
        'CRM_PRODUCT_IMAGE_SAVE_FAILED',
        'Product image could not be saved',
        500,
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'crm.product_image.uploaded',
      aggregateType: 'crm_product_image_asset',
      aggregateId: saved.id,
      organizationId: input.organizationId,
      eventKey: `crm-product-image-uploaded:${input.organizationId}:${saved.id}`,
      payload: {
        productId: product.id,
        productReferenceCode: product.reference_code,
        pipelineId: product.pipeline_id,
        assetId: saved.id,
        assetRevision,
        rowVersion: safePositiveInteger(saved.row_version, 'row version'),
        mimeType: image.mimeType,
        contentSha256: image.contentSha256,
        byteLength: image.byteLength,
        pixelWidth: image.pixelWidth,
        pixelHeight: image.pixelHeight,
        source: 'manual_upload',
        isPrimary: makePrimary,
        previousPrimaryAssetIds,
      },
    }, client)
    return state(client, input.organizationId, product)
  })
}

export async function setPrimaryCrmProductImageAssetInPostgres(input: {
  organizationId: string
  productId: string
  assetId: string
  expectedRowVersion: number
  actorEmail: string
}): Promise<CrmProductImageAssetState> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `crm-product-images:${input.organizationId}:${input.productId}`,
    )
    const product = await resolveProduct(
      client,
      input.organizationId,
      input.productId,
      'update',
    )
    const targetResult = await client.query<{
      id: string
      row_version: string
      is_primary: boolean
    }>(
      `SELECT id::text, row_version::text, is_primary
       FROM crm_product_image_assets
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND product_id = $3::uuid
         AND id = $4::uuid
       LIMIT 1
       FOR UPDATE`,
      [
        input.organizationId,
        product.pipeline_id,
        product.id,
        input.assetId,
      ],
    )
    const target = targetResult.rows[0]
    if (!target) {
      fail(
        'CRM_PRODUCT_IMAGE_ASSET_NOT_FOUND',
        'Product image was not found for this Product',
        404,
      )
    }
    const currentRowVersion = safePositiveInteger(
      target.row_version,
      'row version',
    )
    if (currentRowVersion !== input.expectedRowVersion) {
      fail(
        'CRM_PRODUCT_IMAGE_REVISION_CONFLICT',
        'Product image changed after it was loaded',
        409,
      )
    }
    if (target.is_primary) {
      return state(client, input.organizationId, product)
    }
    const demoted = await client.query<{ id: string }>(
      `UPDATE crm_product_image_assets
       SET is_primary = false,
           row_version = row_version + 1,
           updated_by = $5,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND product_id = $3::uuid
         AND id <> $4::uuid
         AND is_primary = true
       RETURNING id::text`,
      [
        input.organizationId,
        product.pipeline_id,
        product.id,
        input.assetId,
        input.actorEmail,
      ],
    )
    const promoted = await client.query<{ row_version: string }>(
      `UPDATE crm_product_image_assets
       SET is_primary = true,
           row_version = row_version + 1,
           updated_by = $6,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND product_id = $3::uuid
         AND id = $4::uuid
         AND row_version = $5
         AND is_primary = false
       RETURNING row_version::text`,
      [
        input.organizationId,
        product.pipeline_id,
        product.id,
        input.assetId,
        input.expectedRowVersion,
        input.actorEmail,
      ],
    )
    const nextRowVersion = promoted.rows[0]?.row_version
    if (!nextRowVersion) {
      fail(
        'CRM_PRODUCT_IMAGE_REVISION_CONFLICT',
        'Product image changed after it was loaded',
        409,
      )
    }
    const rowVersion = safePositiveInteger(nextRowVersion, 'row version')
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'crm.product_image.primary_changed',
      aggregateType: 'crm_product_image_asset',
      aggregateId: input.assetId,
      organizationId: input.organizationId,
      eventKey: `crm-product-image-primary:${input.organizationId}:${input.assetId}:${rowVersion}`,
      payload: {
        productId: product.id,
        productReferenceCode: product.reference_code,
        pipelineId: product.pipeline_id,
        assetId: input.assetId,
        rowVersion,
        previousPrimaryAssetIds: demoted.rows.map((row) => row.id),
      },
    }, client)
    return state(client, input.organizationId, product)
  })
}
