import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  parseShopifyPackagingImportCsv,
  SHOPIFY_PACKAGING_IMPORT_TEMPLATE,
  ShopifyPackagingImportError,
} from '@/lib/operations/shopifyPackagingImport'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  importShopifyPackagingMaterialsInPostgres,
  PackagingMaterialRequestError,
} from '@/lib/persistence/packagingMaterials'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 160 * 1024
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const FIELDS = new Set(['action', 'accountGlobalId', 'csv'])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new PackagingMaterialRequestError(code, message, status)
}

async function body(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    fail('SHOPIFY_PACKAGING_IMPORT_CONTENT_TYPE_INVALID', 'Shopify package imports require JSON', 415)
  }
  const reader = req.body?.getReader()
  if (!reader) fail('SHOPIFY_PACKAGING_IMPORT_REQUEST_INVALID', 'Shopify package import is invalid')
  let received = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_REQUEST_BYTES) {
      await reader.cancel('request_too_large')
      fail('SHOPIFY_PACKAGING_IMPORT_TOO_LARGE', 'Shopify package import is too large', 413)
    }
    chunks.push(value)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('SHOPIFY_PACKAGING_IMPORT_REQUEST_INVALID', 'Shopify package import must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('SHOPIFY_PACKAGING_IMPORT_REQUEST_INVALID', 'Shopify package import is invalid')
  }
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).some((field) => !FIELDS.has(field))) {
    fail('SHOPIFY_PACKAGING_IMPORT_REQUEST_INVALID', 'Shopify package import contains an unsupported field')
  }
  if (!['preview', 'apply'].includes(String(record.action || ''))) {
    fail('SHOPIFY_PACKAGING_IMPORT_ACTION_INVALID', 'Shopify package import action is invalid')
  }
  if (typeof record.csv !== 'string') {
    fail('SHOPIFY_PACKAGING_IMPORT_REQUEST_INVALID', 'Shopify package CSV is required')
  }
  const accountGlobalId = String(record.accountGlobalId || '')
  if (record.action === 'apply' && !ACCOUNT_GLOBAL_ID.test(accountGlobalId)) {
    fail('SHOPIFY_PACKAGING_IMPORT_ACCOUNT_INVALID', 'Select a Shopify connection')
  }
  return { action: record.action as 'preview' | 'apply', csv: record.csv, accountGlobalId }
}

function idempotencyKey(req: NextRequest) {
  const value = String(req.headers.get('idempotency-key') || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(value)) {
    fail('PACKAGING_MATERIAL_IDEMPOTENCY_KEY_INVALID', 'A valid Idempotency-Key header is required')
  }
  return value
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
  }
  if (error instanceof PackagingMaterialRequestError || error instanceof ShopifyPackagingImportError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  return json({ ok: false, error: 'Shopify package import failed', code: 'SHOPIFY_PACKAGING_IMPORT_FAILED' }, 500)
}

export async function GET(req: NextRequest) {
  try {
    await requireRequestUser(req)
    return new NextResponse(SHOPIFY_PACKAGING_IMPORT_TEMPLATE, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="clawpilot-shopify-packages-template.csv"',
        'Content-Type': 'text/csv; charset=utf-8',
        Vary: 'Cookie',
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      fail('PACKAGING_MATERIAL_POSTGRES_REQUIRED', 'Packaging materials require Postgres storage', 503)
    }
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) {
      return json({ ok: false, error: 'You do not have permission to manage packaging materials', code: 'PACKAGING_MATERIAL_MANAGE_REQUIRED' }, 403)
    }
    const command = await body(req)
    const preview = parseShopifyPackagingImportCsv(command.csv)
    if (command.action === 'preview') {
      return json({ ok: true, preview })
    }
    const result = await importShopifyPackagingMaterialsInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      actorEmail: actor.email,
      accountGlobalId: command.accountGlobalId,
      idempotencyKey: idempotencyKey(req),
      preview,
    })
    return json({ ok: true, result }, result.replayed ? 200 : 201)
  } catch (error) {
    return errorResponse(error)
  }
}
