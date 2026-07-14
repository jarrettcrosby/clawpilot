import {
  decryptGoogleApiKey,
  decryptGoogleServiceAccount,
  encryptGoogleApiKey,
  encryptGoogleServiceAccount,
  normalizeGoogleApiKey,
  normalizeGoogleServiceAccount,
} from '@/lib/integrations/googleWorkspaceCrypto'
import {
  createGoogleWorkspaceRuntime,
  GoogleWorkspaceClientError,
  listAccessibleGoogleSharedDrives,
  validateGoogleApiKey,
  validateGoogleSheetsAccess,
  validateGoogleServiceAccount,
  verifyAccessibleGoogleSharedDrive,
  type GoogleSharedDrive,
  type GoogleWorkspaceRuntime,
} from '@/lib/integrations/googleWorkspaceClient'
import {
  disconnectGoogleWorkspaceIntegrationInPostgres,
  GoogleWorkspacePersistenceConflictError,
  markGoogleWorkspaceVerifiedInPostgres,
  readGoogleWorkspaceIntegrationRecordInPostgres,
  recordGoogleWorkspaceIntegrationEventInPostgres,
  selectGoogleWorkspaceSharedDriveInPostgres,
  writeGoogleWorkspaceCredentialInPostgres,
  type GoogleWorkspaceIntegrationRecord,
} from '@/lib/persistence/googleWorkspace'

export type GoogleWorkspaceIntegrationState = {
  configured: boolean
  ready: boolean
  apiKeyConfigured: boolean
  apiKeyLastFour: string | null
  serviceAccountConfigured: boolean
  projectId: string | null
  serviceAccountEmail: string | null
  privateKeyId: string | null
  credentialVersion: number
  sharedDriveConfigured: boolean
  sharedDriveName: string | null
  verifiedAt: string | null
  updatedAt: string | null
}

export class GoogleWorkspaceRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'GOOGLE_WORKSPACE_REQUEST_INVALID',
  ) {
    super(message)
    this.name = 'GoogleWorkspaceRequestError'
  }
}

function requestError(error: unknown): GoogleWorkspaceRequestError {
  if (error instanceof GoogleWorkspaceRequestError) return error
  if (error instanceof GoogleWorkspaceClientError) {
    return new GoogleWorkspaceRequestError(error.message, error.status, error.code)
  }
  if (error instanceof GoogleWorkspacePersistenceConflictError) {
    return new GoogleWorkspaceRequestError(error.message, 409, 'GOOGLE_WORKSPACE_CONFLICT')
  }
  if (
    error instanceof Error
    && (error.message.includes('service-account') || error.message.startsWith('Google credential'))
  ) {
    return new GoogleWorkspaceRequestError(error.message, 400, 'GOOGLE_SERVICE_ACCOUNT_INVALID')
  }
  if (
    error instanceof Error
    && (error.message.startsWith('Google API key') || error.message.startsWith('A Google API key'))
  ) {
    return new GoogleWorkspaceRequestError(error.message, 400, 'GOOGLE_API_KEY_INVALID')
  }
  if (error instanceof Error && error.message === 'Google Workspace credential encryption is not configured') {
    return new GoogleWorkspaceRequestError(
      'Google Workspace credential encryption is not configured',
      503,
      'GOOGLE_WORKSPACE_ENCRYPTION_REQUIRED',
    )
  }
  return new GoogleWorkspaceRequestError(
    'Google Workspace integration request failed',
    500,
    'GOOGLE_WORKSPACE_INTERNAL_ERROR',
  )
}

