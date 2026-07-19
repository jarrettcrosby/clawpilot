import { query } from '@/lib/persistence/postgres'

type TimestampValue = string | Date
type JsonRecord = Record<string, unknown>

export const POS_REPORT_MAX_RANGE_DAYS = 367

type PosReportOrderRow = {
  business_date: TimestampValue
  restaurant_guid: string
  guest_count: string | number
  check_count: string | number
  item_count: string | number
  gross_sales: string | number
  net_sales: string | number
  discounts: string | number
  tax: string | number
  service_charges: string | number
  tips: string | number
  refunds: string | number
  tendered: string | number
  total: string | number
  cash_tender: string | number
  card_tender: string | number
  other_tender: string | number
  voided: boolean
  details: unknown
}

type ComparisonRow = Omit<PosReportOrderRow, 'business_date' | 'restaurant_guid' | 'voided' | 'details'> & {
  comparison_key: 'priorPeriod' | 'priorYear'
  business_days: string | number
  location_count: string | number
  order_count: string | number
  voided_order_count: string | number
  voided_sales: string | number
}

type LocationRow = {
  restaurant_guid: string
  restaurant_name: string
  location_name: string | null
  timezone: string | null
  active: boolean
  archived: boolean
}

type PayoutEvidenceRow = {
  record_count: string | number
}

type ReceiptAccumulator = {
  dates: Set<string>
  locations: Set<string>
  orderCount: number
  voidedOrderCount: number
  guestCount: number
  checkCount: number
  itemQuantity: number
  grossSales: number
  netSales: number
  discounts: number
  voidedSales: number
  refunds: number
  tax: number
  serviceCharges: number
  tips: number
  tendered: number
  total: number
  cashTender: number
  cardTender: number
  otherTender: number
}

type ProductAccumulator = {
  productId: string | null
  identitySource: 'itemGuid' | 'itemId' | 'plu' | 'name'
  name: string
  plu: string | null
  categoryId: string | null
  categoryName: string
  categoryType: 'salesCategory' | 'itemGroup' | 'uncategorized'
  selectionCount: number
  quantity: number
  grossSales: number
  netSales: number
  discounts: number
  tax: number
  voidedQuantity: number
  voidedNetSales: number
  receipts: Set<number>
  checks: Set<string>
}

type CategoryAccumulator = {
  categoryId: string | null
  identitySource: 'salesCategoryId' | 'itemGroupId' | 'name' | 'uncategorized'
  name: string
  categoryType: 'salesCategory' | 'itemGroup' | 'uncategorized'
  selectionCount: number
  quantity: number
  grossSales: number
  netSales: number
  discounts: number
  tax: number
  voidedQuantity: number
  voidedNetSales: number
  products: Set<string>
}

type PaymentAccumulator = {
  paymentCount: number
  amount: number
  tips: number
  processingFees: number
  paymentsWithProcessingFee: number
  refundAmount: number
  tipRefundAmount: number
}

type CheckAccumulator = {
  checkCount: number
  amount: number
  tax: number
  serviceCharges: number
  total: number
}

const DAY_MS = 86_400_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function numberValue(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function money(value: unknown) {
  return Math.round(numberValue(value) * 100) / 100
}

function addMoney(left: number, right: unknown) {
  return money(left + numberValue(right))
}

function quantity(value: unknown) {
  return Math.round(numberValue(value) * 1_000) / 1_000
}

function text(value: unknown, max = 240): string | null {
  const normalized = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().replace(/[\u0000-\u001f\u007f]/g, '')
    : ''
  return normalized ? normalized.slice(0, max) : null
}

function nestedText(value: unknown, keys: string[]): string | null {
  const direct = text(value)
  if (direct) return direct
  const item = record(value)
  for (const key of keys) {
    const candidate = text(item[key])
    if (candidate) return candidate
  }
  return null
}

function dateOnly(value: TimestampValue) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

function dateMs(value: string) {
  return new Date(`${value}T00:00:00.000Z`).getTime()
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10)
}

function moveDays(value: string, days: number) {
  return formatDate(new Date(dateMs(value) + (days * DAY_MS)))
}

function moveCalendarYear(value: string, years: number) {
  const source = new Date(`${value}T00:00:00.000Z`)
  const year = source.getUTCFullYear() + years
  const month = source.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return formatDate(new Date(Date.UTC(year, month, Math.min(source.getUTCDate(), lastDay))))
}

function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('POS_DATE_INVALID')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || formatDate(parsed) !== value) throw new Error('POS_DATE_INVALID')
}

