import crypto from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { XMLParser } from 'fast-xml-parser'
import { query } from '@/lib/persistence/postgres'

const MAX_FEED_BYTES = 4 * 1024 * 1024
const MAX_ITEMS_PER_SOURCE = 30
const RETENTION_DAYS = 365
const MAX_REDIRECTS = 3

type RadarSource = {
  key: string
  name: string
  url: string
  category: string
  tags: string[]
}

export type AiRadarItem = {
  id: string
  sourceName: string
  sourceUrl: string
  itemUrl: string
  title: string
  summary: string
  category: string
  tags: string[]
  publishedAt: string
  discoveredAt: string
}

type RadarRow = {
  id: string
  source_name: string
  source_url: string
  item_url: string
  title: string
  summary: string
  category: string
  tags: string[] | null
  published_at: string
  discovered_at: string
}

const DEFAULT_SOURCES: RadarSource[] = [
  {
    key: 'openai-news',
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    category: 'AI platforms',
    tags: ['ai', 'openai', 'models'],
  },
  {
    key: 'github-changelog',
    name: 'GitHub Changelog',
    url: 'https://github.blog/changelog/feed/',
    category: 'Developer platforms',
    tags: ['github', 'development', 'delivery'],
  },
  {
    key: 'vercel-changelog',
    name: 'Vercel Changelog',
    url: 'https://vercel.com/changelog/rss.xml',
    category: 'Application delivery',
    tags: ['vercel', 'deployment', 'frontend'],
  },
  {
    key: 'railway-blog',
    name: 'Railway Blog',
    url: 'https://blog.railway.com/rss.xml',
    category: 'Infrastructure',
    tags: ['railway', 'infrastructure', 'postgres'],
  },
]

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
  processEntities: false,
  trimValues: true,
})

function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split('.').map(Number)
    return !(
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && [0, 2].includes(c))
      || (a === 192 && b === 168)
      || (a === 198 && [18, 19].includes(b))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224
    )
  }
  if (isIP(normalized) !== 6) return false
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (mappedIpv4) return isPublicIpAddress(mappedIpv4)
  return !(
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
  )
}

async function validatedFeedUrl(value: string): Promise<URL> {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('AI Radar feeds and redirects must use HTTPS without embedded credentials')
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(`AI Radar feed host ${hostname} is not public`)
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw new Error(`AI Radar feed host ${hostname} resolves to a non-public address`)
  }
  return url
}

