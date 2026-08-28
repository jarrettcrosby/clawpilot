function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function sanitizeNumericDraft(value) {
  const source = String(value ?? '')
  let draft = ''
  let hasDecimal = false

  for (const character of source) {
    if (character >= '0' && character <= '9') {
      draft += character
      continue
    }
    if (character === '.' && !hasDecimal) {
      draft += character
      hasDecimal = true
      continue
    }
    if (character === '-' && draft === '') {
      draft = '-'
    }
  }

  return draft
}

export function numericDraftFromValue(value) {
  return String(finiteNumber(value, 0))
}

export function commitNumericDraft(value, options = {}) {
  const minimum = finiteNumber(options.minimum, Number.NEGATIVE_INFINITY)
  const maximum = finiteNumber(options.maximum, Number.POSITIVE_INFINITY)
  const lower = Math.min(minimum, maximum)
  const upper = Math.max(minimum, maximum)
  const fallback = Math.min(upper, Math.max(lower, finiteNumber(options.fallback, 0)))
  const draft = sanitizeNumericDraft(value).trim()
  const parsed = draft === '' || draft === '-' || draft === '.' || draft === '-.'
    ? fallback
    : finiteNumber(draft, fallback)
  const committed = Math.min(upper, Math.max(lower, parsed))

  return {
    value: committed,
    draft: numericDraftFromValue(committed),
  }
}
