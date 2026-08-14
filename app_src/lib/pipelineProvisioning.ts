import crypto from 'node:crypto'
import {
  GoogleWorkspaceRequestError,
  resolveGoogleWorkspaceProvisioningBinding,
  resolveManagedGoogleWorkspaceRuntime,
} from '@/lib/integrations/googleWorkspace'
import {
  GoogleWorkspaceClientError,
  googleDriveJson,
  googleSheetsJson,
  validateGoogleSheetsAccess,
  type GoogleWorkspaceRuntime,
} from '@/lib/integrations/googleWorkspaceClient'
import {
  completePipelineProvisioningInPostgres,
  deletePipelineGooglePermissionTrackingInPostgres,
  enqueuePipelineProvisioningInPostgres,
  markPipelineProvisioningStartedInPostgres,
  readPipelineGooglePermissionContextInPostgres,
  readPipelineProvisioningRecordInPostgres,
  replacePipelineSheetBindingInPostgres,
  recordPipelineProvisioningFailureInPostgres,
  storePipelineDriveFolderIdInPostgres,
  storePipelineProvisioningSheetIdInPostgres,
  storePipelineShortLinkIdInPostgres,
  upsertPipelineGooglePermissionTrackingInPostgres,
  type PipelineDropdownCatalog,
  type PipelineProvisioningRecord,
} from '@/lib/persistence/pipeline'
import { getPostgresPool } from '@/lib/persistence/postgres'
import { syncAppUserProfileToCrm } from '@/lib/persistence/crm'
import { createShortLink, listShortLinks, updateShortLink, type ShortLinkActor } from '@/lib/shortlinks'
import {
  readPipelineWorkbookBranding,
  type OrganizationBranding,
} from '@/lib/organizationBranding'
import { normalizeUserEmail } from '@/lib/users'

const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
const SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet'
const EXPECTED_TABS = [
  'Start Here',
  'Organizations',
  'Contacts',
  'Opportunities',
  'Interactions',
  'Calculations',
  'Dashboard',
  'Dropdowns',
] as const

const TAB_HEADERS: Record<(typeof EXPECTED_TABS)[number], string[]> = {
  'Start Here': ['Section', 'Details'],
  Organizations: [
    'Priority', 'Organization', 'Owner', 'Type', 'Status', 'Industry',
    'Website', 'Phone', 'Address', 'City', 'State', 'Notes',
    'Parent Organization', 'Relationship',
  ],
  Contacts: [
    'Priority', 'Contact', 'Owner', 'Organization', 'Title', 'Email',
    'Phone', 'Status', 'Source', 'Last Contact', 'Next Action', 'Notes',
  ],
  Opportunities: [
    'Priority', 'Opportunity', 'Owner', 'Organization', 'Status', 'Stage',
    'Loss Reason', 'Source', 'Value', 'Probability', 'Expected Close', 'Notes',
  ],
  Interactions: ['Priority', 'Interaction', 'Owner', 'Organization', 'Agent', 'Date', 'Opportunity', 'Contact', 'Notes'],
  Calculations: ['Metric', 'Value'],
  Dashboard: ['Metric', 'Value'],
  Dropdowns: ['Owner', 'Product', 'Stage', 'Priority', 'Status', 'Source', 'Loss Reason'],
}

type DriveFile = {
  id?: string
  name?: string
  mimeType?: string
  parents?: string[]
  driveId?: string
  appProperties?: Record<string, string>
  trashed?: boolean
}

type DrivePermission = {
  id?: string
  type?: string
  role?: string
  emailAddress?: string
  deleted?: boolean
  permissionDetails?: Array<{
    inherited?: boolean
    inheritedFrom?: string
    permissionType?: string
    role?: string
  }>
}

type SpreadsheetMetadata = {
  spreadsheetId?: string
  sheets?: Array<{
    properties?: {
      sheetId?: number
      title?: string
      index?: number
      gridProperties?: {
        rowCount?: number
        columnCount?: number
        frozenRowCount?: number
        frozenColumnCount?: number
      }
    }
    protectedRanges?: Array<{ protectedRangeId?: number; description?: string }>
    charts?: Array<{ chartId?: number }>
    conditionalFormats?: unknown[]
    bandedRanges?: Array<{ bandedRangeId?: number }>
    basicFilter?: unknown
    merges?: Array<{
      sheetId?: number
      startRowIndex?: number
      endRowIndex?: number
      startColumnIndex?: number
      endColumnIndex?: number
    }>
  }>
}

export type SheetsRequestInput = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  idempotent?: boolean
}

export type SheetsJsonRequest = <T>(pathname: string, input?: SheetsRequestInput) => Promise<T>

const GENERATED_TABS = EXPECTED_TABS.filter((title) => title !== 'Opportunities')
const IDENTIFIER_TABS = ['Organizations', 'Contacts', 'Opportunities', 'Interactions'] as const
const PROTECTION_PREFIX = 'ClawPilot managed:'
const REQUIRED_CONFIGURED_DROPDOWNS = ['product', 'stage', 'priority', 'status', 'source', 'loss_reason'] as const
const GENERATED_REPORT_CLEAR_RANGES = [
  "'Start Here'!B4:ZZZ",
  "'Calculations'!B4:ZZZ",
  "'Dashboard'!B4:ZZZ",
] as const
const GENERATED_HEADER_CLEAR_RANGES = EXPECTED_TABS.map((title) => `'${title}'!A1:ZZ3`)

const WORKBOOK_THEME = {
  shell: '#0F0F13',
  surface: '#1A1A23',
  surfaceVariant: '#232330',
  canvas: '#F4F6FA',
  paper: '#FFFFFF',
  paperAlt: '#F8F9FC',
  editable: '#EEF4FF',
  editableAlt: '#E7F0FF',
  ink: '#20212A',
  muted: '#626675',
  outline: '#D9DCE5',
  accent: '#A8C7FA',
  secondary: '#CFC6EA',
  success: '#4F9E67',
  successFill: '#E7F4EA',
  warning: '#A86708',
  warningFill: '#FFF1D6',
  danger: '#B34A45',
  dangerFill: '#FCE8E6',
  info: '#3D6FA8',
  infoFill: '#E8F0FE',
} as const

const DASHBOARD_MATERIAL = {
  primary: '#315C9B',
  activity: '#00796B',
  potential: '#C75B39',
  probable: '#00796B',
  success: '#2E7D32',
  warning: '#C29415',
  canvas: '#F4F7FB',
  surface: '#FFFFFF',
  surfaceVariant: '#F8FAFD',
  outline: '#D8DEE9',
  ink: '#172033',
  muted: '#5E687B',
} as const

const WORKBOOK_TAB_COLORS: Record<(typeof EXPECTED_TABS)[number], string> = {
  'Start Here': WORKBOOK_THEME.accent,
  Organizations: '#79A8F5',
  Contacts: WORKBOOK_THEME.secondary,
  Opportunities: '#76C98D',
  Interactions: '#66CDBD',
  Calculations: '#8E94A6',
  Dashboard: WORKBOOK_THEME.accent,
  Dropdowns: '#E7B867',
}

const WORKBOOK_COLUMN_WIDTHS: Record<(typeof EXPECTED_TABS)[number], number[]> = {
  'Start Here': [64, 190, 720],
  Organizations: [80, 220, 150, 120, 105, 150, 190, 125, 220, 120, 85, 280, 220, 130],
  Contacts: [80, 190, 150, 200, 180, 220, 125, 105, 125, 135, 190, 300],
  Opportunities: [80, 220, 150, 210, 105, 145, 135, 135, 125, 100, 130, 340],
  Interactions: [80, 240, 150, 210, 155, 155, 200, 185, 420],
  Calculations: [240, 150],
  Dashboard: [],
  Dropdowns: [160, 180, 170, 120, 140, 160, 170],
}

const FILTERED_TABLE_TABS = ['Organizations', 'Contacts', 'Opportunities', 'Interactions'] as const
const DASHBOARD_HELPER_COLUMN_INDEX = 15
const DASHBOARD_STAGE_HELPER_COLUMN_INDEX = 18
const DASHBOARD_INTERACTION_HELPER_COLUMN_INDEX = 21
const DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX = 30
const DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX = 39
const DASHBOARD_HELPER_END_COLUMN_INDEX = 42
const DASHBOARD_LAST_VISIBLE_COLUMN_INDEX = 13
const CANONICAL_DROPDOWN_KEYS = ['owner', 'product', 'stage', 'priority', 'status', 'source', 'loss_reason'] as const

function orderedDropdownKeys(catalog: Record<string, unknown>) {
  const available = new Set(Object.keys(catalog))
  return [
    ...CANONICAL_DROPDOWN_KEYS.filter((key) => available.delete(key)),
    ...Array.from(available).sort((left, right) => left.localeCompare(right)),
  ]
}

function populatedColumnCount(row: unknown[]) {
  let lastPopulated = -1
  row.forEach((value, index) => {
    if (String(value ?? '').trim()) lastPopulated = index
  })
  return lastPopulated + 1
}

const INITIAL_TAB_ROWS: Partial<Record<(typeof EXPECTED_TABS)[number], unknown[][]>> = {
  'Start Here': [
    ['WORKFLOW', 'Use this workbook as a focused pipeline workspace. ClawPilot remains the system of record for CRM relationships, access, and automation.'],
    ['1. Update opportunities', 'Only the Opportunities tab is operator-editable. ClawPilot syncs those changes with the CRM.'],
    ['2. Set lifecycle status', 'Status controls lifecycle reporting and formulas. Active excludes Won, Lost, Closed, and Abandoned; Open and On Hold remain active.'],
    ['3. Move the pipeline stage', 'Stage controls where an opportunity appears on the pipeline board.'],
    ['4. Confirm probability', 'Probability controls weighted active value: opportunity value multiplied by win probability. Enter a whole percent from 0 to 100.'],
    ['5. Add the forecast date', 'Expected Close controls when opportunity value appears in the sales forecast.'],
    ['PRODUCTS', 'Products are selected as a multi-select field in ClawPilot and synchronized with the opportunity.'],
    ['GENERATED REPORTING', 'Organizations, Contacts, Interactions, Calculations, Dashboard, and Dropdowns are managed by ClawPilot.'],
    ['DATA SAFETY', 'Do not rename tabs or move table headers. Hidden record IDs preserve exact CRM relationships and are protected from editing.'],
  ],
  Calculations: [
    ['Total opportunities', '=COUNTA(Opportunities!C5:C)'],
    ['Open opportunities', '=COUNTIFS(Opportunities!C5:C,"<>",Opportunities!F5:F,"Open")'],
    ['On-hold opportunities', '=COUNTIFS(Opportunities!C5:C,"<>",Opportunities!F5:F,"On Hold")'],
    ['Active opportunities', '=COUNTIFS(Opportunities!C5:C,"<>",Opportunities!F5:F,"<>Won",Opportunities!F5:F,"<>Lost",Opportunities!F5:F,"<>Closed",Opportunities!F5:F,"<>Abandoned")'],
    ['Active pipeline value', '=SUMIFS(Opportunities!J5:J,Opportunities!C5:C,"<>",Opportunities!F5:F,"<>Won",Opportunities!F5:F,"<>Lost",Opportunities!F5:F,"<>Closed",Opportunities!F5:F,"<>Abandoned")'],
    ['Weighted active value', '=SUMPRODUCT(Opportunities!J5:J,Opportunities!K5:K/100,--(Opportunities!C5:C<>""),--(Opportunities!F5:F<>"Won"),--(Opportunities!F5:F<>"Lost"),--(Opportunities!F5:F<>"Closed"),--(Opportunities!F5:F<>"Abandoned"))'],
    ['Won opportunities', '=COUNTIFS(Opportunities!C5:C,"<>",Opportunities!F5:F,"Won")+COUNTIFS(Opportunities!C5:C,"<>",Opportunities!F5:F,"Closed")'],
    ['Won value', '=SUMIFS(Opportunities!J5:J,Opportunities!C5:C,"<>",Opportunities!F5:F,"Won")+SUMIFS(Opportunities!J5:J,Opportunities!C5:C,"<>",Opportunities!F5:F,"Closed")'],
    ['Lost opportunities', '=COUNTIFS(Opportunities!C5:C,"<>",Opportunities!F5:F,"Lost")+COUNTIFS(Opportunities!C5:C,"<>",Opportunities!F5:F,"Abandoned")'],
    ['Win rate', '=IFERROR(C11/(C11+C13),0)'],
    ['Organizations', '=COUNTA(Organizations!C5:C)'],
    ['Contacts', '=COUNTA(Contacts!C5:C)'],
    ['Interactions', '=COUNTA(Interactions!C5:C)'],
    ['Open opportunities value', '=SUMIFS(Opportunities!J5:J,Opportunities!C5:C,"<>",Opportunities!F5:F,"Open")'],
  ],
  Dashboard: [
    ['Total opportunities', '=Calculations!C5'],
    ['Active opportunities', '=Calculations!C8'],
    ['Open opportunities', '=Calculations!C6'],
    ['On-hold opportunities', '=Calculations!C7'],
    ['Won opportunities', '=Calculations!C11'],
    ['Lost opportunities', '=Calculations!C13'],
    ['Win rate', '=Calculations!C14'],
    ['Active pipeline value', '=Calculations!C9'],
    ['Weighted active value', '=Calculations!C10'],
    ['Won value', '=Calculations!C12'],
    ['Organizations', '=Calculations!C15'],
    ['Contacts', '=Calculations!C16'],
    ['Interactions', '=Calculations!C17'],
    ['Open opportunities value', '=Calculations!C18'],
  ],
  Dropdowns: [
    ['', '', 'Identified Lead', 'A+', 'Open', 'Inbound', 'No Decision'],
    ['', '', 'Qualified Lead', 'A', 'On Hold', 'Outbound', 'Budget'],
    ['', '', 'Needs Analysis', 'B', 'Closed', 'Referral', 'Competition'],
    ['', '', 'Demo', 'C', 'Won', 'Website', 'Not a Fit'],
    ['', '', 'Proposal', 'D', 'Lost', 'Partner', ''],
    ['', '', 'Negotiation', '', 'Abandoned', '', ''],
    ['', '', 'Loss', '', '', '', ''],
    ['', '', 'Won', '', '', '', ''],
  ],
}