export function buildPosReportRanges(from: string, to: string) {
  assertDate(from)
  assertDate(to)
  const difference = Math.round((dateMs(to) - dateMs(from)) / DAY_MS)
  if (difference < 0 || difference >= POS_REPORT_MAX_RANGE_DAYS) throw new Error('POS_DATE_RANGE_INVALID')
  const inclusiveDays = difference + 1
  return {
    current: { from, to, days: inclusiveDays },
    priorPeriod: { from: moveDays(from, -inclusiveDays), to: moveDays(from, -1) },
    priorYear: { from: moveCalendarYear(from, -1), to: moveCalendarYear(to, -1) },
  }
}

function emptyReceiptAccumulator(): ReceiptAccumulator {
  return {
    dates: new Set(),
    locations: new Set(),
    orderCount: 0,
    voidedOrderCount: 0,
    guestCount: 0,
    checkCount: 0,
    itemQuantity: 0,
    grossSales: 0,
    netSales: 0,
    discounts: 0,
    voidedSales: 0,
    refunds: 0,
    tax: 0,
    serviceCharges: 0,
    tips: 0,
    tendered: 0,
    total: 0,
    cashTender: 0,
    cardTender: 0,
    otherTender: 0,
  }
}

function addOrder(accumulator: ReceiptAccumulator, row: PosReportOrderRow) {
  accumulator.voidedOrderCount += row.voided ? 1 : 0
  accumulator.voidedSales = addMoney(accumulator.voidedSales, row.voided ? row.net_sales : 0)
  if (row.voided) return
  accumulator.dates.add(dateOnly(row.business_date))
  accumulator.locations.add(row.restaurant_guid)
  accumulator.orderCount += 1
  accumulator.guestCount += numberValue(row.guest_count)
  accumulator.checkCount += numberValue(row.check_count)
  accumulator.itemQuantity = quantity(accumulator.itemQuantity + numberValue(row.item_count))
  accumulator.grossSales = addMoney(accumulator.grossSales, row.gross_sales)
  accumulator.netSales = addMoney(accumulator.netSales, row.net_sales)
  accumulator.discounts = addMoney(accumulator.discounts, row.discounts)
  accumulator.refunds = addMoney(accumulator.refunds, row.refunds)
  accumulator.tax = addMoney(accumulator.tax, row.tax)
  accumulator.serviceCharges = addMoney(accumulator.serviceCharges, row.service_charges)
  accumulator.tips = addMoney(accumulator.tips, row.tips)
  accumulator.tendered = addMoney(accumulator.tendered, row.tendered)
  accumulator.total = addMoney(accumulator.total, row.total)
  accumulator.cashTender = addMoney(accumulator.cashTender, row.cash_tender)
  accumulator.cardTender = addMoney(accumulator.cardTender, row.card_tender)
  accumulator.otherTender = addMoney(accumulator.otherTender, row.other_tender)
}

function average(value: number, count: number) {
  return count > 0 ? money(value / count) : null
}

function receiptTotals(accumulator: ReceiptAccumulator) {
  return {
    businessDays: accumulator.dates.size,
    locationCount: accumulator.locations.size,
    orderCount: accumulator.orderCount,
    voidedOrderCount: accumulator.voidedOrderCount,
    guestCount: accumulator.guestCount,
    checkCount: accumulator.checkCount,
    itemQuantity: accumulator.itemQuantity,
    grossSales: accumulator.grossSales,
    netSales: accumulator.netSales,
    discounts: accumulator.discounts,
    voidedSales: accumulator.voidedSales,
    refunds: accumulator.refunds,
    tax: accumulator.tax,
    serviceCharges: accumulator.serviceCharges,
    tips: accumulator.tips,
    tendered: accumulator.tendered,
    total: accumulator.total,
    cashTender: accumulator.cashTender,
    cardTender: accumulator.cardTender,
    otherTender: accumulator.otherTender,
    averageOrderNetSales: average(accumulator.netSales, accumulator.orderCount),
    averageCheckNetSales: average(accumulator.netSales, accumulator.checkCount),
    averageGuestNetSales: average(accumulator.netSales, accumulator.guestCount),
  }
}

function amountFromAggregate(value: unknown, allowedKeys: string[]): number | null {
  const direct = optionalNumber(value)
  if (direct !== null) return money(direct)
  const values = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
  let found = false
  let total = 0
  for (const entry of values) {
    const item = record(entry)
    for (const key of allowedKeys) {
      const amount = optionalNumber(item[key])
      if (amount !== null) {
        found = true
        total = addMoney(total, amount)
        break
      }
    }
  }
  return found ? total : null
}

