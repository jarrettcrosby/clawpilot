import { matonFetch } from '@/lib/maton'
import {
  parseQuickBooksAccounts,
  parseQuickBooksAttachments,
  parseQuickBooksCompanyInfo,
  parseQuickBooksCustomers,
  parseQuickBooksItems,
  parseQuickBooksTransactions,
  parseQuickBooksVendors,
} from '@/lib/integrations/quickBooksCatalog.mjs'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MINOR_VERSION = '75'
const QUERY_PAGE_SIZE = 1000
const TRANSACTION_PAGE_SIZE = 200
const MAX_CATALOG_RECORDS = 20_000
const REQUEST_SPACING_MS = 300
const MAX_REQUEST_ATTEMPTS = 5
const DEFAULT_RETRY_DELAY_MS = 1_500
const MAX_RETRY_DELAY_MS = 30_000
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

let lastRequestStartedAt = 0

const TRANSACTION_ENTITIES = [
  'Invoice',
  'Payment',
  'SalesReceipt',
  'Purchase',
  'Bill',
  'BillPayment',
  'CreditMemo',
  'RefundReceipt',
] as const

type QuickBooksTransactionEntity = typeof TRANSACTION_ENTITIES[number]
type QuickBooksQueryEntity = 'Account' | 'Item' | 'Customer' | 'Vendor' | 'Attachable' | QuickBooksTransactionEntity

export type QuickBooksCompanyInfo = ReturnType<typeof parseQuickBooksCompanyInfo>
export type QuickBooksAccount = ReturnType<typeof parseQuickBooksAccounts>[number]
export type QuickBooksItem = ReturnType<typeof parseQuickBooksItems>[number]
export type QuickBooksCustomer = ReturnType<typeof parseQuickBooksCustomers>[number]
export type QuickBooksVendor = ReturnType<typeof parseQuickBooksVendors>[number]
export type QuickBooksTransaction = ReturnType<typeof parseQuickBooksTransactions>[number]
export type QuickBooksAttachment = ReturnType<typeof parseQuickBooksAttachments>[number]

async function responseJson(response: Response) {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error('QuickBooks response exceeded the supported size')
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('QuickBooks response exceeded the supported size')
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error('QuickBooks returned an invalid response')
  }
  if (!response.ok) {
    const fault = payload.Fault as { Error?: Array<{ Message?: string }> } | undefined
    throw new Error(fault?.Error?.[0]?.Message || `QuickBooks request failed with HTTP ${response.status}`)
  }
  return payload
}

function sleep(durationMs: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function retryAfterMs(value: string | null) {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1_000))
  }
  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return 0
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAt - Date.now()))
}

async function paceRequest() {
  const elapsed = Date.now() - lastRequestStartedAt
  if (elapsed < REQUEST_SPACING_MS) await sleep(REQUEST_SPACING_MS - elapsed)
  lastRequestStartedAt = Date.now()
}

async function request(pathname: string, ownerEmail: string, connectionId: string) {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    await paceRequest()
    const response = await matonFetch(pathname, { method: 'GET' }, {
      ownerEmail,
      app: 'quickbooks',
      boundConnectionId: connectionId,
    })
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_REQUEST_ATTEMPTS - 1) {
      return responseJson(response)
    }
    await response.body?.cancel().catch(() => undefined)
    const exponentialBackoff = Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * (2 ** attempt))
    await sleep(Math.max(exponentialBackoff, retryAfterMs(response.headers.get('retry-after'))))
  }
  throw new Error('QuickBooks request retry budget exhausted')
}

async function queryEntityPage(
  entity: QuickBooksQueryEntity,
  ownerEmail: string,
  connectionId: string,
  startPosition: number,
  pageSize: number,
) {
  const query = encodeURIComponent(
    `SELECT * FROM ${entity} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`,
  )
  return request(
    `/quickbooks/v3/company/:realmId/query?query=${query}&minorversion=${MINOR_VERSION}`,
    ownerEmail,
    connectionId,
  )
}

function sourceRowCount(payload: Record<string, unknown>, entity: QuickBooksQueryEntity) {
  const queryResponse = payload.QueryResponse
  if (!queryResponse || typeof queryResponse !== 'object' || Array.isArray(queryResponse)) return 0
  const rows = (queryResponse as Record<string, unknown>)[entity]
  return Array.isArray(rows) ? rows.length : 0
}

async function queryAllEntities<T>(
  entity: QuickBooksQueryEntity,
  ownerEmail: string,
  connectionId: string,
  parse: (payload: Record<string, unknown>) => T[],
) {
  const records = new Map<string, T>()
  const pageSize = entity === 'Account' || entity === 'Item' || entity === 'Customer' || entity === 'Vendor'
    ? QUERY_PAGE_SIZE
    : TRANSACTION_PAGE_SIZE
  for (let startPosition = 1; startPosition <= MAX_CATALOG_RECORDS; startPosition += pageSize) {
    const payload = await queryEntityPage(entity, ownerEmail, connectionId, startPosition, pageSize)
    for (const record of parse(payload)) {
      const id = String((record as { id?: unknown }).id || '')
      if (id) records.set(id, record)
    }
    if (sourceRowCount(payload, entity) < pageSize) return [...records.values()]
  }
  throw new Error(`QuickBooks ${entity} catalog exceeded ${MAX_CATALOG_RECORDS} records`)
}

export async function readQuickBooksCompanyInfo(ownerEmail: string, connectionId: string) {
  const payload = await request(
    `/quickbooks/v3/company/:realmId/companyinfo/:realmId?minorversion=${MINOR_VERSION}`,
    ownerEmail,
    connectionId,
  )
  return parseQuickBooksCompanyInfo(payload)
}

export async function readQuickBooksCatalog(ownerEmail: string, connectionId: string) {
  const company = await readQuickBooksCompanyInfo(ownerEmail, connectionId)
  const accounts = await queryAllEntities('Account', ownerEmail, connectionId, parseQuickBooksAccounts)
  const items = await queryAllEntities('Item', ownerEmail, connectionId, parseQuickBooksItems)
  const customers = await queryAllEntities('Customer', ownerEmail, connectionId, parseQuickBooksCustomers)
  const vendors = await queryAllEntities('Vendor', ownerEmail, connectionId, parseQuickBooksVendors)
  const transactionGroups: QuickBooksTransaction[][] = []
  for (const entity of TRANSACTION_ENTITIES) {
    transactionGroups.push(await queryAllEntities(
      entity,
      ownerEmail,
      connectionId,
      (payload) => parseQuickBooksTransactions(payload, entity),
    ))
  }
  const attachments = await queryAllEntities(
    'Attachable',
    ownerEmail,
    connectionId,
    parseQuickBooksAttachments,
  )
  return {
    company,
    accounts,
    items,
    customers,
    vendors,
    transactions: transactionGroups.flat(),
    attachments,
  }
}
