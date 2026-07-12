import fs from 'fs/promises'
import path from 'path'
import { matonFetch } from '@/lib/maton'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import {
  DEFAULT_PIPELINE_SHEET_ID,
  isPostgresPipelineStoreEnabled,
  upsertPipelineProjectionInPostgres,
  type PipelineProjection,
} from '@/lib/persistence/pipeline'

type SheetValuesResponse = {
  values?: string[][]
}

const RANGES = {
  opportunities: 'Opportunities!B5:M2000',
  organizations: 'Organizations!B5:M2000',
  contacts: 'Contacts!B5:M2000',
} as const

function nowIso() {
  return new Date().toISOString()
}

function parseMoney(value: unknown) {
  const parsed = Number(String(value || '').replace(/[$,]/g, '').trim() || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function parsePercent(value: unknown) {
  const parsed = Number(String(value || '').replace('%', '').trim() || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

async function readRange(range: string): Promise<string[][]> {
  const response = await matonFetch(
    `/google-sheets/v4/spreadsheets/${DEFAULT_PIPELINE_SHEET_ID}/values/${encodeURIComponent(range)}`,
  )
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Pipeline Sheet read failed for ${range} (${response.status}): ${text.slice(0, 1000)}`)
  }

  const parsed = text ? JSON.parse(text) as SheetValuesResponse : {}
  return Array.isArray(parsed.values) ? parsed.values : []
}

function mapOpportunity(row: string[], index: number, syncedAt: string) {
  return {
    id: `opp_${index + 1}`,
    sheetRowNumber: index + 5,
    priority: String(row[0] || '').trim(),
    name: String(row[1] || '').trim(),
    owner: String(row[2] || '').trim(),
    organization: String(row[3] || '').trim(),
    status: String(row[4] || '').trim(),
    stage: String(row[5] || '').trim(),
    lossReason: String(row[6] || '').trim(),
    source: String(row[7] || '').trim(),
    valueRaw: String(row[8] || '').trim(),
    value: parseMoney(row[8]),
    probabilityRaw: String(row[9] || '').trim(),
    probability: parsePercent(row[9]),
    expectedClose: String(row[10] || '').trim(),
    notes: String(row[11] || '').trim(),
    updatedAt: syncedAt,
  }
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tempPath, filePath)
}

async function writeFileProjection(projection: PipelineProjection, raw: Record<string, unknown>) {
  const root = path.join(process.cwd(), '..')
  const normalizedPath = process.env.PIPELINE_NORMALIZED_PATH
    || path.join(root, 'data', 'pipeline', 'normalized', 'current.json')
  const rawPath = process.env.PIPELINE_RAW_PATH
    || path.join(root, 'data', 'pipeline', 'raw', 'last-sync.json')

  await Promise.all([
    writeJsonAtomic(normalizedPath, projection),
    writeJsonAtomic(rawPath, raw),
  ])
}

export async function syncPipelineFromSheets(): Promise<{
  ok: true
  syncedAt: string
  summary: Record<string, number>
  projectionStorage: 'postgres' | 'file' | 'file-fallback'
  rawCounts: Record<string, number>
}> {
  const syncedAt = nowIso()
  const [opportunityRows, organizationRows, contactRows] = await Promise.all([
    readRange(RANGES.opportunities),
    readRange(RANGES.organizations),
    readRange(RANGES.contacts),
  ])

  const opportunities = opportunityRows
    .map((row, index) => mapOpportunity(row, index, syncedAt))
    .filter((opportunity) => opportunity.name)
  const organizations = organizationRows.filter((row) => String(row[1] || '').trim())
  const contacts = contactRows.filter((row) => String(row[1] || '').trim())
  const closed = new Set(['abandoned', 'loss', 'closed', 'closed-lost'])

  const summary = {
    opportunities: opportunities.length,
    organizations: organizations.length,
    contacts: contacts.length,
    totalOpenValue: Math.round(opportunities
      .filter((opportunity) => !closed.has(opportunity.status.toLowerCase()))
      .reduce((total, opportunity) => total + opportunity.value, 0) * 100) / 100,
  }
  const projection: PipelineProjection = {
    syncedAt,
    source: {
      provider: 'maton-google-sheets',
      sheetId: DEFAULT_PIPELINE_SHEET_ID,
      ranges: RANGES,
    },
    summary,
    opportunities,
  }
  const rawCounts = {
    opportunityRows: opportunityRows.length,
    organizationRows: organizationRows.length,
    contactRows: contactRows.length,
    normalizedOpportunities: opportunities.length,
  }
  const raw = { syncedAt, counts: rawCounts }

  if (isPostgresPipelineStoreEnabled()) {
    try {
      await upsertPipelineProjectionInPostgres(projection)
      return { ok: true, syncedAt, summary, projectionStorage: 'postgres', rawCounts }
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[pipeline-sync] Postgres projection write failed; using file fallback', error)
      await writeFileProjection(projection, raw)
      return { ok: true, syncedAt, summary, projectionStorage: 'file-fallback', rawCounts }
    }
  }

  await writeFileProjection(projection, raw)
  return { ok: true, syncedAt, summary, projectionStorage: 'file', rawCounts }
}