export class PipelineProvisioningRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'PIPELINE_PROVISIONING_INVALID',
  ) {
    super(message)
    this.name = 'PipelineProvisioningRequestError'
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function pipelineLockKey(scope: string) {
  return `clawpilot:pipeline-google:${scope}`
}

async function withPipelineGoogleLock<T>(scope: string, callback: () => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [pipelineLockKey(scope)])
    return await callback()
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [pipelineLockKey(scope)])
    } finally {
      client.release()
    }
  }
}

function driveQueryLiteral(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function appPropertyClause(key: string, value: string) {
  return `appProperties has { key='${driveQueryLiteral(key)}' and value='${driveQueryLiteral(value)}' }`
}

function validResourceId(value: unknown, label = 'Google Workspace resource') {
  const resourceId = String(value || '').trim()
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(resourceId)) {
    throw new PipelineProvisioningRequestError(`${label} is invalid`, 502, 'GOOGLE_RESOURCE_INVALID')
  }
  return resourceId
}

function runtimeSharedDriveId(runtime: GoogleWorkspaceRuntime) {
  return validResourceId(runtime.sharedDriveId, 'Google Shared Drive binding')
}

function cleanDriveName(value: string, fallback: string) {
  const cleaned = value.replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (cleaned || fallback).slice(0, 100)
}

function ownerPropertyKey(ownerEmail: string) {
  return crypto.createHash('sha256').update(ownerEmail).digest('hex').slice(0, 32)
}

function managedEnvironmentName() {
  const environment = String(
    process.env.CLAWPILOT_ENVIRONMENT
    || process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.VERCEL_ENV
    || process.env.NODE_ENV
    || 'development',
  ).trim().toLowerCase()
  return environment === 'production' ? 'Production' : 'Development'
}

function fileProperties(resource: string, extra: Record<string, string> = {}) {
  return { clawpilotManaged: 'true', clawpilotResource: resource, ...extra }
}

function pipelineBinding(pipeline: PipelineProvisioningRecord) {
  if (!pipeline.googleServiceAccountEmail || !pipeline.googleSharedDriveId) {
    throw new PipelineProvisioningRequestError(
      'Pipeline native Google Workspace binding is incomplete',
      409,
      'GOOGLE_WORKSPACE_BINDING_REQUIRED',
    )
  }
  return {
    serviceAccountEmail: pipeline.googleServiceAccountEmail,
    sharedDriveId: pipeline.googleSharedDriveId,
  }
}

async function runtimeForPipeline(pipeline: PipelineProvisioningRecord) {
  return resolveManagedGoogleWorkspaceRuntime(pipelineBinding(pipeline))
}

function wrapSetupError(error: unknown): never {
  if (error instanceof PipelineProvisioningRequestError) throw error
  if (error instanceof GoogleWorkspaceRequestError) {
    throw new PipelineProvisioningRequestError(error.message, error.status, error.code)
  }
  throw new PipelineProvisioningRequestError(
    'Google Workspace integration is not ready for managed pipeline provisioning',
    503,
    'GOOGLE_WORKSPACE_NOT_READY',
  )
}

export async function queuePipelineProvisioning(input: { actorEmail: unknown; pipelineId: unknown }) {
  const actorEmail = normalizeUserEmail(input.actorEmail)
  const pipeline = await readPipelineProvisioningRecordInPostgres(input.pipelineId)
  if (pipeline.ownerEmail !== actorEmail) {
    throw new PipelineProvisioningRequestError(
      'Only the pipeline owner can provision it',
      403,
      'PIPELINE_OWNER_REQUIRED',
    )
  }
  if (pipeline.provisioningStatus === 'ready' && pipeline.sheetId && pipeline.syncEnabled) {
    const shortLinkId = await ensurePipelineShortLink(pipeline, pipeline.sheetId)
    if (pipeline.shortLinkId !== shortLinkId) {
      await storePipelineShortLinkIdInPostgres({
        pipelineId: pipeline.id,
        expectedShortLinkId: pipeline.shortLinkId,
        shortLinkId,
      })
    }
    return {
      outboxId: null,
      outboxStatus: 'succeeded',
      provisioningStatus: 'ready' as const,
      alreadyReady: true,
    }
  }

  try {
    const binding = pipeline.googleServiceAccountEmail && pipeline.googleSharedDriveId
      ? {
        serviceAccountEmail: pipeline.googleServiceAccountEmail,
        sharedDriveId: pipeline.googleSharedDriveId,
      }
      : await resolveGoogleWorkspaceProvisioningBinding()
    const queued = await enqueuePipelineProvisioningInPostgres({
      pipelineId: pipeline.id,
      ownerEmail: pipeline.ownerEmail,
      actor: actorEmail,
      serviceAccountEmail: binding.serviceAccountEmail,
      sharedDriveId: binding.sharedDriveId,
    })
    return {
      outboxId: queued.outboxId,
      outboxStatus: queued.outboxStatus,
      provisioningStatus: queued.provisioningStatus,
      alreadyReady: queued.alreadyReady,
    }
  } catch (error) {
    wrapSetupError(error)
  }
}

async function listManagedFiles(input: {
  runtime: GoogleWorkspaceRuntime
  parentId: string
  mimeType: string
  appProperties: Record<string, string>
}): Promise<DriveFile[]> {
  const sharedDriveId = runtimeSharedDriveId(input.runtime)
  const clauses = [
    'trashed = false',
    `mimeType = '${driveQueryLiteral(input.mimeType)}'`,
    `'${driveQueryLiteral(input.parentId)}' in parents`,
    ...Object.entries(input.appProperties).map(([key, value]) => appPropertyClause(key, value)),
  ]
  const parameters = new URLSearchParams({
    q: clauses.join(' and '),
    corpora: 'drive',
    driveId: sharedDriveId,
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    spaces: 'drive',
    pageSize: '20',
    fields: 'files(id,name,mimeType,parents,driveId,appProperties,trashed)',
  })
  const response = await googleDriveJson<{ files?: DriveFile[] }>(
    input.runtime,
    `/drive/v3/files?${parameters.toString()}`,
  )
  return Array.isArray(response.files) ? response.files : []
}

async function recoverManagedFile(input: {
  runtime: GoogleWorkspaceRuntime
  parentId: string
  mimeType: string
  appProperties: Record<string, string>
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await delay(250 * (2 ** attempt))
    const recovered = await listManagedFiles(input)
    if (recovered.length > 1) {
      throw new PipelineProvisioningRequestError(
        'Duplicate managed Google resources require operator review',
        409,
        'GOOGLE_RESOURCE_DUPLICATE',
      )
    }
    if (recovered[0]) return recovered[0]
  }
  return null
}

async function ensureManagedFolder(input: {
  runtime: GoogleWorkspaceRuntime
  parentId: string
  name: string
  appProperties: Record<string, string>
}) {
  const existing = await listManagedFiles({ ...input, mimeType: DRIVE_FOLDER_MIME_TYPE })
  if (existing.length > 1) {
    throw new PipelineProvisioningRequestError(
      'Duplicate managed Drive folders require operator review',
      409,
      'GOOGLE_RESOURCE_DUPLICATE',
    )
  }
  if (existing[0]) {
    const folderId = validResourceId(existing[0].id, 'Managed Drive folder ID')
    if (existing[0].name !== input.name) {
      const parameters = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id' })
      await googleDriveJson(input.runtime, `/drive/v3/files/${folderId}?${parameters.toString()}`, {
        method: 'PATCH',
        body: { name: input.name },
        idempotent: true,
      })
    }
    return folderId
  }

  const parameters = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id' })
  try {
    const created = await googleDriveJson<DriveFile>(
      input.runtime,
      `/drive/v3/files?${parameters.toString()}`,
      {
        method: 'POST',
        body: {
          name: input.name,
          mimeType: DRIVE_FOLDER_MIME_TYPE,
          parents: [input.parentId],
          appProperties: input.appProperties,
        },
        idempotent: false,
      },
    )
    return validResourceId(created.id, 'Managed Drive folder ID')
  } catch (error) {
    const recovered = await recoverManagedFile({ ...input, mimeType: DRIVE_FOLDER_MIME_TYPE })
    if (recovered) return validResourceId(recovered.id, 'Managed Drive folder ID')
    throw error
  }
}

async function getDriveFile(runtime: GoogleWorkspaceRuntime, resourceId: string): Promise<DriveFile> {
  const parameters = new URLSearchParams({
    supportsAllDrives: 'true',
    fields: 'id,name,mimeType,parents,driveId,appProperties,trashed',
  })
  return googleDriveJson<DriveFile>(runtime, `/drive/v3/files/${resourceId}?${parameters.toString()}`)
}

async function listVerifiedDriveFolderChildren(runtime: GoogleWorkspaceRuntime, folderId: string) {
  let pageToken: string | undefined
  const seenPageTokens = new Set<string>()
  const children: string[] = []

  do {
    const parameters = new URLSearchParams({
      q: `trashed = false and '${driveQueryLiteral(folderId)}' in parents`,
      corpora: 'drive',
      driveId: runtimeSharedDriveId(runtime),
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      spaces: 'drive',
      pageSize: '100',
      fields: 'nextPageToken,files(id,parents)',
    })
    if (pageToken) parameters.set('pageToken', pageToken)
    const response = await googleDriveJson<{
      files?: Array<{ id?: string; parents?: string[] }>
      nextPageToken?: string
    }>(runtime, `/drive/v3/files?${parameters.toString()}`)

    for (const child of response.files || []) {
      // Drive can echo the queried folder in this response. It cannot be its own child.
      if (child.id === folderId) continue
      if (!child.id || !child.parents?.includes(folderId)) {
        throw new GoogleWorkspaceClientError(
          'Google Drive returned an unverifiable folder child',
          502,
          'GOOGLE_RESPONSE_INVALID',
        )
      }
      children.push(child.id)
    }

    pageToken = response.nextPageToken
    if (pageToken && seenPageTokens.has(pageToken)) {
      throw new GoogleWorkspaceClientError(
        'Google Drive returned a repeated page token',
        502,
        'GOOGLE_RESPONSE_INVALID',
      )
    }
    if (pageToken) seenPageTokens.add(pageToken)
  } while (pageToken)

  return children
}

async function waitForDriveChildRemoval(
  runtime: GoogleWorkspaceRuntime,
  parentId: string,
  childId: string,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const children = await listVerifiedDriveFolderChildren(runtime, parentId)
    if (!children.includes(childId)) return
    await delay(250 * (2 ** attempt))
  }
  throw new GoogleWorkspaceClientError(
    'Google Drive folder cleanup is still converging',
    503,
    'GOOGLE_DRIVE_TRASH_UNVERIFIED',
    true,
  )
}

async function trashLegacyDriveFolder(runtime: GoogleWorkspaceRuntime, folderId: string) {
  const parameters = new URLSearchParams({
    supportsAllDrives: 'true',
    fields: 'id,name,mimeType,parents,driveId,appProperties,trashed',
  })
  const trashed = await googleDriveJson<DriveFile>(runtime, `/drive/v3/files/${folderId}?${parameters.toString()}`, {
    method: 'PATCH',
    body: { trashed: true },
    idempotent: true,
  })
  if (trashed.id !== folderId || trashed.trashed !== true) {
    throw new GoogleWorkspaceClientError(
      'Google Drive did not verify the legacy folder cleanup',
      503,
      'GOOGLE_DRIVE_TRASH_UNVERIFIED',
      true,
    )
  }
}

async function cleanupLegacyFolderChain(runtime: GoogleWorkspaceRuntime, folderId: string | undefined) {
  const legacyResources = new Set(['pipelines-root', 'user-root', 'users-root'])
  let current = folderId
  for (let depth = 0; current && depth < 3; depth += 1) {
    let folder: DriveFile
    try {
      folder = await getDriveFile(runtime, current)
    } catch (error) {
      if (error instanceof GoogleWorkspaceClientError && error.code === 'GOOGLE_RESOURCE_NOT_FOUND') return
      throw error
    }
    const parent = folder.parents?.[0]
    if (folder.trashed) {
      current = parent
      continue
    }
    if (
      folder.mimeType !== DRIVE_FOLDER_MIME_TYPE
      || folder.appProperties?.clawpilotManaged !== 'true'
      || !legacyResources.has(String(folder.appProperties?.clawpilotResource || ''))
      || (await listVerifiedDriveFolderChildren(runtime, current)).length > 0
    ) return
    try {
      await trashLegacyDriveFolder(runtime, current)
    } catch (error) {
      if (!(error instanceof GoogleWorkspaceClientError) || error.code !== 'GOOGLE_RESOURCE_NOT_FOUND') throw error
    }
    if (parent) await waitForDriveChildRemoval(runtime, parent, current)
    current = parent
  }
}

async function cleanupLegacyOwnerHierarchy(input: {
  runtime: GoogleWorkspaceRuntime
  environmentFolderId: string
  environment: string
  ownerKey: string
}) {
  const usersRoots = await listManagedFiles({
    runtime: input.runtime,
    parentId: input.environmentFolderId,
    mimeType: DRIVE_FOLDER_MIME_TYPE,
    appProperties: fileProperties('users-root', { environment: input.environment.toLowerCase() }),
  })
  for (const usersRoot of usersRoots) {
    const usersRootId = validResourceId(usersRoot.id, 'Legacy users folder ID')
    const userFolders = await listManagedFiles({
      runtime: input.runtime,
      parentId: usersRootId,
      mimeType: DRIVE_FOLDER_MIME_TYPE,
      appProperties: fileProperties('user-root', { ownerKey: input.ownerKey }),
    })
    for (const userFolder of userFolders) {
      const userFolderId = validResourceId(userFolder.id, 'Legacy user folder ID')
      const pipelineRoots = await listManagedFiles({
        runtime: input.runtime,
        parentId: userFolderId,
        mimeType: DRIVE_FOLDER_MIME_TYPE,
        appProperties: fileProperties('pipelines-root', { ownerKey: input.ownerKey }),
      })
      for (const pipelineRoot of pipelineRoots) {
        await cleanupLegacyFolderChain(
          input.runtime,
          validResourceId(pipelineRoot.id, 'Legacy pipelines folder ID'),
        )
      }
      await cleanupLegacyFolderChain(input.runtime, userFolderId)
    }
    await cleanupLegacyFolderChain(input.runtime, usersRootId)
  }
}

