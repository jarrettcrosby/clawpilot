import { NextRequest, NextResponse } from 'next/server'
import {
  isHostedRuntime,
  isPostgresStorageEnabled,
} from '@/lib/persistence/config'
import {
  OPERATIONS_PRINT_AGENT_PAIRING_REDEMPTION_SCHEMA_VERSION,
  redeemOperationsPrintAgentPairingGrantInPostgres,
} from '@/lib/persistence/operationPrintDelivery'
import { OperationsRequestError } from '@/lib/persistence/operations'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 2 * 1024
const PAIRING_CODE =
  /^cppair\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const X25519_SPKI_BASE64URL = /^[A-Za-z0-9_-]{59}$/
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function secureTransport(req: NextRequest) {
  const forwardedProtocol = String(
    req.headers.get('x-forwarded-proto') || '',
  ).split(',')[0].trim().toLowerCase()
  const protocol = forwardedProtocol || req.nextUrl.protocol.replace(/:$/, '')
  if (protocol === 'https') return

  const hostname = req.nextUrl.hostname.toLowerCase()
  const localDevelopment = !isHostedRuntime()
    && ['localhost', '127.0.0.1', '::1'].includes(hostname)
  if (!localDevelopment) {
    fail(
      'OPERATIONS_PRINT_AGENT_PAIRING_HTTPS_REQUIRED',
      'Print-agent pairing requires HTTPS',
      426,
    )
  }
}

function installerRequest(req: NextRequest) {
  // The operator browser creates and displays cppair grants, but must never be
  // the client that receives a long-lived cpprint credential. Native/Node
  // installer requests do not send browser Origin or Fetch Metadata headers.
  if (req.headers.get('origin') || req.headers.get('sec-fetch-site')) {
    fail(
      'OPERATIONS_PRINT_AGENT_INSTALLER_REQUIRED',
      'Pairing codes must be redeemed by the local print-agent installer',
      403,
    )
  }
}

function idempotencyKey(req: NextRequest) {
  const key = String(req.headers.get('idempotency-key') || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    fail(
      'OPERATIONS_PRINT_IDEMPOTENCY_REQUIRED',
      'A valid Idempotency-Key is required',
    )
  }
  return key
}

async function body(req: NextRequest) {
  if (
    !String(req.headers.get('content-type') || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    fail(
      'OPERATIONS_PRINT_AGENT_CONTENT_TYPE_INVALID',
      'Print-agent pairing requires JSON',
      415,
    )
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_TOO_LARGE',
      'Print-agent pairing request exceeded the supported size',
      413,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_TOO_LARGE',
      'Print-agent pairing request exceeded the supported size',
      413,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'A valid print-agent pairing request is required',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'Print-agent pairing request is invalid',
    )
  }
  const value = parsed as Record<string, unknown>
  if (
    Object.keys(value).length === 1
    && Object.prototype.hasOwnProperty.call(value, 'pairingCode')
  ) {
    fail(
      'OPERATIONS_PRINT_AGENT_PAIRING_PROTOCOL_REQUIRED',
      'Install the current ClawPilot Print Agent to use recovery-safe pairing',
      426,
    )
  }
  const supportedFields = new Set([
    'schemaVersion',
    'pairingCode',
    'installationId',
    'clientPublicKey',
    'clientKeyFingerprint',
  ])
  if (
    Object.keys(value).length !== supportedFields.size
    || Object.keys(value).some((field) => !supportedFields.has(field))
  ) {
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'Print-agent pairing request includes an unsupported field',
    )
  }
  const pairingCode = String(value.pairingCode || '').trim()
  if (!PAIRING_CODE.test(pairingCode)) {
    fail(
      'OPERATIONS_PRINT_AGENT_PAIRING_CODE_INVALID',
      'Print-agent pairing code is invalid',
      401,
    )
  }
  const schemaVersion = value.schemaVersion
  const installationId = String(value.installationId || '').trim().toLowerCase()
  const clientPublicKey = String(value.clientPublicKey || '').trim()
  const clientKeyFingerprint = String(value.clientKeyFingerprint || '').trim()
  if (
    schemaVersion !== OPERATIONS_PRINT_AGENT_PAIRING_REDEMPTION_SCHEMA_VERSION
    || !UUID.test(installationId)
    || !X25519_SPKI_BASE64URL.test(clientPublicKey)
    || !SHA256_BASE64URL.test(clientKeyFingerprint)
  ) {
    fail(
      'OPERATIONS_PRINT_AGENT_PAIRING_CLIENT_INVALID',
      'Print-agent recovery identity is invalid',
    )
  }
  return {
    pairingCode,
    client: {
      schemaVersion: OPERATIONS_PRINT_AGENT_PAIRING_REDEMPTION_SCHEMA_VERSION,
      installationId,
      clientPublicKey,
      clientKeyFingerprint,
    },
  }
}

function errorResponse(error: unknown) {
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  return json({
    ok: false,
    error: 'Local print-agent pairing failed',
    code: 'OPERATIONS_PRINT_AGENT_PAIRING_FAILED',
  }, 500)
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return json({
        ok: false,
        error: 'Local print agents require Postgres storage',
        code: 'OPERATIONS_POSTGRES_REQUIRED',
      }, 503)
    }
    secureTransport(req)
    installerRequest(req)
    const pairingRequest = await body(req)
    const result = await redeemOperationsPrintAgentPairingGrantInPostgres({
      pairingCode: pairingRequest.pairingCode,
      idempotencyKey: idempotencyKey(req),
      client: pairingRequest.client,
    })
    return json({
      ok: true,
      schemaVersion: OPERATIONS_PRINT_AGENT_PAIRING_REDEMPTION_SCHEMA_VERSION,
      ...result,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
