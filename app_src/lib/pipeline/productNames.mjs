/**
 * Legacy pipeline Sheets store a multi-select product array as one comma-separated
 * cell. Normalize that transport shape before creating durable CRM products.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitPipelineProductNames(value) {
  const values = Array.isArray(value) ? value : [value]
  const names = []
  const seen = new Set()
  for (const entry of values) {
    for (const part of String(entry || '').split(',')) {
      const name = part.replace(/\s+/g, ' ').trim()
      const normalized = name.toLowerCase()
      if (!name || name.length > 250 || seen.has(normalized)) continue
      seen.add(normalized)
      names.push(name)
    }
  }
  return names
}
