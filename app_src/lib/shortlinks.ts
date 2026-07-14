import crypto from 'node:crypto'
import type { NextRequest } from 'next/server'
import type { QueryResultRow } from 'pg'
import { getStorageDriver } from '@/lib/persistence/config'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveUserPermissions, normalizeUserEmail } from '@/lib/users'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/
const SOURCE_PATTERN = /^[a-z][a-z0-9-]{1,39}$/
const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
const RESERVED_SLUGS = new Set(['admin', 'api', 'app', 'auth', 'new', 'privacy', 'settings'])
const MAX_TAGS = 20
const MAX_LIST_RESULTS = 250

export type ShortLinkStatus = 'active' | 'disabled' | 'expired' | 'exhausted'

export type ShortLink = {
  id: string
  ownerEmail: string
  sourceApp: string
  slug: string
  shortUrl: string
  destinationUrl: string
  title: string
  tags: string[]
  status: ShortLinkStatus
  expiresAt: string | null
  maxClicks: number | null
  clickCount: number
  remainingClicks: number | null
  lastClickedAt: string | null
  createdAt: string
  updatedAt: string
}

type ShortLinkRow = QueryResultRow & {
  id: string
  owner_email: string
  source_app: string
  slug: string
  destination_url: string
  title: string
  tags: string[] | null
  link_status: ShortLinkStatus
  expires_at: string | null
  max_clicks: string | number | null
  click_count: string | number
  last_clicked_at: string | null
  created_at: string
  updated_at: string
}

export type ShortLinkActor = {
  ownerEmail: string
  sourceApp: string
  manageAll: boolean
  service: boolean
}

type ShortLinkServiceClient = {
  sourceApp: string
  secret: string
  ownerDomain: string | null
}

export class ShortLinkRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'ShortLinkRequestError'
  }
}

const statusSql = `
  CASE
    WHEN disabled_at IS NOT NULL THEN 'disabled'
    WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
    WHEN max_clicks IS NOT NULL AND click_count >= max_clicks THEN 'exhausted'
    ELSE 'active'
  END
`

function canonicalOrigin(): string {
  const configured = String(process.env.SHORTLINK_PUBLIC_ORIGIN || '').trim()
  if (configured) {
    try {
      const url = new URL(configured)
      const localOrigin = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      if ((url.protocol !== 'https:' && !(localOrigin && url.protocol === 'http:'))
        || url.username
        || url.password
        || url.pathname !== '/'
        || url.search
        || url.hash) {
        throw new Error('Short-link origin must use HTTPS')
      }
      return url.origin
    } catch {
      throw new Error('SHORTLINK_PUBLIC_ORIGIN must be a valid HTTPS origin')
    }
  }
  const appOrigin = String(process.env.CLAWPILOT_PUBLIC_URL || '').trim()
  if (appOrigin) {
    const url = new URL(appOrigin)
    const localOrigin = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if ((url.protocol !== 'https:' && !(localOrigin && url.protocol === 'http:')) || url.username || url.password) {
      throw new Error('CLAWPILOT_PUBLIC_URL must use HTTPS')
    }
    return url.origin
  }
  return 'http://localhost:4002'
}

function requirePostgresStorage() {
  if (getStorageDriver() !== 'postgres') {
    throw new ShortLinkRequestError('Short links require Postgres storage', 503)
  }
}

export function shortLinkUrl(slug: string): string {
  return `${canonicalOrigin()}/s/${slug}`
}

