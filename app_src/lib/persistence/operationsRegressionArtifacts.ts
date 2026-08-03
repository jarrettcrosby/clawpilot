import type { PoolClient, QueryResultRow } from 'pg'
import {
  PACKING_SLIP_TEMPLATE_VERSION,
  renderPackingSlip,
} from '@/lib/operations/packingSlip'

export type OperationsRegressionPackingSlipLine = {
  lineKey: string
  productKey: string
  title: string
  quantity: number
}

export type OperationsRegressionPackingSlipArtifactInput = {
  organizationId: string
  actorEmail: string
  runGlobalId: string
  scenarioId: string
  sourceReference: string
  orderNumber: string
  customerName: string
  customerGlobalId: string
  packageKey: string
  packageSequence: number
  packageCount: number
  trackingNumber: string
  carrier: 'ups_rest' | 'fedex_rest'
  serviceCode: string
  recordedLabelReference: string
  recordedAt: string
  shipTo: {
    name: string
    line1: string
    line2?: string | null
    city: string
    region: string
    postalCode: string
    country: string
  }
  lines: OperationsRegressionPackingSlipLine[]
}

export type OperationsRegressionPackingSlipArtifact = {
  id: string
  globalId: string
  contentSha256: string
  byteLength: number
  contentUrl: string
}

type ArtifactRow = QueryResultRow & {
  id: string
  global_id: string
  content_sha256: string
  byte_length: string
}

function orderedLines(lines: OperationsRegressionPackingSlipLine[]) {
  return [...lines].sort((left, right) => (
    left.lineKey.localeCompare(right.lineKey)
    || left.productKey.localeCompare(right.productKey)
  ))
}

function safeReferencePart(value: string) {
  return encodeURIComponent(String(value || '').trim()).slice(0, 240)
}

/**
 * Persists one replay-only final packing slip using the same immutable artifact
 * and payload tables as live Operations documents. The caller must invoke this
 * inside the pack-rate replay transaction after its exact allocations exist
 * and before inserting the package-finalization row that references `id`.
 *
 * This helper never calls a carrier, purchases postage, creates a provider
 * label, or enqueues a print job.
 */
