import { createHash } from 'node:crypto'

export const GL_CODING_RULE_OPERATORS = [
  'equals',
  'not_equals',
  'in',
  'contains',
  'starts_with',
  'exists',
] as const

export type GlCodingRuleOperator = typeof GL_CODING_RULE_OPERATORS[number]

export type GlCodingRuleClause = {
  field: string
  operator: GlCodingRuleOperator
  value?: unknown
}

export type GlCodingRuleConditions = {
  clauses: GlCodingRuleClause[]
}

export type GlCodingChargeFacts = {
  provider: string
  environment: 'sandbox' | 'production'
  billedAccountFingerprint: string
  trackingNumber: string | null
  providerLabelId: string | null
  packageReference: string | null
  serviceCode: string | null
  chargeCategory: string
  description: string | null
  amountMinor: string
  currency: string
  shipmentDate: string | null
  senderAddressFingerprint: string | null
  recipientAddressFingerprint: string | null
  routingAttributes: Record<string, unknown>
}

export type GlCodingRuleSnapshot = {
  id: string
  globalId: string
  name: string
  priority: number
  matchMode: 'all' | 'any'
  conditions: GlCodingRuleConditions
  outputs: Record<string, unknown>
  targetShipperPartyId: string
  targetShipperPartyGlobalId: string
  targetShipperName: string
  versionNumber: number
}

export type GlCodingRuleEvaluation = {
  matched: boolean
  clauseResults: Array<{
    field: string
    operator: GlCodingRuleOperator
    matched: boolean
  }>
}

const BASE_FIELDS = new Set([
  'provider',
  'environment',
  'billedAccountFingerprint',
  'trackingNumber',
  'providerLabelId',
  'packageReference',
  'serviceCode',
  'chargeCategory',
  'description',
  'amountMinor',
  'currency',
  'shipmentDate',
  'senderAddressFingerprint',
  'recipientAddressFingerprint',
])

function normalizedString(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function comparableValues(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' || typeof right === 'number') {
    return typeof left === 'number'
      && typeof right === 'number'
      && Number.isFinite(left)
      && Number.isFinite(right)
      && left === right
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return typeof left === 'boolean'
      && typeof right === 'boolean'
      && left === right
  }
  return normalizedString(left) === normalizedString(right)
}

function comparableMinorUnits(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): bigint | null => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return BigInt(value)
    }
    if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
      return null
    }
    try {
      return BigInt(value.trim())
    } catch {
      return null
    }
  }
  const leftMinor = normalize(left)
  const rightMinor = normalize(right)
  return leftMinor !== null && rightMinor !== null && leftMinor === rightMinor
}

function isRuleScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value))
}

function fieldValue(facts: GlCodingChargeFacts, field: string): unknown {
  if (BASE_FIELDS.has(field)) {
    return facts[field as keyof Omit<GlCodingChargeFacts, 'routingAttributes'>]
  }
  if (!field.startsWith('routingAttributes.')) return undefined
  const key = field.slice('routingAttributes.'.length)
  if (!key || key.includes('.') || !Object.prototype.hasOwnProperty.call(facts.routingAttributes, key)) {
    return undefined
  }
  return facts.routingAttributes[key]
}

function evaluateClause(
  facts: GlCodingChargeFacts,
  clause: GlCodingRuleClause,
): boolean {
  const actual = fieldValue(facts, clause.field)
  if (clause.operator === 'exists') {
    const exists = actual !== undefined && actual !== null && String(actual).trim() !== ''
    return clause.value === false ? !exists : exists
  }
  if (actual === undefined || actual === null) return false
  const valuesEqual = (expected: unknown) => (
    clause.field === 'amountMinor'
      ? comparableMinorUnits(actual, expected)
      : comparableValues(actual, expected)
  )
  if (clause.operator === 'equals') return valuesEqual(clause.value)
  if (clause.operator === 'not_equals') return !valuesEqual(clause.value)
  if (clause.operator === 'in') {
    return Array.isArray(clause.value)
      && clause.value.some((candidate) => valuesEqual(candidate))
  }
  const actualText = normalizedString(actual)
  const expectedText = normalizedString(clause.value)
  if (!expectedText) return false
  if (clause.operator === 'contains') return actualText.includes(expectedText)
  if (clause.operator === 'starts_with') return actualText.startsWith(expectedText)
  return false
}

export function isGlCodingRuleOperator(value: unknown): value is GlCodingRuleOperator {
  return GL_CODING_RULE_OPERATORS.includes(value as GlCodingRuleOperator)
}

export function isGlCodingRuleField(field: string): boolean {
  return BASE_FIELDS.has(field)
    || /^routingAttributes\.[A-Za-z0-9_-]{1,80}$/.test(field)
}

export function validateGlCodingConditions(value: unknown): GlCodingRuleConditions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => key !== 'clauses') || !Array.isArray(input.clauses)) {
    throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
  }
  if (input.clauses.length < 1 || input.clauses.length > 25) {
    throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
  }
  const clauses = input.clauses.map((rawClause) => {
    if (!rawClause || typeof rawClause !== 'object' || Array.isArray(rawClause)) {
      throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
    }
    const clause = rawClause as Record<string, unknown>
    if (Object.keys(clause).some((key) => !['field', 'operator', 'value'].includes(key))) {
      throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
    }
    const field = String(clause.field || '').trim()
    const operator = clause.operator
    if (!isGlCodingRuleField(field) || !isGlCodingRuleOperator(operator)) {
      throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
    }
    if (operator !== 'exists' && clause.value === undefined) {
      throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
    }
    if (operator === 'exists' && clause.value !== undefined && typeof clause.value !== 'boolean') {
      throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
    }
    if (
      operator === 'in'
      && (
        !Array.isArray(clause.value)
        || clause.value.length < 1
        || clause.value.length > 50
        || clause.value.some((entry) => !isRuleScalar(entry))
      )
    ) {
      throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
    }
    if (operator !== 'in' && operator !== 'exists' && !isRuleScalar(clause.value)) {
      throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
    }
    if (typeof clause.value === 'string' && clause.value.length > 500) {
      throw new Error('GL_CODING_RULE_CONDITIONS_INVALID')
    }
    return {
      field,
      operator,
      ...(clause.value === undefined ? {} : { value: clause.value }),
    } satisfies GlCodingRuleClause
  })
  return { clauses }
}

export function evaluateGlCodingRule(
  rule: Pick<GlCodingRuleSnapshot, 'matchMode' | 'conditions'>,
  facts: GlCodingChargeFacts,
): GlCodingRuleEvaluation {
  const clauseResults = rule.conditions.clauses.map((clause) => ({
    field: clause.field,
    operator: clause.operator,
    matched: evaluateClause(facts, clause),
  }))
  return {
    matched: rule.matchMode === 'all'
      ? clauseResults.every((result) => result.matched)
      : clauseResults.some((result) => result.matched),
    clauseResults,
  }
}

export function selectGlCodingRule(
  rules: GlCodingRuleSnapshot[],
  facts: GlCodingChargeFacts,
): {
  rule: GlCodingRuleSnapshot | null
  evaluation: GlCodingRuleEvaluation | null
} {
  const sorted = [...rules].sort((left, right) => (
    left.priority - right.priority
    || left.name.localeCompare(right.name)
    || right.versionNumber - left.versionNumber
  ))
  for (const rule of sorted) {
    const evaluation = evaluateGlCodingRule(rule, facts)
    if (evaluation.matched) return { rule, evaluation }
  }
  return { rule: null, evaluation: null }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    )
  }
  return value
}

export function glCodingChecksum(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex')
}

export function normalizeCarrierTrackingNumber(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}