function toSafeInteger(value: string | number | null): number | null {
  if (value === null) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

function toShortLink(row: ShortLinkRow): ShortLink {
  const maxClicks = toSafeInteger(row.max_clicks)
  const clickCount = toSafeInteger(row.click_count) || 0
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    sourceApp: row.source_app,
    slug: row.slug,
    shortUrl: shortLinkUrl(row.slug),
    destinationUrl: row.destination_url,
    title: row.title,
    tags: Array.isArray(row.tags) ? row.tags : [],
    status: row.link_status,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    maxClicks,
    clickCount,
    remainingClicks: maxClicks === null ? null : Math.max(0, maxClicks - clickCount),
    lastClickedAt: row.last_clicked_at ? new Date(row.last_clicked_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = crypto.createHash('sha256').update(left).digest()
  const rightHash = crypto.createHash('sha256').update(right).digest()
  return crypto.timingSafeEqual(leftHash, rightHash)
}

function normalizeSource(value: unknown, fallback = 'clawpilot'): string {
  const source = String(value || fallback).trim().toLowerCase()
  if (!SOURCE_PATTERN.test(source)) throw new ShortLinkRequestError('A valid source application is required')
  return source
}

function configuredServiceClients(): ShortLinkServiceClient[] {
  const configured = String(process.env.SHORTLINK_SERVICE_CLIENTS_JSON || '').trim()
  if (configured) {
    let parsed: unknown
    try {
      parsed = JSON.parse(configured)
    } catch {
      throw new ShortLinkRequestError('Short-link service authentication is misconfigured', 503)
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
      throw new ShortLinkRequestError('Short-link service authentication is misconfigured', 503)
    }
    try {
      return parsed.map((value) => {
        const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        const sourceApp = normalizeSource(record.sourceApp)
        const secret = String(record.secret || '')
        const ownerDomain = String(record.ownerDomain || '').trim().toLowerCase() || null
        if (secret.length < 32 || (ownerDomain && !/^[a-z0-9.-]+$/.test(ownerDomain))) throw new Error()
        return { sourceApp, secret, ownerDomain }
      })
    } catch {
      throw new ShortLinkRequestError('Short-link service authentication is misconfigured', 503)
    }
  }

  const secret = String(process.env.SHORTLINK_SERVICE_SECRET || '')
  if (secret.length < 32) return []
  return [{
    sourceApp: normalizeSource(process.env.SHORTLINK_SERVICE_SOURCE, 'external-app'),
    secret,
    ownerDomain: String(process.env.SHORTLINK_SERVICE_ALLOWED_OWNER_DOMAIN || '').trim().toLowerCase() || null,
  }]
}

export function validateShortLinkConfiguration(options: { requireServiceClient?: boolean; requirePublicOrigin?: boolean } = {}) {
  if (options.requirePublicOrigin && !String(process.env.SHORTLINK_PUBLIC_ORIGIN || '').trim()) {
    throw new Error('SHORTLINK_PUBLIC_ORIGIN must be configured')
  }
  const origin = canonicalOrigin()
  const clients = configuredServiceClients()
  if (options.requireServiceClient && clients.length === 0) {
    throw new Error('At least one short-link service client must be configured')
  }
  const duplicateSources = clients.filter((client, index) => (
    clients.findIndex((candidate) => candidate.sourceApp === client.sourceApp) !== index
  ))
  if (duplicateSources.length > 0) throw new Error('Short-link service client sources must be unique')
  return { origin, serviceClientCount: clients.length }
}

export async function resolveShortLinkActor(req: NextRequest): Promise<ShortLinkActor> {
  const authorization = String(req.headers.get('authorization') || '')
  if (/^Bearer\s+/i.test(authorization)) {
    const provided = authorization.replace(/^Bearer\s+/i, '').trim()
    let requestedSource: string
    try {
      requestedSource = normalizeSource(req.headers.get('x-shortlink-source'), '')
    } catch {
      throw new ShortLinkRequestError('Unauthorized', 401)
    }
    const client = configuredServiceClients().find((candidate) => (
      candidate.sourceApp === requestedSource && provided && secureEqual(provided, candidate.secret)
    ))
    if (!client) {
      throw new ShortLinkRequestError('Unauthorized', 401)
    }
    let ownerEmail: string
    try {
      ownerEmail = normalizeUserEmail(req.headers.get('x-shortlink-owner'))
    } catch {
      throw new ShortLinkRequestError('A valid authenticated user is required', 401)
    }
    if (client.ownerDomain && ownerEmail.split('@')[1] !== client.ownerDomain) {
      throw new ShortLinkRequestError('Authenticated user is outside the allowed domain', 403)
    }
    return {
      ownerEmail,
      sourceApp: client.sourceApp,
      manageAll: false,
      service: true,
    }
  }

  const user = await requireRequestUser(req)
  const permissions = effectiveUserPermissions(user)
  return {
    ownerEmail: user.email,
    sourceApp: 'clawpilot',
    manageAll: (user.role === 'owner' || user.role === 'admin') && permissions.manageLinks,
    service: false,
  }
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ShortLinkRequestError('Tags must be an array')
  const tags = Array.from(new Set(value.map((tag) => String(tag || '').trim().toLowerCase()).filter(Boolean)))
  if (tags.length > MAX_TAGS) throw new ShortLinkRequestError(`Use no more than ${MAX_TAGS} tags`)
  if (tags.some((tag) => tag.length > 40 || !/^[a-z0-9][a-z0-9 _-]*$/.test(tag))) {
    throw new ShortLinkRequestError('Tags may contain letters, numbers, spaces, hyphens, and underscores')
  }
  return tags
}

function normalizeSlug(value: unknown): string {
  const slug = String(value || '').trim().toLowerCase()
  if (!SLUG_PATTERN.test(slug)) {
    throw new ShortLinkRequestError('Slug must be 3-64 lowercase letters, numbers, hyphens, or underscores')
  }
  if (RESERVED_SLUGS.has(slug)) throw new ShortLinkRequestError('This slug is reserved')
  return slug
}

function generatedSlug(lengthValue: unknown): string {
  const length = valueOrDefaultInteger(lengthValue, 7, 4, 32, 'Slug length')
  const bytes = crypto.randomBytes(length)
  return Array.from(bytes, (byte) => SLUG_ALPHABET[byte % SLUG_ALPHABET.length]).join('')
}

function valueOrDefaultInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new ShortLinkRequestError(`${label} must be an integer from ${min} to ${max}`)
  }
  return number
}

