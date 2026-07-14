import fs from 'fs/promises'
import path from 'path'
import { googleSheetsJson, type GoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspaceClient'
import { resolveManagedGoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspace'
import { matonFetch } from '@/lib/maton'
import { shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import {
  DEFAULT_PIPELINE_SHEET_ID,
  isPostgresPipelineStoreEnabled,
  resolvePipelineSheetBindingInPostgres,
  upsertPipelineProjectionInPostgres,
  type PipelineSheetContext,
  type PipelineProjection,
} from '@/lib/persistence/pipeline'
import {
  ensurePipelineCrmHierarchy,
  listCrmRecordsInPostgres,
  readCrmSummaryFromPostgres,
  stageCrmRecordInPostgres,
} from '@/lib/persistence/crm'
import type { CrmOrganization } from '@/lib/crm/types'

type SheetValuesResponse = {
  values?: string[][]
}

type PipelineSyncContext = PipelineSheetContext & {
  legacyOwnerFallback?: boolean
  actorEmail?: string
}

const RANGES = {
  opportunities: 'Opportunities!A5:M2000',
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

async function readRange(
  sheetId: string,
  range: string,
  managedRuntime?: GoogleWorkspaceRuntime,
): Promise<string[][]> {
  if (managedRuntime) {
    const parsed = await googleSheetsJson<SheetValuesResponse>(
      managedRuntime,
      `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    )
    return Array.isArray(parsed.values) ? parsed.values : []
  }
  const response = await matonFetch(
    `/google-sheets/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
  )
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Pipeline Sheet read failed for ${range} (${response.status}): ${text.slice(0, 1000)}`)
  }

  const parsed = text ? JSON.parse(text) as SheetValuesResponse : {}
  return Array.isArray(parsed.values) ? parsed.values : []
}

function mapOpportunity(row: string[], index: number, syncedAt: string, sheetId: string) {
  const rowNumber = index + 5
  const sourceKey = String(row[0] || '').trim() || `sheet:${sheetId}:opportunities:${rowNumber}`
  return {
    id: sourceKey,
    sourceKey,
    sheetRowNumber: rowNumber,
    priority: String(row[1] || '').trim(),
    name: String(row[2] || '').trim(),
    owner: String(row[3] || '').trim(),
    organization: String(row[4] || '').trim(),
    status: String(row[5] || '').trim(),
    stage: String(row[6] || '').trim(),
    lossReason: String(row[7] || '').trim(),
    source: String(row[8] || '').trim(),
    valueRaw: String(row[9] || '').trim(),
    value: parseMoney(row[9]),
    probabilityRaw: String(row[10] || '').trim(),
    probability: parsePercent(row[10]),
    expectedClose: String(row[11] || '').trim(),
    notes: String(row[12] || '').trim(),
    updatedAt: syncedAt,
  }
}

function normalizedName(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

async function stageOpportunityRows(input: PipelineSyncContext, opportunities: ReturnType<typeof mapOpportunity>[]) {
  if (!input.actorEmail) throw new Error('Signed-in user context is required for CRM synchronization')
  const hierarchy = await ensurePipelineCrmHierarchy({
    pipelineId: input.pipelineId,
    actorEmail: input.actorEmail,
  })
  const existingOrganizations = await listCrmRecordsInPostgres({
    pipelineId: input.pipelineId,
    entity: 'organizations',
    limit: 1000,
  }) as CrmOrganization[]
  const organizations = new Map(existingOrganizations.map((record) => [normalizedName(record.name), record]))
  for (const opportunity of opportunities) {
    const organizationName = opportunity.organization
    if (!organizationName) continue
    let organization = organizations.get(normalizedName(organizationName))
    if (!organization) {
      const sourceKey = `sheet:${input.sheetId}:organization:${normalizedName(organizationName)}`
      const staged = await stageCrmRecordInPostgres({
        entity: 'organizations',
        pipelineId: input.pipelineId,
        sourceKey,
        sourceSheetId: input.sheetId,
        sourcePayload: { source: 'opportunities-sheet', organization: organizationName },
        actorEmail: input.actorEmail,
        fields: {
          name: organizationName,
          parentOrganizationId: hierarchy.customerParent.id,
          parentOrganizationSuiteCrmId: hierarchy.customerParent.suiteCrmId,
          relationshipType: 'customer',
        },
      })
      organization = {
        id: staged.id,
        suiteCrmId: staged.suiteCrmId,
        name: organizationName,
      } as CrmOrganization
      organizations.set(normalizedName(organizationName), organization)
    }
    await stageCrmRecordInPostgres({
      entity: 'opportunities',
      pipelineId: input.pipelineId,
      sourceKey: opportunity.sourceKey,
      sourceSheetId: input.sheetId,
      sourceRowNumber: opportunity.sheetRowNumber,
      sourcePayload: { source: 'opportunities-sheet' },
      actorEmail: input.actorEmail,
      fields: {
        organizationId: organization.id,
        organizationSuiteCrmId: organization.suiteCrmId,
        priority: opportunity.priority,
        name: opportunity.name,
        owner: opportunity.owner,
        organization: organizationName,
        status: opportunity.status,
        stage: opportunity.stage,
        lossReason: opportunity.lossReason,
        source: opportunity.source,
        value: opportunity.value,
        probability: opportunity.probability,
        expectedClose: opportunity.expectedClose || null,
        notes: opportunity.notes,
      },
    })
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

export async function syncPipelineFromSheets(input?: PipelineSyncContext): Promise<{
  ok: true
  syncedAt: string
  summary: Record<string, number>
  projectionStorage: 'postgres' | 'file' | 'file-fallback'
  rawCounts: Record<string, number>
}> {
  const postgresEnabled = isPostgresPipelineStoreEnabled()
  if (postgresEnabled && !input) {
    throw new Error('Pipeline and Sheet context are required for Postgres sync')
  }
  const sheetId = input?.sheetId || DEFAULT_PIPELINE_SHEET_ID
  let managedRuntime: GoogleWorkspaceRuntime | undefined
  if (postgresEnabled && input) {
    const binding = await resolvePipelineSheetBindingInPostgres(input)
    if (!binding.legacyOwnerFallback) {
      if (!binding.googleServiceAccountEmail || !binding.googleSharedDriveId) {
        throw new Error('Managed pipeline is missing its native Google Workspace binding')
      }
      managedRuntime = await resolveManagedGoogleWorkspaceRuntime({
        serviceAccountEmail: binding.googleServiceAccountEmail,
        sharedDriveId: binding.googleSharedDriveId,
      })
    }
  }
  const syncedAt = nowIso()
  const opportunityRows = await readRange(sheetId, RANGES.opportunities, managedRuntime)

  const opportunities = opportunityRows
    .map((row, index) => mapOpportunity(row, index, syncedAt, sheetId))
    .filter((opportunity) => opportunity.name)
  if (postgresEnabled && input) await stageOpportunityRows(input, opportunities)
  const crmSummary = postgresEnabled && input
    ? await readCrmSummaryFromPostgres(input.pipelineId)
    : null
  const closed = new Set(['abandoned', 'loss', 'lost', 'won', 'closed', 'closed-lost', 'closed-won'])

  const summary = {
    opportunities: opportunities.length,
    organizations: crmSummary?.organizations || 0,
    contacts: crmSummary?.contacts || 0,
    totalOpenValue: Math.round(opportunities
      .filter((opportunity) => !closed.has(opportunity.status.toLowerCase()))
      .reduce((total, opportunity) => total + opportunity.value, 0) * 100) / 100,
  }
  const projection: PipelineProjection = {
    syncedAt,
    source: {
      provider: managedRuntime ? 'native-google-sheets' : 'maton-google-sheets',
      pipelineId: input?.pipelineId || null,
      ranges: RANGES,
    },
    summary,
    opportunities,
  }
  const rawCounts = {
    opportunityRows: opportunityRows.length,
    organizationRows: crmSummary?.organizations || 0,
    contactRows: crmSummary?.contacts || 0,
    normalizedOpportunities: opportunities.length,
  }
  const raw = { syncedAt, pipelineId: input?.pipelineId || null, sheetId, counts: rawCounts }

  if (postgresEnabled && input) {
    try {
      await upsertPipelineProjectionInPostgres({
        pipelineId: input.pipelineId,
        sheetId: input.sheetId,
        projection,
      })
      return { ok: true, syncedAt, summary, projectionStorage: 'postgres', rawCounts }
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError() || !input.legacyOwnerFallback) throw error
      console.warn('[pipeline-sync] Postgres projection write failed; using file fallback', error)
      await writeFileProjection(projection, raw)
      return { ok: true, syncedAt, summary, projectionStorage: 'file-fallback', rawCounts }
    }
  }

  await writeFileProjection(projection, raw)
  return { ok: true, syncedAt, summary, projectionStorage: 'file', rawCounts }
}
