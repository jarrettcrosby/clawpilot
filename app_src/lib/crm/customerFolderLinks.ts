/** These exact, column-zero labels reserve a whole description line. This is
 * intentionally not a Markdown parser, Drive verifier or folder provisioner. */
export const CUSTOMER_FOLDER_LINK_LABELS = {
  bpoDriveUrl: 'BPO Supply Chain Drive',
  fractionalCustomerFolderUrl: 'Fractional Customer Folder',
} as const

export type CustomerFolderLinkKey = keyof typeof CUSTOMER_FOLDER_LINK_LABELS
export type CustomerFolderLinks = { bpoDriveUrl: string; fractionalCustomerFolderUrl: string }
export type ParsedCustomerFolderLinks = {
  values: CustomerFolderLinks
  duplicateLabels: CustomerFolderLinkKey[]
  hasDuplicates: boolean
  invalidLabels: CustomerFolderLinkKey[]
}
export type CustomerFolderDescriptionSegment =
  | { type: 'text'; text: string }
  | { type: 'folder-link'; key: CustomerFolderLinkKey; label: string; url: string; text: string; lineEnding: string }

export class CustomerFolderLinkError extends Error {
  constructor(message: string) { super(message); this.name = 'CustomerFolderLinkError' }
}

const KEYS = Object.keys(CUSTOMER_FOLDER_LINK_LABELS) as CustomerFolderLinkKey[]
const UNSAFE_CHARACTERS = /[\s\u0000-\u001f\u007f-\u009f]/u
const MAX_URL_LENGTH = 2048
const MAX_DESCRIPTION_LENGTH = 10_000

function folderUrl(value: unknown): string {
  if (typeof value !== 'string') throw new CustomerFolderLinkError('Folder links must be URL strings')
  if (value === '') return ''
  // Validate the original string, not a trimmed or WHATWG-repaired URL. Keep
  // the accepted spelling unchanged so existing customer shortlinks roundtrip.
  if (value.length > MAX_URL_LENGTH || !value.startsWith('https://')
    || UNSAFE_CHARACTERS.test(value) || value.includes('\\') || /%(?![a-f0-9]{2})/iu.test(value)) {
    throw new CustomerFolderLinkError('Folder links must be absolute HTTPS URLs without whitespace or controls, at most 2,048 characters')
  }
  const authority = value.slice('https://'.length).split(/[/?#]/u, 1)[0]
  if (!authority || authority.includes('@')) throw new CustomerFolderLinkError('Folder links cannot contain credentials')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new CustomerFolderLinkError('Folder links must be valid absolute HTTPS URLs') }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new CustomerFolderLinkError('Folder links must be absolute HTTPS URLs without credentials')
  }
  // Decode for validation only. Repeated encoding cannot conceal line/control
  // injection; valid UTF-8 continuation bytes are not themselves C1 controls.
  let inspected = value
  while (/%[a-f0-9]{2}/iu.test(inspected)) {
    let decoded: string
    try {
      // Decode escape runs only: a decoded literal '%' elsewhere must not make
      // a harmless remaining nested escape look like malformed input.
      decoded = inspected.replace(/(?:%[a-f0-9]{2})+/giu, sequence => decodeURIComponent(sequence))
    } catch { throw new CustomerFolderLinkError('Folder links contain invalid URL encoding') }
    if (UNSAFE_CHARACTERS.test(decoded)) throw new CustomerFolderLinkError('Folder links cannot contain encoded whitespace or controls')
    if (decoded === inspected) break
    inspected = decoded
  }
  return value
}

/** Validation deliberately does not trim, canonicalize or fetch either URL. */
export function normalizeCustomerFolderLinks(values: CustomerFolderLinks): CustomerFolderLinks {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new CustomerFolderLinkError('Both customer folder link values are required')
  return { bpoDriveUrl: folderUrl(values.bpoDriveUrl), fractionalCustomerFolderUrl: folderUrl(values.fractionalCustomerFolderUrl) }
}