function optionalMaxClicks(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  return valueOrDefaultInteger(value, 1, 1, 1_000_000_000, 'Click limit')
}

function optionalExpiry(input: { expiresAt?: unknown; durationHours?: unknown }, current?: string | null): string | null {
  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null || input.expiresAt === '') return null
    const date = new Date(String(input.expiresAt))
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
      throw new ShortLinkRequestError('Expiration must be in the future')
    }
    return date.toISOString()
  }
  if (input.durationHours !== undefined) {
    if (input.durationHours === null || input.durationHours === '') return null
    const hours = Number(input.durationHours)
    if (!Number.isFinite(hours) || hours < 1 || hours > 87_600) {
      throw new ShortLinkRequestError('Duration must be between 1 hour and 10 years')
    }
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
  }
  return current || null
}

function normalizeDestination(value: unknown): string {
  const input = String(value || '').trim()
  if (!input || input.length > 4096) throw new ShortLinkRequestError('A destination URL is required')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new ShortLinkRequestError('Destination must be a valid HTTPS URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ShortLinkRequestError('Destination must be an HTTPS URL without embedded credentials')
  }
  const canonical = new URL(canonicalOrigin())
  if (url.origin === canonical.origin && /^\/s\//.test(url.pathname)) {
    throw new ShortLinkRequestError('A short link cannot point to another link on the same short-link service')
  }
  return url.toString()
}

function normalizeTitle(value: unknown): string {
  const title = String(value || '').trim()
  if (title.length > 200) throw new ShortLinkRequestError('Title must be 200 characters or fewer')
  return title
}

