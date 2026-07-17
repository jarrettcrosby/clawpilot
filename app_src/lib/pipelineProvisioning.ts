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
import { createShortLink, listShortLinks, type ShortLinkActor } from '@/lib/shortlinks'
import { ensurePrimaryWorkspaceOrganization } from '@/lib/organizations'
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
    properties?: { sheetId?: number; title?: string; index?: number }
    protectedRanges?: Array<{ protectedRangeId?: number; description?: string }>
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

const INITIAL_TAB_ROWS: Partial<Record<(typeof EXPECTED_TABS)[number], unknown[][]>> = {
  'Start Here': [
    ['Opportunity updates', 'Edit rows on the Opportunities tab. ClawPilot syncs those changes into the CRM.'],
    ['CRM records', 'Organizations, Contacts, and Interactions are generated from the CRM and are read-only here.'],
    ['Reporting', 'Calculations and Dashboard are generated from the CRM projection.'],
  ],
  Calculations: [
    ['Total opportunities', '=COUNTA(Opportunities!C5:C)'],
    ['Open pipeline', '=SUMIFS(Opportunities!J5:J,Opportunities!F5:F,"<>Closed",Opportunities!F5:F,"<>Lost",Opportunities!F5:F,"<>Abandoned")'],
    ['Weighted pipeline', '=SUMPRODUCT(Opportunities!J5:J,Opportunities!K5:K/100,--(Opportunities!F5:F<>"Closed"),--(Opportunities!F5:F<>"Lost"),--(Opportunities!F5:F<>"Abandoned"))'],
    ['Won value', '=SUMIF(Opportunities!F5:F,"Won",Opportunities!J5:J)'],
    ['Organizations', '=COUNTA(Organizations!C5:C)'],
    ['Contacts', '=COUNTA(Contacts!C5:C)'],
    ['Interactions', '=COUNTA(Interactions!C5:C)'],
  ],
  Dashboard: [
    ['Open pipeline', '=Calculations!C6'],
    ['Weighted pipeline', '=Calculations!C7'],
    ['Won value', '=Calculations!C8'],
    ['Opportunities', '=Calculations!C5'],
    ['Organizations', '=Calculations!C9'],
    ['Contacts', '=Calculations!C10'],
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
    `/v4/spreadsheets/${sheetId}?fields=spreadsheetId,sheets(properties,protectedRanges(protectedRangeId,description))`,
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
  }

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

        writes.push({
          range: `'${title}'!B4`,
          majorDimension: 'ROWS',
          values: [TAB_HEADERS[title]],
        })
        if (INITIAL_TAB_ROWS[title]) {
          writes.push({
            range: `'${title}'!B5`,
            majorDimension: 'ROWS',
            values: INITIAL_TAB_ROWS[title] || [],
          })
        }
        return writes
      }),
    },
    idempotent: true,
  })

  metadata = await spreadsheetMetadata(request, sheetId)
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
    for (const range of sheet.protectedRanges || []) {
      if (range.protectedRangeId !== undefined && String(range.description || '').startsWith(PROTECTION_PREFIX)) {
        formattingRequests.push({ deleteProtectedRange: { protectedRangeId: range.protectedRangeId } })
      }
    }
    formattingRequests.push({
      updateSheetProperties: {
        properties: {
          sheetId: sheetIdValue,
          index: EXPECTED_TABS.indexOf(title),
          gridProperties: { frozenRowCount: 4, frozenColumnCount: 1 },
        },
        fields: 'index,gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    })
    formattingRequests.push({
      updateDimensionProperties: {
        range: { sheetId: sheetIdValue, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    })
    formattingRequests.push({
      repeatCell: {
        range: { sheetId: sheetIdValue, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 1, endColumnIndex: 1 + TAB_HEADERS[title].length },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.12, green: 0.14, blue: 0.18 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
            horizontalAlignment: 'LEFT',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    })
    formattingRequests.push({
      autoResizeDimensions: {
        dimensions: { sheetId: sheetIdValue, dimension: 'COLUMNS', startIndex: 1, endIndex: 1 + TAB_HEADERS[title].length },
      },
    })
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

export async function applyPipelineWorkbookBrandingWithRequest(
  request: SheetsJsonRequest,
  sheetId: string,
  branding: OrganizationBranding,
) {
  const metadata = await spreadsheetMetadata(request, sheetId)
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
  const escapedLogoUrl = branding.logoUrl.replace(/"/g, '""')
  await request(`/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    body: {
      valueInputOption: 'USER_ENTERED',
      data: managedSheets.flatMap((sheet) => {
        const title = sheet.properties?.title as (typeof EXPECTED_TABS)[number]
        return [
          { range: `'${title}'!B1`, majorDimension: 'ROWS', values: [[`=IMAGE("${escapedLogoUrl}",4,48,48)`]] },
          { range: `'${title}'!C1`, majorDimension: 'ROWS', values: [[sheetText(branding.organizationName)]] },
          { range: `'${title}'!C2`, majorDimension: 'ROWS', values: [['Powered by ClawPilot']] },
        ]
      }),
    },
    idempotent: true,
  })

  const primary = googleColor(branding.primaryColor)
  const accent = googleColor(branding.accentColor)
  const foreground = contrastingGoogleColor(branding.primaryColor)
  const requests: unknown[] = []
  for (const sheet of managedSheets) {
    const id = sheet.properties?.sheetId
    const title = sheet.properties?.title as (typeof EXPECTED_TABS)[number]
    if (id === undefined) continue
    const endColumnIndex = Math.max(8, 1 + TAB_HEADERS[title].length)
    requests.push(
      {
        repeatCell: {
          range: { sheetId: id, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 1, endColumnIndex },
          cell: { userEnteredFormat: { backgroundColor: primary } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      },
      {
        repeatCell: {
          range: { sheetId: id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 2, endColumnIndex },
          cell: { userEnteredFormat: { textFormat: { foregroundColor: foreground, fontSize: 14, bold: true } } },
          fields: 'userEnteredFormat.textFormat',
        },
      },
      {
        repeatCell: {
          range: { sheetId: id, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex },
          cell: { userEnteredFormat: { textFormat: { foregroundColor: accent, fontSize: 10, bold: true } } },
          fields: 'userEnteredFormat.textFormat',
        },
      },
      {
        repeatCell: {
          range: { sheetId: id, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 1, endColumnIndex: 1 + TAB_HEADERS[title].length },
          cell: {
            userEnteredFormat: {
              backgroundColor: primary,
              textFormat: { foregroundColor: foreground, bold: true },
              borders: { bottom: { style: 'SOLID_THICK', color: accent } },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,borders)',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: id, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 52 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: id, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 58 },
          fields: 'pixelSize',
        },
      },
    )
  }
  if (requests.length > 0) {
    await request(`/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: { requests, includeSpreadsheetInResponse: false },
      idempotent: true,
    })
  }
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
    const endColumn = String.fromCharCode('A'.charCodeAt(0) + TAB_HEADERS[title].length)
    parameters.append('ranges', `'${title}'!B4:${endColumn}4`)
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
    const expected = TAB_HEADERS[title]
    if (actual.length !== expected.length || expected.some((header, column) => actual[column] !== header)) {
      throw new PipelineProvisioningRequestError(
        'Managed pipeline Sheet headers did not verify',
        409,
        'GOOGLE_PIPELINE_HEADERS_INVALID',
      )
    }
  })
}

const shortLinkActor = async (ownerEmail: string): Promise<ShortLinkActor> => ({
  ownerEmail,
  organizationId: (await ensurePrimaryWorkspaceOrganization(ownerEmail)).id,
  sourceApp: 'clawpilot',
  manageOrganization: false,
  service: false,
})

async function ensurePipelineShortLink(pipeline: PipelineProvisioningRecord, sheetId: string) {
  const destinationUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`
  const actor = await shortLinkActor(pipeline.ownerEmail)
  const existing = (await listShortLinks(actor, {
    query: destinationUrl,
    status: 'active',
    sourceApp: 'clawpilot',
  })).filter((link) => link.ownerEmail === pipeline.ownerEmail && link.destinationUrl === destinationUrl)
  const bound = pipeline.shortLinkId
    ? existing.find((link) => link.id === pipeline.shortLinkId)
    : null
  if (bound) return bound.id
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
    sendNotificationEmail: 'false',
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
  const keys = Object.keys(catalog).sort((left, right) => left.localeCompare(right))
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