type DescriptionLine = { content: string; ending: string; key?: CustomerFolderLinkKey; url?: string; invalid?: boolean }
function descriptionLines(description: string): DescriptionLine[] {
  if (typeof description !== 'string') throw new CustomerFolderLinkError('CRM description must be text')
  const result: DescriptionLine[] = []
  const expression = /([^\r\n]*)(\r\n|\r|\n|$)/gu
  for (const match of description.matchAll(expression)) {
    if (!match[0]) continue
    const line: DescriptionLine = { content: match[1], ending: match[2] }
    line.key = KEYS.find(key => line.content.startsWith(`${CUSTOMER_FOLDER_LINK_LABELS[key]}:`))
    if (line.key) {
      const prefix = `${CUSTOMER_FOLDER_LINK_LABELS[line.key]}: `
      try {
        if (!line.content.startsWith(prefix)) throw new CustomerFolderLinkError('Folder line spacing is invalid')
        const url = folderUrl(line.content.slice(prefix.length))
        if (!url) throw new CustomerFolderLinkError('Empty named folder lines are invalid')
        line.url = url
      } catch { line.invalid = true }
    }
    result.push(line)
  }
  return result
}

export function parseCustomerFolderLinks(description: string): ParsedCustomerFolderLinks {
  const values: CustomerFolderLinks = { bpoDriveUrl: '', fractionalCustomerFolderUrl: '' }
  const counts = { bpoDriveUrl: 0, fractionalCustomerFolderUrl: 0 }
  const invalid = new Set<CustomerFolderLinkKey>()
  for (const line of descriptionLines(description)) {
    if (!line.key) continue
    counts[line.key]++
    if (line.invalid) invalid.add(line.key)
    else if (counts[line.key] === 1) values[line.key] = line.url!
  }
  const duplicateLabels = KEYS.filter(key => counts[key] > 1)
  return { values, duplicateLabels, hasDuplicates: duplicateLabels.length > 0, invalidLabels: KEYS.filter(key => invalid.has(key)) }
}

/** Replace/remove existing managed lines in place; append only missing values.
 * All other text, including its whitespace and line endings, is retained. */
export function updateCustomerFolderLinks(description: string, input: CustomerFolderLinks): string {
  const values = normalizeCustomerFolderLinks(input)
  const parsed = parseCustomerFolderLinks(description)
  if (parsed.hasDuplicates) throw new CustomerFolderLinkError('Duplicate customer folder labels must be fixed in the description before saving links')
  if (parsed.invalidLabels.length) throw new CustomerFolderLinkError('Malformed customer folder lines must be fixed in the description before saving links')
  const lines = descriptionLines(description)
  const present = new Set<CustomerFolderLinkKey>()
  let result = lines.map(line => {
    if (!line.key) return `${line.content}${line.ending}`
    present.add(line.key)
    return values[line.key] ? `${CUSTOMER_FOLDER_LINK_LABELS[line.key]}: ${values[line.key]}${line.ending}` : ''
  }).join('')
  const additions = KEYS.filter(key => !present.has(key) && values[key])
  if (additions.length) {
    const ending = lines.find(line => line.ending)?.ending || '\n'
    if (result && !/[\r\n]$/u.test(result)) result += ending
    result += additions.map(key => `${CUSTOMER_FOLDER_LINK_LABELS[key]}: ${values[key]}`).join(ending)
  }
  if (result.length > MAX_DESCRIPTION_LENGTH) throw new CustomerFolderLinkError('CRM description with folder links must be 10,000 characters or fewer')
  return result
}

/** Only a complete, valid reserved folder line can become an anchor. Malformed
 * lines and every other note remain text, never HTML or arbitrary Markdown. */
export function segmentCustomerFolderDescription(description: string): CustomerFolderDescriptionSegment[] {
  const result: CustomerFolderDescriptionSegment[] = []
  for (const line of descriptionLines(description)) {
    const text = `${line.content}${line.ending}`
    if (line.key && line.url && !line.invalid) {
      result.push({ type: 'folder-link', key: line.key, label: CUSTOMER_FOLDER_LINK_LABELS[line.key], url: line.url, text, lineEnding: line.ending })
    } else {
      const previous = result.at(-1)
      if (previous?.type === 'text') previous.text += text
      else result.push({ type: 'text', text })
    }
  }
  return result
}