function categoryIdentity(selection: JsonRecord) {
  const salesCategory = record(selection.salesCategory)
  const itemGroup = record(selection.itemGroup)
  const salesCategoryId = text(selection.salesCategoryId) || text(salesCategory.guid) || text(salesCategory.id)
  const itemGroupId = text(selection.itemGroupId) || text(itemGroup.guid) || text(itemGroup.id)
  const salesCategoryName = text(selection.salesCategoryName) || text(salesCategory.name)
  const itemGroupName = text(selection.itemGroupName) || text(itemGroup.name)
  if (salesCategoryId) {
    return {
      key: `salesCategoryId:${salesCategoryId}`,
      categoryId: salesCategoryId,
      identitySource: 'salesCategoryId' as const,
      name: salesCategoryName || 'Unnamed sales category',
      categoryType: 'salesCategory' as const,
    }
  }
  if (itemGroupId) {
    return {
      key: `itemGroupId:${itemGroupId}`,
      categoryId: itemGroupId,
      identitySource: 'itemGroupId' as const,
      name: itemGroupName || 'Unnamed item group',
      categoryType: 'itemGroup' as const,
    }
  }
  if (salesCategoryName) {
    return {
      key: `salesCategoryName:${salesCategoryName.toLocaleLowerCase('en-US')}`,
      categoryId: null,
      identitySource: 'name' as const,
      name: salesCategoryName,
      categoryType: 'salesCategory' as const,
    }
  }
  if (itemGroupName) {
    return {
      key: `itemGroupName:${itemGroupName.toLocaleLowerCase('en-US')}`,
      categoryId: null,
      identitySource: 'name' as const,
      name: itemGroupName,
      categoryType: 'itemGroup' as const,
    }
  }
  return {
    key: 'uncategorized',
    categoryId: null,
    identitySource: 'uncategorized' as const,
    name: 'Uncategorized',
    categoryType: 'uncategorized' as const,
  }
}

function productIdentity(selection: JsonRecord, categoryKey: string) {
  const item = record(selection.item)
  const itemGuid = text(selection.itemGuid) || text(item.guid)
  const itemId = text(selection.itemId) || text(item.id)
  const plu = text(selection.plu, 100) || text(item.plu, 100)
  const name = text(selection.name) || text(selection.itemName) || text(item.name) || 'Unnamed item'
  if (itemGuid) return { key: `itemGuid:${itemGuid}`, productId: itemGuid, identitySource: 'itemGuid' as const, name, plu }
  if (itemId) return { key: `itemId:${itemId}`, productId: itemId, identitySource: 'itemId' as const, name, plu }
  if (plu) return { key: `plu:${plu}`, productId: plu, identitySource: 'plu' as const, name, plu }
  return {
    key: `name:${categoryKey}:${name.toLocaleLowerCase('en-US')}`,
    productId: null,
    identitySource: 'name' as const,
    name,
    plu: null,
  }
}

function selectionAmounts(selection: JsonRecord) {
  const grossSales = money(selection.gross)
  const netSales = money(selection.net)
  const explicitDiscounts = amountFromAggregate(selection.discounts, ['amount', 'discountAmount', 'value'])
    ?? amountFromAggregate(selection.discount, ['amount', 'discountAmount', 'value'])
  const tax = amountFromAggregate(selection.taxes, ['amount', 'taxAmount', 'value']) ?? money(selection.tax)
  return {
    quantity: quantity(selection.quantity ?? 1),
    grossSales,
    netSales,
    discounts: explicitDiscounts === null ? Math.max(0, money(grossSales - netSales)) : Math.max(0, explicitDiscounts),
    tax,
    voided: selection.voided === true,
  }
}

function addPayment(
  target: Map<string, PaymentAccumulator>,
  key: string,
  amount: number,
  tip: number,
  processingFee: number | null,
  refundAmount: number,
  tipRefundAmount: number,
) {
  const current = target.get(key) || {
    paymentCount: 0,
    amount: 0,
    tips: 0,
    processingFees: 0,
    paymentsWithProcessingFee: 0,
    refundAmount: 0,
    tipRefundAmount: 0,
  }
  current.paymentCount += 1
  current.amount = addMoney(current.amount, amount)
  current.tips = addMoney(current.tips, tip)
  if (processingFee !== null) {
    current.processingFees = addMoney(current.processingFees, processingFee)
    current.paymentsWithProcessingFee += 1
  }
  current.refundAmount = addMoney(current.refundAmount, refundAmount)
  current.tipRefundAmount = addMoney(current.tipRefundAmount, tipRefundAmount)
  target.set(key, current)
}

