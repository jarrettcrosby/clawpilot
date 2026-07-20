#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const localRequire = (specifier) => Object.prototype.hasOwnProperty.call(mocks, specifier)
    ? mocks[specifier]
    : nodeRequire(specifier)
  const sandbox = {
    Buffer,
    console,
    exports: module.exports,
    module,
    process,
    require: localRequire,
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const migration = read('db/migrations/0067_toast_pos_orders.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS toast_pos_orders',
  'PRIMARY KEY (organization_id, restaurant_guid, order_guid)',
  'details jsonb NOT NULL',
  'payload_hash text NOT NULL',
  'standard_tax numeric',
  'standard_tips numeric',
  'standard_cash numeric',
  'standard_card numeric',
]) {
  assert.ok(migration.includes(fragment), `POS migration missing ${fragment}`)
}

const projectionModule = loadTypeScriptModule('app_src/lib/integrations/toastOrderProjection.ts')
const sample = {
  guid: '11111111-1111-4111-8111-111111111111',
  displayNumber: '42',
  source: { name: 'In Store' },
  diningOption: { behavior: 'DINE_IN' },
  numberOfGuests: 2,
  openedDate: '2026-07-18T16:00:00.000Z',
  checks: [{
    displayNumber: '1',
    paymentStatus: 'PAID',
    amount: 20,
    taxAmount: 1.6,
    totalAmount: 24.6,
    selections: [{
      displayName: 'Lunch special',
      quantity: 2,
      preDiscountPrice: 22,
      price: 20,
      tax: 1.6,
      modifiers: [{ displayName: 'Extra sauce', quantity: 1, price: 0.5 }],
    }],
    payments: [{ type: 'CREDIT', cardType: 'VISA', paymentStatus: 'CAPTURED', amount: 21.6, tipAmount: 3 }],
  }],
}
const projected = projectionModule.projectToastOrders([sample])
assert.equal(projected.orders.length, 1)
assert.equal(projected.totals.orderCount, 1)
assert.equal(projected.totals.grossSales, 22)
assert.equal(projected.totals.netSales, 20)
assert.equal(projected.totals.discounts, 2)
assert.equal(projected.totals.tax, 1.6)
assert.equal(projected.totals.tips, 3)
assert.equal(projected.totals.tendered, 21.6)
assert.equal(projected.totals.total, 24.6)
assert.equal(projected.totals.cardTender, 21.6)
assert.equal(projected.orders[0].details.checks[0].payments[0].cardBrand, 'VISA')
assert.equal(projected.orders[0].details.checks[0].selections[0].name, 'Lunch special')
assert.ok(!JSON.stringify(projected.orders[0].details).includes('last4Digits'))
assert.ok(!JSON.stringify(projected.orders[0].details).includes('customer'))

const partialRefundOrder = projectionModule.projectToastOrder({
  guid: '22222222-2222-4222-8222-222222222222',
  checks: [{
    amount: 100,
    totalAmount: 120,
    selections: [{ displayName: 'Refundable item', quantity: 1, preDiscountPrice: 100, price: 100 }],
    payments: [{
      type: 'CREDIT',
      cardType: 'AMEX',
      paymentStatus: 'CAPTURED',
      refundStatus: 'PARTIAL',
      amount: 100,
      tipAmount: 20,
      refund: { refundAmount: 25, tipRefundAmount: 5 },
    }],
  }],
}, 'partial-refund')
const partialRefundPayment = partialRefundOrder.details.checks[0].payments[0]
assert.equal(partialRefundPayment.cardBrand, 'AMEX')
assert.equal(partialRefundPayment.refundAmount, 25)
assert.equal(partialRefundPayment.tipRefundAmount, 5)
assert.equal(partialRefundPayment.refunded, true)
assert.equal(partialRefundOrder.netSales, 75)
assert.equal(partialRefundOrder.refunds, 30)
assert.equal(partialRefundOrder.tips, 15)
assert.equal(partialRefundOrder.tendered, 75)
assert.equal(partialRefundOrder.cardTender, 75)
assert.equal(partialRefundOrder.total, 90)

