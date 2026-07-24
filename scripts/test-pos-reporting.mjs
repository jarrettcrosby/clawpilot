#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')
const contractsOnly = process.argv.includes('--contracts-only')

const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_ORGANIZATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RESTAURANT_GUID = '11111111-1111-4111-8111-111111111111'
const OTHER_RESTAURANT_GUID = '22222222-2222-4222-8222-222222222222'

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function loadTypeScriptModule(relativePath, mocks = {}) {
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText
  const module = { exports: {} }
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
    try {
      return requireFromApp(specifier)
    } catch {
      return nodeRequire(specifier)
    }
  }
  vm.runInNewContext(output, {
    Buffer,
    console,
    Error,
    exports: module.exports,
    module,
    process,
    require: localRequire,
  }, { filename: relativePath })
  return module.exports
}

function money(value) {
  return Math.round(value * 100) / 100
}

function acceptanceRows() {
  return Array.from({ length: 26 }, (_, index) => {
    const final = index === 25
    const net = final ? 51.74 : 20
    const tax = final ? 3.08 : 1.5
    const tip = final ? 2.92 : 2.5
    const tender = final ? 54.82 : 21.5
    const total = final ? 57.74 : 24
    const itemQuantity = final ? 12 : 3
    const processingFee = final ? 3.21 : 1
    return {
      business_date: '2026-07-18',
      restaurant_guid: RESTAURANT_GUID,
      guest_count: 1,
      check_count: 1,
      item_count: itemQuantity,
      gross_sales: net,
      net_sales: net,
      discounts: 0,
      tax,
      service_charges: 0,
      tips: tip,
      refunds: 0,
      tendered: tender,
      total,
      cash_tender: 0,
      card_tender: tender,
      other_tender: 0,
      voided: false,
      details: {
        checks: [{
          guid: `raw-check-${index}`,
          displayNumber: `secret-receipt-${index}`,
          paymentStatus: 'PAID',
          amount: net,
          tax,
          serviceCharges: 0,
          total,
          server: { name: 'Private Server Identity' },
          selections: [{
            itemGuid: index < 13 ? 'menu-item-burger' : 'menu-item-salad',
            itemId: `unstable-item-${index}`,
            itemGroupId: 'menu-group-lunch',
            itemGroupName: 'Lunch',
            salesCategoryId: 'sales-category-entrees',
            salesCategoryName: 'Entrees',
            plu: index < 13 ? '1001' : '1002',
            name: index < 13 ? 'Burger' : 'Salad',
            quantity: itemQuantity,
            gross: net,
            net,
            discounts: [{ amount: 0, approver: 'Private Approver Identity' }],
            taxes: [{ amount: tax, customer: 'Private Customer Identity' }],
            voided: false,
            rawSelectionGuid: `raw-selection-${index}`,
          }],
          payments: [{
            guid: `raw-payment-${index}`,
            type: 'CREDIT',
            cardBrand: index < 13 ? 'VISA' : 'MASTERCARD',
            status: 'CAPTURED',
            amount: tender,
            tip,
            processingFee,
            originalProcessingFee: 999,
            first6: '411111',
            last4: '4242',
            customer: 'Private Customer Identity',
            approver: 'Private Approver Identity',
          }],
        }],
      },
    }
  })
}