function state(record: GoogleWorkspaceIntegrationRecord): GoogleWorkspaceIntegrationState {
  const apiKeyConfigured = Boolean(record.apiKeySecret && record.apiKeyLastFour)
  const serviceAccountConfigured = Boolean(
    record.serviceAccountSecret
    && record.projectId
    && record.serviceAccountEmail
    && record.privateKeyId,
  )
  const sharedDriveConfigured = Boolean(record.selectedSharedDriveId && record.selectedSharedDriveName)
  return {
    configured: apiKeyConfigured || serviceAccountConfigured,
    ready: apiKeyConfigured && serviceAccountConfigured && sharedDriveConfigured && Boolean(record.verifiedAt),
    apiKeyConfigured,
    apiKeyLastFour: apiKeyConfigured ? record.apiKeyLastFour : null,
    serviceAccountConfigured,
    projectId: serviceAccountConfigured ? record.projectId : null,
    serviceAccountEmail: serviceAccountConfigured ? record.serviceAccountEmail : null,
    privateKeyId: serviceAccountConfigured ? record.privateKeyId : null,
    credentialVersion: record.credentialVersion,
    sharedDriveConfigured,
    sharedDriveName: sharedDriveConfigured ? record.selectedSharedDriveName : null,
    verifiedAt: record.verifiedAt,
    updatedAt: record.updatedAt,
  }
}

function serviceAccount(record: GoogleWorkspaceIntegrationRecord) {
  if (!record.serviceAccountSecret) {
    throw new GoogleWorkspaceRequestError(
      'Upload a Google service-account credential before using managed pipelines',
      409,
      'GOOGLE_SERVICE_ACCOUNT_REQUIRED',
    )
  }
  try {
    const credential = decryptGoogleServiceAccount(record.serviceAccountSecret)
    if (
      credential.client_email !== record.serviceAccountEmail
      || credential.project_id !== record.projectId
      || credential.private_key_id !== record.privateKeyId
    ) {
      throw new Error('metadata mismatch')
    }
    return credential
  } catch {
    throw new GoogleWorkspaceRequestError(
      'Stored Google service-account credential is unavailable',
      503,
      'GOOGLE_SERVICE_ACCOUNT_UNAVAILABLE',
    )
  }
}

function apiKey(record: GoogleWorkspaceIntegrationRecord) {
  if (!record.apiKeySecret) return null
  try {
    return decryptGoogleApiKey(record.apiKeySecret)
  } catch {
    throw new GoogleWorkspaceRequestError(
      'Stored Google API key is unavailable',
      503,
      'GOOGLE_API_KEY_UNAVAILABLE',
    )
  }
}

export async function getGoogleWorkspaceIntegrationState() {
  return state(await readGoogleWorkspaceIntegrationRecordInPostgres())
}

