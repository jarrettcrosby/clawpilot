import fs from 'fs'
import os from 'os'
import path from 'path'

const DEFAULT_BASE = 'https://gateway.maton.ai'

function readKey(): string {
  const candidates = [
    path.join(os.homedir(), '.openclaw', 'workspace', 'credentials', 'maton_api_key.txt'),
    path.join(process.cwd(), '..', 'credentials', 'maton_api_key.txt'),
  ]

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const key = fs.readFileSync(p, 'utf-8').trim()
      if (key) return key
    }
  }

  const fromEnv = process.env.MATON_API_KEY?.trim()
  if (fromEnv) return fromEnv

  throw new Error('MATON_API_KEY not configured')
}

export async function matonFetch(pathname: string, init?: RequestInit) {
  const key = readKey()
  const base = (process.env.MATON_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
  const url = `${base}${pathname}`

  const headers = new Headers(init?.headers || {})
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${key}`)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')

  return fetch(url, { ...init, headers })
}
