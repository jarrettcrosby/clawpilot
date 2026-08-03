#!/usr/bin/env node

import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

export const SCRIPT_VERSION =
  'suitecrm-native-product-image-reprojection-v1'
export const CONFIRMATION_VARIABLE =
  'CLAWPILOT_SUITECRM_IMAGE_REPROJECT_CONFIRM'
export const ACTOR_VARIABLE =
  'CLAWPILOT_SUITECRM_IMAGE_REPROJECT_ACTOR'

const PRODUCT_REFERENCE_PATTERN =
  /^gp(?:[0-9]{7}|[0-9a-v]{12})$/u
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u

function fail(message) {
  throw new Error(message)
}

function clean(value) {
  return String(value ?? '').trim()
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    )
  }
  return value
}

export function stableDigest(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)), 'utf8')
    .digest('hex')
}

function parseArgs(argv) {
  let productReferenceCode = ''
  let apply = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (arg === '--product') {
      productReferenceCode = clean(argv[index + 1]).toLowerCase()
      index += 1
      continue
    }
    fail(`Unknown argument: ${arg}`)
  }
  if (!PRODUCT_REFERENCE_PATTERN.test(productReferenceCode)) {
    fail('--product requires one exact Product Global ID')
  }
  return { apply, productReferenceCode }
}

function exactOrigin(value, label, allowPrivateRailwayHttp = false) {
  const raw = clean(value)
  if (!raw) return false
  try {
    const url = new URL(raw)
    const privateRailway = allowPrivateRailwayHttp
      && url.protocol === 'http:'
      && url.hostname.endsWith('.railway.internal')
    const local = url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    return Boolean(
      (url.protocol === 'https:' || privateRailway || local)
      && !url.username
      && !url.password
      && url.pathname === '/'
      && !url.search
      && !url.hash
    )
  } catch {
    return false
  }
}

function comparableCredential(name, value) {
  return name.endsWith('_USERNAME') || name.endsWith('_USER')
    ? clean(value).toLowerCase()
    : String(value ?? '')
}

export function nativeProjectionConfiguration(environment = process.env) {
  const required = [
    'SUITECRM_BASE_URL',
    'CLAWPILOT_PUBLIC_URL',
    'SUITECRM_MEDIA_USERNAME',
    'SUITECRM_MEDIA_PASSWORD',
  ]
  const missing = required.filter((name) => !clean(environment[name]))
  const invalid = []
  if (
    !missing.includes('SUITECRM_BASE_URL')
    && !exactOrigin(environment.SUITECRM_BASE_URL, 'SUITECRM_BASE_URL', true)
  ) invalid.push('SUITECRM_BASE_URL')
  if (
    !missing.includes('CLAWPILOT_PUBLIC_URL')
    && !exactOrigin(environment.CLAWPILOT_PUBLIC_URL, 'CLAWPILOT_PUBLIC_URL')
  ) invalid.push('CLAWPILOT_PUBLIC_URL')
  if (
    !missing.includes('SUITECRM_MEDIA_USERNAME')
    && (
      clean(environment.SUITECRM_MEDIA_USERNAME).length > 255
      || CONTROL_CHARACTER_PATTERN.test(environment.SUITECRM_MEDIA_USERNAME)
    )
  ) invalid.push('SUITECRM_MEDIA_USERNAME')
  if (
    !missing.includes('SUITECRM_MEDIA_PASSWORD')
    && (
      String(environment.SUITECRM_MEDIA_PASSWORD).length > 4096
      || CONTROL_CHARACTER_PATTERN.test(environment.SUITECRM_MEDIA_PASSWORD)
    )
  ) invalid.push('SUITECRM_MEDIA_PASSWORD')
  const mediaNames = ['SUITECRM_MEDIA_USERNAME', 'SUITECRM_MEDIA_PASSWORD']
  const otherNames = [
    'SUITECRM_ADMIN_USER',
    'SUITECRM_ADMIN_USERNAME',
    'SUITECRM_ADMIN_PASSWORD',
    'SUITECRM_CLIENT_ID',
    'SUITECRM_CLIENT_SECRET',
    'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID',
    'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET',
    'SUITECRM_PRODUCT_IMAGE_READ_USERNAME',
    'SUITECRM_PRODUCT_IMAGE_READ_PASSWORD',
  ]
  const credentialConflicts = mediaNames.flatMap((mediaName) => {
    const mediaValue = comparableCredential(mediaName, environment[mediaName])
    if (!mediaValue) return []
    return otherNames
      .filter((otherName) => (
        mediaValue === comparableCredential(otherName, environment[otherName])
        && comparableCredential(otherName, environment[otherName]).length > 0
      ))
      .map((otherName) => `${mediaName}:${otherName}`)
  })
  const enabled = environment.SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED
    === '1'
  return {
    enabled,
    ready: enabled
      && missing.length === 0
      && invalid.length === 0
      && credentialConflicts.length === 0,
    missing,
    invalid,
    credentialConflicts,
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`Product ${label} is invalid`)
  }
  return parsed
}

