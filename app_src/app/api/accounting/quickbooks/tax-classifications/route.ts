import { NextRequest, NextResponse } from 'next/server'
import { accountingCapabilities, activeAccountingOrganizationId } from '@/lib/accountingAuthorization'
import {
  parseQuickBooksTaxClassificationPage,
  quickBooksTaxClassificationPath,
  resolveQuickBooksTaxClassificationChain,
  taxClassificationAppliesToItem,
} from '@/lib/integrations/quickBooksTaxClassifications'
import { matonFetch } from '@/lib/maton'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query } from '@/lib/persistence/postgres'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_CATALOG_RECORDS = 5_000
const PARENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/
const ITEM_TYPES = new Set(['Inventory', 'NonInventory', 'Service'])
type ItemType = 'Inventory' | 'NonInventory' | 'Service'

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function requestProviderCatalog(input: {
  ownerEmail: string
  connectionId: string
}) {
  const response = await matonFetch(quickBooksTaxClassificationPath({ allLevels: true }), { method: 'GET' }, {
    ownerEmail: input.ownerEmail,
    app: 'quickbooks',
    boundConnectionId: input.connectionId,
  })
  const declaredBytes = Number(response.headers.get('content-length') || 0)
  if (declaredBytes > MAX_RESPONSE_BYTES) throw new Error('QuickBooks tax classification response exceeded the supported size')
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('QuickBooks tax classification response exceeded the supported size')
  }
  let payload: unknown
  try {
    payload = JSON.parse(raw) as unknown
  } catch {
    throw new Error('QuickBooks tax classification response was invalid')
  }
  if (!response.ok || (payload && typeof payload === 'object' && 'Fault' in payload)) {
    throw new Error('QuickBooks tax classifications are temporarily unavailable')
  }
  const categories = parseQuickBooksTaxClassificationPage(payload)
  if (categories.length > MAX_CATALOG_RECORDS) {
    throw new Error('QuickBooks tax classification catalog exceeded the supported size')
  }
  return categories
}

export async function GET(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return json({ ok: false, error: 'Accounting requires Postgres storage', code: 'ACCOUNTING_POSTGRES_REQUIRED' }, 503)
    }
    const actor = await requireRequestUser(req)
    if (!accountingCapabilities(actor).canView) {
      return json({ ok: false, error: 'Accounting view access is required', code: 'ACCOUNTING_VIEW_REQUIRED' }, 403)
    }
    const params = req.nextUrl.searchParams
    if ([...params.keys()].some((key) => key !== 'itemType' && key !== 'parentId')
      || params.getAll('itemType').length !== 1 || params.getAll('parentId').length > 1) {
      return json({ ok: false, error: 'Invalid tax classification query', code: 'QUICKBOOKS_TAX_CLASSIFICATION_QUERY_INVALID' }, 400)
    }
    const requestedType = params.get('itemType') || ''
    const parentId = params.get('parentId') || null
    if (!ITEM_TYPES.has(requestedType) || (parentId !== null && !PARENT_ID_PATTERN.test(parentId))) {
      return json({ ok: false, error: 'Invalid tax classification query', code: 'QUICKBOOKS_TAX_CLASSIFICATION_QUERY_INVALID' }, 400)
    }
    const itemType = requestedType as ItemType
    const organizationId = activeAccountingOrganizationId(actor)
    const connection = await query<{ credential_owner_email: string; maton_connection_id: string }>(
      `SELECT credential_owner_email, maton_connection_id
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid AND status = 'active'
       LIMIT 1`,
      [organizationId],
    )
    const binding = connection.rows[0]
    if (!binding) {
      return json({ ok: false, error: 'Connect QuickBooks before choosing sales tax categories', code: 'QUICKBOOKS_NOT_CONNECTED' }, 409)
    }
    const provider = { ownerEmail: binding.credential_owner_email, connectionId: binding.maton_connection_id }
    const catalog = await requestProviderCatalog(provider)
    if (parentId) {
      const chain = resolveQuickBooksTaxClassificationChain(catalog, parentId)
      if (!chain || chain.some((category) => category.applicableTo.length
        && !taxClassificationAppliesToItem(category, itemType))) {
        return json({ ok: false, error: 'Selected sales tax category is unavailable', code: 'QUICKBOOKS_TAX_CLASSIFICATION_PARENT_INVALID' }, 400)
      }
      const parent = chain[chain.length - 1]
      const categories = catalog.filter((category) => category.parentId === parent.id
        && category.level === parent.level + 1)
      return json({ ok: true, categories })
    }
    // Return every direct child so the picker can distinguish "no children"
    // from "children exist, but none apply to this item type" before selecting a leaf.
    const categories = catalog.filter((category) => category.level === 1 && !category.parentId
      && (category.applicableTo.length === 0
      || taxClassificationAppliesToItem(category, itemType))
    )
    return json({ ok: true, categories })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    }
    if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
      return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
    }
    return json({ ok: false, error: 'QuickBooks sales tax categories are temporarily unavailable', code: 'QUICKBOOKS_TAX_CLASSIFICATION_UNAVAILABLE' }, 502)
  }
}