function verifyPipelineFolder(
  file: DriveFile,
  pipelineId: string,
  sharedDriveId: string,
) {
  if (
    file.trashed
    || file.mimeType !== DRIVE_FOLDER_MIME_TYPE
    || file.driveId !== sharedDriveId
    || file.appProperties?.clawpilotManaged !== 'true'
    || file.appProperties?.clawpilotResource !== 'pipeline-folder'
    || file.appProperties?.pipelineId !== pipelineId
  ) {
    throw new PipelineProvisioningRequestError(
      'Managed pipeline folder verification failed',
      409,
      'GOOGLE_PIPELINE_FOLDER_INVALID',
    )
  }
}

function verifyPipelineFile(
  file: DriveFile,
  pipelineId: string,
  parentId: string,
  sharedDriveId: string,
) {
  if (
    file.trashed
    || file.mimeType !== SHEET_MIME_TYPE
    || file.driveId !== sharedDriveId
    || !file.parents?.includes(parentId)
    || file.appProperties?.clawpilotManaged !== 'true'
    || file.appProperties?.clawpilotResource !== 'pipeline-sheet'
    || file.appProperties?.pipelineId !== pipelineId
  ) {
    throw new PipelineProvisioningRequestError(
      'Managed pipeline Sheet verification failed',
      409,
      'GOOGLE_PIPELINE_SHEET_INVALID',
    )
  }
}

type PipelineCrmIdentity = Awaited<ReturnType<typeof syncAppUserProfileToCrm>>

function pipelineDriveName(pipeline: PipelineProvisioningRecord, identity: PipelineCrmIdentity) {
  return cleanDriveName(`${identity.contactReferenceCode} ${pipeline.name}`, 'Pipeline')
}

async function ensurePipelineFolder(
  runtime: GoogleWorkspaceRuntime,
  pipeline: PipelineProvisioningRecord,
  identity: PipelineCrmIdentity,
) {
  const sharedDriveId = runtimeSharedDriveId(runtime)
  const environment = managedEnvironmentName()
  const ownerKey = ownerPropertyKey(pipeline.ownerEmail)
  const root = await ensureManagedFolder({
    runtime,
    parentId: sharedDriveId,
    name: 'ClawPilot Data',
    appProperties: fileProperties('data-root'),
  })
  const environmentFolder = await ensureManagedFolder({
    runtime,
    parentId: root,
    name: environment,
    appProperties: fileProperties('environment-root', { environment: environment.toLowerCase() }),
  })
  const organizationsFolder = await ensureManagedFolder({
    runtime,
    parentId: environmentFolder,
    name: 'Organizations',
    appProperties: fileProperties('organizations-root', { environment: environment.toLowerCase() }),
  })
  const organizationFolder = await ensureManagedFolder({
    runtime,
    parentId: organizationsFolder,
    name: cleanDriveName(
      `${identity.organizationReferenceCode} ${identity.organizationName}`,
      'Organization',
    ),
    appProperties: fileProperties('organization-root', {
      workspaceOrganizationId: identity.workspaceOrganizationId,
      organizationReferenceCode: identity.organizationReferenceCode,
    }),
  })
  const contactsFolder = await ensureManagedFolder({
    runtime,
    parentId: organizationFolder,
    name: 'Contacts',
    appProperties: fileProperties('contacts-root', {
      workspaceOrganizationId: identity.workspaceOrganizationId,
    }),
  })
  const contactFolder = await ensureManagedFolder({
    runtime,
    parentId: contactsFolder,
    name: cleanDriveName(
      `${identity.contactReferenceCode} ${identity.displayName}`,
      'Contact',
    ),
    appProperties: fileProperties('contact-root', {
      ownerKey,
      appUserReferenceCode: identity.contactReferenceCode,
    }),
  })
  const pipelinesFolder = await ensureManagedFolder({
    runtime,
    parentId: contactFolder,
    name: 'Pipelines',
    appProperties: fileProperties('pipelines-root', { ownerKey }),
  })
  const pipelineName = pipelineDriveName(pipeline, identity)
  let pipelineFolderId: string
  if (pipeline.driveFolderId) {
    const folder = await getDriveFile(runtime, pipeline.driveFolderId)
    verifyPipelineFolder(folder, pipeline.id, sharedDriveId)
    const moveRequired = !folder.parents?.includes(pipelinesFolder)
    if (moveRequired || folder.name !== pipelineName) {
      const parameters = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,parents,name' })
      if (moveRequired) {
        parameters.set('addParents', pipelinesFolder)
        if (folder.parents?.length) parameters.set('removeParents', folder.parents.join(','))
      }
      await googleDriveJson(runtime, `/drive/v3/files/${pipeline.driveFolderId}?${parameters.toString()}`, {
        method: 'PATCH',
        body: { name: pipelineName },
        idempotent: true,
      })
      const moved = await getDriveFile(runtime, pipeline.driveFolderId)
      verifyPipelineFolder(moved, pipeline.id, sharedDriveId)
      if (moved.name !== pipelineName || !moved.parents?.includes(pipelinesFolder)) {
        throw new PipelineProvisioningRequestError(
          'Managed pipeline folder move did not verify',
          409,
          'GOOGLE_PIPELINE_FOLDER_MOVE_UNVERIFIED',
        )
      }
      if (moveRequired) await cleanupLegacyFolderChain(runtime, folder.parents?.[0])
    }
    pipelineFolderId = pipeline.driveFolderId
  } else {
    pipelineFolderId = await ensureManagedFolder({
      runtime,
      parentId: pipelinesFolder,
      name: pipelineName,
      appProperties: fileProperties('pipeline-folder', { pipelineId: pipeline.id }),
    })
  }

  await cleanupLegacyOwnerHierarchy({
    runtime,
    environmentFolderId: environmentFolder,
    environment,
    ownerKey,
  })
  return pipelineFolderId
}

async function ensurePipelineSheet(
  runtime: GoogleWorkspaceRuntime,
  pipeline: PipelineProvisioningRecord,
  folderId: string,
  pipelineName: string,
) {
  const sharedDriveId = runtimeSharedDriveId(runtime)
  const boundSheetId = pipeline.provisioningSheetId || pipeline.sheetId
  if (boundSheetId) {
    const file = await getDriveFile(runtime, boundSheetId)
    verifyPipelineFile(file, pipeline.id, folderId, sharedDriveId)
    if (file.name !== pipelineName) {
      const parameters = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name' })
      await googleDriveJson(runtime, `/drive/v3/files/${boundSheetId}?${parameters.toString()}`, {
        method: 'PATCH',
        body: { name: pipelineName },
        idempotent: true,
      })
    }
    return boundSheetId
  }
  const appProperties = fileProperties('pipeline-sheet', { pipelineId: pipeline.id })
  const existing = await listManagedFiles({
    runtime,
    parentId: folderId,
    mimeType: SHEET_MIME_TYPE,
    appProperties,
  })
  if (existing.length > 1) {
    throw new PipelineProvisioningRequestError(
      'Duplicate managed pipeline Sheets require operator review',
      409,
      'GOOGLE_RESOURCE_DUPLICATE',
    )
  }
  if (existing[0]) return validResourceId(existing[0].id, 'Managed pipeline Sheet ID')

  const parameters = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id' })
  try {
    const created = await googleDriveJson<DriveFile>(runtime, `/drive/v3/files?${parameters.toString()}`, {
      method: 'POST',
      body: {
        name: pipelineName,
        mimeType: SHEET_MIME_TYPE,
        parents: [folderId],
        appProperties,
      },
      idempotent: false,
    })
    return validResourceId(created.id, 'Managed pipeline Sheet ID')
  } catch (error) {
    const recovered = await recoverManagedFile({
      runtime,
      parentId: folderId,
      mimeType: SHEET_MIME_TYPE,
      appProperties,
    })
    if (recovered) return validResourceId(recovered.id, 'Managed pipeline Sheet ID')
    throw error
  }
}

async function spreadsheetMetadata(request: SheetsJsonRequest, sheetId: string) {
  const metadata = await request<SpreadsheetMetadata>(
    `/v4/spreadsheets/${sheetId}?fields=spreadsheetId,sheets(properties,protectedRanges(protectedRangeId,description),charts(chartId),conditionalFormats,bandedRanges(bandedRangeId),basicFilter,merges)`,
  )
  if (validResourceId(metadata.spreadsheetId, 'Managed pipeline Sheet ID') !== sheetId) {
    throw new PipelineProvisioningRequestError(
      'Managed pipeline Sheet metadata did not match its binding',
      409,
      'GOOGLE_PIPELINE_SHEET_INVALID',
    )
  }
  return metadata
}

async function legacyDashboardHasUnmanagedHeader(request: SheetsJsonRequest, sheetId: string) {
  const range = encodeURIComponent("'Dashboard'!D1:ZZ3")
  const result = await request<{ values?: unknown[][] }>(
    `/v4/spreadsheets/${sheetId}/values/${range}?majorDimension=ROWS`,
  )
  return (result.values || []).some((row) => row.some((value) => String(value ?? '').trim() !== ''))
}

function dashboardChartRequests(sheetId: number) {
  const chartShell = (input: {
    title: string
    chartType: 'BAR' | 'COLUMN'
    stackedType?: 'NOT_STACKED' | 'STACKED'
    legendPosition: 'NO_LEGEND' | 'BOTTOM_LEGEND' | 'TOP_LEGEND'
    valueAxisTitle: string
    domainColumnIndex: number
    seriesColumnIndex: number
    seriesColors: string[]
    startRowIndex: number
    endRowIndex: number
    anchorRowIndex: number
    anchorColumnIndex: number
  }) => ({
    addChart: {
      chart: {
        spec: {
          title: input.title,
          fontName: 'Roboto',
          hiddenDimensionStrategy: 'SHOW_ALL',
          backgroundColor: googleColor(WORKBOOK_THEME.paper),
          titleTextFormat: {
            foregroundColor: googleColor(WORKBOOK_THEME.ink),
            fontSize: 14,
            bold: true,
          },
          basicChart: {
            chartType: input.chartType,
            stackedType: input.stackedType || 'NOT_STACKED',
            legendPosition: input.legendPosition,
            headerCount: 1,
            axis: input.chartType === 'BAR'
              ? [
                {
                  position: 'BOTTOM_AXIS',
                  title: input.valueAxisTitle,
                  format: { foregroundColor: googleColor(WORKBOOK_THEME.muted), fontSize: 9 },
                },
                {
                  position: 'LEFT_AXIS',
                  title: 'Stage',
                  format: { foregroundColor: googleColor(WORKBOOK_THEME.muted), fontSize: 9 },
                },
              ]
              : [
                {
                  position: 'BOTTOM_AXIS',
                  title: 'Month ending',
                  format: { foregroundColor: googleColor(WORKBOOK_THEME.muted), fontSize: 9 },
                },
                {
                  position: 'LEFT_AXIS',
                  title: input.valueAxisTitle,
                  format: { foregroundColor: googleColor(WORKBOOK_THEME.muted), fontSize: 9 },
                },
              ],
            domains: [{
              domain: {
                sourceRange: {
                  sources: [{
                    sheetId,
                    startRowIndex: input.startRowIndex,
                    endRowIndex: input.endRowIndex,
                    startColumnIndex: input.domainColumnIndex,
                    endColumnIndex: input.domainColumnIndex + 1,
                  }],
                },
              },
            }],
            series: input.seriesColors.map((color, index) => ({
              series: {
                sourceRange: {
                  sources: [{
                    sheetId,
                    startRowIndex: input.startRowIndex,
                    endRowIndex: input.endRowIndex,
                    startColumnIndex: input.seriesColumnIndex + index,
                    endColumnIndex: input.seriesColumnIndex + index + 1,
                  }],
                },
              },
              targetAxis: input.chartType === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS',
              color: googleColor(color),
            })),
          },
        },
        position: {
          overlayPosition: {
            anchorCell: {
              sheetId,
              rowIndex: input.anchorRowIndex,
              columnIndex: input.anchorColumnIndex,
            },
            widthPixels: 440,
            heightPixels: 250,
          },
        },
      },
    },
  })

  const interactionSeriesColors = ['#5C6BC0', '#356BB3', '#7CB342', '#008C95', '#8E55A6', '#C29415', '#C75B39']
  const forecastStageColors = ['#2E7D32', '#C29415', '#D66D24', '#1597C1', '#A45A9C', '#59A14F', '#4E79A7']

  return [
    chartShell({
      title: 'Opportunities by stage',
      chartType: 'BAR',
      legendPosition: 'NO_LEGEND',
      valueAxisTitle: 'Opportunities',
      domainColumnIndex: DASHBOARD_STAGE_HELPER_COLUMN_INDEX,
      seriesColumnIndex: DASHBOARD_STAGE_HELPER_COLUMN_INDEX + 1,
      seriesColors: [DASHBOARD_MATERIAL.primary],
      startRowIndex: 3,
      endRowIndex: 13,
      anchorRowIndex: 9,
      anchorColumnIndex: 1,
    }),
    chartShell({
      title: 'Interactions, last quarter',
      chartType: 'COLUMN',
      stackedType: 'NOT_STACKED',
      legendPosition: 'BOTTOM_LEGEND',
      valueAxisTitle: 'Interactions',
      domainColumnIndex: DASHBOARD_INTERACTION_HELPER_COLUMN_INDEX,
      seriesColumnIndex: DASHBOARD_INTERACTION_HELPER_COLUMN_INDEX + 1,
      seriesColors: interactionSeriesColors,
      startRowIndex: 3,
      endRowIndex: 7,
      anchorRowIndex: 9,
      anchorColumnIndex: 7,
    }),
    chartShell({
      title: 'Potential Revenue by Stage, Next 2 Quarters',
      chartType: 'COLUMN',
      stackedType: 'STACKED',
      legendPosition: 'TOP_LEGEND',
      valueAxisTitle: 'Potential revenue',
      domainColumnIndex: DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX,
      seriesColumnIndex: DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX + 1,
      seriesColors: forecastStageColors,
      startRowIndex: 3,
      endRowIndex: 10,
      anchorRowIndex: 24,
      anchorColumnIndex: 1,
    }),
    chartShell({
      title: 'Potential vs probable value',
      chartType: 'COLUMN',
      stackedType: 'NOT_STACKED',
      legendPosition: 'BOTTOM_LEGEND',
      valueAxisTitle: 'Value',
      domainColumnIndex: DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX,
      seriesColumnIndex: DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX + 1,
      seriesColors: [DASHBOARD_MATERIAL.potential, DASHBOARD_MATERIAL.probable],
      startRowIndex: 3,
      endRowIndex: 10,
      anchorRowIndex: 24,
      anchorColumnIndex: 7,
    }),
  ]
}

