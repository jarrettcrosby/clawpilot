import crypto from 'crypto'
import type { NextRequest, NextResponse } from 'next/server'
import { getCookieName, getCookieNames, verifySessionToken } from '@/lib/auth'
import { recordAuditEvent } from '@/lib/auditWriter'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { observedRequestIpAddress } from '@/lib/requestIpAddress'

const ABSOLUTE_TTL_SECONDS = 24 * 60 * 60
const ADMIN_IDLE_TTL_SECONDS = 60 * 60
const MEMBER_IDLE_TTL_SECONDS = 8 * 60 * 60
const IMPERSONATION_TTL_SECONDS = 30 * 60
const RECENT_AUTH_SECONDS = 15 * 60

type SessionRole = 'owner' | 'admin' | 'member'
type SessionAuthMethod = 'magic_code' | 'google_sso' | 'operator_password' | 'legacy_upgrade' | 'demo'

type SessionRow = {
  id: string
  authenticated_user_email: string
  effective_user_email: string
  authenticated_role: SessionRole
  effective_role: SessionRole
  authenticated_status: string
  effective_status: string
  active_workspace_organization_id: string
  active_workspace_name: string
  active_workspace_reference_code: string
  active_workspace_role: SessionRole
  active_workspace_permissions: unknown
  active_membership_status: string
  active_workspace_switched_at: string
  auth_method: SessionAuthMethod
  device_label: string
  user_agent: string | null
  initial_ip_address: string | null
  last_ip_address: string | null
  created_at: string
  last_seen_at: string
  last_user_activity_at: string
  last_authenticated_at: string
  idle_timeout_seconds: number
  idle_expires_at: string
  absolute_expires_at: string
  revoked_at: string | null
  revoked_reason: string | null
  impersonation_started_at: string | null
  impersonation_expires_at: string | null
}

export type BrowserSession = {
  id: string
  authenticatedUser: string
  effectiveUser: string
  authenticatedRole: SessionRole
  effectiveRole: SessionRole
  activeWorkspaceOrganizationId: string | null
  activeWorkspaceName: string | null
  activeWorkspaceReferenceCode: string | null
  activeWorkspaceRole: SessionRole | null
  activeWorkspacePermissions: Record<string, boolean> | null
  activeWorkspaceSwitchedAt: string | null
  authMethod: SessionAuthMethod
  deviceLabel: string
  userAgent: string | null
  initialIpAddress: string | null
  lastIpAddress: string | null
  createdAt: string
  lastSeenAt: string
  lastUserActivityAt: string
  lastAuthenticatedAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  impersonationStartedAt: string | null
  impersonationExpiresAt: string | null
  impersonating: boolean
  legacy?: boolean
}

export type IssuedBrowserSession = {
  token: string
  session: BrowserSession
}

function sessionSecret(): string {
  const value = String(process.env.APP_SESSION_SECRET || process.env.NEXTAUTH_SECRET || '')
  if (value.length < 32) throw new Error('APP_SESSION_SECRET must contain at least 32 characters')
  return value
}

function hashToken(token: string): string {
  return crypto
    .createHmac('sha256', sessionSecret())
    .update(`clawpilot-browser-session:v1\n${token}`)
    .digest('hex')
}

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function networkFingerprint(headers: Headers): string {
  return crypto
    .createHmac('sha256', sessionSecret())
    .update(`clawpilot-network:v1\n${observedRequestIpAddress(headers) || 'unknown'}`)
    .digest('hex')
    .slice(0, 24)
}

function deviceLabel(headers: Headers): string {
  const userAgent = String(headers.get('user-agent') || '')
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /CriOS\//.test(userAgent) ? 'Chrome iOS'
      : /Chrome\//.test(userAgent) ? 'Chrome'
        : /FxiOS\//.test(userAgent) ? 'Firefox iOS'
          : /Firefox\//.test(userAgent) ? 'Firefox'
            : /Safari\//.test(userAgent) ? 'Safari'
              : 'Browser'
  const platform = /iPhone/.test(userAgent) ? 'iPhone'
    : /iPad/.test(userAgent) ? 'iPad'
      : /Android/.test(userAgent) ? 'Android'
        : /Mac OS X/.test(userAgent) ? 'Mac'
          : /Windows/.test(userAgent) ? 'Windows'
            : /Linux/.test(userAgent) ? 'Linux'
              : 'device'
  return `${browser} on ${platform}`
}

