import { matonFetch } from '@/lib/maton'
import {
  parseQuickBooksAccounts,
  parseQuickBooksAttachments,
  parseQuickBooksCompanyInfo,
  parseQuickBooksClasses,
  parseQuickBooksCustomers,
  parseQuickBooksDepartments,
  parseQuickBooksFinancialReport,
  parseQuickBooksItems,
  parseQuickBooksTaxCodes,
  parseQuickBooksTransactions,
  parseQuickBooksVendors,
} from '@/lib/integrations/quickBooksCatalog.mjs'
import {
  buildQuickBooksProviderPayload,
  quickBooksProviderEntity,
  type QuickBooksWriteDraftPayload,
  type QuickBooksWriteOperationKind,
} from '@/lib/integrations/quickBooksWritePayloads'

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
type QuickBooksQueryEntity =
  | 'Account' | 'Item' | 'Customer' | 'Vendor' | 'Attachable'
  | 'Class' | 'Department' | 'TaxCode'
  | QuickBooksTransactionEntity

export type QuickBooksCompanyInfo = ReturnType<typeof parseQuickBooksCompanyInfo>
export type QuickBooksAccount = ReturnType<typeof parseQuickBooksAccounts>[number]
export type QuickBooksClass = ReturnType<typeof parseQuickBooksClasses>[number]
export type QuickBooksItem = ReturnType<typeof parseQuickBooksItems>[number]
export type QuickBooksCustomer = ReturnType<typeof parseQuickBooksCustomers>[number]
export type QuickBooksDepartment = ReturnType<typeof parseQuickBooksDepartments>[number]
export type QuickBooksTaxCode = ReturnType<typeof parseQuickBooksTaxCodes>[number]
export type QuickBooksVendor = ReturnType<typeof parseQuickBooksVendors>[number]
export type QuickBooksTransaction = ReturnType<typeof parseQuickBooksTransactions>[number]
export type QuickBooksAttachment = ReturnType<typeof parseQuickBooksAttachments>[number]
export type QuickBooksFinancialReport = ReturnType<typeof parseQuickBooksFinancialReport>

export const QUICKBOOKS_FINANCIAL_REPORT_KEYS = [
  'profit_loss', 'balance_sheet', 'cash_flow', 'ar_aging', 'ap_aging',
] as const

export const QUICKBOOKS_FINANCIAL_REPORT_PERIODS = [
  'mtd', 'qtd', 'ytd', 'six_months', 'as_of_today',
] as const

export type QuickBooksFinancialReportKey = typeof QUICKBOOKS_FINANCIAL_REPORT_KEYS[number]
export type QuickBooksFinancialReportPeriod = typeof QUICKBOOKS_FINANCIAL_REPORT_PERIODS[number]
export type QuickBooksFinancialReportSnapshot = {
  reportKey: QuickBooksFinancialReportKey
  periodKey: QuickBooksFinancialReportPeriod
  status: 'ready' | 'error'
  errorCode: string | null
  report: QuickBooksFinancialReport | null
}

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

async function requestResponse(pathname: string, ownerEmail: string, connectionId: string, init?: RequestInit) {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    await paceRequest()
    const response = await matonFetch(pathname, init || { method: 'GET' }, {
      ownerEmail,
      app: 'quickbooks',
      boundConnectionId: connectionId,
    })
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_REQUEST_ATTEMPTS - 1) {
      return response
    }
    await response.body?.cancel().catch(() => undefined)
    const exponentialBackoff = Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * (2 ** attempt))
    await sleep(Math.max(exponentialBackoff, retryAfterMs(response.headers.get('retry-after'))))
  }
  throw new Error('QuickBooks request retry budget exhausted')
}

export class QuickBooksProviderWriteError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'QuickBooksProviderWriteError'
    this.code = code
  }
}

