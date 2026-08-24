import { createHash } from 'node:crypto'
import { recordAuditEvent } from '@/lib/auditWriter'
import type { PrintFormat, PrintMedia } from '@/lib/operations/printing'
import { OperationsRequestError } from '@/lib/persistence/operations'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const RECONCILIATION_GLOBAL_ID = /^gsfr(?:[0-9]{7}|[0-9a-v]{12})$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const MAX_LABEL_BYTES = 10 * 1024 * 1024

type ExternalLabelFormat = Extract<PrintFormat, 'ZPL' | 'PDF' | 'PNG'>
type ExternalLabelMedia = Extract<PrintMedia, 'label_4x6' | 'label_4x8'>

function invalid(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function requiredText(value: unknown, label: string, maxLength: number) {
  const normalized = String(value || '').trim()
  if (
    !normalized
    || normalized.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    invalid('OPERATIONS_EXTERNAL_LABEL_INVALID', `${label} is invalid`)
  }
  return normalized
}

function safeFilename(value: unknown, format: ExternalLabelFormat) {
  const extension = format.toLowerCase()
  const stem = String(value || '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\.(zpl|pdf|png)$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 180)
  return `${stem || 'external-shipping-label'}.${extension}`
}

function validZpl(bytes: Buffer) {
  const text = bytes.toString('utf8')
  const normalized = text.trim()
  return Buffer.from(text, 'utf8').equals(bytes)
    && normalized.startsWith('^XA')
    && normalized.endsWith('^XZ')
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
}

function validPdf(bytes: Buffer) {
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return false
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1')
  return /%%EOF[\u0000\t\n\f\r ]*$/u.test(tail)
}

function validPng(bytes: Buffer) {
  return bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )
}

export function validateExternalFulfillmentLabelBytes(input: {
  format: ExternalLabelFormat
  payload: Uint8Array
}) {
  const payload = Buffer.from(input.payload)
  const valid = payload.length >= 1
    && payload.length <= MAX_LABEL_BYTES
    && (input.format === 'ZPL'
      ? validZpl(payload)
      : input.format === 'PDF'
        ? validPdf(payload)
        : validPng(payload))
  if (!valid) {
    invalid(
      'OPERATIONS_EXTERNAL_LABEL_PAYLOAD_INVALID',
      'The uploaded label bytes do not match the declared ZPL, PDF, or PNG format',
    )
  }
  return payload
}

function trackingNumbers(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return []
  const fulfillment = (snapshot as Record<string, unknown>).fulfillment
  if (!fulfillment || typeof fulfillment !== 'object' || Array.isArray(fulfillment)) {
    return []
  }
  const tracking = (fulfillment as Record<string, unknown>).tracking
  if (!Array.isArray(tracking)) return []
  return tracking.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const number = String((value as Record<string, unknown>).number || '').trim()
    return number ? [number] : []
  })
}

export async function importOperationsExternalFulfillmentLabelInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  orderGlobalId: string
  expectedOrderRowVersion: number
  reconciliationGlobalId: string
  trackingNumber: string
  format: ExternalLabelFormat
  media: ExternalLabelMedia
  filename: string
  payload: Uint8Array
  reason: string
}) {
  const organizationId = String(input.organizationId || '').trim().toLowerCase()
  if (!UUID.test(organizationId)) {
    invalid('OPERATIONS_EXTERNAL_LABEL_ORGANIZATION_INVALID', 'Organization is invalid')
  }
  const actorEmail = requiredText(input.actorEmail, 'Actor', 320).toLowerCase()
  if (!actorEmail.includes('@')) {
    invalid('OPERATIONS_EXTERNAL_LABEL_ACTOR_INVALID', 'Actor is invalid', 401)
  }
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    invalid('OPERATIONS_EXTERNAL_LABEL_IDEMPOTENCY_INVALID', 'Idempotency-Key is invalid')
  }
  const orderGlobalId = requiredText(input.orderGlobalId, 'Order', 20)
  const reconciliationGlobalId = requiredText(
    input.reconciliationGlobalId,
    'External fulfillment evidence',
    20,
  )
  if (!ORDER_GLOBAL_ID.test(orderGlobalId) || !RECONCILIATION_GLOBAL_ID.test(reconciliationGlobalId)) {
    invalid('OPERATIONS_EXTERNAL_LABEL_REFERENCE_INVALID', 'Order or external fulfillment evidence is invalid')
  }
  if (!Number.isSafeInteger(input.expectedOrderRowVersion) || input.expectedOrderRowVersion < 0) {
    invalid('OPERATIONS_EXTERNAL_LABEL_VERSION_INVALID', 'Order version is invalid')
  }
  const trackingNumber = requiredText(input.trackingNumber, 'Tracking number', 255)
  if (!['ZPL', 'PDF', 'PNG'].includes(input.format)) {
    invalid('OPERATIONS_EXTERNAL_LABEL_FORMAT_INVALID', 'Label format is invalid')
  }
  if (!['label_4x6', 'label_4x8'].includes(input.media)) {
    invalid('OPERATIONS_EXTERNAL_LABEL_MEDIA_INVALID', 'Label media is invalid')
  }
  const reason = requiredText(input.reason, 'Import reason', 500)
  if (reason.length < 8) {
    invalid('OPERATIONS_EXTERNAL_LABEL_REASON_INVALID', 'An 8-500 character import reason is required')
  }
  const payload = validateExternalFulfillmentLabelBytes({
    format: input.format,
    payload: input.payload,
  })
  const contentSha256 = createHash('sha256').update(payload).digest('hex')
  const filename = safeFilename(input.filename, input.format)
  const mimeType = input.format === 'ZPL'
    ? 'application/vnd.zebra-zpl'
    : input.format === 'PDF'
      ? 'application/pdf'
      : 'image/png'

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:external-label:${organizationId}:${reconciliationGlobalId}:${trackingNumber}`,
    )
    const context = await client.query<{
      reconciliation_id: string
      evidence_snapshot: Record<string, unknown>
      order_id: string
      order_number: string
      order_status: string
      order_row_version: string
      warehouse_id: string
    }>(
      `SELECT reconciliation.id::text AS reconciliation_id,
              reconciliation.evidence_snapshot,
              source_order.id::text AS order_id,
              source_order.order_number,
              source_order.status AS order_status,
              source_order.row_version::text AS order_row_version,
              plan.warehouse_id::text
       FROM operations_shopify_external_fulfillment_reconciliations
              reconciliation
       JOIN operations_orders source_order
         ON source_order.organization_id = reconciliation.organization_id
        AND source_order.id = reconciliation.order_id
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = reconciliation.organization_id
        AND plan.id = reconciliation.plan_id
       WHERE reconciliation.organization_id = $1::uuid
         AND reconciliation.global_id = $2
         AND source_order.global_id = $3
       FOR SHARE OF reconciliation, source_order, plan`,
      [organizationId, reconciliationGlobalId, orderGlobalId],
    )
    const source = context.rows[0]
    if (!source) {
      invalid(
        'OPERATIONS_EXTERNAL_LABEL_RECONCILIATION_NOT_FOUND',
        'The external fulfillment evidence was not found for this order',
        404,
      )
    }
    if (
      source.order_status !== 'cancelled'
      || Number(source.order_row_version) !== input.expectedOrderRowVersion
    ) {
      invalid(
        'OPERATIONS_EXTERNAL_LABEL_ORDER_STALE',
        'The externally fulfilled order changed; refresh before importing its label',
        409,
      )
    }
    if (!trackingNumbers(source.evidence_snapshot).includes(trackingNumber)) {
      invalid(
        'OPERATIONS_EXTERNAL_LABEL_TRACKING_MISMATCH',
        'The selected tracking number is not present in the immutable Shopify fulfillment evidence',
        409,
      )
    }
    const trackingHash = createHash('sha256')
      .update(trackingNumber)
      .digest('hex')
    const storageReference = (
      `clawpilot-external-label:${reconciliationGlobalId}:${trackingHash}:${contentSha256}`
    )
    const inserted = await client.query<{
      id: string
      global_id: string
      content_sha256: string
      byte_length: string
    }>(
      `INSERT INTO operations_print_artifacts (
         organization_id, source_order_id,
         source_external_fulfillment_reconciliation_id,
         external_tracking_number, document_type, format, media_size,
         content_sha256, byte_length, storage_reference, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'shipping_label', $5, $6,
         $7, $8, $9, $10
       )
       ON CONFLICT (
         organization_id,
         source_external_fulfillment_reconciliation_id,
         external_tracking_number,
         format,
         media_size
       ) WHERE source_external_fulfillment_reconciliation_id IS NOT NULL
       DO NOTHING
       RETURNING id::text, global_id, content_sha256, byte_length::text`,
      [
        organizationId,
        source.order_id,
        source.reconciliation_id,
        trackingNumber,
        input.format,
        input.media,
        contentSha256,
        payload.length,
        storageReference,
        actorEmail,
      ],
    )
    const artifact = inserted.rows[0] || (await client.query<{
      id: string
      global_id: string
      content_sha256: string
      byte_length: string
    }>(
      `SELECT id::text, global_id, content_sha256, byte_length::text
       FROM operations_print_artifacts
       WHERE organization_id = $1::uuid
         AND source_external_fulfillment_reconciliation_id = $2::uuid
         AND external_tracking_number = $3
         AND format = $4
         AND media_size = $5
       FOR SHARE`,
      [
        organizationId,
        source.reconciliation_id,
        trackingNumber,
        input.format,
        input.media,
      ],
    )).rows[0]
    if (
      !artifact
      || artifact.content_sha256 !== contentSha256
      || Number(artifact.byte_length) !== payload.length
    ) {
      invalid(
        'OPERATIONS_EXTERNAL_LABEL_CONFLICT',
        'A different original label is already retained for this tracking number and format',
        409,
      )
    }
    await client.query(
      `INSERT INTO operations_print_artifact_payloads (
         artifact_id, organization_id, mime_type, filename, payload,
         template_version, render_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5,
         'external-fulfillment-label-import-v1', $6::jsonb
       ) ON CONFLICT (artifact_id) DO NOTHING`,
      [
        artifact.id,
        organizationId,
        mimeType,
        filename,
        payload,
        JSON.stringify({
          version: 'external-fulfillment-label-import-v1',
          reconciliationGlobalId,
          orderGlobalId,
          trackingNumber,
          format: input.format,
          media: input.media,
          contentSha256,
          byteLength: payload.length,
          reason,
          idempotencyKey,
        }),
      ],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.external_fulfillment_label.imported',
      aggregateType: 'operations.order',
      aggregateId: orderGlobalId,
      eventKey: `operations:external-fulfillment-label:${artifact.global_id}`,
      organizationId,
      payload: {
        orderGlobalId,
        orderNumber: source.order_number,
        reconciliationGlobalId,
        artifactGlobalId: artifact.global_id,
        trackingNumber,
        format: input.format,
        media: input.media,
        contentSha256,
        byteLength: payload.length,
        providerWrites: 0,
        postagePurchases: 0,
        reason,
      },
    }, client)
    return {
      orderGlobalId,
      reconciliationGlobalId,
      artifactGlobalId: artifact.global_id,
      trackingNumber,
      format: input.format,
      media: input.media,
      contentSha256,
      byteLength: payload.length,
      warehouseId: source.warehouse_id,
      replayed: !inserted.rows[0],
    }
  })
}
