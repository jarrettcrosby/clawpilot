import { query } from '@/lib/persistence/postgres'

export const QUICKBOOKS_EXPLORER_VIEWS = [
  'accounts', 'products', 'customers', 'vendors', 'invoices', 'receipts', 'transactions', 'attachments',
] as const

export const QUICKBOOKS_EXPLORER_RANGES = ['30d', '90d', 'ytd', '12m', 'all'] as const

export type QuickBooksExplorerView = typeof QUICKBOOKS_EXPLORER_VIEWS[number]
export type QuickBooksExplorerRange = typeof QUICKBOOKS_EXPLORER_RANGES[number]

const TRANSACTION_STATUS_SQL = `CASE
  WHEN entity_type IN ('Invoice', 'Bill') AND open_balance <> 0 AND due_date < current_date THEN 'Overdue'
  WHEN entity_type IN ('Invoice', 'Bill') AND open_balance <> 0 THEN 'Open'
  WHEN entity_type IN ('Invoice', 'Bill') THEN 'Paid'
  ELSE transaction_status
END`

function pagination(pageValue: number, pageSizeValue: number) {
  const page = Math.max(1, Math.floor(Number(pageValue || 1)))
  const pageSize = Math.max(10, Math.min(Math.floor(Number(pageSizeValue || 25)), 100))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function searchPattern(value: string) {
  return `%${String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)}%`
}

export function quickBooksExplorerStartDate(range: QuickBooksExplorerRange) {
  if (range === 'all') return null
  const now = new Date()
  if (range === 'ytd') return `${now.getUTCFullYear()}-01-01`
  const days = range === '30d' ? 30 : range === '90d' ? 90 : 365
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  start.setUTCDate(start.getUTCDate() - days)
  return start.toISOString().slice(0, 10)
}

export async function readQuickBooksExplorerOverviewInPostgres(input: {
  organizationId: string
  range: QuickBooksExplorerRange
}) {
  const startDate = quickBooksExplorerStartDate(input.range)
  const [connection, counts, metrics, trend, transactionTypes, recent, currency] = await Promise.all([
    query<{
      company_name: string; country: string | null; status: string; catalog_sync_enabled: boolean
      last_catalog_synced_at: string | null; last_error_code: string | null
    }>(
      `SELECT company_name, country, status, catalog_sync_enabled,
         last_catalog_synced_at::text, last_error_code
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid LIMIT 1`,
      [input.organizationId],
    ),
    query<{
      accounts: string; products: string; customers: string; vendors: string
      transactions: string; attachments: string
    }>(
      `SELECT
         (SELECT count(*) FROM quickbooks_accounts WHERE organization_id = $1::uuid)::text AS accounts,
         (SELECT count(*) FROM quickbooks_items WHERE organization_id = $1::uuid)::text AS products,
         (SELECT count(*) FROM quickbooks_customers WHERE organization_id = $1::uuid)::text AS customers,
         (SELECT count(*) FROM quickbooks_vendors WHERE organization_id = $1::uuid)::text AS vendors,
         (SELECT count(*) FROM quickbooks_transactions WHERE organization_id = $1::uuid)::text AS transactions,
         (SELECT count(*) FROM quickbooks_attachments WHERE organization_id = $1::uuid)::text AS attachments`,
      [input.organizationId],
    ),
    query<{
      invoiced: string; received_sales: string; expenses: string; open_invoices: string
      overdue_invoices: string; open_invoice_count: string; overdue_invoice_count: string
    }>(
      `SELECT
         COALESCE(sum(total_amount) FILTER (
           WHERE entity_type = 'Invoice' AND ($2::date IS NULL OR transaction_date >= $2::date)
         ), 0)::text AS invoiced,
         COALESCE(sum(total_amount) FILTER (
           WHERE entity_type = 'SalesReceipt' AND ($2::date IS NULL OR transaction_date >= $2::date)
         ), 0)::text AS received_sales,
         COALESCE(sum(total_amount) FILTER (
           WHERE entity_type IN ('Purchase', 'Bill') AND ($2::date IS NULL OR transaction_date >= $2::date)
         ), 0)::text AS expenses,
         COALESCE(sum(open_balance) FILTER (WHERE entity_type = 'Invoice' AND open_balance <> 0), 0)::text AS open_invoices,
         COALESCE(sum(open_balance) FILTER (
           WHERE entity_type = 'Invoice' AND open_balance <> 0 AND due_date < current_date
         ), 0)::text AS overdue_invoices,
         count(*) FILTER (WHERE entity_type = 'Invoice' AND open_balance <> 0)::text AS open_invoice_count,
         count(*) FILTER (
           WHERE entity_type = 'Invoice' AND open_balance <> 0 AND due_date < current_date
         )::text AS overdue_invoice_count
       FROM quickbooks_transactions
       WHERE organization_id = $1::uuid`,
      [input.organizationId, startDate],
    ),
    query<{ month: string; sales: string; expenses: string }>(
      `SELECT to_char(months.month, 'YYYY-MM') AS month,
         COALESCE(sum(transaction.total_amount) FILTER (
           WHERE transaction.entity_type IN ('Invoice', 'SalesReceipt')
         ), 0)::text AS sales,
         COALESCE(sum(transaction.total_amount) FILTER (
           WHERE transaction.entity_type IN ('Purchase', 'Bill')
         ), 0)::text AS expenses
       FROM generate_series(
         date_trunc('month', current_date) - interval '5 months',
         date_trunc('month', current_date),
         interval '1 month'
       ) AS months(month)
       LEFT JOIN quickbooks_transactions transaction
         ON transaction.organization_id = $1::uuid
        AND transaction.transaction_date >= months.month::date
        AND transaction.transaction_date < (months.month + interval '1 month')::date
       GROUP BY months.month ORDER BY months.month`,
      [input.organizationId],
    ),
    query<{ entity_type: string; count: string; total: string }>(
      `SELECT entity_type, count(*)::text AS count, COALESCE(sum(total_amount), 0)::text AS total
       FROM quickbooks_transactions
       WHERE organization_id = $1::uuid
         AND ($2::date IS NULL OR transaction_date >= $2::date)
       GROUP BY entity_type ORDER BY count(*) DESC, entity_type`,
      [input.organizationId, startDate],
    ),
    query<{
      id: string; entity_type: string; document_number: string | null; transaction_date: string | null
      due_date: string | null; party_name: string | null; total_amount: string; open_balance: string
      status: string; currency_code: string | null
    }>(
      `SELECT quickbooks_transaction_id AS id, entity_type, document_number,
         transaction_date::text, due_date::text, party_name, total_amount::text, open_balance::text,
         ${TRANSACTION_STATUS_SQL} AS status, currency_code
       FROM quickbooks_transactions
       WHERE organization_id = $1::uuid
       ORDER BY transaction_date DESC NULLS LAST, synced_at DESC, quickbooks_transaction_id
       LIMIT 8`,
      [input.organizationId],
    ),
    query<{ currency_code: string }>(
      `SELECT currency_code FROM quickbooks_transactions
       WHERE organization_id = $1::uuid AND currency_code IS NOT NULL
       GROUP BY currency_code ORDER BY count(*) DESC, currency_code LIMIT 1`,
      [input.organizationId],
    ),
  ])

  const connectionRow = connection.rows[0]
  const countRow = counts.rows[0]
  const metricRow = metrics.rows[0]
  return {
    connection: connectionRow ? {
      configured: true,
      companyName: connectionRow.company_name,
      country: connectionRow.country,
      status: connectionRow.status,
      syncEnabled: connectionRow.catalog_sync_enabled,
      lastSyncedAt: connectionRow.last_catalog_synced_at,
      lastErrorCode: connectionRow.last_error_code,
    } : { configured: false },
    currencyCode: currency.rows[0]?.currency_code || null,
    counts: {
      accounts: Number(countRow?.accounts || 0),
      products: Number(countRow?.products || 0),
      customers: Number(countRow?.customers || 0),
      vendors: Number(countRow?.vendors || 0),
      transactions: Number(countRow?.transactions || 0),
      attachments: Number(countRow?.attachments || 0),
    },
    metrics: {
      invoiced: Number(metricRow?.invoiced || 0),
      receivedSales: Number(metricRow?.received_sales || 0),
      expenses: Number(metricRow?.expenses || 0),
      openInvoices: Number(metricRow?.open_invoices || 0),
      overdueInvoices: Number(metricRow?.overdue_invoices || 0),
      openInvoiceCount: Number(metricRow?.open_invoice_count || 0),
      overdueInvoiceCount: Number(metricRow?.overdue_invoice_count || 0),
    },
    trend: trend.rows.map((row) => ({
      month: row.month,
      sales: Number(row.sales || 0),
      expenses: Number(row.expenses || 0),
    })),
    transactionTypes: transactionTypes.rows.map((row) => ({
      type: row.entity_type,
      count: Number(row.count || 0),
      total: Number(row.total || 0),
    })),
    recent: recent.rows.map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      documentNumber: row.document_number,
      transactionDate: row.transaction_date,
      dueDate: row.due_date,
      partyName: row.party_name,
      totalAmount: Number(row.total_amount || 0),
      openBalance: Number(row.open_balance || 0),
      status: row.status,
      currencyCode: row.currency_code,
    })),
  }
}

