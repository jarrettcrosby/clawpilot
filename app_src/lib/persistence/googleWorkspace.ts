import type { PoolClient } from 'pg'
import { query, withTransaction } from '@/lib/persistence/postgres'
import type { EncryptedGoogleWorkspaceSecret } from '@/lib/integrations/googleWorkspaceCrypto'

type GoogleWorkspaceRow = {
  api_key_ciphertext: Buffer | null
  api_key_iv: Buffer | null
  api_key_tag: Buffer | null
  api_key_last_four: string | null
  service_account_ciphertext: Buffer | null
  service_account_iv: Buffer | null
  service_account_tag: Buffer | null
  project_id: string | null
  service_account_email: string | null
  private_key_id: string | null
  credential_version: number
  selected_shared_drive_id: string | null
  selected_shared_drive_name: string | null
  verified_at: string | null
  created_at: string
  updated_at: string
}

export type GoogleWorkspaceIntegrationRecord = {
  apiKeySecret: EncryptedGoogleWorkspaceSecret | null
  apiKeyLastFour: string | null
  serviceAccountSecret: EncryptedGoogleWorkspaceSecret | null
  projectId: string | null
  serviceAccountEmail: string | null
  privateKeyId: string | null
  credentialVersion: number
  selectedSharedDriveId: string | null
  selectedSharedDriveName: string | null
  verifiedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export class GoogleWorkspacePersistenceConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleWorkspacePersistenceConflictError'
  }
}

function secret(ciphertext: Buffer | null, iv: Buffer | null, tag: Buffer | null) {
  return ciphertext && iv && tag ? { ciphertext, iv, tag } : null
}

function record(row?: GoogleWorkspaceRow): GoogleWorkspaceIntegrationRecord {
  return {
    apiKeySecret: row ? secret(row.api_key_ciphertext, row.api_key_iv, row.api_key_tag) : null,
    apiKeyLastFour: row?.api_key_last_four || null,
    serviceAccountSecret: row
      ? secret(row.service_account_ciphertext, row.service_account_iv, row.service_account_tag)
      : null,
    projectId: row?.project_id || null,
    serviceAccountEmail: row?.service_account_email || null,
    privateKeyId: row?.private_key_id || null,
    credentialVersion: row?.credential_version || 0,
    selectedSharedDriveId: row?.selected_shared_drive_id || null,
    selectedSharedDriveName: row?.selected_shared_drive_name || null,
    verifiedAt: row?.verified_at || null,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
  }
}

async function ensureRow(client: PoolClient) {
  await client.query(
    'INSERT INTO google_workspace_integration (singleton_id) VALUES (1) ON CONFLICT (singleton_id) DO NOTHING',
  )
}

async function readWithClient(client: PoolClient, lock = false) {
  const result = await client.query<GoogleWorkspaceRow>(
    `
      SELECT
        api_key_ciphertext,
        api_key_iv,
        api_key_tag,
        api_key_last_four,
        service_account_ciphertext,
        service_account_iv,
        service_account_tag,
        project_id,
        service_account_email,
        private_key_id,
        credential_version,
        selected_shared_drive_id,
        selected_shared_drive_name,
        verified_at::text,
        created_at::text,
        updated_at::text
      FROM google_workspace_integration
      WHERE singleton_id = 1
      ${lock ? 'FOR UPDATE' : ''}
    `,
  )
  return record(result.rows[0])
}

function assertExpectedVersion(current: GoogleWorkspaceIntegrationRecord, expectedVersion: number) {
  if (current.credentialVersion !== expectedVersion) {
    throw new GoogleWorkspacePersistenceConflictError('Google Workspace integration changed; refresh and retry')
  }
}

async function audit(
  client: PoolClient,
  actor: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    `
      INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
      VALUES ($1, $2, 'google_workspace_integration', 'platform', $3::jsonb)
    `,
    [actor, eventType, JSON.stringify(payload)],
  )
}

export async function readGoogleWorkspaceIntegrationRecordInPostgres() {
  const result = await query<GoogleWorkspaceRow>(
    `
      SELECT
        api_key_ciphertext,
        api_key_iv,
        api_key_tag,
        api_key_last_four,
        service_account_ciphertext,
        service_account_iv,
        service_account_tag,
        project_id,
        service_account_email,
        private_key_id,
        credential_version,
        selected_shared_drive_id,
        selected_shared_drive_name,
        verified_at::text,
        created_at::text,
        updated_at::text
      FROM google_workspace_integration
      WHERE singleton_id = 1
    `,
  )
  return record(result.rows[0])
}