function dashboardValueWrites() {
  const interactionTypes = ['Direct Mail', 'LinkedIn', 'Email', 'Call', 'In Person', 'Note', 'Campaign']
  const opportunityStages = ['Identified Lead', 'Qualified Lead', 'Needs Analysis', 'Demo', 'Proposal', 'Negotiation', 'Closed', 'Closed Delayed', 'Loss']
  const forecastStages = ['Closed', 'Closed Delayed', 'Proposal', 'Demo', 'Needs Analysis', 'Qualified Lead', 'Identified Lead']
  const interactionMonthColumn = columnName(DASHBOARD_INTERACTION_HELPER_COLUMN_INDEX)
  const interactionTrackerRows = [-2, -1, 0].map((monthOffset, rowIndex) => {
    const dateFormula = monthOffset === 0 ? '=TODAY()' : `=EOMONTH(TODAY(),${monthOffset})`
    const sheetRow = 5 + rowIndex
    return [
      dateFormula,
      ...interactionTypes.map((_, typeIndex) => {
        const typeColumn = columnName(DASHBOARD_INTERACTION_HELPER_COLUMN_INDEX + 1 + typeIndex)
        return `=COUNTIFS(Interactions!$C$5:$C,${typeColumn}$4,Interactions!$G$5:$G,">="&EOMONTH($${interactionMonthColumn}${sheetRow},-1)+1,Interactions!$G$5:$G,"<="&$${interactionMonthColumn}${sheetRow})`
      }),
    ]
  })
  const forecastMonthColumn = columnName(DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX)
  const forecastStageRows = Array.from({ length: 6 }, (_, rowIndex) => {
    const sheetRow = 5 + rowIndex
    return [
      `=EOMONTH(TODAY(),${rowIndex})`,
      ...forecastStages.map((_, stageIndex) => {
        const stageColumn = columnName(DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX + 1 + stageIndex)
        return `=SUMIFS(Opportunities!$J$5:$J,Opportunities!$C$5:$C,"<>",Opportunities!$G$5:$G,${stageColumn}$4,Opportunities!$L$5:$L,">="&EOMONTH($${forecastMonthColumn}${sheetRow},-1)+1,Opportunities!$L$5:$L,"<="&$${forecastMonthColumn}${sheetRow})`
      }),
    ]
  })
  const forecastValueMonthColumn = columnName(DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX)
  const forecastValueRows = Array.from({ length: 6 }, (_, rowIndex) => {
    const sheetRow = 5 + rowIndex
    const monthCell = `$${forecastValueMonthColumn}${sheetRow}`
    return [
      `=EOMONTH(TODAY(),${rowIndex})`,
      `=SUMIFS(Opportunities!$J$5:$J,Opportunities!$C$5:$C,"<>",Opportunities!$L$5:$L,">="&EOMONTH(${monthCell},-1)+1,Opportunities!$L$5:$L,"<="&${monthCell},Opportunities!$F$5:$F,"<>Won",Opportunities!$F$5:$F,"<>Lost",Opportunities!$F$5:$F,"<>Closed",Opportunities!$F$5:$F,"<>Abandoned")`,
      `=SUMPRODUCT(Opportunities!$J$5:$J,Opportunities!$K$5:$K/100,--(Opportunities!$C$5:$C<>""),--(Opportunities!$L$5:$L>=EOMONTH(${monthCell},-1)+1),--(Opportunities!$L$5:$L<=${monthCell}),--(Opportunities!$F$5:$F<>"Won"),--(Opportunities!$F$5:$F<>"Lost"),--(Opportunities!$F$5:$F<>"Closed"),--(Opportunities!$F$5:$F<>"Abandoned"))`,
    ]
  })
  return [
    { range: "'Dashboard'!B5", majorDimension: 'ROWS' as const, values: [['OPEN OPPORTUNITIES VALUE']] },
    { range: "'Dashboard'!B6", majorDimension: 'ROWS' as const, values: [['=Calculations!C18']] },
    { range: "'Dashboard'!H5", majorDimension: 'ROWS' as const, values: [['POTENTIAL VALUE']] },
    { range: "'Dashboard'!H6", majorDimension: 'ROWS' as const, values: [['=Calculations!C9']] },
    { range: "'Dashboard'!B8", majorDimension: 'ROWS' as const, values: [['="CONTACTS  "&TEXT(Calculations!C16,"#,##0")']] },
    { range: "'Dashboard'!D8", majorDimension: 'ROWS' as const, values: [['="INTERACTIONS  "&TEXT(Calculations!C17,"#,##0")']] },
    { range: "'Dashboard'!F8", majorDimension: 'ROWS' as const, values: [['="OPPS PURSUED  "&TEXT(Calculations!C5,"#,##0")']] },
    { range: "'Dashboard'!I8", majorDimension: 'ROWS' as const, values: [['="OPPS CLOSED  "&TEXT(Calculations!C11,"#,##0")']] },
    { range: "'Dashboard'!K8", majorDimension: 'ROWS' as const, values: [['="WIN RATE  "&TEXT(Calculations!C14,"0.0%")']] },
    { range: "'Dashboard'!B9", majorDimension: 'ROWS' as const, values: [['PIPELINE AND CUSTOMER ACTIVITY']] },
    { range: "'Dashboard'!B24", majorDimension: 'ROWS' as const, values: [['SALES FORECAST']] },
    {
      range: "'Dashboard'!S4",
      majorDimension: 'ROWS' as const,
      values: [
        ['Stage', 'Opportunities'],
        ...opportunityStages.map((stage, rowIndex) => [
          stage,
          `=COUNTIFS(Opportunities!$C$5:$C,"<>",Opportunities!$G$5:$G,$S${5 + rowIndex})`,
        ]),
      ],
    },
    {
      range: "'Dashboard'!V4",
      majorDimension: 'ROWS' as const,
      values: [['Month ending', ...interactionTypes], ...interactionTrackerRows],
    },
    {
      range: "'Dashboard'!AE4",
      majorDimension: 'ROWS' as const,
      values: [['Month ending', ...forecastStages], ...forecastStageRows],
    },
    {
      range: "'Dashboard'!AN4",
      majorDimension: 'ROWS' as const,
      values: [['Month ending', 'Potential', 'Probable'], ...forecastValueRows],
    },
    {
      range: "'Dashboard'!B40",
      majorDimension: 'ROWS' as const,
      values: [['Generated from ClawPilot CRM records. Grouped interactions use CRM activity type; forecasts use expected close month.']],
    },
  ]
}

function googleBorder(hex: string = WORKBOOK_THEME.outline, style: string = 'SOLID') {
  return { style, color: googleColor(hex) }
}

function tableBandingRequest(input: {
  sheetId: number
  rowCount: number
  startColumnIndex?: number
  endColumnIndex: number
  editable?: boolean
}) {
  return {
    addBanding: {
      bandedRange: {
        range: {
          sheetId: input.sheetId,
          startRowIndex: 4,
          endRowIndex: input.rowCount,
          startColumnIndex: input.startColumnIndex ?? 1,
          endColumnIndex: input.endColumnIndex,
        },
        rowProperties: {
          firstBandColor: googleColor(input.editable ? WORKBOOK_THEME.editable : WORKBOOK_THEME.paper),
          secondBandColor: googleColor(input.editable ? WORKBOOK_THEME.editableAlt : WORKBOOK_THEME.paperAlt),
        },
      },
    },
  }
}

function conditionalTextRule(input: {
  sheetId: number
  rowCount: number
  columnIndex: number
  value: string
  fill: string
  foreground: string
}) {
  return {
    addConditionalFormatRule: {
      rule: {
        ranges: [{
          sheetId: input.sheetId,
          startRowIndex: 4,
          endRowIndex: input.rowCount,
          startColumnIndex: input.columnIndex,
          endColumnIndex: input.columnIndex + 1,
        }],
        booleanRule: {
          condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: input.value }] },
          format: {
            backgroundColor: googleColor(input.fill),
            textFormat: { foregroundColor: googleColor(input.foreground), bold: true },
          },
        },
      },
      index: 0,
    },
  }
}

function commonTableConditionalFormatting(sheetId: number, rowCount: number) {
  return [
    conditionalTextRule({ sheetId, rowCount, columnIndex: 1, value: 'A+', fill: '#E2F3E7', foreground: '#2C6A3C' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex: 1, value: 'A', fill: '#E8F0FE', foreground: '#315D91' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex: 1, value: 'B', fill: '#F0EBFA', foreground: '#625080' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex: 1, value: 'C', fill: '#FFF1D6', foreground: '#8B5A08' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex: 1, value: 'D', fill: '#FCE8E6', foreground: '#963D39' }),
  ]
}

function syncStatusConditionalFormatting(sheetId: number, rowCount: number, columnIndex: number) {
  return [
    conditionalTextRule({ sheetId, rowCount, columnIndex, value: 'synced', fill: WORKBOOK_THEME.successFill, foreground: '#2C6A3C' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex, value: 'pending', fill: WORKBOOK_THEME.warningFill, foreground: '#8B5A08' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex, value: 'queued', fill: WORKBOOK_THEME.warningFill, foreground: '#8B5A08' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex, value: 'failed', fill: WORKBOOK_THEME.dangerFill, foreground: '#963D39' }),
  ]
}

function opportunityStatusConditionalFormatting(sheetId: number, rowCount: number) {
  return [
    conditionalTextRule({ sheetId, rowCount, columnIndex: 5, value: 'Open', fill: WORKBOOK_THEME.infoFill, foreground: '#315D91' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex: 5, value: 'On Hold', fill: WORKBOOK_THEME.warningFill, foreground: '#8B5A08' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex: 5, value: 'Won', fill: WORKBOOK_THEME.successFill, foreground: '#2C6A3C' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex: 5, value: 'Closed', fill: WORKBOOK_THEME.successFill, foreground: '#2C6A3C' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex: 5, value: 'Lost', fill: WORKBOOK_THEME.dangerFill, foreground: '#963D39' }),
    conditionalTextRule({ sheetId, rowCount, columnIndex: 5, value: 'Abandoned', fill: WORKBOOK_THEME.dangerFill, foreground: '#963D39' }),
  ]
}

function setRangeNumberFormat(input: {
  sheetId: number
  startRowIndex: number
  endRowIndex?: number
  startColumnIndex: number
  endColumnIndex: number
  type: string
  pattern: string
}) {
  return {
    repeatCell: {
      range: {
        sheetId: input.sheetId,
        startRowIndex: input.startRowIndex,
        ...(input.endRowIndex === undefined ? {} : { endRowIndex: input.endRowIndex }),
        startColumnIndex: input.startColumnIndex,
        endColumnIndex: input.endColumnIndex,
      },
      cell: { userEnteredFormat: { numberFormat: { type: input.type, pattern: input.pattern } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  }
}

function opportunityValidationRequests(sheetId: number, rowCount: number) {
  const dropdown = (columnIndex: number, sourceColumn: string) => ({
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: 4,
        endRowIndex: rowCount,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rule: {
        condition: {
          type: 'ONE_OF_RANGE',
          values: [{ userEnteredValue: `='Dropdowns'!$${sourceColumn}$5:$${sourceColumn}` }],
        },
        strict: false,
        showCustomUi: true,
      },
    },
  })
  const numeric = (columnIndex: number, type: string, values: string[]) => ({
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: 4,
        endRowIndex: rowCount,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rule: {
        condition: { type, values: values.map((value) => ({ userEnteredValue: value })) },
        strict: true,
        showCustomUi: true,
      },
    },
  })
  return [
    dropdown(1, 'E'),
    dropdown(3, 'B'),
    dropdown(5, 'F'),
    dropdown(6, 'D'),
    dropdown(7, 'H'),
    dropdown(8, 'G'),
    numeric(9, 'NUMBER_GREATER_THAN_EQ', ['0']),
    numeric(10, 'NUMBER_BETWEEN', ['0', '100']),
    {
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: 4,
          endRowIndex: rowCount,
          startColumnIndex: 11,
          endColumnIndex: 12,
        },
        rule: { condition: { type: 'DATE_IS_VALID' }, strict: true, showCustomUi: true },
      },
    },
  ]
}

