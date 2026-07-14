const PUBLIC_URL_ERROR = 'SUITECRM_PUBLIC_URL must be an exact pathless HTTPS origin'
const ADMIN_PORTAL_URL_ERROR = 'SUITECRM_ADMIN_PORTAL_URL must be a Railway service variables URL'

export function suiteCrmPublicUrl(value: unknown = process.env.SUITECRM_PUBLIC_URL): string {
  const configured = typeof value === 'string' ? value : ''

  try {
    const parsed = new URL(configured)
    if (parsed.protocol !== 'https:' || configured !== parsed.origin) throw new Error(PUBLIC_URL_ERROR)
    return parsed.origin
  } catch {
    throw new Error(PUBLIC_URL_ERROR)
  }
}

export function suiteCrmAdminUsername(value: unknown = process.env.SUITECRM_ADMIN_USER): string {
  const username = String(value || 'admin').trim()
  if (!/^[A-Za-z0-9._@+-]{1,128}$/.test(username)) {
    throw new Error('SUITECRM_ADMIN_USER is invalid')
  }
  return username
}

export function suiteCrmAdminPortalUrl(value: unknown = process.env.SUITECRM_ADMIN_PORTAL_URL): string | null {
  const configured = String(value || '').trim()
  if (!configured) return null

  try {
    const parsed = new URL(configured)
    if (
      parsed.protocol !== 'https:'
      || parsed.hostname !== 'railway.com'
      || parsed.username
      || parsed.password
      || parsed.hash
      || !/^\/project\/[^/]+\/service\/[^/]+\/variables$/.test(parsed.pathname)
      || !parsed.searchParams.get('environmentId')
    ) {
      throw new Error(ADMIN_PORTAL_URL_ERROR)
    }
    return parsed.toString()
  } catch {
    throw new Error(ADMIN_PORTAL_URL_ERROR)
  }
}
