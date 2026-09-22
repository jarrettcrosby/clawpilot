/** @param {unknown} value */
function exactHttpsOrigin(value) {
  const candidate = String(value || '').trim()
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(url.hostname)
      || url.hostname.includes('..')
      || url.pathname !== '/'
      || url.search
      || url.hash
      || candidate !== url.origin
    ) return null
    return url.origin
  } catch {
    return null
  }
}

/** @param {unknown} value
 * @returns {readonly string[]}
 */
export function additionalPublicOrigins(value) {
  if (value === undefined || value === null || value === '') return []
  let parsed
  try {
    parsed = JSON.parse(String(value))
  } catch {
    throw new Error('CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON must be a JSON array of exact HTTPS origins')
  }
  if (!Array.isArray(parsed) || parsed.length > 4) {
    throw new Error('CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON must contain at most four exact HTTPS origins')
  }
  const origins = parsed.map(exactHttpsOrigin)
  if (origins.some((origin) => !origin) || new Set(origins).size !== origins.length) {
    throw new Error('CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON contains an invalid or duplicate origin')
  }
  return origins
}

/** @param {{ get(name: string): string | null }} headers */
function forwardedOrigin(headers) {
  const host = String(headers.get('x-forwarded-host') || '').trim()
  const protocol = String(headers.get('x-forwarded-proto') || '').trim().toLowerCase()
  if (
    !host
    || protocol !== 'https'
    || /[,/\\@?#\s]/.test(host)
  ) return null
  try {
    const url = new URL(`https://${host}`)
    return url.host === host.toLowerCase() ? url.origin : null
  } catch {
    return null
  }
}

/** @param {{ canonicalOrigin: string, additionalOrigins: readonly string[], requestUrl: string, headers: { get(name: string): string | null } }} input */
export function browserReturnOrigin(input) {
  const allowed = new Set([input.canonicalOrigin, ...input.additionalOrigins])
  try {
    const direct = new URL(input.requestUrl).origin
    if (allowed.has(direct)) return direct
  } catch {
    // A malformed routed URL cannot supply a redirect destination.
  }
  const forwarded = forwardedOrigin(input.headers)
  return forwarded && allowed.has(forwarded) ? forwarded : input.canonicalOrigin
}
