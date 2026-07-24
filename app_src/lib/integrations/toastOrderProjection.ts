import crypto from 'crypto'

type JsonRecord = Record<string, unknown>

export type ToastProjectedSelection = {
  providerGuid: string | null
  itemGuid: string | null
  itemMultiLocationId: string | null
  itemName: string
  plu: string | null
  itemGroupGuid: string | null
  itemGroupMultiLocationId: string | null
  itemGroupName: string | null
  salesCategoryGuid: string | null
  salesCategoryMultiLocationId: string | null
  salesCategoryName: string | null
  groupGuid: string | null
  groupName: string | null
  name: string
  quantity: number
  gross: number
  net: number
  tax: number
  voided: boolean
  discounts: ToastProjectedNamedAmount[]
  taxes: ToastProjectedNamedAmount[]
  modifiers: Array<{
    providerGuid: string | null
    itemGuid: string | null
    itemName: string
    name: string
    quantity: number
    amount: number
  }>
}

export type ToastProjectedPayment = {
  type: string
  cardBrand: string | null
  status: string | null
  paidAt: string | null
  paidBusinessDate: string | null
  amount: number
  tip: number
  refundAmount: number
  tipRefundAmount: number
  processingFee: number | null
  refunded: boolean
  voided: boolean
  deleted: boolean
}

export type ToastProjectedNamedAmount = {
  providerGuid: string | null
  name: string
  amount: number
  type: string | null
  rate: number | null
  percent: number | null
}

export type ToastProjectedCheck = {
  providerGuid: string | null
  displayNumber: string | null
  paymentStatus: string | null
  openedAt: string | null
  closedAt: string | null
  paidAt: string | null
  duration: number | null
  amount: number
  tax: number
  total: number
  serviceCharges: number
  voided: boolean
  deleted: boolean
  selections: ToastProjectedSelection[]
  payments: ToastProjectedPayment[]
  discounts: ToastProjectedNamedAmount[]
  taxes: ToastProjectedNamedAmount[]
  serviceChargeLines: ToastProjectedNamedAmount[]
}

export type ToastProjectedOrder = {
  orderGuid: string
  displayNumber: string | null
  source: string | null
  diningOption: string | null
  approvalStatus: string | null
  paymentStatus: string | null
  createdAt: string | null
  modifiedAt: string | null
  promisedAt: string | null
  estimatedFulfillmentAt: string | null
  openedAt: string | null
  closedAt: string | null
  paidAt: string | null
  guestCount: number
  checkCount: number
  itemCount: number
  grossSales: number
  netSales: number
  discounts: number
  tax: number
  serviceCharges: number
  tips: number
  refunds: number
  tendered: number
  total: number
  cashTender: number
  cardTender: number
  otherTender: number
  voided: boolean
  deleted: boolean
  details: { checks: ToastProjectedCheck[] }
  payloadHash: string
}

export type ToastProjectedTotals = Omit<ToastProjectedOrder,
  'orderGuid' | 'displayNumber' | 'source' | 'diningOption' | 'approvalStatus' | 'paymentStatus'
  | 'createdAt' | 'modifiedAt' | 'promisedAt' | 'estimatedFulfillmentAt'
  | 'openedAt' | 'closedAt' | 'paidAt' | 'voided' | 'deleted' | 'details' | 'payloadHash'
> & { orderCount: number; voids: number }

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function list(value: unknown) {
  return Array.isArray(value) ? value : []
}

