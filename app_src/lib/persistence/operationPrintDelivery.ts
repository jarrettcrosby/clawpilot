import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  DEFAULT_PRINT_AGENT_CAPABILITIES,
  PRINT_DOCUMENT_TYPES,
  PRINT_FORMATS,
  PRINT_MEDIA,
  selectPrinterRoute,
  supportsPrinterRoute,
  type DurablePrintDocumentType,
  type PrintAgentCapabilities,
  type OperationsPrintAgentContext,
  type OperationsPrintAgentCredential,
  type OperationsPrintAgentProfile,
  type OperationsPrintAgentWorkspace,
  type OperationsPrintAttemptListItem,
  type OperationsPrintClaimJob,
  type OperationsPrintJobListItem,
  type OperationsPrintJobWorkspace,
  type OperationsPrinterProfile,
  type PrintFormat,
  type PrintMedia,
  type PrintPayloadEncoding,
} from '@/lib/operations/printing'
import { OperationsRequestError } from '@/lib/persistence/operations'
import {
  listOperationsPrinterProfilesInPostgres,
} from '@/lib/persistence/operationPrinting'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type TimestampValue = string | Date

type PrintAgentRow = {
  id: string
  global_id: string
  organization_id: string
  warehouse_id: string
  warehouse_global_id: string
  warehouse_name: string
  name: string
  status: OperationsPrintAgentProfile['status']
  credential_version: number
  supported_formats: OperationsPrintAgentProfile['supportedFormats']
  supported_media: OperationsPrintAgentProfile['supportedMedia']
  supported_document_types: OperationsPrintAgentProfile['supportedDocumentTypes']
  assigned_printers: Array<{ globalId: string; name: string }> | null
  enrolled_by: string | null
  enrolled_at: TimestampValue
  rotated_at: TimestampValue | null
  revoked_at: TimestampValue | null
  last_seen_at: TimestampValue | null
}

type PrintJobRow = {
  id: string
  global_id: string
  document_type: OperationsPrintJobListItem['documentType']
  format: OperationsPrintJobListItem['format']
  media_size: OperationsPrintJobListItem['media']
  artifact_global_id: string | null
  artifact_content_sha256: string | null
  artifact_byte_length: string | number | null
  artifact_created_by: string | null
  artifact_created_at: TimestampValue | null
  source_label_global_id: string | null
  source_label_status: string | null
  carrier: string | null
  carrier_service_code: string | null
  carrier_environment: string | null
  label_created_at: TimestampValue | null
  label_voided_at: TimestampValue | null
  label_voided_by: string | null
  source_order_global_id: string | null
  source_order_number: string | null
  source_shipment_global_id: string | null
  tracking_number: string | null
  package_global_id: string | null
  package_number: number | null
  package_length_mm: number | null
  package_width_mm: number | null
  package_height_mm: number | null
  package_weight_grams: number | null
  ship_to_name: string | null
  ship_to_city: string | null
  ship_to_region: string | null
  ship_to_postal_code: string | null
  ship_to_country: string | null
  warehouse_global_id: string
  warehouse_name: string
  station_type: OperationsPrintJobListItem['stationType']
  printer_global_id: string
  printer_name: string
  requested_printer_global_id: string
  requested_printer_name: string
  fallback_printer_global_id: string | null
  fallback_printer_name: string | null
  print_agent_global_id: string | null
  print_agent_name: string | null
  status: OperationsPrintJobListItem['status']
  routing_reason: string
  attempts: number
  max_attempts: number
  available_at: TimestampValue
  claim_expires_at: TimestampValue | null
  delivered_at: TimestampValue | null
  last_error: string | null
  reprint_of_job_global_id: string | null
  reprint_reason: string | null
  enqueued_by: string | null
  attempt_history: Array<{
    attemptNumber: number
    sequenceNumber: number
    state: OperationsPrintAttemptListItem['state']
    actorType: OperationsPrintAttemptListItem['actorType']
    actorEmail: string | null
    printAgentGlobalId: string | null
    printerGlobalId: string
    printerName: string
    detail: string | null
    errorCode: string | null
    errorMessage: string | null
    deviceJobReference: string | null
    deliveryEvidence: string | null
    physicalOutputVerified: boolean
    occurredAt: TimestampValue
  }> | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

type LockedPrintJobRow = {
  id: string
  global_id: string
  organization_id: string
  label_id: string | null
  rate_test_label_id: string | null
  source_order_id: string | null
  source_order_global_id: string | null
  source_shipment_id: string | null
  source_shipment_global_id: string | null
  tracking_number: string | null
  artifact_id: string
  document_type: DurablePrintDocumentType
  format: PrintFormat
  media_size: PrintMedia
  warehouse_id: string
  printer_id: string
  printer_global_id: string
  requested_printer_id: string
  requested_printer_global_id: string
  fallback_printer_id: string | null
  fallback_printer_global_id: string | null
  status: OperationsPrintJobListItem['status']
  attempts: number
  max_attempts: number
  claimed_by_print_agent_id: string | null
  current_claim_attempt_id: string | null
  claim_expires_at: TimestampValue | null
}

type PrintClaimRow = {
  claim_token: string
  claim_expires_at: TimestampValue
  attempt_number: number
  global_id: string
  artifact_global_id: string
  document_type: DurablePrintDocumentType
  format: PrintFormat
  media_size: PrintMedia
  content_sha256: string
  byte_length: string
  storage_reference: string
  label_payload: string | null
  rate_test_label_payload: Buffer | null
  artifact_payload: Buffer | null
  printer_global_id: string
  printer_code: string
  printer_name: string
}

type PrintArtifactPayloadRow = {
  global_id: string
  document_type: DurablePrintDocumentType
  format: PrintFormat
  media_size: PrintMedia
  content_sha256: string
  byte_length: string
  payload_mime_type: 'application/pdf' | 'image/png' | null
  payload_filename: string | null
  artifact_payload: Buffer | null
  template_version: string | null
  source_label_global_id: string | null
  source_label_format: PrintFormat | null
  source_label_payload: string | null
  rate_test_label_global_id: string | null
  rate_test_label_format: PrintFormat | null
  rate_test_label_payload: Buffer | null
  created_at: TimestampValue
}

export type EnqueueOperationsPrintJobInput = {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  warehouseId: string
  preferredPrinterGlobalId?: string | null
  maxAttempts?: number
  document:
    | {
      type: 'shipping_label'
      sourceLabelGlobalId: string
      media: Extract<PrintMedia, 'label_4x6' | 'label_4x8'>
    }
    | {
      type: 'rate_test_label'
      sourceRateTestLabelGlobalId: string
      media: Extract<PrintMedia, 'label_4x6' | 'label_4x8'>
    }
    | {
      type: 'packing_slip'
      format: Extract<PrintFormat, 'PDF' | 'PNG'>
      media: Extract<PrintMedia, 'letter' | 'a4'>
      contentSha256: string
      byteLength: number
      storageReference: string
      sourceOrderGlobalId?: string | null
      sourceShipmentGlobalId?: string | null
    }
    | {
      type: 'packing_slip_artifact'
      sourceArtifactGlobalId: string
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const AGENT_GLOBAL_ID = /^gpt\d{7}$/
const JOB_GLOBAL_ID = /^gpj\d{7}$/
const ARTIFACT_GLOBAL_ID = /^gpf\d{7}$/
const LABEL_GLOBAL_ID = /^glb\d{7}$/
const RATE_TEST_LABEL_GLOBAL_ID = /^gsl\d{7}$/
const ORDER_GLOBAL_ID = /^gor\d{7}$/
const SHIPMENT_GLOBAL_ID = /^gsh\d{7}$/
const SHA256 = /^[a-f0-9]{64}$/
const PRINT_AGENT_CREDENTIAL =
  /^cpprint\.v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i
const STORAGE_PROTOCOLS = new Set([
  'https:',
  's3:',
  'clawpilot-document:',
  'clawpilot-label:',
  'clawpilot-rate-test-label:',
])
const MAX_REASON_LENGTH = 500
const MAX_ERROR_LENGTH = 1000
const DEFAULT_LEASE_SECONDS = 120

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function requiredOrganizationId(value: string) {
  const organizationId = String(value || '').trim()
  if (!UUID.test(organizationId)) {
    throw new OperationsRequestError(
      'OPERATIONS_ORGANIZATION_INVALID',
      'The active organization is invalid',
    )
  }
  return organizationId
}

function requiredActor(value: string) {
  const actor = String(value || '').trim().toLowerCase()
  if (!actor || !actor.includes('@')) {
    throw new OperationsRequestError(
      'OPERATIONS_ACTOR_REQUIRED',
      'Signed-in user is required',
    )
  }
  return actor
}

function requiredIdempotencyKey(value: string) {
  const key = String(value || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_IDEMPOTENCY_REQUIRED',
      'A valid Idempotency-Key is required',
    )
  }
  return key
}

function requiredReason(value: string, label: string) {
  const reason = String(value || '').trim()
  if (!reason || reason.length > MAX_REASON_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_REASON_REQUIRED',
      `${label} is required and must be ${MAX_REASON_LENGTH} characters or fewer`,
    )
  }
  return reason
}

function requiredCapabilityValues<T extends string>(
  values: unknown,
  label: string,
  supported: readonly T[],
) {
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.length > supported.length
    || values.some((value) => typeof value !== 'string' || !supported.includes(value as T))
    || new Set(values).size !== values.length
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_AGENT_CAPABILITIES_INVALID',
      `${label} are invalid`,
    )
  }
  return values as T[]
}

function requiredPrintAgentCapabilities(
  input?: Partial<PrintAgentCapabilities>,
): PrintAgentCapabilities {
  const capabilities = input || DEFAULT_PRINT_AGENT_CAPABILITIES
  return {
    supportedFormats: requiredCapabilityValues(
      capabilities.supportedFormats,
      'Print-agent formats',
      PRINT_FORMATS,
    ),
    supportedMedia: requiredCapabilityValues(
      capabilities.supportedMedia,
      'Print-agent media',
      PRINT_MEDIA,
    ),
    supportedDocumentTypes: requiredCapabilityValues(
      capabilities.supportedDocumentTypes,
      'Print-agent document types',
      PRINT_DOCUMENT_TYPES,
    ),
  }
}

function printAgentCapabilitiesAreSubset(
  candidate: PrintAgentCapabilities,
  enrolled: PrintAgentCapabilities,
) {
  return candidate.supportedFormats.every((value) => (
    enrolled.supportedFormats.includes(value)
  ))
    && candidate.supportedMedia.every((value) => (
      enrolled.supportedMedia.includes(value)
    ))
    && candidate.supportedDocumentTypes.every((value) => (
      enrolled.supportedDocumentTypes.includes(value)
    ))
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

export function operationsPrintDeliveryFingerprint(value: unknown) {
  return crypto
    .createHash('sha256')
    .update(`clawpilot:operations-print-delivery:v1\n${stableJson(value)}`)
    .digest('hex')
}

function contentHash(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function strictBase64Bytes(value: string) {
  const encoded = value.replace(/\s+/g, '')
  const unpadded = encoded.replace(/=+$/, '')
  if (
    !encoded
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || encoded.length % 4 === 1
    || (encoded.includes('=') && encoded.length % 4 !== 0)
  ) return null
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  const bytes = Buffer.from(padded, 'base64')
  return (
    bytes.length
    && bytes.toString('base64').replace(/=+$/, '') === unpadded
  ) ? bytes : null
}

function validZplBytes(bytes: Buffer) {
  const payload = bytes.toString('utf8')
  const normalized = payload.trim()
  return (
    Buffer.from(payload, 'utf8').equals(bytes)
    && normalized.startsWith('^XA')
    && normalized.endsWith('^XZ')
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload)
  )
}

function validPdfBytes(bytes: Buffer) {
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return false
  const tail = bytes
    .subarray(Math.max(0, bytes.byteLength - 2048))
    .toString('latin1')
  return /%%EOF[\u0000\t\n\f\r ]*$/.test(tail)
}

function validateLabelBytes(format: PrintFormat, bytes: Buffer) {
  const bounded = bytes.byteLength >= 1 && bytes.byteLength <= 10 * 1024 * 1024
  const valid = bounded && (format === 'ZPL'
    ? validZplBytes(bytes)
    : format === 'PDF'
      ? validPdfBytes(bytes)
      : format === 'PNG'
        ? bytes.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
        : false)
  if (!valid) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_LABEL_PAYLOAD_INVALID',
      'Stored shipping-label bytes do not match the declared format',
      409,
    )
  }
  return bytes
}

function validateDocumentBytes(format: PrintFormat, bytes: Buffer) {
  const bounded = bytes.byteLength >= 1 && bytes.byteLength <= 50 * 1024 * 1024
  const valid = bounded && (format === 'PDF'
    ? validPdfBytes(bytes)
    : format === 'PNG'
      ? bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
      : false)
  if (!valid) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
      'Print artifact content failed integrity validation',
      500,
    )
  }
  return bytes
}

export function decodeStoredOperationsLabelPayload(input: {
  format: PrintFormat
  payload: string
}) {
  if (input.format === 'ZPL') {
    const raw = Buffer.from(input.payload, 'utf8')
    if (validZplBytes(raw)) return raw
    const decoded = strictBase64Bytes(input.payload)
    if (decoded && validZplBytes(decoded)) return decoded
    return validateLabelBytes(input.format, raw)
  }
  const decoded = strictBase64Bytes(input.payload)
  if (!decoded) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_LABEL_PAYLOAD_INVALID',
      'Stored shipping-label payload is not valid base64',
      409,
    )
  }
  return validateLabelBytes(input.format, decoded)
}

export function encodeOperationsPrintClaimPayload(input: {
  format?: PrintFormat | null
  labelPayload?: string | null
  rateTestLabelPayload?: Uint8Array | null
  artifactPayload?: Uint8Array | null
}): {
  inlinePayload: string | null
  encoding: PrintPayloadEncoding | null
} {
  if (input.labelPayload !== undefined && input.labelPayload !== null) {
    const format = input.format || 'ZPL'
    const bytes = decodeStoredOperationsLabelPayload({
      format,
      payload: input.labelPayload,
    })
    return {
      inlinePayload: format === 'ZPL'
        ? bytes.toString('utf8')
        : bytes.toString('base64'),
      encoding: format === 'ZPL' ? 'utf8' : 'base64',
    }
  }
  if (
    input.rateTestLabelPayload !== undefined
    && input.rateTestLabelPayload !== null
  ) {
    if (!input.format) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_LABEL_PAYLOAD_INVALID',
        'Stored rate-test label format is unavailable',
        409,
      )
    }
    const bytes = validateLabelBytes(
      input.format,
      Buffer.from(input.rateTestLabelPayload),
    )
    return {
      inlinePayload: input.format === 'ZPL'
        ? bytes.toString('utf8')
        : bytes.toString('base64'),
      encoding: input.format === 'ZPL' ? 'utf8' : 'base64',
    }
  }
  if (input.artifactPayload !== undefined && input.artifactPayload !== null) {
    return {
      inlinePayload: Buffer.from(input.artifactPayload).toString('base64'),
      encoding: 'base64',
    }
  }
  return {
    inlinePayload: null,
    encoding: null,
  }
}