function refundAndExclusionRows() {
  return [{
    business_date: '2026-07-18',
    restaurant_guid: RESTAURANT_GUID,
    guest_count: 1,
    check_count: 1,
    item_count: 1,
    gross_sales: 100,
    net_sales: 75,
    discounts: 0,
    tax: 0,
    service_charges: 0,
    tips: 15,
    refunds: 30,
    tendered: 75,
    total: 90,
    cash_tender: 0,
    card_tender: 75,
    other_tender: 0,
    voided: false,
    details: {
      checks: [{
        paymentStatus: 'PAID',
        amount: 100,
        tax: 0,
        serviceCharges: 0,
        total: 120,
        voided: false,
        deleted: false,
        selections: [{
          itemGuid: 'active-refund-item',
          name: 'Active refund item',
          quantity: 1,
          gross: 100,
          net: 100,
          voided: false,
        }],
        payments: [{
          type: 'CREDIT',
          cardBrand: 'AMEX',
          status: 'CAPTURED',
          amount: 100,
          tip: 20,
          refundAmount: 25,
          tipRefundAmount: 5,
          processingFee: 3,
          refunded: true,
        }],
      }, {
        paymentStatus: 'VOIDED',
        amount: 500,
        tax: 40,
        serviceCharges: 10,
        total: 550,
        voided: true,
        deleted: false,
        selections: [{
          itemGuid: 'voided-check-item',
          name: 'Voided check item',
          quantity: 5,
          gross: 500,
          net: 500,
          voided: false,
        }],
        payments: [{
          type: 'CREDIT',
          cardBrand: 'VOIDED_CHECK_BRAND',
          status: 'VOIDED',
          amount: 500,
          tip: 0,
          refundAmount: 0,
          tipRefundAmount: 0,
          processingFee: 10,
        }],
      }, {
        paymentStatus: 'PAID',
        amount: 600,
        tax: 0,
        serviceCharges: 0,
        total: 600,
        voided: false,
        deleted: true,
        selections: [{
          itemGuid: 'deleted-check-item',
          name: 'Deleted check item',
          quantity: 6,
          gross: 600,
          net: 600,
          voided: false,
        }],
        payments: [{
          type: 'CREDIT',
          cardBrand: 'DELETED_CHECK_BRAND',
          status: 'CAPTURED',
          amount: 600,
          tip: 0,
          refundAmount: 0,
          tipRefundAmount: 0,
          processingFee: 12,
        }],
      }],
    },
  }, {
    business_date: '2026-07-18',
    restaurant_guid: RESTAURANT_GUID,
    guest_count: 99,
    check_count: 1,
    item_count: 9,
    gross_sales: 900,
    net_sales: 900,
    discounts: 0,
    tax: 0,
    service_charges: 0,
    tips: 90,
    refunds: 0,
    tendered: 900,
    total: 990,
    cash_tender: 0,
    card_tender: 900,
    other_tender: 0,
    voided: true,
    details: {
      checks: [{
        paymentStatus: 'VOIDED',
        amount: 900,
        tax: 0,
        serviceCharges: 0,
        total: 990,
        voided: false,
        deleted: false,
        selections: [{
          itemGuid: 'voided-order-item',
          name: 'Voided order item',
          quantity: 9,
          gross: 900,
          net: 900,
          voided: false,
        }],
        payments: [{
          type: 'CREDIT',
          cardBrand: 'VOIDED_ORDER_BRAND',
          status: 'VOIDED',
          amount: 900,
          tip: 90,
          refundAmount: 0,
          tipRefundAmount: 0,
          processingFee: 18,
        }],
      }],
    },
  }]
}

function comparisonRow(comparisonKey, netSales) {
  return {
    comparison_key: comparisonKey,
    business_days: '1',
    location_count: '1',
    order_count: '1',
    voided_order_count: '0',
    guest_count: '1',
    check_count: '1',
    item_count: '1',
    gross_sales: String(netSales),
    net_sales: String(netSales),
    discounts: '0',
    voided_sales: '0',
    refunds: '0',
    tax: '0',
    service_charges: '0',
    tips: '0',
    tendered: String(netSales),
    total: String(netSales),
    cash_tender: '0',
    card_tender: String(netSales),
    other_tender: '0',
  }
}

function locationRows() {
  return [{
    restaurant_guid: RESTAURANT_GUID,
    restaurant_name: 'Acceptance Restaurant',
    location_name: 'Acceptance Location',
    timezone: 'America/New_York',
    active: true,
    archived: false,
  }]
}