export async function updateGoogleWorkspaceCredential(input: {
  actorEmail: string
  apiKey?: unknown
  serviceAccountJson?: unknown
  setApiKey: boolean
  setServiceAccount: boolean
}) {
  try {
    if (!input.setApiKey && !input.setServiceAccount) {
      throw new GoogleWorkspaceRequestError('Provide apiKey and/or serviceAccountJson')
    }
    const current = await readGoogleWorkspaceIntegrationRecordInPostgres()
    const candidateServiceAccount = input.setServiceAccount
      ? normalizeGoogleServiceAccount(input.serviceAccountJson)
      : null
    const candidateApiKey = input.setApiKey
      ? normalizeGoogleApiKey(input.apiKey)
      : apiKey(current)
    const effectiveServiceAccount = candidateServiceAccount
      || (current.serviceAccountSecret ? serviceAccount(current) : null)
    if (input.setApiKey && candidateApiKey) await validateGoogleApiKey(candidateApiKey)

    let selectedSharedDriveId = current.selectedSharedDriveId
    let selectedSharedDriveName = current.selectedSharedDriveName
    if (input.setServiceAccount && candidateServiceAccount) {
      const candidateRuntime = createGoogleWorkspaceRuntime({
        serviceAccount: candidateServiceAccount,
        apiKey: candidateApiKey,
        credentialVersion: current.credentialVersion + 1,
      })
      await Promise.all([
        validateGoogleServiceAccount(candidateRuntime),
        validateGoogleSheetsAccess(candidateRuntime),
      ])
      if (current.selectedSharedDriveId) {
        try {
          const selected = await verifyAccessibleGoogleSharedDrive(candidateRuntime, current.selectedSharedDriveId)
          selectedSharedDriveId = selected.id
          selectedSharedDriveName = selected.name
        } catch (error) {
          if (candidateServiceAccount.client_email === current.serviceAccountEmail) throw error
          selectedSharedDriveId = null
          selectedSharedDriveName = null
        }
      }
    } else if (input.setApiKey && effectiveServiceAccount) {
      const candidateRuntime = createGoogleWorkspaceRuntime({
        serviceAccount: effectiveServiceAccount,
        apiKey: candidateApiKey,
        credentialVersion: current.credentialVersion + 1,
        sharedDriveId: current.selectedSharedDriveId,
        sharedDriveName: current.selectedSharedDriveName,
      })
      await Promise.all([
        validateGoogleServiceAccount(candidateRuntime),
        validateGoogleSheetsAccess(candidateRuntime),
      ])
      if (current.selectedSharedDriveId) {
        const selected = await verifyAccessibleGoogleSharedDrive(candidateRuntime, current.selectedSharedDriveId)
        selectedSharedDriveId = selected.id
        selectedSharedDriveName = selected.name
      }
    }

    const encryptedApiKey = input.setApiKey && candidateApiKey
      ? encryptGoogleApiKey(candidateApiKey)
      : current.apiKeySecret
    const encryptedServiceAccount = input.setServiceAccount && candidateServiceAccount
      ? encryptGoogleServiceAccount(candidateServiceAccount)
      : current.serviceAccountSecret
    const updated = await writeGoogleWorkspaceCredentialInPostgres({
      actor: input.actorEmail,
      expectedVersion: current.credentialVersion,
      apiKeySecret: encryptedApiKey,
      apiKeyLastFour: candidateApiKey ? candidateApiKey.slice(-4) : null,
      serviceAccountSecret: encryptedServiceAccount,
      projectId: candidateServiceAccount?.project_id || current.projectId,
      serviceAccountEmail: candidateServiceAccount?.client_email || current.serviceAccountEmail,
      privateKeyId: candidateServiceAccount?.private_key_id || current.privateKeyId,
      selectedSharedDriveId,
      selectedSharedDriveName,
      verifiedAt: new Date().toISOString(),
      eventType: current.apiKeySecret || current.serviceAccountSecret
        ? 'google_workspace.credential.rotated'
        : 'google_workspace.credential.set',
    })
    return state(updated)
  } catch (error) {
    throw requestError(error)
  }
}

async function configuredRuntime(record: GoogleWorkspaceIntegrationRecord) {
  const credential = serviceAccount(record)
  const resolvedApiKey = apiKey(record)
  if (!resolvedApiKey) {
    throw new GoogleWorkspaceRequestError(
      'Configure the Google API key before provisioning managed pipelines',
      409,
      'GOOGLE_API_KEY_REQUIRED',
    )
  }
  return createGoogleWorkspaceRuntime({
    serviceAccount: credential,
    apiKey: resolvedApiKey,
    credentialVersion: record.credentialVersion,
    sharedDriveId: record.selectedSharedDriveId,
    sharedDriveName: record.selectedSharedDriveName,
  })
}

export async function refreshGoogleWorkspaceSharedDrives(input: { actorEmail: string }) {
  try {
    const current = await readGoogleWorkspaceIntegrationRecordInPostgres()
    const sharedDrives = await listAccessibleGoogleSharedDrives(await configuredRuntime(current))
    await recordGoogleWorkspaceIntegrationEventInPostgres({
      actor: input.actorEmail,
      eventType: 'google_workspace.shared_drives.refreshed',
      payload: { count: sharedDrives.length },
    })
    return { integration: state(current), sharedDrives }
  } catch (error) {
    throw requestError(error)
  }
}

export async function selectGoogleWorkspaceSharedDrive(input: {
  actorEmail: string
  sharedDriveId: unknown
}) {
  try {
    const current = await readGoogleWorkspaceIntegrationRecordInPostgres()
    const selected = await verifyAccessibleGoogleSharedDrive(
      await configuredRuntime(current),
      input.sharedDriveId,
    )
    const updated = await selectGoogleWorkspaceSharedDriveInPostgres({
      actor: input.actorEmail,
      expectedVersion: current.credentialVersion,
      sharedDriveId: selected.id,
      sharedDriveName: selected.name,
      verifiedAt: new Date().toISOString(),
    })
    return state(updated)
  } catch (error) {
    throw requestError(error)
  }
}

