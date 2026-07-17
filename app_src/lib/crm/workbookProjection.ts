import {
  applyPipelineWorkbookBranding,
  configurePipelineTabs,
} from '@/lib/pipelineProvisioning'
import { readPipelineWorkbookBranding } from '@/lib/organizationBranding'
import { configureLegacyPipelineTabs } from '@/lib/pipelineLegacyWorkbook'
import { resolveManagedGoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspace'
import { googleSheetsJson, type GoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspaceClient'
import { matonFetch } from '@/lib/maton'
import {
  beginCrmSyncRun,
  finishCrmSyncRun,
  listCrmRecordsInPostgres,
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

function interactionRow(
  record: CrmInteraction,
  contacts: Map<string, string>,
  opportunities: Map<string, string>,
): unknown[] {
  return [
    record.sourceKey, '', record.subject, '', record.organizationName, record.agentName, record.occurredAt || '',
    record.opportunityId ? opportunities.get(record.opportunityId) || '' : '',
    record.contactId ? contacts.get(record.contactId) || '' : '',
    record.description,
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
    if (runtime) {
      await configurePipelineTabs(runtime, input.context.sheetId)
      await applyPipelineWorkbookBranding(
        runtime,
        input.context.sheetId,
        await readPipelineWorkbookBranding(input.context.pipelineId),
      )
    } else await configureLegacyPipelineTabs(input.context.sheetId)
    const [organizations, contacts, opportunities, interactions] = await Promise.all([
      listCrmRecordsInPostgres({ pipelineId: input.context.pipelineId, entity: 'organizations', limit: 1000 }) as Promise<CrmOrganization[]>,
      listCrmRecordsInPostgres({ pipelineId: input.context.pipelineId, entity: 'contacts', limit: 1000 }) as Promise<CrmContact[]>,
      listCrmRecordsInPostgres({ pipelineId: input.context.pipelineId, entity: 'opportunities', limit: 1000 }) as Promise<CrmOpportunity[]>,
      listCrmRecordsInPostgres({ pipelineId: input.context.pipelineId, entity: 'interactions', limit: 1000 }) as Promise<CrmInteraction[]>,
    ])
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
    const counts = {
      organizations: organizations.length,
      contacts: contacts.length,
      opportunities: opportunities.length,
      interactions: interactions.length,
    }
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
