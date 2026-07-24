import { NextRequest, NextResponse } from 'next/server'
import { CarrierBillingImportError } from '@/lib/operations/carrierBillingImport'
import {
  activeOperationsOrganizationId,
  carrierRateNetworkCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CarrierBillingRequestError,
  importCarrierBillingCsvInPostgres,
  MAX_CARRIER_BILLING_CSV_BYTES,
} from '@/lib/persistence/carrierBilling'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_MULTIPART_OVERHEAD_BYTES = 256 * 1024
const MAX_MULTIPART_BYTES =
  MAX_CARRIER_BILLING_CSV_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
const MAX_HEADER_MAPPING_BYTES = 16 * 1024
const ALLOWED_FIELDS = new Set([
  'file',
  'provider',
  'environment',
  'networkGlobalId',
  'defaultCurrency',
  'headerMapping',
])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new CarrierBillingRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError(
      'CARRIER_BILLING_POSTGRES_REQUIRED',
      'Carrier billing imports require Postgres storage',
      503,
    )
  }
}

function multipartContentType(req: NextRequest): string {
  const contentType = String(req.headers.get('content-type') || '')
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !/boundary=/i.test(contentType)) {
    requestError(
      'CARRIER_BILLING_CONTENT_TYPE_INVALID',
      'Carrier billing imports require multipart form data',
      415,
    )
  }
  return contentType
}

async function readMultipartForm(req: NextRequest): Promise<FormData> {
  const contentType = multipartContentType(req)
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (
    Number.isFinite(contentLength)
    && contentLength > MAX_MULTIPART_BYTES
  ) {
    requestError(
      'CARRIER_BILLING_FILE_TOO_LARGE',
      'Carrier billing CSV files must be 10 MB or smaller',
      413,
    )
  }
  if (!req.body) {
    requestError(
      'CARRIER_BILLING_MULTIPART_INVALID',
      'Carrier billing multipart data is required',
    )
  }

  const chunks: Uint8Array[] = []
  let byteLength = 0
  const reader = req.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_MULTIPART_BYTES) {
        await reader.cancel()
        requestError(
          'CARRIER_BILLING_FILE_TOO_LARGE',
          'Carrier billing CSV files must be 10 MB or smaller',
          413,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  try {
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    return await new Response(body, {
      headers: { 'Content-Type': contentType },
    }).formData()
  } catch (error) {
    if (error instanceof CarrierBillingRequestError) throw error
    requestError(
      'CARRIER_BILLING_MULTIPART_INVALID',
      'Carrier billing multipart data is invalid',
    )
  }
}

function assertAllowedFields(form: FormData) {
  for (const key of form.keys()) {
    if (!ALLOWED_FIELDS.has(key)) {
      requestError(
        'CARRIER_BILLING_FORM_INVALID',
        'Carrier billing import includes an unsupported field',
      )
    }
  }
}

function scalarField(
  form: FormData,
  name: string,
  label: string,
  maximum: number,
  required = true,
): string | null {
  const values = form.getAll(name)
  if (values.length > 1 || (values[0] !== undefined && typeof values[0] !== 'string')) {
    requestError(
      'CARRIER_BILLING_FORM_INVALID',
      `${label} must be supplied once`,
    )
  }
  const value = String(values[0] ?? '').trim()
  if (
    (required && !value)
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    requestError(
      'CARRIER_BILLING_FORM_INVALID',
      `${label} is invalid`,
    )
  }
  return value || null
}

type UploadedFile = Blob & {
  name?: string
}

function uploadedFile(form: FormData): UploadedFile {
  const values = form.getAll('file')
  const value = values[0]
  if (
    values.length !== 1
    || !value
    || typeof value === 'string'
    || typeof value.arrayBuffer !== 'function'
    || !Number.isSafeInteger(value.size)
  ) {
    requestError(
      'CARRIER_BILLING_FILE_REQUIRED',
      'Select one carrier billing CSV file',
    )
  }
  if (value.size < 1) {
    requestError(
      'CARRIER_BILLING_FILE_EMPTY',
      'Carrier billing CSV file is empty',
    )
  }
  if (value.size > MAX_CARRIER_BILLING_CSV_BYTES) {
    requestError(
      'CARRIER_BILLING_FILE_TOO_LARGE',
      'Carrier billing CSV files must be 10 MB or smaller',
      413,
    )
  }
  const name = String(value.name || '').trim()
  if (!/\.csv$/i.test(name)) {
    requestError(
      'CARRIER_BILLING_FILE_INVALID',
      'Carrier billing import requires a CSV file',
      415,
    )
  }
  return value
}

function headerMappingField(form: FormData) {
  const raw = scalarField(
    form,
    'headerMapping',
    'Carrier billing header mapping',
    MAX_HEADER_MAPPING_BYTES,
    false,
  )
  if (!raw) return undefined
  if (Buffer.byteLength(raw, 'utf8') > MAX_HEADER_MAPPING_BYTES) {
    requestError(
      'CARRIER_BILLING_HEADER_MAPPING_INVALID',
      'Carrier billing header mapping exceeds the supported size',
    )
  }
  try {
    const mapping = JSON.parse(raw) as unknown
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      requestError(
        'CARRIER_BILLING_HEADER_MAPPING_INVALID',
        'Carrier billing header mapping must be an object',
      )
    }
    return mapping
  } catch (error) {
    if (error instanceof CarrierBillingRequestError) throw error
    requestError(
      'CARRIER_BILLING_HEADER_MAPPING_INVALID',
      'Carrier billing header mapping must be valid JSON',
    )
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({
      ok: false,
      error: 'Select an active organization first',
      code: error.message,
    }, 409)
  }
  if (error instanceof CarrierBillingRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CarrierBillingImportError) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
      ...(error.field ? { field: error.field } : {}),
    }, error.code === 'FILE_TOO_LARGE' ? 413 : 422)
  }
  return json({
    ok: false,
    error: 'Carrier billing import failed',
    code: 'CARRIER_BILLING_IMPORT_FAILED',
  }, 500)
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const organizationId = activeOperationsOrganizationId(actor)
    const capabilities = carrierRateNetworkCapabilities(actor)
    if (!capabilities.canReconcileCarrierBilling) {
      return json({
        ok: false,
        error: 'You do not have permission to reconcile carrier billing',
        code: 'CARRIER_BILLING_RECONCILE_REQUIRED',
      }, 403)
    }

    const form = await readMultipartForm(req)
    assertAllowedFields(form)
    const file = uploadedFile(form)
    const csv = Buffer.from(await file.arrayBuffer())
    if (csv.byteLength > MAX_CARRIER_BILLING_CSV_BYTES) {
      requestError(
        'CARRIER_BILLING_FILE_TOO_LARGE',
        'Carrier billing CSV files must be 10 MB or smaller',
        413,
      )
    }
    const result = await importCarrierBillingCsvInPostgres({
      organizationId,
      actorEmail: actor.email,
      capabilities,
      csv,
      provider: scalarField(form, 'provider', 'Carrier billing provider', 64),
      environment: scalarField(
        form,
        'environment',
        'Carrier billing environment',
        32,
      ),
      networkGlobalId: scalarField(
        form,
        'networkGlobalId',
        'Carrier rate network',
        16,
        false,
      ),
      defaultCurrency: scalarField(
        form,
        'defaultCurrency',
        'Default currency',
        16,
        false,
      ),
      headerMapping: headerMappingField(form),
    })
    return json({ ok: true, result }, result.duplicate ? 200 : 201)
  } catch (error) {
    return errorResponse(error)
  }
}
