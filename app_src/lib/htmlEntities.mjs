const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '...',
  lt: '<',
  mdash: '-',
  nbsp: ' ',
  ndash: '-',
  quot: '"',
}

function decodeOnce(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi, (encoded, entity) => {
    const normalized = String(entity).toLowerCase()
    if (normalized.startsWith('#')) {
      const radix = normalized.startsWith('#x') ? 16 : 10
      const digits = normalized.slice(radix === 16 ? 2 : 1)
      const codePoint = Number.parseInt(digits, radix)
      if (
        !Number.isFinite(codePoint)
        || codePoint <= 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) return '\uFFFD'
      return String.fromCodePoint(codePoint)
    }
    return NAMED_ENTITIES[normalized] ?? encoded
  })
}

/**
 * Decode bounded HTML entity layers from external text APIs.
 * SuiteCRM can return encoded JSON attribute values, including double-encoded values.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function decodeHtmlEntities(value) {
  let decoded = String(value ?? '')
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodeOnce(decoded)
    if (next === decoded) break
    decoded = next
  }
  return decoded
}
