import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { isHostedRuntime } from '@/lib/persistence/config'
import { query, withTransaction } from '@/lib/persistence/agentCredentials'

const PROVIDER = 'openai-codex'
const AUTH_BASE_URL = 'https://auth.openai.com'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEVICE_CALLBACK_URL = `${AUTH_BASE_URL}/deviceauth/callback`
const VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`
const LOGIN_TTL_MS = 15 * 60_000
const REFRESH_WINDOW_MS = 5 * 60_000
const MAX_AUTH_BODY_BYTES = 1024 * 1024

type CipherFields = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

type PendingLoginRow = {
  operator_id: string
  login_id: string
  verification_url: string
  device_auth_id_ciphertext: Buffer
  device_auth_id_iv: Buffer
  device_auth_id_tag: Buffer
  user_code_ciphertext: Buffer
  user_code_iv: Buffer
  user_code_tag: Buffer
  poll_interval_seconds: number
  last_polled_at: string | null
  expires_at: string
}

type CredentialRow = {
  operator_id: string
  access_token_ciphertext: Buffer
  access_token_iv: Buffer
  access_token_tag: Buffer
  refresh_token_ciphertext: Buffer
  refresh_token_iv: Buffer
  refresh_token_tag: Buffer
  account_id: string | null
  account_email: string | null
  plan_type: string | null
  expires_at: string
  connected_at: string
  last_refreshed_at: string
}

type TokenPayload = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
}

export type ChatGPTConnection = {
  connected: boolean
  email?: string
  planType?: string
  expiresAt?: string
  connectedAt?: string
}

export type ChatGPTCredential = {
  accessToken: string
  refreshToken: string
  accountId: string
  accountEmail?: string
  planType?: string
  expiresAt: string
}

export type ChatGPTDeviceLogin = {
  loginId: string
  verificationUrl: string
  userCode: string
  expiresAt: string
}

export type ChatGPTLoginPollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'completed'; connected: true; auth: ChatGPTConnection }

function normalizeOperatorId(value: unknown): string {
  const operatorId = String(value || '').trim().toLowerCase()
  if (!operatorId || operatorId.length > 512) throw new Error('A valid signed-in user is required')
  return operatorId
}

function encryptionKey(): Buffer {
  const dedicated = String(process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY || '')
  if (isHostedRuntime() && dedicated.length < 32) {
    throw new Error('Agent credential encryption is not configured')
  }
  const secret = dedicated || String(process.env.APP_SESSION_SECRET || '')
  if (secret.length < 32) throw new Error('Agent credential encryption is not configured')
  return crypto.createHash('sha256').update(secret).digest()
}

function cipherAad(operatorId: string, purpose: string): Buffer {
  return Buffer.from(`clawpilot:${PROVIDER}:${operatorId}:${purpose}:v1`, 'utf8')
}

function encryptSecret(value: string, operatorId: string, purpose: string): CipherFields {
  if (!value) throw new Error('Credential material was missing')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(cipherAad(operatorId, purpose))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

function decryptSecret(fields: CipherFields, operatorId: string, purpose: string): string {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), fields.iv)
    decipher.setAAD(cipherAad(operatorId, purpose))
    decipher.setAuthTag(fields.tag)
    return Buffer.concat([decipher.update(fields.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Stored ChatGPT authorization could not be decrypted')
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parsePositiveNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_AUTH_BODY_BYTES) throw new Error('ChatGPT authorization response was too large')
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_AUTH_BODY_BYTES) throw new Error('ChatGPT authorization response was too large')
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

async function authFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('ChatGPT authorization timed out')
    throw new Error('Unable to reach ChatGPT authorization')
  } finally {
    clearTimeout(timer)
  }
}

function authHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    originator: 'clawpilot',
    'User-Agent': 'clawpilot',
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) return {}
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function tokenIdentity(accessToken: string): {
  accountId?: string
  email?: string
  planType?: string
  expiresAt?: string
} {
  const payload = decodeJwtPayload(accessToken)
  const auth = payload['https://api.openai.com/auth']
  const profile = payload['https://api.openai.com/profile']
  const authRecord = auth && typeof auth === 'object' ? auth as Record<string, unknown> : {}
  const profileRecord = profile && typeof profile === 'object' ? profile as Record<string, unknown> : {}
  const exp = parsePositiveNumber(payload.exp)
  return {
    accountId: asText(authRecord.chatgpt_account_id) || undefined,
    email: asText(profileRecord.email) || undefined,
    planType: asText(authRecord.chatgpt_plan_type) || undefined,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : undefined,
  }
}

function expiryFromToken(payload: TokenPayload, accessToken: string): string {
  const seconds = parsePositiveNumber(payload.expires_in)
  if (seconds) return new Date(Date.now() + seconds * 1000).toISOString()
  return tokenIdentity(accessToken).expiresAt || new Date(Date.now() + 60 * 60_000).toISOString()
}

function rowCredential(row: CredentialRow): ChatGPTCredential {
  const operatorId = normalizeOperatorId(row.operator_id)
  const accessToken = decryptSecret({
    ciphertext: row.access_token_ciphertext,
    iv: row.access_token_iv,
    tag: row.access_token_tag,
  }, operatorId, 'access-token')
  const refreshToken = decryptSecret({
    ciphertext: row.refresh_token_ciphertext,
    iv: row.refresh_token_iv,
    tag: row.refresh_token_tag,
  }, operatorId, 'refresh-token')
  if (!row.account_id) throw new Error('Stored ChatGPT authorization is missing an account')
  return {
    accessToken,
    refreshToken,
    accountId: row.account_id,
    accountEmail: row.account_email || undefined,
    planType: row.plan_type || undefined,
    expiresAt: new Date(row.expires_at).toISOString(),
  }
}

function connectionFromRow(row?: CredentialRow): ChatGPTConnection {
  if (!row) return { connected: false }
  return {
    connected: true,
    email: row.account_email || undefined,
    planType: row.plan_type || undefined,
    expiresAt: new Date(row.expires_at).toISOString(),
    connectedAt: new Date(row.connected_at).toISOString(),
  }
}

async function selectCredential(client: PoolClient, operatorId: string, lock = false): Promise<CredentialRow | undefined> {
  const result = await client.query<CredentialRow>(
    `SELECT * FROM agent_chatgpt_credentials WHERE operator_id = $1 AND provider = $2${lock ? ' FOR UPDATE' : ''}`,
    [operatorId, PROVIDER],
  )
  return result.rows[0]
}

async function persistCredential(client: PoolClient, operatorId: string, input: {
  accessToken: string
  refreshToken: string
  accountId: string
  accountEmail?: string
  planType?: string
  expiresAt: string
}): Promise<void> {
  const access = encryptSecret(input.accessToken, operatorId, 'access-token')
  const refresh = encryptSecret(input.refreshToken, operatorId, 'refresh-token')
  await client.query(
    `
      INSERT INTO agent_chatgpt_credentials (
        operator_id, provider,
        access_token_ciphertext, access_token_iv, access_token_tag,
        refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
        account_id, account_email, plan_type, expires_at,
        connected_at, last_refreshed_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, now(), now(), now(), now())
      ON CONFLICT (operator_id, provider) DO UPDATE SET
        access_token_ciphertext = EXCLUDED.access_token_ciphertext,
        access_token_iv = EXCLUDED.access_token_iv,
        access_token_tag = EXCLUDED.access_token_tag,
        refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
        refresh_token_iv = EXCLUDED.refresh_token_iv,
        refresh_token_tag = EXCLUDED.refresh_token_tag,
        account_id = EXCLUDED.account_id,
        account_email = EXCLUDED.account_email,
        plan_type = EXCLUDED.plan_type,
        expires_at = EXCLUDED.expires_at,
        last_refreshed_at = now(),
        updated_at = now()
    `,
    [
      operatorId, PROVIDER,
      access.ciphertext, access.iv, access.tag,
      refresh.ciphertext, refresh.iv, refresh.tag,
      input.accountId, input.accountEmail || null, input.planType || null, input.expiresAt,
    ],
  )
}

export async function getChatGPTConnection(operatorValue: unknown): Promise<ChatGPTConnection> {
  const operatorId = normalizeOperatorId(operatorValue)
  const result = await query<CredentialRow>(
    'SELECT * FROM agent_chatgpt_credentials WHERE operator_id = $1 AND provider = $2',
    [operatorId, PROVIDER],
  )
  return connectionFromRow(result.rows[0])
}

export async function startChatGPTDeviceLogin(operatorValue: unknown): Promise<ChatGPTDeviceLogin> {
  const operatorId = normalizeOperatorId(operatorValue)
  encryptionKey()
  const response = await authFetch(`${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: authHeaders('application/json'),
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  const payload = await readJson(response)
  if (!response.ok) throw new Error('Unable to start ChatGPT device authorization')
  const deviceAuthId = asText(payload.device_auth_id)
  const userCode = asText(payload.user_code) || asText(payload.usercode)
  if (!deviceAuthId || !userCode) throw new Error('ChatGPT device authorization returned an incomplete response')

  const intervalSeconds = Math.max(1, Math.min(60, Math.trunc(parsePositiveNumber(payload.interval) || 5)))
  const loginId = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + LOGIN_TTL_MS).toISOString()
  const device = encryptSecret(deviceAuthId, operatorId, 'device-auth-id')
  const code = encryptSecret(userCode, operatorId, 'device-user-code')

  await withTransaction(async (client) => {
    await client.query('DELETE FROM agent_chatgpt_pending_logins WHERE operator_id = $1 AND provider = $2', [operatorId, PROVIDER])
    await client.query(
      `
        INSERT INTO agent_chatgpt_pending_logins (
          operator_id, provider, login_id, verification_url,
          device_auth_id_ciphertext, device_auth_id_iv, device_auth_id_tag,
          user_code_ciphertext, user_code_iv, user_code_tag,
          poll_interval_seconds, expires_at, created_at, updated_at
        )
        VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, now(), now())
      `,
      [
        operatorId, PROVIDER, loginId, VERIFICATION_URL,
        device.ciphertext, device.iv, device.tag,
        code.ciphertext, code.iv, code.tag,
        intervalSeconds, expiresAt,
      ],
    )
  })

  return { loginId, verificationUrl: VERIFICATION_URL, userCode, expiresAt }
}

