type HeaderReader = Pick<Headers, 'get'>

function normalizeOrigin(value: unknown): string | null {
  const candidate = String(value || '').trim()
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

function singleHeaderValue(value: string | null): string | null {
  const candidate = String(value || '').trim()
  if (!candidate || candidate.includes(',')) return null
  return candidate
}

function routedOrigin(headers: HeaderReader): string | null {
  const rawForwardedHost = String(
    headers.get('x-forwarded-host') || '',
  ).trim()
  if (rawForwardedHost.includes(',')) return null
  const host = rawForwardedHost || singleHeaderValue(headers.get('host'))
  if (!host) return null
  if (/[/\\@?#\s]/.test(host)) return null
  const forwardedProtocol = singleHeaderValue(
    headers.get('x-forwarded-proto'),
  )?.toLowerCase()
  if (
    forwardedProtocol !== 'http'
    && forwardedProtocol !== 'https'
  ) return null
  const normalized = normalizeOrigin(`${forwardedProtocol}://${host}`)
  if (!normalized) return null
  const normalizedUrl = new URL(normalized)
  return normalizedUrl.host === host.toLowerCase() ? normalized : null
}

export function isBrowserSameOriginRequest(input: {
  headers: HeaderReader
  requestOrigin: string
  trustedOrigins?: Array<string | null | undefined>
}): boolean {
  if (input.headers.get('sec-fetch-site') === 'cross-site') return false
  const suppliedOrigin = normalizeOrigin(input.headers.get('origin'))
  if (!suppliedOrigin) return false

  const allowed = new Set<string>()
  for (const candidate of [
    input.requestOrigin,
    routedOrigin(input.headers),
    ...(input.trustedOrigins || []),
  ]) {
    const normalized = normalizeOrigin(candidate)
    if (normalized) allowed.add(normalized)
  }
  return allowed.has(suppliedOrigin)
}
