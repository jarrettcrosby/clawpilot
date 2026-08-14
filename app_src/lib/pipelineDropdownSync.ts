import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { resolveManagedGoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspace'
import { googleSheetsJson, type GoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspaceClient'
import { matonFetch } from '@/lib/maton'
import { logPipelineEvent } from '@/lib/pipelineLog'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import {
  DEFAULT_PIPELINE_SHEET_ID,
  isPostgresPipelineStoreEnabled,
  readPipelineDropdownCatalogFromPostgres,
  resolvePipelineSheetBindingInPostgres,
  upsertPipelineDropdownCatalogInPostgres,
  type PipelineDropdownCatalog,
  type PipelineDropdownOption,
  type PipelineSheetContext,
} from '@/lib/persistence/pipeline'

const DROPDOWN_TAB = process.env.PIPELINE_DROPDOWN_TAB || 'Dropdowns'

// Jarrett-confirmed layout (column-per-dropdown):
// headers on row 4, options start on row 5
const HEADER_ROW = Number(process.env.PIPELINE_DROPDOWN_HEADER_ROW || 4)
const START_COL_LETTER = process.env.PIPELINE_DROPDOWN_START_COL || 'B'
const END_COL_LETTER = process.env.PIPELINE_DROPDOWN_END_COL || 'ZZ'
const CANONICAL_DROPDOWN_KEYS = ['owner', 'product', 'stage', 'priority', 'status', 'source', 'loss_reason'] as const

const READ_RANGE = `${DROPDOWN_TAB}!${START_COL_LETTER}${HEADER_ROW}:${END_COL_LETTER}2000`
const CACHE_FILE = process.env.PIPELINE_DROPDOWN_CACHE_PATH
  || path.join(process.cwd(), '..', 'data', 'pipeline', 'dropdowns', 'catalog.json')

type SheetMeta = { sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> }
type SheetValuesResponse = { values?: string[][] }
type PipelineDropdownSyncContext = Partial<PipelineSheetContext> & {
  legacyOwnerFallback?: boolean
}
type ResolvedDropdownSyncContext = {
  pipelineId: string | null
  sheetId: string
  postgresContext: PipelineSheetContext | null
  legacyOwnerFallback: boolean
  managedRuntime?: Promise<GoogleWorkspaceRuntime | null>
}

function nowIso() {
  return new Date().toISOString()
}

function resolveDropdownSyncContext(input: PipelineDropdownSyncContext = {}): ResolvedDropdownSyncContext {
  const pipelineId = String(input.pipelineId || '').trim() || null
  const sheetId = String(input.sheetId || '').trim() || DEFAULT_PIPELINE_SHEET_ID
  const legacyOwnerFallback = input.legacyOwnerFallback === true

  if (isPostgresPipelineStoreEnabled() && (!pipelineId || !input.sheetId)) {
    throw new Error('Pipeline and Sheet context are required for dropdown sync')
  }
  if (legacyOwnerFallback && (!pipelineId && sheetId !== DEFAULT_PIPELINE_SHEET_ID)) {
    throw new Error('Legacy pipeline dropdown sync cannot target a non-default Sheet')
  }

  return {
    pipelineId,
    sheetId,
    postgresContext: pipelineId && input.sheetId ? { pipelineId, sheetId } : null,
    legacyOwnerFallback,
  }
}

function normalizeKey(input: string) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function orderedDropdownKeys(catalog: Record<string, unknown>) {
  const available = new Set(Object.keys(catalog))
  return [
    ...CANONICAL_DROPDOWN_KEYS.filter((key) => available.delete(key)),
    ...Array.from(available).sort((left, right) => left.localeCompare(right)),
  ]
}

function hashCatalogEntry(key: string, values: string[]) {
  return crypto.createHash('sha1').update(`${key}|${values.join('|')}`).digest('hex').slice(0, 12)
}

function ensureCacheDir() {
  const dir = path.dirname(CACHE_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function writeFileCache(catalog: PipelineDropdownCatalog) {
  ensureCacheDir()
  fs.writeFileSync(CACHE_FILE, JSON.stringify(catalog, null, 2), 'utf-8')
}

function readFileCache(): PipelineDropdownCatalog | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as PipelineDropdownCatalog : null
  } catch {
    return null
  }
}

async function persistCatalog(catalog: PipelineDropdownCatalog, context: ResolvedDropdownSyncContext) {
  if (isPostgresPipelineStoreEnabled()) {
    if (!context.postgresContext) {
      if (context.legacyOwnerFallback) return catalog
      throw new Error('Pipeline and Sheet context are required for dropdown persistence')
    }
    try {
      return await upsertPipelineDropdownCatalogInPostgres({ ...context.postgresContext, catalog })
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError() || !context.legacyOwnerFallback) throw error
      console.warn('[pipeline-dropdown-sync] Postgres catalog write failed; using file fallback', error)
    }
  }

  writeFileCache(catalog)
  return catalog
}

async function readPersistedCatalog(context: ResolvedDropdownSyncContext): Promise<PipelineDropdownCatalog | null> {
  if (isPostgresPipelineStoreEnabled()) {
    if (!context.postgresContext) {
      if (context.legacyOwnerFallback) return null
      throw new Error('Pipeline and Sheet context are required for dropdown persistence')
    }
    try {
      const catalog = await readPipelineDropdownCatalogFromPostgres(context.postgresContext)
      if (catalog) return catalog
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError() || !context.legacyOwnerFallback) throw error
      console.warn('[pipeline-dropdown-sync] Postgres catalog read failed; using file fallback', error)
    }
  }

  return readFileCache()
}

