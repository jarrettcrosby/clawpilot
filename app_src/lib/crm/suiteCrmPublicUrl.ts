const PUBLIC_URL_ERROR = 'SUITECRM_PUBLIC_URL must be an exact pathless HTTPS origin'

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
