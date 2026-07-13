import fs from 'fs'

const DEFAULT_BASE = 'https://gateway.maton.ai'

function readKey(): string {
  const fromEnv = process.env.MATON_API_KEY?.trim()
  if (fromEnv) return fromEnv

  const configuredPath = process.env.MATON_API_KEY_FILE?.trim()
  if (configuredPath && fs.existsSync(configuredPath)) {
    const key = fs.readFileSync(configuredPath, 'utf8').trim()
    if (key) return key
  }

  throw new Error('MATON_API_KEY not configured')
}

export async function matonFetch(pathname: string, init?: RequestInit) {
  const key = readKey()
  const base = (process.env.MATON_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
  const url = `${base}${pathname}`

  const headers = new Headers(init?.headers || {})
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${key}`)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')

  return fetch(url, {
    ...init,
    headers,
    signal: init?.signal || AbortSignal.timeout(15000),
  })
}