export function hashOperationsPrintAgentSecret(agentId: string, secret: string) {
  if (!UUID.test(agentId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_AGENT_CREDENTIAL_INVALID',
      'Print-agent credential material is invalid',
    )
  }
  return crypto
    .createHash('sha256')
    .update(`clawpilot:operations-print-agent:v1\n${agentId.toLowerCase()}\n${secret}`)
    .digest('hex')
}

export function createOperationsPrintAgentCredential(
  agentId: string = crypto.randomUUID(),
) {
  if (!UUID.test(agentId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_AGENT_CREDENTIAL_INVALID',
      'Print-agent identity is invalid',
    )
  }
  const normalizedAgentId = agentId.toLowerCase()
  const secret = crypto.randomBytes(32).toString('base64url')
  return {
    agentId: normalizedAgentId,
    credential: `cpprint.v1.${normalizedAgentId}.${secret}`,
    secretHash: hashOperationsPrintAgentSecret(normalizedAgentId, secret),
  }
}

function secureHashEqual(left: string, right: string) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false
  return crypto.timingSafeEqual(
    Buffer.from(left, 'hex'),
    Buffer.from(right, 'hex'),
  )
}

function parseAgentCredential(value: string) {
  const match = String(value || '').trim().match(PRINT_AGENT_CREDENTIAL)
  return match
    ? { agentId: match[1].toLowerCase(), secret: match[2] }
    : null
}

function stableStorageReference(value: string) {
  const storageReference = String(value || '').trim()
  if (
    !storageReference
    || storageReference.length > 1000
    || /[\u0000-\u001f\u007f]/.test(storageReference)
  ) {
    return null
  }
  try {
    const parsed = new URL(storageReference)
    if (
      !STORAGE_PROTOCOLS.has(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return null
    }
    return storageReference
  } catch {
    return null
  }
}

const fingerprint = operationsPrintDeliveryFingerprint

function agentProfile(row: PrintAgentRow): OperationsPrintAgentProfile {
  return {
    id: row.id,
    globalId: row.global_id,
    warehouseId: row.warehouse_id,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseName: row.warehouse_name,
    name: row.name,
    status: row.status,
    credentialVersion: row.credential_version,
    supportedFormats: row.supported_formats,
    supportedMedia: row.supported_media,
    supportedDocumentTypes: row.supported_document_types,
    assignedPrinters: Array.isArray(row.assigned_printers) ? row.assigned_printers : [],
    enrolledBy: row.enrolled_by,
    enrolledAt: iso(row.enrolled_at) as string,
    rotatedAt: iso(row.rotated_at),
    revokedAt: iso(row.revoked_at),
    lastSeenAt: iso(row.last_seen_at),
  }
}

function jobItem(row: PrintJobRow): OperationsPrintJobListItem {
  return {
    id: row.id,
    globalId: row.global_id,
    documentType: row.document_type,
    format: row.format,
    media: row.media_size,
    artifactGlobalId: row.artifact_global_id,
    artifactContentSha256: row.artifact_content_sha256,
    artifactByteLength: row.artifact_byte_length === null
      ? null
      : Number(row.artifact_byte_length),
    artifactCreatedBy: row.artifact_created_by,
    artifactCreatedAt: iso(row.artifact_created_at),
    sourceLabelGlobalId: row.source_label_global_id,
    sourceLabelStatus: row.source_label_status,
    carrier: row.carrier,
    carrierServiceCode: row.carrier_service_code,
    carrierEnvironment: row.carrier_environment,
    labelCreatedAt: iso(row.label_created_at),
    labelVoidedAt: iso(row.label_voided_at),
    labelVoidedBy: row.label_voided_by,
    sourceOrderGlobalId: row.source_order_global_id,
    sourceOrderNumber: row.source_order_number,
    sourceShipmentGlobalId: row.source_shipment_global_id,
    trackingNumber: row.tracking_number,
    packageGlobalId: row.package_global_id,
    packageNumber: row.package_number,
    packageLengthMm: row.package_length_mm,
    packageWidthMm: row.package_width_mm,
    packageHeightMm: row.package_height_mm,
    packageWeightGrams: row.package_weight_grams,
    shipToName: row.ship_to_name,
    shipToCity: row.ship_to_city,
    shipToRegion: row.ship_to_region,
    shipToPostalCode: row.ship_to_postal_code,
    shipToCountry: row.ship_to_country,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseName: row.warehouse_name,
    stationType: row.station_type,
    printerGlobalId: row.printer_global_id,
    printerName: row.printer_name,
    requestedPrinterGlobalId: row.requested_printer_global_id,
    requestedPrinterName: row.requested_printer_name,
    fallbackPrinterGlobalId: row.fallback_printer_global_id,
    fallbackPrinterName: row.fallback_printer_name,
    printAgentGlobalId: row.print_agent_global_id,
    printAgentName: row.print_agent_name,
    status: row.status,
    routingReason: row.routing_reason,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: iso(row.available_at) as string,
    claimExpiresAt: iso(row.claim_expires_at),
    deliveredAt: iso(row.delivered_at),
    lastError: row.last_error,
    reprintOfJobGlobalId: row.reprint_of_job_global_id,
    reprintReason: row.reprint_reason,
    enqueuedBy: row.enqueued_by,
    attemptHistory: (row.attempt_history || []).map((attempt) => ({
      ...attempt,
      occurredAt: iso(attempt.occurredAt) as string,
    })),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  }
}

const PRINT_AGENT_SELECT = `
  SELECT
    agent.id::text,
    agent.global_id,
    agent.organization_id::text,
    agent.warehouse_id::text,
    warehouse.global_id AS warehouse_global_id,
    warehouse.name AS warehouse_name,
    agent.name,
    agent.status,
    agent.credential_version,
    agent.supported_formats,
    agent.supported_media,
    agent.supported_document_types,
    COALESCE(
      jsonb_agg(
        jsonb_build_object('globalId', printer.global_id, 'name', printer.name)
        ORDER BY printer.priority, printer.name
      ) FILTER (WHERE printer.id IS NOT NULL),
      '[]'::jsonb
    ) AS assigned_printers,
    agent.enrolled_by,
    agent.enrolled_at,
    agent.rotated_at,
    agent.revoked_at,
    agent.last_seen_at
  FROM operations_print_agents agent
  JOIN operations_warehouses warehouse
    ON warehouse.organization_id = agent.organization_id
   AND warehouse.id = agent.warehouse_id
  LEFT JOIN operations_printers printer
    ON printer.organization_id = agent.organization_id
   AND printer.warehouse_id = agent.warehouse_id
   AND printer.local_print_agent_id = agent.id
`

const PRINT_JOB_SELECT = `
  SELECT
    job.id::text,
    job.global_id,
    artifact.document_type,
    artifact.format,
    artifact.media_size,
    artifact.global_id AS artifact_global_id,
    artifact.content_sha256 AS artifact_content_sha256,
    artifact.byte_length AS artifact_byte_length,
    artifact.created_by AS artifact_created_by,
    artifact.created_at AS artifact_created_at,
    COALESCE(source_label.global_id, rate_test_label.global_id)
      AS source_label_global_id,
    COALESCE(source_label.status, rate_test_label.status)
      AS source_label_status,
    COALESCE(source_label.carrier, rate_test_label.provider) AS carrier,
    COALESCE(source_label.service_code, rate_test_label.service_code)
      AS carrier_service_code,
    COALESCE(source_label.environment, rate_test_label.environment)
      AS carrier_environment,
    COALESCE(source_label.created_at, rate_test_label.created_at)
      AS label_created_at,
    COALESCE(source_label.voided_at, rate_test_label.voided_at)
      AS label_voided_at,
    COALESCE(source_label.voided_by, rate_test_label.voided_by)
      AS label_voided_by,
    source_order.global_id AS source_order_global_id,
    source_order.order_number AS source_order_number,
    source_shipment.global_id AS source_shipment_global_id,
    COALESCE(
      source_shipment.tracking_number,
      source_label.tracking_number,
      rate_test_label.tracking_number
    )
      AS tracking_number,
    source_package.global_id AS package_global_id,
    source_package.package_number,
    source_package.length_mm AS package_length_mm,
    source_package.width_mm AS package_width_mm,
    source_package.height_mm AS package_height_mm,
    source_package.weight_grams AS package_weight_grams,
    NULLIF(source_order.ship_to->>'name', '') AS ship_to_name,
    NULLIF(source_order.ship_to->>'city', '') AS ship_to_city,
    NULLIF(source_order.ship_to->>'region', '') AS ship_to_region,
    NULLIF(source_order.ship_to->>'postalCode', '') AS ship_to_postal_code,
    NULLIF(source_order.ship_to->>'country', '') AS ship_to_country,
    warehouse.global_id AS warehouse_global_id,
    warehouse.name AS warehouse_name,
    printer.station_type,
    printer.global_id AS printer_global_id,
    printer.name AS printer_name,
    requested.global_id AS requested_printer_global_id,
    requested.name AS requested_printer_name,
    fallback.global_id AS fallback_printer_global_id,
    fallback.name AS fallback_printer_name,
    print_agent.global_id AS print_agent_global_id,
    print_agent.name AS print_agent_name,
    job.status,
    job.routing_reason,
    job.attempts,
    job.max_attempts,
    job.available_at,
    job.claim_expires_at,
    job.delivered_at,
    job.last_error,
    prior.global_id AS reprint_of_job_global_id,
    job.reprint_reason,
    job.enqueued_by,
    attempt_history.attempts AS attempt_history,
    job.created_at,
    job.updated_at
  FROM operations_print_jobs job
  JOIN operations_printers printer
    ON printer.organization_id = job.organization_id
   AND printer.id = job.printer_id
  JOIN operations_warehouses warehouse
    ON warehouse.organization_id = printer.organization_id
   AND warehouse.id = printer.warehouse_id
  JOIN operations_printers requested
    ON requested.organization_id = job.organization_id
   AND requested.id = COALESCE(job.requested_printer_id, job.printer_id)
  LEFT JOIN operations_printers fallback
    ON fallback.organization_id = job.organization_id
   AND fallback.id = job.fallback_printer_id
  LEFT JOIN operations_print_agents print_agent
    ON print_agent.organization_id = printer.organization_id
   AND print_agent.warehouse_id = printer.warehouse_id
   AND print_agent.id = printer.local_print_agent_id
  LEFT JOIN operations_print_artifacts artifact
    ON artifact.organization_id = job.organization_id
   AND artifact.id = job.artifact_id
  LEFT JOIN operations_labels source_label
    ON source_label.organization_id = artifact.organization_id
   AND source_label.id = artifact.source_label_id
  LEFT JOIN operations_carrier_rate_test_labels rate_test_label
    ON rate_test_label.organization_id = artifact.organization_id
   AND rate_test_label.id = artifact.source_rate_test_label_id
  LEFT JOIN operations_packages source_package
    ON source_package.organization_id = source_label.organization_id
   AND source_package.id = source_label.package_id
  LEFT JOIN operations_orders source_order
    ON source_order.organization_id = artifact.organization_id
   AND source_order.id = artifact.source_order_id
  LEFT JOIN operations_shipments source_shipment
    ON source_shipment.organization_id = artifact.organization_id
   AND source_shipment.id = artifact.source_shipment_id
  LEFT JOIN operations_print_jobs prior
    ON prior.organization_id = job.organization_id
   AND prior.id = job.reprint_of_job_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'attemptNumber', attempt.attempt_number,
          'sequenceNumber', attempt.sequence_number,
          'state', attempt.state,
          'actorType', attempt.actor_type,
          'actorEmail', attempt.actor_email,
          'printAgentGlobalId', attempt_agent.global_id,
          'printerGlobalId', attempt_printer.global_id,
          'printerName', attempt_printer.name,
          'detail', attempt.detail,
          'errorCode', attempt.error_code,
          'errorMessage', attempt.error_message,
          'deviceJobReference', attempt.device_job_reference,
          'deliveryEvidence', attempt.delivery_evidence,
          'physicalOutputVerified', attempt.physical_output_verified,
          'occurredAt', attempt.occurred_at
        )
        ORDER BY attempt.sequence_number
      ),
      '[]'::jsonb
    ) AS attempts
    FROM operations_print_delivery_attempts attempt
    JOIN operations_printers attempt_printer
      ON attempt_printer.organization_id = attempt.organization_id
     AND attempt_printer.id = attempt.printer_id
    LEFT JOIN operations_print_agents attempt_agent
      ON attempt_agent.organization_id = attempt.organization_id
     AND attempt_agent.id = attempt.print_agent_id
    WHERE attempt.organization_id = job.organization_id
      AND attempt.print_job_id = job.id
  ) attempt_history ON true
`

async function listAgents(organizationId: string, client?: PoolClient) {
  const sql = `${PRINT_AGENT_SELECT}
    WHERE agent.organization_id = $1::uuid
      AND upper(warehouse.code) <> 'MOCK-01'
    GROUP BY agent.id, warehouse.global_id, warehouse.name
    ORDER BY warehouse.name, agent.name`
  const result = client
    ? await client.query<PrintAgentRow>(sql, [organizationId])
    : await query<PrintAgentRow>(sql, [organizationId])
  return result.rows.map(agentProfile)
}

async function oneAgent(
  organizationId: string,
  globalId: string,
  client: PoolClient,
) {
  const result = await client.query<PrintAgentRow>(
    `${PRINT_AGENT_SELECT}
     WHERE agent.organization_id = $1::uuid
       AND agent.global_id = $2
     GROUP BY agent.id, warehouse.global_id, warehouse.name
     LIMIT 1`,
    [organizationId, globalId],
  )
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_AGENT_NOT_FOUND',
      'Local print agent was not found',
      404,
    )
  }
  return agentProfile(result.rows[0])
}

async function oneJob(
  organizationId: string,
  globalId: string,
  client?: PoolClient,
) {
  const sql = `${PRINT_JOB_SELECT}
    WHERE job.organization_id = $1::uuid
      AND job.global_id = $2
    LIMIT 1`
  const result = client
    ? await client.query<PrintJobRow>(sql, [organizationId, globalId])
    : await query<PrintJobRow>(sql, [organizationId, globalId])
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_JOB_NOT_FOUND',
      'Print job was not found',
      404,
    )
  }
  return jobItem(result.rows[0])
}