function dashboardLayoutRequests(sheetId: number) {
  const requests: unknown[] = []
  const cards = [
    { startColumnIndex: 1, endColumnIndex: 7, color: DASHBOARD_MATERIAL.primary },
    { startColumnIndex: 7, endColumnIndex: 13, color: DASHBOARD_MATERIAL.potential },
  ]
  for (const card of cards) {
    requests.push(
      {
        mergeCells: {
          range: { sheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: card.startColumnIndex, endColumnIndex: card.endColumnIndex },
          mergeType: 'MERGE_ALL',
        },
      },
      {
        mergeCells: {
          range: { sheetId, startRowIndex: 5, endRowIndex: 7, startColumnIndex: card.startColumnIndex, endColumnIndex: card.endColumnIndex },
          mergeType: 'MERGE_ALL',
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 4, endRowIndex: 7, startColumnIndex: card.startColumnIndex, endColumnIndex: card.endColumnIndex },
          cell: {
            userEnteredFormat: {
              backgroundColor: googleColor(DASHBOARD_MATERIAL.surface),
              borders: {
                top: googleBorder(card.color, 'SOLID_THICK'),
                bottom: googleBorder(DASHBOARD_MATERIAL.outline),
                left: googleBorder(DASHBOARD_MATERIAL.outline),
                right: googleBorder(DASHBOARD_MATERIAL.outline),
              },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,borders)',
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: card.startColumnIndex, endColumnIndex: card.endColumnIndex },
          cell: {
            userEnteredFormat: {
              textFormat: { foregroundColor: googleColor(DASHBOARD_MATERIAL.muted), fontFamily: 'Roboto', fontSize: 9, bold: true },
              horizontalAlignment: 'LEFT',
              verticalAlignment: 'BOTTOM',
            },
          },
          fields: 'userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)',
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 5, endRowIndex: 7, startColumnIndex: card.startColumnIndex, endColumnIndex: card.endColumnIndex },
          cell: {
            userEnteredFormat: {
              textFormat: { foregroundColor: googleColor(card.color), fontFamily: 'Roboto Mono', fontSize: 22, bold: true },
              horizontalAlignment: 'LEFT',
              verticalAlignment: 'MIDDLE',
            },
          },
          fields: 'userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)',
        },
      },
    )
  }
  const compactCards = [
    { startColumnIndex: 1, endColumnIndex: 3, color: '#A45A9C' },
    { startColumnIndex: 3, endColumnIndex: 5, color: DASHBOARD_MATERIAL.activity },
    { startColumnIndex: 5, endColumnIndex: 8, color: DASHBOARD_MATERIAL.primary },
    { startColumnIndex: 8, endColumnIndex: 10, color: DASHBOARD_MATERIAL.success },
    { startColumnIndex: 10, endColumnIndex: 13, color: DASHBOARD_MATERIAL.warning },
  ]
  for (const card of compactCards) {
    requests.push(
      {
        mergeCells: {
          range: { sheetId, startRowIndex: 7, endRowIndex: 8, startColumnIndex: card.startColumnIndex, endColumnIndex: card.endColumnIndex },
          mergeType: 'MERGE_ALL',
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 7, endRowIndex: 8, startColumnIndex: card.startColumnIndex, endColumnIndex: card.endColumnIndex },
          cell: {
            userEnteredFormat: {
              backgroundColor: googleColor(DASHBOARD_MATERIAL.surfaceVariant),
              textFormat: { foregroundColor: googleColor(card.color), fontFamily: 'Roboto', fontSize: 9, bold: true },
              horizontalAlignment: 'CENTER',
              verticalAlignment: 'MIDDLE',
              borders: {
                top: googleBorder(card.color, 'SOLID_MEDIUM'),
                bottom: googleBorder(DASHBOARD_MATERIAL.outline),
                left: googleBorder(DASHBOARD_MATERIAL.outline),
                right: googleBorder(DASHBOARD_MATERIAL.outline),
              },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,borders)',
        },
      },
    )
  }
  requests.push(
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 8, endRowIndex: 9, startColumnIndex: 1, endColumnIndex: DASHBOARD_LAST_VISIBLE_COLUMN_INDEX },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 23, endRowIndex: 24, startColumnIndex: 1, endColumnIndex: DASHBOARD_LAST_VISIBLE_COLUMN_INDEX },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      mergeCells: {
        range: { sheetId, startRowIndex: 39, endRowIndex: 40, startColumnIndex: 1, endColumnIndex: DASHBOARD_LAST_VISIBLE_COLUMN_INDEX },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 8, endRowIndex: 9, startColumnIndex: 1, endColumnIndex: DASHBOARD_LAST_VISIBLE_COLUMN_INDEX },
        cell: {
          userEnteredFormat: {
            textFormat: { foregroundColor: googleColor(DASHBOARD_MATERIAL.ink), fontFamily: 'Roboto', fontSize: 11, bold: true },
            borders: { bottom: googleBorder(DASHBOARD_MATERIAL.outline, 'SOLID_MEDIUM') },
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(textFormat,borders,verticalAlignment)',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 23, endRowIndex: 24, startColumnIndex: 1, endColumnIndex: DASHBOARD_LAST_VISIBLE_COLUMN_INDEX },
        cell: {
          userEnteredFormat: {
            textFormat: { foregroundColor: googleColor(DASHBOARD_MATERIAL.ink), fontFamily: 'Roboto', fontSize: 11, bold: true },
            borders: { bottom: googleBorder(DASHBOARD_MATERIAL.outline, 'SOLID_MEDIUM') },
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(textFormat,borders,verticalAlignment)',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 39, endRowIndex: 40, startColumnIndex: 1, endColumnIndex: DASHBOARD_LAST_VISIBLE_COLUMN_INDEX },
        cell: {
          userEnteredFormat: {
            textFormat: { foregroundColor: googleColor(DASHBOARD_MATERIAL.muted), fontFamily: 'Roboto', fontSize: 9, italic: true },
            horizontalAlignment: 'LEFT',
          },
        },
        fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
      },
    },
    setRangeNumberFormat({ sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2, type: 'CURRENCY', pattern: '$#,##0' }),
    setRangeNumberFormat({ sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 7, endColumnIndex: 8, type: 'CURRENCY', pattern: '$#,##0' }),
    setRangeNumberFormat({
      sheetId,
      startRowIndex: 3,
      endRowIndex: 7,
      startColumnIndex: DASHBOARD_INTERACTION_HELPER_COLUMN_INDEX,
      endColumnIndex: DASHBOARD_INTERACTION_HELPER_COLUMN_INDEX + 1,
      type: 'DATE',
      pattern: 'mmm d',
    }),
    setRangeNumberFormat({
      sheetId,
      startRowIndex: 3,
      endRowIndex: 10,
      startColumnIndex: DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX,
      endColumnIndex: DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX + 1,
      type: 'DATE',
      pattern: 'mmm yyyy',
    }),
    setRangeNumberFormat({
      sheetId,
      startRowIndex: 4,
      endRowIndex: 10,
      startColumnIndex: DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX + 1,
      endColumnIndex: DASHBOARD_FORECAST_STAGE_HELPER_COLUMN_INDEX + 8,
      type: 'CURRENCY',
      pattern: '$#,##0',
    }),
    setRangeNumberFormat({
      sheetId,
      startRowIndex: 3,
      endRowIndex: 10,
      startColumnIndex: DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX,
      endColumnIndex: DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX + 1,
      type: 'DATE',
      pattern: 'mmm yyyy',
    }),
    setRangeNumberFormat({
      sheetId,
      startRowIndex: 4,
      endRowIndex: 10,
      startColumnIndex: DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX + 1,
      endColumnIndex: DASHBOARD_FORECAST_VALUE_HELPER_COLUMN_INDEX + 3,
      type: 'CURRENCY',
      pattern: '$#,##0',
    }),
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: DASHBOARD_LAST_VISIBLE_COLUMN_INDEX },
        properties: { pixelSize: 72 },
        fields: 'pixelSize',
      },
    },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: DASHBOARD_HELPER_COLUMN_INDEX, endIndex: DASHBOARD_HELPER_END_COLUMN_INDEX },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        },
      },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 4, endIndex: 7 },
        properties: { pixelSize: 30 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 7, endIndex: 8 },
        properties: { pixelSize: 26 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 8, endIndex: 9 },
        properties: { pixelSize: 30 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 23, endIndex: 24 },
        properties: { pixelSize: 30 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 39, endIndex: 40 },
        properties: { pixelSize: 28 },
        fields: 'pixelSize',
      },
    },
    ...dashboardChartRequests(sheetId),
  )
  return requests
}