export async function persistOperationsRegressionPackingSlipArtifactWithClient(
  client: PoolClient,
  input: OperationsRegressionPackingSlipArtifactInput,
): Promise<OperationsRegressionPackingSlipArtifact> {
  const lines = orderedLines(input.lines)
  if (lines.length < 1) {
    throw new Error('OPERATIONS_REGRESSION_PACKING_SLIP_LINES_REQUIRED')
  }
  if (
    !Number.isInteger(input.packageSequence)
    || input.packageSequence < 1
    || !Number.isInteger(input.packageCount)
    || input.packageCount < input.packageSequence
  ) {
    throw new Error('OPERATIONS_REGRESSION_PACKING_SLIP_PACKAGE_INVALID')
  }
  if (lines.some((line) => (
    !line.lineKey.trim()
    || !line.productKey.trim()
    || !line.title.trim()
    || !Number.isInteger(line.quantity)
    || line.quantity < 1
  ))) {
    throw new Error('OPERATIONS_REGRESSION_PACKING_SLIP_ALLOCATION_INVALID')
  }

  const rendered = renderPackingSlip({
    documentTitle: 'ClawPilot Recorded Replay Packing Slip',
    shipmentSectionTitle: 'Recorded label response',
    shipmentTimestampLabel: 'Recorded',
    footerNotice: (
      'Development replay evidence only. No carrier call or postage purchase was performed.'
    ),
    orderGlobalId: input.sourceReference,
    orderNumber: input.orderNumber,
    customerName: input.customerName,
    customerGlobalId: input.customerGlobalId,
    shipmentGlobalId: input.runGlobalId,
    trackingNumber: input.trackingNumber,
    carrier: input.carrier,
    serviceCode: input.serviceCode,
    shippedAt: input.recordedAt,
    shipTo: input.shipTo,
    lines: lines.map((line) => ({
      productGlobalId: line.productKey,
      productName: line.title,
      channelSku: line.lineKey,
      quantity: line.quantity,
    })),
  })
  const renderSnapshot = {
    documentStage: 'recorded_fulfillment_replay',
    runGlobalId: input.runGlobalId,
    scenarioId: input.scenarioId,
    sourceReference: input.sourceReference,
    packageKey: input.packageKey,
    packageSequence: input.packageSequence,
    packageCount: input.packageCount,
    trackingNumber: input.trackingNumber,
    carrier: input.carrier,
    serviceCode: input.serviceCode,
    recordedLabelReference: input.recordedLabelReference,
    providerWriteCount: 0,
    postagePurchaseCount: 0,
    lines,
  } as const
  const storageReference = [
    'clawpilot-document:pack-rate-replay',
    safeReferencePart(input.runGlobalId),
    safeReferencePart(input.packageKey),
    rendered.contentSha256,
  ].join(':')

  const inserted = await client.query<ArtifactRow>(
    `INSERT INTO operations_print_artifacts (
       organization_id, document_type, format, media_size, content_sha256,
       byte_length, storage_reference, created_by
     ) VALUES (
       $1::uuid, 'packing_slip', 'PDF', 'letter', $2, $3, $4, $5
     )
     ON CONFLICT (
       organization_id, content_sha256, storage_reference
     ) DO NOTHING
     RETURNING id::text, global_id, content_sha256, byte_length::text`,
    [
      input.organizationId,
      rendered.contentSha256,
      rendered.byteLength,
      storageReference,
      input.actorEmail,
    ],
  )
  let artifact = inserted.rows[0]
  if (artifact) {
    await client.query(
      `INSERT INTO operations_print_artifact_payloads (
         artifact_id, organization_id, mime_type, filename, payload,
         template_version, render_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb
       )`,
      [
        artifact.id,
        input.organizationId,
        rendered.mimeType,
        rendered.filename,
        rendered.payload,
        PACKING_SLIP_TEMPLATE_VERSION,
        JSON.stringify(renderSnapshot),
      ],
    )
  } else {
    const existing = await client.query<ArtifactRow>(
      `SELECT
         artifact.id::text,
         artifact.global_id,
         artifact.content_sha256,
         artifact.byte_length::text
       FROM operations_print_artifacts artifact
       JOIN operations_print_artifact_payloads payload
         ON payload.organization_id = artifact.organization_id
        AND payload.artifact_id = artifact.id
       WHERE artifact.organization_id = $1::uuid
         AND artifact.content_sha256 = $2
         AND artifact.byte_length = $3
         AND artifact.storage_reference = $4
         AND artifact.document_type = 'packing_slip'
         AND artifact.format = 'PDF'
         AND artifact.media_size = 'letter'
         AND payload.mime_type = $5
         AND payload.template_version = $6
         AND payload.render_snapshot = $7::jsonb
         AND octet_length(payload.payload) = $3
         AND encode(digest(payload.payload, 'sha256'), 'hex') = $2
       FOR SHARE OF artifact, payload`,
      [
        input.organizationId,
        rendered.contentSha256,
        rendered.byteLength,
        storageReference,
        rendered.mimeType,
        PACKING_SLIP_TEMPLATE_VERSION,
        JSON.stringify(renderSnapshot),
      ],
    )
    artifact = existing.rows[0]
    if (!artifact) {
      throw new Error('OPERATIONS_REGRESSION_PACKING_SLIP_CONFLICT')
    }
  }

  return {
    id: artifact.id,
    globalId: artifact.global_id,
    contentSha256: artifact.content_sha256,
    byteLength: Number(artifact.byte_length),
    contentUrl: (
      `/api/operations/artifacts/${encodeURIComponent(artifact.global_id)}`
    ),
  }
}