function searchSlug(value: string): string {
  try {
    const url = new URL(value)
    return url.pathname.match(/^\/s\/([^/?#]+)/)?.[1]?.toLowerCase() || ''
  } catch {
    return value.toLowerCase().replace(/^.*\/s\//, '')
  }
}

export async function listShortLinks(actor: ShortLinkActor, filters: {
  query?: unknown
  tag?: unknown
  status?: unknown
  sourceApp?: unknown
} = {}): Promise<ShortLink[]> {
  requirePostgresStorage()
  const search = String(filters.query || '').trim().slice(0, 500)
  const slugSearch = searchSlug(search).slice(0, 64)
  const tag = String(filters.tag || '').trim().toLowerCase().slice(0, 40)
  const status = String(filters.status || '').trim().toLowerCase()
  if (status && !['active', 'disabled', 'expired', 'exhausted'].includes(status)) {
    throw new ShortLinkRequestError('Invalid short-link status filter')
  }
  const sourceApp = filters.sourceApp ? normalizeSource(filters.sourceApp) : ''
  const result = await query<ShortLinkRow>(
    `
      SELECT
        id::text, owner_email, source_app, slug, destination_url, title, tags,
        ${statusSql} AS link_status,
        expires_at::text, max_clicks, click_count, last_clicked_at::text,
        created_at::text, updated_at::text
      FROM short_links
      WHERE deleted_at IS NULL
        AND ($2::boolean OR owner_email = $1)
        AND (NOT $8::boolean OR source_app = $9)
        AND (
          $3 = ''
          OR destination_url ILIKE '%' || $3 || '%'
          OR title ILIKE '%' || $3 || '%'
          OR slug ILIKE '%' || $3 || '%'
          OR owner_email ILIKE '%' || $3 || '%'
          OR source_app ILIKE '%' || $3 || '%'
          OR ($4 <> '' AND slug ILIKE '%' || $4 || '%')
          OR array_to_string(tags, ' ') ILIKE '%' || $3 || '%'
        )
        AND ($5 = '' OR $5 = ANY(tags))
        AND ($6 = '' OR (${statusSql}) = $6)
        AND ($7 = '' OR source_app = $7)
      ORDER BY updated_at DESC, id DESC
      LIMIT $10
    `,
    [
      actor.ownerEmail,
      actor.manageAll,
      search,
      slugSearch,
      tag,
      status,
      sourceApp,
      actor.service,
      actor.sourceApp,
      MAX_LIST_RESULTS,
    ],
  )
  return result.rows.map(toShortLink)
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505')
}

export async function createShortLink(actor: ShortLinkActor, value: unknown): Promise<ShortLink> {
  requirePostgresStorage()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ShortLinkRequestError('Request body is required')
  const input = value as Record<string, unknown>
  const destinationUrl = normalizeDestination(input.destinationUrl)
  const title = normalizeTitle(input.title)
  const tags = normalizeTags(input.tags)
  const maxClicks = optionalMaxClicks(input.maxClicks)
  const expiresAt = optionalExpiry(input)
  const customSlug = String(input.slug || '').trim() ? normalizeSlug(input.slug) : null

  for (let attempt = 0; attempt < (customSlug ? 1 : 8); attempt += 1) {
    const slug = customSlug || generatedSlug(input.slugLength)
    try {
      const result = await query<ShortLinkRow>(
        `
          INSERT INTO short_links (
            owner_email, source_app, slug, destination_url, title, tags,
            max_clicks, expires_at, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8::timestamptz, now(), now())
          RETURNING
            id::text, owner_email, source_app, slug, destination_url, title, tags,
            ${statusSql} AS link_status,
            expires_at::text, max_clicks, click_count, last_clicked_at::text,
            created_at::text, updated_at::text
        `,
        [actor.ownerEmail, actor.sourceApp, slug, destinationUrl, title, tags, maxClicks, expiresAt],
      )
      return toShortLink(result.rows[0])
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      if (customSlug) throw new ShortLinkRequestError('That slug is already in use', 409)
    }
  }
  throw new ShortLinkRequestError('Unable to generate a unique slug. Try again.', 409)
}

export async function updateShortLink(actor: ShortLinkActor, value: unknown): Promise<ShortLink> {
  requirePostgresStorage()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ShortLinkRequestError('Request body is required')
  const input = value as Record<string, unknown>
  const id = String(input.id || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ShortLinkRequestError('A valid short-link id is required')
  const action = String(input.action || '').trim().toLowerCase()
  if (action && !['disable', 'enable'].includes(action)) throw new ShortLinkRequestError('Invalid short-link action')
  try {
    return await withTransaction(async (client) => {
      const selected = await client.query<ShortLinkRow>(
        `
          SELECT
            id::text, owner_email, source_app, slug, destination_url, title, tags,
            ${statusSql} AS link_status,
            expires_at::text, max_clicks, click_count, last_clicked_at::text,
            created_at::text, updated_at::text
          FROM short_links
          WHERE id = $1::uuid
            AND deleted_at IS NULL
            AND ($3::boolean OR owner_email = $2)
            AND (NOT $4::boolean OR source_app = $5)
          FOR UPDATE
        `,
        [id, actor.ownerEmail, actor.manageAll, actor.service, actor.sourceApp],
      )
      const current = selected.rows[0]
      if (!current) throw new ShortLinkRequestError('Short link was not found', 404)
      const destinationUrl = input.destinationUrl === undefined ? current.destination_url : normalizeDestination(input.destinationUrl)
      const title = input.title === undefined ? current.title : normalizeTitle(input.title)
      const tags = input.tags === undefined ? (current.tags || []) : normalizeTags(input.tags)
      const slug = input.slug === undefined || input.slug === '' ? current.slug : normalizeSlug(input.slug)
      const maxClicks = input.maxClicks === undefined ? toSafeInteger(current.max_clicks) : optionalMaxClicks(input.maxClicks)
      const clickCount = toSafeInteger(current.click_count) || 0
      if (maxClicks !== null && maxClicks < clickCount) {
        throw new ShortLinkRequestError(`Click limit cannot be lower than the existing ${clickCount} clicks`)
      }
      const expiresAt = optionalExpiry(input, current.expires_at)
      const result = await client.query<ShortLinkRow>(
        `
          UPDATE short_links
          SET slug = $2,
              destination_url = $3,
              title = $4,
              tags = $5::text[],
              max_clicks = $6,
              expires_at = $7::timestamptz,
              disabled_at = CASE
                WHEN $8 = 'disable' THEN now()
                WHEN $8 = 'enable' THEN NULL
                ELSE disabled_at
              END,
              updated_at = now()
          WHERE id = $1::uuid
          RETURNING
            id::text, owner_email, source_app, slug, destination_url, title, tags,
            ${statusSql} AS link_status,
            expires_at::text, max_clicks, click_count, last_clicked_at::text,
            created_at::text, updated_at::text
        `,
        [id, slug, destinationUrl, title, tags, maxClicks, expiresAt, action],
      )
      return toShortLink(result.rows[0])
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ShortLinkRequestError('That slug is already in use', 409)
    throw error
  }
}

export async function deleteShortLink(actor: ShortLinkActor, idValue: unknown): Promise<void> {
  requirePostgresStorage()
  const id = String(idValue || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ShortLinkRequestError('A valid short-link id is required')
  const result = await query(
    `
      UPDATE short_links
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1::uuid
        AND deleted_at IS NULL
        AND ($3::boolean OR owner_email = $2)
        AND (NOT $4::boolean OR source_app = $5)
    `,
    [id, actor.ownerEmail, actor.manageAll, actor.service, actor.sourceApp],
  )
  if (result.rowCount !== 1) throw new ShortLinkRequestError('Short link was not found', 404)
}

function referrerHost(value: unknown): string | null {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().slice(0, 255) || null
  } catch {
    return null
  }
}

export async function resolveShortLink(input: {
  slug: unknown
  sourceApp?: unknown
  referrer?: unknown
}): Promise<{ status: 'found' | 'not-found' | Exclude<ShortLinkStatus, 'active'>; destinationUrl?: string }> {
  if (getStorageDriver() !== 'postgres') return { status: 'not-found' }
  let slug: string
  try {
    slug = normalizeSlug(input.slug)
  } catch {
    return { status: 'not-found' }
  }
  let sourceApp: string
  try {
    sourceApp = normalizeSource(input.sourceApp, 'short-link')
  } catch {
    sourceApp = 'short-link'
  }
  return withTransaction(async (client) => {
    const selected = await client.query<{
      id: string
      destination_url: string
      disabled_at: string | null
      expires_at: string | null
      max_clicks: string | null
      click_count: string
    }>(
      `
        SELECT id::text, destination_url, disabled_at::text, expires_at::text, max_clicks, click_count
        FROM short_links
        WHERE slug = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [slug],
    )
    const link = selected.rows[0]
    if (!link) return { status: 'not-found' as const }
    if (link.disabled_at) return { status: 'disabled' as const }
    if (link.expires_at && Date.parse(link.expires_at) <= Date.now()) return { status: 'expired' as const }
    const maxClicks = toSafeInteger(link.max_clicks)
    const clickCount = toSafeInteger(link.click_count) || 0
    if (maxClicks !== null && clickCount >= maxClicks) return { status: 'exhausted' as const }
    await client.query(
      `UPDATE short_links SET click_count = click_count + 1, last_clicked_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [link.id],
    )
    await client.query(
      `INSERT INTO short_link_clicks (short_link_id, source_app, referrer_host) VALUES ($1::uuid, $2, $3)`,
      [link.id, sourceApp, referrerHost(input.referrer)],
    )
    return { status: 'found' as const, destinationUrl: link.destination_url }
  })
}