export async function configurePipelineTabsWithRequest(
  request: SheetsJsonRequest,
  sheetId: string,
  protectionEditor?: string,
) {
  let metadata = await spreadsheetMetadata(request, sheetId)
  const current = metadata.sheets || []
  const currentTitles = new Set(current.map((sheet) => sheet.properties?.title).filter(Boolean))
  const newlyProvisionedTitles = new Set<string>()
  const requests: unknown[] = []

  if (!currentTitles.has(EXPECTED_TABS[0])) {
    const renameCandidate = current.find((sheet) => (
      typeof sheet.properties?.sheetId === 'number'
      && !EXPECTED_TABS.includes(sheet.properties?.title as (typeof EXPECTED_TABS)[number])
    ))
    if (renameCandidate?.properties?.sheetId !== undefined) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: renameCandidate.properties.sheetId, title: EXPECTED_TABS[0] },
          fields: 'title',
        },
      })
      currentTitles.add(EXPECTED_TABS[0])
      newlyProvisionedTitles.add(EXPECTED_TABS[0])
    }
  }
  for (const title of EXPECTED_TABS) {
    if (!currentTitles.has(title)) {
      requests.push({ addSheet: { properties: { title } } })
      currentTitles.add(title)
      newlyProvisionedTitles.add(title)
    }
  }
  if (requests.length > 0) {
    await request(`/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: { requests, includeSpreadsheetInResponse: false },
      idempotent: false,
    })
    metadata = await spreadsheetMetadata(request, sheetId)
  }

  const legacyDashboard = (metadata.sheets || [])
    .find((sheet) => sheet.properties?.title === 'Dashboard')
  if (
    typeof legacyDashboard?.properties?.sheetId === 'number'
    && await legacyDashboardHasUnmanagedHeader(request, sheetId)
  ) {
    await request(`/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: [
          { deleteSheet: { sheetId: legacyDashboard.properties.sheetId } },
          { addSheet: { properties: { title: 'Dashboard', index: EXPECTED_TABS.indexOf('Dashboard') } } },
        ],
        includeSpreadsheetInResponse: false,
      },
      idempotent: false,
    })
    newlyProvisionedTitles.add('Dashboard')
    metadata = await spreadsheetMetadata(request, sheetId)
  }

  const managedMerges = (metadata.sheets || []).flatMap((sheet) => (
    EXPECTED_TABS.includes(sheet.properties?.title as (typeof EXPECTED_TABS)[number])
      ? sheet.merges || []
      : []
  ))
  if (managedMerges.length > 0) {
    await request(`/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: managedMerges.map((range) => ({ unmergeCells: { range } })),
        includeSpreadsheetInResponse: false,
      },
      idempotent: false,
    })
  }

  await request(`/v4/spreadsheets/${sheetId}/values:batchClear`, {
    method: 'POST',
    body: { ranges: [...GENERATED_HEADER_CLEAR_RANGES, ...GENERATED_REPORT_CLEAR_RANGES] },
    idempotent: true,
  })

  await request(`/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    body: {
      valueInputOption: 'USER_ENTERED',
      data: EXPECTED_TABS.flatMap((title) => {
        const writes: Array<{ range: string; majorDimension: 'ROWS'; values: unknown[][] }> = []
        if (IDENTIFIER_TABS.includes(title as (typeof IDENTIFIER_TABS)[number])) {
          writes.push({
            range: `'${title}'!A4`,
            majorDimension: 'ROWS',
            values: [['ClawPilot Record ID']],
          })
        }
        const preserveConfiguredDropdowns = title === 'Dropdowns' && !newlyProvisionedTitles.has(title)
        if (preserveConfiguredDropdowns) return writes

        const dataColumn = title === 'Dashboard' ? 'P' : title === 'Start Here' ? 'C' : 'B'
        writes.push({
          range: `'${title}'!${dataColumn}4`,
          majorDimension: 'ROWS',
          values: [TAB_HEADERS[title]],
        })
        if (INITIAL_TAB_ROWS[title]) {
          writes.push({
            range: `'${title}'!${dataColumn}5`,
            majorDimension: 'ROWS',
            values: INITIAL_TAB_ROWS[title] || [],
          })
        }
        return writes
      }).concat(dashboardValueWrites()),
    },
    idempotent: true,
  })

  metadata = await spreadsheetMetadata(request, sheetId)
  const dropdownHeaderResult = await request<{ values?: unknown[][] }>(
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent("'Dropdowns'!B4:ZZ4")}?majorDimension=ROWS`,
  )
  const configuredDropdownColumnCount = Math.max(
    TAB_HEADERS.Dropdowns.length,
    populatedColumnCount(dropdownHeaderResult.values?.[0] || []),
  )
  const managedSheets = (metadata.sheets || []).filter((sheet) => (
    typeof sheet.properties?.sheetId === 'number'
    && EXPECTED_TABS.includes(sheet.properties?.title as (typeof EXPECTED_TABS)[number])
  ))
  if (managedSheets.length === 0) {
    throw new PipelineProvisioningRequestError(
      'Managed pipeline workbook has no ClawPilot tabs to brand',
      409,
      'GOOGLE_PIPELINE_TABS_MISSING',
    )
  }
  const formattingRequests: unknown[] = []
  managedSheets.forEach((sheet) => {
    const sheetIdValue = sheet.properties?.sheetId
    const title = sheet.properties?.title as (typeof EXPECTED_TABS)[number]
    if (sheetIdValue === undefined) return
    const tableStartColumnIndex = title === 'Start Here' ? 2 : 1
    const tableColumnCount = title === 'Dropdowns'
      ? configuredDropdownColumnCount
      : TAB_HEADERS[title].length
    const tableEndColumnIndex = tableStartColumnIndex + tableColumnCount
    const visibleEndColumnIndex = title === 'Dashboard'
      ? DASHBOARD_LAST_VISIBLE_COLUMN_INDEX
      : Math.max(8, tableEndColumnIndex)
    const minimumRows = title === 'Dashboard' ? 44 : title === 'Start Here' ? 30 : title === 'Calculations' ? 40 : 1000
    const rowCount = Math.max(minimumRows, sheet.properties?.gridProperties?.rowCount || 0)
    const columnCount = Math.max(
      sheet.properties?.gridProperties?.columnCount || 0,
      title === 'Dashboard' ? DASHBOARD_HELPER_END_COLUMN_INDEX : tableEndColumnIndex,
    )
    for (const range of sheet.protectedRanges || []) {
      if (range.protectedRangeId !== undefined && String(range.description || '').startsWith(PROTECTION_PREFIX)) {
        formattingRequests.push({ deleteProtectedRange: { protectedRangeId: range.protectedRangeId } })
      }
    }
    for (let index = (sheet.conditionalFormats || []).length - 1; index >= 0; index -= 1) {
      formattingRequests.push({ deleteConditionalFormatRule: { sheetId: sheetIdValue, index } })
    }
    for (const bandedRange of sheet.bandedRanges || []) {
      if (bandedRange.bandedRangeId !== undefined) {
        formattingRequests.push({ deleteBanding: { bandedRangeId: bandedRange.bandedRangeId } })
      }
    }
    if (sheet.basicFilter) formattingRequests.push({ clearBasicFilter: { sheetId: sheetIdValue } })
    for (const chart of sheet.charts || []) {
      if (chart.chartId !== undefined) {
        formattingRequests.push({ deleteEmbeddedObject: { objectId: chart.chartId } })
      }
    }
    formattingRequests.push({
      setDataValidation: {
        range: {
          sheetId: sheetIdValue,
          startRowIndex: 4,
          endRowIndex: rowCount,
          startColumnIndex: tableStartColumnIndex,
          endColumnIndex: tableEndColumnIndex,
        },
        filteredRowsIncluded: true,
      },
    })
    formattingRequests.push(
      {
        updateSheetProperties: {
          properties: {
            sheetId: sheetIdValue,
            index: EXPECTED_TABS.indexOf(title),
            tabColor: googleColor(WORKBOOK_TAB_COLORS[title]),
            gridProperties: {
              rowCount,
              columnCount,
              frozenRowCount: title === 'Dashboard' ? 3 : 4,
              frozenColumnCount: 1,
              hideGridlines: true,
            },
          },
          fields: 'index,tabColor,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount,hideGridlines)',
        },
      },
      {
        repeatCell: {
          range: { sheetId: sheetIdValue, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount },
          cell: {
            userEnteredFormat: {
              backgroundColor: googleColor(WORKBOOK_THEME.canvas),
              textFormat: { foregroundColor: googleColor(WORKBOOK_THEME.ink), fontFamily: 'Roboto', fontSize: 10 },
              verticalAlignment: 'MIDDLE',
              wrapStrategy: 'CLIP',
            },
          },
          fields: 'userEnteredFormat',
        },
      },
      {
        repeatCell: {
          range: { sheetId: sheetIdValue, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: visibleEndColumnIndex },
          cell: {
            userEnteredFormat: {
              backgroundColor: googleColor(WORKBOOK_THEME.shell),
              textFormat: { foregroundColor: googleColor('#FFFFFF'), fontFamily: 'Roboto' },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: sheetIdValue, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: sheetIdValue, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 38 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: sheetIdValue, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 24 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: sheetIdValue, dimension: 'ROWS', startIndex: 2, endIndex: 3 },
          properties: { pixelSize: 8 },
          fields: 'pixelSize',
        },
      },
    )

    if (title !== 'Dashboard') {
      formattingRequests.push(
        {
          repeatCell: {
            range: { sheetId: sheetIdValue, startRowIndex: 3, endRowIndex: 4, startColumnIndex: tableStartColumnIndex, endColumnIndex: tableEndColumnIndex },
            cell: {
              userEnteredFormat: {
                backgroundColor: googleColor(WORKBOOK_THEME.surface),
                textFormat: { foregroundColor: googleColor('#FFFFFF'), fontFamily: 'Roboto', fontSize: 10, bold: true },
                horizontalAlignment: 'LEFT',
                verticalAlignment: 'MIDDLE',
                borders: { bottom: googleBorder(WORKBOOK_THEME.accent, 'SOLID_THICK') },
                wrapStrategy: 'WRAP',
              },
            },
            fields: 'userEnteredFormat',
          },
        },
        {
          repeatCell: {
            range: { sheetId: sheetIdValue, startRowIndex: 4, endRowIndex: rowCount, startColumnIndex: tableStartColumnIndex, endColumnIndex: tableEndColumnIndex },
            cell: {
              userEnteredFormat: {
                textFormat: { foregroundColor: googleColor(WORKBOOK_THEME.ink), fontFamily: 'Roboto', fontSize: 10 },
                verticalAlignment: 'MIDDLE',
                borders: { bottom: googleBorder(WORKBOOK_THEME.outline) },
                wrapStrategy: title === 'Start Here' ? 'WRAP' : 'CLIP',
              },
            },
            fields: 'userEnteredFormat(textFormat,verticalAlignment,borders,wrapStrategy)',
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: sheetIdValue, dimension: 'ROWS', startIndex: 3, endIndex: 4 },
            properties: { pixelSize: 34 },
            fields: 'pixelSize',
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: sheetIdValue, dimension: 'ROWS', startIndex: 4, endIndex: rowCount },
            properties: { pixelSize: title === 'Start Here' ? 54 : 32 },
            fields: 'pixelSize',
          },
        },
      )
      Array.from(
        { length: Math.max(tableColumnCount, WORKBOOK_COLUMN_WIDTHS[title].length) },
        (_, column) => WORKBOOK_COLUMN_WIDTHS[title][column] || 160,
      ).forEach((pixelSize, column) => {
        formattingRequests.push({
          updateDimensionProperties: {
            range: { sheetId: sheetIdValue, dimension: 'COLUMNS', startIndex: 1 + column, endIndex: 2 + column },
            properties: { pixelSize },
            fields: 'pixelSize',
          },
        })
      })
      formattingRequests.push(tableBandingRequest({
        sheetId: sheetIdValue,
        rowCount,
        startColumnIndex: tableStartColumnIndex,
        endColumnIndex: tableEndColumnIndex,
        editable: title === 'Opportunities',
      }))
    }

    if (title === 'Start Here') {
      formattingRequests.push(
        {
          repeatCell: {
            range: { sheetId: sheetIdValue, startRowIndex: 4, endRowIndex: 13, startColumnIndex: 2, endColumnIndex: 3 },
            cell: {
              userEnteredFormat: {
                textFormat: { foregroundColor: googleColor(WORKBOOK_THEME.info), fontSize: 10, bold: true },
                verticalAlignment: 'TOP',
              },
            },
            fields: 'userEnteredFormat(textFormat,verticalAlignment)',
          },
        },
        {
          repeatCell: {
            range: { sheetId: sheetIdValue, startRowIndex: 4, endRowIndex: 13, startColumnIndex: 3, endColumnIndex: 4 },
            cell: { userEnteredFormat: { textFormat: { foregroundColor: googleColor(WORKBOOK_THEME.ink), fontSize: 10 }, verticalAlignment: 'TOP' } },
            fields: 'userEnteredFormat(textFormat,verticalAlignment)',
          },
        },
      )
    }

    if (FILTERED_TABLE_TABS.includes(title as (typeof FILTERED_TABLE_TABS)[number])) {
      formattingRequests.push(
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId: sheetIdValue,
                startRowIndex: 3,
                endRowIndex: rowCount,
                startColumnIndex: 1,
                endColumnIndex: tableEndColumnIndex,
              },
            },
          },
        },
        ...commonTableConditionalFormatting(sheetIdValue, rowCount),
      )
    }

    if (title === 'Organizations') {
      formattingRequests.push(...syncStatusConditionalFormatting(sheetIdValue, rowCount, 5))
    }
    if (title === 'Contacts') {
      formattingRequests.push(
        ...syncStatusConditionalFormatting(sheetIdValue, rowCount, 8),
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 4, startColumnIndex: 10, endColumnIndex: 11, type: 'DATE', pattern: 'mmm d, yyyy' }),
      )
    }
    if (title === 'Opportunities') {
      formattingRequests.push(
        ...opportunityStatusConditionalFormatting(sheetIdValue, rowCount),
        ...opportunityValidationRequests(sheetIdValue, rowCount),
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 4, startColumnIndex: 9, endColumnIndex: 10, type: 'CURRENCY', pattern: '$#,##0.00' }),
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 4, startColumnIndex: 10, endColumnIndex: 11, type: 'NUMBER', pattern: '0.0"%"' }),
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 4, startColumnIndex: 11, endColumnIndex: 12, type: 'DATE', pattern: 'mmm d, yyyy' }),
      )
    }
    if (title === 'Interactions') {
      formattingRequests.push(
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 4, startColumnIndex: 6, endColumnIndex: 7, type: 'DATE_TIME', pattern: 'mmm d, yyyy h:mm AM/PM' }),
      )
    }
    if (title === 'Calculations') {
      formattingRequests.push(
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 8, endRowIndex: 10, startColumnIndex: 2, endColumnIndex: 3, type: 'CURRENCY', pattern: '$#,##0.00' }),
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 11, endRowIndex: 12, startColumnIndex: 2, endColumnIndex: 3, type: 'CURRENCY', pattern: '$#,##0.00' }),
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 13, endRowIndex: 14, startColumnIndex: 2, endColumnIndex: 3, type: 'PERCENT', pattern: '0.0%' }),
      )
    }
    if (title === 'Dashboard') {
      formattingRequests.push(
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 10, endRowIndex: 11, startColumnIndex: 16, endColumnIndex: 17, type: 'PERCENT', pattern: '0.0%' }),
        setRangeNumberFormat({ sheetId: sheetIdValue, startRowIndex: 11, endRowIndex: 14, startColumnIndex: 16, endColumnIndex: 17, type: 'CURRENCY', pattern: '$#,##0.00' }),
        ...dashboardLayoutRequests(sheetIdValue),
      )
    }

    if (GENERATED_TABS.includes(title as (typeof GENERATED_TABS)[number])) {
      formattingRequests.push({
        addProtectedRange: {
          protectedRange: {
            description: `${PROTECTION_PREFIX} generated ${title}`,
            range: { sheetId: sheetIdValue },
            warningOnly: false,
            ...(protectionEditor ? { editors: { users: [protectionEditor] } } : {}),
          },
        },
      })
    } else {
      formattingRequests.push({
        addProtectedRange: {
          protectedRange: {
            description: `${PROTECTION_PREFIX} opportunity identifiers and headers`,
            range: { sheetId: sheetIdValue, startRowIndex: 0, endRowIndex: 4 },
            warningOnly: false,
            ...(protectionEditor ? { editors: { users: [protectionEditor] } } : {}),
          },
        },
      })
      formattingRequests.push({
        addProtectedRange: {
          protectedRange: {
            description: `${PROTECTION_PREFIX} opportunity identifiers`,
            range: { sheetId: sheetIdValue, startColumnIndex: 0, endColumnIndex: 1 },
            warningOnly: false,
            ...(protectionEditor ? { editors: { users: [protectionEditor] } } : {}),
          },
        },
      })
    }
  })
  if (formattingRequests.length > 0) {
    await request(`/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: { requests: formattingRequests, includeSpreadsheetInResponse: false },
      idempotent: false,
    })
  }
}

export async function configurePipelineTabs(runtime: GoogleWorkspaceRuntime, sheetId: string) {
  const request: SheetsJsonRequest = (pathname, input) => googleSheetsJson(runtime, pathname, input)
  return configurePipelineTabsWithRequest(request, sheetId, runtime.serviceAccountEmail)
}

function googleColor(hex: string) {
  const value = /^#[0-9A-F]{6}$/i.test(hex) ? hex.slice(1) : '1F2430'
  return {
    red: Number.parseInt(value.slice(0, 2), 16) / 255,
    green: Number.parseInt(value.slice(2, 4), 16) / 255,
    blue: Number.parseInt(value.slice(4, 6), 16) / 255,
  }
}

function contrastingGoogleColor(hex: string) {
  const color = googleColor(hex)
  const luminance = (0.2126 * color.red) + (0.7152 * color.green) + (0.0722 * color.blue)
  return luminance > 0.55 ? { red: 0.08, green: 0.08, blue: 0.1 } : { red: 1, green: 1, blue: 1 }
}

function sheetText(value: string) {
  const text = String(value || '').trim().slice(0, 200)
  return /^[=+\-@]/.test(text) ? `'${text}` : text
}

function workbookBrandMark(branding: OrganizationBranding) {
  if (!branding.hasCustomLogo) return 'CP'
  const words = branding.organizationName.match(/[A-Za-z0-9]+/g) || []
  if (words.length > 1) return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase()
  return (words[0] || 'CP').slice(0, 2).toUpperCase()
}