export async function readOperationsPrintArtifactPayloadInPostgres(input: {
  organizationId: string
  artifactGlobalId: string
}) {
  const organizationId = requiredOrganizationId(input.organizationId)
  const artifactGlobalId = String(input.artifactGlobalId || '').trim().toLowerCase()
  if (!ARTIFACT_GLOBAL_ID.test(artifactGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ARTIFACT_NOT_FOUND',
      'Print artifact was not found',
      404,
    )
  }
  const result = await query<PrintArtifactPayloadRow>(
    `SELECT
       artifact.global_id,
       artifact.document_type,
       artifact.format,
       artifact.media_size,
       artifact.content_sha256,
       artifact.byte_length::text,
       payload.mime_type AS payload_mime_type,
       payload.filename AS payload_filename,
       payload.payload AS artifact_payload,
       payload.template_version,
       source_label.global_id AS source_label_global_id,
       source_label.format AS source_label_format,
       source_label.label_payload AS source_label_payload,
       rate_test_label.global_id AS rate_test_label_global_id,
       rate_test_label.format AS rate_test_label_format,
       rate_test_label.label_payload AS rate_test_label_payload,
       COALESCE(
         payload.created_at,
         source_label.created_at,
         rate_test_label.created_at,
         artifact.created_at
       ) AS created_at
     FROM operations_print_artifacts artifact
     LEFT JOIN operations_print_artifact_payloads payload
       ON payload.organization_id = artifact.organization_id
      AND payload.artifact_id = artifact.id
     LEFT JOIN operations_labels source_label
       ON source_label.organization_id = artifact.organization_id
      AND source_label.id = artifact.source_label_id
     LEFT JOIN operations_carrier_rate_test_labels rate_test_label
       ON rate_test_label.organization_id = artifact.organization_id
      AND rate_test_label.id = artifact.source_rate_test_label_id
     WHERE artifact.organization_id = $1::uuid
       AND artifact.global_id = $2
     LIMIT 1`,
    [organizationId, artifactGlobalId],
  )
  const artifact = result.rows[0]
  if (!artifact) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ARTIFACT_NOT_FOUND',
      'Print artifact was not found',
      404,
    )
  }
  let payload: Buffer
  let filename: string
  let mimeType: 'application/vnd.zebra-zpl' | 'application/pdf' | 'image/png'
  let templateVersion: string | null = null
  if (
    artifact.document_type !== 'packing_slip'
    && artifact.document_type !== 'shipping_label'
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
      'Print artifact content failed integrity validation',
      500,
    )
  }
  if (artifact.document_type === 'packing_slip') {
    const expectedMimeType = artifact.format === 'PDF'
      ? 'application/pdf'
      : artifact.format === 'PNG'
        ? 'image/png'
        : null
    if (
      !expectedMimeType
      || artifact.payload_mime_type !== expectedMimeType
      || !artifact.payload_filename
      || !artifact.artifact_payload
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
        'Print artifact content failed integrity validation',
        500,
      )
    }
    payload = Buffer.from(artifact.artifact_payload)
    validateDocumentBytes(artifact.format, payload)
    filename = artifact.payload_filename
    mimeType = expectedMimeType
    templateVersion = artifact.template_version
  } else if (
    artifact.document_type === 'shipping_label'
    &&
    artifact.source_label_global_id
    && artifact.source_label_format === artifact.format
    && artifact.source_label_payload !== null
  ) {
    payload = decodeStoredOperationsLabelPayload({
      format: artifact.format,
      payload: artifact.source_label_payload,
    })
    filename = `shipping-label-${artifact.source_label_global_id}`
    mimeType = artifact.format === 'ZPL'
      ? 'application/vnd.zebra-zpl'
      : artifact.format === 'PDF'
        ? 'application/pdf'
        : 'image/png'
  } else if (
    artifact.document_type === 'shipping_label'
    &&
    artifact.rate_test_label_global_id
    && artifact.rate_test_label_format === artifact.format
    && artifact.rate_test_label_payload
  ) {
    payload = validateLabelBytes(
      artifact.format,
      Buffer.from(artifact.rate_test_label_payload),
    )
    filename = `shipping-label-${artifact.rate_test_label_global_id}`
    mimeType = artifact.format === 'ZPL'
      ? 'application/vnd.zebra-zpl'
      : artifact.format === 'PDF'
        ? 'application/pdf'
        : 'image/png'
  } else {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
      'Print artifact content failed integrity validation',
      500,
    )
  }
  const byteLength = Number(artifact.byte_length)
  if (
    !Number.isSafeInteger(byteLength)
    || byteLength !== payload.byteLength
    || contentHash(payload) !== artifact.content_sha256
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
      'Print artifact content failed integrity validation',
      500,
    )
  }
  return {
    globalId: artifact.global_id,
    documentType: artifact.document_type,
    format: artifact.format,
    media: artifact.media_size,
    contentSha256: artifact.content_sha256,
    byteLength,
    mimeType,
    filename,
    payload,
    templateVersion,
    createdAt: iso(artifact.created_at) as string,
  }
}

export async function readOperationsPrintAgentWorkspaceFromPostgres(input: {
  organizationId: string
  canView: boolean
  canManage: boolean
}): Promise<OperationsPrintAgentWorkspace> {
  if (!input.canView) {
    throw new OperationsRequestError(
      'OPERATIONS_FORBIDDEN',
      'You do not have permission to view local print agents',
      403,
    )
  }
  const organizationId = requiredOrganizationId(input.organizationId)
  return {
    organizationId,
    capabilities: { canView: input.canView, canManage: input.canManage },
    agents: await listAgents(organizationId),
    generatedAt: new Date().toISOString(),
  }
}

export async function readOperationsPrintJobWorkspaceFromPostgres(input: {
  organizationId: string
  canView: boolean
  canManage: boolean
  canExecute: boolean
  limit?: number
}): Promise<OperationsPrintJobWorkspace> {
  if (!input.canView) {
    throw new OperationsRequestError(
      'OPERATIONS_FORBIDDEN',
      'You do not have permission to view print jobs',
      403,
    )
  }
  const organizationId = requiredOrganizationId(input.organizationId)
  const result = await query<PrintJobRow>(
    `${PRINT_JOB_SELECT}
     WHERE job.organization_id = $1::uuid
     ORDER BY job.created_at DESC, job.id DESC
     LIMIT $2`,
    [organizationId, Math.max(1, Math.min(input.limit || 100, 250))],
  )
  return {
    organizationId,
    capabilities: {
      canView: input.canView,
      canManage: input.canManage,
      canExecute: input.canExecute,
      canReprint: input.canManage && input.canExecute,
    },
    jobs: result.rows.map(jobItem),
    generatedAt: new Date().toISOString(),
  }
}