function assertAcceptanceReport(report) {
  assert.equal(report.receiptTotals.orderCount, 26)
  assert.equal(report.receiptTotals.itemQuantity, 87)
  assert.equal(report.receiptTotals.netSales, 551.74)
  assert.equal(report.receiptTotals.tax, 40.58)
  assert.equal(report.receiptTotals.tips, 65.42)
  assert.equal(report.receiptTotals.tendered, 592.32)
  assert.equal(report.receiptTotals.total, 657.74)
  assert.equal(report.tenderTotals.processingFees.available, true)
  assert.equal(report.tenderTotals.processingFees.value, 28.21)
  assert.equal(report.tenderTotals.processingFees.complete, true)
  assert.equal(report.tenderTotals.calculatedCardSettlement.available, true)
  assert.equal(report.tenderTotals.calculatedCardSettlement.value, 629.53)
  assert.equal(money(report.tenderTotals.byCardType.reduce((sum, row) => sum + row.amount, 0)), 592.32)
  assert.equal(money(report.tenderTotals.byCardType.reduce((sum, row) => sum + row.processingFees, 0)), 28.21)
  assert.equal(report.tenderTotals.byCardType.map((row) => row.cardType).sort().join(','), 'MASTERCARD,VISA')
  assert.equal(report.tenderTotals.byStatus[0].status, 'CAPTURED')
  assert.equal(report.tenderTotals.byStatus[0].paymentCount, 26)
  assert.equal(report.productPerformance.length, 2)
  assert.ok(report.productPerformance.every((row) => row.identitySource === 'itemGuid'))
  assert.equal(report.categoryTotals.length, 1)
  assert.equal(report.categoryTotals[0].categoryId, 'sales-category-entrees')
  assert.equal(report.categoryTotals[0].identitySource, 'salesCategoryId')
  assert.equal(report.dailySummaries.length, 1)
  assert.equal(report.checkSummaries.totals.checkCount, 26)
  assert.equal(report.comparisons.priorPeriod.available, true)
  assert.equal(report.comparisons.priorYear.available, true)
  assert.equal(report.tenderTotals.payoutEvidence.available, false)
  assert.equal(report.tenderTotals.actualPayout.available, false)
  assert.equal(report.tenderTotals.bankDeposits.available, false)
  assert.equal(report.unavailableMetrics.weather.available, false)
  assert.equal(report.unavailableMetrics.cogs.available, false)
  assert.equal(report.unavailableMetrics.grossMargin.available, false)

  const serialized = JSON.stringify(report).toLowerCase()
  for (const forbidden of [
    'raw-check-',
    'secret-receipt-',
    'raw-payment-',
    'raw-selection-',
    '411111',
    '4242',
    'private customer identity',
    'private server identity',
    'private approver identity',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `aggregate report exposed ${forbidden}`)
  }
}