async function pendingLoginForPoll(operatorId: string, loginId: string): Promise<PendingLoginRow | null> {
  return withTransaction(async (client) => {
    const result = await client.query<PendingLoginRow>(
      `
        SELECT *
        FROM agent_chatgpt_pending_logins
        WHERE operator_id = $1 AND provider = $2 AND login_id = $3::uuid
        FOR UPDATE
      `,
      [operatorId, PROVIDER, loginId],
    )
    const row = result.rows[0]
    if (!row) return null
    if (Date.parse(row.expires_at) <= Date.now()) {
      await client.query('DELETE FROM agent_chatgpt_pending_logins WHERE login_id = $1::uuid', [loginId])
      return { ...row, expires_at: new Date(0).toISOString() }
    }
    const lastPoll = Date.parse(String(row.last_polled_at || ''))
    if (Number.isFinite(lastPoll) && Date.now() - lastPoll < row.poll_interval_seconds * 1000 - 250) return null
    await client.query('UPDATE agent_chatgpt_pending_logins SET last_polled_at = now(), updated_at = now() WHERE login_id = $1::uuid', [loginId])
    return row
  })
}

async function exchangeAuthorizationCode(code: string, verifier: string): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: string
}> {
  const response = await authFetch(`${AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: authHeaders('application/x-www-form-urlencoded'),
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: DEVICE_CALLBACK_URL,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  })
  const payload = await readJson(response) as TokenPayload
  if (!response.ok) throw new Error('ChatGPT authorization could not be completed')
  const accessToken = asText(payload.access_token)
  const refreshToken = asText(payload.refresh_token)
  if (!accessToken || !refreshToken) throw new Error('ChatGPT authorization returned incomplete credentials')
  return { accessToken, refreshToken, expiresAt: expiryFromToken(payload, accessToken) }
}

export async function pollChatGPTDeviceLogin(operatorValue: unknown, loginValue: unknown): Promise<ChatGPTLoginPollResult> {
  const operatorId = normalizeOperatorId(operatorValue)
  const loginId = String(loginValue || '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(loginId)) {
    throw new Error('Invalid ChatGPT login request')
  }

  const pending = await pendingLoginForPoll(operatorId, loginId)
  if (!pending) {
    const connection = await getChatGPTConnection(operatorId)
    return connection.connected
      ? { status: 'completed', connected: true, auth: connection }
      : { status: 'pending' }
  }
  if (Date.parse(pending.expires_at) <= Date.now()) return { status: 'expired' }

  const deviceAuthId = decryptSecret({
    ciphertext: pending.device_auth_id_ciphertext,
    iv: pending.device_auth_id_iv,
    tag: pending.device_auth_id_tag,
  }, operatorId, 'device-auth-id')
  const userCode = decryptSecret({
    ciphertext: pending.user_code_ciphertext,
    iv: pending.user_code_iv,
    tag: pending.user_code_tag,
  }, operatorId, 'device-user-code')

  const response = await authFetch(`${AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: authHeaders('application/json'),
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  })
  if (response.status === 403 || response.status === 404) return { status: 'pending' }
  const payload = await readJson(response)
  if (!response.ok) throw new Error('ChatGPT device authorization failed')
  const authorizationCode = asText(payload.authorization_code)
  const codeVerifier = asText(payload.code_verifier)
  if (!authorizationCode || !codeVerifier) throw new Error('ChatGPT device authorization returned an incomplete exchange')

  const tokens = await exchangeAuthorizationCode(authorizationCode, codeVerifier)
  const identity = tokenIdentity(tokens.accessToken)
  if (!identity.accountId) throw new Error('ChatGPT authorization did not include an account')

  await withTransaction(async (client) => {
    const stillPending = await client.query(
      'SELECT login_id FROM agent_chatgpt_pending_logins WHERE operator_id = $1 AND provider = $2 AND login_id = $3::uuid FOR UPDATE',
      [operatorId, PROVIDER, loginId],
    )
    if (stillPending.rowCount !== 1) return
    await persistCredential(client, operatorId, {
      ...tokens,
      accountId: identity.accountId!,
      accountEmail: identity.email,
      planType: identity.planType,
    })
    await client.query('DELETE FROM agent_chatgpt_pending_logins WHERE login_id = $1::uuid', [loginId])
  })

  return { status: 'completed', connected: true, auth: await getChatGPTConnection(operatorId) }
}