function addCheck(target: Map<string, CheckAccumulator>, key: string, values: Omit<CheckAccumulator, 'checkCount'>) {
  const current = target.get(key) || { checkCount: 0, amount: 0, tax: 0, serviceCharges: 0, total: 0 }
  current.checkCount += 1
  current.amount = addMoney(current.amount, values.amount)
  current.tax = addMoney(current.tax, values.tax)
  current.serviceCharges = addMoney(current.serviceCharges, values.serviceCharges)
  current.total = addMoney(current.total, values.total)
  target.set(key, current)
}

function paymentRows(values: Map<string, PaymentAccumulator>, field: 'type' | 'cardType' | 'status') {
  return [...values.entries()]
    .sort(([leftKey, left], [rightKey, right]) => right.amount - left.amount || leftKey.localeCompare(rightKey))
    .map(([key, totals]) => ({
      [field]: key,
      ...totals,
      calculatedNetSettlement: totals.paymentsWithProcessingFee === totals.paymentCount
        ? money(totals.amount + totals.tips - totals.refundAmount - totals.tipRefundAmount - totals.processingFees)
        : null,
    }))
}

function checkTotals(value: CheckAccumulator) {
  return {
    ...value,
    averageAmount: average(value.amount, value.checkCount),
    averageTotal: average(value.total, value.checkCount),
  }
}

function unavailable(reason: string) {
  return { available: false as const, value: null, reason }
}

function comparisonReceiptTotals(row: ComparisonRow | undefined) {
  const orderCount = numberValue(row?.order_count)
  const checkCount = numberValue(row?.check_count)
  const guestCount = numberValue(row?.guest_count)
  const netSales = money(row?.net_sales)
  return {
    businessDays: numberValue(row?.business_days),
    locationCount: numberValue(row?.location_count),
    orderCount,
    voidedOrderCount: numberValue(row?.voided_order_count),
    guestCount,
    checkCount,
    itemQuantity: quantity(row?.item_count),
    grossSales: money(row?.gross_sales),
    netSales,
    discounts: money(row?.discounts),
    voidedSales: money(row?.voided_sales),
    refunds: money(row?.refunds),
    tax: money(row?.tax),
    serviceCharges: money(row?.service_charges),
    tips: money(row?.tips),
    tendered: money(row?.tendered),
    total: money(row?.total),
    cashTender: money(row?.cash_tender),
    cardTender: money(row?.card_tender),
    otherTender: money(row?.other_tender),
    averageOrderNetSales: average(netSales, orderCount),
    averageCheckNetSales: average(netSales, checkCount),
    averageGuestNetSales: average(netSales, guestCount),
  }
}

function change(current: number, baseline: number, moneyValue = true) {
  const difference = moneyValue ? money(current - baseline) : current - baseline
  return {
    absolute: difference,
    percent: baseline === 0 ? null : Math.round(((current - baseline) / Math.abs(baseline)) * 10_000) / 100,
  }
}

function comparison(
  range: { from: string; to: string },
  current: ReturnType<typeof receiptTotals>,
  row: ComparisonRow | undefined,
) {
  const totals = comparisonReceiptTotals(row)
  if (!row || totals.orderCount === 0) return { available: false as const, range, totals: null, change: null }
  return {
    available: true as const,
    range,
    totals,
    change: {
      orderCount: change(current.orderCount, totals.orderCount, false),
      checkCount: change(current.checkCount, totals.checkCount, false),
      guestCount: change(current.guestCount, totals.guestCount, false),
      grossSales: change(current.grossSales, totals.grossSales),
      netSales: change(current.netSales, totals.netSales),
      tendered: change(current.tendered, totals.tendered),
      total: change(current.total, totals.total),
    },
  }
}

