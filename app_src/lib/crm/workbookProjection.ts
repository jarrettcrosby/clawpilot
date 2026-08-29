import {
  applyPipelineWorkbookBranding,
  configurePipelineTabs,
} from '@/lib/pipelineProvisioning'
import { readPipelineWorkbookBranding } from '@/lib/organizationBranding'
import {
  applyLegacyPipelineWorkbookBranding,
  configureLegacyPipelineTabs,
} from '@/lib/pipelineLegacyWorkbook'
import { resolveManagedGoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspace'
import { googleSheetsJson, type GoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspaceClient'
import { matonFetch } from '@/lib/maton'
import {
  beginCrmSyncRun,
  finishCrmSyncRun,
  readCrmWorkbookProjectionSnapshotInPostgres,
  readCrmWorkbookProjectionReadiness,
} from '@/lib/persistence/crm'
import {
  resolvePipelineSheetBindingInPostgres,
  type PipelineSheetContext,
} from '@/lib/persistence/pipeline'
import { query } from '@/lib/persistence/postgres'
import type {
  CrmContact,
  CrmInteraction,
  CrmOpportunity,
  CrmOrganization,
} from '@/lib/crm/types'

const PROJECTED_TABS = ['Organizations', 'Contacts', 'Opportunities', 'Interactions'] as const

async function clearRange(
  context: PipelineSheetContext,
  range: string,
  runtime: GoogleWorkspaceRuntime | null,
) {
  if (runtime) {
    await googleSheetsJson(runtime, `/v4/spreadsheets/${context.sheetId}/values/${encodeURIComponent(range)}:clear`, {
      method: 'POST',
      body: {},
      idempotent: true,
    })
    return
  }
  const response = await matonFetch(
    `/google-sheets/v4/spreadsheets/${context.sheetId}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  )
  if (!response.ok) throw new Error(`CRM workbook clear failed for ${range} (${response.status})`)
}

async function writeRows(
  context: PipelineSheetContext,
  range: string,
  values: unknown[][],
  runtime: GoogleWorkspaceRuntime | null,
) {
  if (values.length === 0) return
  const payload = { range, majorDimension: 'ROWS', values }
  if (runtime) {
    await googleSheetsJson(runtime, `/v4/spreadsheets/${context.sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body: payload,
      idempotent: true,
    })
    return
  }
  const response = await matonFetch(
    `/google-sheets/v4/spreadsheets/${context.sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
  )
  if (!response.ok) throw new Error(`CRM workbook write failed for ${range} (${response.status})`)
}

function organizationRow(record: CrmOrganization): unknown[] {
  return [
    record.sourceKey, record.priority, record.name, record.accountManager, record.accountType,
    record.syncStatus, '', record.website, record.phone, record.address, record.city, record.state,
    record.description, record.parentOrganizationName, record.relationshipType,
  ]
}

function contactRow(record: CrmContact): unknown[] {
  return [
    record.sourceKey, record.priority, record.fullName, record.accountManager, record.organizationName,
    record.jobTitle, record.email, record.phoneWork || record.phoneMobile, record.syncStatus, '', '', '',
    record.description,
  ]
}

function opportunityRow(record: CrmOpportunity): unknown[] {
  return [
    record.sourceKey, record.priority, record.name, record.owner, record.organization, record.status,
    record.stage, record.lossReason, record.source, record.value, record.probability,
    record.expectedClose, record.notes,
  ]
}

export function googleSheetsDateTime(value: string | null | undefined): number | '' {
  const timestamp = Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp)) return ''
  // configurePipelineTabs pins managed workbooks to Etc/UTC, so the serial's
  // wall-clock value and all Sheet calendar-month formulas are deterministic.
  return (timestamp / 86_400_000) + 25_569
}

function workbookInteractionType(record: CrmInteraction) {
  const normalized = record.interactionType.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  if (['meeting', 'meetings', 'in person'].includes(normalized)) return 'In Person'
  if (['linkedin', 'linked in'].includes(normalized)) return 'LinkedIn'
  if (['direct mail', 'directmail'].includes(normalized)) return 'Direct Mail'
  if (['email', 'emails', 'e mail'].includes(normalized)) return 'Email'
  if (['call', 'calls', 'phone', 'phone call'].includes(normalized)) return 'Call'
  if (['campaign', 'campaigns'].includes(normalized)) return 'Campaign'
  if (['note', 'notes'].includes(normalized)) return 'Note'
  return record.interactionType || 'Note'
}

function interactionRow(
  record: CrmInteraction,
  contacts: Map<string, string>,
  opportunities: Map<string, string>,
): unknown[] {
  const interactionType = workbookInteractionType(record)
  const notes = [record.subject && record.subject !== interactionType ? record.subject : '', record.description]
    .filter(Boolean)
    .join(' — ')
  return [
    record.sourceKey, '', interactionType, '', record.organizationName, record.agentName, googleSheetsDateTime(record.occurredAt),
    record.opportunityId ? opportunities.get(record.opportunityId) || '' : '',
    record.contactId ? contacts.get(record.contactId) || '' : '',
    notes,
  ]
}

export async function projectCrmWorkbook(input: {
  context: PipelineSheetContext
  actorEmail: string
}) {
  const readiness = await readCrmWorkbookProjectionReadiness(input.context.pipelineId)
  if (!readiness.ready) {
    throw new Error(`CRM workbook projection is waiting for reconciliation (${readiness.unresolved} unresolved records)`)
  }
  const projection = await readCrmWorkbookProjectionSnapshotInPostgres({
    pipelineId: input.context.pipelineId,
  })
  const binding = await resolvePipelineSheetBindingInPostgres(input.context)
  const runtime = binding.legacyOwnerFallback
    ? null
    : await resolveManagedGoogleWorkspaceRuntime({
        serviceAccountEmail: binding.googleServiceAccountEmail || '',
        sharedDriveId: binding.googleSharedDriveId || '',
      })
  const runId = await beginCrmSyncRun({
    pipelineId: input.context.pipelineId,
    direction: 'crm_to_sheet',
    sourceSystem: 'suitecrm',
    targetSystem: 'google_sheets',
    actorEmail: input.actorEmail,
  })
  try {
    const branding = await readPipelineWorkbookBranding(input.context.pipelineId)
    const dataRowCounts = {
      Organizations: projection.counts.organizations,
      Contacts: projection.counts.contacts,
      Opportunities: projection.counts.opportunities,
      Interactions: projection.counts.interactions,
    }
    if (runtime) {
      await configurePipelineTabs(runtime, input.context.sheetId, dataRowCounts)
      await applyPipelineWorkbookBranding(
        runtime,
        input.context.sheetId,
        branding,
      )
    } else {
      await configureLegacyPipelineTabs(input.context.sheetId, dataRowCounts)
      await applyLegacyPipelineWorkbookBranding(input.context.sheetId, branding)
    }
    const { organizations, contacts, opportunities, interactions } = projection
    const contactNames = new Map(contacts.map((record) => [record.id, record.fullName]))
    const opportunityNames = new Map(opportunities.map((record) => [record.id, record.name]))
    const rows: Record<(typeof PROJECTED_TABS)[number], unknown[][]> = {
      Organizations: organizations.map(organizationRow),
      Contacts: contacts.map(contactRow),
      Opportunities: opportunities.map(opportunityRow),
      Interactions: interactions.map((record) => interactionRow(record, contactNames, opportunityNames)),
    }
    for (const tab of PROJECTED_TABS) {
      await clearRange(input.context, `'${tab}'!A5:Z20000`, runtime)
      await writeRows(input.context, `'${tab}'!A5`, rows[tab], runtime)
    }
    await query(
      'UPDATE pipeline_spaces SET crm_last_synced_at = now(), updated_at = now() WHERE id = $1::uuid AND sheet_id = $2',
      [input.context.pipelineId, input.context.sheetId],
    )
    const counts = projection.counts
    await finishCrmSyncRun({ id: runId, status: 'succeeded', counts })
    return { ok: true as const, counts }
  } catch (error) {
    await finishCrmSyncRun({
      id: runId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