function fromRow(row: SessionRow): BrowserSession {
  return {
    id: row.id,
    authenticatedUser: row.authenticated_user_email,
    effectiveUser: row.effective_user_email,
    authenticatedRole: row.authenticated_role,
    effectiveRole: row.effective_role,
    activeWorkspaceOrganizationId: row.active_workspace_organization_id,
    activeWorkspaceName: row.active_workspace_name,
    activeWorkspaceReferenceCode: row.active_workspace_reference_code,
    activeWorkspaceRole: row.active_workspace_role,
    activeWorkspacePermissions: row.active_workspace_permissions && typeof row.active_workspace_permissions === 'object'
      ? row.active_workspace_permissions as Record<string, boolean>
      : null,
    activeWorkspaceSwitchedAt: row.active_workspace_switched_at,
    authMethod: row.auth_method,
    deviceLabel: row.device_label,
    userAgent: row.user_agent,
    initialIpAddress: row.initial_ip_address,
    lastIpAddress: row.last_ip_address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastUserActivityAt: row.last_user_activity_at,
    lastAuthenticatedAt: row.last_authenticated_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    impersonationStartedAt: row.impersonation_started_at,
    impersonationExpiresAt: row.impersonation_expires_at,
    impersonating: row.authenticated_user_email !== row.effective_user_email,
  }
}

const SESSION_SELECT = `SELECT session.id::text, session.authenticated_user_email,
  session.effective_user_email, authenticated.role AS authenticated_role,
  effective.role AS effective_role, authenticated.status AS authenticated_status,
  effective.status AS effective_status,
  session.active_workspace_organization_id::text,
  active_workspace.name AS active_workspace_name,
  active_workspace.reference_code AS active_workspace_reference_code,
  active_membership.role AS active_workspace_role,
  active_membership.permissions AS active_workspace_permissions,
  active_membership.status AS active_membership_status,
  session.active_workspace_switched_at::text,
  session.auth_method, session.device_label,
  session.user_agent, host(session.initial_ip_address) AS initial_ip_address,
  host(session.last_ip_address) AS last_ip_address,
  session.created_at::text, session.last_seen_at::text,
  session.last_user_activity_at::text, session.last_authenticated_at::text,
  session.idle_timeout_seconds, session.idle_expires_at::text,
  session.absolute_expires_at::text, session.revoked_at::text,
  session.revoked_reason, session.impersonation_started_at::text,
  session.impersonation_expires_at::text
  FROM app_sessions session
  JOIN app_users authenticated ON authenticated.email = session.authenticated_user_email
  JOIN app_users effective ON effective.email = session.effective_user_email
  JOIN app_user_organization_memberships active_membership
    ON active_membership.user_email = session.effective_user_email
   AND active_membership.organization_id = session.active_workspace_organization_id
  JOIN workspace_organizations active_workspace
    ON active_workspace.id = session.active_workspace_organization_id`

function idleTtl(role: SessionRole): number {
  return role === 'owner' || role === 'admin' ? ADMIN_IDLE_TTL_SECONDS : MEMBER_IDLE_TTL_SECONDS
}