export async function applyPipelineWorkbookBrandingWithRequest(
  request: SheetsJsonRequest,
  sheetId: string,
  branding: OrganizationBranding,
) {
  const metadata = await spreadsheetMetadata(request, sheetId)
  const dropdownHeaderResult = await request<{ values?: unknown[][] }>(
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent("'Dropdowns'!B4:ZZ4")}?majorDimension=ROWS`,
  )
  const configuredDropdownColumnCount = Math.max(
    TAB_HEADERS.Dropdowns.length,
    populatedColumnCount(dropdownHeaderResult.values?.[0] || []),
  )
  const managedSheets = (metadata.sheets || []).filter((sheet) => (
    typeof sheet.properties?.sheetId === 'number'
    && EXPECTED_TABS.includes(sheet.properties?.title as (typeof EXPECTED_TABS)[number])
  ))
  if (managedSheets.length === 0) {
    throw new PipelineProvisioningRequestError(
      'Managed pipeline workbook has no ClawPilot tabs to brand',
      409,
      'GOOGLE_PIPELINE_TABS_MISSING',
    )
  }
  const primary = googleColor(branding.primaryColor)
  const accent = googleColor(branding.accentColor)
  const foreground = contrastingGoogleColor(branding.primaryColor)
  const markForeground = contrastingGoogleColor(branding.accentColor)
  const requests: unknown[] = []
  for (const sheet of managedSheets) {
    const id = sheet.properties?.sheetId
    const title = sheet.properties?.title as (typeof EXPECTED_TABS)[number]
    if (id === undefined) continue
    const tableStartColumnIndex = title === 'Start Here' ? 2 : 1
    const tableColumnCount = title === 'Dropdowns'
      ? configuredDropdownColumnCount
      : TAB_HEADERS[title].length
    const endColumnIndex = title === 'Dashboard'
      ? DASHBOARD_LAST_VISIBLE_COLUMN_INDEX
      : Math.max(8, tableStartColumnIndex + tableColumnCount)
    for (const merge of sheet.merges || []) {
      if ((merge.startRowIndex || 0) < 3 && (merge.endRowIndex || 0) <= 3) {
        requests.push({ unmergeCells: { range: merge } })
      }
    }
    requests.push(
      {
        mergeCells: {
          range: { sheetId: id, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 },
          mergeType: 'MERGE_ALL',
        },
      },
      {
        mergeCells: {
          range: { sheetId: id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 2, endColumnIndex },
          mergeType: 'MERGE_ALL',
        },
      },
      {
        mergeCells: {
          range: { sheetId: id, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex },
          mergeType: 'MERGE_ALL',
        },
      },
      {
        repeatCell: {
          range: { sheetId: id, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 1, endColumnIndex },
          cell: { userEnteredFormat: { backgroundColor: primary } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      },
      {
        repeatCell: {
          range: { sheetId: id, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 },
          cell: {
            userEnteredFormat: {
              backgroundColor: accent,
              textFormat: { foregroundColor: markForeground, fontSize: 16, bold: true },
              horizontalAlignment: 'CENTER',
              verticalAlignment: 'MIDDLE',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
        },
      },
      {
        repeatCell: {
          range: { sheetId: id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 2, endColumnIndex },
          cell: {
            userEnteredFormat: {
              textFormat: { foregroundColor: foreground, fontSize: 15, bold: true },
              horizontalAlignment: 'LEFT',
              verticalAlignment: 'BOTTOM',
            },
          },
          fields: 'userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)',
        },
      },
      {
        repeatCell: {
          range: { sheetId: id, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex },
          cell: {
            userEnteredFormat: {
              textFormat: { foregroundColor: foreground, fontSize: 9, bold: false },
              horizontalAlignment: 'LEFT',
              verticalAlignment: 'TOP',
            },
          },
          fields: 'userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)',
        },
      },
      {
        repeatCell: {
          range: { sheetId: id, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 1, endColumnIndex },
          cell: {
            userEnteredFormat: {
              backgroundColor: primary,
              borders: { bottom: { style: 'SOLID_THICK', color: accent } },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,borders)',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: id, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 38 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: id, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 24 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: id, dimension: 'ROWS', startIndex: 2, endIndex: 3 },
          properties: { pixelSize: 8 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: id, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 64 },
          fields: 'pixelSize',
        },
      },
    )
    if (title !== 'Dashboard') {
      requests.push({
        repeatCell: {
          range: {
            sheetId: id,
            startRowIndex: 3,
            endRowIndex: 4,
            startColumnIndex: tableStartColumnIndex,
            endColumnIndex: tableStartColumnIndex + TAB_HEADERS[title].length,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: primary,
              textFormat: { foregroundColor: foreground, fontSize: 10, bold: true },
              borders: { bottom: { style: 'SOLID_THICK', color: accent } },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,borders)',
        },
      })
    }
  }
  if (requests.length > 0) {
    await request(`/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: { requests, includeSpreadsheetInResponse: false },
      idempotent: true,
    })
  }
  await request(`/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    body: {
      valueInputOption: 'USER_ENTERED',
      data: managedSheets.flatMap((sheet) => {
        const title = sheet.properties?.title as (typeof EXPECTED_TABS)[number]
        return [
          // Service-account IMAGE formulas remain #REF until a human approves external URL access.
          { range: `'${title}'!B1`, majorDimension: 'ROWS', values: [[workbookBrandMark(branding)]] },
          { range: `'${title}'!C1`, majorDimension: 'ROWS', values: [[sheetText(branding.organizationName)]] },
          { range: `'${title}'!C2`, majorDimension: 'ROWS', values: [[`${title} | Managed by ClawPilot`]] },
        ]
      }),
    },
    idempotent: true,
  })
}

export async function applyPipelineWorkbookBranding(
  runtime: GoogleWorkspaceRuntime,
  sheetId: string,
  branding: OrganizationBranding,
) {
  const request: SheetsJsonRequest = (pathname, input) => googleSheetsJson(runtime, pathname, input)
  return applyPipelineWorkbookBrandingWithRequest(request, sheetId, branding)
}

async function verifyPipelineTabsAndHeaders(runtime: GoogleWorkspaceRuntime, sheetId: string) {
  const request: SheetsJsonRequest = (pathname, input) => googleSheetsJson(runtime, pathname, input)
  const metadata = await spreadsheetMetadata(request, sheetId)
  const titles = (metadata.sheets || [])
    .map((sheet) => sheet.properties?.title)
    .filter((title): title is string => Boolean(title))
  if (EXPECTED_TABS.some((title) => !titles.includes(title))) {
    throw new PipelineProvisioningRequestError(
      'Managed pipeline Sheet tabs did not verify',
      409,
      'GOOGLE_PIPELINE_TABS_INVALID',
    )
  }
  const parameters = new URLSearchParams({ majorDimension: 'ROWS' })
  for (const title of EXPECTED_TABS) {
    const startColumn = title === 'Dashboard' ? 'P' : title === 'Start Here' ? 'C' : 'B'
    const endColumn = title === 'Dropdowns'
      ? 'ZZ'
      : title === 'Dashboard'
        ? 'Q'
        : title === 'Start Here'
          ? 'D'
      : String.fromCharCode('A'.charCodeAt(0) + TAB_HEADERS[title].length)
    parameters.append('ranges', `'${title}'!${startColumn}4:${endColumn}4`)
  }
  const values = await googleSheetsJson<{ valueRanges?: Array<{ values?: unknown[][] }> }>(
    runtime,
    `/v4/spreadsheets/${sheetId}/values:batchGet?${parameters.toString()}`,
  )
  if ((values.valueRanges || []).length !== EXPECTED_TABS.length) {
    throw new PipelineProvisioningRequestError(
      'Managed pipeline Sheet headers did not verify',
      409,
      'GOOGLE_PIPELINE_HEADERS_INVALID',
    )
  }
  EXPECTED_TABS.forEach((title, index) => {
    const actual = values.valueRanges?.[index]?.values?.[0] || []
    if (title === 'Dropdowns') {
      const normalized = actual.map((header) => normalizeDropdownKey(String(header || ''))).filter(Boolean)
      const unique = new Set(normalized)
      const ownerConfigured = unique.has('owner') || unique.has('acct_manager')
      if (
        normalized.length !== unique.size
        || !ownerConfigured
        || REQUIRED_CONFIGURED_DROPDOWNS.some((header) => !unique.has(header))
      ) {
        throw new PipelineProvisioningRequestError(
          'Managed pipeline Dropdowns headers did not verify',
          409,
          'GOOGLE_PIPELINE_HEADERS_INVALID',
        )
      }
      return
    }
    const expected = TAB_HEADERS[title]
    if (actual.length !== expected.length || expected.some((header, column) => actual[column] !== header)) {
      throw new PipelineProvisioningRequestError(
        `Managed pipeline ${title} headers did not verify`,
        409,
        'GOOGLE_PIPELINE_HEADERS_INVALID',
      )
    }
  })
}

const shortLinkActor = async (pipeline: PipelineProvisioningRecord): Promise<ShortLinkActor> => {
  const scoped = await getPostgresPool().query<{ workspace_organization_id: string }>(
    `SELECT workspace_organization_id::text
     FROM pipeline_spaces
     WHERE id = $1::uuid
     LIMIT 1`,
    [pipeline.id],
  )
  const organizationId = scoped.rows[0]?.workspace_organization_id
  if (!organizationId) throw new Error('Pipeline workspace organization is not available')
  return {
    ownerEmail: pipeline.ownerEmail,
    organizationId,
    sourceApp: 'clawpilot',
    manageOrganization: false,
    service: false,
  }
}

async function ensurePipelineShortLink(pipeline: PipelineProvisioningRecord, sheetId: string) {
  const destinationUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`
  const actor = await shortLinkActor(pipeline)
  if (pipeline.shortLinkId) {
    const updated = await updateShortLink(actor, {
      id: pipeline.shortLinkId,
      destinationUrl,
      title: `${pipeline.name} pipeline`,
      tags: ['pipeline', 'google-sheet'],
    })
    return updated.id
  }
  const existing = (await listShortLinks(actor, {
    query: destinationUrl,
    status: 'active',
    sourceApp: 'clawpilot',
  })).filter((link) => link.ownerEmail === pipeline.ownerEmail && link.destinationUrl === destinationUrl)
  if (existing[0]) return existing[0].id
  const created = await createShortLink(actor, {
    destinationUrl,
    title: `${pipeline.name} pipeline`,
    tags: ['pipeline', 'google-sheet'],
  })
  return created.id
}

function permissionIsInherited(permission: DrivePermission) {
  return (permission.permissionDetails || []).some((detail) => (
    detail.inherited === true || Boolean(detail.inheritedFrom)
  ))
}

function normalizedPermissionEmail(permission: DrivePermission) {
  return String(permission.emailAddress || '').trim().toLowerCase()
}

function permissionRoleRank(role: string | undefined) {
  if (role === 'owner' || role === 'organizer') return 4
  if (role === 'fileOrganizer') return 3
  if (role === 'writer') return 2
  if (role === 'commenter' || role === 'reader') return 1
  return 0
}

async function listDrivePermissions(runtime: GoogleWorkspaceRuntime, resourceId: string) {
  const permissions: DrivePermission[] = []
  let pageToken = ''
  for (let page = 0; page < 10; page += 1) {
    const parameters = new URLSearchParams({
      supportsAllDrives: 'true',
      fields: 'nextPageToken,permissions(id,type,role,emailAddress,deleted,permissionDetails(inherited,inheritedFrom,permissionType,role))',
      pageSize: '100',
    })
    if (pageToken) parameters.set('pageToken', pageToken)
    const response = await googleDriveJson<{
      permissions?: DrivePermission[]
      nextPageToken?: string
    }>(runtime, `/drive/v3/files/${resourceId}/permissions?${parameters.toString()}`)
    if (Array.isArray(response.permissions)) permissions.push(...response.permissions)
    pageToken = String(response.nextPageToken || '').trim()
    if (!pageToken) return permissions
  }
  throw new PipelineProvisioningRequestError(
    'Google permission listing exceeded the safe page limit',
    409,
    'GOOGLE_PERMISSION_PAGE_LIMIT',
  )
}

async function createDrivePermission(
  runtime: GoogleWorkspaceRuntime,
  resourceId: string,
  email: string,
  role: 'reader' | 'writer',
) {
  const parameters = new URLSearchParams({
    supportsAllDrives: 'true',
    sendNotificationEmail: 'true',
    fields: 'id,type,role,emailAddress,permissionDetails(inherited,inheritedFrom,permissionType,role)',
  })
  return googleDriveJson<DrivePermission>(
    runtime,
    `/drive/v3/files/${resourceId}/permissions?${parameters.toString()}`,
    { method: 'POST', body: { type: 'user', role, emailAddress: email }, idempotent: false },
  )
}

async function updateDrivePermission(
  runtime: GoogleWorkspaceRuntime,
  resourceId: string,
  permissionId: string,
  role: 'reader' | 'writer',
) {
  const parameters = new URLSearchParams({
    supportsAllDrives: 'true',
    fields: 'id,type,role,emailAddress,permissionDetails(inherited,inheritedFrom,permissionType,role)',
  })
  return googleDriveJson<DrivePermission>(
    runtime,
    `/drive/v3/files/${resourceId}/permissions/${permissionId}?${parameters.toString()}`,
    { method: 'PATCH', body: { role }, idempotent: true },
  )
}

async function deleteDrivePermission(
  runtime: GoogleWorkspaceRuntime,
  resourceId: string,
  permissionId: string,
) {
  const parameters = new URLSearchParams({ supportsAllDrives: 'true' })
  await googleDriveJson(
    runtime,
    `/drive/v3/files/${resourceId}/permissions/${permissionId}?${parameters.toString()}`,
    { method: 'DELETE', idempotent: true },
  )
}

async function reconcilePipelineGooglePermissionsUnlocked(
  pipelineId: string,
  providedRuntime?: GoogleWorkspaceRuntime,
) {
  const context = await readPipelineGooglePermissionContextInPostgres(pipelineId)
  const { pipeline } = context
  if (!pipeline.driveFolderId || !pipeline.googleServiceAccountEmail || !pipeline.googleSharedDriveId) {
    return { skipped: true }
  }
  const runtime = providedRuntime || await runtimeForPipeline(pipeline)
  const resourceId = pipeline.driveFolderId
  const folder = await getDriveFile(runtime, resourceId)
  verifyPipelineFolder(folder, pipeline.id, runtimeSharedDriveId(runtime))
  const permissions = await listDrivePermissions(runtime, resourceId)
  const active = permissions.filter((permission) => !permission.deleted)
  const direct = active.filter((permission) => !permissionIsInherited(permission))
  const inherited = active.filter(permissionIsInherited)

  if (direct.some((permission) => ['anyone', 'domain', 'group'].includes(String(permission.type || '')))) {
    throw new PipelineProvisioningRequestError(
      'Remove direct anyone, domain, or group access from the managed pipeline folder',
      409,
      'GOOGLE_PIPELINE_BROAD_PERMISSION',
    )
  }
  const directUsers = direct.filter((permission) => permission.type === 'user')
  if (directUsers.some((permission) => !normalizedPermissionEmail(permission))) {
    throw new PipelineProvisioningRequestError(
      'A direct Google user permission has no verifiable email address',
      409,
      'GOOGLE_PIPELINE_PERMISSION_INVALID',
    )
  }

  const desired = new Map<string, 'reader' | 'writer'>([[pipeline.ownerEmail, 'writer']])
  for (const member of context.members) {
    desired.set(member.email, member.accessRole === 'editor' ? 'writer' : 'reader')
  }
  const trackedRemovalEmails = new Set(
    context.trackedPermissions
      .filter((tracked) => tracked.resourceId === resourceId && !desired.has(tracked.userEmail))
      .map((tracked) => tracked.userEmail),
  )
  const permittedDirectEmails = new Set([
    runtime.serviceAccountEmail,
    ...desired.keys(),
    ...trackedRemovalEmails,
  ])
  if (directUsers.some((permission) => !permittedDirectEmails.has(normalizedPermissionEmail(permission)))) {
    throw new PipelineProvisioningRequestError(
      'Unmanaged direct Google user permissions require operator review',
      409,
      'GOOGLE_PIPELINE_UNMANAGED_PERMISSION',
    )
  }

  const directByEmail = new Map<string, DrivePermission[]>()
  for (const permission of directUsers) {
    const email = normalizedPermissionEmail(permission)
    directByEmail.set(email, [...(directByEmail.get(email) || []), permission])
  }
  if (Array.from(directByEmail.values()).some((matches) => matches.length > 1)) {
    throw new PipelineProvisioningRequestError(
      'Duplicate direct Google user permissions require operator review',
      409,
      'GOOGLE_PIPELINE_PERMISSION_DUPLICATE',
    )
  }

  const inheritedByEmail = new Map<string, DrivePermission[]>()
  for (const permission of inherited.filter((candidate) => candidate.type === 'user')) {
    const email = normalizedPermissionEmail(permission)
    if (!email) continue
    inheritedByEmail.set(email, [...(inheritedByEmail.get(email) || []), permission])
  }

  for (const tracked of context.trackedPermissions) {
    if (tracked.resourceId !== resourceId || desired.has(tracked.userEmail)) continue
    const remote = (directByEmail.get(tracked.userEmail) || [])[0]
    if (remote) {
      const permissionId = validResourceId(remote.id, 'Google permission ID')
      if (permissionId !== tracked.permissionId) {
        throw new PipelineProvisioningRequestError(
          'A tracked Google permission changed outside ClawPilot',
          409,
          'GOOGLE_PIPELINE_PERMISSION_CHANGED',
        )
      }
      await deleteDrivePermission(runtime, resourceId, permissionId)
      directByEmail.delete(tracked.userEmail)
    }
    await deletePipelineGooglePermissionTrackingInPostgres({
      pipelineId,
      resourceId,
      permissionId: tracked.permissionId,
      userEmail: tracked.userEmail,
    })
  }

  for (const [email, role] of desired) {
    let permission = (directByEmail.get(email) || [])[0]
    if (!permission) {
      const inheritedAccess = (inheritedByEmail.get(email) || []).some((candidate) => (
        permissionRoleRank(candidate.role) >= permissionRoleRank(role)
      ))
      if (inheritedAccess) continue
      permission = await createDrivePermission(runtime, resourceId, email, role)
    } else if (permission.role !== role) {
      if (permission.role !== 'reader' && permission.role !== 'writer') {
        throw new PipelineProvisioningRequestError(
          'A direct Google permission role requires operator review',
          409,
          'GOOGLE_PIPELINE_PERMISSION_ROLE_INVALID',
        )
      }
      permission = await updateDrivePermission(
        runtime,
        resourceId,
        validResourceId(permission.id, 'Google permission ID'),
        role,
      )
    }
    const permissionId = validResourceId(permission.id, 'Google permission ID')
    await upsertPipelineGooglePermissionTrackingInPostgres({
      pipelineId,
      resourceId,
      permissionId,
      userEmail: email,
      googleRole: role,
    })
  }
  return { skipped: false }
}