async function runSourceAndUnitContracts() {
  const persistenceSource = read('app_src/lib/persistence/posReporting.ts')
  for (const fragment of [
    'readPosOperationalReportFromPostgres',
    'aggregatePosOperationalReport',
    'organization_id = $1::uuid',
    "source_kind = 'analytics_payout'",
    'payment.processingFee',
    'nestedText(payment.cardBrand',
    'cardPaymentAmount + cardTips - cardRefundAmount - cardTipRefundAmount - cardProcessingFees',
    'FILTER (WHERE orders.voided = false)',
    'Gross margin cannot be calculated without cost of goods sold.',
  ]) {
    assert.ok(persistenceSource.includes(fragment), `POS reporting persistence missing ${fragment}`)
  }
  assert.ok(!persistenceSource.includes('toast_source_snapshots.payload'))

  const reportsPanelSource = read('app_src/components/pos/PosReportsPanel.tsx')
  for (const fragment of [
    'DailySalesRows',
    'ProductTable',
    'POS report views',
    'Calculated card settlement',
    'Weather and event adjustments are not included',
    "display: { xs: 'none', md: 'block' }",
    "display: { xs: 'block', md: 'none' }",
  ]) {
    assert.ok(reportsPanelSource.includes(fragment), `POS reports panel missing ${fragment}`)
  }

  const routeSource = read('app_src/app/api/pos/reports/route.ts')
  for (const fragment of [
    'requireRequestUser',
    'accountingCapabilities(actor)',
    'activeAccountingOrganizationId(actor)',
    "searchParams.get('restaurantGuid')",
    "searchParams.get('location')",
    'POS_DATE_RANGE_INVALID',
    'POS_LOCATION_CONFLICT',
    "'Cache-Control': 'no-store'",
  ]) {
    assert.ok(routeSource.includes(fragment), `POS reporting route missing ${fragment}`)
  }

  const queryCalls = []
  const persistenceModule = loadTypeScriptModule('app_src/lib/persistence/posReporting.ts', {
    '@/lib/persistence/postgres': {
      query: async (sql, params) => {
        queryCalls.push({ sql, params })
        if (sql.includes('FROM toast_locations')) return { rows: locationRows(), rowCount: 1 }
        if (sql.includes('WITH comparison_ranges')) {
          return { rows: [comparisonRow('priorPeriod', 100), comparisonRow('priorYear', 80)], rowCount: 2 }
        }
        if (sql.includes('FROM toast_source_snapshots')) return { rows: [{ record_count: '0' }], rowCount: 1 }
        return { rows: acceptanceRows(), rowCount: 26 }
      },
    },
  })

  const ranges = persistenceModule.buildPosReportRanges('2026-07-18', '2026-07-18')
  assert.equal(ranges.priorPeriod.from, '2026-07-17')
  assert.equal(ranges.priorPeriod.to, '2026-07-17')
  assert.equal(ranges.priorYear.from, '2025-07-18')
  assert.throws(() => persistenceModule.buildPosReportRanges('2026-02-30', '2026-03-01'), /POS_DATE_INVALID/)
  assert.throws(() => persistenceModule.buildPosReportRanges('2026-07-19', '2026-07-18'), /POS_DATE_RANGE_INVALID/)
  assert.throws(() => persistenceModule.buildPosReportRanges('2025-01-01', '2026-01-03'), /POS_DATE_RANGE_INVALID/)

  const regressionReport = persistenceModule.aggregatePosOperationalReport({
    organizationId: ORGANIZATION_ID,
    from: '2026-07-18',
    to: '2026-07-18',
    restaurantGuid: RESTAURANT_GUID,
    orders: refundAndExclusionRows(),
  })
  assert.equal(regressionReport.receiptTotals.orderCount, 1)
  assert.equal(regressionReport.receiptTotals.voidedOrderCount, 1)
  assert.equal(regressionReport.receiptTotals.netSales, 75)
  assert.equal(regressionReport.receiptTotals.voidedSales, 900)
  assert.equal(regressionReport.receiptTotals.tips, 15)
  assert.equal(regressionReport.receiptTotals.refunds, 30)
  assert.equal(regressionReport.receiptTotals.tendered, 75)
  assert.equal(regressionReport.receiptTotals.cardTender, 75)
  assert.equal(regressionReport.checkSummaries.totals.checkCount, 1)
  assert.equal(regressionReport.coverage.detailedPayments, 1)
  assert.equal(regressionReport.tenderTotals.processingFees.value, 3)
  assert.equal(regressionReport.tenderTotals.byCardType.length, 1)
  assert.equal(regressionReport.tenderTotals.byCardType[0].cardType, 'AMEX')
  assert.equal(regressionReport.tenderTotals.byCardType[0].amount, 100)
  assert.equal(regressionReport.tenderTotals.byCardType[0].tips, 20)
  assert.equal(regressionReport.tenderTotals.byCardType[0].refundAmount, 25)
  assert.equal(regressionReport.tenderTotals.byCardType[0].tipRefundAmount, 5)
  assert.equal(regressionReport.tenderTotals.byCardType[0].calculatedNetSettlement, 87)
  assert.equal(regressionReport.tenderTotals.calculatedCardSettlement.value, 87)
  assert.equal(regressionReport.tenderTotals.calculatedCardSettlement.refunds, 25)
  assert.equal(regressionReport.tenderTotals.calculatedCardSettlement.tipRefunds, 5)
  assert.equal(regressionReport.productPerformance.some((row) => row.productId === 'deleted-check-item'), false)
  const regressionSerialized = JSON.stringify(regressionReport)
  assert.equal(regressionSerialized.includes('VOIDED_CHECK_BRAND'), false)
  assert.equal(regressionSerialized.includes('DELETED_CHECK_BRAND'), false)
  assert.equal(regressionSerialized.includes('VOIDED_ORDER_BRAND'), false)

  const report = await persistenceModule.readPosOperationalReportFromPostgres({
    organizationId: ORGANIZATION_ID,
    from: '2026-07-18',
    to: '2026-07-18',
    restaurantGuid: RESTAURANT_GUID,
  })
  assertAcceptanceReport(report)
  assert.equal(queryCalls.length, 4)
  for (const call of queryCalls) {
    assert.ok(call.sql.includes('organization_id = $1::uuid'), 'reader query is missing tenant predicate')
    assert.equal(call.params[0], ORGANIZATION_ID)
  }
  assert.ok(queryCalls.some((call) => call.sql.includes('AND deleted = false')))
  assert.ok(queryCalls.some((call) => call.sql.includes('FILTER (WHERE orders.voided = false)')))
  assert.equal(queryCalls[0].params[1], RESTAURANT_GUID)

  let postgresEnabled = true
  let canView = true
  let requestError = null
  const readerCalls = []
  const actor = { organizationId: ORGANIZATION_ID }
  const routeModule = loadTypeScriptModule('app_src/app/api/pos/reports/route.ts', {
    'next/server': {
      NextResponse: {
        json: (payload, init = {}) => ({ payload, status: init.status || 200, headers: init.headers || {} }),
      },
    },
    '@/lib/accountingAuthorization': {
      accountingCapabilities: () => ({ canView, canManage: false, canPrepare: false, canApprove: false }),
      activeAccountingOrganizationId: (value) => {
        if (!value.organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
        return value.organizationId
      },
    },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => postgresEnabled },
    '@/lib/persistence/posReporting': {
      buildPosReportRanges: persistenceModule.buildPosReportRanges,
      readPosOperationalReportFromPostgres: async (input) => {
        readerCalls.push(input)
        return { range: { from: input.from, to: input.to } }
      },
    },
    '@/lib/requestUser': {
      requireRequestUser: async () => {
        if (requestError) throw requestError
        return actor
      },
    },
  })

  const request = (query = '') => ({ nextUrl: new URL(`http://clawpilot.test/api/pos/reports${query}`) })
  const success = await routeModule.GET(request(`?from=2026-07-18&to=2026-07-18&restaurantGuid=${RESTAURANT_GUID}`))
  assert.equal(success.status, 200)
  assert.equal(success.headers['Cache-Control'], 'no-store')
  assert.equal(readerCalls[0].organizationId, ORGANIZATION_ID)
  assert.equal(readerCalls[0].restaurantGuid, RESTAURANT_GUID)

  const alias = await routeModule.GET(request(`?from=2026-07-18&to=2026-07-18&location=${RESTAURANT_GUID}`))
  assert.equal(alias.status, 200)
  assert.equal(readerCalls[1].restaurantGuid, RESTAURANT_GUID)
  assert.equal((await routeModule.GET(request(`?restaurantGuid=${RESTAURANT_GUID}&location=${OTHER_RESTAURANT_GUID}`))).status, 400)
  assert.equal((await routeModule.GET(request('?from=2026-02-30&to=2026-03-01'))).status, 400)
  assert.equal((await routeModule.GET(request('?from=2025-01-01&to=2026-01-03'))).status, 400)

  canView = false
  assert.equal((await routeModule.GET(request())).status, 403)
  canView = true
  postgresEnabled = false
  assert.equal((await routeModule.GET(request())).status, 503)
  postgresEnabled = true
  requestError = new Error('Unauthorized')
  assert.equal((await routeModule.GET(request())).status, 401)

  console.log('POS reporting source, aggregation, route, and tenant-query contracts passed')
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${commandName} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(pool) {
  const deadline = Date.now() + 45_000
  let lastError
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
  }
  throw lastError || new Error('PostgreSQL did not become ready')
}

function payloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function insertOrder(pool, input) {
  await pool.query(
    `INSERT INTO toast_pos_orders (
       organization_id, restaurant_guid, order_guid, business_date, fulfillment_business_date,
       guest_count, check_count, item_count, gross_sales, net_sales, discounts,
       tax, service_charges, tips, refunds, tendered, total,
       cash_tender, card_tender, other_tender, voided, deleted, details, payload_hash
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4::date, $4::date,
       $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16,
       $17, $18, $19, $20, $21, $22::jsonb, $23
     )`,
    [
      input.organizationId,
      input.restaurantGuid,
      input.orderGuid,
      input.row.business_date,
      input.row.guest_count,
      input.row.check_count,
      input.row.item_count,
      input.row.gross_sales,
      input.row.net_sales,
      input.row.discounts,
      input.row.tax,
      input.row.service_charges,
      input.row.tips,
      input.row.refunds,
      input.row.tendered,
      input.row.total,
      input.row.cash_tender,
      input.row.card_tender,
      input.row.other_tender,
      input.voided ?? input.row.voided === true,
      input.deleted ?? input.row.deleted === true,
      JSON.stringify(input.row.details),
      payloadHash(input.row.details),
    ],
  )
}

function baselineRow(businessDate, amount) {
  return {
    ...acceptanceRows()[0],
    business_date: businessDate,
    item_count: 1,
    gross_sales: amount,
    net_sales: amount,
    tax: 0,
    tips: 0,
    tendered: amount,
    total: amount,
    card_tender: amount,
    details: { checks: [] },
  }
}