export async function createBrowserSession(input: {
  email: string
  authMethod: SessionAuthMethod
  headers: Headers
  organizationId?: string | null
}): Promise<IssuedBrowserSession> {
  const email = String(input.email || '').trim().toLowerCase()
  const requestedOrganizationId = String(input.organizationId || '').trim() || null
  if (requestedOrganizationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedOrganizationId)) {
    throw new Error('Active workspace is invalid')
  }
  const user = await query<{
    role: SessionRole
    status: string
    organization_id: string
    membership_role: SessionRole
  }>(
    `SELECT app_user.role, app_user.status, membership.organization_id::text, membership.role AS membership_role
     FROM app_users app_user
     JOIN LATERAL (
       SELECT organization_id, role
       FROM app_user_organization_memberships
       WHERE user_email = app_user.email
         AND status = 'active'
         AND ($2::uuid IS NULL OR organization_id = $2::uuid)
       ORDER BY is_default DESC, created_at
       LIMIT 1
     ) membership ON true
     WHERE app_user.email = $1`,
    [email, requestedOrganizationId],
  )
  if (!user.rows[0] || user.rows[0].status !== 'active') throw new Error('User access is not active')
  const token = newToken()
  const idleSeconds = idleTtl(user.rows[0].membership_role)
  const fingerprint = networkFingerprint(input.headers)
  const ipAddress = observedRequestIpAddress(input.headers)
  const result = await query<SessionRow>(
    `WITH inserted AS (
       INSERT INTO app_sessions (
         token_hash, authenticated_user_email, effective_user_email, auth_method,
         device_label, user_agent, initial_network_fingerprint, last_network_fingerprint,
         initial_ip_address, last_ip_address, idle_timeout_seconds,
         idle_expires_at, absolute_expires_at, active_workspace_organization_id
       ) VALUES (
         $1, $2, $2, $3, $4, $5, $6, $6, $7::inet, $7::inet, $8,
         now() + ($8::integer * interval '1 second'),
         now() + ($9::integer * interval '1 second'), $10::uuid
       ) RETURNING *
     )
     ${SESSION_SELECT.replace('FROM app_sessions session', 'FROM inserted session')}`,
    [
      hashToken(token),
      email,
      input.authMethod,
      deviceLabel(input.headers),
      String(input.headers.get('user-agent') || '').slice(0, 512) || null,
      fingerprint,
      ipAddress,
      idleSeconds,
      ABSOLUTE_TTL_SECONDS,
      user.rows[0].organization_id,
    ],
  )
  const session = fromRow(result.rows[0])
  await recordAuditEvent({
    actor: email,
    subject: email,
    eventType: 'auth.session.created',
    aggregateType: 'app_session',
    aggregateId: session.id,
    organizationId: session.activeWorkspaceOrganizationId,
    payload: {
      sessionId: session.id,
      deviceLabel: session.deviceLabel,
      authMethod: session.authMethod,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      organizationId: session.activeWorkspaceOrganizationId,
      organizationName: session.activeWorkspaceName,
    },
  }).catch(() => undefined)
  return { token, session }
}

async function expireSession(row: SessionRow, reason: string): Promise<null> {
  const updated = await query<{ id: string }>(
    `UPDATE app_sessions SET revoked_at = now(), revoked_reason = $2
     WHERE id = $1::uuid AND revoked_at IS NULL RETURNING id::text`,
    [row.id, reason],
  )
  if (updated.rowCount) {
    await recordAuditEvent({
      actor: row.authenticated_user_email,
      subject: row.effective_user_email,
      eventType: 'auth.session.expired',
      aggregateType: 'app_session',
      aggregateId: row.id,
      organizationId: row.active_workspace_organization_id,
      payload: {
        sessionId: row.id,
        organizationId: row.active_workspace_organization_id,
        deviceLabel: row.device_label,
        revokeReason: reason,
      },
    }).catch(() => undefined)
  }
  return null
}