export async function enrollOperationsPrintAgentInPostgres(input: {
  organizationId: string
  warehouseId: string
  name: string
  actorEmail: string
  idempotencyKey: string
  supportedFormats?: OperationsPrintAgentProfile['supportedFormats']
  supportedMedia?: OperationsPrintAgentProfile['supportedMedia']
  supportedDocumentTypes?: OperationsPrintAgentProfile['supportedDocumentTypes']
}): Promise<OperationsPrintAgentCredential> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const actorEmail = requiredActor(input.actorEmail)
  const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey)
  const name = String(input.name || '').trim()
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_AGENT_NAME_INVALID',
      'Print agent name is invalid',
    )
  }
  if (!UUID.test(input.warehouseId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_AGENT_WAREHOUSE_INVALID',
      'Print agent warehouse is invalid',
    )
  }
  const capabilities = requiredPrintAgentCapabilities({
    supportedFormats: input.supportedFormats
      || DEFAULT_PRINT_AGENT_CAPABILITIES.supportedFormats,
    supportedMedia: input.supportedMedia
      || DEFAULT_PRINT_AGENT_CAPABILITIES.supportedMedia,
    supportedDocumentTypes: input.supportedDocumentTypes
      || DEFAULT_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes,
  })
  const requestFingerprint = fingerprint({
    action: 'enroll-print-agent',
    warehouseId: input.warehouseId,
    name,
    ...capabilities,
  })
  const legacyRequestFingerprint = fingerprint({
    action: 'enroll-print-agent',
    warehouseId: input.warehouseId,
    name,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:print-agent:${organizationId}:${input.warehouseId}`,
    )
    const replay = await client.query<{
      global_id: string
      request_fingerprint: string
    }>(
      `SELECT global_id, request_fingerprint
       FROM operations_print_agents
       WHERE organization_id = $1::uuid
         AND idempotency_key = $2
       FOR SHARE`,
      [organizationId, idempotencyKey],
    )
    if (replay.rows[0]) {
      const isLegacyDefaultReplay = (
        printAgentCapabilitiesAreSubset(
          capabilities,
          DEFAULT_PRINT_AGENT_CAPABILITIES,
        )
        && printAgentCapabilitiesAreSubset(
          DEFAULT_PRINT_AGENT_CAPABILITIES,
          capabilities,
        )
        && replay.rows[0].request_fingerprint === legacyRequestFingerprint
      )
      if (
        replay.rows[0].request_fingerprint !== requestFingerprint
        && !isLegacyDefaultReplay
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PRINT_IDEMPOTENCY_REUSED',
          'Idempotency-Key was already used for a different print-agent request',
          409,
        )
      }
      return {
        agent: await oneAgent(organizationId, replay.rows[0].global_id, client),
        credential: null,
      }
    }
    const warehouse = await client.query(
      `SELECT id
       FROM operations_warehouses
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND status = 'active'
         AND upper(code) <> 'MOCK-01'
       FOR SHARE`,
      [organizationId, input.warehouseId],
    )
    if (!warehouse.rows[0]) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_AGENT_WAREHOUSE_INVALID',
        'Select an active non-test warehouse',
      )
    }
    const generated = createOperationsPrintAgentCredential()
    const inserted = await client.query<{ global_id: string }>(
      `INSERT INTO operations_print_agents (
         id, organization_id, warehouse_id, name, secret_hash,
         request_fingerprint, idempotency_key, enrolled_by,
         supported_formats, supported_media, supported_document_types
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
         $9::text[], $10::text[], $11::text[]
       )
       RETURNING global_id`,
      [
        generated.agentId,
        organizationId,
        input.warehouseId,
        name,
        generated.secretHash,
        requestFingerprint,
        idempotencyKey,
        actorEmail,
        capabilities.supportedFormats,
        capabilities.supportedMedia,
        capabilities.supportedDocumentTypes,
      ],
    )
    const globalId = inserted.rows[0].global_id
    const agent = await oneAgent(organizationId, globalId, client)
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.print_agent.enrolled',
      aggregateType: 'operations.print_agent',
      aggregateId: globalId,
      eventKey: `operations:print-agent:enrolled:${globalId}`,
      subject: name,
      organizationId,
      payload: {
        printAgentGlobalId: globalId,
        warehouseGlobalId: agent.warehouseGlobalId,
        credentialVersion: agent.credentialVersion,
        supportedFormats: agent.supportedFormats,
        supportedMedia: agent.supportedMedia,
        supportedDocumentTypes: agent.supportedDocumentTypes,
      },
    }, client)
    return { agent, credential: generated.credential }
  })
}

export async function rotateOperationsPrintAgentCredentialInPostgres(input: {
  organizationId: string
  printAgentGlobalId: string
  actorEmail: string
  idempotencyKey: string
}): Promise<OperationsPrintAgentCredential> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const actorEmail = requiredActor(input.actorEmail)
  const callerKey = requiredIdempotencyKey(input.idempotencyKey)
  if (!AGENT_GLOBAL_ID.test(input.printAgentGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_AGENT_NOT_FOUND',
      'Local print agent was not found',
      404,
    )
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:print-agent-rotation:${organizationId}:${callerKey}`,
    )
    const requestFingerprint = fingerprint({
      action: 'rotate-print-agent-credential',
      printAgentGlobalId: input.printAgentGlobalId,
    })
    const auditKey =
      `operations:print-agent:credential-rotation:${organizationId}:${callerKey}`
    const replay = await client.query<{
      payload: { requestFingerprint?: string } | null
    }>(
      `SELECT payload
       FROM audit_events
       WHERE event_key = $1
       LIMIT 1`,
      [auditKey],
    )
    if (replay.rows[0]) {
      if (replay.rows[0].payload?.requestFingerprint !== requestFingerprint) {
        throw new OperationsRequestError(
          'OPERATIONS_PRINT_IDEMPOTENCY_REUSED',
          'Idempotency-Key was already used for a different credential rotation',
          409,
        )
      }
      return {
        agent: await oneAgent(
          organizationId,
          input.printAgentGlobalId,
          client,
        ),
        credential: null,
      }
    }
    const current = await client.query<{
      id: string
      status: string
      warehouse_id: string
    }>(
      `SELECT id::text, status, warehouse_id::text
       FROM operations_print_agents
       WHERE organization_id = $1::uuid
         AND global_id = $2
       FOR UPDATE`,
      [organizationId, input.printAgentGlobalId],
    )
    if (!current.rows[0]) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_AGENT_NOT_FOUND',
        'Local print agent was not found',
        404,
      )
    }
    if (current.rows[0].status !== 'active') {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_AGENT_REVOKED',
        'Revoked print agents cannot rotate credentials',
        409,
      )
    }
    const generated = createOperationsPrintAgentCredential(current.rows[0].id)
    await client.query(
      `UPDATE operations_print_agents
       SET secret_hash = $3,
           credential_version = credential_version + 1,
           rotated_by = $4,
           rotated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [
        organizationId,
        input.printAgentGlobalId,
        generated.secretHash,
        actorEmail,
      ],
    )
    const agent = await oneAgent(organizationId, input.printAgentGlobalId, client)
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.print_agent.credential_rotated',
      aggregateType: 'operations.print_agent',
      aggregateId: agent.globalId,
      eventKey: auditKey,
      subject: agent.name,
      organizationId,
      payload: {
        printAgentGlobalId: agent.globalId,
        warehouseGlobalId: agent.warehouseGlobalId,
        credentialVersion: agent.credentialVersion,
        requestFingerprint,
      },
    }, client)
    return {
      agent,
      credential: generated.credential,
    }
  })
}

export async function revokeOperationsPrintAgentInPostgres(input: {
  organizationId: string
  printAgentGlobalId: string
  actorEmail: string
}) {
  const organizationId = requiredOrganizationId(input.organizationId)
  const actorEmail = requiredActor(input.actorEmail)
  if (!AGENT_GLOBAL_ID.test(input.printAgentGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_AGENT_NOT_FOUND',
      'Local print agent was not found',
      404,
    )
  }
  return withTransaction(async (client) => {
    const current = await client.query<{
      id: string
      status: string
      warehouse_id: string
    }>(
      `SELECT id::text, status, warehouse_id::text
       FROM operations_print_agents
       WHERE organization_id = $1::uuid
         AND global_id = $2
       FOR UPDATE`,
      [organizationId, input.printAgentGlobalId],
    )
    if (!current.rows[0]) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_AGENT_NOT_FOUND',
        'Local print agent was not found',
        404,
      )
    }
    if (current.rows[0].status === 'active') {
      await client.query(
        `UPDATE operations_printers
         SET local_print_agent_id = NULL,
             status = CASE
               WHEN connection_mode = 'local_agent' THEN 'offline'
               ELSE status
             END,
             row_version = row_version + 1,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND local_print_agent_id = $2::uuid`,
        [organizationId, current.rows[0].id],
      )
      await client.query(
        `UPDATE operations_print_agents
         SET status = 'revoked', revoked_by = $3, revoked_at = clock_timestamp()
         WHERE organization_id = $1::uuid
           AND global_id = $2`,
        [organizationId, input.printAgentGlobalId, actorEmail],
      )
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.print_agent.revoked',
        aggregateType: 'operations.print_agent',
        aggregateId: input.printAgentGlobalId,
        eventKey: `operations:print-agent:revoked:${input.printAgentGlobalId}`,
        organizationId,
        payload: { printAgentGlobalId: input.printAgentGlobalId },
      }, client)
      await rerouteUnavailableQueuedJobs({
        client,
        organizationId,
        warehouseId: current.rows[0].warehouse_id,
        reason: `Local print agent ${input.printAgentGlobalId} was revoked`,
      })
    }
    return oneAgent(organizationId, input.printAgentGlobalId, client)
  })
}

export async function authenticateOperationsPrintAgentInPostgres(
  credential: string,
): Promise<OperationsPrintAgentContext | null> {
  const parsed = parseAgentCredential(credential)
  if (!parsed) return null
  const result = await query<{
    id: string
    global_id: string
    organization_id: string
    warehouse_id: string
    name: string
    secret_hash: string
    status: string
    credential_version: number
    supported_formats: OperationsPrintAgentContext['supportedFormats']
    supported_media: OperationsPrintAgentContext['supportedMedia']
    supported_document_types: OperationsPrintAgentContext['supportedDocumentTypes']
  }>(
    `SELECT id::text, global_id, organization_id::text, warehouse_id::text,
       name, secret_hash, status, credential_version,
       supported_formats, supported_media, supported_document_types
     FROM operations_print_agents
     WHERE id = $1::uuid
     LIMIT 1`,
    [parsed.agentId],
  )
  const agent = result.rows[0]
  const providedHash = hashOperationsPrintAgentSecret(
    parsed.agentId,
    parsed.secret,
  )
  if (
    !agent
    || agent.status !== 'active'
    || !secureHashEqual(agent.secret_hash, providedHash)
  ) {
    return null
  }
  return {
    id: agent.id,
    globalId: agent.global_id,
    organizationId: agent.organization_id,
    warehouseId: agent.warehouse_id,
    name: agent.name,
    credentialVersion: agent.credential_version,
    supportedFormats: agent.supported_formats,
    supportedMedia: agent.supported_media,
    supportedDocumentTypes: agent.supported_document_types,
  }
}

type PrintSourceLinkage = {
  orderId: string | null
  orderGlobalId: string | null
  orderNumber: string | null
  shipmentId: string | null
  shipmentGlobalId: string | null
  trackingNumber: string | null
}

async function resolvePackingSlipSource(
  client: PoolClient,
  input: EnqueueOperationsPrintJobInput,
  organizationId: string,
): Promise<PrintSourceLinkage> {
  if (input.document.type !== 'packing_slip') {
    return {
      orderId: null,
      orderGlobalId: null,
      orderNumber: null,
      shipmentId: null,
      shipmentGlobalId: null,
      trackingNumber: null,
    }
  }
  const orderGlobalId = String(input.document.sourceOrderGlobalId || '').trim()
  const shipmentGlobalId = String(input.document.sourceShipmentGlobalId || '').trim()
  if (orderGlobalId && !ORDER_GLOBAL_ID.test(orderGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ORDER_INVALID',
      'Packing-slip order reference is invalid',
    )
  }
  if (shipmentGlobalId && !SHIPMENT_GLOBAL_ID.test(shipmentGlobalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_SHIPMENT_INVALID',
      'Packing-slip shipment reference is invalid',
    )
  }
  if (shipmentGlobalId) {
    const shipment = await client.query<{
      shipment_id: string
      shipment_global_id: string
      tracking_number: string
      order_id: string
      order_global_id: string
      order_number: string
      warehouse_id: string
    }>(
      `SELECT
         shipment.id::text AS shipment_id,
         shipment.global_id AS shipment_global_id,
         shipment.tracking_number,
         source_order.id::text AS order_id,
         source_order.global_id AS order_global_id,
         source_order.order_number,
         plan.warehouse_id::text
       FROM operations_shipments shipment
       JOIN operations_orders source_order
         ON source_order.organization_id = shipment.organization_id
        AND source_order.id = shipment.order_id
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = shipment.organization_id
        AND plan.id = shipment.plan_id
       WHERE shipment.organization_id = $1::uuid
         AND shipment.global_id = $2
       FOR SHARE OF shipment, source_order, plan`,
      [organizationId, shipmentGlobalId],
    )
    const row = shipment.rows[0]
    if (!row || row.warehouse_id !== input.warehouseId) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_SHIPMENT_INVALID',
        'Packing-slip shipment was not found in the selected warehouse',
        404,
      )
    }
    if (orderGlobalId && orderGlobalId !== row.order_global_id) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_SOURCE_MISMATCH',
        'Packing-slip order and shipment do not belong together',
        409,
      )
    }
    return {
      orderId: row.order_id,
      orderGlobalId: row.order_global_id,
      orderNumber: row.order_number,
      shipmentId: row.shipment_id,
      shipmentGlobalId: row.shipment_global_id,
      trackingNumber: row.tracking_number,
    }
  }
  if (orderGlobalId) {
    const order = await client.query<{
      id: string
      global_id: string
      order_number: string
    }>(
      `SELECT id::text, global_id, order_number
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND global_id = $2
       FOR SHARE`,
      [organizationId, orderGlobalId],
    )
    if (!order.rows[0]) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ORDER_INVALID',
        'Packing-slip order was not found',
        404,
      )
    }
    return {
      orderId: order.rows[0].id,
      orderGlobalId: order.rows[0].global_id,
      orderNumber: order.rows[0].order_number,
      shipmentId: null,
      shipmentGlobalId: null,
      trackingNumber: null,
    }
  }
  return {
    orderId: null,
    orderGlobalId: null,
    orderNumber: null,
    shipmentId: null,
    shipmentGlobalId: null,
    trackingNumber: null,
  }
}

async function insertArtifact(
  client: PoolClient,
  input: EnqueueOperationsPrintJobInput,
  organizationId: string,
  actorEmail: string,
) {
  if (input.document.type === 'shipping_label') {
    if (!LABEL_GLOBAL_ID.test(input.document.sourceLabelGlobalId)) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_LABEL_INVALID',
        'Shipping label reference is invalid',
      )
    }
    const label = await client.query<{
      id: string
      global_id: string
      format: PrintFormat
      label_payload: string
      warehouse_id: string
      order_id: string
      order_global_id: string
      order_number: string
      shipment_id: string | null
      shipment_global_id: string | null
      tracking_number: string
    }>(
      `SELECT label.id::text, label.global_id, label.format, label.label_payload,
         plan.warehouse_id::text,
         source_order.id::text AS order_id,
         source_order.global_id AS order_global_id,
         source_order.order_number,
         shipment.id::text AS shipment_id,
         shipment.global_id AS shipment_global_id,
         label.tracking_number
       FROM operations_labels label
       JOIN operations_packages package
         ON package.organization_id = label.organization_id
        AND package.id = label.package_id
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = package.organization_id
        AND plan.id = package.plan_id
       JOIN operations_orders source_order
         ON source_order.organization_id = plan.organization_id
        AND source_order.id = plan.order_id
       LEFT JOIN operations_shipments shipment
         ON shipment.organization_id = label.organization_id
        AND shipment.label_id = label.id
       WHERE label.organization_id = $1::uuid
         AND label.global_id = $2
         AND label.status = 'created'
       FOR SHARE OF label, package, plan, source_order`,
      [organizationId, input.document.sourceLabelGlobalId],
    )
    if (!label.rows[0] || label.rows[0].warehouse_id !== input.warehouseId) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_LABEL_INVALID',
        'Active shipping label was not found in the selected warehouse',
        404,
      )
    }
    const row = label.rows[0]
    const labelBytes = decodeStoredOperationsLabelPayload({
      format: row.format,
      payload: row.label_payload,
    })
    const contentSha256 = contentHash(labelBytes)
    const byteLength = labelBytes.byteLength
    await client.query(
      `INSERT INTO operations_print_artifacts (
         organization_id, source_label_id, source_order_id, source_shipment_id,
         document_type, format, media_size, content_sha256, byte_length,
         storage_reference, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         'shipping_label', $5, $6, $7, $8, $9, $10
       )
       ON CONFLICT (
         organization_id, source_label_id, format, media_size
       ) DO NOTHING`,
      [
        organizationId,
        row.id,
        row.order_id,
        row.shipment_id,
        row.format,
        input.document.media,
        contentSha256,
        byteLength,
        `clawpilot-label:${row.global_id}`,
        actorEmail,
      ],
    )
    const artifact = await client.query<{
      id: string
      global_id: string
      format: PrintFormat
    }>(
      `SELECT id::text, global_id, format
       FROM operations_print_artifacts
       WHERE organization_id = $1::uuid
         AND source_label_id = $2::uuid
         AND format = $3
         AND media_size = $4
       FOR SHARE`,
      [organizationId, row.id, row.format, input.document.media],
    )
    return {
      id: artifact.rows[0].id,
      globalId: artifact.rows[0].global_id,
      labelId: row.id,
      rateTestLabelId: null,
      type: 'shipping_label' as const,
      format: artifact.rows[0].format,
      media: input.document.media,
      source: {
        orderId: row.order_id,
        orderGlobalId: row.order_global_id,
        orderNumber: row.order_number,
        shipmentId: row.shipment_id,
        shipmentGlobalId: row.shipment_global_id,
        trackingNumber: row.tracking_number,
      },
    }
  }

  if (input.document.type === 'rate_test_label') {
    if (!RATE_TEST_LABEL_GLOBAL_ID.test(
      input.document.sourceRateTestLabelGlobalId,
    )) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_LABEL_INVALID',
        'Rate-test label reference is invalid',
      )
    }
    const label = await client.query<{
      id: string
      global_id: string
      format: PrintFormat
      media_size: Extract<PrintMedia, 'label_4x6' | 'label_4x8'>
      label_payload: Buffer
      content_sha256: string
      byte_length: string
      tracking_number: string
    }>(
      `SELECT
         label.id::text,
         label.global_id,
         label.format,
         label.media_size,
         label.label_payload,
         label.content_sha256,
         octet_length(label.label_payload)::text AS byte_length,
         label.tracking_number
       FROM operations_carrier_rate_test_labels label
       WHERE label.organization_id = $1::uuid
         AND label.global_id = $2
         AND label.status = 'created'
       FOR SHARE`,
      [organizationId, input.document.sourceRateTestLabelGlobalId],
    )
    const row = label.rows[0]
    if (!row || row.media_size !== input.document.media) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_LABEL_INVALID',
        'Active rate-test label was not found with the selected media',
        404,
      )
    }
    const labelBytes = validateLabelBytes(row.format, Buffer.from(row.label_payload))
    if (
      contentHash(labelBytes) !== row.content_sha256
      || labelBytes.byteLength !== Number(row.byte_length)
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
        'Rate-test label content failed integrity validation',
        500,
      )
    }
    await client.query(
      `INSERT INTO operations_print_artifacts (
         organization_id, source_rate_test_label_id,
         document_type, format, media_size, content_sha256, byte_length,
         storage_reference, created_by
       ) VALUES (
         $1::uuid, $2::uuid,
         'shipping_label', $3, $4, $5, $6, $7, $8
       )
       ON CONFLICT (
         organization_id, source_rate_test_label_id, format, media_size
       ) WHERE source_rate_test_label_id IS NOT NULL
       DO NOTHING`,
      [
        organizationId,
        row.id,
        row.format,
        row.media_size,
        row.content_sha256,
        labelBytes.byteLength,
        `clawpilot-rate-test-label:${row.global_id}`,
        actorEmail,
      ],
    )
    const artifact = await client.query<{
      id: string
      global_id: string
      format: PrintFormat
    }>(
      `SELECT id::text, global_id, format
       FROM operations_print_artifacts
       WHERE organization_id = $1::uuid
         AND source_rate_test_label_id = $2::uuid
         AND format = $3
         AND media_size = $4
       FOR SHARE`,
      [organizationId, row.id, row.format, row.media_size],
    )
    if (!artifact.rows[0]) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ARTIFACT_CONFLICT',
        'Rate-test label artifact could not be resolved',
        409,
      )
    }
    return {
      id: artifact.rows[0].id,
      globalId: artifact.rows[0].global_id,
      labelId: null,
      rateTestLabelId: row.id,
      type: 'shipping_label' as const,
      format: artifact.rows[0].format,
      media: row.media_size,
      source: {
        orderId: null,
        orderGlobalId: null,
        orderNumber: null,
        shipmentId: null,
        shipmentGlobalId: null,
        trackingNumber: row.tracking_number,
      },
    }
  }

  if (input.document.type === 'packing_slip_artifact') {
    if (!ARTIFACT_GLOBAL_ID.test(input.document.sourceArtifactGlobalId)) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ARTIFACT_INVALID',
        'Packing-list artifact reference is invalid',
      )
    }
    const artifactResult = await client.query<{
      id: string
      global_id: string
      format: Extract<PrintFormat, 'PDF' | 'PNG'>
      media_size: Extract<PrintMedia, 'letter' | 'a4'>
      content_sha256: string
      byte_length: string
      payload: Buffer | null
      order_id: string
      order_global_id: string
      order_number: string
      shipment_id: string | null
      shipment_global_id: string | null
      tracking_number: string | null
      warehouse_id: string
    }>(
      `SELECT
         artifact.id::text,
         artifact.global_id,
         artifact.format,
         artifact.media_size,
         artifact.content_sha256,
         artifact.byte_length::text,
         payload.payload,
         source_order.id::text AS order_id,
         source_order.global_id AS order_global_id,
         source_order.order_number,
         shipment.id::text AS shipment_id,
         shipment.global_id AS shipment_global_id,
         shipment.tracking_number,
         plan.warehouse_id::text
       FROM operations_print_artifacts artifact
       JOIN operations_print_artifact_payloads payload
         ON payload.organization_id = artifact.organization_id
        AND payload.artifact_id = artifact.id
       JOIN operations_packages package
         ON package.organization_id = artifact.organization_id
        AND package.id = artifact.source_package_id
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = package.organization_id
        AND plan.id = package.plan_id
       JOIN operations_orders source_order
         ON source_order.organization_id = plan.organization_id
        AND source_order.id = plan.order_id
        AND source_order.id = artifact.source_order_id
       LEFT JOIN operations_shipments shipment
         ON shipment.organization_id = artifact.organization_id
        AND shipment.id = artifact.source_shipment_id
       WHERE artifact.organization_id = $1::uuid
         AND artifact.global_id = $2
         AND artifact.document_type = 'packing_slip'
         AND artifact.format IN ('PDF', 'PNG')
         AND artifact.media_size IN ('letter', 'a4')
       FOR SHARE OF artifact, payload, package, plan, source_order`,
      [organizationId, input.document.sourceArtifactGlobalId],
    )
    const artifact = artifactResult.rows[0]
    if (!artifact || artifact.warehouse_id !== input.warehouseId) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ARTIFACT_INVALID',
        'Packing list was not found in the selected warehouse',
        404,
      )
    }
    const payload = artifact.payload ? Buffer.from(artifact.payload) : null
    if (
      !payload
      || payload.byteLength !== Number(artifact.byte_length)
      || contentHash(payload) !== artifact.content_sha256
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
        'Packing-list content failed integrity validation',
        500,
      )
    }
    return {
      id: artifact.id,
      globalId: artifact.global_id,
      labelId: null,
      rateTestLabelId: null,
      type: 'packing_slip' as const,
      format: artifact.format,
      media: artifact.media_size,
      source: {
        orderId: artifact.order_id,
        orderGlobalId: artifact.order_global_id,
        orderNumber: artifact.order_number,
        shipmentId: artifact.shipment_id,
        shipmentGlobalId: artifact.shipment_global_id,
        trackingNumber: artifact.tracking_number,
      },
    }
  }

  if (
    !SHA256.test(input.document.contentSha256)
    || !Number.isSafeInteger(input.document.byteLength)
    || input.document.byteLength < 1
    || input.document.byteLength > 50 * 1024 * 1024
    || !stableStorageReference(input.document.storageReference)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ARTIFACT_INVALID',
      'Packing-slip artifact metadata is invalid',
    )
  }
  const source = await resolvePackingSlipSource(
    client,
    input,
    organizationId,
  )
  const inserted = await client.query<{
    id: string
    global_id: string
  }>(
    `INSERT INTO operations_print_artifacts (
       organization_id, source_order_id, source_shipment_id,
       document_type, format, media_size, content_sha256,
       byte_length, storage_reference, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'packing_slip',
       $4, $5, $6, $7, $8, $9
     )
     ON CONFLICT (
       organization_id, content_sha256, storage_reference
     ) DO NOTHING
     RETURNING id::text, global_id`,
    [
      organizationId,
      source.orderId,
      source.shipmentId,
      input.document.format,
      input.document.media,
      input.document.contentSha256,
      input.document.byteLength,
      input.document.storageReference,
      actorEmail,
    ],
  )
  if (inserted.rows[0]) {
    return {
      id: inserted.rows[0].id,
      globalId: inserted.rows[0].global_id,
      labelId: null,
      rateTestLabelId: null,
      type: 'packing_slip' as const,
      format: input.document.format,
      media: input.document.media,
      source,
    }
  }
  const artifact = await client.query<{
    id: string
    global_id: string
    source_order_id: string | null
    source_shipment_id: string | null
  }>(
    `SELECT id::text, global_id, source_order_id::text, source_shipment_id::text
     FROM operations_print_artifacts
     WHERE organization_id = $1::uuid
       AND content_sha256 = $2
       AND storage_reference = $3
       AND document_type = 'packing_slip'
       AND format = $4
       AND media_size = $5
     FOR SHARE`,
    [
      organizationId,
      input.document.contentSha256,
      input.document.storageReference,
      input.document.format,
      input.document.media,
    ],
  )
  if (!artifact.rows[0]) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ARTIFACT_CONFLICT',
      'Artifact content reference already exists with different print metadata',
      409,
    )
  }
  if (
    artifact.rows[0].source_order_id !== source.orderId
    || artifact.rows[0].source_shipment_id !== source.shipmentId
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ARTIFACT_CONFLICT',
      'Artifact content reference is already linked to a different order or shipment',
      409,
    )
  }
  return {
    id: artifact.rows[0].id,
    globalId: artifact.rows[0].global_id,
    labelId: null,
    rateTestLabelId: null,
    type: 'packing_slip' as const,
    format: input.document.format,
    media: input.document.media,
    source,
  }
}

async function insertQueuedAttempt(input: {
  client: PoolClient
  organizationId: string
  jobId: string
  actorEmail: string | null
  actorType: 'user' | 'system'
  idempotencyKey: string
  requestFingerprint: string
  detail: string
}) {
  await input.client.query(
    `INSERT INTO operations_print_delivery_attempts (
       organization_id, print_job_id, printer_id,
       state, actor_type, actor_email, idempotency_key,
       request_fingerprint, detail
     )
     SELECT organization_id, id, printer_id,
       'queued', $3, $4, $5, $6, $7
     FROM operations_print_jobs
     WHERE organization_id = $1::uuid
       AND id = $2::uuid`,
    [
      input.organizationId,
      input.jobId,
      input.actorType,
      input.actorEmail,
      input.idempotencyKey,
      input.requestFingerprint,
      input.detail,
    ],
  )
}

async function assertShippingLabelCanBeEnqueued(input: {
  client: PoolClient
  organizationId: string
  sourceLabelGlobalId: string
}) {
  await acquireTransactionAdvisoryLock(
    input.client,
    `operations:print-label:${input.organizationId}:${input.sourceLabelGlobalId}`,
  )
  const existing = await input.client.query<{
    global_id: string
    status: OperationsPrintJobListItem['status']
  }>(
    `SELECT job.global_id, job.status
     FROM operations_print_jobs job
     JOIN operations_labels label
       ON label.organization_id = job.organization_id
      AND label.id = job.label_id
     WHERE job.organization_id = $1::uuid
       AND label.global_id = $2
       AND job.reprint_of_job_id IS NULL
     LIMIT 1
     FOR SHARE OF job, label`,
    [input.organizationId, input.sourceLabelGlobalId],
  )
  if (!existing.rows[0]) return
  const job = existing.rows[0]
  const nextStep = job.status === 'delivered'
    ? 'Use the controlled reprint action and provide a reprint reason.'
    : job.status === 'failed'
      ? 'Use the retry action after resolving the printer route.'
      : job.status === 'cancelled'
        ? 'Generate a new carrier label before creating another print job.'
        : 'Wait for or manage the existing print job.'
  throw new OperationsRequestError(
    'OPERATIONS_PRINT_LABEL_ALREADY_ENQUEUED',
    `Shipping label already has original print job ${job.global_id} (${job.status}). ${nextStep}`,
    409,
  )
}

async function assertRateTestLabelCanBeEnqueued(input: {
  client: PoolClient
  organizationId: string
  sourceRateTestLabelGlobalId: string
}) {
  await acquireTransactionAdvisoryLock(
    input.client,
    `operations:print-rate-test-label:${input.organizationId}:${input.sourceRateTestLabelGlobalId}`,
  )
  const existing = await input.client.query<{
    global_id: string
    status: OperationsPrintJobListItem['status']
  }>(
    `SELECT job.global_id, job.status
     FROM operations_print_jobs job
     JOIN operations_carrier_rate_test_labels label
       ON label.organization_id = job.organization_id
      AND label.id = job.rate_test_label_id
     WHERE job.organization_id = $1::uuid
       AND label.global_id = $2
       AND job.reprint_of_job_id IS NULL
     LIMIT 1
     FOR SHARE OF job, label`,
    [input.organizationId, input.sourceRateTestLabelGlobalId],
  )
  if (!existing.rows[0]) return
  const job = existing.rows[0]
  const nextStep = job.status === 'delivered'
    ? 'Use the controlled reprint action and provide a reprint reason.'
    : job.status === 'failed'
      ? 'Use the retry action after resolving the printer route.'
      : job.status === 'cancelled'
        ? 'Create a new rate-test label before creating another print job.'
        : 'Wait for or manage the existing print job.'
  throw new OperationsRequestError(
    'OPERATIONS_PRINT_LABEL_ALREADY_ENQUEUED',
    `Rate-test label already has original print job ${job.global_id} (${job.status}). ${nextStep}`,
    409,
  )
}

async function assertPackingSlipArtifactCanBeEnqueued(input: {
  client: PoolClient
  organizationId: string
  artifactGlobalId: string
}) {
  await acquireTransactionAdvisoryLock(
    input.client,
    `operations:print-packing-slip:${input.organizationId}:${input.artifactGlobalId}`,
  )
  const existing = await input.client.query<{
    global_id: string
    status: OperationsPrintJobListItem['status']
  }>(
    `SELECT job.global_id, job.status
     FROM operations_print_jobs job
     JOIN operations_print_artifacts artifact
       ON artifact.organization_id = job.organization_id
      AND artifact.id = job.artifact_id
     WHERE job.organization_id = $1::uuid
       AND artifact.global_id = $2
       AND artifact.document_type = 'packing_slip'
       AND job.reprint_of_job_id IS NULL
     LIMIT 1
     FOR SHARE OF job, artifact`,
    [input.organizationId, input.artifactGlobalId],
  )
  if (!existing.rows[0]) return
  const job = existing.rows[0]
  const nextStep = job.status === 'delivered'
    ? 'Use the controlled reprint action and provide a reprint reason.'
    : job.status === 'failed'
      ? 'Use the retry action after resolving the printer route.'
      : job.status === 'cancelled'
        ? 'Generate a replacement packing list only if the package allocation changes.'
        : 'Wait for or manage the existing print job.'
  throw new OperationsRequestError(
    'OPERATIONS_PRINT_PACKING_SLIP_ALREADY_ENQUEUED',
    `Packing list already has original print job ${job.global_id} (${job.status}). ${nextStep}`,
    409,
  )
}

export async function enqueueOperationsPrintJobInPostgres(
  input: EnqueueOperationsPrintJobInput,
) {
  const organizationId = requiredOrganizationId(input.organizationId)
  const actorEmail = requiredActor(input.actorEmail)
  const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey)
  if (!UUID.test(input.warehouseId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_WAREHOUSE_INVALID',
      'Print warehouse is invalid',
    )
  }
  const maxAttempts = input.maxAttempts === undefined ? 3 : Number(input.maxAttempts)
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ATTEMPTS_INVALID',
      'Print attempts must be an integer from 1 to 10',
    )
  }
  const requestFingerprint = fingerprint({
    action: 'enqueue-print-job',
    warehouseId: input.warehouseId,
    preferredPrinterGlobalId: input.preferredPrinterGlobalId || null,
    maxAttempts,
    document: input.document,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:print-job:${organizationId}:${idempotencyKey}`,
    )
    const replay = await client.query<{
      global_id: string
      request_fingerprint: string | null
    }>(
      `SELECT global_id, request_fingerprint
       FROM operations_print_jobs
       WHERE organization_id = $1::uuid
         AND idempotency_key = $2
       FOR SHARE`,
      [organizationId, idempotencyKey],
    )
    if (replay.rows[0]) {
      if (replay.rows[0].request_fingerprint !== requestFingerprint) {
        throw new OperationsRequestError(
          'OPERATIONS_PRINT_IDEMPOTENCY_REUSED',
          'Idempotency-Key was already used for a different print request',
          409,
        )
      }
      return oneJob(organizationId, replay.rows[0].global_id, client)
    }
    if (input.document.type === 'shipping_label') {
      await assertShippingLabelCanBeEnqueued({
        client,
        organizationId,
        sourceLabelGlobalId: input.document.sourceLabelGlobalId,
      })
    } else if (input.document.type === 'rate_test_label') {
      await assertRateTestLabelCanBeEnqueued({
        client,
        organizationId,
        sourceRateTestLabelGlobalId: input.document.sourceRateTestLabelGlobalId,
      })
    }
    const artifact = await insertArtifact(client, input, organizationId, actorEmail)
    if (artifact.type === 'packing_slip') {
      await assertPackingSlipArtifactCanBeEnqueued({
        client,
        organizationId,
        artifactGlobalId: artifact.globalId,
      })
    }
    const profiles = await listOperationsPrinterProfilesInPostgres(organizationId, client)
    const route = selectPrinterRoute(profiles, {
      warehouseId: input.warehouseId,
      documentType: artifact.type,
      format: artifact.format,
      media: artifact.media,
      durable: true,
      preferredPrinterGlobalId: input.preferredPrinterGlobalId,
    })
    if (!route) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ROUTE_UNAVAILABLE',
        'No online local-agent printer supports this document format and media',
        409,
      )
    }
    const inserted = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_print_jobs (
         organization_id, label_id, rate_test_label_id,
         artifact_id, printer_id,
         requested_printer_id, fallback_printer_id,
         status, routing_reason, attempts, max_attempts,
         request_fingerprint, enqueued_by, idempotency_key
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         $4::uuid, $5::uuid,
         $6::uuid, $7::uuid,
         'queued', $8, 0, $9, $10, $11, $12
       )
       RETURNING id::text, global_id`,
      [
        organizationId,
        artifact.labelId,
        artifact.rateTestLabelId,
        artifact.id,
        route.printer.id,
        route.requestedPrinter.id,
        route.fallbackPrinter?.id || null,
        route.reason,
        maxAttempts,
        requestFingerprint,
        actorEmail,
        idempotencyKey,
      ],
    )
    const job = inserted.rows[0]
    await insertQueuedAttempt({
      client,
      organizationId,
      jobId: job.id,
      actorEmail,
      actorType: 'user',
      idempotencyKey: `print-job:${job.global_id}:queued:1`,
      requestFingerprint: fingerprint({
        state: 'queued',
        jobGlobalId: job.global_id,
        attempt: 1,
      }),
      detail: route.reason,
    })
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.print_job.queued',
      aggregateType: 'operations.print_job',
      aggregateId: job.global_id,
      eventKey: `operations:print-job:queued:${job.global_id}`,
      organizationId,
      payload: {
        printJobGlobalId: job.global_id,
        printArtifactGlobalId: artifact.globalId,
        documentType: artifact.type,
        format: artifact.format,
        media: artifact.media,
        requestedPrinterGlobalId: route.requestedPrinter.globalId,
        selectedPrinterGlobalId: route.printer.globalId,
        fallbackPrinterGlobalId: route.fallbackPrinter?.globalId || null,
        usedFallback: route.usedFallback,
        sourceOrderGlobalId: artifact.source.orderGlobalId,
        sourceOrderNumber: artifact.source.orderNumber,
        sourceShipmentGlobalId: artifact.source.shipmentGlobalId,
        trackingNumber: artifact.source.trackingNumber,
        sourceRateTestLabelGlobalId: input.document.type === 'rate_test_label'
          ? input.document.sourceRateTestLabelGlobalId
          : null,
      },
    }, client)
    return oneJob(organizationId, job.global_id, client)
  })
}

const LOCKED_PRINT_JOB_SELECT = `
  SELECT
    job.id::text,
    job.global_id,
    job.organization_id::text,
    job.label_id::text,
    job.rate_test_label_id::text,
    artifact.source_order_id::text,
    source_order.global_id AS source_order_global_id,
    artifact.source_shipment_id::text,
    source_shipment.global_id AS source_shipment_global_id,
    COALESCE(
      source_shipment.tracking_number,
      source_label.tracking_number,
      rate_test_label.tracking_number
    )
      AS tracking_number,
    job.artifact_id::text,
    artifact.document_type,
    artifact.format,
    artifact.media_size,
    requested.warehouse_id::text,
    job.printer_id::text,
    printer.global_id AS printer_global_id,
    job.requested_printer_id::text,
    requested.global_id AS requested_printer_global_id,
    job.fallback_printer_id::text,
    fallback.global_id AS fallback_printer_global_id,
    job.status,
    job.attempts,
    job.max_attempts,
    job.claimed_by_print_agent_id::text,
    job.current_claim_attempt_id::text,
    job.claim_expires_at
  FROM operations_print_jobs job
  JOIN operations_print_artifacts artifact
    ON artifact.organization_id = job.organization_id
   AND artifact.id = job.artifact_id
  LEFT JOIN operations_orders source_order
    ON source_order.organization_id = artifact.organization_id
   AND source_order.id = artifact.source_order_id
  LEFT JOIN operations_shipments source_shipment
    ON source_shipment.organization_id = artifact.organization_id
   AND source_shipment.id = artifact.source_shipment_id
  LEFT JOIN operations_labels source_label
    ON source_label.organization_id = artifact.organization_id
   AND source_label.id = artifact.source_label_id
  LEFT JOIN operations_carrier_rate_test_labels rate_test_label
    ON rate_test_label.organization_id = artifact.organization_id
   AND rate_test_label.id = artifact.source_rate_test_label_id
  JOIN operations_printers printer
    ON printer.organization_id = job.organization_id
   AND printer.id = job.printer_id
  JOIN operations_printers requested
    ON requested.organization_id = job.organization_id
   AND requested.id = job.requested_printer_id
  LEFT JOIN operations_printers fallback
    ON fallback.organization_id = job.organization_id
   AND fallback.id = job.fallback_printer_id