async function fetchFeedResponse(source: RadarSource): Promise<Response> {
  let currentUrl = source.url
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const validated = await validatedFeedUrl(currentUrl)
    const response = await fetch(validated, {
      headers: { Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml', 'User-Agent': 'ClawPilot-AI-Radar/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location || redirect === MAX_REDIRECTS) throw new Error(`${source.name} exceeded the redirect limit`)
    await response.body?.cancel()
    currentUrl = new URL(location, validated).toString()
  }
  throw new Error(`${source.name} exceeded the redirect limit`)
}

async function readBoundedFeed(response: Response, sourceName: string): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > MAX_FEED_BYTES) throw new Error(`${sourceName} feed exceeds ${MAX_FEED_BYTES} bytes`)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_FEED_BYTES) {
      await reader.cancel()
      throw new Error(`${sourceName} feed exceeds ${MAX_FEED_BYTES} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return textValue(record['#text'] ?? record.cdata ?? '')
  }
  return ''
}

function stripMarkup(value: unknown): string {
  return textValue(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)
}

function absoluteHttpsUrl(value: unknown, sourceUrl: string): string | null {
  try {
    const url = new URL(textValue(value), sourceUrl)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function atomLink(value: unknown, sourceUrl: string): string | null {
  const links = asArray(value)
  const preferred = links.find((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const record = entry as Record<string, unknown>
    return !record['@_rel'] || record['@_rel'] === 'alternate'
  }) || links[0]
  if (preferred && typeof preferred === 'object') {
    return absoluteHttpsUrl((preferred as Record<string, unknown>)['@_href'], sourceUrl)
  }
  return absoluteHttpsUrl(preferred, sourceUrl)
}

function parsePublishedAt(value: unknown): string | null {
  const date = new Date(textValue(value))
  if (!Number.isFinite(date.getTime())) return null
  const now = Date.now()
  if (date.getTime() > now + 24 * 60 * 60 * 1000) return null
  if (date.getTime() < now - RETENTION_DAYS * 24 * 60 * 60 * 1000) return null
  return date.toISOString()
}

function keywordTags(title: string, summary: string): string[] {
  const haystack = `${title} ${summary}`.toLowerCase()
  const matches: Array<[RegExp, string]> = [
    [/agent|codex|copilot/, 'agents'],
    [/model|gpt|embedding|inference/, 'models'],
    [/api|sdk|developer/, 'api'],
    [/security|vulnerab|auth|oauth/, 'security'],
    [/database|postgres|storage|backup/, 'data'],
    [/deploy|runtime|serverless|build/, 'deployment'],
    [/search|retrieval|vector/, 'knowledge'],
  ]
  return matches.filter(([pattern]) => pattern.test(haystack)).map(([, tag]) => tag)
}

function configuredSources(): RadarSource[] {
  const value = String(process.env.AI_RADAR_FEEDS_JSON || '').trim()
  if (!value) return DEFAULT_SOURCES
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('AI_RADAR_FEEDS_JSON must be valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 12) {
    throw new Error('AI_RADAR_FEEDS_JSON must contain 1-12 feed definitions')
  }
  return parsed.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const url = new URL(String(record.url || ''))
    if (url.protocol !== 'https:') throw new Error(`AI Radar feed ${index + 1} must use HTTPS`)
    const key = String(record.key || `feed-${index + 1}`).trim().toLowerCase()
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(key)) throw new Error(`AI Radar feed ${index + 1} has an invalid key`)
    return {
      key,
      name: String(record.name || key).trim().slice(0, 100),
      url: url.toString(),
      category: String(record.category || 'AI').trim().slice(0, 80),
      tags: asArray(record.tags).map(textValue).filter(Boolean).slice(0, 12),
    }
  })
}

async function fetchFeed(source: RadarSource) {
  const response = await fetchFeedResponse(source)
  if (!response.ok) throw new Error(`${source.name} returned HTTP ${response.status}`)
  const xml = await readBoundedFeed(response, source.name)
  const root = parser.parse(xml) as Record<string, unknown>
  const rssChannel = root.rss && typeof root.rss === 'object'
    ? (root.rss as Record<string, unknown>).channel as Record<string, unknown> | undefined
    : undefined
  const atomFeed = root.feed && typeof root.feed === 'object' ? root.feed as Record<string, unknown> : undefined
  const entries = rssChannel ? asArray(rssChannel.item) : atomFeed ? asArray(atomFeed.entry) : []
  return entries.slice(0, MAX_ITEMS_PER_SOURCE).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const title = stripMarkup(item.title).slice(0, 300)
    const itemUrl = rssChannel
      ? absoluteHttpsUrl(item.link || item.guid, source.url)
      : atomLink(item.link, source.url)
    const publishedAt = parsePublishedAt(item.pubDate || item.published || item.updated || item.date)
    if (!title || !itemUrl || !publishedAt) return []
    const summary = stripMarkup(item.description || item.summary || item.content || '')
    const feedCategories = asArray(item.category).map((category) => {
      if (category && typeof category === 'object') {
        return textValue((category as Record<string, unknown>)['@_term'] || category)
      }
      return textValue(category)
    }).filter(Boolean)
    const tags = Array.from(new Set([...source.tags, ...feedCategories, ...keywordTags(title, summary)]))
      .map((tag) => tag.toLowerCase().slice(0, 40))
      .filter(Boolean)
      .slice(0, 20)
    return [{
      sourceKey: crypto.createHash('sha256').update(`${source.key}\n${itemUrl}`).digest('hex'),
      sourceName: source.name,
      sourceUrl: source.url,
      itemUrl,
      title,
      summary,
      category: source.category,
      tags,
      publishedAt,
    }]
  })
}

async function recordHeartbeat(phase: string, details: Record<string, unknown>) {
  await query(
    `
      INSERT INTO knowledge_worker_heartbeat (worker_name, checked_at, phase, details)
      VALUES ('ai-radar', now(), $1, $2::jsonb)
      ON CONFLICT (worker_name) DO UPDATE SET
        checked_at = now(), phase = EXCLUDED.phase, details = EXCLUDED.details
    `,
    [phase, JSON.stringify(details)],
  )
}

export async function ingestAiRadarFeeds() {
  if (process.env.AI_RADAR_ENABLED === 'false') {
    await recordHeartbeat('disabled', { ingested: 0 })
    return { enabled: false, sources: 0, ingested: 0, errors: [] as string[] }
  }
  const sources = configuredSources()
  await recordHeartbeat('running', { sources: sources.length })
  const settled = await Promise.allSettled(sources.map(fetchFeed))
  const items = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  let ingested = 0
  for (const item of items) {
    const result = await query(
      `
        INSERT INTO ai_radar_items (
          source_key, source_name, source_url, item_url, title, summary,
          category, tags, published_at, discovered_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::timestamptz, now(), now())
        ON CONFLICT (source_key) DO UPDATE SET
          source_name = EXCLUDED.source_name,
          source_url = EXCLUDED.source_url,
          item_url = EXCLUDED.item_url,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          category = EXCLUDED.category,
          tags = EXCLUDED.tags,
          published_at = EXCLUDED.published_at,
          updated_at = now()
        WHERE ai_radar_items.title IS DISTINCT FROM EXCLUDED.title
           OR ai_radar_items.summary IS DISTINCT FROM EXCLUDED.summary
           OR ai_radar_items.tags IS DISTINCT FROM EXCLUDED.tags
        RETURNING id
      `,
      [item.sourceKey, item.sourceName, item.sourceUrl, item.itemUrl, item.title, item.summary, item.category, item.tags, item.publishedAt],
    )
    ingested += result.rowCount || 0
  }
  await query(`DELETE FROM ai_radar_items WHERE published_at < now() - ($1::integer * interval '1 day')`, [RETENTION_DAYS])
  const errors = settled.flatMap((result) => result.status === 'rejected'
    ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
    : [])
  await recordHeartbeat(errors.length > 0 ? 'degraded' : 'completed', { sources: sources.length, items: items.length, ingested, errors })
  return { enabled: true, sources: sources.length, items: items.length, ingested, errors }
}

export async function listAiRadarItems(limitValue: unknown = 20): Promise<AiRadarItem[]> {
  const limit = Math.max(1, Math.min(Math.trunc(Number(limitValue) || 20), 100))
  const result = await query<RadarRow>(
    `
      SELECT
        id::text, source_name, source_url, item_url, title, summary,
        category, tags, published_at::text, discovered_at::text
      FROM ai_radar_items
      ORDER BY published_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  )
  return result.rows.map((row) => ({
    id: row.id,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    itemUrl: row.item_url,
    title: row.title,
    summary: row.summary,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    publishedAt: new Date(row.published_at).toISOString(),
    discoveredAt: new Date(row.discovered_at).toISOString(),
  }))
}

export async function readKnowledgeWorkerStatus() {
  const result = await query<{ worker_name: string; checked_at: string; phase: string; details: Record<string, unknown> }>(
    `SELECT worker_name, checked_at::text, phase, details FROM knowledge_worker_heartbeat ORDER BY worker_name`,
  )
  return result.rows
}