async function dropdownManagedRuntime(context: ResolvedDropdownSyncContext) {
  if (!isPostgresPipelineStoreEnabled()) return null
  if (!context.postgresContext) throw new Error('Pipeline and Sheet context are required for dropdown sync')
  if (!context.managedRuntime) {
    context.managedRuntime = (async () => {
      const binding = await resolvePipelineSheetBindingInPostgres(context.postgresContext as PipelineSheetContext)
      if (binding.legacyOwnerFallback) return null
      if (!binding.googleServiceAccountEmail || !binding.googleSharedDriveId) {
        throw new Error('Managed pipeline is missing its native Google Workspace binding')
      }
      return resolveManagedGoogleWorkspaceRuntime({
        serviceAccountEmail: binding.googleServiceAccountEmail,
        sharedDriveId: binding.googleSharedDriveId,
      })
    })()
  }
  return context.managedRuntime
}

function nativeSheetsPath(pathname: string) {
  if (!pathname.startsWith('/google-sheets/v4/')) {
    throw new Error('Managed Google Sheets request path is invalid')
  }
  return pathname.slice('/google-sheets'.length)
}

async function sheetGet(pathname: string, context: ResolvedDropdownSyncContext) {
  const managedRuntime = await dropdownManagedRuntime(context)
  if (managedRuntime) {
    return googleSheetsJson<Record<string, unknown>>(managedRuntime, nativeSheetsPath(pathname))
  }
  const res = await matonFetch(pathname)
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text.slice(0, 2000) }
  }
  if (!res.ok) throw new Error(`Sheets GET failed (${res.status})`)
  return data
}

async function sheetPost(pathname: string, body: unknown, context: ResolvedDropdownSyncContext) {
  const managedRuntime = await dropdownManagedRuntime(context)
  if (managedRuntime) {
    return googleSheetsJson<Record<string, unknown>>(managedRuntime, nativeSheetsPath(pathname), {
      method: 'POST',
      body,
      idempotent: false,
    })
  }
  const res = await matonFetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text.slice(0, 2000) }
  }
  if (!res.ok) throw new Error(`Sheets POST failed (${res.status})`)
  return data
}

async function sheetWrite(
  pathname: string,
  method: 'POST' | 'PUT',
  body: unknown,
  context: ResolvedDropdownSyncContext,
) {
  const managedRuntime = await dropdownManagedRuntime(context)
  if (managedRuntime) {
    await googleSheetsJson<Record<string, unknown>>(managedRuntime, nativeSheetsPath(pathname), {
      method,
      body,
      idempotent: method === 'PUT',
    })
    return
  }
  const res = await matonFetch(pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    const detail = text ? `: ${text.slice(0, 500)}` : ''
    throw new Error(`Sheets ${method} failed (${res.status})${detail}`)
  }
}

function colLetterToIndex(col: string) {
  let out = 0
  for (const ch of col.toUpperCase()) out = out * 26 + (ch.charCodeAt(0) - 64)
  return out - 1
}

