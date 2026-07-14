import fs from 'fs'
import {
  normalizeMatonGatewayApp,
  resolveConfiguredOwnerMatonGatewayCredential,
  resolveUserMatonGatewayCredential,
  type MatonGatewayCredential,
} from '@/lib/integrations/matonGatewayCredentials'

const DEFAULT_BASE = 'https://gateway.maton.ai'
const REQUEST_TIMEOUT_MS = 15_000

export type MatonFetchContext = {
  ownerEmail: string
  app?: string
  boundConnectionId?: string
}

function cleanHeaderCredential(value: unknown, label: string, maxLength: number): string {
  const credential = typeof value === 'string' ? value.trim() : ''
  if (!credential || credential.length > maxLength || !/^[\x21-\x7e]+$/.test(credential)) {
    throw new Error(`${label} is not configured safely`)
  }
  return credential
}

function readKey(): string {
  const fromEnv = process.env.MATON_API_KEY?.trim()
  if (fromEnv) return cleanHeaderCredential(fromEnv, 'MATON_API_KEY', 4096)

  const configuredPath = process.env.MATON_API_KEY_FILE?.trim()
  if (configuredPath && fs.existsSync(configuredPath)) {
    const key = fs.readFileSync(configuredPath, 'utf8').trim()
    if (key) return cleanHeaderCredential(key, 'MATON_API_KEY_FILE', 4096)
  }

  throw new Error('MATON_API_KEY not configured')
}

function readGmailConnectionId(): string {
  return cleanHeaderCredential(
    process.env.MATON_GMAIL_CONNECTION_ID,
    'MATON_GMAIL_CONNECTION_ID',
    512,
  )
}

export function resolveMatonGatewayBaseUrl(value = process.env.MATON_BASE_URL): string {
  const configured = String(value || DEFAULT_BASE).trim()
  try {
    const url = new URL(configured)
    const allowedHost = url.hostname === 'gateway.maton.ai' || url.hostname.endsWith('.gateway.maton.ai')
    if (
      url.protocol !== 'https:'
      || !allowedHost
      || url.port
      || url.username
      || url.password
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash
    ) {
      throw new Error('invalid gateway origin')
    }
    return url.origin
  } catch {
    throw new Error('MATON_BASE_URL is not configured safely')
  }
}

export function inferMatonGatewayApp(pathname: string): string | null {
  const path = String(pathname || '').split(/[?#]/, 1)[0]
  if (path === '/google-mail' || path.startsWith('/google-mail/')) return 'google-mail'
  if (path === '/google-sheets' || path.startsWith('/google-sheets/')) return 'google-sheets'
  if (path === '/google-drive' || path.startsWith('/google-drive/')) return 'google-drive'
  return null
}

function requestUrl(pathnameValue: unknown, base: string): string {
  const pathname = typeof pathnameValue === 'string' ? pathnameValue : ''
  if (
    !pathname.startsWith('/')
    || pathname.startsWith('//')
    || pathname.includes('\\')
    || pathname.includes('#')
    || /[\u0000-\u001f\u007f]/.test(pathname)
  ) {
    throw new Error('A safe Maton gateway path is required')
  }
  const url = new URL(pathname, `${base}/`)
  if (url.origin !== base) throw new Error('A safe Maton gateway path is required')
  return url.toString()
}

async function requestCredential(
  pathname: string,
  context?: MatonFetchContext,
): Promise<{ app: string | null; credential: MatonGatewayCredential | null }> {
  const inferredApp = inferMatonGatewayApp(pathname)
  const explicitApp = context?.app === undefined ? null : normalizeMatonGatewayApp(context.app)
  if (inferredApp && explicitApp && inferredApp !== explicitApp) {
    throw new Error('Maton gateway app does not match the request path')
  }
  const app = explicitApp || inferredApp
  if (context) {
    if (!app) throw new Error('A Maton app is required for user-scoped requests')
    return {
      app,
      credential: await resolveUserMatonGatewayCredential({
        ownerEmail: context.ownerEmail,
        app,
        boundConnectionId: context.boundConnectionId,
      }),
    }
  }
  return {
    app,
    credential: app ? await resolveConfiguredOwnerMatonGatewayCredential({ app }) : null,
  }
}

export async function matonFetch(pathname: string, init?: RequestInit, context?: MatonFetchContext) {
  const base = resolveMatonGatewayBaseUrl()
  const url = requestUrl(pathname, base)
  const { app, credential } = await requestCredential(pathname, context)

  const headers = new Headers(init?.headers || {})
  if (credential) {
    headers.set('Authorization', `Bearer ${credential.apiKey}`)
    headers.set('Maton-Connection', credential.connectionId)
  } else {
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${readKey()}`)
    if (app === 'google-mail' && !headers.has('Maton-Connection')) {
      headers.set('Maton-Connection', readGmailConnectionId())
    }
  }
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abort = () => controller.abort()
  if (init?.signal?.aborted) controller.abort()
  else init?.signal?.addEventListener('abort', abort, { once: true })
  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    })
  } catch {
    throw new Error('Maton gateway request failed')
  } finally {
    clearTimeout(timeout)
    init?.signal?.removeEventListener('abort', abort)
  }
}
