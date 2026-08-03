export const LEGACY_GLOBAL_ID_SUFFIX_SOURCE = '[0-9]{7}'
export const BASE32HEX_GLOBAL_ID_SUFFIX_SOURCE = '[0-9a-v]{12}'
export const GLOBAL_ID_SUFFIX_SOURCE = `(?:${LEGACY_GLOBAL_ID_SUFFIX_SOURCE}|${BASE32HEX_GLOBAL_ID_SUFFIX_SOURCE})`
export const GLOBAL_ID_MAX_LENGTH = 17

const GLOBAL_ID_PREFIX_PATTERN = /^g[a-z]{1,4}$/

function normalizePrefixes(prefixes) {
  const values = Array.isArray(prefixes) ? prefixes : [prefixes]
  if (values.length === 0) throw new TypeError('At least one Global ID prefix is required')

  return [...new Set(values.map((value) => {
    const prefix = String(value || '')
    if (!GLOBAL_ID_PREFIX_PATTERN.test(prefix)) {
      throw new TypeError(`Invalid Global ID prefix: ${prefix || '(empty)'}`)
    }
    return prefix
  }))]
}

/**
 * Returns an unanchored fragment for one or more exact Global ID prefixes.
 * The prefix arguments are validated before they are included in the pattern.
 *
 * @param {string | string[]} prefixes
 */
export function globalIdFragment(prefixes) {
  const values = normalizePrefixes(prefixes)
  const prefixSource = values.length === 1 ? values[0] : `(?:${values.join('|')})`
  return `${prefixSource}${GLOBAL_ID_SUFFIX_SOURCE}`
}

/**
 * Builds an anchored validator for one or more exact Global ID prefixes.
 *
 * @param {string | string[]} prefixes
 * @param {string} [flags]
 */
export function globalIdPattern(prefixes, flags = '') {
  return new RegExp(`^${globalIdFragment(prefixes)}$`, flags)
}

/**
 * @param {unknown} value
 * @param {string | string[]} prefixes
 */
export function isGlobalId(value, prefixes) {
  return typeof value === 'string' && globalIdPattern(prefixes).test(value)
}

/**
 * Normalizes case and surrounding whitespace at an external boundary, then
 * requires the result to use one of the exact expected prefixes.
 *
 * @param {unknown} value
 * @param {string | string[]} prefixes
 */
export function normalizeGlobalId(value, prefixes) {
  const normalized = String(value || '').trim().toLowerCase()
  return isGlobalId(normalized, prefixes) ? normalized : null
}
