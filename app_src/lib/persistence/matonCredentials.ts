import type { PoolClient } from 'pg'
import { query, withTransaction } from '@/lib/persistence/postgres'

type TimestampValue = string | Date

type CredentialRow = {
  owner_email: string
  login_email: string | null
  api_key_ciphertext: Buffer | null
  api_key_iv: Buffer | null
  api_key_tag: Buffer | null
  api_key_last_four: string | null
  api_key_version: number
  key_rotated_at: TimestampValue | null
  key_revoked_at: TimestampValue | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

type ConnectionRow = {
  owner_email: string
  connection_id: string
  name: string
  app: string
  status: string
  method: string | null
  account_email: string | null
  is_selected: boolean
  source: 'maton' | 'manual'
  remote_created_at: TimestampValue | null
  remote_updated_at: TimestampValue | null
  last_refreshed_at: TimestampValue | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

export type MatonEncryptedCredentialRecord = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

export type MatonGatewayCredentialLookup =
  | { status: 'missing-key' }
  | { status: 'missing-connection' }
  | {
      status: 'resolved'
      credential: MatonEncryptedCredentialRecord
      connectionId: string
      accountEmail: string | null
    }

type MatonGatewayCredentialRow = {
  api_key_ciphertext: Buffer | null
  api_key_iv: Buffer | null
  api_key_tag: Buffer | null
  connection_id: string | null
  account_email: string | null
}

type ActiveMatonConnectionRow = {
  connection_id: string
  account_email: string | null
  status: string
}

type MatonCredentialReadinessRow = {
  ready: boolean
}

export type ActiveMatonGatewayConnection = {
  connectionId: string
  accountEmail: string | null
  status: 'ACTIVE'
}

export type MatonConnectionWrite = {
  connectionId: string
  name: string
  app: string
  status: string
  method: string | null
  accountEmail: string | null
  source: 'maton' | 'manual'
  remoteCreatedAt: string | null
  remoteUpdatedAt: string | null
}

export type MatonConnectionState = MatonConnectionWrite & {
  selected: boolean
  lastRefreshedAt: string | null
  createdAt: string
  updatedAt: string
}

export type MatonCredentialState = {
  configured: boolean
  loginEmail: string | null
  keyLastFour: string | null
  keyVersion: number
  keyRotatedAt: string | null
  keyRevokedAt: string | null
  connections: MatonConnectionState[]
  createdAt: string | null
  updatedAt: string | null
}

type ApiKeyWrite = MatonEncryptedCredentialRecord & {
  lastFour: string
}

function iso(value: TimestampValue | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

function connectionState(row: ConnectionRow): MatonConnectionState {
  return {
    connectionId: row.connection_id,
    name: row.name,
    app: row.app,
    status: row.status,
    method: row.method,
    accountEmail: row.account_email,
    source: row.source,
    remoteCreatedAt: iso(row.remote_created_at),
    remoteUpdatedAt: iso(row.remote_updated_at),
    selected: row.is_selected,
    lastRefreshedAt: iso(row.last_refreshed_at),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  }
}

function credentialState(row: CredentialRow | undefined, connections: ConnectionRow[]): MatonCredentialState {
  const configured = Boolean(
    row?.api_key_ciphertext && row.api_key_iv && row.api_key_tag && row.api_key_last_four,
  )
  return {
    configured,
    loginEmail: row?.login_email || null,
    keyLastFour: configured ? row?.api_key_last_four || null : null,
    keyVersion: row?.api_key_version || 0,
    keyRotatedAt: iso(row?.key_rotated_at || null),
    keyRevokedAt: iso(row?.key_revoked_at || null),
    connections: connections.map(connectionState),
    createdAt: row ? iso(row.created_at) : null,
    updatedAt: row ? iso(row.updated_at) : null,
  }
}

async function readStateWithClient(client: PoolClient, ownerEmail: string): Promise<MatonCredentialState> {
  const credential = await client.query<CredentialRow>(
    'SELECT * FROM user_maton_credentials WHERE owner_email = $1',
    [ownerEmail],
  )
  const connections = await client.query<ConnectionRow>(
    `
      SELECT *
      FROM user_maton_connections
      WHERE owner_email = $1
      ORDER BY app ASC, is_selected DESC, name ASC, connection_id ASC
    `,
    [ownerEmail],
  )
  return credentialState(credential.rows[0], connections.rows)
}

async function audit(
  client: PoolClient,
  ownerEmail: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `
      INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
      VALUES ($1, $2, 'user_maton_credential', $1, $3::jsonb)
    `,
    [ownerEmail, eventType, JSON.stringify(payload)],
  )
}

function serializedConnections(connections: MatonConnectionWrite[]): string {
  return JSON.stringify(connections.map((connection) => ({
    connection_id: connection.connectionId,
    name: connection.name,
    app: connection.app,
    status: connection.status,
    method: connection.method,
    account_email: connection.accountEmail,
    remote_created_at: connection.remoteCreatedAt,
    remote_updated_at: connection.remoteUpdatedAt,
  })))
}

async function upsertConnections(
  client: PoolClient,
  ownerEmail: string,
  connections: MatonConnectionWrite[],
  source: 'maton' | 'manual',
): Promise<void> {
  if (connections.length === 0) return
  const remote = source === 'maton'
  await client.query(
    `
      INSERT INTO user_maton_connections (
        owner_email,
        connection_id,
        name,
        app,
        status,
        method,
        account_email,
        is_selected,
        source,
        remote_created_at,
        remote_updated_at,
        last_refreshed_at,
        created_at,
        updated_at
      )
      SELECT
        $1,
        item.connection_id,
        item.name,
        item.app,
        item.status,
        item.method,
        item.account_email,
        false,
        $3,
        NULLIF(item.remote_created_at, '')::timestamptz,
        NULLIF(item.remote_updated_at, '')::timestamptz,
        CASE WHEN $4::boolean THEN now() ELSE NULL END,
        now(),
        now()
      FROM jsonb_to_recordset($2::jsonb) AS item(
        connection_id text,
        name text,
        app text,
        status text,
        method text,
        account_email text,
        remote_created_at text,
        remote_updated_at text
      )
      ON CONFLICT (owner_email, connection_id) DO UPDATE SET
        name = CASE
          WHEN $4::boolean THEN user_maton_connections.name
          ELSE EXCLUDED.name
        END,
        app = EXCLUDED.app,
        is_selected = CASE
          WHEN user_maton_connections.app = EXCLUDED.app THEN user_maton_connections.is_selected
          ELSE false
        END,
        status = EXCLUDED.status,
        method = EXCLUDED.method,
        account_email = EXCLUDED.account_email,
        source = EXCLUDED.source,
        remote_created_at = EXCLUDED.remote_created_at,
        remote_updated_at = EXCLUDED.remote_updated_at,
        last_refreshed_at = CASE
          WHEN $4::boolean THEN now()
          ELSE user_maton_connections.last_refreshed_at
        END,
        updated_at = now()
      WHERE $4::boolean OR user_maton_connections.source = 'manual'
    `,
    [ownerEmail, serializedConnections(connections), source, remote],
  )
}

async function ensureSelectedConnections(
  client: PoolClient,
  ownerEmail: string,
  apps: string[],
): Promise<void> {
  if (apps.length === 0) return
  await client.query(
    `
      UPDATE user_maton_connections
      SET is_selected = false,
          updated_at = now()
      WHERE owner_email = $1
        AND app = ANY($2::text[])
        AND is_selected
        AND (source <> 'maton' OR status <> 'ACTIVE')
    `,
    [ownerEmail, apps],
  )
  await client.query(
    `
      WITH candidates AS (
        SELECT DISTINCT ON (candidate.app)
          candidate.owner_email,
          candidate.app,
          candidate.connection_id
        FROM user_maton_connections candidate
        WHERE candidate.owner_email = $1
          AND candidate.app = ANY($2::text[])
          AND candidate.source = 'maton'
          AND candidate.status = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1
            FROM user_maton_connections selected
            WHERE selected.owner_email = candidate.owner_email
              AND selected.app = candidate.app
              AND selected.is_selected
          )
        ORDER BY
          candidate.app,
          candidate.remote_created_at DESC NULLS LAST,
          candidate.connection_id ASC
      )
      UPDATE user_maton_connections target
      SET is_selected = true,
          updated_at = now()
      FROM candidates
      WHERE target.owner_email = candidates.owner_email
        AND target.connection_id = candidates.connection_id
    `,
    [ownerEmail, apps],
  )
}

async function syncRemoteConnections(
  client: PoolClient,
  ownerEmail: string,
  connections: MatonConnectionWrite[],
  replaceRemote: boolean,
): Promise<void> {
  await upsertConnections(client, ownerEmail, connections, 'maton')
  if (replaceRemote) {
    const ids = connections.map((connection) => connection.connectionId)
    await client.query(
      `
        DELETE FROM user_maton_connections
        WHERE owner_email = $1
          AND source = 'maton'
          AND NOT (connection_id = ANY($2::text[]))
      `,
      [ownerEmail, ids],
    )
  }
  await ensureSelectedConnections(
    client,
    ownerEmail,
    Array.from(new Set(connections.map((connection) => connection.app))),
  )
}

async function upsertCredential(
  client: PoolClient,
  input: {
    ownerEmail: string
    setLoginEmail: boolean
    loginEmail: string | null
    apiKey?: ApiKeyWrite
  },
): Promise<void> {
  const hasApiKey = Boolean(input.apiKey)
  await client.query(
    `
      INSERT INTO user_maton_credentials (
        owner_email,
        login_email,
        api_key_ciphertext,
        api_key_iv,
        api_key_tag,
        api_key_last_four,
        api_key_version,
        key_rotated_at,
        key_revoked_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        CASE WHEN $2::boolean THEN $3 ELSE NULL END,
        $5,
        $6,
        $7,
        $8,
        CASE WHEN $4::boolean THEN 1 ELSE 0 END,
        CASE WHEN $4::boolean THEN now() ELSE NULL END,
        NULL,
        now(),
        now()
      )
      ON CONFLICT (owner_email) DO UPDATE SET
        login_email = CASE
          WHEN $2::boolean THEN EXCLUDED.login_email
          ELSE user_maton_credentials.login_email
        END,
        api_key_ciphertext = CASE
          WHEN $4::boolean THEN EXCLUDED.api_key_ciphertext
          ELSE user_maton_credentials.api_key_ciphertext
        END,
        api_key_iv = CASE
          WHEN $4::boolean THEN EXCLUDED.api_key_iv
          ELSE user_maton_credentials.api_key_iv
        END,
        api_key_tag = CASE
          WHEN $4::boolean THEN EXCLUDED.api_key_tag
          ELSE user_maton_credentials.api_key_tag
        END,
        api_key_last_four = CASE
          WHEN $4::boolean THEN EXCLUDED.api_key_last_four
          ELSE user_maton_credentials.api_key_last_four
        END,
        api_key_version = CASE
          WHEN $4::boolean THEN user_maton_credentials.api_key_version + 1
          ELSE user_maton_credentials.api_key_version
        END,
        key_rotated_at = CASE
          WHEN $4::boolean THEN now()
          ELSE user_maton_credentials.key_rotated_at
        END,
        key_revoked_at = CASE
          WHEN $4::boolean THEN NULL
          ELSE user_maton_credentials.key_revoked_at
        END,
        updated_at = now()
    `,
    [
      input.ownerEmail,
      input.setLoginEmail,
      input.loginEmail,
      hasApiKey,
      input.apiKey?.ciphertext || null,
      input.apiKey?.iv || null,
      input.apiKey?.tag || null,
      input.apiKey?.lastFour || null,
    ],
  )
}

export async function readMatonCredentialStateFromPostgres(ownerEmail: string): Promise<MatonCredentialState> {
  const credential = await query<CredentialRow>(
    'SELECT * FROM user_maton_credentials WHERE owner_email = $1',
    [ownerEmail],
  )
  const connections = await query<ConnectionRow>(
    `
      SELECT *
      FROM user_maton_connections
      WHERE owner_email = $1
      ORDER BY app ASC, is_selected DESC, name ASC, connection_id ASC
    `,
    [ownerEmail],
  )
  return credentialState(credential.rows[0], connections.rows)
}

export async function readActiveMatonConnectionsFromPostgres(input: {
  ownerEmail: string
  app: string
}): Promise<ActiveMatonGatewayConnection[]> {
  const result = await query<ActiveMatonConnectionRow>(
    `
      SELECT connection_id, account_email, status
      FROM user_maton_connections
      WHERE owner_email = $1
        AND app = $2
        AND status = 'ACTIVE'
        AND source = 'maton'
      ORDER BY account_email ASC NULLS LAST, connection_id ASC
    `,
    [input.ownerEmail, input.app],
  )
  return result.rows.map((row) => ({
    connectionId: row.connection_id,
    accountEmail: row.account_email,
    status: 'ACTIVE',
  }))
}

export async function readMatonCredentialReadinessFromPostgres(
  ownerEmail: string,
): Promise<boolean> {
  const result = await query<MatonCredentialReadinessRow>(
    `
      SELECT (
        api_key_ciphertext IS NOT NULL
        AND octet_length(api_key_ciphertext) BETWEEN 16 AND 4096
        AND octet_length(api_key_iv) = 12
        AND octet_length(api_key_tag) = 16
        AND key_revoked_at IS NULL
      ) AS ready
      FROM user_maton_credentials
      WHERE owner_email = $1
    `,
    [ownerEmail],
  )
  return result.rows[0]?.ready === true
}

export async function readEncryptedMatonApiKeyFromPostgres(
  ownerEmail: string,
): Promise<MatonEncryptedCredentialRecord | null> {
  const result = await query<CredentialRow>(
    `
      SELECT *
      FROM user_maton_credentials
      WHERE owner_email = $1
    `,
    [ownerEmail],
  )
  const row = result.rows[0]
  if (!row?.api_key_ciphertext || !row.api_key_iv || !row.api_key_tag) return null
  return {
    ciphertext: row.api_key_ciphertext,
    iv: row.api_key_iv,
    tag: row.api_key_tag,
  }
}

export async function resolveMatonGatewayCredentialFromPostgres(input: {
  ownerEmail: string
  app: string
  boundConnectionId?: string
}): Promise<MatonGatewayCredentialLookup> {
  const result = await query<MatonGatewayCredentialRow>(
    `
      SELECT
        credential.api_key_ciphertext,
        credential.api_key_iv,
        credential.api_key_tag,
        active_connection.connection_id,
        active_connection.account_email
      FROM user_maton_credentials credential
      LEFT JOIN LATERAL (
        SELECT connection.connection_id, connection.account_email
        FROM user_maton_connections connection
        WHERE connection.owner_email = credential.owner_email
          AND connection.app = $2
          AND connection.status = 'ACTIVE'
          AND connection.source = 'maton'
          AND (
            ($3::text IS NOT NULL AND connection.connection_id = $3)
            OR ($3::text IS NULL AND connection.is_selected)
          )
        LIMIT 1
      ) active_connection ON true
      WHERE credential.owner_email = $1
    `,
    [input.ownerEmail, input.app, input.boundConnectionId || null],
  )
  const row = result.rows[0]
  if (!row?.api_key_ciphertext || !row.api_key_iv || !row.api_key_tag) return { status: 'missing-key' }
  if (!row.connection_id) return { status: 'missing-connection' }
  return {
    status: 'resolved',
    credential: {
      ciphertext: row.api_key_ciphertext,
      iv: row.api_key_iv,
      tag: row.api_key_tag,
    },
    connectionId: row.connection_id,
    accountEmail: row.account_email,
  }
}

export async function updateMatonCredentialInPostgres(input: {
  ownerEmail: string
  setLoginEmail: boolean
  loginEmail: string | null
  apiKey?: ApiKeyWrite
  refreshedConnections: MatonConnectionWrite[]
  connectionUpserts: MatonConnectionWrite[]
  connectionRemovals: string[]
}): Promise<MatonCredentialState> {
  return withTransaction(async (client) => {
    const current = await client.query<CredentialRow>(
      'SELECT * FROM user_maton_credentials WHERE owner_email = $1 FOR UPDATE',
      [input.ownerEmail],
    )
    await upsertCredential(client, input)
    if (input.apiKey) {
      await client.query('DELETE FROM user_maton_connections WHERE owner_email = $1', [input.ownerEmail])
      await syncRemoteConnections(client, input.ownerEmail, input.refreshedConnections, false)
    }
    await upsertConnections(client, input.ownerEmail, input.connectionUpserts, 'manual')
    let removedConnections = 0
    const affectedApps: string[] = []
    if (input.connectionRemovals.length > 0) {
      const removed = await client.query<{ app: string }>(
        `
          DELETE FROM user_maton_connections
          WHERE owner_email = $1
            AND connection_id = ANY($2::text[])
          RETURNING app
        `,
        [input.ownerEmail, input.connectionRemovals],
      )
      removedConnections = removed.rowCount || 0
      affectedApps.push(...removed.rows.map((row) => row.app))
    }
    await ensureSelectedConnections(client, input.ownerEmail, Array.from(new Set(affectedApps)))
    await audit(client, input.ownerEmail, 'maton.credential.updated', {
      loginEmailChanged: input.setLoginEmail,
      keyAction: input.apiKey
        ? current.rows[0]?.api_key_ciphertext ? 'rotated' : 'set'
        : null,
      refreshedConnections: input.apiKey ? input.refreshedConnections.length : 0,
      upsertedConnections: input.connectionUpserts.length,
      removedConnections,
    })
    return readStateWithClient(client, input.ownerEmail)
  })
}

export async function syncMatonConnectionsInPostgres(input: {
  ownerEmail: string
  connections: MatonConnectionWrite[]
  eventType: 'maton.connections.refreshed' | 'maton.connection.created'
  replaceRemote: boolean
}): Promise<MatonCredentialState> {
  return withTransaction(async (client) => {
    const credential = await client.query(
      'SELECT 1 FROM user_maton_credentials WHERE owner_email = $1 AND api_key_ciphertext IS NOT NULL FOR UPDATE',
      [input.ownerEmail],
    )
    if (!credential.rows[0]) throw new Error('A stored Maton API key is required')
    await syncRemoteConnections(client, input.ownerEmail, input.connections, input.replaceRemote)
    await audit(client, input.ownerEmail, input.eventType, {
      connectionCount: input.connections.length,
      apps: Array.from(new Set(input.connections.map((connection) => connection.app))).sort(),
    })
    return readStateWithClient(client, input.ownerEmail)
  })
}

export async function importPlatformMatonCredentialInPostgres(input: {
  ownerEmail: string
  apiKey: ApiKeyWrite
  connections: MatonConnectionWrite[]
  selectedConnectionIds?: string[]
}): Promise<MatonCredentialState> {
  return withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO user_maton_credentials (owner_email, created_at, updated_at)
        VALUES ($1, now(), now())
        ON CONFLICT (owner_email) DO NOTHING
      `,
      [input.ownerEmail],
    )
    const current = await client.query<CredentialRow>(
      'SELECT * FROM user_maton_credentials WHERE owner_email = $1 FOR UPDATE',
      [input.ownerEmail],
    )
    if (current.rows[0]?.api_key_ciphertext) throw new Error('A per-user Maton credential is already configured')
    await upsertCredential(client, {
      ownerEmail: input.ownerEmail,
      setLoginEmail: false,
      loginEmail: null,
      apiKey: input.apiKey,
    })
    await client.query('DELETE FROM user_maton_connections WHERE owner_email = $1', [input.ownerEmail])
    await syncRemoteConnections(client, input.ownerEmail, input.connections, true)
    const selectedConnectionIds = Array.from(new Set(input.selectedConnectionIds || []))
    if (selectedConnectionIds.length > 0) {
      const selectedConnections = await client.query<{ connection_id: string; app: string }>(
        `
          SELECT connection_id, app
          FROM user_maton_connections
          WHERE owner_email = $1
            AND connection_id = ANY($2::text[])
            AND source = 'maton'
            AND status = 'ACTIVE'
          FOR UPDATE
        `,
        [input.ownerEmail, selectedConnectionIds],
      )
      const selectedApps = selectedConnections.rows.map((connection) => connection.app)
      if (
        selectedConnections.rows.length !== selectedConnectionIds.length
        || new Set(selectedApps).size !== selectedApps.length
      ) {
        throw new Error('Preferred Maton connection selection is invalid')
      }
      await client.query(
        `
          UPDATE user_maton_connections
          SET is_selected = false,
              updated_at = now()
          WHERE owner_email = $1
            AND app = ANY($2::text[])
            AND is_selected
        `,
        [input.ownerEmail, selectedApps],
      )
      await client.query(
        `
          UPDATE user_maton_connections
          SET is_selected = true,
              updated_at = now()
          WHERE owner_email = $1
            AND connection_id = ANY($2::text[])
            AND source = 'maton'
            AND status = 'ACTIVE'
        `,
        [input.ownerEmail, selectedConnectionIds],
      )
    }
    await audit(client, input.ownerEmail, 'maton.credential.platform_imported', {
      connectionCount: input.connections.length,
      apps: Array.from(new Set(input.connections.map((connection) => connection.app))).sort(),
    })
    return readStateWithClient(client, input.ownerEmail)
  })
}

export async function selectMatonConnectionInPostgres(input: {
  ownerEmail: string
  connectionId: string
}): Promise<MatonCredentialState> {
  return withTransaction(async (client) => {
    const target = await client.query<{ app: string }>(
      `
        SELECT app
        FROM user_maton_connections
        WHERE owner_email = $1
          AND connection_id = $2
          AND source = 'maton'
          AND status = 'ACTIVE'
        FOR UPDATE
      `,
      [input.ownerEmail, input.connectionId],
    )
    const app = target.rows[0]?.app
    if (!app) throw new Error('Maton connection was not found')
    await client.query(
      `
        UPDATE user_maton_connections
        SET is_selected = false,
            updated_at = now()
        WHERE owner_email = $1
          AND app = $2
          AND is_selected
      `,
      [input.ownerEmail, app],
    )
    await client.query(
      `
        UPDATE user_maton_connections
        SET is_selected = true,
            updated_at = now()
        WHERE owner_email = $1
          AND connection_id = $2
          AND app = $3
          AND source = 'maton'
      `,
      [input.ownerEmail, input.connectionId, app],
    )
    await audit(client, input.ownerEmail, 'maton.connection.selected', { app })
    return readStateWithClient(client, input.ownerEmail)
  })
}

export async function revokeMatonCredentialInPostgres(ownerEmail: string): Promise<MatonCredentialState> {
  return withTransaction(async (client) => {
    const revoked = await client.query(
      `
        UPDATE user_maton_credentials
        SET api_key_ciphertext = NULL,
            api_key_iv = NULL,
            api_key_tag = NULL,
            api_key_last_four = NULL,
            key_rotated_at = NULL,
            key_revoked_at = CASE WHEN api_key_ciphertext IS NOT NULL THEN now() ELSE key_revoked_at END,
            updated_at = now()
        WHERE owner_email = $1
        RETURNING owner_email
      `,
      [ownerEmail],
    )
    await client.query(
      'DELETE FROM user_maton_connections WHERE owner_email = $1',
      [ownerEmail],
    )
    if (revoked.rows[0]) await audit(client, ownerEmail, 'maton.credential.revoked', {})
    return readStateWithClient(client, ownerEmail)
  })
}