async function endExpiredImpersonation(row: SessionRow): Promise<SessionRow> {
  if (!row.impersonation_expires_at || Date.parse(row.impersonation_expires_at) > Date.now()) return row
  const target = row.effective_user_email
  await query(
    `UPDATE app_sessions SET effective_user_email = authenticated_user_email,
       active_workspace_organization_id = (
         SELECT organization_id
         FROM app_user_organization_memberships
         WHERE user_email = app_sessions.authenticated_user_email AND status = 'active'
         ORDER BY is_default DESC, created_at
         LIMIT 1
       ),
       active_workspace_switched_at = now(),
       impersonation_started_at = NULL, impersonation_expires_at = NULL, last_seen_at = now()
     WHERE id = $1::uuid AND impersonation_expires_at <= now()`,
    [row.id],
  )
  const refreshed = await query<SessionRow>(`${SESSION_SELECT} WHERE session.id = $1::uuid`, [row.id])
  if (refreshed.rows[0]?.effective_user_email === row.authenticated_user_email) {
    await recordAuditEvent({
      actor: row.authenticated_user_email,
      subject: target,
      eventType: 'auth.impersonation.expired',
      aggregateType: 'app_session',
      aggregateId: row.id,
      organizationId: refreshed.rows[0].active_workspace_organization_id,
      payload: {
        sessionId: row.id,
        organizationId: refreshed.rows[0].active_workspace_organization_id,
        authenticatedUser: row.authenticated_user_email,
        effectiveUser: target,
      },
    }).catch(() => undefined)
    return refreshed.rows[0]
  }
  return row
}

export async function resolveBrowserSessionToken(token?: string | null): Promise<BrowserSession | null> {
  if (!token || token.includes('.')) return null
  const result = await query<SessionRow>(`${SESSION_SELECT} WHERE session.token_hash = $1`, [hashToken(token)])
  let row = result.rows[0]
  if (!row || row.revoked_at) return null
  if (row.authenticated_status !== 'active' || row.effective_status !== 'active' || row.active_membership_status !== 'active') {
    return expireSession(row, 'user_inactive')
  }
  if (Date.parse(row.absolute_expires_at) <= Date.now()) return expireSession(row, 'absolute_timeout')
  if (Date.parse(row.idle_expires_at) <= Date.now()) return expireSession(row, 'idle_timeout')
  row = await endExpiredImpersonation(row)
  if (Date.now() - Date.parse(row.last_seen_at) >= 60_000) {
    await query(
      `UPDATE app_sessions SET last_seen_at = now()
       WHERE id = $1::uuid AND revoked_at IS NULL`,
      [row.id],
    ).catch(() => undefined)
  }
  return fromRow(row)
}

export async function resolveRequestSession(req: NextRequest): Promise<BrowserSession | null> {
  for (const name of getCookieNames()) {
    const token = req.cookies.get(name)?.value
    if (!token) continue
    const durable = await resolveBrowserSessionToken(token)
    if (durable) return durable
    const legacy = verifySessionToken(token)
    if (legacy.ok) {
      return {
        id: 'legacy',
        authenticatedUser: legacy.user.toLowerCase(),
        effectiveUser: legacy.user.toLowerCase(),
        authenticatedRole: 'member',
        effectiveRole: 'member',
        activeWorkspaceOrganizationId: null,
        activeWorkspaceName: null,
        activeWorkspaceReferenceCode: null,
        activeWorkspaceRole: null,
        activeWorkspacePermissions: null,
        activeWorkspaceSwitchedAt: null,
        authMethod: 'legacy_upgrade',
        deviceLabel: deviceLabel(req.headers),
        userAgent: String(req.headers.get('user-agent') || '').slice(0, 512) || null,
        initialIpAddress: observedRequestIpAddress(req.headers),
        lastIpAddress: observedRequestIpAddress(req.headers),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastUserActivityAt: new Date().toISOString(),
        lastAuthenticatedAt: new Date().toISOString(),
        idleExpiresAt: new Date(legacy.exp * 1000).toISOString(),
        absoluteExpiresAt: new Date(legacy.exp * 1000).toISOString(),
        impersonationStartedAt: null,
        impersonationExpiresAt: null,
        impersonating: false,
        legacy: true,
      }
    }
  }
  return null
}

export async function upgradeLegacyRequestSession(req: NextRequest, session: BrowserSession): Promise<IssuedBrowserSession> {
  if (!session.legacy) throw new Error('Session is already durable')
  return createBrowserSession({ email: session.authenticatedUser, authMethod: 'legacy_upgrade', headers: req.headers })
}