function finiteMoney(value, label) {
  const parsed = Number(value || 0)
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(`Product ${label} is invalid`)
  }
  return parsed
}

async function loadTarget(client, productReferenceCode, lock = false) {
  const products = await client.query(
    `SELECT
       pipeline.workspace_organization_id::text AS organization_id,
       pipeline.owner_email,
       product.pipeline_id::text,
       product.id::text AS product_id,
       product.suitecrm_id,
       product.reference_code,
       product.name,
       product.sku,
       product.product_type,
       product.category,
       product.cost::text,
       product.price::text,
       product.currency,
       product.url,
       product.description
     FROM crm_products product
     JOIN pipeline_spaces pipeline ON pipeline.id = product.pipeline_id
     WHERE product.reference_code = $1
     LIMIT 2
     ${lock ? 'FOR UPDATE OF product' : ''}`,
    [productReferenceCode],
  )
  if (products.rows.length !== 1) {
    fail('Product Global ID did not resolve to exactly one CRM Product')
  }
  const product = products.rows[0]
  const assets = await client.query(
    `SELECT id::text AS image_asset_id,
       asset_revision::text AS image_asset_revision,
       row_version::text AS image_row_version,
       content_sha256 AS image_content_sha256
     FROM crm_product_image_assets
     WHERE organization_id = $1::uuid
       AND pipeline_id = $2::uuid
       AND product_id = $3::uuid
       AND is_primary = true
     ORDER BY asset_revision, id
     LIMIT 2
     ${lock ? 'FOR UPDATE' : ''}`,
    [product.organization_id, product.pipeline_id, product.product_id],
  )
  if (assets.rows.length !== 1) {
    fail('Product must have exactly one current primary image')
  }
  if (!product.suitecrm_id) {
    fail('Product has no SuiteCRM identity')
  }
  const asset = assets.rows[0]
  if (!HASH_PATTERN.test(asset.image_content_sha256 || '')) {
    fail('Product primary image content identity is invalid')
  }
  return {
    ...product,
    ...asset,
    image_asset_revision: positiveInteger(
      asset.image_asset_revision,
      'primary image asset revision',
    ),
    image_row_version: positiveInteger(
      asset.image_row_version,
      'primary image row version',
    ),
  }
}

export function targetFingerprint(target) {
  return stableDigest({
    scriptVersion: SCRIPT_VERSION,
    organizationId: target.organization_id,
    pipelineId: target.pipeline_id,
    productId: target.product_id,
    suiteCrmId: target.suitecrm_id,
    productReferenceCode: target.reference_code,
    imageAssetId: target.image_asset_id,
    imageAssetRevision: Number(target.image_asset_revision),
    imageRowVersion: Number(target.image_row_version),
    imageContentSha256: target.image_content_sha256,
  })
}

export function confirmationForTarget(target) {
  return `suitecrm-native-product-image:${target.reference_code}:${
    targetFingerprint(target)
  }`
}

function projectionPayload(target) {
  return {
    entity: 'products',
    pipelineId: target.pipeline_id,
    localId: target.product_id,
    suiteCrmId: target.suitecrm_id,
    attributes: {
      global_id_c: target.reference_code,
      name: clean(target.name),
      part_number: clean(target.sku),
      type: clean(target.product_type) || 'Good',
      category: clean(target.category),
      cost: finiteMoney(target.cost, 'cost'),
      price: finiteMoney(target.price, 'price'),
      url: clean(target.url),
      description: clean(target.description),
    },
    currencyCode: clean(target.currency || 'USD').toUpperCase(),
    productImage: {
      referenceCode: target.reference_code,
      contentSha256: target.image_content_sha256,
    },
    productImageProjectionRequired: true,
  }
}

function idempotencyKey(target) {
  return `crm:products:image:v1:${target.product_id}:${
    target.image_asset_id
  }:${target.image_asset_revision}:${target.image_row_version}:${
    target.image_content_sha256
  }`
}

