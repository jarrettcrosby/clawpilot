#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (relativePath) =>
  readFileSync(resolve(root, relativePath), 'utf8')

const migration = read(
  'db/migrations/0153_crm_product_image_assets.sql',
)
for (const contract of [
  'CREATE TABLE IF NOT EXISTS crm_product_image_assets',
  'content_bytes bytea NOT NULL',
  "mime_type IN ('image/png', 'image/jpeg', 'image/webp')",
  "content_sha256 = encode(digest(content_bytes, 'sha256'), 'hex')",
  'byte_length = octet_length(content_bytes)',
  'byte_length BETWEEN 1 AND 2097152',
  'pixel_width BETWEEN 1 AND 8192',
  'pixel_height BETWEEN 1 AND 8192',
  'pixel_width::bigint * pixel_height::bigint <= 40000000',
  'length(btrim(alt_text)) BETWEEN 1 AND 500',
  "source IN ('manual_upload', 'provider_import', 'migration')",
  'is_primary boolean NOT NULL DEFAULT false',
  'row_version bigint NOT NULL DEFAULT 1',
  'created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT',
  'updated_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT',
  'FOREIGN KEY (organization_id, pipeline_id)',
  'REFERENCES pipeline_spaces(workspace_organization_id, id)',
  'FOREIGN KEY (pipeline_id, product_id)',
  'REFERENCES crm_products(pipeline_id, id)',
  'idx_crm_product_image_assets_one_primary',
  'WHERE is_primary',
  'crm_product_image_assets_product_content_unique',
  'clawpilot_guard_crm_product_image_asset',
  'BEFORE UPDATE OR DELETE ON crm_product_image_assets',
  'CRM product image asset content is immutable',
  'row_version must advance by one',
]) {
  assert.ok(
    migration.includes(contract),
    `migration must include ${contract}`,
  )
}

const suiteCrmBackfillMigration = read(
  'db/migrations/0222_suitecrm_product_image_projection_backfill.sql',
)
for (const contract of [
  'asset.is_primary = true',
  'product.suitecrm_id IS NOT NULL',
  'COALESCE(organization.is_demo, false) = false',
  "'crm:products:image:v1:'",
  'INSERT INTO sync_outbox',
  "'upsert_record'",
  "'suitecrm'",
  "'productImage'",
  "'referenceCode'",
  "'contentSha256'",
  "'crm.product_image.suitecrm_backfill_queued'",
  'ON CONFLICT (target_system, idempotency_key)',
  'ON CONFLICT (event_key)',
]) {
  assert.ok(
    suiteCrmBackfillMigration.includes(contract),
    `SuiteCRM Product image backfill must include ${contract}`,
  )
}

const validation = read(
  'app_src/lib/crm/productImageAssets.ts',
)
for (const contract of [
  'CRM_PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024',
  'CRM_PRODUCT_IMAGE_MAX_DIMENSION = 8192',
  'CRM_PRODUCT_IMAGE_MAX_PIXELS = 40_000_000',
  'PNG_SIGNATURE',
  'pngCrc32',
  'JPEG_START_OF_FRAME_MARKERS',
  "ascii(bytes, 0, 4) !== 'RIFF'",
  "ascii(bytes, 8, 4) !== 'WEBP'",
  'u32le(bytes, 4) !== bytes.length - 8',
  'declaredMimeType !== mimeType',
  "createHash('sha256')",
]) {
  assert.ok(
    validation.includes(contract),
    `validation must include ${contract}`,
  )
}