`

async function lockedJob(
  client: PoolClient,
  organizationId: string,
  globalId: string,
) {
  if (!JOB_GLOBAL_ID.test(globalId)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_JOB_NOT_FOUND',
      'Print job was not found',
      404,
    )
  }
  const result = await client.query<LockedPrintJobRow>(
    `${LOCKED_PRINT_JOB_SELECT}
     WHERE job.organization_id = $1::uuid
       AND job.global_id = $2
     FOR UPDATE OF job`,
    [organizationId, globalId],
  )
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_JOB_NOT_FOUND',
      'Print job was not found',
      404,
    )
  }
  return result.rows[0]
}

async function attemptReplay(input: {
  client: PoolClient
  organizationId: string
  idempotencyKey: string
  requestFingerprint: string
}) {
  const replay = await input.client.query<{
    print_job_id: string
    request_fingerprint: string
  }>(
    `SELECT print_job_id::text, request_fingerprint
     FROM operations_print_delivery_attempts
     WHERE organization_id = $1::uuid
       AND idempotency_key = $2
     LIMIT 1`,
    [input.organizationId, input.idempotencyKey],
  )
  if (
    replay.rows[0]
    && replay.rows[0].request_fingerprint !== input.requestFingerprint
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_IDEMPOTENCY_REUSED',
      'Idempotency-Key was already used for a different print result',
      409,
    )
  }
  return replay.rows[0] || null
}

function routeProfile(
  profiles: OperationsPrinterProfile[],
  globalId: string | null,
) {
  return globalId
    ? profiles.find((profile) => profile.globalId === globalId) || null
    : null
}

function retryTarget(
  profiles: OperationsPrinterProfile[],
  job: LockedPrintJobRow,
  preferFallback: boolean,
) {
  const request = {
    warehouseId: job.warehouse_id,
    documentType: job.document_type,
    format: job.format,
    media: job.media_size,
    durable: true,
  } as const
  const requested = routeProfile(profiles, job.requested_printer_global_id)
  const fallback = routeProfile(profiles, job.fallback_printer_global_id)
  if (
    preferFallback
    && fallback?.status === 'online'
    && supportsPrinterRoute(fallback, request)
  ) {
    return fallback
  }
  if (
    requested?.status === 'online'
    && supportsPrinterRoute(requested, request)
  ) {
    return requested
  }
  if (
    fallback?.status === 'online'
    && supportsPrinterRoute(fallback, request)
  ) {
    return fallback
  }
  return null
}

async function rerouteUnavailableQueuedJobs(input: {
  client: PoolClient
  organizationId: string
  warehouseId: string
  reason: string
}) {
  const jobs = await input.client.query<LockedPrintJobRow>(
    `${LOCKED_PRINT_JOB_SELECT}
     WHERE job.organization_id = $1::uuid
       AND requested.warehouse_id = $2::uuid
       AND job.status = 'queued'
       AND (
         printer.status <> 'online'
         OR printer.connection_mode <> 'local_agent'
         OR printer.local_print_agent_id IS NULL
         OR NOT EXISTS (
           SELECT 1
           FROM operations_print_agents selected_agent
           WHERE selected_agent.organization_id = printer.organization_id
             AND selected_agent.warehouse_id = printer.warehouse_id
             AND selected_agent.id = printer.local_print_agent_id
             AND selected_agent.status = 'active'
         )
       )
     ORDER BY job.available_at, job.created_at, job.id
     FOR UPDATE OF job SKIP LOCKED
     LIMIT 100`,
    [input.organizationId, input.warehouseId],
  )
  if (!jobs.rows.length) return { rerouted: 0, failed: 0 }
  const profiles = await listOperationsPrinterProfilesInPostgres(
    input.organizationId,
    input.client,
  )
  let rerouted = 0
  let failed = 0
  for (const job of jobs.rows) {
    const target = retryTarget(profiles, job, true)
    if (!target || target.id === job.printer_id) {
      const eventId = crypto.randomUUID()
      const errorMessage = `${input.reason}; no online approved printer route is available`
      await input.client.query(
        `INSERT INTO operations_print_delivery_attempts (
           organization_id, print_job_id, printer_id,
           state, actor_type, idempotency_key, request_fingerprint,
           error_code, error_message
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           'failed', 'system', $4, $5,
           'PRINT_ROUTE_UNAVAILABLE', $6
         )`,
        [
          input.organizationId,
          job.id,
          job.printer_id,
          `print-job:${job.global_id}:route-unavailable:${eventId}`,
          fingerprint({
            state: 'failed',
            jobGlobalId: job.global_id,
            reason: 'route_unavailable',
            eventId,
          }),
          errorMessage,
        ],
      )
      await recordAuditEvent({
        eventType: 'operations.print_job.route_unavailable',
        aggregateType: 'operations.print_job',
        aggregateId: job.global_id,
        eventKey: `operations:print-job:route-unavailable:${eventId}`,
        organizationId: input.organizationId,
        isSystem: true,
        payload: {
          printJobGlobalId: job.global_id,
          sourceOrderGlobalId: job.source_order_global_id,
          sourceShipmentGlobalId: job.source_shipment_global_id,
          trackingNumber: job.tracking_number,
          unavailablePrinterGlobalId: job.printer_global_id,
          reason: input.reason,
        },
      }, input.client)
      failed += 1
      continue
    }

    const eventId = crypto.randomUUID()
    const detail = `${input.reason}; rerouted from ${job.printer_global_id} to ${target.globalId}`
    await input.client.query(
      `INSERT INTO operations_print_delivery_attempts (
         organization_id, print_job_id, printer_id,
         state, actor_type, idempotency_key, request_fingerprint, detail
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'rerouted', 'system', $4, $5, $6
       )`,
      [
        input.organizationId,
        job.id,
        job.printer_id,
        `print-job:${job.global_id}:rerouted:${eventId}`,
        fingerprint({
          state: 'rerouted',
          jobGlobalId: job.global_id,
          fromPrinterGlobalId: job.printer_global_id,
          toPrinterGlobalId: target.globalId,
          eventId,
        }),
        detail,
      ],
    )
    await input.client.query(
      `UPDATE operations_print_jobs
       SET printer_id = $3::uuid,
           routing_reason = $4,
           available_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND status = 'rerouted'`,
      [input.organizationId, job.id, target.id, detail],
    )
    await insertQueuedAttempt({
      client: input.client,
      organizationId: input.organizationId,
      jobId: job.id,
      actorEmail: null,
      actorType: 'system',
      idempotencyKey: `print-job:${job.global_id}:requeued:${eventId}`,
      requestFingerprint: fingerprint({
        state: 'queued',
        jobGlobalId: job.global_id,
        targetPrinterGlobalId: target.globalId,
        eventId,
      }),
      detail,
    })
    await recordAuditEvent({
      eventType: 'operations.print_job.rerouted',
      aggregateType: 'operations.print_job',
      aggregateId: job.global_id,
      eventKey: `operations:print-job:rerouted:${eventId}`,
      organizationId: input.organizationId,
      isSystem: true,
      payload: {
        printJobGlobalId: job.global_id,
        sourceOrderGlobalId: job.source_order_global_id,
        sourceShipmentGlobalId: job.source_shipment_global_id,
        trackingNumber: job.tracking_number,
        fromPrinterGlobalId: job.printer_global_id,
        toPrinterGlobalId: target.globalId,
        reason: input.reason,
      },
    }, input.client)
    rerouted += 1
  }
  return { rerouted, failed }
}

async function scheduleRetry(input: {
  client: PoolClient
  job: LockedPrintJobRow
  idempotencyKey: string
  detail: string
  delaySeconds: number
  preferFallback: boolean
  actorEmail: string | null
  actorType: 'user' | 'system'
}) {
  if (input.job.attempts >= input.job.max_attempts) {
    return { queued: false, target: null as OperationsPrinterProfile | null }
  }
  const profiles = await listOperationsPrinterProfilesInPostgres(
    input.job.organization_id,
    input.client,
  )
  const target = retryTarget(profiles, input.job, input.preferFallback)
  if (!target) return { queued: false, target: null as OperationsPrinterProfile | null }
  const delaySeconds = Math.max(0, Math.min(input.delaySeconds, 300))
  await input.client.query(
    `UPDATE operations_print_jobs
     SET printer_id = $3::uuid,
         routing_reason = $4,
         available_at = clock_timestamp() + ($5 * interval '1 second'),
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND status = 'failed'`,
    [
      input.job.organization_id,
      input.job.id,
      target.id,
      input.detail,
      delaySeconds,
    ],
  )
  await insertQueuedAttempt({
    client: input.client,
    organizationId: input.job.organization_id,
    jobId: input.job.id,
    actorEmail: input.actorEmail,
    actorType: input.actorType,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: fingerprint({
      state: 'queued',
      jobGlobalId: input.job.global_id,
      targetPrinterGlobalId: target.globalId,
      nextAttempt: input.job.attempts + 1,
    }),
    detail: input.detail,
  })
  return { queued: true, target }
}

async function recoverExpiredClaims(
  client: PoolClient,
  agent: OperationsPrintAgentContext,
) {
  const expired = await client.query<LockedPrintJobRow>(
    `${LOCKED_PRINT_JOB_SELECT}
     WHERE job.organization_id = $1::uuid
       AND requested.warehouse_id = $2::uuid
       AND job.status = 'claimed'
       AND job.claim_expires_at <= clock_timestamp()
     ORDER BY job.claim_expires_at, job.id
     FOR UPDATE OF job SKIP LOCKED
     LIMIT 25`,
    [agent.organizationId, agent.warehouseId],
  )
  for (const job of expired.rows) {
    const requestFingerprint = fingerprint({
      state: 'failed',
      reason: 'lease_expired',
      jobGlobalId: job.global_id,
      claimToken: job.current_claim_attempt_id,
    })
    await client.query(
      `INSERT INTO operations_print_delivery_attempts (
         organization_id, print_job_id, printer_id,
         state, actor_type, claim_attempt_id, idempotency_key,
         request_fingerprint, error_code, error_message
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'failed', 'system', $4::uuid, $5,
         $6, 'LEASE_EXPIRED', 'Local print-agent lease expired before acknowledgement'
       )`,
      [
        agent.organizationId,
        job.id,
        job.printer_id,
        job.current_claim_attempt_id,
        `print-job:${job.global_id}:lease-expired:${job.current_claim_attempt_id}`,
        requestFingerprint,
      ],
    )
    await scheduleRetry({
      client,
      job,
      idempotencyKey: `print-job:${job.global_id}:lease-retry:${job.attempts + 1}`,
      detail: job.fallback_printer_id && job.printer_id === job.requested_printer_id
        ? 'Claim lease expired; queued on the approved fallback printer'
        : 'Claim lease expired; queued for another bounded attempt',
      delaySeconds: 0,
      preferFallback: true,
      actorEmail: null,
      actorType: 'system',
    })
  }
}

async function cancelVoidedLabelJobs(
  client: PoolClient,
  agent: OperationsPrintAgentContext,
) {
  const cancelled = await client.query<{
    id: string
    global_id: string
    printer_id: string
  }>(
    `SELECT job.id::text, job.global_id, job.printer_id::text
     FROM operations_print_jobs job
     JOIN operations_print_artifacts artifact
       ON artifact.organization_id = job.organization_id
      AND artifact.id = job.artifact_id
     JOIN operations_labels label
       ON label.organization_id = artifact.organization_id
      AND label.id = artifact.source_label_id
     JOIN operations_printers printer
       ON printer.organization_id = job.organization_id
      AND printer.id = job.printer_id
     WHERE job.organization_id = $1::uuid
       AND printer.warehouse_id = $2::uuid
       AND job.status = 'queued'
       AND label.status <> 'created'
     ORDER BY job.created_at, job.id
     FOR UPDATE OF job SKIP LOCKED
     LIMIT 25`,
    [agent.organizationId, agent.warehouseId],
  )
  for (const job of cancelled.rows) {
    await client.query(
      `INSERT INTO operations_print_delivery_attempts (
         organization_id, print_job_id, printer_id,
         state, actor_type, idempotency_key, request_fingerprint, detail
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'cancelled', 'system', $4, $5,
         'Source carrier label is no longer active'
       )`,
      [
        agent.organizationId,
        job.id,
        job.printer_id,
        `print-job:${job.global_id}:source-label-cancelled`,
        fingerprint({
          state: 'cancelled',
          jobGlobalId: job.global_id,
          reason: 'source_label_inactive',
        }),
      ],
    )
  }
}

async function cancelVoidedRateTestLabelJobs(
  client: PoolClient,
  agent: OperationsPrintAgentContext,
) {
  const cancelled = await client.query<{
    id: string
    global_id: string
    printer_id: string
  }>(
    `SELECT job.id::text, job.global_id, job.printer_id::text
     FROM operations_print_jobs job
     JOIN operations_print_artifacts artifact
       ON artifact.organization_id = job.organization_id
      AND artifact.id = job.artifact_id
     JOIN operations_carrier_rate_test_labels label
       ON label.organization_id = artifact.organization_id
      AND label.id = artifact.source_rate_test_label_id
     JOIN operations_printers printer
       ON printer.organization_id = job.organization_id
      AND printer.id = job.printer_id
     WHERE job.organization_id = $1::uuid
       AND printer.warehouse_id = $2::uuid
       AND job.status = 'queued'
       AND label.status <> 'created'
     ORDER BY job.created_at, job.id
     FOR UPDATE OF job SKIP LOCKED
     LIMIT 25`,
    [agent.organizationId, agent.warehouseId],
  )
  for (const job of cancelled.rows) {
    await client.query(
      `INSERT INTO operations_print_delivery_attempts (
         organization_id, print_job_id, printer_id,
         state, actor_type, idempotency_key, request_fingerprint, detail
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'cancelled', 'system', $4, $5,
         'Source carrier rate-test label is no longer active'
       )`,
      [
        agent.organizationId,
        job.id,
        job.printer_id,
        `print-job:${job.global_id}:source-rate-test-label-cancelled`,
        fingerprint({
          state: 'cancelled',
          jobGlobalId: job.global_id,
          reason: 'source_rate_test_label_inactive',
        }),
      ],
    )
  }
}

async function claimedJobs(
  client: PoolClient,
  agent: OperationsPrintAgentContext,
  claimAttemptIds: string[],
): Promise<OperationsPrintClaimJob[]> {
  if (claimAttemptIds.length === 0) return []
  const result = await client.query<PrintClaimRow>(
    `SELECT
       attempt.id::text AS claim_token,
       attempt.claim_expires_at,
       attempt.attempt_number,
       job.global_id,
       artifact.global_id AS artifact_global_id,
       artifact.document_type,
       artifact.format,
       artifact.media_size,
       artifact.content_sha256,
       artifact.byte_length::text,
       artifact.storage_reference,
       label.label_payload,
       rate_test_label.label_payload AS rate_test_label_payload,
       payload.payload AS artifact_payload,
       printer.global_id AS printer_global_id,
       printer.code AS printer_code,
       printer.name AS printer_name
     FROM operations_print_delivery_attempts attempt
     JOIN operations_print_jobs job
       ON job.organization_id = attempt.organization_id
      AND job.id = attempt.print_job_id
     JOIN operations_print_artifacts artifact
       ON artifact.organization_id = job.organization_id
      AND artifact.id = job.artifact_id
     JOIN operations_printers printer
       ON printer.organization_id = attempt.organization_id
      AND printer.id = attempt.printer_id
     LEFT JOIN operations_labels label
       ON label.organization_id = artifact.organization_id
      AND label.id = artifact.source_label_id
      AND label.status = 'created'
     LEFT JOIN operations_carrier_rate_test_labels rate_test_label
       ON rate_test_label.organization_id = artifact.organization_id
      AND rate_test_label.id = artifact.source_rate_test_label_id
      AND rate_test_label.status = 'created'
     LEFT JOIN operations_print_artifact_payloads payload
       ON payload.organization_id = artifact.organization_id
      AND payload.artifact_id = artifact.id
     WHERE attempt.organization_id = $1::uuid
       AND attempt.id = ANY($2::uuid[])
       AND attempt.state = 'claimed'
       AND attempt.print_agent_id = $3::uuid
     ORDER BY attempt.idempotency_key`,
    [agent.organizationId, claimAttemptIds, agent.id],
  )
  if (result.rows.length !== claimAttemptIds.length) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_CLAIM_INVALID',
      'Claim replay could not resolve every claimed print job',
      409,
    )
  }
  return result.rows.map((row) => {
    const encodedPayload = encodeOperationsPrintClaimPayload({
      format: row.format,
      labelPayload: row.label_payload,
      rateTestLabelPayload: row.rate_test_label_payload,
      artifactPayload: row.artifact_payload,
    })
    if (
      row.document_type === 'shipping_label'
      && encodedPayload.inlinePayload === null
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
        'Shipping-label bytes are unavailable for this print claim',
        500,
      )
    }
    if (encodedPayload.inlinePayload !== null && encodedPayload.encoding) {
      const payloadBytes = encodedPayload.encoding === 'utf8'
        ? Buffer.from(encodedPayload.inlinePayload, 'utf8')
        : Buffer.from(encodedPayload.inlinePayload, 'base64')
      if (
        payloadBytes.byteLength !== Number(row.byte_length)
        || contentHash(payloadBytes) !== row.content_sha256
      ) {
        throw new OperationsRequestError(
          'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
          'Print artifact content failed integrity validation',
          500,
        )
      }
    }
    return {
      globalId: row.global_id,
      claimToken: row.claim_token,
      claimExpiresAt: iso(row.claim_expires_at) as string,
      document: {
        globalId: row.artifact_global_id,
        type: row.document_type,
        format: row.format,
        media: row.media_size,
        contentSha256: row.content_sha256,
        byteLength: Number(row.byte_length),
        storageReference: row.storage_reference,
        ...encodedPayload,
      },
      printer: {
        globalId: row.printer_global_id,
        code: row.printer_code,
        name: row.printer_name,
      },
      attempt: row.attempt_number,
    }
  })
}

export async function claimOperationsPrintJobsInPostgres(input: {
  agent: OperationsPrintAgentContext
  idempotencyKey: string
  limit?: number
  leaseSeconds?: number
  runtimeCapabilities: PrintAgentCapabilities
}): Promise<OperationsPrintClaimJob[]> {
  const limit = Math.max(1, Math.min(Number(input.limit) || 1, 10))
  const leaseSeconds = Math.max(
    30,
    Math.min(Number(input.leaseSeconds) || DEFAULT_LEASE_SECONDS, 300),
  )
  const callerKey = requiredIdempotencyKey(input.idempotencyKey)
  const runtimeCapabilities = requiredPrintAgentCapabilities(input.runtimeCapabilities)
  const requestFingerprint = fingerprint({
    action: 'claim-print-jobs',
    printAgentGlobalId: input.agent.globalId,
    limit,
    leaseSeconds,
    ...runtimeCapabilities,
  })
  const claimKeys = Array.from(
    { length: limit },
    (_value, index) => (
      `print-agent:${input.agent.globalId}:claim:${callerKey}:${String(index + 1).padStart(2, '0')}`
    ),
  )
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:print-claim:${input.agent.organizationId}:${input.agent.id}:${callerKey}`,
    )
    const enrolledCapabilitiesResult = await client.query<{
      supported_formats: OperationsPrintAgentContext['supportedFormats']
      supported_media: OperationsPrintAgentContext['supportedMedia']
      supported_document_types: OperationsPrintAgentContext['supportedDocumentTypes']
    }>(
      `SELECT supported_formats, supported_media, supported_document_types
       FROM operations_print_agents
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND status = 'active'
       FOR SHARE`,
      [input.agent.organizationId, input.agent.id],
    )
    const enrolledCapabilitiesRow = enrolledCapabilitiesResult.rows[0]
    const enrolledCapabilities = enrolledCapabilitiesRow
      ? {
        supportedFormats: enrolledCapabilitiesRow.supported_formats,
        supportedMedia: enrolledCapabilitiesRow.supported_media,
        supportedDocumentTypes: enrolledCapabilitiesRow.supported_document_types,
      }
      : null
    if (
      !enrolledCapabilities
      || !printAgentCapabilitiesAreSubset(runtimeCapabilities, enrolledCapabilities)
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_AGENT_CAPABILITIES_MISMATCH',
        'Runtime capabilities must be a non-empty subset of the enrolled print-agent capabilities',
        409,
      )
    }
    const replay = await client.query<{
      id: string
      idempotency_key: string
      print_agent_id: string | null
      request_fingerprint: string
      state: string
    }>(
      `SELECT id::text, idempotency_key, print_agent_id::text,
         request_fingerprint, state
       FROM operations_print_delivery_attempts
       WHERE organization_id = $1::uuid
         AND idempotency_key = ANY($2::text[])
       ORDER BY idempotency_key
       FOR SHARE`,
      [input.agent.organizationId, claimKeys],
    )
    if (replay.rows.length > 0) {
      if (replay.rows.some((attempt) => (
        attempt.state !== 'claimed'
        || attempt.print_agent_id !== input.agent.id
        || attempt.request_fingerprint !== requestFingerprint
      ))) {
        throw new OperationsRequestError(
          'OPERATIONS_PRINT_IDEMPOTENCY_REUSED',
          'Idempotency-Key was already used for a different claim request',
          409,
        )
      }
      return claimedJobs(
        client,
        input.agent,
        replay.rows.map((attempt) => attempt.id),
      )
    }
    await recoverExpiredClaims(client, input.agent)
    await cancelVoidedLabelJobs(client, input.agent)
    await cancelVoidedRateTestLabelJobs(client, input.agent)
    await rerouteUnavailableQueuedJobs({
      client,
      organizationId: input.agent.organizationId,
      warehouseId: input.agent.warehouseId,
      reason: 'Selected printer is offline or its local print agent is unavailable',
    })
    const candidates = await client.query<{
      id: string
      global_id: string
      source_order_global_id: string | null
      source_shipment_global_id: string | null
      tracking_number: string | null
      artifact_global_id: string
      document_type: DurablePrintDocumentType
      format: PrintFormat
      media_size: PrintMedia
      content_sha256: string
      byte_length: string
      storage_reference: string
      label_payload: string | null
      printer_id: string
      printer_global_id: string
      printer_code: string
      printer_name: string
      attempts: number
    }>(
      `SELECT
         job.id::text,
         job.global_id,
         source_order.global_id AS source_order_global_id,
         source_shipment.global_id AS source_shipment_global_id,
         COALESCE(
           source_shipment.tracking_number,
           label.tracking_number,
           rate_test_label.tracking_number
         )
           AS tracking_number,
         artifact.global_id AS artifact_global_id,
         artifact.document_type,
         artifact.format,
         artifact.media_size,
         artifact.content_sha256,
         artifact.byte_length::text,
         artifact.storage_reference,
         label.label_payload,
         printer.id::text AS printer_id,
         printer.global_id AS printer_global_id,
         printer.code AS printer_code,
         printer.name AS printer_name,
         job.attempts
       FROM operations_print_jobs job
       JOIN operations_print_artifacts artifact
         ON artifact.organization_id = job.organization_id
        AND artifact.id = job.artifact_id
       JOIN operations_printers printer
         ON printer.organization_id = job.organization_id
        AND printer.id = job.printer_id
       LEFT JOIN operations_orders source_order
         ON source_order.organization_id = artifact.organization_id
        AND source_order.id = artifact.source_order_id
       LEFT JOIN operations_shipments source_shipment
         ON source_shipment.organization_id = artifact.organization_id
        AND source_shipment.id = artifact.source_shipment_id
       LEFT JOIN operations_labels label
         ON label.organization_id = artifact.organization_id
        AND label.id = artifact.source_label_id
        AND label.status = 'created'
       LEFT JOIN operations_carrier_rate_test_labels rate_test_label
         ON rate_test_label.organization_id = artifact.organization_id
        AND rate_test_label.id = artifact.source_rate_test_label_id
        AND rate_test_label.status = 'created'
       WHERE job.organization_id = $1::uuid
         AND printer.warehouse_id = $2::uuid
         AND printer.local_print_agent_id = $3::uuid
         AND printer.connection_mode = 'local_agent'
         AND printer.status = 'online'
         AND job.status = 'queued'
         AND job.available_at <= clock_timestamp()
         AND job.attempts <= job.max_attempts
         AND artifact.format = ANY($5::text[])
         AND artifact.media_size = ANY($6::text[])
         AND artifact.document_type = ANY($7::text[])
         AND (
           artifact.source_label_id IS NULL
           OR label.id IS NOT NULL
         )
         AND (
           artifact.source_rate_test_label_id IS NULL
           OR rate_test_label.id IS NOT NULL
         )
       ORDER BY job.available_at, job.created_at, job.id
       FOR UPDATE OF job SKIP LOCKED
       LIMIT $4`,
      [
        input.agent.organizationId,
        input.agent.warehouseId,
        input.agent.id,
        limit,
        runtimeCapabilities.supportedFormats,
        runtimeCapabilities.supportedMedia,
        runtimeCapabilities.supportedDocumentTypes,
      ],
    )
    const claimAttemptIds: string[] = []
    for (const [index, job] of candidates.rows.entries()) {
      const claim = await client.query<{
        id: string
        claim_expires_at: TimestampValue
      }>(
        `INSERT INTO operations_print_delivery_attempts (
           organization_id, print_job_id, printer_id,
           state, actor_type, print_agent_id, claim_expires_at,
           idempotency_key, request_fingerprint
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           'claimed', 'local_print_agent', $4::uuid,
           clock_timestamp() + ($5 * interval '1 second'),
           $6, $7
         )
         RETURNING id::text, claim_expires_at`,
        [
          input.agent.organizationId,
          job.id,
          job.printer_id,
          input.agent.id,
          leaseSeconds,
          claimKeys[index],
          requestFingerprint,
        ],
      )
      claimAttemptIds.push(claim.rows[0].id)
      await recordAuditEvent({
        eventType: 'operations.print_job.claimed',
        aggregateType: 'operations.print_job',
        aggregateId: job.global_id,
        eventKey: `operations:print-job:claimed:${claim.rows[0].id}`,
        subject: input.agent.globalId,
        organizationId: input.agent.organizationId,
        isSystem: true,
        payload: {
          printJobGlobalId: job.global_id,
          printAgentGlobalId: input.agent.globalId,
          printerGlobalId: job.printer_global_id,
          attempt: job.attempts,
          claimExpiresAt: iso(claim.rows[0].claim_expires_at),
          sourceOrderGlobalId: job.source_order_global_id,
          sourceShipmentGlobalId: job.source_shipment_global_id,
          trackingNumber: job.tracking_number,
          runtimeSupportedFormats: runtimeCapabilities.supportedFormats,
          runtimeSupportedMedia: runtimeCapabilities.supportedMedia,
          runtimeSupportedDocumentTypes: runtimeCapabilities.supportedDocumentTypes,
        },
      }, client)
    }
    await client.query(
      `UPDATE operations_print_agents
       SET last_seen_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND status = 'active'`,
      [input.agent.organizationId, input.agent.id],
    )
    if (candidates.rows.length) {
      await client.query(
        `UPDATE operations_printers
         SET last_seen_at = clock_timestamp(), updated_at = updated_at
         WHERE organization_id = $1::uuid
           AND id = ANY($2::uuid[])`,
        [
          input.agent.organizationId,
          [...new Set(candidates.rows.map((job) => job.printer_id))],
        ],
      )
    }
    return claimedJobs(client, input.agent, claimAttemptIds)
  })
}

