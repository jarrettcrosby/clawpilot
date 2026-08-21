export const ORDER_SHIP_TO_FIELDS = [
  'name',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'country',
] as const

export type OrderShipToField = typeof ORDER_SHIP_TO_FIELDS[number]

export type OrderShipToDraft = Readonly<{
  name: string | null
  line1: string | null
  line2: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
}>

export type OrderShipToPatch = Partial<
  Record<OrderShipToField, string | null>
>

export type OrderShipToReadiness =
  | 'missing'
  | 'incomplete'
  | 'carrier_ready'

export type OrderShipToIssue = Readonly<{
  field: Exclude<OrderShipToField, 'line2'>
  code: 'required' | 'invalid_format'
}>

const REQUIRED_FIELDS: ReadonlyArray<Exclude<OrderShipToField, 'line2'>> = [
  'name',
  'line1',
  'city',
  'region',
  'postalCode',
  'country',
]

function normalizedText(value: unknown) {
  if (typeof value !== 'string') return null
  return value.trim() || null
}

export function normalizeOrderShipToDraft(
  value: (
    Partial<Record<OrderShipToField, unknown>>
    & { contactName?: unknown; countryCode?: unknown }
  ) | null | undefined,
): OrderShipToDraft {
  return {
    name: normalizedText(value?.name) || normalizedText(value?.contactName),
    line1: normalizedText(value?.line1),
    line2: normalizedText(value?.line2),
    city: normalizedText(value?.city),
    region: normalizedText(value?.region),
    postalCode: normalizedText(value?.postalCode),
    country: (
      normalizedText(value?.country)
      || normalizedText(value?.countryCode)
    )?.toUpperCase() || null,
  }
}

export function mergeOrderShipToDraft(
  current: OrderShipToDraft,
  patch: OrderShipToPatch,
): OrderShipToDraft {
  const merged: Partial<Record<OrderShipToField, unknown>> = { ...current }
  for (const field of ORDER_SHIP_TO_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      merged[field] = patch[field]
    }
  }
  return normalizeOrderShipToDraft(merged)
}

export function orderShipToIssues(
  value: OrderShipToDraft,
): OrderShipToIssue[] {
  const issues: OrderShipToIssue[] = []
  for (const field of REQUIRED_FIELDS) {
    if (!value[field]) issues.push({ field, code: 'required' })
  }
  if (value.country && !/^[A-Z]{2}$/u.test(value.country)) {
    const requiredCountry = issues.findIndex((issue) => (
      issue.field === 'country' && issue.code === 'required'
    ))
    if (requiredCountry >= 0) issues.splice(requiredCountry, 1)
    issues.push({ field: 'country', code: 'invalid_format' })
  }
  return issues
}

export function orderShipToReadiness(
  value: OrderShipToDraft,
): OrderShipToReadiness {
  if (ORDER_SHIP_TO_FIELDS.every((field) => !value[field])) return 'missing'
  return orderShipToIssues(value).length === 0
    ? 'carrier_ready'
    : 'incomplete'
}

export function orderShipToStorageValue(
  value: OrderShipToDraft,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const field of ORDER_SHIP_TO_FIELDS) {
    if (value[field]) result[field] = value[field]
  }
  return result
}

export function changedOrderShipToFields(
  before: OrderShipToDraft,
  after: OrderShipToDraft,
): OrderShipToField[] {
  return ORDER_SHIP_TO_FIELDS.filter((field) => before[field] !== after[field])
}