function indexToColLetter(index: number) {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

async function getSheetIdByTitle(
  spreadsheetId: string,
  title: string,
  context: ResolvedDropdownSyncContext,
): Promise<number> {
  const meta = await sheetGet(
    `/google-sheets/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    context,
  ) as SheetMeta
  const sheet = (meta.sheets || []).find((entry) => entry?.properties?.title === title)
  if (!sheet?.properties?.sheetId && sheet?.properties?.sheetId !== 0) throw new Error(`Sheet tab not found: ${title}`)
  return Number(sheet.properties.sheetId)
}

function parseColumnarValues(values: string[][]): PipelineDropdownCatalog {
  // values is a matrix from B4:ZZ2000 where first row is header names per column
  const headerRow = values?.[0] || []
  const dropdowns: Record<string, PipelineDropdownOption[]> = {}

  for (let col = 0; col < headerRow.length; col++) {
    const headerRaw = String(headerRow[col] || '').trim()
    if (!headerRaw) continue

    const dropdownKey = normalizeKey(headerRaw) || `col_${col}`
    const options: PipelineDropdownOption[] = []

    for (let row = 1; row < (values?.length || 0); row++) {
      const cell = String(values[row]?.[col] || '').trim()
      if (!cell) continue
      options.push({
        value: cell,
        label: cell,
        active: true,
        sort_order: options.length,
      })
    }

    // dedupe while preserving order
    const seen = new Set<string>()
    dropdowns[dropdownKey] = options.filter((o) => {
      const key = o.value.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  return {
    syncedAt: nowIso(),
    source: 'sheet',
    dropdowns,
  }
}

function toColumnarRows(catalog: PipelineDropdownCatalog) {
  const keys = orderedDropdownKeys(catalog.dropdowns || {})
  const headers = keys.map((k) => k)
  const columns = keys.map((k) => {
    const opts = (catalog.dropdowns[k] || [])
      .filter((o) => o.active !== false)
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
      .map((o) => String(o.label || o.value || '').trim())
      .filter(Boolean)
    const seen = new Set<string>()
    return opts.filter((v) => {
      const x = v.toLowerCase()
      if (seen.has(x)) return false
      seen.add(x)
      return true
    })
  })
  const maxRows = Math.max(1, ...columns.map((c) => c.length))

  const rows: string[][] = []
  rows.push(headers)
  for (let i = 0; i < maxRows; i++) {
    rows.push(columns.map((col) => col[i] || ''))
  }

  return { keys, rows }
}

async function fetchDropdownsFromSheet(spreadsheetId: string, context: ResolvedDropdownSyncContext) {
  const encoded = encodeURIComponent(READ_RANGE)
  const data = await sheetGet(
    `/google-sheets/v4/spreadsheets/${spreadsheetId}/values/${encoded}`,
    context,
  ) as SheetValuesResponse
  return parseColumnarValues(data.values || [])
}

export async function pullDropdownsFromSheet(input: PipelineDropdownSyncContext = {}) {
  const context = resolveDropdownSyncContext(input)
  const runId = `pull-${Date.now()}`
  try {
    const catalog = await fetchDropdownsFromSheet(context.sheetId, context)
    await persistCatalog(catalog, context)
    logPipelineEvent({
      module: 'pipeline-dropdown-sync',
      action: 'pull',
      result: 'ok',
      pipelineId: context.pipelineId || undefined,
      detail: { runId, dropdownCount: Object.keys(catalog.dropdowns).length },
    })

    return { runId, catalog }
  } catch (e: unknown) {
    logPipelineEvent({
      module: 'pipeline-dropdown-sync',
      action: 'pull',
      result: 'error',
      pipelineId: context.pipelineId || undefined,
      detail: { runId, error: String(e) },
    })
    throw e
  }
}

export async function getDropdownCatalog(
  input: PipelineDropdownSyncContext & { forceRefresh?: boolean; maxAgeMs?: number } = {},
) {
  const context = resolveDropdownSyncContext(input)
  const cached = await readPersistedCatalog(context)
  const maxAgeMs = Math.max(0, Number(input.maxAgeMs ?? process.env.PIPELINE_DROPDOWN_CACHE_MAX_AGE_MS ?? 300_000))
  const cachedAt = cached?.syncedAt ? Date.parse(cached.syncedAt) : Number.NaN
  const fresh = cached && Number.isFinite(cachedAt) && Date.now() - cachedAt <= maxAgeMs

  if (!input.forceRefresh && fresh) {
    return { runId: 'cache', catalog: cached, storage: isPostgresPipelineStoreEnabled() ? 'postgres' : 'file', stale: false }
  }

  try {
    const pulled = await pullDropdownsFromSheet(input)
    return { ...pulled, storage: isPostgresPipelineStoreEnabled() ? 'postgres' : 'file', stale: false }
  } catch (error) {
    if (!input.forceRefresh && cached) {
      return {
        runId: 'cache-stale',
        catalog: cached,
        storage: isPostgresPipelineStoreEnabled() ? 'postgres' : 'file',
        stale: true,
        warning: String(error),
      }
    }
    throw error
  }
}

export async function pushDropdownsToSheet(
  input: PipelineDropdownCatalog,
  contextInput: PipelineDropdownSyncContext = {},
) {
  const context = resolveDropdownSyncContext(contextInput)
  const runId = `push-${Date.now()}`
  try {
    const sheetId = await getSheetIdByTitle(context.sheetId, DROPDOWN_TAB, context)

    // Pull current first to preserve unknown/manually-added columns
    const existing = await fetchDropdownsFromSheet(context.sheetId, context)
    const merged: PipelineDropdownCatalog = {
      syncedAt: nowIso(),
      source: 'app',
      dropdowns: { ...(existing.dropdowns || {}), ...(input?.dropdowns || {}) },
    }

    const { keys, rows } = toColumnarRows(merged)

    const startColIdx = colLetterToIndex(START_COL_LETTER)
    const startRowIdx = HEADER_ROW - 1
    const endColIdx = startColIdx + Math.max(1, keys.length)
    const endRowIdx = startRowIdx + rows.length

    const rangeA1 = `${DROPDOWN_TAB}!${START_COL_LETTER}${HEADER_ROW}:${indexToColLetter(endColIdx - 1)}${HEADER_ROW + rows.length - 1}`
    const clearRangeA1 = `${DROPDOWN_TAB}!${START_COL_LETTER}${HEADER_ROW}:${indexToColLetter(Math.max(endColIdx, colLetterToIndex(END_COL_LETTER)+1) - 1)}2000`

    // value update
    await sheetWrite(
      `/google-sheets/v4/spreadsheets/${context.sheetId}/values/${encodeURIComponent(clearRangeA1)}:clear`,
      'POST',
      {},
      context,
    )

    await sheetWrite(
      `/google-sheets/v4/spreadsheets/${context.sheetId}/values/${encodeURIComponent(rangeA1)}?valueInputOption=RAW`,
      'PUT',
      { range: rangeA1, majorDimension: 'ROWS', values: rows },
      context,
    )

    // copy formatting + validation from first dropdown column template
    await sheetPost(`/google-sheets/v4/spreadsheets/${context.sheetId}:batchUpdate`, {
      requests: [
        {
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: startRowIdx,
              endRowIndex: endRowIdx,
              startColumnIndex: startColIdx,
              endColumnIndex: startColIdx + 1,
            },
            destination: {
              sheetId,
              startRowIndex: startRowIdx,
              endRowIndex: endRowIdx,
              startColumnIndex: startColIdx,
              endColumnIndex: endColIdx,
            },
            pasteType: 'PASTE_FORMAT',
            pasteOrientation: 'NORMAL',
          },
        },
        {
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: startRowIdx,
              endRowIndex: endRowIdx,
              startColumnIndex: startColIdx,
              endColumnIndex: startColIdx + 1,
            },
            destination: {
              sheetId,
              startRowIndex: startRowIdx,
              endRowIndex: endRowIdx,
              startColumnIndex: startColIdx,
              endColumnIndex: endColIdx,
            },
            pasteType: 'PASTE_DATA_VALIDATION',
            pasteOrientation: 'NORMAL',
          },
        },
      ],
      includeSpreadsheetInResponse: false,
      responseIncludeGridData: false,
    }, context)

    // lightweight metadata hashes in log only (no secret output)
    const hashes = keys.map((k) => ({ key: k, hash: hashCatalogEntry(k, (merged.dropdowns[k] || []).map((x) => x.value)) }))

    await persistCatalog(merged, context)
    logPipelineEvent({
      module: 'pipeline-dropdown-sync',
      action: 'push',
      result: 'ok',
      pipelineId: context.pipelineId || undefined,
      detail: { runId, dropdownCount: keys.length, hashes },
    })

    return { runId, catalog: merged }
  } catch (e: unknown) {
    logPipelineEvent({
      module: 'pipeline-dropdown-sync',
      action: 'push',
      result: 'error',
      pipelineId: context.pipelineId || undefined,
      detail: { runId, error: String(e) },
    })
    throw e
  }
}