export async function testGoogleWorkspaceConnection(input: { actorEmail: string }) {
  try {
    const current = await readGoogleWorkspaceIntegrationRecordInPostgres()
    const resolvedRuntime = await configuredRuntime(current)
    await Promise.all([
      validateGoogleServiceAccount(resolvedRuntime),
      validateGoogleSheetsAccess(resolvedRuntime),
    ])
    if (current.selectedSharedDriveId) {
      await verifyAccessibleGoogleSharedDrive(resolvedRuntime, current.selectedSharedDriveId)
    }
    const updated = await markGoogleWorkspaceVerifiedInPostgres({
      actor: input.actorEmail,
      expectedVersion: current.credentialVersion,
      verifiedAt: new Date().toISOString(),
    })
    return state(updated)
  } catch (error) {
    throw requestError(error)
  }
}

export async function disconnectGoogleWorkspaceIntegration(input: { actorEmail: string }) {
  try {
    const current = await readGoogleWorkspaceIntegrationRecordInPostgres()
    return state(await disconnectGoogleWorkspaceIntegrationInPostgres({
      actor: input.actorEmail,
      expectedVersion: current.credentialVersion,
    }))
  } catch (error) {
    throw requestError(error)
  }
}

export async function resolveManagedGoogleWorkspaceRuntime(input: {
  serviceAccountEmail: string
  sharedDriveId: string
}) {
  try {
    const current = await readGoogleWorkspaceIntegrationRecordInPostgres()
    if (!current.serviceAccountEmail || current.serviceAccountEmail !== input.serviceAccountEmail) {
      throw new GoogleWorkspaceRequestError(
        'Managed pipeline is bound to a different Google service account',
        409,
        'GOOGLE_SERVICE_ACCOUNT_BINDING_MISMATCH',
      )
    }
    const resolvedRuntime = await configuredRuntime(current)
    const sharedDrive = await verifyAccessibleGoogleSharedDrive(resolvedRuntime, input.sharedDriveId)
    resolvedRuntime.sharedDriveId = sharedDrive.id
    resolvedRuntime.sharedDriveName = sharedDrive.name
    return resolvedRuntime
  } catch (error) {
    throw requestError(error)
  }
}

export async function resolveGoogleWorkspaceProvisioningRuntime() {
  try {
    const current = await readGoogleWorkspaceIntegrationRecordInPostgres()
    if (!current.apiKeySecret) {
      throw new GoogleWorkspaceRequestError(
        'Configure the Google API key before provisioning managed pipelines',
        409,
        'GOOGLE_API_KEY_REQUIRED',
      )
    }
    if (!current.serviceAccountSecret) {
      throw new GoogleWorkspaceRequestError(
        'Upload and validate a Google service-account credential before provisioning managed pipelines',
        409,
        'GOOGLE_SERVICE_ACCOUNT_REQUIRED',
      )
    }
    if (!current.selectedSharedDriveId) {
      throw new GoogleWorkspaceRequestError(
        'Select an accessible Shared Drive before provisioning managed pipelines',
        409,
        'GOOGLE_SHARED_DRIVE_REQUIRED',
      )
    }
    if (!current.verifiedAt) {
      throw new GoogleWorkspaceRequestError(
        'Test the Google Workspace integration before provisioning managed pipelines',
        409,
        'GOOGLE_WORKSPACE_VALIDATION_REQUIRED',
      )
    }
    const resolvedRuntime = await configuredRuntime(current)
    const sharedDrive = await verifyAccessibleGoogleSharedDrive(resolvedRuntime, current.selectedSharedDriveId)
    resolvedRuntime.sharedDriveId = sharedDrive.id
    resolvedRuntime.sharedDriveName = sharedDrive.name
    return resolvedRuntime
  } catch (error) {
    throw requestError(error)
  }
}

export function sanitizedGoogleWorkspaceError(error: unknown) {
  return requestError(error)
}

export type { GoogleSharedDrive, GoogleWorkspaceRuntime }