function numberValue(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function money(value: unknown) {
  return Math.round(numberValue(value) * 100) / 100
}

function text(value: unknown, max = 200) {
  const normalized = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return normalized ? normalized.slice(0, max) : null
}

function guid(value: unknown) {
  const candidate = text(value, 36)
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate.toLowerCase()
    : null
}

function safeIdentifier(value: unknown, max = 200) {
  const candidate = text(value, max)
  return candidate && /^[!-~]+$/.test(candidate) ? candidate : null
}

function nestedText(value: unknown, ...keys: string[]) {
  if (typeof value === 'string') return text(value)
  const item = record(value)
  for (const key of keys) {
    const result = text(item[key])
    if (result) return result
  }
  return null
}

function instant(value: unknown) {
  const candidate = text(value, 100)
  if (!candidate) return null
  const parsed = new Date(candidate)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function businessDate(value: unknown) {
  const candidate = text(value, 20)
  if (!candidate) return null
  const normalized = /^\d{8}$/.test(candidate)
    ? `${candidate.slice(0, 4)}-${candidate.slice(4, 6)}-${candidate.slice(6, 8)}`
    : candidate
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
    ? normalized
    : null
}

function serviceChargeAmount(value: unknown) {
  const item = record(value)
  return money(item.chargeAmount ?? item.amount ?? item.serviceChargeAmount)
}

function modifier(value: unknown) {
  const item = record(value)
  const itemReference = record(item.item)
  const itemName = text(itemReference.name ?? item.displayName ?? item.name, 240) || 'Modifier'
  return {
    providerGuid: guid(item.guid),
    itemGuid: guid(itemReference.guid ?? item.itemGuid),
    itemName,
    name: text(item.displayName ?? itemName, 240) || itemName,
    quantity: numberValue(item.quantity) || 1,
    amount: money(item.price ?? item.receiptLinePrice ?? item.preDiscountPrice),
  }
}

function selection(value: unknown): ToastProjectedSelection {
  const item = record(value)
  const itemReference = record(item.item)
  const itemGroupReference = record(item.itemGroup ?? itemReference.itemGroup)
  const salesCategoryReference = record(item.salesCategory ?? itemReference.salesCategory)
  const groupReference = Object.keys(salesCategoryReference).length > 0 ? salesCategoryReference : itemGroupReference
  const itemName = text(itemReference.name ?? item.displayName ?? item.name, 240) || 'Item'
  const gross = money(item.preDiscountPrice ?? item.receiptLinePrice ?? item.price)
  const net = money(item.price ?? item.receiptLinePrice ?? item.preDiscountPrice)
  return {
    providerGuid: guid(item.guid),
    itemGuid: guid(itemReference.guid ?? item.itemGuid),
    itemMultiLocationId: safeIdentifier(itemReference.multiLocationId ?? item.itemMultiLocationId),
    itemName,
    plu: safeIdentifier(item.plu ?? itemReference.plu, 100),
    itemGroupGuid: guid(itemGroupReference.guid ?? item.itemGroupGuid),
    itemGroupMultiLocationId: safeIdentifier(itemGroupReference.multiLocationId ?? item.itemGroupMultiLocationId),
    itemGroupName: text(itemGroupReference.name ?? item.itemGroupName, 240),
    salesCategoryGuid: guid(salesCategoryReference.guid ?? item.salesCategoryGuid),
    salesCategoryMultiLocationId: safeIdentifier(salesCategoryReference.multiLocationId ?? item.salesCategoryMultiLocationId),
    salesCategoryName: text(salesCategoryReference.name ?? item.salesCategoryName, 240),
    groupGuid: guid(groupReference.guid ?? item.itemGroupGuid ?? item.salesCategoryGuid),
    groupName: text(groupReference.name ?? item.itemGroupName ?? item.salesCategoryName, 240),
    name: text(item.displayName ?? itemName, 240) || itemName,
    quantity: numberValue(item.quantity) || 1,
    gross,
    net,
    tax: money(item.tax ?? item.taxAmount),
    voided: item.voided === true || item.deleted === true,
    discounts: list(item.appliedDiscounts ?? item.discounts).map((entry) => namedAmount(entry, ['discount'])),
    taxes: list(item.appliedTaxes ?? item.taxes).map((entry) => namedAmount(entry, ['taxRate', 'tax'])),
    modifiers: list(item.modifiers).map(modifier),
  }
}

function namedAmount(value: unknown, referenceKeys: string[]): ToastProjectedNamedAmount {
  const item = record(value)
  let reference: JsonRecord = item
  for (const key of referenceKeys) {
    const candidate = record(item[key])
    if (Object.keys(candidate).length > 0) {
      reference = candidate
      break
    }
  }
  return {
    providerGuid: guid(reference.guid ?? item.guid),
    name: text(reference.name ?? item.displayName ?? item.name, 240) || 'POS adjustment',
    amount: money(
      item.amount ?? item.discountAmount ?? item.taxAmount ?? item.chargeAmount
      ?? item.serviceChargeAmount ?? item.appliedAmount,
    ),
    type: nestedText(item.discountType ?? item.type, 'name', 'value'),
    rate: (item.rate ?? reference.rate) === null || (item.rate ?? reference.rate) === undefined
      ? null
      : numberValue(item.rate ?? reference.rate),
    percent: (item.percent ?? reference.percent) === null || (item.percent ?? reference.percent) === undefined
      ? null
      : numberValue(item.percent ?? reference.percent),
  }
}

function payment(value: unknown): ToastProjectedPayment {
  const item = record(value)
  const paymentMethod = record(item.paymentMethod ?? item.tenderOption ?? item.paymentOption)
  const refund = record(item.refund)
  const status = nestedText(item.paymentStatus ?? item.status, 'name', 'value')
  const refundAmount = Math.abs(money(refund.refundAmount ?? item.refundAmount))
  const tipRefundAmount = Math.abs(money(refund.tipRefundAmount ?? item.tipRefundAmount))
  const deleted = item.deleted === true
  const voided = item.voided === true
    || deleted
    || item.cancelled === true
    || item.canceled === true
    || /^(voided|cancelled|canceled)$/i.test(status || '')
  return {
    type: nestedText(paymentMethod.name ?? item.type, 'name', 'value') || 'OTHER',
    cardBrand: nestedText(item.cardType, 'name', 'value'),
    status,
    paidAt: instant(item.paidDate ?? item.paymentDate ?? item.paidAt),
    paidBusinessDate: businessDate(item.paidBusinessDate),
    amount: money(item.amount),
    tip: money(item.tipAmount),
    refundAmount,
    tipRefundAmount,
    processingFee: item.originalProcessingFee === null || item.originalProcessingFee === undefined
      ? null
      : Math.abs(money(item.originalProcessingFee)),
    refunded: item.refunded === true || refundAmount > 0 || tipRefundAmount > 0
      || /refund/i.test(status || '') || /refund/i.test(String(item.refundStatus || '')),
    voided,
    deleted,
  }
}

export function isToastProjectedPaymentActive(value: unknown) {
  const entry = record(value)
  const status = nestedText(entry.status ?? entry.paymentStatus, 'name', 'value')
  return entry.voided !== true
    && entry.deleted !== true
    && entry.cancelled !== true
    && entry.canceled !== true
    && !/^(voided|cancelled|canceled)$/i.test(status || '')
}

export function isToastProjectedOrderAccountingActive(value: unknown) {
  const order = record(value)
  if (order.voided === true || order.deleted === true) return false
  const checks = list(record(order.details).checks)
  return checks.length === 0
    || checks.some((value) => {
      const entry = record(value)
      return entry.voided !== true && entry.deleted !== true
    })
}

function check(value: unknown): ToastProjectedCheck {
  const item = record(value)
  const serviceChargeLines = list(item.appliedServiceCharges).map((entry) => namedAmount(entry, ['serviceCharge']))
  return {
    providerGuid: guid(item.guid),
    displayNumber: text(item.displayNumber, 100),
    paymentStatus: nestedText(item.paymentStatus, 'name', 'value'),
    openedAt: instant(item.openedDate ?? item.openedAt),
    closedAt: instant(item.closedDate ?? item.closedAt),
    paidAt: instant(item.paidDate ?? item.paidAt),
    duration: item.duration === null || item.duration === undefined
      ? null
      : Math.max(0, numberValue(item.duration)),
    amount: money(item.amount),
    tax: money(item.taxAmount),
    total: money(item.totalAmount),
    serviceCharges: money(list(item.appliedServiceCharges).reduce((sum, entry) => sum + serviceChargeAmount(entry), 0)),
    voided: item.voided === true,
    deleted: item.deleted === true,
    selections: list(item.selections).map(selection),
    payments: list(item.payments).map(payment),
    discounts: list(item.appliedDiscounts ?? item.discounts).map((entry) => namedAmount(entry, ['discount'])),
    taxes: list(item.appliedTaxes ?? item.taxes).map((entry) => namedAmount(entry, ['taxRate', 'tax'])),
    serviceChargeLines,
  }
}

function sum(values: number[]) {
  return money(values.reduce((total, value) => total + value, 0))
}

function netPaymentAmount(entry: ToastProjectedPayment) {
  const amount = money(entry.amount)
  return amount < 0 ? amount : money(amount - money(entry.refundAmount))
}

function netPaymentTip(entry: ToastProjectedPayment) {
  const tip = money(entry.tip)
  return tip < 0 ? tip : money(tip - money(entry.tipRefundAmount))
}

export function summarizeToastProjectedChecks(checks: ToastProjectedCheck[]) {
  const activeChecks = checks.filter((entry) => !entry.voided && !entry.deleted)
  const selections = activeChecks.flatMap((entry) => entry.selections).filter((entry) => !entry.voided)
  const payments = activeChecks
    .flatMap((entry) => entry.payments)
    .filter(isToastProjectedPaymentActive)
  const salesRefunds = sum(payments.map((entry) => money(entry.refundAmount)))
  const tipRefunds = sum(payments.map((entry) => money(entry.tipRefundAmount)))
  const netSales = money(sum(activeChecks.map((entry) => money(entry.amount))) - salesRefunds)
  const selectionGross = sum(selections.map((entry) => money(entry.gross)))
  const selectionNet = sum(selections.map((entry) => money(entry.net)))
  const discounts = Math.max(0, money(selectionGross - selectionNet))
  const grossSales = selectionGross || money(netSales + discounts)
  const tax = sum(activeChecks.map((entry) => money(entry.tax)))
  const serviceCharges = sum(activeChecks.map((entry) => money(entry.serviceCharges)))
  const tips = sum(payments.map(netPaymentTip))
  const refunds = money(salesRefunds + tipRefunds)
  const tendered = sum(payments.map(netPaymentAmount))
  const checkTotal = sum(activeChecks.map((entry) => money(entry.total)))
  const cardTender = sum(payments.filter((entry) => /credit|debit|card/i.test(entry.type)).map(netPaymentAmount))
  const cashTender = sum(payments.filter((entry) => /cash/i.test(entry.type)).map(netPaymentAmount))
  return {
    activeChecks,
    selections,
    payments,
    grossSales,
    netSales,
    discounts,
    tax,
    serviceCharges,
    tips,
    refunds,
    tendered,
    total: payments.length > 0 ? money(tendered + tips) : checkTotal,
    cashTender,
    cardTender,
    otherTender: money(tendered - cashTender - cardTender),
  }
}

export function projectToastOrder(value: unknown, fallbackId: string): ToastProjectedOrder {
  const item = record(value)
  const serialized = JSON.stringify(value)
  const payloadHash = crypto.createHash('sha256').update(serialized).digest('hex')
  const checks = list(item.checks).map(check)
  const summary = summarizeToastProjectedChecks(checks)
  const { activeChecks, selections } = summary
  const paymentStatuses = [...new Set(activeChecks.map((entry) => entry.paymentStatus).filter(Boolean))]
  const rawGuid = text(item.guid ?? item.externalId ?? item.id, 200)
  return {
    orderGuid: rawGuid || `unidentified-${payloadHash.slice(0, 32)}-${fallbackId.slice(0, 24)}`,
    displayNumber: text(item.displayNumber, 100),
    source: nestedText(item.source, 'name', 'value'),
    diningOption: nestedText(item.diningOption, 'behavior', 'name', 'value'),
    approvalStatus: nestedText(item.approvalStatus, 'name', 'value'),
    paymentStatus: paymentStatuses.join(', ') || null,
    createdAt: instant(item.createdDate ?? item.createdAt),
    modifiedAt: instant(item.modifiedDate ?? item.modifiedAt),
    promisedAt: instant(item.promisedDate ?? item.promisedAt),
    estimatedFulfillmentAt: instant(item.estimatedFulfillmentDate ?? item.estimatedFulfillmentAt),
    openedAt: instant(item.openedDate ?? item.openedAt),
    closedAt: instant(item.closedDate ?? item.closedAt),
    paidAt: instant(item.paidDate ?? item.paidAt),
    guestCount: Math.max(0, Math.round(numberValue(item.numberOfGuests ?? item.guests))),
    checkCount: activeChecks.length,
    itemCount: selections.reduce((total, entry) => total + entry.quantity, 0),
    grossSales: summary.grossSales,
    netSales: summary.netSales,
    discounts: summary.discounts,
    tax: summary.tax,
    serviceCharges: summary.serviceCharges,
    tips: summary.tips,
    refunds: summary.refunds,
    tendered: summary.tendered,
    total: summary.total,
    cashTender: summary.cashTender,
    cardTender: summary.cardTender,
    otherTender: summary.otherTender,
    voided: item.voided === true,
    deleted: item.deleted === true,
    details: { checks },
    payloadHash,
  }
}

export function projectToastOrders(values: unknown[]) {
  const byId = new Map<string, ToastProjectedOrder>()
  values.forEach((value, index) => {
    const order = projectToastOrder(value, String(index))
    byId.set(order.orderGuid, order)
  })
  const orders = [...byId.values()]
  const active = orders.filter(isToastProjectedOrderAccountingActive)
  const voided = orders.filter((order) => !order.deleted && order.voided)
  const totals: ToastProjectedTotals = {
    orderCount: active.length,
    guestCount: active.reduce((sum, order) => sum + order.guestCount, 0),
    checkCount: active.reduce((sum, order) => sum + order.checkCount, 0),
    itemCount: active.reduce((sum, order) => sum + order.itemCount, 0),
    grossSales: sum(active.map((order) => order.grossSales)),
    netSales: sum(active.map((order) => order.netSales)),
    discounts: sum(active.map((order) => order.discounts)),
    tax: sum(active.map((order) => order.tax)),
    serviceCharges: sum(active.map((order) => order.serviceCharges)),
    tips: sum(active.map((order) => order.tips)),
    refunds: sum(active.map((order) => order.refunds)),
    tendered: sum(active.map((order) => order.tendered)),
    total: sum(active.map((order) => order.total)),
    cashTender: sum(active.map((order) => order.cashTender)),
    cardTender: sum(active.map((order) => order.cardTender)),
    otherTender: sum(active.map((order) => order.otherTender)),
    voids: sum(voided.map((order) => order.netSales)),
  }
  return { orders, totals }
}