export function setBrowserSessionCookie(response: NextResponse, issued: IssuedBrowserSession): void {
  const maxAge = Math.max(1, Math.floor((Date.parse(issued.session.absoluteExpiresAt) - Date.now()) / 1000))
  response.cookies.set({
    name: getCookieName(),
    value: issued.token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  })
  for (const name of getCookieNames()) {
    if (name === getCookieName()) continue
    response.cookies.set({ name, value: '', httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 0 })
  }
}

export function clearBrowserSessionCookies(response: NextResponse): void {
  for (const name of getCookieNames()) {
    response.cookies.set({
      name,
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: name.startsWith('__Host-') || process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    })
  }
}

export async function touchBrowserSessionActivity(session: BrowserSession, headers: Headers): Promise<BrowserSession | null> {
  if (session.legacy || session.id === 'legacy') return null
  const result = await query<SessionRow>(
    `${SESSION_SELECT}
     WHERE session.id = $1::uuid AND session.revoked_at IS NULL
       AND session.absolute_expires_at > now() AND session.idle_expires_at > now()`,
    [session.id],
  )
  if (!result.rows[0]) return null
  await query(
    `UPDATE app_sessions SET last_seen_at = now(), last_user_activity_at = now(),
       last_network_fingerprint = $2, last_ip_address = $3::inet,
       idle_expires_at = LEAST(absolute_expires_at, now() + (idle_timeout_seconds * interval '1 second'))
     WHERE id = $1::uuid AND revoked_at IS NULL`,
    [session.id, networkFingerprint(headers), observedRequestIpAddress(headers)],
  )
  const refreshed = await query<SessionRow>(`${SESSION_SELECT} WHERE session.id = $1::uuid`, [session.id])
  return refreshed.rows[0] ? fromRow(refreshed.rows[0]) : null
}

export async function listBrowserSessions(authenticatedUser: string): Promise<BrowserSession[]> {
  const result = await query<SessionRow>(
    `${SESSION_SELECT}
     WHERE session.authenticated_user_email = $1 AND session.revoked_at IS NULL
       AND session.absolute_expires_at > now() AND session.idle_expires_at > now()
     ORDER BY session.last_seen_at DESC`,
    [authenticatedUser.toLowerCase()],
  )
  return result.rows.map(fromRow)
}

export async function revokeBrowserSession(input: {
  authenticatedUser: string
  sessionId: string
  actor?: string
  reason?: string
  audit?: boolean
}): Promise<boolean> {
  const result = await query<{
    id: string
    effective_user_email: string
    device_label: string
    active_workspace_organization_id: string
  }>(
    `UPDATE app_sessions SET revoked_at = now(), revoked_reason = $3
     WHERE id = $1::uuid AND authenticated_user_email = $2 AND revoked_at IS NULL
     RETURNING id::text, effective_user_email, device_label, active_workspace_organization_id::text`,
    [input.sessionId, input.authenticatedUser.toLowerCase(), input.reason || 'user_revoked'],
  )
  const row = result.rows[0]
  if (!row) return false
  if (input.audit !== false) {
    await recordAuditEvent({
      actor: input.actor || input.authenticatedUser,
      subject: row.effective_user_email,
      eventType: 'auth.session.revoked',
      aggregateType: 'app_session',
      aggregateId: row.id,
      organizationId: row.active_workspace_organization_id,
      payload: {
        sessionId: row.id,
        organizationId: row.active_workspace_organization_id,
        deviceLabel: row.device_label,
        revokeReason: input.reason || 'user_revoked',
      },
    }).catch(() => undefined)
  }
  return true
}

