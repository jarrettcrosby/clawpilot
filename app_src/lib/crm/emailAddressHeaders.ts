type Mailbox = { address: string; displayName?: string }
type HeaderName = 'from' | 'to' | 'cc' | 'bcc'
export type EmailAddressHeaders = { version: 1 } & Partial<Record<HeaderName, Mailbox[]>>

const HEADER_NAMES = ['from', 'to', 'cc', 'bcc'] as const
const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const MAX_HEADER_LENGTH = 8_000
const MAX_ADDRESSES = 50

function address(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value)
    ? value.toLowerCase() : null
}

function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  // SuiteCRM Email::cleanEmails splits even quoted commas/semicolons. Preserve
  // supported names, but use the proven address alone for unsupported names.
  return name && name.length <= 255 && !/[<>;,\u0000-\u001f\u007f-\u009f]/.test(name)
    ? name : undefined
}

function parseHeader(value: string): Mailbox[] | null {
  if (value.length > MAX_HEADER_LENGTH) return null
  const unfolded = value.replace(/\r\n[ \t]+/g, ' ').replace(/\t/g, ' ')
  if (/[\u0000-\u001f\u007f-\u009f]/.test(unfolded)) return null
  const parts: string[] = []
  let quoted = false, escaped = false, angle = false, start = 0
  for (let index = 0; index < unfolded.length; index += 1) {
    const char = unfolded[index]
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (char === '<') { if (angle) return null; angle = true }
    if (char === '>') { if (!angle) return null; angle = false }
    // RFC group syntax is not flattened into invented recipient categories.
    if (char === ';' || (char === ':' && !angle)) return null
    if (char === ',' && !angle) { parts.push(unfolded.slice(start, index)); start = index + 1 }
  }
  if (quoted || escaped || angle) return null
  parts.push(unfolded.slice(start))
  if (parts.length > MAX_ADDRESSES) return null
  const result: Mailbox[] = []
  for (const part of parts) {
    const item = part.trim()
    const named = item.match(/^([^<>]*)<([^<>]+)>$/)
    const email = address((named?.[2] || item).trim())
    if (!email) return null
    const rawName = named?.[1].trim() || ''
    const name = displayName(rawName.startsWith('"') && rawName.endsWith('"')
      ? rawName.slice(1, -1).replace(/\\([\\"])/g, '$1') : rawName)
    if (!result.some(mailbox => mailbox.address === email)) {
      result.push({ address: email, ...(name ? { displayName: name } : {}) })
    }
  }
  return result
}

/** Capture only actual top-level headers, never Delivered-To/Reply-To or body text. */
export function captureEmailAddressHeaders(
  headers: readonly { name?: string; value?: string }[] | undefined,
): EmailAddressHeaders {
  const result: EmailAddressHeaders = { version: 1 }
  for (const name of HEADER_NAMES) {
    const matches = (Array.isArray(headers) ? headers : []).filter(header => (
      header && typeof header.name === 'string' && header.name.toLowerCase() === name
    ))
    if (matches.length !== 1 || typeof matches[0].value !== 'string') continue
    const mailboxes = parseHeader(matches[0].value)
    if (mailboxes?.length && (name !== 'from' || mailboxes.length === 1)) result[name] = mailboxes
  }
  return result
}

/** Positive-only native Email fields; absence must not clear an existing projection. */
export function suiteCrmEmailAddressAttributes(evidence: unknown): Record<string, string> {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return {}
  const stored = evidence as Record<string, unknown>
  if (stored.version !== 1) return {}
  const result: Record<string, string> = {}
  for (const name of HEADER_NAMES) {
    const entries = stored[name]
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ADDRESSES
      || (name === 'from' && entries.length !== 1)) continue
    const values: string[] = [], seen = new Set<string>()
    let valid = true
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { valid = false; break }
      const email = address(entry.address)
      if (!email) { valid = false; break }
      if (seen.has(email)) continue
      seen.add(email)
      const label = displayName(entry.displayName)
      values.push(label ? `${label} <${email}>` : email)
    }
    const value = values.join(', ')
    if (valid && value && value.length <= MAX_HEADER_LENGTH) {
      result[name === 'from' ? 'from_addr_name' : `${name}_addrs_names`] = value
    }
  }
  return result
}