function assertAgentOwnsClaim(
  job: LockedPrintJobRow,
  agent: OperationsPrintAgentContext,
  claimToken: string,
) {
  if (
    job.status !== 'claimed'
    || job.current_claim_attempt_id !== claimToken
    || job.claimed_by_print_agent_id !== agent.id
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_CLAIM_EXPIRED',
      'Print job claim is no longer current',
      409,
    )
  }
  if (
    !job.claim_expires_at
    || new Date(job.claim_expires_at).getTime() <= Date.now()
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_CLAIM_EXPIRED',
      'Print job claim lease expired',
      409,
    )
  }
}

export async function acknowledgeOperationsPrintJobInPostgres(input: {
  agent: OperationsPrintAgentContext
  jobGlobalId: string
  claimToken: string
  idempotencyKey: string
  deviceJobReference?: string | null
}) {
  if (!UUID.test(input.claimToken)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_CLAIM_INVALID',
      'Print claim token is invalid',
    )
  }
  const callerKey = requiredIdempotencyKey(input.idempotencyKey)
  const idempotencyKey = `print-agent:${input.agent.globalId}:ack:${callerKey}`
  const deviceJobReference = String(input.deviceJobReference || '').trim()
  if (
    deviceJobReference.length > 200
    || /[\u0000-\u001f\u007f]/.test(deviceJobReference)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_DEVICE_REFERENCE_INVALID',
      'Device job reference is invalid',
    )
  }
  const requestFingerprint = fingerprint({
    action: 'acknowledge',
    jobGlobalId: input.jobGlobalId,
    claimToken: input.claimToken,
    deviceJobReference: deviceJobReference || null,
  })
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:print-attempt:${input.agent.organizationId}:${idempotencyKey}`,
    )
    const replay = await attemptReplay({
      client,
      organizationId: input.agent.organizationId,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) {
      return oneJob(input.agent.organizationId, input.jobGlobalId, client)
    }
    const job = await lockedJob(
      client,
      input.agent.organizationId,
      input.jobGlobalId,
    )
    assertAgentOwnsClaim(job, input.agent, input.claimToken)
    await client.query(
      `INSERT INTO operations_print_delivery_attempts (
         organization_id, print_job_id, printer_id,
         state, actor_type, print_agent_id, claim_attempt_id,
         idempotency_key, request_fingerprint,
         device_job_reference, delivery_evidence
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'delivered', 'local_print_agent', $4::uuid, $5::uuid,
         $6, $7, $8, 'local_agent_acknowledgement'
       )`,
      [
        input.agent.organizationId,
        job.id,
        job.printer_id,
        input.agent.id,
        input.claimToken,
        idempotencyKey,
        requestFingerprint,
        deviceJobReference || null,
      ],
    )
    await client.query(
      `UPDATE operations_print_agents
       SET last_seen_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [input.agent.organizationId, input.agent.id],
    )
    await client.query(
      `UPDATE operations_printers
       SET last_seen_at = clock_timestamp(), updated_at = updated_at
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [input.agent.organizationId, job.printer_id],
    )
    await recordAuditEvent({
      eventType: 'operations.print_job.acknowledged',
      aggregateType: 'operations.print_job',
      aggregateId: job.global_id,
      eventKey: `operations:print-job:acknowledged:${input.claimToken}`,
      subject: input.agent.globalId,
      organizationId: input.agent.organizationId,
      isSystem: true,
      payload: {
        printJobGlobalId: job.global_id,
        printAgentGlobalId: input.agent.globalId,
        printerGlobalId: job.printer_global_id,
        attempt: job.attempts,
        evidence: 'local_agent_acknowledgement',
        physicalOutputVerified: false,
        sourceOrderGlobalId: job.source_order_global_id,
        sourceShipmentGlobalId: job.source_shipment_global_id,
        trackingNumber: job.tracking_number,
      },
    }, client)
    return oneJob(input.agent.organizationId, job.global_id, client)
  })
}

export async function failOperationsPrintJobInPostgres(input: {
  agent: OperationsPrintAgentContext
  jobGlobalId: string
  claimToken: string
  idempotencyKey: string
  errorCode: string
  errorMessage: string
  retryable: boolean
  printerUnavailable?: boolean
  retryAfterSeconds?: number
}) {
  if (!UUID.test(input.claimToken)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_CLAIM_INVALID',
      'Print claim token is invalid',
    )
  }
  const callerKey = requiredIdempotencyKey(input.idempotencyKey)
  const errorCode = String(input.errorCode || '').trim().toUpperCase()
  const errorMessage = String(input.errorMessage || '').trim()
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(errorCode)) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ERROR_INVALID',
      'Print failure code is invalid',
    )
  }
  if (
    !errorMessage
    || errorMessage.length > MAX_ERROR_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(errorMessage)
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINT_ERROR_INVALID',
      'Print failure message is invalid',
    )
  }
  const idempotencyKey = `print-agent:${input.agent.globalId}:fail:${callerKey}`
  const requestFingerprint = fingerprint({
    action: 'fail',
    jobGlobalId: input.jobGlobalId,
    claimToken: input.claimToken,
    errorCode,
    errorMessage,
    retryable: input.retryable === true,
    printerUnavailable: input.printerUnavailable === true,
    retryAfterSeconds: Number(input.retryAfterSeconds) || 0,
  })
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:print-attempt:${input.agent.organizationId}:${idempotencyKey}`,
    )
    const replay = await attemptReplay({
      client,
      organizationId: input.agent.organizationId,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) {
      return oneJob(input.agent.organizationId, input.jobGlobalId, client)
    }
    const job = await lockedJob(
      client,
      input.agent.organizationId,
      input.jobGlobalId,
    )
    assertAgentOwnsClaim(job, input.agent, input.claimToken)
    if (input.printerUnavailable === true) {
      await client.query(
        `UPDATE operations_printers
         SET status = 'offline',
             last_seen_at = clock_timestamp(),
             row_version = row_version + 1,
             updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [input.agent.organizationId, job.printer_id],
      )
    }
    await client.query(
      `INSERT INTO operations_print_delivery_attempts (
         organization_id, print_job_id, printer_id,
         state, actor_type, print_agent_id, claim_attempt_id,
         idempotency_key, request_fingerprint, error_code, error_message
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'failed', 'local_print_agent', $4::uuid, $5::uuid,
         $6, $7, $8, $9
       )`,
      [
        input.agent.organizationId,
        job.id,
        job.printer_id,
        input.agent.id,
        input.claimToken,
        idempotencyKey,
        requestFingerprint,
        errorCode,
        errorMessage,
      ],
    )
    const retry = input.retryable === true
      ? await scheduleRetry({
        client,
        job,
        idempotencyKey: `${idempotencyKey}:retry:${job.attempts + 1}`,
        detail: job.fallback_printer_id && job.printer_id === job.requested_printer_id
          ? `Printer failure ${errorCode}; queued on approved fallback`
          : `Printer failure ${errorCode}; queued for bounded retry`,
        delaySeconds: Math.max(
          0,
          Math.min(Number(input.retryAfterSeconds) || 0, 300),
        ),
        preferFallback: true,
        actorEmail: null,
        actorType: 'system',
      })
      : { queued: false, target: null }
    await recordAuditEvent({
      eventType: 'operations.print_job.failed',
      aggregateType: 'operations.print_job',
      aggregateId: job.global_id,
      eventKey: `operations:print-job:failed:${input.claimToken}`,
      subject: input.agent.globalId,
      organizationId: input.agent.organizationId,
      isSystem: true,
      payload: {
        printJobGlobalId: job.global_id,
        printAgentGlobalId: input.agent.globalId,
        printerGlobalId: job.printer_global_id,
        attempt: job.attempts,
        errorCode,
        retryQueued: retry.queued,
        retryPrinterGlobalId: retry.target?.globalId || null,
        sourceOrderGlobalId: job.source_order_global_id,
        sourceShipmentGlobalId: job.source_shipment_global_id,
        trackingNumber: job.tracking_number,
      },
    }, client)
    if (retry.queued) {
      await recordAuditEvent({
        eventType: retry.target?.globalId === job.fallback_printer_global_id
          ? 'operations.print_job.rerouted'
          : 'operations.print_job.retry_queued',
        aggregateType: 'operations.print_job',
        aggregateId: job.global_id,
        eventKey: `operations:print-job:retry:${input.claimToken}`,
        subject: input.agent.globalId,
        organizationId: input.agent.organizationId,
        isSystem: true,
        payload: {
          printJobGlobalId: job.global_id,
          fromPrinterGlobalId: job.printer_global_id,
          toPrinterGlobalId: retry.target?.globalId || null,
          nextAttempt: job.attempts + 1,
        },
      }, client)
    }
    return oneJob(input.agent.organizationId, job.global_id, client)
  })
}

export async function retryOperationsPrintJobInPostgres(input: {
  organizationId: string
  jobGlobalId: string
  actorEmail: string
  idempotencyKey: string
  reason: string
}) {
  const organizationId = requiredOrganizationId(input.organizationId)
  const actorEmail = requiredActor(input.actorEmail)
  const callerKey = requiredIdempotencyKey(input.idempotencyKey)
  const reason = requiredReason(input.reason, 'Retry reason')
  const idempotencyKey = `print-user:retry:${callerKey}`
  const requestFingerprint = fingerprint({
    action: 'retry-print-job',
    jobGlobalId: input.jobGlobalId,
    reason,
  })
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:print-attempt:${organizationId}:${idempotencyKey}`,
    )
    const replay = await attemptReplay({
      client,
      organizationId,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) return oneJob(organizationId, input.jobGlobalId, client)
    const job = await lockedJob(client, organizationId, input.jobGlobalId)
    if (job.status !== 'failed') {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_RETRY_INVALID',
        'Only failed print jobs can be retried',
        409,
      )
    }
    if (job.attempts >= job.max_attempts) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_RETRY_EXHAUSTED',
        'Print job exhausted its bounded retry attempts; resolve the route and queue a new print job',
        409,
      )
    }
    const retry = await scheduleRetry({
      client,
      job,
      idempotencyKey,
      detail: `Operator retry: ${reason}`,
      delaySeconds: 0,
      preferFallback: job.printer_id === job.requested_printer_id,
      actorEmail,
      actorType: 'user',
    })
    if (!retry.queued) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ROUTE_UNAVAILABLE',
        'No online approved printer is available for this retry',
        409,
      )
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: retry.target?.globalId === job.fallback_printer_global_id
        ? 'operations.print_job.rerouted'
        : 'operations.print_job.retry_queued',
      aggregateType: 'operations.print_job',
      aggregateId: job.global_id,
      eventKey: `operations:print-job:operator-retry:${idempotencyKey}`,
      subject: job.global_id,
      organizationId,
      payload: {
        printJobGlobalId: job.global_id,
        reason,
        fromPrinterGlobalId: job.printer_global_id,
        toPrinterGlobalId: retry.target?.globalId || null,
        nextAttempt: job.attempts + 1,
      },
    }, client)
    return oneJob(organizationId, job.global_id, client)
  })
}

