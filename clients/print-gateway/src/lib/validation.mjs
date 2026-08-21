import { isIP } from 'node:net'

const PAIRING_GRANT = /^cppair\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i
export const TRUSTED_CLAWPILOT_ORIGINS = Object.freeze([
  'https://aiapp.eigenracing.com',
  'https://dev.aiapp.eigenracing.com',
])

export function normalizeBaseUrl(value, { allowLocalDevelopment = false } = {}) {
  const raw = String(value || '').trim()
  const parsed = new URL(raw)
  const authority = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] || ''
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/'
  ) {
    throw new Error('Select an exact trusted ClawPilot deployment origin')
  }
  const origin = parsed.origin.toLowerCase()
  if (TRUSTED_CLAWPILOT_ORIGINS.includes(origin)) {
    if (/:[0-9]+$/.test(authority)) {
      throw new Error('Trusted ClawPilot deployments do not use an explicit port')
    }
    return origin
  }
  if (
    allowLocalDevelopment
    && parsed.protocol === 'http:'
    && ['127.0.0.1', 'localhost'].includes(parsed.hostname)
  ) return origin
  throw new Error('Select the trusted ClawPilot Production or Development deployment')
}

export function normalizeInstanceName(value) {
  const displayName = String(value || '').trim().replace(/\s+/g, ' ')
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!displayName || displayName.length > 80 || !slug || slug.length > 64) {
    throw new Error('The instance name must contain 1 to 64 letters or numbers')
  }
  return { displayName, slug }
}

export function normalizePrinterHost(value, { allowLocalDevelopment = false } = {}) {
  const host = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(host) !== 4 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    throw new Error('Enter the Zebra printer as a literal private LAN IPv4 address')
  }
  const [first, second] = host.split('.').map(Number)
  const privateAddress = first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
  if (!privateAddress && !(allowLocalDevelopment && first === 127)) {
    throw new Error('The printer IP must use private LAN space (10/8, 172.16/12, 192.168/16, or 169.254/16)')
  }
  return host
}

export function normalizePrinterPort(value) {
  const port = Number(value || 9_100)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('The raw printer port must be an integer from 1 to 65535')
  }
  return port
}

export function assertPairingGrant(value) {
  const grant = String(value || '').trim()
  if (!PAIRING_GRANT.test(grant)) {
    throw new Error('Paste the short-lived cppair.v1 code from ClawPilot')
  }
  return grant
}

export function normalizedPairingInput(input = {}, options) {
  const localNameValue = String(input.instanceName || '').trim()
  const localName = localNameValue ? normalizeInstanceName(localNameValue).displayName : null
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl, options),
    localName,
    printerHost: normalizePrinterHost(input.printerHost, options),
    printerPort: normalizePrinterPort(input.printerPort),
    pairingCode: assertPairingGrant(input.pairingCode),
  }
}