export async function revokeOtherBrowserSessions(input: {
  authenticatedUser: string
  currentSessionId: string
  organizationId: string
}): Promise<number> {
  const result = await query<{ id: string }>(
    `UPDATE app_sessions SET revoked_at = now(), revoked_reason = 'revoke_others'
     WHERE authenticated_user_email = $1 AND id <> $2::uuid AND revoked_at IS NULL
     RETURNING id::text`,
    [input.authenticatedUser.toLowerCase(), input.currentSessionId],
  )
  await recordAuditEvent({
    actor: input.authenticatedUser,
    subject: input.authenticatedUser,
    eventType: 'auth.sessions.revoked',
    aggregateType: 'app_user',
    aggregateId: input.authenticatedUser,
    organizationId: input.organizationId,
    payload: {
      sessionId: input.currentSessionId,
      organizationId: input.organizationId,
      revokedCount: result.rowCount || 0,
      revokeReason: 'revoke_others',
    },
  }).catch(() => undefined)
  return result.rowCount || 0
}

export async function revokeAllBrowserSessionsForUser(input: {
  userEmail: string
  actor: string
  reason: string
  organizationId: string
}): Promise<number> {
  const result = await query<{ id: string }>(
    `UPDATE app_sessions SET revoked_at = now(), revoked_reason = $2
     WHERE (authenticated_user_email = $1 OR effective_user_email = $1) AND revoked_at IS NULL
     RETURNING id::text`,
    [input.userEmail.toLowerCase(), input.reason],
  )
  if (result.rowCount) {
    await recordAuditEvent({
      actor: input.actor,
      subject: input.userEmail,
      eventType: 'auth.sessions.revoked',
      aggregateType: 'app_user',
      aggregateId: input.userEmail,
      organizationId: input.organizationId,
      payload: {
        organizationId: input.organizationId,
        revokedCount: result.rowCount,
        revokeReason: input.reason,
      },
    }).catch(() => undefined)
  }
  return result.rowCount || 0
}

export async function revokeBrowserSessionsForUserWorkspace(input: {
  userEmail: string
  organizationId: string
  actor: string
  reason: string
}): Promise<number> {
  const result = await query<{ id: string }>(
    `UPDATE app_sessions
     SET revoked_at = now(), revoked_reason = $3
     WHERE (authenticated_user_email = $1 OR effective_user_email = $1)
       AND active_workspace_organization_id = $2::uuid
       AND revoked_at IS NULL
     RETURNING id::text`,
    [input.userEmail.toLowerCase(), input.organizationId, input.reason],
  )
  if (result.rowCount) {
    await recordAuditEvent({
      actor: input.actor,
      subject: input.userEmail,
      eventType: 'auth.sessions.revoked',
      aggregateType: 'app_user',
      aggregateId: input.userEmail,
      organizationId: input.organizationId,
      payload: {
        organizationId: input.organizationId,
        revokedCount: result.rowCount,
        revokeReason: input.reason,
      },
    }).catch(() => undefined)
  }
  return result.rowCount || 0
}

export async function listImpersonationTargets(authenticatedUser: string) {
  const owner = String(process.env.APP_LOGIN_EMAIL || '').trim().toLowerCase()
  if (authenticatedUser.toLowerCase() !== owner) throw new Error('Root administrator access required')
  const result = await query<{
    email: string
    display_name: string | null
    organization_name: string | null
    role: SessionRole
  }>(
    `SELECT email, display_name, organization_name, role
     FROM app_users WHERE status = 'active' AND role <> 'owner' AND email <> $1
     ORDER BY COALESCE(display_name, email), email`,
    [owner],
  )
  return result.rows.map((row) => ({
    email: row.email,
    displayName: row.display_name,
    organizationName: row.organization_name,
    role: row.role,
  }))
}