export function aggregatePosOperationalReport(input: {
  organizationId: string
  from: string
  to: string
  restaurantGuid: string | null
  locations?: LocationRow[]
  orders: PosReportOrderRow[]
  comparisons?: ComparisonRow[]
  analyticsPayoutEvidenceRecords?: number
}) {
  const ranges = buildPosReportRanges(input.from, input.to)
  const receiptAccumulator = emptyReceiptAccumulator()
  const daily = new Map<string, ReceiptAccumulator>()
  const products = new Map<string, ProductAccumulator>()
  const categories = new Map<string, CategoryAccumulator>()
  const tenderTypes = new Map<string, PaymentAccumulator>()
  const cardTypes = new Map<string, PaymentAccumulator>()
  const paymentStatuses = new Map<string, PaymentAccumulator>()
  const checkStatuses = new Map<string, CheckAccumulator>()
  const allChecks: CheckAccumulator = { checkCount: 0, amount: 0, tax: 0, serviceCharges: 0, total: 0 }
  let ordersWithCheckDetails = 0
  let selectionsParsed = 0
  let paymentsParsed = 0
  let cashPaymentCount = 0
  let cashPaymentAmount = 0
  let cashRefundAmount = 0
  let processingFees = 0
  let paymentsWithProcessingFee = 0
  let cardPaymentCount = 0
  let cardPaymentsWithProcessingFee = 0
  let cardPaymentAmount = 0
  let cardTips = 0
  let cardRefundAmount = 0
  let cardTipRefundAmount = 0
  let cardProcessingFees = 0

  input.orders.forEach((row, orderIndex) => {
    addOrder(receiptAccumulator, row)
    const businessDate = dateOnly(row.business_date)
    const dailyAccumulator = daily.get(businessDate) || emptyReceiptAccumulator()
    addOrder(dailyAccumulator, row)
    daily.set(businessDate, dailyAccumulator)

    const checks = list(record(row.details).checks)
    if (checks.some((checkValue) => record(checkValue).deleted !== true)) ordersWithCheckDetails += 1
    checks.forEach((checkValue, checkIndex) => {
      const check = record(checkValue)
      if (check.deleted === true) return
      const checkVoided = row.voided || check.voided === true
      const values = {
        amount: money(check.amount),
        tax: money(check.tax),
        serviceCharges: money(check.serviceCharges),
        total: money(check.total),
      }
      const status = (nestedText(check.paymentStatus, ['name', 'value']) || 'UNKNOWN').toLocaleUpperCase('en-US')
      if (!checkVoided) {
        addCheck(checkStatuses, status, values)
        allChecks.checkCount += 1
        allChecks.amount = addMoney(allChecks.amount, values.amount)
        allChecks.tax = addMoney(allChecks.tax, values.tax)
        allChecks.serviceCharges = addMoney(allChecks.serviceCharges, values.serviceCharges)
        allChecks.total = addMoney(allChecks.total, values.total)
      }

      list(check.selections).forEach((selectionValue) => {
        const selection = record(selectionValue)
        const category = categoryIdentity(selection)
        const product = productIdentity(selection, category.key)
        const amounts = selectionAmounts(selection)
        const isVoided = checkVoided || amounts.voided
        selectionsParsed += 1

        const productTotals = products.get(product.key) || {
          productId: product.productId,
          identitySource: product.identitySource,
          name: product.name,
          plu: product.plu,
          categoryId: category.categoryId,
          categoryName: category.name,
          categoryType: category.categoryType,
          selectionCount: 0,
          quantity: 0,
          grossSales: 0,
          netSales: 0,
          discounts: 0,
          tax: 0,
          voidedQuantity: 0,
          voidedNetSales: 0,
          receipts: new Set<number>(),
          checks: new Set<string>(),
        }
        productTotals.selectionCount += 1
        productTotals.receipts.add(orderIndex)
        productTotals.checks.add(`${orderIndex}:${checkIndex}`)
        if (isVoided) {
          productTotals.voidedQuantity = quantity(productTotals.voidedQuantity + amounts.quantity)
          productTotals.voidedNetSales = addMoney(productTotals.voidedNetSales, amounts.netSales)
        } else {
          productTotals.quantity = quantity(productTotals.quantity + amounts.quantity)
          productTotals.grossSales = addMoney(productTotals.grossSales, amounts.grossSales)
          productTotals.netSales = addMoney(productTotals.netSales, amounts.netSales)
          productTotals.discounts = addMoney(productTotals.discounts, amounts.discounts)
          productTotals.tax = addMoney(productTotals.tax, amounts.tax)
        }
        products.set(product.key, productTotals)

        const categoryTotals = categories.get(category.key) || {
          categoryId: category.categoryId,
          identitySource: category.identitySource,
          name: category.name,
          categoryType: category.categoryType,
          selectionCount: 0,
          quantity: 0,
          grossSales: 0,
          netSales: 0,
          discounts: 0,
          tax: 0,
          voidedQuantity: 0,
          voidedNetSales: 0,
          products: new Set<string>(),
        }
        categoryTotals.selectionCount += 1
        categoryTotals.products.add(product.key)
        if (isVoided) {
          categoryTotals.voidedQuantity = quantity(categoryTotals.voidedQuantity + amounts.quantity)
          categoryTotals.voidedNetSales = addMoney(categoryTotals.voidedNetSales, amounts.netSales)
        } else {
          categoryTotals.quantity = quantity(categoryTotals.quantity + amounts.quantity)
          categoryTotals.grossSales = addMoney(categoryTotals.grossSales, amounts.grossSales)
          categoryTotals.netSales = addMoney(categoryTotals.netSales, amounts.netSales)
          categoryTotals.discounts = addMoney(categoryTotals.discounts, amounts.discounts)
          categoryTotals.tax = addMoney(categoryTotals.tax, amounts.tax)
        }
        categories.set(category.key, categoryTotals)
      })

      if (checkVoided) return
      list(check.payments).forEach((paymentValue) => {
        const payment = record(paymentValue)
        const type = (nestedText(payment.type, ['name', 'value']) || 'OTHER').toLocaleUpperCase('en-US')
        const cardBrand = nestedText(payment.cardBrand, ['name', 'value'])?.toLocaleUpperCase('en-US') || null
        const status = (nestedText(payment.status, ['name', 'value']) || 'UNKNOWN').toLocaleUpperCase('en-US')
        const amount = money(payment.amount)
        const tip = money(payment.tip)
        const refundAmount = Math.abs(money(payment.refundAmount))
        const tipRefundAmount = Math.abs(money(payment.tipRefundAmount))
        const processingFeeValue = optionalNumber(payment.processingFee)
        const processingFee = processingFeeValue === null ? null : money(processingFeeValue)
        paymentsParsed += 1
        if (processingFee !== null) {
          paymentsWithProcessingFee += 1
          processingFees = addMoney(processingFees, processingFee)
        }
        addPayment(tenderTypes, type, amount, tip, processingFee, refundAmount, tipRefundAmount)
        addPayment(paymentStatuses, status, amount, tip, processingFee, refundAmount, tipRefundAmount)
        if (cardBrand || /credit|debit|card/i.test(type)) {
          cardPaymentCount += 1
          cardPaymentAmount = addMoney(cardPaymentAmount, amount)
          cardTips = addMoney(cardTips, tip)
          cardRefundAmount = addMoney(cardRefundAmount, refundAmount)
          cardTipRefundAmount = addMoney(cardTipRefundAmount, tipRefundAmount)
          if (processingFee !== null) {
            cardPaymentsWithProcessingFee += 1
            cardProcessingFees = addMoney(cardProcessingFees, processingFee)
          }
          addPayment(cardTypes, cardBrand || 'UNKNOWN', amount, tip, processingFee, refundAmount, tipRefundAmount)
        }
        if (/cash/i.test(type)) {
          cashPaymentCount += 1
          cashPaymentAmount = addMoney(cashPaymentAmount, amount)
          cashRefundAmount = addMoney(cashRefundAmount, refundAmount + tipRefundAmount)
        }
      })
    })
  })

  const totals = receiptTotals(receiptAccumulator)
  const comparisonRows = input.comparisons || []
  const priorPeriodRow = comparisonRows.find((row) => row.comparison_key === 'priorPeriod')
  const priorYearRow = comparisonRows.find((row) => row.comparison_key === 'priorYear')
  const payoutEvidenceRecords = Math.max(0, Math.floor(numberValue(input.analyticsPayoutEvidenceRecords)))
  const payoutEvidence = {
    available: payoutEvidenceRecords > 0,
    recordCount: payoutEvidenceRecords,
  }
  const deposits = unavailable(payoutEvidence.available
    ? 'Toast Analytics payout evidence exists, but no safe bank-deposit amount is projected for this report.'
    : 'No Toast Analytics payout evidence exists for this report range.')
  const actualPayout = unavailable(payoutEvidence.available
    ? 'Toast Analytics payout evidence exists, but no safe payout amount is projected for this report.'
    : 'No Toast Analytics payout evidence exists for this report range.')
  const processingFeeMetric = paymentsWithProcessingFee > 0
    ? {
        available: true as const,
        value: processingFees,
        paymentCount: paymentsWithProcessingFee,
        totalPaymentCount: paymentsParsed,
        complete: paymentsWithProcessingFee === paymentsParsed,
        source: 'toast_pos_orders.details.checks.payments.processingFee' as const,
      }
    : unavailable('Projected payment details do not contain processing fees for this report range.')
  const calculatedCardSettlement = cardPaymentCount > 0 && cardPaymentsWithProcessingFee === cardPaymentCount
    ? {
        available: true as const,
        value: money(cardPaymentAmount + cardTips - cardRefundAmount - cardTipRefundAmount - cardProcessingFees),
        cardAmount: cardPaymentAmount,
        tips: cardTips,
        refunds: cardRefundAmount,
        tipRefunds: cardTipRefundAmount,
        processingFees: cardProcessingFees,
        formula: 'cardAmount + tips - refunds - tipRefunds - processingFees' as const,
      }
    : unavailable(cardPaymentCount === 0
      ? 'No card payments are present for this report range.'
      : 'Calculated card settlement requires processingFee on every projected card payment.')

  return {
    organizationId: input.organizationId,
    range: ranges.current,
    scope: {
      restaurantGuid: input.restaurantGuid,
      locations: (input.locations || []).map((location) => ({
        restaurantGuid: location.restaurant_guid,
        restaurantName: location.restaurant_name,
        locationName: location.location_name,
        timezone: location.timezone,
        active: location.active,
        archived: location.archived,
      })),
    },
    receiptTotals: totals,
    categoryTotals: [...categories.values()]
      .map((category) => ({
        categoryId: category.categoryId,
        identitySource: category.identitySource,
        name: category.name,
        categoryType: category.categoryType,
        productCount: category.products.size,
        selectionCount: category.selectionCount,
        quantity: category.quantity,
        grossSales: category.grossSales,
        netSales: category.netSales,
        discounts: category.discounts,
        tax: category.tax,
        voidedQuantity: category.voidedQuantity,
        voidedNetSales: category.voidedNetSales,
      }))
      .sort((left, right) => right.netSales - left.netSales || left.name.localeCompare(right.name)),
    productPerformance: [...products.values()]
      .map((product) => ({
        productId: product.productId,
        identitySource: product.identitySource,
        name: product.name,
        plu: product.plu,
        categoryId: product.categoryId,
        categoryName: product.categoryName,
        categoryType: product.categoryType,
        receiptCount: product.receipts.size,
        checkCount: product.checks.size,
        selectionCount: product.selectionCount,
        quantity: product.quantity,
        grossSales: product.grossSales,
        netSales: product.netSales,
        discounts: product.discounts,
        tax: product.tax,
        voidedQuantity: product.voidedQuantity,
        voidedNetSales: product.voidedNetSales,
      }))
      .sort((left, right) => right.netSales - left.netSales || left.name.localeCompare(right.name)),
    tenderTotals: {
      orderLevel: {
        tendered: totals.tendered,
        cash: totals.cashTender,
        card: totals.cardTender,
        other: totals.otherTender,
      },
      byType: paymentRows(tenderTypes, 'type'),
      byCardType: paymentRows(cardTypes, 'cardType'),
      byStatus: paymentRows(paymentStatuses, 'status'),
      processingFees: processingFeeMetric,
      calculatedCardSettlement,
      payoutEvidence,
      actualPayout,
      bankDeposits: deposits,
    },
    cashOperations: {
      tendered: totals.cashTender,
      detailedPaymentCount: cashPaymentCount,
      detailedPaymentAmount: cashPaymentAmount,
      detailedRefundAmount: cashRefundAmount,
      deposits,
    },
    dailySummaries: [...daily.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([businessDate, accumulator]) => ({ businessDate, ...receiptTotals(accumulator) })),
    checkSummaries: {
      totals: checkTotals(allChecks),
      byPaymentStatus: [...checkStatuses.entries()]
        .map(([paymentStatus, value]) => ({ paymentStatus, ...checkTotals(value) }))
        .sort((left, right) => right.checkCount - left.checkCount || left.paymentStatus.localeCompare(right.paymentStatus)),
    },
    comparisons: {
      priorPeriod: comparison(ranges.priorPeriod, totals, priorPeriodRow),
      priorYear: comparison(ranges.priorYear, totals, priorYearRow),
    },
    coverage: {
      orders: input.orders.length,
      ordersWithCheckDetails,
      detailedChecks: allChecks.checkCount,
      detailedSelections: selectionsParsed,
      detailedPayments: paymentsParsed,
      paymentsWithProcessingFee,
      cardPaymentsWithProcessingFee,
      analyticsPayoutEvidenceRecords: payoutEvidenceRecords,
    },
    unavailableMetrics: {
      deposits,
      actualPayout,
      processingFees: processingFeeMetric,
      weather: unavailable('Weather observations are not present in the POS reporting sources.'),
      cogs: unavailable('Cost of goods sold is not present in the POS reporting sources.'),
      grossMargin: unavailable('Gross margin cannot be calculated without cost of goods sold.'),
    },
  }
}