export async function cancelOperationsPrintJobInPostgres(input: {
  organizationId: string
  jobGlobalId: string
  actorEmail: string
  idempotencyKey: string
  reason: string
}) {
  const organizationId = requiredOrganizationId(input.organizationId)
  const actorEmail = requiredActor(input.actorEmail)
  const callerKey = requiredIdempotencyKey(input.idempotencyKey)
  const reason = requiredReason(input.reason, 'Cancellation reason')
  const idempotencyKey = `print-user:cancel:${callerKey}`
  const requestFingerprint = fingerprint({
    action: 'cancel-print-job',
    actorEmail,
    jobGlobalId: input.jobGlobalId,
    reason,
  })
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:print-attempt:${organizationId}:${idempotencyKey}`,
    )
    const replay = await attemptReplay({
      client,
      organizationId,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) return oneJob(organizationId, input.jobGlobalId, client)
    const job = await lockedJob(client, organizationId, input.jobGlobalId)
    if (job.status !== 'queued' && job.status !== 'claimed') {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_CANCEL_INVALID',
        'Only queued or claimed print jobs can be cancelled',
        409,
      )
    }
    const cancelled = await client.query<{ id: string }>(
      `INSERT INTO operations_print_delivery_attempts (
         organization_id, print_job_id, printer_id,
         state, actor_type, actor_email, claim_attempt_id,
         idempotency_key, request_fingerprint, detail
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'cancelled', 'user', $4, $5::uuid,
         $6, $7, $8
       )
       RETURNING id::text`,
      [
        organizationId,
        job.id,
        job.printer_id,
        actorEmail,
        job.status === 'claimed' ? job.current_claim_attempt_id : null,
        idempotencyKey,
        requestFingerprint,
        reason,
      ],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.print_job.cancelled',
      aggregateType: 'operations.print_job',
      aggregateId: job.global_id,
      eventKey: `operations:print-job:cancelled:${cancelled.rows[0].id}`,
      subject: job.global_id,
      organizationId,
      payload: {
        printJobGlobalId: job.global_id,
        cancellationAttemptId: cancelled.rows[0].id,
        reason,
        physicalOutputVerified: false,
        sourceOrderGlobalId: job.source_order_global_id,
        sourceShipmentGlobalId: job.source_shipment_global_id,
        trackingNumber: job.tracking_number,
      },
    }, client)
    return oneJob(organizationId, job.global_id, client)
  })
}

export async function reprintOperationsPrintJobInPostgres(input: {
  organizationId: string
  jobGlobalId: string
  actorEmail: string
  idempotencyKey: string
  reason: string
}) {
  const organizationId = requiredOrganizationId(input.organizationId)
  const actorEmail = requiredActor(input.actorEmail)
  const callerKey = requiredIdempotencyKey(input.idempotencyKey)
  const reason = requiredReason(input.reason, 'Reprint reason')
  const idempotencyKey = `print-user:reprint:${callerKey}`
  const requestFingerprint = fingerprint({
    action: 'reprint-print-job',
    jobGlobalId: input.jobGlobalId,
    reason,
  })
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:print-reprint:${organizationId}:${callerKey}`,
    )
    const replay = await client.query<{
      global_id: string
      request_fingerprint: string
    }>(
      `SELECT global_id, request_fingerprint
       FROM operations_print_jobs
       WHERE organization_id = $1::uuid
         AND idempotency_key = $2
       FOR SHARE`,
      [organizationId, idempotencyKey],
    )
    if (replay.rows[0]) {
      if (replay.rows[0].request_fingerprint !== requestFingerprint) {
        throw new OperationsRequestError(
          'OPERATIONS_PRINT_IDEMPOTENCY_REUSED',
          'Idempotency-Key was already used for a different reprint request',
          409,
        )
      }
      return oneJob(organizationId, replay.rows[0].global_id, client)
    }
    const original = await lockedJob(client, organizationId, input.jobGlobalId)
    if (original.status !== 'delivered') {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_REPRINT_INVALID',
        'Only acknowledged durable print jobs can be reprinted',
        409,
      )
    }
    if (original.label_id) {
      const sourceLabel = await client.query<{ status: string }>(
        `SELECT status
         FROM operations_labels
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
         FOR SHARE`,
        [organizationId, original.label_id],
      )
      if (sourceLabel.rows[0]?.status !== 'created') {
        throw new OperationsRequestError(
          'OPERATIONS_PRINT_REPRINT_LABEL_INACTIVE',
          'Inactive or voided carrier labels cannot be reprinted',
          409,
        )
      }
    }
    if (original.rate_test_label_id) {
      const sourceLabel = await client.query<{ status: string }>(
        `SELECT status
         FROM operations_carrier_rate_test_labels
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
         FOR SHARE`,
        [organizationId, original.rate_test_label_id],
      )
      if (sourceLabel.rows[0]?.status !== 'created') {
        throw new OperationsRequestError(
          'OPERATIONS_PRINT_REPRINT_LABEL_INACTIVE',
          'Inactive or voided carrier rate-test labels cannot be reprinted',
          409,
        )
      }
    }
    const profiles = await listOperationsPrinterProfilesInPostgres(organizationId, client)
    const route = selectPrinterRoute(profiles, {
      warehouseId: original.warehouse_id,
      documentType: original.document_type,
      format: original.format,
      media: original.media_size,
      durable: true,
      preferredPrinterGlobalId: original.requested_printer_global_id,
    })
    if (!route) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINT_ROUTE_UNAVAILABLE',
        'No online local-agent printer is available for this reprint',
        409,
      )
    }
    const inserted = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_print_jobs (
         organization_id, label_id, rate_test_label_id,
         artifact_id, printer_id,
         requested_printer_id, fallback_printer_id,
         status, routing_reason, attempts, max_attempts,
         request_fingerprint, enqueued_by, idempotency_key,
         reprint_of_job_id, reprint_reason, reprint_authorized_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         $4::uuid, $5::uuid,
         $6::uuid, $7::uuid,
         'queued', $8, 0, $9,
         $10, $11, $12,
         $13::uuid, $14, $11
       )
       RETURNING id::text, global_id`,
      [
        organizationId,
        original.label_id,
        original.rate_test_label_id,
        original.artifact_id,
        route.printer.id,
        route.requestedPrinter.id,
        route.fallbackPrinter?.id || null,
        `Audited reprint of ${original.global_id}: ${route.reason}`,
        original.max_attempts,
        requestFingerprint,
        actorEmail,
        idempotencyKey,
        original.id,
        reason,
      ],
    )
    const reprint = inserted.rows[0]
    await insertQueuedAttempt({
      client,
      organizationId,
      jobId: reprint.id,
      actorEmail,
      actorType: 'user',
      idempotencyKey: `print-job:${reprint.global_id}:queued:1`,
      requestFingerprint: fingerprint({
        state: 'queued',
        jobGlobalId: reprint.global_id,
        reprintOfJobGlobalId: original.global_id,
        attempt: 1,
      }),
      detail: `Reprint authorized: ${reason}`,
    })
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.print_job.reprinted',
      aggregateType: 'operations.print_job',
      aggregateId: reprint.global_id,
      eventKey: `operations:print-job:reprinted:${reprint.global_id}`,
      subject: original.global_id,
      organizationId,
      payload: {
        printJobGlobalId: reprint.global_id,
        reprintOfJobGlobalId: original.global_id,
        reason,
        requestedPrinterGlobalId: route.requestedPrinter.globalId,
        selectedPrinterGlobalId: route.printer.globalId,
        fallbackPrinterGlobalId: route.fallbackPrinter?.globalId || null,
        sourceOrderGlobalId: original.source_order_global_id,
        sourceShipmentGlobalId: original.source_shipment_global_id,
        trackingNumber: original.tracking_number,
      },
    }, client)
    return oneJob(organizationId, reprint.global_id, client)
  })
}