export async function getValidChatGPTCredential(
  operatorValue: unknown,
  options: { forceRefresh?: boolean } = {},
): Promise<ChatGPTCredential> {
  const operatorId = normalizeOperatorId(operatorValue)
  return withTransaction(async (client) => {
    const row = await selectCredential(client, operatorId, true)
    if (!row) throw new Error('Connect ChatGPT before sending an agent message')
    const current = rowCredential(row)
    if (!options.forceRefresh && Date.parse(current.expiresAt) > Date.now() + REFRESH_WINDOW_MS) return current

    const response = await authFetch(`${AUTH_BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: authHeaders('application/x-www-form-urlencoded'),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: CLIENT_ID,
      }),
    })
    const payload = await readJson(response) as TokenPayload
    if (!response.ok) throw new Error('ChatGPT authorization expired. Reconnect ChatGPT to continue.')
    const accessToken = asText(payload.access_token)
    const refreshToken = asText(payload.refresh_token) || current.refreshToken
    if (!accessToken) throw new Error('ChatGPT authorization refresh returned incomplete credentials')
    const identity = tokenIdentity(accessToken)
    const next = {
      accessToken,
      refreshToken,
      accountId: identity.accountId || current.accountId,
      accountEmail: identity.email || current.accountEmail,
      planType: identity.planType || current.planType,
      expiresAt: expiryFromToken(payload, accessToken),
    }
    await persistCredential(client, operatorId, next)
    return next
  })
}

export async function disconnectChatGPT(operatorValue: unknown): Promise<void> {
  const operatorId = normalizeOperatorId(operatorValue)
  const result = await query<CredentialRow>(
    'SELECT * FROM agent_chatgpt_credentials WHERE operator_id = $1 AND provider = $2',
    [operatorId, PROVIDER],
  )
  const row = result.rows[0]
  if (row) {
    try {
      const credential = rowCredential(row)
      await authFetch(`${AUTH_BASE_URL}/oauth/revoke`, {
        method: 'POST',
        headers: authHeaders('application/json'),
        body: JSON.stringify({
          token: credential.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: CLIENT_ID,
        }),
      })
    } catch {
      // Local deletion remains authoritative even when upstream revocation is unavailable.
    }
  }
  await withTransaction(async (client) => {
    await client.query('DELETE FROM agent_chatgpt_pending_logins WHERE operator_id = $1 AND provider = $2', [operatorId, PROVIDER])
    await client.query('DELETE FROM agent_chatgpt_credentials WHERE operator_id = $1 AND provider = $2', [operatorId, PROVIDER])
  })
}