export async function createQuickBooksEntity(input: {
  ownerEmail: string
  connectionId: string
  operationKind: QuickBooksWriteOperationKind
  payload: QuickBooksWriteDraftPayload
  providerRequestId: string
}) {
  const entity = quickBooksProviderEntity(input.operationKind)
  const providerPayload = buildQuickBooksProviderPayload(input.operationKind, input.payload)
  const body = JSON.stringify(providerPayload)
  if (Buffer.byteLength(body, 'utf8') > 64 * 1024) {
    throw new QuickBooksProviderWriteError('QUICKBOOKS_WRITE_PAYLOAD_TOO_LARGE', 'QuickBooks write payload exceeded the supported size')
  }
  const search = new URLSearchParams({ requestid: input.providerRequestId, minorversion: MINOR_VERSION })
  let response: Response
  try {
    response = await requestResponse(
      `/quickbooks/v3/company/:realmId/${entity.path}?${search.toString()}`,
      input.ownerEmail,
      input.connectionId,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    )
  } catch {
    throw new QuickBooksProviderWriteError('QUICKBOOKS_WRITE_GATEWAY_FAILED', 'QuickBooks write gateway request failed')
  }
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new QuickBooksProviderWriteError('QUICKBOOKS_WRITE_RESPONSE_TOO_LARGE', 'QuickBooks write response exceeded the supported size')
  }
  let responsePayload: Record<string, unknown>
  try {
    responsePayload = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new QuickBooksProviderWriteError('QUICKBOOKS_WRITE_RESPONSE_INVALID', 'QuickBooks returned an invalid write response')
  }
  if (!response.ok) {
    const fault = responsePayload.Fault as { Error?: Array<{ code?: string; Message?: string; Detail?: string }> } | undefined
    const providerError = fault?.Error?.[0]
    throw new QuickBooksProviderWriteError(
      providerError?.code ? `QUICKBOOKS_${providerError.code}` : `QUICKBOOKS_HTTP_${response.status}`,
      providerError?.Message || providerError?.Detail || `QuickBooks write failed with HTTP ${response.status}`,
    )
  }
  const record = responsePayload[entity.responseKey]
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new QuickBooksProviderWriteError('QUICKBOOKS_WRITE_ENTITY_MISSING', 'QuickBooks did not return the created record')
  }
  const providerRecord = record as Record<string, unknown>
  const id = String(providerRecord.Id || '').trim()
  if (!id) throw new QuickBooksProviderWriteError('QUICKBOOKS_WRITE_ID_MISSING', 'QuickBooks did not return a record identifier')
  return {
    entityType: entity.responseKey,
    entityId: id,
    syncToken: providerRecord.SyncToken === undefined ? null : String(providerRecord.SyncToken),
  }
}

async function request(pathname: string, ownerEmail: string, connectionId: string) {
  return responseJson(await requestResponse(pathname, ownerEmail, connectionId))
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
  const pageSize = ['Account', 'Item', 'Customer', 'Vendor', 'Class', 'Department', 'TaxCode'].includes(entity)
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

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10)
}

function financialReportPeriods(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const month = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  const quarter = new Date(Date.UTC(end.getUTCFullYear(), Math.floor(end.getUTCMonth() / 3) * 3, 1))
  const year = new Date(Date.UTC(end.getUTCFullYear(), 0, 1))
  const sixMonths = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1))
  return [
    { periodKey: 'mtd' as const, startDate: isoDate(month), endDate: isoDate(end) },
    { periodKey: 'qtd' as const, startDate: isoDate(quarter), endDate: isoDate(end) },
    { periodKey: 'ytd' as const, startDate: isoDate(year), endDate: isoDate(end) },
    { periodKey: 'six_months' as const, startDate: isoDate(sixMonths), endDate: isoDate(end) },
  ]
}

export async function readQuickBooksFinancialReports(
  ownerEmail: string,
  connectionId: string,
  now = new Date(),
) {
  const periods = financialReportPeriods(now)
  const endDate = isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())))
  const requests: Array<{
    reportKey: QuickBooksFinancialReportKey
    periodKey: QuickBooksFinancialReportPeriod
    endpoint: string
    params: Record<string, string>
  }> = []
  for (const reportKey of ['profit_loss', 'cash_flow'] as const) {
    for (const period of periods) {
      requests.push({
        reportKey,
        periodKey: period.periodKey,
        endpoint: reportKey === 'profit_loss' ? 'ProfitAndLoss' : 'CashFlow',
        params: {
          start_date: period.startDate,
          end_date: period.endDate,
          summarize_column_by: 'Month',
        },
      })
    }
  }
  requests.push(
    { reportKey: 'balance_sheet', periodKey: 'as_of_today', endpoint: 'BalanceSheet', params: { end_date: endDate } },
    { reportKey: 'ar_aging', periodKey: 'as_of_today', endpoint: 'AgedReceivables', params: { report_date: endDate } },
    { reportKey: 'ap_aging', periodKey: 'as_of_today', endpoint: 'AgedPayables', params: { report_date: endDate } },
  )

  const snapshots: QuickBooksFinancialReportSnapshot[] = []
  for (const reportRequest of requests) {
    try {
      const search = new URLSearchParams({ ...reportRequest.params, minorversion: MINOR_VERSION })
      const payload = await request(
        `/quickbooks/v3/company/:realmId/reports/${reportRequest.endpoint}?${search.toString()}`,
        ownerEmail,
        connectionId,
      )
      snapshots.push({
        reportKey: reportRequest.reportKey,
        periodKey: reportRequest.periodKey,
        status: 'ready',
        errorCode: null,
        report: parseQuickBooksFinancialReport(payload),
      })
    } catch {
      snapshots.push({
        reportKey: reportRequest.reportKey,
        periodKey: reportRequest.periodKey,
        status: 'error',
        errorCode: 'QUICKBOOKS_REPORT_FETCH_FAILED',
        report: null,
      })
    }
  }
  return snapshots
}

