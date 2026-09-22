import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { requireRequestSession } from '@/lib/requestUser'
import { isRootAppOwner, requireActiveAppUser } from '@/lib/users'

type ArchitectureManifest = {
  format: number; sourceHash: string; htmlHash: string; bytes: number
  toolVersion: string; views: string[]
}

export class ArchitectureAccessError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? 'Sign in to view architecture.' : 'Architecture is restricted to the platform owner outside impersonation.')
  }
}

export async function requireArchitectureAccess(request: NextRequest): Promise<void> {
  let session
  try { session = await requireRequestSession(request) }
  catch { throw new ArchitectureAccessError(401) }
  if (session.impersonating || session.authenticatedUser !== session.effectiveUser) throw new ArchitectureAccessError(403)
  // Never trust an organization-scoped role or the locally synthesized dev user.
  const actor = await requireActiveAppUser(session.authenticatedUser).catch(() => null)
  if (!actor || !isRootAppOwner(actor)) throw new ArchitectureAccessError(403)
}

export function architecturePrivateHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'private, no-store, max-age=0',
    'Vary': 'Cookie',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
  })
}

// Literal server-only paths are explicitly traced by next.config.ts. These files
// are neither imported by React nor copied into public or _next/static.
const artifactDirectory = path.join(process.cwd(), 'server-assets', 'architecture')

export async function readArchitectureManifest(): Promise<ArchitectureManifest> {
  const manifest = JSON.parse(await readFile(path.join(artifactDirectory, 'manifest.json'), 'utf8')) as ArchitectureManifest
  if (manifest.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sourceHash) || !/^[a-f0-9]{64}$/.test(manifest.htmlHash)
    || !Number.isInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > 20_000_000
    || !Array.isArray(manifest.views) || !manifest.views.every((view) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(view))) {
    throw new Error('Invalid architecture artifact')
  }
  return manifest
}

export async function readArchitectureViewer(): Promise<{ html: string; headers: Headers }> {
  const manifest = await readArchitectureManifest()
  const html = await readFile(path.join(artifactDirectory, 'viewer.html'), 'utf8')
  if (Buffer.byteLength(html) !== manifest.bytes || createHash('sha256').update(html).digest('hex') !== manifest.htmlHash) {
    throw new Error('Architecture artifact integrity mismatch')
  }
  const nonce = randomBytes(24).toString('base64')
  const headers = architecturePrivateHeaders()
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('X-Frame-Options', 'SAMEORIGIN')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  headers.set('Content-Security-Policy', [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'unsafe-inline'",
    'img-src data: blob:', 'font-src data:', "connect-src 'none'", "worker-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
    'sandbox allow-scripts',
  ].join('; '))
  return { html: html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (_, attributes: string, script: string) => `<script nonce="${nonce}"${attributes}>${script}</script>`), headers }
}

export function architectureFailure(error: unknown): Response {
  const status = error instanceof ArchitectureAccessError ? error.status : 503
  return Response.json({ ok: false, error: error instanceof ArchitectureAccessError ? error.message : 'Architecture viewer is unavailable. Rebuild the application artifact.' },
    { status, headers: architecturePrivateHeaders() })
}
