import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { matonFetch } from '@/lib/maton'
import { logPipelineEvent } from '@/lib/pipelineLog'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import {
  isPostgresPipelineStoreEnabled,
  readPipelineDropdownCatalogFromPostgres,
  upsertPipelineDropdownCatalogInPostgres,
  type PipelineDropdownCatalog,
  type PipelineDropdownOption,
} from '@/lib/persistence/pipeline'

const SHEET_ID = process.env.PIPELINE_SHEET_ID || '1sp-eLYEEGera1acBoze_GvR4263dunlmaOUyBej-iqY'
const DROPDOWN_TAB = process.env.PIPELINE_DROPDOWN_TAB || 'Dropdowns'

// Jarrett-confirmed layout (column-per-dropdown):
// headers on row 4, options start on row 5
const HEADER_ROW = Number(process.env.PIPELINE_DROPDOWN_HEADER_ROW || 4)
const OPTIONS_START_ROW = Number(process.env.PIPELINE_DROPDOWN_OPTIONS_START_ROW || 5)
const START_COL_LETTER = process.env.PIPELINE_DROPDOWN_START_COL || 'B'
const END_COL_LETTER = process.env.PIPELINE_DROPDOWN_END_COL || 'ZZ'

const READ_RANGE = `${DROPDOWN_TAB}!${START_COL_LETTER}${HEADER_ROW}:${END_COL_LETTER}2000`
const CACHE_FILE = process.env.PIPELINE_DROPDOWN_CACHE_PATH
  || path.join(process.cwd(), '..', 'data', 'pipeline', 'dropdowns', 'catalog.json')

type SheetMeta = { sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> }
type SheetValuesResponse = { values?: string[][] }

function nowIso() {
  return new Date().toISOString()
}

function normalizeKey(input: string) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
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

async function persistCatalog(catalog: PipelineDropdownCatalog) {
  if (isPostgresPipelineStoreEnabled()) {
    try {
      return await upsertPipelineDropdownCatalogInPostgres(catalog)
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[pipeline-dropdown-sync] Postgres catalog write failed; using file fallback', error)
    }
  }

  writeFileCache(catalog)
  return catalog
}

async function readPersistedCatalog(): Promise<PipelineDropdownCatalog | null> {
  if (isPostgresPipelineStoreEnabled()) {
    try {
      const catalog = await readPipelineDropdownCatalogFromPostgres()
      if (catalog) return catalog
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[pipeline-dropdown-sync] Postgres catalog read failed; using file fallback', error)
    }
  }

  return readFileCache()
}

async function sheetGet(pathname: string) {
  const res = await matonFetch(pathname)
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text.slice(0, 2000) } }
  if (!res.ok) throw new Error(`Sheets GET failed (${res.status})`)
  return data
}

async function sheetPost(pathname: string, body: unknown) {
  const res = await matonFetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text.slice(0, 2000) } }
  if (!res.ok) throw new Error(`Sheets POST failed (${res.status})`)
  return data
}

async function sheetWrite(pathname: string, method: 'POST' | 'PUT', body: unknown) {
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

async function getSheetIdByTitle(title: string): Promise<number> {
  const meta = await sheetGet(`/google-sheets/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`) as SheetMeta
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
  const keys = Object.keys(catalog.dropdowns || {}).sort((a, b) => a.localeCompare(b))
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

async function fetchDropdownsFromSheet() {
  const encoded = encodeURIComponent(READ_RANGE)
  const data = await sheetGet(`/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${encoded}`) as SheetValuesResponse
  return parseColumnarValues(data.values || [])
}

export async function pullDropdownsFromSheet() {
  const runId = `pull-${Date.now()}`
  try {
    const catalog = await fetchDropdownsFromSheet()
    await persistCatalog(catalog)
    logPipelineEvent({
      module: 'pipeline-dropdown-sync',
      action: 'pull',
      result: 'ok',
      detail: { runId, dropdownCount: Object.keys(catalog.dropdowns).length },
    })

    return { runId, catalog }
  } catch (e: unknown) {
    logPipelineEvent({ module: 'pipeline-dropdown-sync', action: 'pull', result: 'error', detail: { runId, error: String(e) } })
    throw e
  }
}

export async function getDropdownCatalog(input: { forceRefresh?: boolean; maxAgeMs?: number } = {}) {
  const cached = await readPersistedCatalog()
  const maxAgeMs = Math.max(0, Number(input.maxAgeMs ?? process.env.PIPELINE_DROPDOWN_CACHE_MAX_AGE_MS ?? 300_000))
  const cachedAt = cached?.syncedAt ? Date.parse(cached.syncedAt) : Number.NaN
  const fresh = cached && Number.isFinite(cachedAt) && Date.now() - cachedAt <= maxAgeMs

  if (!input.forceRefresh && fresh) {
    return { runId: 'cache', catalog: cached, storage: isPostgresPipelineStoreEnabled() ? 'postgres' : 'file', stale: false }
  }

  try {
    const pulled = await pullDropdownsFromSheet()
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

export async function pushDropdownsToSheet(input: PipelineDropdownCatalog) {
  const runId = `push-${Date.now()}`
  try {
    const sheetId = await getSheetIdByTitle(DROPDOWN_TAB)

    // Pull current first to preserve unknown/manually-added columns
    const existing = await fetchDropdownsFromSheet()
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
      `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(clearRangeA1)}:clear`,
      'POST',
      {},
    )

    await sheetWrite(
      `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(rangeA1)}?valueInputOption=USER_ENTERED`,
      'PUT',
      { range: rangeA1, majorDimension: 'ROWS', values: rows },
    )

    // copy formatting + validation from first dropdown column template
    await sheetPost(`/google-sheets/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
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
    })

    // lightweight metadata hashes in log only (no secret output)
    const hashes = keys.map((k) => ({ key: k, hash: hashCatalogEntry(k, (merged.dropdowns[k] || []).map((x) => x.value)) }))

    await persistCatalog(merged)
    logPipelineEvent({
      module: 'pipeline-dropdown-sync',
      action: 'push',
      result: 'ok',
      detail: { runId, dropdownCount: keys.length, hashes },
    })

    return { runId, catalog: merged }
  } catch (e: unknown) {
    logPipelineEvent({ module: 'pipeline-dropdown-sync', action: 'push', result: 'error', detail: { runId, error: String(e) } })
    throw e
  }
}