export async function readQuickBooksAttachmentDownloadUrl(input: {
  ownerEmail: string
  connectionId: string
  attachmentId: string
  thumbnail?: boolean
}) {
  const attachmentId = String(input.attachmentId || '').trim()
  if (!attachmentId || attachmentId.length > 200 || /[^\x20-\x7e]/.test(attachmentId)) {
    throw new Error('QuickBooks attachment id is invalid')
  }

  // Maton can read Attachable metadata even when its download resource returns
  // a gateway error. A targeted query refreshes the short-lived Intuit URLs.
  const escapedAttachmentId = attachmentId.replaceAll("'", "''")
  const query = encodeURIComponent(`SELECT * FROM Attachable WHERE Id = '${escapedAttachmentId}'`)
  try {
    const attachmentPayload = await request(
      `/quickbooks/v3/company/:realmId/query?query=${query}&minorversion=${MINOR_VERSION}`,
      input.ownerEmail,
      input.connectionId,
    )
    const source = parseQuickBooksAttachments(attachmentPayload)
      .find((attachment) => attachment.id === attachmentId)
      ?.sourcePayload as Record<string, unknown> | undefined
    const queriedCandidate = input.thumbnail
      ? source?.ThumbnailTempDownloadUri || source?.TempDownloadUri
      : source?.TempDownloadUri
    if (queriedCandidate) return validatedAttachmentUrl(queriedCandidate)
  } catch {
    // Fall through to Maton's dedicated download resource.
  }

  const endpoint = input.thumbnail ? 'attachable-thumbnail' : 'download'
  const response = await requestResponse(
    `/quickbooks/v3/company/:realmId/${endpoint}/${encodeURIComponent(attachmentId)}`,
    input.ownerEmail,
    input.connectionId,
  )
  const raw = await response.text()
  if (!response.ok) throw new Error(`QuickBooks attachment request failed with HTTP ${response.status}`)
  if (Buffer.byteLength(raw, 'utf8') > 16_384) throw new Error('QuickBooks attachment URL response was invalid')
  let candidate = raw.trim()
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown> | string
    candidate = typeof parsed === 'string'
      ? parsed
      : String(parsed.TempDownloadUrl || parsed.TempDownloadUri || parsed.url || '')
  } catch {}
  return validatedAttachmentUrl(candidate)
}

function validatedAttachmentUrl(value: unknown) {
  const url = new URL(String(value || '').trim())
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('QuickBooks returned an invalid attachment URL')
  }
  return url.toString()
}

export async function readQuickBooksCatalog(ownerEmail: string, connectionId: string) {
  const company = await readQuickBooksCompanyInfo(ownerEmail, connectionId)
  const accounts = await queryAllEntities('Account', ownerEmail, connectionId, parseQuickBooksAccounts)
  const items = await queryAllEntities('Item', ownerEmail, connectionId, parseQuickBooksItems)
  const customers = await queryAllEntities('Customer', ownerEmail, connectionId, parseQuickBooksCustomers)
  const vendors = await queryAllEntities('Vendor', ownerEmail, connectionId, parseQuickBooksVendors)
  const classes = await queryAllEntities('Class', ownerEmail, connectionId, parseQuickBooksClasses)
  const departments = await queryAllEntities('Department', ownerEmail, connectionId, parseQuickBooksDepartments)
  const taxCodes = await queryAllEntities('TaxCode', ownerEmail, connectionId, parseQuickBooksTaxCodes)
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
  const reports = await readQuickBooksFinancialReports(ownerEmail, connectionId)
  return {
    company,
    accounts,
    items,
    customers,
    vendors,
    classes,
    departments,
    taxCodes,
    transactions: transactionGroups.flat(),
    attachments,
    reports,
  }
}