const persistence = read(
  'app_src/lib/persistence/crmProductImageAssets.ts',
)
for (const contract of [
  'validateCrmProductImage',
  'readCrmProductImageAssetBytesInPostgres',
  'acquireTransactionAdvisoryLock',
  'pipeline.workspace_organization_id = $1::uuid',
  'product.id = $2::uuid',
  'asset.organization_id = $1::uuid',
  'asset.pipeline_id = $2::uuid',
  'asset.product_id = $3::uuid',
  'content_sha256 = $4',
  "'manual_upload'",
  'row_version = row_version + 1',
  'recordAuditEvent',
  "'crm.product_image.uploaded'",
  "'crm.product_image.primary_changed'",
  'CRM_PRODUCT_IMAGE_REVISION_CONFLICT',
  'readPublicCrmProductImageAssetBytesInPostgres',
  'asset.content_sha256 = $2',
  'CRM_PRODUCT_IMAGE_EVIDENCE_CORRUPT',
  'enqueueSuiteCrmProductImageProjectionWithClient',
]) {
  assert.ok(
    persistence.includes(contract),
    `persistence must include ${contract}`,
  )
}
assert.doesNotMatch(persistence, /shopify/i)
assert.doesNotMatch(persistence, /\bfetch\s*\(/)
assert.doesNotMatch(persistence, /DELETE FROM crm_product_image_assets/i)

const publicUrl = read(
  'app_src/lib/crm/productImagePublic.ts',
)
for (const contract of [
  "globalIdPattern('gp')",
  '/^[0-9a-f]{64}$/',
  'url.protocol',
  'url.username',
  'url.password',
  'url.pathname',
  'SUITECRM_PRODUCT_IMAGE_MAX_URL_LENGTH = 255',
  '/api/public/crm-product-images/',
]) {
  assert.ok(
    publicUrl.includes(contract),
    `public Product image URL must include ${contract}`,
  )
}

const projection = read(
  'app_src/lib/persistence/suiteCrmProductImageProjection.ts',
)
for (const contract of [
  'enqueueSuiteCrmProductImageProjectionWithClient',
  'asset.is_primary = true',
  'image_asset.asset_revision',
  'image_asset.row_version',
  'image_asset.content_sha256',
  'crm:products:image:v1:',
  'INSERT INTO sync_outbox',
  "target_system, payload",
  "'suitecrm'",
  'productImage:',
  "'crm.product_image.suitecrm_queued'",
  "projection: row.image_asset_id ? 'set' : 'clear'",
]) {
  assert.ok(
    projection.includes(contract),
    `SuiteCRM Product image projection must include ${contract}`,
  )
}

const suiteCrmClient = read(
  'app_src/lib/crm/suiteCrmClient.ts',
)
for (const contract of [
  'record.productImage === null',
  "attributes.product_image = ''",
  'record.productImage !== undefined',
  'publicCrmProductImageUrl',
  'record.productImage.referenceCode',
  'record.productImage.contentSha256',
]) {
  assert.ok(
    suiteCrmClient.includes(contract),
    `SuiteCRM Product image transport must include ${contract}`,
  )
}

const route = read(
  'app_src/app/api/crm/products/[productId]/images/route.ts',
)
for (const contract of [
  'requireRequestUser(req)',
  "role !== 'owner' && role !== 'admin'",
  'actor.organizationId',
  'isPostgresStorageEnabled()',
  'context: { params: Promise<{ productId: string }> }',
  "startsWith('multipart/form-data;')",
  "form.get('image')",
  "form.get('altText')",
  "form.get('setPrimary')",
  'CRM_PRODUCT_IMAGE_MAX_BYTES + MAX_MULTIPART_OVERHEAD_BYTES',
  'image.type',
  'export async function GET',
  'export async function POST',
  'export async function PATCH',
  "body.action !== 'set-primary'",
  'expectedRowVersion',
  'setPrimaryCrmProductImageAssetInPostgres',
  'assertSameOrigin(req)',
  'isBrowserSameOriginRequest',
  'appPublicUrl()',
  "'Cache-Control': 'private, no-store, max-age=0'",
]) {
  assert.ok(route.includes(contract), `route must include ${contract}`)
}
assert.doesNotMatch(route, /form\.get\(['"]organizationId['"]\)/)
assert.doesNotMatch(route, /body\.organizationId/)
assert.doesNotMatch(route, /shopify/i)
assert.doesNotMatch(route, /\bfetch\s*\(/)

const previewRoute = read(
  'app_src/app/api/crm/products/[productId]/images/[assetId]/route.ts',
)
for (const contract of [
  'requireRequestUser(req)',
  "role !== 'owner' && role !== 'admin'",
  'actor.organizationId',
  'readCrmProductImageAssetBytesInPostgres',
  "'Cache-Control': 'private, no-store, max-age=0'",
  "'Cross-Origin-Resource-Policy': 'same-origin'",
  "'X-Content-Type-Options': 'nosniff'",
  "'Content-Disposition': 'inline'",
]) {
  assert.ok(
    previewRoute.includes(contract),
    `preview route must include ${contract}`,
  )
}
assert.doesNotMatch(previewRoute, /body\.organizationId/)
assert.doesNotMatch(previewRoute, /\bfetch\s*\(/)

const publicRoute = read(
  'app_src/app/api/public/crm-product-images/[referenceCode]/[contentSha256]/route.ts',
)
for (const contract of [
  'readPublicCrmProductImageAssetBytesInPostgres',
  'CRM_PRODUCT_IMAGE_PUBLIC_REFERENCE_PATTERN',
  'CRM_PRODUCT_IMAGE_PUBLIC_CONTENT_SHA256_PATTERN',
  "'Cache-Control': 'public, max-age=31536000, immutable'",
  "'Cross-Origin-Resource-Policy': 'cross-origin'",
  "'X-Content-Type-Options': 'nosniff'",
  "'Content-Disposition': 'inline'",
  "req.headers.get('if-none-match')",
  'status: 304',
  'status: 404',
]) {
  assert.ok(
    publicRoute.includes(contract),
    `public Product image route must include ${contract}`,
  )
}
assert.doesNotMatch(publicRoute, /requireRequestUser/)
assert.doesNotMatch(publicRoute, /shopify/i)

const providerImport = read(
  'app_src/lib/persistence/commerceProductImageImports.ts',
)
for (const contract of [
  'Promise<boolean>',
  'const primaryChanged = await electCurrentProviderImagePrimary',
  'const priorPrimaryChanged = await electCurrentProviderImagePrimary',
  'const currentPrimaryChanged = await electCurrentProviderImagePrimary',
  'enqueueSuiteCrmProductImageProjectionWithClient',
]) {
  assert.ok(
    providerImport.includes(contract),
    `provider primary projection must include ${contract}`,
  )
}

console.log('CRM Product image asset contract checks passed')