export async function writeGoogleWorkspaceCredentialInPostgres(input: {
  actor: string
  expectedVersion: number
  apiKeySecret: EncryptedGoogleWorkspaceSecret | null
  apiKeyLastFour: string | null
  serviceAccountSecret: EncryptedGoogleWorkspaceSecret | null
  projectId: string | null
  serviceAccountEmail: string | null
  privateKeyId: string | null
  selectedSharedDriveId: string | null
  selectedSharedDriveName: string | null
  verifiedAt: string
  eventType: 'google_workspace.credential.set' | 'google_workspace.credential.rotated'
}) {
  return withTransaction(async (client) => {
    await ensureRow(client)
    const current = await readWithClient(client, true)
    assertExpectedVersion(current, input.expectedVersion)
    if (current.serviceAccountEmail !== input.serviceAccountEmail) {
      const incompatibleBinding = await client.query(
        `
          SELECT 1
          FROM pipeline_spaces
          WHERE google_service_account_email IS NOT NULL
            AND google_service_account_email IS DISTINCT FROM $1
          LIMIT 1
        `,
        [input.serviceAccountEmail],
      )
      if (incompatibleBinding.rows[0]) {
        throw new GoogleWorkspacePersistenceConflictError(
          'Existing managed pipelines are bound to a different service account',
        )
      }
    }

    await client.query(
      `
        UPDATE google_workspace_integration
        SET api_key_ciphertext = $1,
            api_key_iv = $2,
            api_key_tag = $3,
            api_key_last_four = $4,
            service_account_ciphertext = $5,
            service_account_iv = $6,
            service_account_tag = $7,
            project_id = $8,
            service_account_email = $9,
            private_key_id = $10,
            selected_shared_drive_id = $11,
            selected_shared_drive_name = $12,
            verified_at = $13::timestamptz,
            credential_version = credential_version + 1,
            updated_at = now()
        WHERE singleton_id = 1
      `,
      [
        input.apiKeySecret?.ciphertext || null,
        input.apiKeySecret?.iv || null,
        input.apiKeySecret?.tag || null,
        input.apiKeyLastFour,
        input.serviceAccountSecret?.ciphertext || null,
        input.serviceAccountSecret?.iv || null,
        input.serviceAccountSecret?.tag || null,
        input.projectId,
        input.serviceAccountEmail,
        input.privateKeyId,
        input.selectedSharedDriveId,
        input.selectedSharedDriveName,
        input.verifiedAt,
      ],
    )
    await audit(client, input.actor, input.eventType, {
      apiKeyConfigured: Boolean(input.apiKeySecret),
      serviceAccountConfigured: Boolean(input.serviceAccountSecret),
      serviceAccountEmail: input.serviceAccountEmail,
      projectId: input.projectId,
      privateKeyId: input.privateKeyId,
      sharedDriveConfigured: Boolean(input.selectedSharedDriveId),
    })
    return readWithClient(client)
  })
}

export async function selectGoogleWorkspaceSharedDriveInPostgres(input: {
  actor: string
  expectedVersion: number
  sharedDriveId: string
  sharedDriveName: string
  verifiedAt: string
}) {
  return withTransaction(async (client) => {
    await ensureRow(client)
    const current = await readWithClient(client, true)
    assertExpectedVersion(current, input.expectedVersion)
    if (!current.serviceAccountSecret) throw new Error('A service-account credential is required')
    await client.query(
      `
        UPDATE google_workspace_integration
        SET selected_shared_drive_id = $1,
            selected_shared_drive_name = $2,
            verified_at = $3::timestamptz,
            credential_version = credential_version + 1,
            updated_at = now()
        WHERE singleton_id = 1
      `,
      [input.sharedDriveId, input.sharedDriveName, input.verifiedAt],
    )
    await audit(client, input.actor, 'google_workspace.shared_drive.selected', {
      sharedDriveName: input.sharedDriveName,
    })
    return readWithClient(client)
  })
}

export async function disconnectGoogleWorkspaceIntegrationInPostgres(input: {
  actor: string
  expectedVersion: number
}) {
  return withTransaction(async (client) => {
    await ensureRow(client)
    const current = await readWithClient(client, true)
    assertExpectedVersion(current, input.expectedVersion)
    const managedPipeline = await client.query(
      `
        SELECT 1
        FROM pipeline_spaces
        WHERE google_service_account_email IS NOT NULL
        LIMIT 1
      `,
    )
    if (managedPipeline.rows[0]) {
      throw new GoogleWorkspacePersistenceConflictError(
        'Disconnect is blocked while managed pipelines are bound to this Google Workspace integration',
      )
    }
    await client.query(
      `
        UPDATE google_workspace_integration
        SET api_key_ciphertext = NULL,
            api_key_iv = NULL,
            api_key_tag = NULL,
            api_key_last_four = NULL,
            service_account_ciphertext = NULL,
            service_account_iv = NULL,
            service_account_tag = NULL,
            project_id = NULL,
            service_account_email = NULL,
            private_key_id = NULL,
            selected_shared_drive_id = NULL,
            selected_shared_drive_name = NULL,
            verified_at = NULL,
            credential_version = credential_version + 1,
            updated_at = now()
        WHERE singleton_id = 1
      `,
    )
    await audit(client, input.actor, 'google_workspace.disconnected', {
      previousServiceAccountEmail: current.serviceAccountEmail,
      hadManagedDrive: Boolean(current.selectedSharedDriveId),
    })
    return readWithClient(client)
  })
}

export async function recordGoogleWorkspaceIntegrationEventInPostgres(input: {
  actor: string
  eventType: 'google_workspace.connection.tested' | 'google_workspace.shared_drives.refreshed'
  payload?: Record<string, unknown>
}) {
  await withTransaction((client) => audit(client, input.actor, input.eventType, input.payload || {}))
}

export async function markGoogleWorkspaceVerifiedInPostgres(input: {
  actor: string
  expectedVersion: number
  verifiedAt: string
}) {
  return withTransaction(async (client) => {
    await ensureRow(client)
    const current = await readWithClient(client, true)
    assertExpectedVersion(current, input.expectedVersion)
    await client.query(
      `
        UPDATE google_workspace_integration
        SET verified_at = $1::timestamptz,
            updated_at = now()
        WHERE singleton_id = 1
      `,
      [input.verifiedAt],
    )
    await audit(client, input.actor, 'google_workspace.connection.tested', {
      serviceAccountEmail: current.serviceAccountEmail,
      sharedDriveConfigured: Boolean(current.selectedSharedDriveId),
    })
    return readWithClient(client)
  })
}
