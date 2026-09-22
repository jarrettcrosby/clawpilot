import { isHostedRuntime } from '@/lib/persistence/config'
import { additionalPublicOrigins, browserReturnOrigin } from '@/lib/publicOriginRouting.mjs'

export function appPublicUrl(): string {
  const configured = String(process.env.CLAWPILOT_PUBLIC_URL || '').trim()
  if (!configured && isHostedRuntime()) throw new Error('CLAWPILOT_PUBLIC_URL is required in hosted environments')
  const url = new URL(configured || 'http://localhost:4002')
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('CLAWPILOT_PUBLIC_URL must use HTTPS')
  }
  return url.origin
}

/** Preserve an explicitly configured browser host for local navigation only.
 * Provider callbacks, webhooks, and server-originated email links continue to
 * use appPublicUrl() until each provider is registered and session-fenced there.
 */
export function appBrowserReturnUrl(request: {
  url: string
  headers: Pick<Headers, 'get'>
}): string {
  return browserReturnOrigin({
    canonicalOrigin: appPublicUrl(),
    additionalOrigins: additionalPublicOrigins(process.env.CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON),
    requestUrl: request.url,
    headers: request.headers,
  })
}