export async function startImpersonation(input: {
  session: BrowserSession
  targetEmail: string
}): Promise<IssuedBrowserSession> {
  if (input.session.legacy || input.session.id === 'legacy') throw new Error('Sign in again before using support mode')
  if (input.session.impersonating) throw new Error('Exit the current user view before selecting another user')
  const owner = String(process.env.APP_LOGIN_EMAIL || '').trim().toLowerCase()
  if (input.session.authenticatedUser !== owner || input.session.authenticatedRole !== 'owner') {
    throw new Error('Root administrator access required')
  }
  if (Date.now() - Date.parse(input.session.lastAuthenticatedAt) > RECENT_AUTH_SECONDS * 1000) {
    throw new Error('Sign out and sign in again before using support mode')
  }
  const targetEmail = String(input.targetEmail || '').trim().toLowerCase()
  if (!targetEmail || targetEmail === owner) throw new Error('Select an active non-owner user')
  const token = newToken()
  const row = await withTransaction(async (client) => {
    const target = await client.query<{
      email: string
      role: SessionRole
      status: string
      organization_id: string
    }>(
      `SELECT app_user.email, app_user.role, app_user.status, membership.organization_id::text
       FROM app_users app_user
       JOIN LATERAL (
         SELECT organization_id
         FROM app_user_organization_memberships
         WHERE user_email = app_user.email AND status = 'active'
         ORDER BY is_default DESC, created_at
         LIMIT 1
       ) membership ON true
       WHERE app_user.email = $1
       FOR SHARE OF app_user`,
      [targetEmail],
    )
    if (!target.rows[0] || target.rows[0].status !== 'active' || target.rows[0].role === 'owner') {
      throw new Error('Select an active non-owner user')
    }
    const updated = await client.query<SessionRow>(
      `WITH changed AS (
         UPDATE app_sessions SET token_hash = $2, effective_user_email = $3,
           active_workspace_organization_id = $5::uuid,
           active_workspace_switched_at = now(),
           impersonation_started_at = now(),
           impersonation_expires_at = now() + ($4::integer * interval '1 second'),
           last_seen_at = now()
         WHERE id = $1::uuid AND revoked_at IS NULL
         RETURNING *
       )
       ${SESSION_SELECT.replace('FROM app_sessions session', 'FROM changed session')}`,
      [input.session.id, hashToken(token), targetEmail, IMPERSONATION_TTL_SECONDS, target.rows[0].organization_id],
    )
    if (!updated.rows[0]) throw new Error('Session is no longer active')
    await recordAuditEvent({
      actor: owner,
      subject: targetEmail,
      eventType: 'auth.impersonation.started',
      aggregateType: 'app_session',
      aggregateId: input.session.id,
      organizationId: target.rows[0].organization_id,
      payload: {
        sessionId: input.session.id,
        authenticatedUser: owner,
        effectiveUser: targetEmail,
        deviceLabel: input.session.deviceLabel,
        impersonationExpiresAt: updated.rows[0].impersonation_expires_at,
      },
    }, client)
    return updated.rows[0]
  })
  return { token, session: fromRow(row) }
}

export async function stopImpersonation(session: BrowserSession): Promise<IssuedBrowserSession> {
  if (session.legacy || session.id === 'legacy' || !session.impersonating) throw new Error('Support mode is not active')
  const token = newToken()
  const target = session.effectiveUser
  const result = await query<SessionRow>(
    `WITH changed AS (
       UPDATE app_sessions SET token_hash = $2,
         effective_user_email = authenticated_user_email,
         active_workspace_organization_id = (
           SELECT organization_id
           FROM app_user_organization_memberships
           WHERE user_email = app_sessions.authenticated_user_email AND status = 'active'
           ORDER BY is_default DESC, created_at
           LIMIT 1
         ),
         active_workspace_switched_at = now(),
         impersonation_started_at = NULL, impersonation_expires_at = NULL,
         last_seen_at = now()
       WHERE id = $1::uuid AND revoked_at IS NULL
       RETURNING *
     )
     ${SESSION_SELECT.replace('FROM app_sessions session', 'FROM changed session')}`,
    [session.id, hashToken(token)],
  )
  if (!result.rows[0]) throw new Error('Session is no longer active')
  await recordAuditEvent({
    actor: session.authenticatedUser,
    subject: target,
    eventType: 'auth.impersonation.ended',
    aggregateType: 'app_session',
    aggregateId: session.id,
    organizationId: result.rows[0].active_workspace_organization_id,
    payload: {
      sessionId: session.id,
      organizationId: result.rows[0].active_workspace_organization_id,
      authenticatedUser: session.authenticatedUser,
      effectiveUser: target,
      deviceLabel: session.deviceLabel,
    },
  }).catch(() => undefined)
  return { token, session: fromRow(result.rows[0]) }
}