async function loadState(client, target) {
  const key = idempotencyKey(target)
  const state = await client.query(
    `SELECT id::text, status, attempts, payload
     FROM sync_outbox
     WHERE target_system = 'suitecrm'
       AND idempotency_key = $1
     LIMIT 1`,
    [key],
  )
  const latestResult = await client.query(
    `SELECT payload, created_at::text
     FROM audit_events
     WHERE event_type =
         'crm.product_image.suitecrm_native_projection_completed'
       AND aggregate_type = 'crm_product'
       AND aggregate_id = $1
       AND payload->>'suiteCrmId' = $2
       AND payload->>'imageContentSha256' = $3
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [target.product_id, target.suitecrm_id, target.image_content_sha256],
  )
  const evidence = latestResult.rows[0] || null
  const action = clean(evidence?.payload?.action)
  const mediaId = clean(evidence?.payload?.mediaId)
  return {
    idempotencyKey: key,
    outbox: state.rows[0] || null,
    latestResult: evidence,
    alreadyProjected: (
      (action === 'attached' || action === 'unchanged')
      && UUID_PATTERN.test(mediaId)
    ),
  }
}

function publicPlan(target, state, configuration) {
  const fingerprint = targetFingerprint(target)
  return {
    scriptVersion: SCRIPT_VERSION,
    productReferenceCode: target.reference_code,
    productId: target.product_id,
    pipelineId: target.pipeline_id,
    organizationId: target.organization_id,
    suiteCrmId: target.suitecrm_id,
    imageAssetId: target.image_asset_id,
    imageAssetRevision: target.image_asset_revision,
    imageRowVersion: target.image_row_version,
    imageContentSha256: target.image_content_sha256,
    outboxId: state.outbox?.id || null,
    outboxStatus: state.outbox?.status || null,
    alreadyProjected: state.alreadyProjected,
    latestNativeResult: state.latestResult?.payload || null,
    latestNativeResultAt: state.latestResult?.created_at || null,
    nativeProjection: configuration,
    planFingerprint: fingerprint,
    confirmation: confirmationForTarget(target),
    providerWrites: 0,
  }
}

async function requireAuthorizedActor(client, target, actorEmail) {
  if (!actorEmail || !actorEmail.includes('@')) {
    fail(`${ACTOR_VARIABLE} must be an exact active owner or administrator email`)
  }
  const membership = await client.query(
    `SELECT membership.role
     FROM app_user_organization_memberships membership
     JOIN app_users app_user ON app_user.email = membership.user_email
     WHERE lower(membership.user_email) = lower($1)
       AND membership.organization_id = $2::uuid
       AND membership.status = 'active'
       AND app_user.status = 'active'
       AND membership.role IN ('owner', 'admin')
     LIMIT 1`,
    [actorEmail, target.organization_id],
  )
  if (!membership.rows[0]) {
    fail('Reprojection actor is not an active owner or administrator for the Product organization')
  }
}

async function applyPlan(client, plannedTarget, actorEmail) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    [`suitecrm-native-product-image:${plannedTarget.product_id}`],
  )
  const target = await loadTarget(
    client,
    plannedTarget.reference_code,
    true,
  )
  if (targetFingerprint(target) !== targetFingerprint(plannedTarget)) {
    fail('Product or primary image changed after the reviewed plan')
  }
  await requireAuthorizedActor(client, target, actorEmail)
  const state = await loadState(client, target)
  if (state.alreadyProjected) {
    return { changed: false, reason: 'already_projected', state }
  }
  const payload = projectionPayload(target)
  const queued = await client.query(
    `INSERT INTO sync_outbox (
       aggregate_type, aggregate_id, operation, target_system, payload,
       status, idempotency_key, attempts, created_at, available_at,
       updated_at
     ) VALUES (
       'crm_products', $1, 'upsert_record', 'suitecrm', $2::jsonb,
       'queued', $3, 0, now(), now(), now()
     )
     ON CONFLICT (target_system, idempotency_key)
     WHERE idempotency_key IS NOT NULL
     DO UPDATE SET
       payload = EXCLUDED.payload,
       status = CASE
         WHEN sync_outbox.status IN ('succeeded', 'dead') THEN 'queued'
         ELSE sync_outbox.status
       END,
       attempts = CASE
         WHEN sync_outbox.status IN ('succeeded', 'dead') THEN 0
         ELSE sync_outbox.attempts
       END,
       last_error = CASE
         WHEN sync_outbox.status IN ('succeeded', 'dead') THEN NULL
         ELSE sync_outbox.last_error
       END,
       available_at = CASE
         WHEN sync_outbox.status IN ('succeeded', 'dead') THEN now()
         ELSE sync_outbox.available_at
       END,
       processed_at = CASE
         WHEN sync_outbox.status IN ('succeeded', 'dead') THEN NULL
         ELSE sync_outbox.processed_at
       END,
       locked_at = CASE
         WHEN sync_outbox.status IN ('succeeded', 'dead') THEN NULL
         ELSE sync_outbox.locked_at
       END,
       lock_token = CASE
         WHEN sync_outbox.status IN ('succeeded', 'dead') THEN NULL
         ELSE sync_outbox.lock_token
       END,
       updated_at = now()
     WHERE sync_outbox.status <> 'processing'
       AND (
         sync_outbox.status IN ('succeeded', 'dead')
         OR sync_outbox.payload IS DISTINCT FROM EXCLUDED.payload
       )
     RETURNING id::text, status`,
    [target.product_id, JSON.stringify(payload), state.idempotencyKey],
  )
  if (queued.rows[0]) {
    await client.query(
      `UPDATE crm_products
       SET sync_status = 'pending', sync_error = NULL, updated_at = now()
       WHERE pipeline_id = $1::uuid AND id = $2::uuid`,
      [target.pipeline_id, target.product_id],
    )
    await client.query(
      `INSERT INTO audit_events (
         actor, subject, is_system, organization_id, event_type,
         aggregate_type, aggregate_id, payload, event_key, created_at
       ) VALUES (
         lower($1), lower($1), false, $2::uuid,
         'crm.product_image.suitecrm_native_reprojection_queued',
         'crm_product', $3, $4::jsonb, $5, now()
       )
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      [
        actorEmail,
        target.organization_id,
        target.product_id,
        JSON.stringify({
          scriptVersion: SCRIPT_VERSION,
          pipelineId: target.pipeline_id,
          productId: target.product_id,
          productReferenceCode: target.reference_code,
          suiteCrmId: target.suitecrm_id,
          imageAssetId: target.image_asset_id,
          imageAssetRevision: target.image_asset_revision,
          imageRowVersion: target.image_row_version,
          imageContentSha256: target.image_content_sha256,
          outboxId: queued.rows[0].id,
          outboxIdempotencyKey: state.idempotencyKey,
          planFingerprint: targetFingerprint(target),
          projectionRequired: true,
          providerWrites: 0,
        }),
        `crm-product-image-suitecrm-native-reprojection:${
          targetFingerprint(target)
        }`,
      ],
    )
    return {
      changed: true,
      reason: 'queued',
      outboxId: queued.rows[0].id,
      outboxStatus: queued.rows[0].status,
    }
  }
  const refreshed = await loadState(client, target)
  return {
    changed: false,
    reason: refreshed.outbox?.status === 'processing'
      ? 'already_processing'
      : 'already_scheduled',
    state: refreshed,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: ['require', 'true'].includes(
      clean(process.env.PGSSLMODE || process.env.DATABASE_SSL).toLowerCase(),
    ) ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    max: 2,
  })
  const client = await pool.connect()
  try {
    const target = await loadTarget(client, args.productReferenceCode)
    const state = await loadState(client, target)
    const configuration = nativeProjectionConfiguration()
    const plan = publicPlan(target, state, configuration)
    if (!args.apply) {
      console.log(JSON.stringify({ ok: true, mode: 'plan', plan }, null, 2))
      return
    }
    if (!configuration.ready) {
      fail('SuiteCRM native Product image projection is not enabled and ready')
    }
    if (clean(process.env[CONFIRMATION_VARIABLE]) !== plan.confirmation) {
      fail(`${CONFIRMATION_VARIABLE} must equal the exact planned confirmation`)
    }
    const actorEmail = clean(process.env[ACTOR_VARIABLE]).toLowerCase()
    await client.query('BEGIN')
    try {
      const applied = await applyPlan(client, target, actorEmail)
      await client.query('COMMIT')
      console.log(JSON.stringify({
        ok: true,
        mode: 'apply',
        productReferenceCode: target.reference_code,
        planFingerprint: plan.planFingerprint,
        ...applied,
        providerWrites: 0,
      }, null, 2))
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  } finally {
    client.release()
    await pool.end()
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : ''
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    console.error(`crm:reproject-suitecrm-product-image failed: ${
      error instanceof Error ? error.message : String(error)
    }`)
    process.exit(1)
  })
}