const orderWithExcludedChecks = {
  guid: '33333333-3333-4333-8333-333333333333',
  checks: [{
    amount: 10,
    totalAmount: 11,
    selections: [{ displayName: 'Active item', quantity: 1, preDiscountPrice: 10, price: 10 }],
    payments: [{ type: 'CREDIT', cardType: 'VISA', amount: 10, tipAmount: 1 }],
  }, {
    voided: true,
    amount: 40,
    totalAmount: 40,
    selections: [{ displayName: 'Voided item', quantity: 1, preDiscountPrice: 40, price: 40 }],
    payments: [{ type: 'CASH', amount: 40, tipAmount: 0 }],
  }, {
    deleted: true,
    amount: 50,
    totalAmount: 50,
    selections: [{ displayName: 'Deleted item', quantity: 1, preDiscountPrice: 50, price: 50 }],
    payments: [{ type: 'CREDIT', cardType: 'MASTERCARD', amount: 50, tipAmount: 0 }],
  }],
}
const excludedOrders = projectionModule.projectToastOrders([
  orderWithExcludedChecks,
  {
    guid: '44444444-4444-4444-8444-444444444444',
    voided: true,
    checks: [{
      amount: 80,
      totalAmount: 80,
      selections: [{ displayName: 'Voided order item', quantity: 1, preDiscountPrice: 80, price: 80 }],
      payments: [{ type: 'CREDIT', cardType: 'DISCOVER', amount: 80, tipAmount: 0 }],
    }],
  },
  {
    guid: '55555555-5555-4555-8555-555555555555',
    deleted: true,
    checks: [{
      amount: 90,
      totalAmount: 90,
      selections: [{ displayName: 'Deleted order item', quantity: 1, preDiscountPrice: 90, price: 90 }],
      payments: [{ type: 'CASH', amount: 90, tipAmount: 0 }],
    }],
  },
])
assert.equal(excludedOrders.totals.orderCount, 1)
assert.equal(excludedOrders.totals.netSales, 10)
assert.equal(excludedOrders.totals.tips, 1)
assert.equal(excludedOrders.totals.tendered, 10)
assert.equal(excludedOrders.totals.total, 11)
assert.equal(excludedOrders.totals.cardTender, 10)
assert.equal(excludedOrders.totals.cashTender, 0)
assert.equal(excludedOrders.totals.voids, 80)
assert.equal(excludedOrders.orders[0].checkCount, 1)
assert.equal(excludedOrders.orders[0].details.checks[1].voided, true)
assert.equal(excludedOrders.orders[0].details.checks[2].deleted, true)

const persistence = read('app_src/lib/persistence/toastIntegrations.ts')
for (const fragment of [
  'projectToastStandardOrdersInPostgres',
  'INSERT INTO toast_pos_orders',
  'DELETE FROM toast_pos_orders',
  'standard_orders_count = EXCLUDED.standard_orders_count',
  'standard_tips = EXCLUDED.standard_tips',
]) {
  assert.ok(persistence.includes(fragment), `POS projection persistence missing ${fragment}`)
}

const readModel = read('app_src/lib/persistence/pos.ts')
for (const fragment of [
  'readPosWorkspaceFromPostgres',
  'WHERE organization_id = $1::uuid',
  'o.organization_id = $1::uuid',
  'toast_accounting_export_drafts',
  'sum(net_sales) FILTER (WHERE voided = false)',
  'sum(card_tender) FILTER (WHERE voided = false)',
  'selectedOrder',
  'readiness',
]) {
  assert.ok(readModel.includes(fragment), `POS read model missing ${fragment}`)
}
assert.match(readModel, /o\.order_guid = \$2[\s\S]*?o\.deleted = false/)

const selectedQueries = []
const deletedSelectedRow = {
  order_guid: 'deleted-selected-order',
  restaurant_guid: '11111111-1111-4111-8111-111111111111',
  restaurant_name: 'Deleted Restaurant',
  business_date: '2026-07-18',
  display_number: 'deleted',
  source: null,
  dining_option: null,
  approval_status: null,
  payment_status: null,
  opened_at: null,
  closed_at: null,
  paid_at: null,
  guest_count: 0,
  check_count: 0,
  item_count: '0',
  gross_sales: '999',
  net_sales: '999',
  discounts: '0',
  tax: '0',
  service_charges: '0',
  tips: '0',
  refunds: '0',
  tendered: '999',
  total: '999',
  cash_tender: '0',
  card_tender: '999',
  other_tender: '0',
  voided: false,
  deleted: true,
  details: { checks: [] },
}
const readModelModule = loadTypeScriptModule('app_src/lib/persistence/pos.ts', {
  '@/lib/persistence/postgres': {
    query: async (sql) => {
      selectedQueries.push(sql)
      if (sql.includes('o.order_guid = $2')) {
        const rows = sql.includes('o.deleted = false') ? [] : [deletedSelectedRow]
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('count(*)::text AS count')) return { rows: [{ count: '0' }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
  },
  '@/lib/persistence/toastIntegrations': {
    readToastIntegrationStateFromPostgres: async () => ({
      credentials: { standard: { configured: false }, analytics: { configured: false } },
      locations: [],
      latestSyncAt: null,
      jobs: [],
      reporting: { datasets: [], noDataReason: null },
    }),
  },
})
const selectedDeletedWorkspace = await readModelModule.readPosWorkspaceFromPostgres({
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  from: '2026-07-18',
  to: '2026-07-18',
  restaurantGuid: null,
  page: 1,
  pageSize: 25,
  selectedOrderGuid: 'deleted-selected-order',
  search: '',
})
assert.equal(selectedDeletedWorkspace.selectedOrder, null)
assert.equal(selectedQueries.filter((sql) => sql.includes('o.order_guid = $2')).length, 1)

const route = read('app_src/app/api/pos/route.ts')
for (const fragment of [
  'requireRequestUser',
  'accountingCapabilities(actor)',
  'activeAccountingOrganizationId(actor)',
  'POS_VIEW_REQUIRED',
  'POS_DATE_RANGE_INVALID',
  "'Cache-Control': 'no-store'",
]) {
  assert.ok(route.includes(fragment), `POS API route missing ${fragment}`)
}

const worker = read('app_src/lib/toastSyncWorker.ts')
assert.ok(worker.includes('projectToastStandardOrdersInPostgres({ job, orders })'))
assert.ok(!worker.includes('updateToastStandardOrdersCountInPostgres'))

console.log('POS module contracts passed')