async function seedDisposableDatabase(pool) {
  await pool.query(
    `INSERT INTO workspace_organizations (id, name, organization_type)
     VALUES ($1::uuid, 'POS Reporting Tenant', 'root'), ($2::uuid, 'Other POS Tenant', 'root')`,
    [ORGANIZATION_ID, OTHER_ORGANIZATION_ID],
  )
  await pool.query(
    `INSERT INTO toast_locations (
       organization_id, restaurant_guid, restaurant_name, location_name, timezone,
       active, archived, standard_access, analytics_access, selected
     ) VALUES
       ($1::uuid, $2::uuid, 'Acceptance Restaurant', 'Acceptance Location', 'America/New_York', true, false, true, true, true),
       ($3::uuid, $4::uuid, 'Private Other Restaurant', 'Private Other Location', 'America/Chicago', true, false, true, true, true)`,
    [ORGANIZATION_ID, RESTAURANT_GUID, OTHER_ORGANIZATION_ID, OTHER_RESTAURANT_GUID],
  )
  await pool.query(
    `INSERT INTO organization_toast_credentials (
       organization_id, access_type, api_base_url, client_id,
       client_secret_ciphertext, client_secret_iv, client_secret_tag,
       client_secret_last_four, sync_enabled, verified_at
     ) VALUES (
       $1::uuid, 'standard', 'https://ws-api.toasttab.com', 'acceptance-standard-client',
       decode('01', 'hex'), decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
       'test', true, now()
     )`,
    [ORGANIZATION_ID],
  )
  await pool.query(
    `INSERT INTO toast_sync_outbox (
       organization_id, restaurant_guid, sync_kind, business_date, status,
       attempt_count, completed_at, postprocess_token, postprocess_started_at
     ) VALUES
       ($1::uuid, $2::uuid, 'standard_orders', '2026-07-16', 'succeeded', 1, now(), NULL, NULL),
       ($1::uuid, $2::uuid, 'standard_orders', '2026-07-18', 'succeeded', 1, now(),
        gen_random_uuid(), now() - interval '20 minutes')`,
    [ORGANIZATION_ID, RESTAURANT_GUID],
  )

  const rows = acceptanceRows()
  for (const [index, row] of rows.entries()) {
    await insertOrder(pool, {
      organizationId: ORGANIZATION_ID,
      restaurantGuid: RESTAURANT_GUID,
      orderGuid: `acceptance-order-${index}`,
      row,
    })
  }
  await insertOrder(pool, {
    organizationId: ORGANIZATION_ID,
    restaurantGuid: RESTAURANT_GUID,
    orderGuid: 'voided-current-order',
    row: baselineRow('2026-07-18', 50000),
    voided: true,
  })
  await insertOrder(pool, {
    organizationId: ORGANIZATION_ID,
    restaurantGuid: RESTAURANT_GUID,
    orderGuid: 'deleted-current-order',
    row: baselineRow('2026-07-18', 60000),
    deleted: true,
  })
  await insertOrder(pool, {
    organizationId: ORGANIZATION_ID,
    restaurantGuid: RESTAURANT_GUID,
    orderGuid: 'prior-period-order',
    row: baselineRow('2026-07-17', 100),
  })
  await insertOrder(pool, {
    organizationId: ORGANIZATION_ID,
    restaurantGuid: RESTAURANT_GUID,
    orderGuid: 'voided-prior-period-order',
    row: baselineRow('2026-07-17', 70000),
    voided: true,
  })
  await insertOrder(pool, {
    organizationId: ORGANIZATION_ID,
    restaurantGuid: RESTAURANT_GUID,
    orderGuid: 'deleted-prior-period-order',
    row: baselineRow('2026-07-17', 80000),
    deleted: true,
  })
  await insertOrder(pool, {
    organizationId: ORGANIZATION_ID,
    restaurantGuid: RESTAURANT_GUID,
    orderGuid: 'prior-year-order',
    row: baselineRow('2025-07-18', 80),
  })
  await insertOrder(pool, {
    organizationId: OTHER_ORGANIZATION_ID,
    restaurantGuid: OTHER_RESTAURANT_GUID,
    orderGuid: 'other-tenant-order',
    row: {
      ...baselineRow('2026-07-18', 99999),
      details: {
        checks: [{
          payments: [{
            type: 'CREDIT',
            cardBrand: 'PRIVATE_OTHER_TENANT_BRAND',
            status: 'CAPTURED',
            amount: 99999,
            tip: 0,
            processingFee: 0,
            last4: '9999',
          }],
        }],
      },
    },
  })

  const otherPayout = { amount: 99999, bankAccount: 'private-other-tenant-bank' }
  await pool.query(
    `INSERT INTO toast_source_snapshots (
       organization_id, restaurant_guid, source_kind, source_id, business_date, payload_hash, payload
     ) VALUES ($1::uuid, $2::uuid, 'analytics_payout', 'other-payout', '2026-07-18', $3, $4::jsonb)`,
    [OTHER_ORGANIZATION_ID, OTHER_RESTAURANT_GUID, payloadHash(otherPayout), JSON.stringify(otherPayout)],
  )
}