export async function switchBrowserSessionWorkspace(input: {
  session: BrowserSession
  organizationId: string
}): Promise<IssuedBrowserSession> {
  if (input.session.legacy || input.session.id === 'legacy') {
    throw new Error('Sign in again before switching businesses')
  }
  const organizationId = String(input.organizationId || '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error('Select a valid business')
  }
  const token = newToken()
  const previousOrganizationId = input.session.activeWorkspaceOrganizationId
  const row = await withTransaction(async (client) => {
    const membership = await client.query<{
      organization_id: string
      organization_name: string
      organization_reference_code: string
      role: SessionRole
      google_sign_in_enabled: boolean
    }>(
      `SELECT membership.organization_id::text,
         organization.name AS organization_name,
         organization.reference_code AS organization_reference_code,
         membership.role,
         COALESCE(auth_policy.google_sign_in_enabled, false) AS google_sign_in_enabled
       FROM app_user_organization_memberships membership
       JOIN workspace_organizations organization ON organization.id = membership.organization_id
       LEFT JOIN app_organization_auth_policies auth_policy
         ON auth_policy.organization_id = membership.organization_id
       WHERE membership.user_email = $1
         AND membership.organization_id = $2::uuid
         AND membership.status = 'active'
       FOR SHARE OF membership, organization`,
      [input.session.effectiveUser, organizationId],
    )
    if (!membership.rows[0]) throw new Error('Business access is not available')
    if (input.session.authMethod === 'google_sso' && !membership.rows[0].google_sign_in_enabled) {
      throw new Error('Google sign-in is not enabled for that business. Sign in with a magic code to switch there')
    }
    const updated = await client.query<SessionRow>(
      `WITH changed AS (
         UPDATE app_sessions
         SET token_hash = $2,
             active_workspace_organization_id = $3::uuid,
             active_workspace_switched_at = now(),
             idle_timeout_seconds = $5,
             idle_expires_at = LEAST(
               absolute_expires_at,
               now() + ($5::integer * interval '1 second')
             ),
             last_seen_at = now(),
             last_user_activity_at = now()
         WHERE id = $1::uuid
           AND effective_user_email = $4
           AND revoked_at IS NULL
         RETURNING *
       )
       ${SESSION_SELECT.replace('FROM app_sessions session', 'FROM changed session')}`,
      [
        input.session.id,
        hashToken(token),
        organizationId,
        input.session.effectiveUser,
        idleTtl(membership.rows[0].role),
      ],
    )
    if (!updated.rows[0]) throw new Error('Session is no longer active')
    await recordAuditEvent({
      actor: input.session.authenticatedUser,
      subject: input.session.effectiveUser,
      eventType: 'auth.workspace.switched',
      aggregateType: 'app_session',
      aggregateId: input.session.id,
      organizationId,
      payload: {
        sessionId: input.session.id,
        authenticatedUser: input.session.authenticatedUser,
        effectiveUser: input.session.effectiveUser,
        impersonated: input.session.impersonating,
        previousOrganizationId,
        organizationId,
        organizationName: membership.rows[0].organization_name,
        organizationReferenceCode: membership.rows[0].organization_reference_code,
        deviceLabel: input.session.deviceLabel,
      },
    }, client)
    return updated.rows[0]
  })
  return { token, session: fromRow(row) }
}

export const SESSION_POLICY = {
  absoluteTtlSeconds: ABSOLUTE_TTL_SECONDS,
  adminIdleTtlSeconds: ADMIN_IDLE_TTL_SECONDS,
  memberIdleTtlSeconds: MEMBER_IDLE_TTL_SECONDS,
  impersonationTtlSeconds: IMPERSONATION_TTL_SECONDS,
  recentAuthSeconds: RECENT_AUTH_SECONDS,
}
