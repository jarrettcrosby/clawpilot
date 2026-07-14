import { resolveManagedGoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspace'
import { googleSheetsJson, type GoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspaceClient'
import { matonFetch } from '@/lib/maton'
import {
  beginCrmSyncRun,
  ensurePipelineCrmHierarchy,
  finishCrmSyncRun,
  stageCrmRecordInPostgres,
} from '@/lib/persistence/crm'
import {
  resolvePipelineSheetBindingInPostgres,
  type PipelineSheetContext,
} from '@/lib/persistence/pipeline'
import { testSuiteCrmConnection } from '@/lib/crm/suiteCrmClient'

const TABS = ['Organizations', 'Contacts', 'Opportunities', 'Interactions'] as const
type ImportTab = (typeof TABS)[number]
type SourceRecord = { rowNumber: number; values: Record<string, string>; raw: Record<string, string> }

function clean(value: unknown) {
  return String(value ?? '').trim()
}

function normalizedHeader(value: unknown) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function normalizedName(value: unknown) {
  return clean(value).toLowerCase().replace(/\s+/g, ' ')
}

function pick(record: SourceRecord, ...aliases: string[]) {
  for (const alias of aliases) {
    const value = record.values[normalizedHeader(alias)]
    if (clean(value)) return clean(value)
  }
  return ''
}

function numberValue(value: unknown) {
  const parsed = Number(clean(value).replace(/[$,%]/g, '').replaceAll(',', '') || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function dateValue(value: unknown) {
  const raw = clean(value)
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

function dateTimeValue(value: unknown) {
  const raw = clean(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function splitName(fullName: string) {
  const normalized = clean(fullName)
  if (!normalized) return { firstName: '', lastName: '' }
  if (normalized.includes(',')) {
    const [lastName, ...first] = normalized.split(',')
    return { firstName: clean(first.join(' ')), lastName: clean(lastName) }
  }
  const parts = normalized.split(/\s+/)
  if (parts.length === 1) return { firstName: '', lastName: parts[0] }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

async function readValues(
  sheetId: string,
  range: string,
  managedRuntime: GoogleWorkspaceRuntime | null,
) {
  if (managedRuntime) {
    const response = await googleSheetsJson<{ values?: unknown[][] }>(
      managedRuntime,
      `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    )
    return Array.isArray(response.values) ? response.values : []
  }
  const response = await matonFetch(`/google-sheets/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`)
  const raw = await response.text()
  if (!response.ok) throw new Error(`CRM workbook read failed for ${range} (${response.status})`)
  const parsed = raw ? JSON.parse(raw) as { values?: unknown[][] } : {}
  return Array.isArray(parsed.values) ? parsed.values : []
}

function recordsFromValues(values: unknown[][]): SourceRecord[] {
  const headers = (values[0] || []).map((value) => clean(value))
  return values.slice(1).flatMap((row, index) => {
    const raw: Record<string, string> = {}
    const normalized: Record<string, string> = {}
    headers.forEach((header, column) => {
      if (!header) return
      raw[header] = clean(row[column])
      normalized[normalizedHeader(header)] = clean(row[column])
    })
    return Object.values(normalized).some(Boolean)
      ? [{ rowNumber: index + 5, values: normalized, raw }]
      : []
  })
}

async function sourceTabs(context: PipelineSheetContext) {
  const binding = await resolvePipelineSheetBindingInPostgres(context)
  const managedRuntime = binding.legacyOwnerFallback
    ? null
    : await resolveManagedGoogleWorkspaceRuntime({
        serviceAccountEmail: binding.googleServiceAccountEmail || '',
        sharedDriveId: binding.googleSharedDriveId || '',
      })
  const entries = await Promise.all(TABS.map(async (tab) => [
    tab,
    recordsFromValues(await readValues(context.sheetId, `${tab}!A4:Z2000`, managedRuntime)),
  ] as const))
  return Object.fromEntries(entries) as Record<ImportTab, SourceRecord[]>
}

export async function inspectCrmWorkbook(context: PipelineSheetContext) {
  const tabs = await sourceTabs(context)
  return {
    tabs,
    counts: Object.fromEntries(TABS.map((tab) => [tab.toLowerCase(), tabs[tab].length])) as Record<string, number>,
    headers: Object.fromEntries(TABS.map((tab) => [tab.toLowerCase(), Object.keys(tabs[tab][0]?.raw || {})])) as Record<string, string[]>,
  }
}

function sourceKey(sheetId: string, tab: ImportTab, record: SourceRecord) {
  return pick(record, 'ClawPilot Record ID') || `sheet:${sheetId}:${tab.toLowerCase()}:${record.rowNumber}`
}

function uniqueSourceRecords(records: SourceRecord[], identity: (record: SourceRecord) => string) {
  const unique = new Map<string, SourceRecord>()
  for (const record of records) {
    const key = identity(record)
    if (key) unique.set(key, record)
  }
  return [...unique.values()]
}

function organizationSourceIdentity(record: SourceRecord) {
  return normalizedName(pick(record, 'Name', 'Organization', 'Organization Name'))
}

function contactSourceIdentity(record: SourceRecord) {
  const email = normalizedName(pick(record, 'Email', 'Email Address'))
  if (email) return `email:${email}`
  const name = normalizedName(pick(record, 'Name', 'Contact', 'Contact Name', 'Full Name', 'Full Name (First, Last)'))
  const organization = normalizedName(pick(record, 'Organization', 'Account', 'Company'))
  return name ? `name:${name}:organization:${organization || 'none'}` : ''
}

export async function importCrmWorkbook(input: {
  context: PipelineSheetContext
  actorEmail: string
}) {
  await testSuiteCrmConnection()
  const runId = await beginCrmSyncRun({
    pipelineId: input.context.pipelineId,
    direction: 'sheet_to_crm',
    sourceSystem: 'google_sheets',
    targetSystem: 'suitecrm',
    actorEmail: input.actorEmail,
  })
  const counts = { organizations: 0, contacts: 0, opportunities: 0, interactions: 0 }
  try {
    const { tabs } = await inspectCrmWorkbook(input.context)
    const importTabs = {
      ...tabs,
      Organizations: uniqueSourceRecords(tabs.Organizations, organizationSourceIdentity),
      Contacts: uniqueSourceRecords(tabs.Contacts, contactSourceIdentity),
    }
    const sourceCounts = Object.fromEntries(
      TABS.map((tab) => [tab.toLowerCase(), importTabs[tab].length]),
    ) as Record<string, number>
    const duplicatesSkipped = {
      organizations: tabs.Organizations.length - importTabs.Organizations.length,
      contacts: tabs.Contacts.length - importTabs.Contacts.length,
    }
    const hierarchy = await ensurePipelineCrmHierarchy({
      pipelineId: input.context.pipelineId,
      actorEmail: input.actorEmail,
    })
    const organizations = new Map<string, { id: string; suiteCrmId: string }>()
    const contacts = new Map<string, { id: string; suiteCrmId: string }>()
    const opportunities = new Map<string, { id: string; suiteCrmId: string }>()

    for (const organization of hierarchy.lineage) {
      organizations.set(normalizedName(organization.name), {
        id: organization.id,
        suiteCrmId: organization.suiteCrmId,
      })
    }

    const knownOrganizationNames = new Set([
      ...organizations.keys(),
      ...importTabs.Organizations.map(organizationSourceIdentity).filter(Boolean),
    ])
    const derivedOrganizations = new Map<string, { name: string; record: SourceRecord; sourceTab: ImportTab }>()
    const registerReferencedOrganization = (sourceTab: ImportTab, record: SourceRecord) => {
      const name = pick(record, 'Organization', 'Account', 'Company')
      const key = normalizedName(name)
      if (!key || knownOrganizationNames.has(key) || derivedOrganizations.has(key)) return
      derivedOrganizations.set(key, { name, record, sourceTab })
    }
    importTabs.Contacts.forEach((record) => registerReferencedOrganization('Contacts', record))
    importTabs.Opportunities.forEach((record) => registerReferencedOrganization('Opportunities', record))
    importTabs.Interactions.forEach((record) => registerReferencedOrganization('Interactions', record))
    sourceCounts.organizations += derivedOrganizations.size

    for (const record of importTabs.Organizations) {
      const name = pick(record, 'Name', 'Organization', 'Organization Name')
      if (!name) continue
      const hierarchyOrganization = organizations.get(normalizedName(name))
      if (hierarchyOrganization) {
        counts.organizations += 1
        continue
      }
      const staged = await stageCrmRecordInPostgres({
        entity: 'organizations', pipelineId: input.context.pipelineId,
        sourceKey: sourceKey(input.context.sheetId, 'Organizations', record),
        sourceSheetId: input.context.sheetId, sourceRowNumber: record.rowNumber,
        sourcePayload: record.raw, actorEmail: input.actorEmail,
        fields: {
          parentOrganizationId: hierarchy.customerParent.id,
          parentOrganizationSuiteCrmId: hierarchy.customerParent.suiteCrmId,
          relationshipType: 'customer',
          priority: pick(record, 'Priority'), name,
          accountType: pick(record, 'Type', 'Account Type'),
          accountManager: pick(record, 'Acct. Manager', 'Account Manager', 'Owner'),
          website: pick(record, 'Website'), linkedinUrl: pick(record, 'LinkedIn', 'LinkedIn URL'),
          phone: pick(record, 'Phone', 'Phone Office'), address: pick(record, 'Address', 'Street'),
          city: pick(record, 'City'), state: pick(record, 'State'),
          postalCode: pick(record, 'Postal Code', 'Zip', 'Zip Code'), country: pick(record, 'Country'),
          description: pick(record, 'Notes', 'Description'),
        },
      })
      organizations.set(normalizedName(name), { id: staged.id, suiteCrmId: staged.suiteCrmId })
      counts.organizations += 1
    }

    for (const [key, derived] of derivedOrganizations) {
      const staged = await stageCrmRecordInPostgres({
        entity: 'organizations', pipelineId: input.context.pipelineId,
        sourceKey: `derived:organization:${key}`,
        sourceSheetId: input.context.sheetId, sourceRowNumber: derived.record.rowNumber,
        sourcePayload: { ...derived.record.raw, _clawpilotDerivedFrom: derived.sourceTab },
        actorEmail: input.actorEmail,
        fields: {
          parentOrganizationId: hierarchy.customerParent.id,
          parentOrganizationSuiteCrmId: hierarchy.customerParent.suiteCrmId,
          relationshipType: 'customer',
          name: derived.name,
          accountManager: pick(derived.record, 'Acct. Manager', 'Account Manager', 'Deal Owner', 'Owner'),
        },
      })
      organizations.set(key, { id: staged.id, suiteCrmId: staged.suiteCrmId })
      counts.organizations += 1
    }

    for (const record of importTabs.Contacts) {
      const fullName = pick(record, 'Name', 'Contact', 'Contact Name', 'Full Name', 'Full Name (First, Last)')
      if (!fullName) continue
      const organizationName = pick(record, 'Organization', 'Account', 'Company')
      const organization = organizations.get(normalizedName(organizationName))
      const explicitFirst = pick(record, 'First Name')
      const explicitLast = pick(record, 'Last Name')
      const split = splitName(fullName)
      const staged = await stageCrmRecordInPostgres({
        entity: 'contacts', pipelineId: input.context.pipelineId,
        sourceKey: sourceKey(input.context.sheetId, 'Contacts', record),
        sourceSheetId: input.context.sheetId, sourceRowNumber: record.rowNumber,
        sourcePayload: record.raw, actorEmail: input.actorEmail,
        fields: {
          organizationId: organization?.id || null, organizationSuiteCrmId: organization?.suiteCrmId || null,
          priority: pick(record, 'Priority'), firstName: explicitFirst || split.firstName,
          lastName: explicitLast || split.lastName, fullName,
          contactType: pick(record, 'Type', 'Contact Type'),
          accountManager: pick(record, 'Acct. Manager', 'Account Manager', 'Owner'),
          jobTitle: pick(record, 'Position', 'Title', 'Job Title'), email: pick(record, 'Email', 'Email Address'),
          linkedinUrl: pick(record, 'LinkedIn', 'LinkedIn URL'), phoneWork: pick(record, 'Phone', 'Work Phone'),
          phoneMobile: pick(record, 'Mobile', 'Cell', 'Mobile Phone'), address: pick(record, 'Address', 'Street'),
          city: pick(record, 'City'), state: pick(record, 'State'),
          postalCode: pick(record, 'Postal Code', 'Zip', 'Zip Code'), country: pick(record, 'Country'),
          description: pick(record, 'Notes', 'Description'),
        },
      })
      contacts.set(normalizedName(fullName), { id: staged.id, suiteCrmId: staged.suiteCrmId })
      counts.contacts += 1
    }

    for (const record of importTabs.Opportunities) {
      const name = pick(record, 'Name', 'Opportunity', 'Opportunity Name')
      const organizationName = pick(record, 'Organization', 'Account', 'Company')
      if (!name || !organizationName) continue
      const organization = organizations.get(normalizedName(organizationName))
      const staged = await stageCrmRecordInPostgres({
        entity: 'opportunities', pipelineId: input.context.pipelineId,
        sourceKey: sourceKey(input.context.sheetId, 'Opportunities', record),
        sourceSheetId: input.context.sheetId, sourceRowNumber: record.rowNumber,
        sourcePayload: record.raw, actorEmail: input.actorEmail,
        fields: {
          organizationId: organization?.id || null, organizationSuiteCrmId: organization?.suiteCrmId || null,
          priority: pick(record, 'Priority'), name, owner: pick(record, 'Deal Owner', 'Owner'), organization: organizationName,
          status: pick(record, 'Status'), stage: pick(record, 'Stage'), lossReason: pick(record, 'Loss Reason'),
          source: pick(record, 'Source', 'Lead Source'), value: numberValue(pick(record, 'Value', 'Amount')),
          probability: numberValue(pick(record, 'Probability')), expectedClose: dateValue(pick(record, 'Exp. Close', 'Expected Close', 'Close Date')),
          notes: pick(record, 'Notes', 'Description'),
        },
      })
      opportunities.set(normalizedName(`${organizationName}:${name}`), { id: staged.id, suiteCrmId: staged.suiteCrmId })
      counts.opportunities += 1
    }

    for (const record of importTabs.Interactions) {
      const interactionType = pick(record, 'Interaction', 'Type', 'Interaction Type')
      const notes = pick(record, 'Notes', 'Description')
      const subject = pick(record, 'Subject', 'Name') || interactionType || notes.slice(0, 100) || `Interaction ${record.rowNumber}`
      const organizationName = pick(record, 'Organization', 'Account', 'Company')
      const contactName = pick(record, 'Contact', 'Contact Name')
      const opportunityName = pick(record, 'Opportunity', 'Opportunity Name')
      const organization = organizations.get(normalizedName(organizationName))
      const contact = contacts.get(normalizedName(contactName))
      const opportunity = opportunities.get(normalizedName(`${organizationName}:${opportunityName}`))
      await stageCrmRecordInPostgres({
        entity: 'interactions', pipelineId: input.context.pipelineId,
        sourceKey: sourceKey(input.context.sheetId, 'Interactions', record),
        sourceSheetId: input.context.sheetId, sourceRowNumber: record.rowNumber,
        sourcePayload: record.raw, actorEmail: input.actorEmail,
        fields: {
          organizationId: organization?.id || null, contactId: contact?.id || null,
          opportunityId: opportunity?.id || null, parentSuiteCrmId: opportunity?.suiteCrmId || null,
          interactionType, subject, agentName: pick(record, 'Agent', 'Owner'),
          occurredAt: dateTimeValue(pick(record, 'Date', 'Occurred At', 'Timestamp')),
          description: notes,
        },
      })
      counts.interactions += 1
    }

    const incomplete = Object.entries(counts).flatMap(([entity, imported]) => {
      const source = Number(sourceCounts[entity] || 0)
      return imported === source ? [] : [`${entity}: ${imported}/${source}`]
    })
    if (incomplete.length > 0) {
      throw new Error(`CRM workbook import was incomplete (${incomplete.join(', ')})`)
    }
    await finishCrmSyncRun({ id: runId, status: 'succeeded', counts })
    return {
      runId,
      counts,
      duplicatesSkipped,
      queued: Object.values(counts).reduce((total, value) => total + value, 0) + hierarchy.lineage.length,
    }
  } catch (error) {
    await finishCrmSyncRun({
      id: runId,
      status: 'failed',
      counts,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