export function sanitizePipelineProvisioningError(error: unknown) {
  if (
    error instanceof PipelineProvisioningRequestError
    || error instanceof GoogleWorkspaceRequestError
    || error instanceof GoogleWorkspaceClientError
  ) {
    return error.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500)
  }
  return 'Google Workspace provisioning failed'
}

export async function rebuildPipelineGoogleWorkbook(input: {
  pipelineId: string
  actorEmail: string
}) {
  return withPipelineGoogleLock(`hierarchy:${managedEnvironmentName()}`, async () => {
    let pipeline = await readPipelineProvisioningRecordInPostgres(input.pipelineId)
    const actorEmail = normalizeUserEmail(input.actorEmail)
    if (pipeline.ownerEmail !== actorEmail) {
      throw new PipelineProvisioningRequestError(
        'Only the pipeline owner can rebuild its CRM workbook', 403, 'PIPELINE_OWNER_REQUIRED',
      )
    }
    if (!pipeline.sheetId || !pipeline.driveFolderId || pipeline.provisioningStatus !== 'ready') {
      throw new PipelineProvisioningRequestError(
        'Pipeline workbook must finish provisioning before it can be rebuilt',
        409,
        'GOOGLE_PIPELINE_NOT_READY',
      )
    }
    const previousSheetId = pipeline.sheetId
    const runtime = await runtimeForPipeline(pipeline)
    await validateGoogleSheetsAccess(runtime)
    const folder = await getDriveFile(runtime, pipeline.driveFolderId)
    verifyPipelineFolder(folder, pipeline.id, runtimeSharedDriveId(runtime))
    const previousSheet = await getDriveFile(runtime, previousSheetId)
    verifyPipelineFile(previousSheet, pipeline.id, pipeline.driveFolderId, runtimeSharedDriveId(runtime))
    const identity = await syncAppUserProfileToCrm({ email: pipeline.ownerEmail, pipelineId: pipeline.id })
    const sheetName = pipelineDriveName(pipeline, identity)
    const parameters = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id' })
    const created = await googleDriveJson<DriveFile>(runtime, `/drive/v3/files?${parameters.toString()}`, {
      method: 'POST',
      body: {
        name: sheetName,
        mimeType: SHEET_MIME_TYPE,
        parents: [pipeline.driveFolderId],
        appProperties: fileProperties('pipeline-sheet-replacement', { pipelineId: pipeline.id }),
      },
      idempotent: false,
    })
    const sheetId = validResourceId(created.id, 'Replacement pipeline Sheet ID')
    let rebound = false
    try {
      await configurePipelineTabs(runtime, sheetId)
      await applyPipelineWorkbookBranding(runtime, sheetId, await readPipelineWorkbookBranding(pipeline.id))
      await verifyPipelineTabsAndHeaders(runtime, sheetId)
      const fileParameters = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name,appProperties' })
      await googleDriveJson(runtime, `/drive/v3/files/${previousSheetId}?${fileParameters.toString()}`, {
        method: 'PATCH',
        body: {
          name: `${sheetName} (retired ${new Date().toISOString().slice(0, 10)})`,
          appProperties: fileProperties('pipeline-sheet-retired', { pipelineId: pipeline.id }),
        },
        idempotent: true,
      })
      await googleDriveJson(runtime, `/drive/v3/files/${sheetId}?${fileParameters.toString()}`, {
        method: 'PATCH',
        body: { name: sheetName, appProperties: fileProperties('pipeline-sheet', { pipelineId: pipeline.id }) },
        idempotent: true,
      })
      pipeline = await replacePipelineSheetBindingInPostgres({
        pipelineId: pipeline.id,
        expectedSheetId: previousSheetId,
        sheetId,
        actorEmail,
      })
      rebound = true
      await reconcilePipelineGooglePermissionsUnlocked(pipeline.id, runtime)
      const shortLinkId = await ensurePipelineShortLink(pipeline, sheetId)
      if (pipeline.shortLinkId !== shortLinkId) {
        pipeline = await storePipelineShortLinkIdInPostgres({
          pipelineId: pipeline.id,
          expectedShortLinkId: pipeline.shortLinkId,
          shortLinkId,
        })
      }
      return {
        pipelineId: pipeline.id,
        previousSheetId,
        sheetId,
        url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
      }
    } catch (error) {
      if (!rebound) {
        const fileParameters = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name,appProperties' })
        await googleDriveJson(runtime, `/drive/v3/files/${previousSheetId}?${fileParameters.toString()}`, {
          method: 'PATCH',
          body: {
            name: previousSheet.name || sheetName,
            appProperties: fileProperties('pipeline-sheet', { pipelineId: pipeline.id }),
          },
          idempotent: true,
        }).catch(() => null)
        await googleDriveJson(runtime, `/drive/v3/files/${sheetId}?${fileParameters.toString()}`, {
          method: 'PATCH',
          body: {
            name: `${sheetName} (replacement failed ${new Date().toISOString().slice(0, 10)})`,
            appProperties: fileProperties('pipeline-sheet-replacement-failed', { pipelineId: pipeline.id }),
          },
          idempotent: true,
        }).catch(() => null)
      }
      throw error
    }
  })
}

export async function provisionPipelineGoogleResources(pipelineId: string) {
  try {
    return await withPipelineGoogleLock(`hierarchy:${managedEnvironmentName()}`, async () => {
      let pipeline = await markPipelineProvisioningStartedInPostgres(pipelineId)
      const identity = await syncAppUserProfileToCrm({
        email: pipeline.ownerEmail,
        pipelineId: pipeline.id,
      })
      const runtime = await runtimeForPipeline(pipeline)
      await validateGoogleSheetsAccess(runtime)
      const alreadyReady = pipeline.provisioningStatus === 'ready' && Boolean(pipeline.sheetId && pipeline.syncEnabled)

      const folderId = await ensurePipelineFolder(runtime, pipeline, identity)
      if (pipeline.driveFolderId && pipeline.driveFolderId !== folderId) {
        throw new PipelineProvisioningRequestError(
          'Managed pipeline folder binding did not verify',
          409,
          'GOOGLE_PIPELINE_FOLDER_INVALID',
        )
      }
      const folderFile = await getDriveFile(runtime, folderId)
      verifyPipelineFolder(folderFile, pipeline.id, runtimeSharedDriveId(runtime))
      if (!pipeline.driveFolderId && !alreadyReady) {
        pipeline = await storePipelineDriveFolderIdInPostgres({
          pipelineId: pipeline.id,
          expectedFolderId: null,
          folderId,
        })
      }

      const sheetId = await ensurePipelineSheet(
        runtime,
        pipeline,
        folderId,
        pipelineDriveName(pipeline, identity),
      )
      const stagedSheetFile = await getDriveFile(runtime, sheetId)
      verifyPipelineFile(stagedSheetFile, pipeline.id, folderId, runtimeSharedDriveId(runtime))
      if (!pipeline.provisioningSheetId && !alreadyReady) {
        pipeline = await storePipelineProvisioningSheetIdInPostgres({
          pipelineId: pipeline.id,
          expectedSheetId: null,
          sheetId,
        })
      }

      if (alreadyReady) {
        await configurePipelineTabs(runtime, sheetId)
        await applyPipelineWorkbookBranding(
          runtime,
          sheetId,
          await readPipelineWorkbookBranding(pipeline.id),
        )
        await verifyPipelineTabsAndHeaders(runtime, sheetId)
        await reconcilePipelineGooglePermissionsUnlocked(pipeline.id, runtime)
        const shortLinkId = await ensurePipelineShortLink(pipeline, sheetId)
        if (pipeline.shortLinkId !== shortLinkId) {
          await storePipelineShortLinkIdInPostgres({
            pipelineId: pipeline.id,
            expectedShortLinkId: pipeline.shortLinkId,
            shortLinkId,
          })
        }
        return { pipelineId: pipeline.id, provisioningStatus: 'ready' as const }
      }

      await configurePipelineTabs(runtime, sheetId)
      await applyPipelineWorkbookBranding(
        runtime,
        sheetId,
        await readPipelineWorkbookBranding(pipeline.id),
      )
      await verifyPipelineTabsAndHeaders(runtime, sheetId)
      const verifiedSheetFile = await getDriveFile(runtime, sheetId)
      verifyPipelineFile(verifiedSheetFile, pipeline.id, folderId, runtimeSharedDriveId(runtime))
      await reconcilePipelineGooglePermissionsUnlocked(pipeline.id, runtime)

      const shortLinkId = await ensurePipelineShortLink(pipeline, sheetId)
      if (pipeline.shortLinkId !== shortLinkId) {
        pipeline = await storePipelineShortLinkIdInPostgres({
          pipelineId: pipeline.id,
          expectedShortLinkId: pipeline.shortLinkId,
          shortLinkId,
        })
      }
      pipeline = await completePipelineProvisioningInPostgres(pipeline.id)
      return { pipelineId: pipeline.id, provisioningStatus: pipeline.provisioningStatus }
    })
  } catch (error) {
    await recordPipelineProvisioningFailureInPostgres({
      pipelineId,
      error: sanitizePipelineProvisioningError(error),
    })
    throw error
  }
}

export async function reconcilePipelineGooglePermissions(pipelineId: string) {
  return withPipelineGoogleLock(pipelineId, () => reconcilePipelineGooglePermissionsUnlocked(pipelineId))
}

function normalizeDropdownKey(input: string) {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function catalogFromDropdownRows(values: unknown[][]): Record<string, string[]> {
  const headers = values[0] || []
  return Object.fromEntries(headers.flatMap((header, column) => {
    const key = normalizeDropdownKey(String(header || ''))
    if (!key) return []
    const seen = new Set<string>()
    const options = values.slice(1).flatMap((row) => {
      const value = String(row[column] || '').trim()
      const normalized = value.toLowerCase()
      if (!value || seen.has(normalized)) return []
      seen.add(normalized)
      return [value]
    })
    return [[key, options] as const]
  }))
}

function dropdownRows(catalog: Record<string, string[]>) {
  const keys = orderedDropdownKeys(catalog)
  const rowCount = Math.max(1, ...keys.map((key) => catalog[key].length))
  return [
    keys,
    ...Array.from({ length: rowCount }, (_, row) => keys.map((key) => catalog[key][row] || '')),
  ]
}

function columnName(index: number) {
  let current = index + 1
  let out = ''
  while (current > 0) {
    out = String.fromCharCode(65 + ((current - 1) % 26)) + out
    current = Math.floor((current - 1) / 26)
  }
  return out
}

export async function replaceManagedPipelineDropdowns(input: {
  runtime: GoogleWorkspaceRuntime
  sheetId: string
  catalog: PipelineDropdownCatalog
}) {
  const readRange = 'Dropdowns!B4:ZZ2000'
  const current = await googleSheetsJson<{ values?: unknown[][] }>(
    input.runtime,
    `/v4/spreadsheets/${input.sheetId}/values/${encodeURIComponent(readRange)}`,
  )
  const merged = catalogFromDropdownRows(current.values || [])
  for (const [key, options] of Object.entries(input.catalog.dropdowns || {})) {
    const normalizedKey = normalizeDropdownKey(key)
    if (!normalizedKey) continue
    const seen = new Set<string>()
    merged[normalizedKey] = options
      .filter((option) => option.active !== false)
      .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0))
      .map((option) => String(option.label || option.value || '').trim())
      .filter((value) => {
        const normalized = value.toLowerCase()
        if (!value || seen.has(normalized)) return false
        seen.add(normalized)
        return true
      })
  }
  const rows = dropdownRows(merged)
  await googleSheetsJson(
    input.runtime,
    `/v4/spreadsheets/${input.sheetId}/values/${encodeURIComponent(readRange)}:clear`,
    { method: 'POST', body: {}, idempotent: true },
  )
  const endColumn = columnName(1 + Math.max(1, rows[0].length) - 1)
  const writeRange = `Dropdowns!B4:${endColumn}${3 + rows.length}`
  await googleSheetsJson(
    input.runtime,
    `/v4/spreadsheets/${input.sheetId}/values/${encodeURIComponent(writeRange)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: { range: writeRange, majorDimension: 'ROWS', values: rows },
      idempotent: true,
    },
  )
}
