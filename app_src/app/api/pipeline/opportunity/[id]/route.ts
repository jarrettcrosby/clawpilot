import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { matonFetch } from '@/lib/maton'
import { logPipelineEvent } from '@/lib/pipelineLog'
import { getErrorMessage } from '@/lib/errorUtils'

const SHEET_ID = '1sp-eLYEEGera1acBoze_GvR4263dunlmaOUyBej-iqY'
const PIPELINE_FILE = process.env.PIPELINE_NORMALIZED_PATH || path.join(process.cwd(), '..', 'data', 'pipeline', 'normalized', 'current.json')

async function getSheetValues(range: string) {
  const res = await matonFetch(`/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`)
  if (!res.ok) throw new Error(await res.text())
  return await res.json()
}

type OpportunityRecord = Record<string, unknown>

async function resolveOpportunityRow(current: OpportunityRecord, fallbackRow: number): Promise<number> {
  try {
    const out = await getSheetValues('Opportunities!B5:M2000')
    const rows = Array.isArray(out?.values) ? out.values : []
    const targetName = String(current?.name || '').trim().toLowerCase()
    const targetOrg = String(current?.organization || current?.org || '').trim().toLowerCase()
    const targetOwner = String(current?.owner || '').trim().toLowerCase()

    let best = -1
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || []
      const name = String(r[1] || '').trim().toLowerCase()
      const owner = String(r[2] || '').trim().toLowerCase()
      const org = String(r[3] || '').trim().toLowerCase()
      if (!name) continue
      const nameMatch = targetName && name === targetName
      const orgMatch = targetOrg && org === targetOrg
      const ownerMatch = targetOwner && owner === targetOwner
      if (nameMatch && orgMatch && ownerMatch) { best = i; break }
      if (best < 0 && nameMatch && orgMatch) best = i
      if (best < 0 && nameMatch && ownerMatch) best = i
      if (best < 0 && nameMatch) best = i
    }

    if (best >= 0) return 5 + best
    return fallbackRow
  } catch {
    return fallbackRow
  }
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function money(v: number | string | undefined) {
  const n = toFiniteNumber(v, 0)
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pct(v: number | string | undefined) {
  const n = toFiniteNumber(v, 0)
  const clamped = Math.max(0, Math.min(100, n))
  return `${clamped.toFixed(1)}%`
}

async function writeSheet(range: string, values: unknown[][], retries = 3, mode: 'update' | 'append' = 'update') {
  let lastErr = ''
  for (let attempt = 1; attempt <= retries; attempt++) {
    const endpoint = mode === 'append'
      ? `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
      : `/google-sheets/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`

    const res = await matonFetch(endpoint, {
      method: mode === 'append' ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
    })

    if (res.ok) return
    lastErr = await res.text()
    if (attempt < retries) await new Promise(r => setTimeout(r, 250 * attempt))
  }

  throw new Error(lastErr || 'Sheet write failed after retries')
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const body = await req.json()
    const action = String(body.action || '')

    if (action !== 'interaction') {
      return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
    }

    if (!fs.existsSync(PIPELINE_FILE)) return NextResponse.json({ error: 'Pipeline data not synced yet' }, { status: 400 })
    const data = JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf-8'))
    const rows = Array.isArray(data.opportunities) ? data.opportunities : []
    const opp = rows.find((r: OpportunityRecord) => r.id === id)
    if (!opp) return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })

    const range = 'Interactions!B:I'
    const values = [[
      opp.priority || 'C',
      String(body.interaction || 'Note'),
      opp.owner || 'Jarrett Crosby',
      String(body.agent || 'ClawPilot'),
      String(body.date || new Date().toLocaleDateString('en-US')),
      opp.name || '',
      String(body.contact || ''),
      String(body.notes || ''),
    ]]

    await writeSheet(range, values, 3, 'append')
    logPipelineEvent({ module: 'pipeline-interaction', action: 'append', recordId: id, result: 'ok' })
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    logPipelineEvent({ module: 'pipeline-interaction', action: 'append', result: 'error', detail: String(e) })
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!fs.existsSync(PIPELINE_FILE)) {
      logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', result: 'error', detail: 'pipeline not synced' })
      return NextResponse.json({ error: 'Pipeline data not synced yet' }, { status: 400 })
    }

    const { id } = await ctx.params
    const updates = await req.json()

    const data = JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf-8'))
    const rows = Array.isArray(data.opportunities) ? data.opportunities : []
    const idx = rows.findIndex((r: OpportunityRecord) => r.id === id)
    if (idx === -1) return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })

    const current = rows[idx]

    // Conflict check
    if (updates.expectedUpdatedAt && current.updatedAt && updates.expectedUpdatedAt !== current.updatedAt) {
      logPipelineEvent({
        module: 'pipeline-opportunity',
        action: 'patch',
        recordId: id,
        result: 'conflict',
        detail: { expected: updates.expectedUpdatedAt, current: current.updatedAt },
      })
      return NextResponse.json({
        error: 'Conflict: record changed since load',
        conflict: true,
        current,
      }, { status: 409 })
    }

    let nextNotes = updates.notes !== undefined ? String(updates.notes || '') : String(current.notes || '')
    if (updates.appendComment) {
      const actor = String(updates.actor || 'Jarrett')
      const msg = String(updates.appendComment || '').trim()
      if (msg) {
        const t = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false })
        const line = `[${t} ET] [${actor}] ${msg}`
        nextNotes = nextNotes ? `${nextNotes}\n${line}` : line
      }
    }

    const merged = {
      ...current,
      ...updates,
      notes: nextNotes,
      value: updates.value !== undefined
        ? toFiniteNumber(updates.value, toFiniteNumber(current.value, 0))
        : toFiniteNumber(current.value, 0),
      probability: updates.probability !== undefined
        ? Math.max(0, Math.min(100, toFiniteNumber(updates.probability, toFiniteNumber(current.probability, 0))))
        : Math.max(0, Math.min(100, toFiniteNumber(current.probability, 0))),
      // Keep org aliases in sync so UI never drops to Unknown Organization due to key mismatch.
      org: (updates.organization ?? updates.org ?? current.org ?? current.organization ?? ''),
      organization: (updates.organization ?? updates.org ?? current.organization ?? current.org ?? ''),
      updatedAt: new Date().toISOString(),
    }

    const actor = String(updates.actor || 'Jarrett')
    const baseActivity = {
      module: 'pipeline',
      recordId: id,
      result: 'ok' as const,
      actor,
      changedBy: actor,
      opportunityName: String(merged.name || current.name || ''),
      organization: String(merged.organization || merged.org || current.organization || current.org || ''),
    }

    const fallbackRow = 4 + Number(String(id).replace('opp_', ''))
    const rowNum = await resolveOpportunityRow(current, fallbackRow)
    const range = `Opportunities!B${rowNum}:M${rowNum}`

    const values = [[
      merged.priority || '',
      merged.name || '',
      merged.owner || '',
      merged.organization || merged.org || '',
      merged.status || '',
      merged.stage || '',
      merged.lossReason || '',
      merged.source || '',
      money(merged.value),
      pct(merged.probability),
      merged.closeDate || merged.expectedClose || '',
      merged.notes || '',
    ]]

    try {
      await writeSheet(range, values, 3)
    } catch (e: unknown) {
      logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', recordId: id, result: 'error', detail: String(e) })
      return NextResponse.json({ error: 'Sheet write failed', detail: String(e).slice(0, 4000) }, { status: 500 })
    }

    rows[idx] = merged
    data.opportunities = rows
    fs.writeFileSync(PIPELINE_FILE, JSON.stringify(data, null, 2))

    logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', recordId: id, result: 'ok' })

    if (updates.stage !== undefined && String(updates.stage) !== String(current.stage || '')) {
      logPipelineEvent({
        ...baseActivity,
        action: 'stage-change',
        activityType: 'moved',
        fromStage: String(current.stage || ''),
        toStage: String(updates.stage || ''),
        message: `Stage changed from ${String(current.stage || '—')} to ${String(updates.stage || '—')}`,
      })
    }

    const changedKeys = ['priority', 'status', 'owner', 'source', 'lossReason', 'value', 'probability', 'closeDate', 'expectedClose']
      .filter((k) => updates[k] !== undefined && String(updates[k]) !== String(current[k] ?? ''))

    logPipelineEvent({
      ...baseActivity,
      action: 'update',
      activityType: 'updated',
      message: changedKeys.length > 0 ? `Opportunity updated (${changedKeys.join(', ')})` : 'Opportunity saved',
      detail: { changedKeys },
    })

    if (updates.appendComment) {
      const msg = String(updates.appendComment || '').trim()
      if (msg) {
        logPipelineEvent({
          ...baseActivity,
          action: 'comment',
          activityType: 'comment',
          message: `Note added: "${msg.slice(0, 80)}${msg.length > 80 ? '...' : ''}"`,
        })
      }
    }

    return NextResponse.json({ ok: true, opportunity: merged })
  } catch (error: unknown) {
    const detail = getErrorMessage(error)
    logPipelineEvent({ module: 'pipeline-opportunity', action: 'patch', result: 'error', detail })
    return NextResponse.json({ error: detail }, { status: 500 })
  }
}