async function runDisposablePostgresAssertions() {
  const dockerInfo = spawnSync('docker', ['info'], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  if (dockerInfo.status !== 0) {
    console.log('POS reporting disposable PostgreSQL assertions skipped: Docker is unavailable')
    return
  }

  const container = `clawpilot-pos-reporting-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  let pool
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_reporting',
      '-e', 'POSTGRES_DB=clawpilot_reporting',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const postgresPort = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(postgresPort > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    const databaseUrl = `postgresql://postgres:clawpilot_reporting@127.0.0.1:${postgresPort}/clawpilot_reporting`
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 })
    await waitForPostgres(pool)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await seedDisposableDatabase(pool)

    const posPersistenceModule = loadTypeScriptModule('app_src/lib/persistence/pos.ts', {
      '@/lib/persistence/postgres': { query: (sql, params) => pool.query(sql, params) },
      '@/lib/persistence/toastIntegrations': {
        readToastIntegrationStateFromPostgres: async () => ({
          credentials: {
            standard: { configured: true },
            analytics: { configured: false },
          },
          locations: [],
          latestSyncAt: null,
          jobs: [],
          reporting: { datasets: {}, noDataReason: null },
        }),
      },
    })
    const posWorkspace = await posPersistenceModule.readPosWorkspaceFromPostgres({
      organizationId: ORGANIZATION_ID,
      from: '2026-07-16',
      to: '2026-07-18',
      restaurantGuid: RESTAURANT_GUID,
      page: 1,
      pageSize: 25,
      selectedOrderGuid: null,
      search: '',
    })
    assert.deepEqual(
      Array.from(posWorkspace.syncIssues, (issue) => [issue.syncKind, issue.status]),
      [
        ['standard_orders', 'stale'],
        ['standard_orders', 'missing'],
      ],
      'POS posting queue must expose overdue postprocessing and configured missing source dates',
    )

    const persistenceModule = loadTypeScriptModule('app_src/lib/persistence/posReporting.ts', {
      '@/lib/persistence/postgres': { query: (sql, params) => pool.query(sql, params) },
    })
    const report = await persistenceModule.readPosOperationalReportFromPostgres({
      organizationId: ORGANIZATION_ID,
      from: '2026-07-18',
      to: '2026-07-18',
      restaurantGuid: null,
    })
    assertAcceptanceReport(report)
    assert.equal(JSON.stringify(report).includes('PRIVATE_OTHER_TENANT_BRAND'), false)
    assert.equal(JSON.stringify(report).includes('Private Other Restaurant'), false)
    assert.equal(report.receiptTotals.voidedOrderCount, 1)
    assert.equal(report.receiptTotals.voidedSales, 50000)
    assert.equal(report.receiptTotals.netSales, 551.74)
    assert.equal(report.receiptTotals.tendered, 592.32)
    assert.equal(report.coverage.orders, 27)
    assert.equal(report.comparisons.priorPeriod.totals.netSales, 100)
    assert.equal(report.comparisons.priorPeriod.totals.voidedOrderCount, 1)
    assert.equal(report.comparisons.priorPeriod.totals.voidedSales, 70000)
    assert.equal(report.comparisons.priorPeriod.totals.tendered, 100)
    assert.equal(report.comparisons.priorYear.totals.netSales, 80)

    const crossTenantLocation = await persistenceModule.readPosOperationalReportFromPostgres({
      organizationId: ORGANIZATION_ID,
      from: '2026-07-18',
      to: '2026-07-18',
      restaurantGuid: OTHER_RESTAURANT_GUID,
    })
    assert.equal(crossTenantLocation.receiptTotals.orderCount, 0)
    assert.equal(crossTenantLocation.scope.locations.length, 0)
    assert.equal(crossTenantLocation.tenderTotals.payoutEvidence.available, false)

    const payout = { amount: 629.53, bankAccount: 'not-returned' }
    await pool.query(
      `INSERT INTO toast_source_snapshots (
         organization_id, restaurant_guid, source_kind, source_id, business_date, payload_hash, payload
       ) VALUES ($1::uuid, $2::uuid, 'analytics_payout', 'acceptance-payout', '2026-07-18', $3, $4::jsonb)`,
      [ORGANIZATION_ID, RESTAURANT_GUID, payloadHash(payout), JSON.stringify(payout)],
    )
    const reportWithPayoutEvidence = await persistenceModule.readPosOperationalReportFromPostgres({
      organizationId: ORGANIZATION_ID,
      from: '2026-07-18',
      to: '2026-07-18',
      restaurantGuid: RESTAURANT_GUID,
    })
    assert.equal(reportWithPayoutEvidence.tenderTotals.payoutEvidence.available, true)
    assert.equal(reportWithPayoutEvidence.tenderTotals.payoutEvidence.recordCount, 1)
    assert.equal(reportWithPayoutEvidence.tenderTotals.actualPayout.available, false)
    assert.equal(reportWithPayoutEvidence.tenderTotals.bankDeposits.available, false)
    assert.equal(JSON.stringify(reportWithPayoutEvidence).includes('not-returned'), false)

    console.log('POS reporting disposable PostgreSQL tenancy and acceptance assertions passed')
  } finally {
    if (pool) await pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '-t', '1', container], { cwd: root, encoding: 'utf8', timeout: 20_000 })
  }
}

async function main() {
  await runSourceAndUnitContracts()
  if (!contractsOnly) await runDisposablePostgresAssertions()
  console.log('POS reporting contracts passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