export async function readQuickBooksExplorerListInPostgres(input: {
  organizationId: string
  view: QuickBooksExplorerView
  page: number
  pageSize: number
  search: string
  range: QuickBooksExplorerRange
  status?: string | null
  entityType?: string | null
}) {
  const { page, pageSize, offset } = pagination(input.page, input.pageSize)
  const pattern = searchPattern(input.search)

  if (input.view === 'accounts') {
    const [count, rows] = await Promise.all([
      query<{ total: string }>(
        `SELECT count(*)::text AS total FROM quickbooks_accounts
         WHERE organization_id = $1::uuid
           AND (name ILIKE $2 OR fully_qualified_name ILIKE $2 OR classification ILIKE $2
             OR account_type ILIKE $2 OR account_sub_type ILIKE $2)`,
        [input.organizationId, pattern],
      ),
      query<{
        id: string; name: string; fully_qualified_name: string; classification: string | null
        account_type: string | null; account_sub_type: string | null; currency_code: string | null
        current_balance: string; active: boolean
      }>(
        `SELECT quickbooks_account_id AS id, name, fully_qualified_name, classification,
           account_type, account_sub_type, currency_code, current_balance::text, active
         FROM quickbooks_accounts
         WHERE organization_id = $1::uuid
           AND (name ILIKE $2 OR fully_qualified_name ILIKE $2 OR classification ILIKE $2
             OR account_type ILIKE $2 OR account_sub_type ILIKE $2)
         ORDER BY active DESC, classification NULLS LAST, fully_qualified_name, quickbooks_account_id
         LIMIT $3 OFFSET $4`,
        [input.organizationId, pattern, pageSize, offset],
      ),
    ])
    return {
      page,
      pageSize,
      total: Number(count.rows[0]?.total || 0),
      rows: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        fullyQualifiedName: row.fully_qualified_name,
        classification: row.classification,
        accountType: row.account_type,
        accountSubType: row.account_sub_type,
        currencyCode: row.currency_code,
        currentBalance: Number(row.current_balance || 0),
        active: row.active,
      })),
    }
  }

  if (input.view === 'products') {
    const [count, rows] = await Promise.all([
      query<{ total: string }>(
        `SELECT count(*)::text AS total FROM quickbooks_items
         WHERE organization_id = $1::uuid
           AND (name ILIKE $2 OR fully_qualified_name ILIKE $2 OR sku ILIKE $2 OR item_type ILIKE $2)`,
        [input.organizationId, pattern],
      ),
      query<{
        id: string; name: string; fully_qualified_name: string; item_type: string; sku: string | null
        description: string | null; unit_price: string; purchase_cost: string
        quantity_on_hand: string | null; track_quantity: boolean; active: boolean; taxable: boolean
      }>(
        `SELECT quickbooks_item_id AS id, name, fully_qualified_name, item_type, sku, description,
           unit_price::text, purchase_cost::text, quantity_on_hand::text, track_quantity, active, taxable
         FROM quickbooks_items
         WHERE organization_id = $1::uuid
           AND (name ILIKE $2 OR fully_qualified_name ILIKE $2 OR sku ILIKE $2 OR item_type ILIKE $2)
         ORDER BY active DESC, fully_qualified_name, quickbooks_item_id
         LIMIT $3 OFFSET $4`,
        [input.organizationId, pattern, pageSize, offset],
      ),
    ])
    return {
      page,
      pageSize,
      total: Number(count.rows[0]?.total || 0),
      rows: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        fullyQualifiedName: row.fully_qualified_name,
        itemType: row.item_type,
        sku: row.sku,
        description: row.description,
        unitPrice: Number(row.unit_price || 0),
        purchaseCost: Number(row.purchase_cost || 0),
        quantityOnHand: row.quantity_on_hand === null ? null : Number(row.quantity_on_hand),
        trackQuantity: row.track_quantity,
        active: row.active,
        taxable: row.taxable,
      })),
    }
  }

  if (input.view === 'customers' || input.view === 'vendors') {
    const table = input.view === 'customers' ? 'quickbooks_customers' : 'quickbooks_vendors'
    const idColumn = input.view === 'customers' ? 'quickbooks_customer_id' : 'quickbooks_vendor_id'
    const [count, rows] = await Promise.all([
      query<{ total: string }>(
        `SELECT count(*)::text AS total FROM ${table}
         WHERE organization_id = $1::uuid
           AND (display_name ILIKE $2 OR company_name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)`,
        [input.organizationId, pattern],
      ),
      query<{
        id: string; display_name: string; company_name: string | null; email: string | null
        phone: string | null; currency_code: string | null; balance: string; active: boolean
      }>(
        `SELECT ${idColumn} AS id, display_name, company_name, email, phone,
           currency_code, balance::text, active
         FROM ${table}
         WHERE organization_id = $1::uuid
           AND (display_name ILIKE $2 OR company_name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)
         ORDER BY active DESC, display_name, ${idColumn}
         LIMIT $3 OFFSET $4`,
        [input.organizationId, pattern, pageSize, offset],
      ),
    ])
    return {
      page,
      pageSize,
      total: Number(count.rows[0]?.total || 0),
      rows: rows.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        companyName: row.company_name,
        email: row.email,
        phone: row.phone,
        currencyCode: row.currency_code,
        balance: Number(row.balance || 0),
        active: row.active,
      })),
    }
  }

  if (input.view === 'attachments') {
    const [count, rows] = await Promise.all([
      query<{ total: string }>(
        `SELECT count(*)::text AS total FROM quickbooks_attachments
         WHERE organization_id = $1::uuid AND (file_name ILIKE $2 OR note ILIKE $2
           OR entity_references::text ILIKE $2)`,
        [input.organizationId, pattern],
      ),
      query<{
        id: string; file_name: string | null; content_type: string | null; size_bytes: string | null
        note: string | null; entity_references: Array<{ id?: string; type?: string; name?: string }>
      }>(
        `SELECT quickbooks_attachment_id AS id, file_name, content_type, size_bytes::text,
           note, entity_references
         FROM quickbooks_attachments
         WHERE organization_id = $1::uuid AND (file_name ILIKE $2 OR note ILIKE $2
           OR entity_references::text ILIKE $2)
         ORDER BY synced_at DESC, file_name NULLS LAST, quickbooks_attachment_id
         LIMIT $3 OFFSET $4`,
        [input.organizationId, pattern, pageSize, offset],
      ),
    ])
    return {
      page,
      pageSize,
      total: Number(count.rows[0]?.total || 0),
      rows: rows.rows.map((row) => ({
        id: row.id,
        fileName: row.file_name,
        contentType: row.content_type,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        note: row.note,
        entityReferences: Array.isArray(row.entity_references) ? row.entity_references : [],
      })),
    }
  }

  const allowedEntityTypes = input.view === 'invoices'
    ? ['Invoice']
    : input.view === 'receipts'
      ? ['SalesReceipt', 'Purchase', 'RefundReceipt']
      : input.entityType
        ? [input.entityType]
        : []
  const startDate = quickBooksExplorerStartDate(input.range)
  const status = String(input.status || '').trim()
  const params: unknown[] = [input.organizationId, pattern, startDate, allowedEntityTypes, status]
  const where = `organization_id = $1::uuid
    AND (document_number ILIKE $2 OR party_name ILIKE $2 OR account_name ILIKE $2
      OR memo ILIKE $2 OR entity_type ILIKE $2)
    AND ($3::date IS NULL OR transaction_date >= $3::date)
    AND (cardinality($4::text[]) = 0 OR entity_type = ANY($4::text[]))
    AND ($5 = '' OR lower(${TRANSACTION_STATUS_SQL}) = lower($5))`
  const [count, rows] = await Promise.all([
    query<{ total: string }>(
      `SELECT count(*)::text AS total FROM quickbooks_transactions WHERE ${where}`,
      params,
    ),
    query<{
      id: string; entity_type: string; document_number: string | null; transaction_date: string | null
      due_date: string | null; party_id: string | null; party_name: string | null
      account_id: string | null; account_name: string | null; currency_code: string | null
      total_amount: string; open_balance: string; status: string; email_status: string | null
      payment_method: string | null; memo: string | null
    }>(
      `SELECT quickbooks_transaction_id AS id, entity_type, document_number,
         transaction_date::text, due_date::text, party_id, party_name, account_id, account_name,
         currency_code, total_amount::text, open_balance::text, ${TRANSACTION_STATUS_SQL} AS status,
         email_status, payment_method, memo
       FROM quickbooks_transactions WHERE ${where}
       ORDER BY transaction_date DESC NULLS LAST, synced_at DESC, quickbooks_transaction_id
       LIMIT $6 OFFSET $7`,
      [...params, pageSize, offset],
    ),
  ])
  return {
    page,
    pageSize,
    total: Number(count.rows[0]?.total || 0),
    rows: rows.rows.map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      documentNumber: row.document_number,
      transactionDate: row.transaction_date,
      dueDate: row.due_date,
      partyId: row.party_id,
      partyName: row.party_name,
      accountId: row.account_id,
      accountName: row.account_name,
      currencyCode: row.currency_code,
      totalAmount: Number(row.total_amount || 0),
      openBalance: Number(row.open_balance || 0),
      status: row.status,
      emailStatus: row.email_status,
      paymentMethod: row.payment_method,
      memo: row.memo,
    })),
  }
}
