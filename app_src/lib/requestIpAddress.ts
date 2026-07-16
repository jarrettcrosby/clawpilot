import { isIP } from 'node:net'

const FORWARDED_ADDRESS_HEADERS = [
  'x-vercel-forwarded-for',
  'x-forwarded-for',
  'x-real-ip',
] as const

export function normalizeIpAddress(value: unknown): string | null {
  let candidate = String(value || '').trim()
  if (!candidate) return null

  if (candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1).trim()
  }
  if (candidate.startsWith('[')) {
    const closingBracket = candidate.indexOf(']')
    if (closingBracket < 0) return null
    const suffix = candidate.slice(closingBracket + 1)
    if (suffix && !/^:\d+$/.test(suffix)) return null
    candidate = candidate.slice(1, closingBracket)
  } else {
    const ipv4WithPort = candidate.match(/^((?:\d{1,3}\.){3}\d{1,3}):\d+$/)
    if (ipv4WithPort) candidate = ipv4WithPort[1]
  }

  // Zone identifiers are local-interface details and are not valid durable client addresses.
  if (candidate.includes('%')) return null
  return isIP(candidate) ? candidate : null
}

export function observedRequestIpAddress(headers: Headers): string | null {
  for (const header of FORWARDED_ADDRESS_HEADERS) {
    const raw = headers.get(header)
    if (!raw) continue
    for (const value of raw.split(',')) {
      const normalized = normalizeIpAddress(value)
      if (normalized) return normalized
    }
  }
  return null
}