export async function readPosOperationalReportFromPostgres(input: {
  organizationId: string
  from: string
  to: string
  restaurantGuid: string | null
}) {
  const organizationId = String(input.organizationId || '').trim()
  const restaurantGuid = input.restaurantGuid ? String(input.restaurantGuid).trim() : null
  if (!UUID_PATTERN.test(organizationId)) throw new Error('POS_ORGANIZATION_INVALID')
  if (restaurantGuid && !UUID_PATTERN.test(restaurantGuid)) throw new Error('POS_LOCATION_INVALID')
  const ranges = buildPosReportRanges(input.from, input.to)

  const [locationResult, orderResult, comparisonResult, payoutEvidenceResult] = await Promise.all([
    query<LocationRow>(
      `SELECT restaurant_guid::text, restaurant_name, location_name, timezone, active, archived
       FROM toast_locations
       WHERE organization_id = $1::uuid
         AND ($2::uuid IS NULL OR restaurant_guid = $2::uuid)
       ORDER BY restaurant_name, restaurant_guid`,
      [organizationId, restaurantGuid],
    ),
    query<PosReportOrderRow>(
      `SELECT business_date, restaurant_guid::text,
         guest_count::text, check_count::text, item_count::text,
         gross_sales::text, net_sales::text, discounts::text, tax::text,
         service_charges::text, tips::text, refunds::text, tendered::text,
         total::text, cash_tender::text, card_tender::text, other_tender::text,
         voided, details
       FROM toast_pos_orders
       WHERE organization_id = $1::uuid
         AND business_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR restaurant_guid = $4::uuid)
         AND deleted = false
       ORDER BY business_date, restaurant_guid, order_guid`,
      [organizationId, input.from, input.to, restaurantGuid],
    ),
    query<ComparisonRow>(
      `WITH comparison_ranges (comparison_key, date_from, date_to) AS (
         VALUES
           ('priorPeriod'::text, $3::date, $4::date),
           ('priorYear'::text, $5::date, $6::date)
       )
       SELECT ranges.comparison_key,
         count(DISTINCT orders.business_date) FILTER (WHERE orders.voided = false)::text AS business_days,
         count(DISTINCT orders.restaurant_guid) FILTER (WHERE orders.voided = false)::text AS location_count,
         count(orders.order_guid) FILTER (WHERE orders.voided = false)::text AS order_count,
         count(orders.order_guid) FILTER (WHERE orders.voided)::text AS voided_order_count,
         coalesce(sum(orders.guest_count) FILTER (WHERE orders.voided = false), 0)::text AS guest_count,
         coalesce(sum(orders.check_count) FILTER (WHERE orders.voided = false), 0)::text AS check_count,
         coalesce(sum(orders.item_count) FILTER (WHERE orders.voided = false), 0)::text AS item_count,
         coalesce(sum(orders.gross_sales) FILTER (WHERE orders.voided = false), 0)::text AS gross_sales,
         coalesce(sum(orders.net_sales) FILTER (WHERE orders.voided = false), 0)::text AS net_sales,
         coalesce(sum(orders.discounts) FILTER (WHERE orders.voided = false), 0)::text AS discounts,
         coalesce(sum(orders.net_sales) FILTER (WHERE orders.voided), 0)::text AS voided_sales,
         coalesce(sum(orders.refunds) FILTER (WHERE orders.voided = false), 0)::text AS refunds,
         coalesce(sum(orders.tax) FILTER (WHERE orders.voided = false), 0)::text AS tax,
         coalesce(sum(orders.service_charges) FILTER (WHERE orders.voided = false), 0)::text AS service_charges,
         coalesce(sum(orders.tips) FILTER (WHERE orders.voided = false), 0)::text AS tips,
         coalesce(sum(orders.tendered) FILTER (WHERE orders.voided = false), 0)::text AS tendered,
         coalesce(sum(orders.total) FILTER (WHERE orders.voided = false), 0)::text AS total,
         coalesce(sum(orders.cash_tender) FILTER (WHERE orders.voided = false), 0)::text AS cash_tender,
         coalesce(sum(orders.card_tender) FILTER (WHERE orders.voided = false), 0)::text AS card_tender,
         coalesce(sum(orders.other_tender) FILTER (WHERE orders.voided = false), 0)::text AS other_tender
       FROM comparison_ranges ranges
       LEFT JOIN toast_pos_orders orders
         ON orders.organization_id = $1::uuid
         AND orders.business_date BETWEEN ranges.date_from AND ranges.date_to
         AND ($2::uuid IS NULL OR orders.restaurant_guid = $2::uuid)
         AND orders.deleted = false
       GROUP BY ranges.comparison_key
       ORDER BY ranges.comparison_key`,
      [organizationId, restaurantGuid, ranges.priorPeriod.from, ranges.priorPeriod.to, ranges.priorYear.from, ranges.priorYear.to],
    ),
    query<PayoutEvidenceRow>(
      `SELECT count(*)::text AS record_count
       FROM toast_source_snapshots
       WHERE organization_id = $1::uuid
         AND source_kind = 'analytics_payout'
         AND business_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR restaurant_guid = $4::uuid)`,
      [organizationId, input.from, input.to, restaurantGuid],
    ),
  ])

  return aggregatePosOperationalReport({
    organizationId,
    from: input.from,
    to: input.to,
    restaurantGuid,
    locations: locationResult.rows,
    orders: orderResult.rows,
    comparisons: comparisonResult.rows,
    analyticsPayoutEvidenceRecords: numberValue(payoutEvidenceResult.rows[0]?.record_count),
  })
}
