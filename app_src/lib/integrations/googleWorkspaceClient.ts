import { JWT } from 'google-auth-library'
import type { GoogleServiceAccountCredential } from '@/lib/integrations/googleWorkspaceCrypto'

const DRIVE_ORIGIN = 'https://www.googleapis.com'
const SHEETS_ORIGIN = 'https://sheets.googleapis.com'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const SHEETS_ACCESS_PROBE_ID = 'clawpilot_google_sheets_api_probe'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

export type GoogleSharedDrive = {
  id: string
  name: string
}

export type GoogleWorkspaceRuntime = {
  authClient: JWT
  apiKey: string | null
  projectId: string
  serviceAccountEmail: string
  privateKeyId: string
  credentialVersion: number
  sharedDriveId: string | null
  sharedDriveName: string | null
}

type GoogleRequestInput = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  idempotent?: boolean
}

type GoogleUpstreamErrorDetails = {
  reason: string
  message: string
}

export class GoogleWorkspaceClientError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'GOOGLE_WORKSPACE_UPSTREAM_FAILED',
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'GoogleWorkspaceClientError'
  }
}

function cleanResourceId(value: unknown, label: string) {
  const resourceId = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(resourceId)) {
    throw new GoogleWorkspaceClientError(`${label} is invalid`, 400, 'GOOGLE_RESOURCE_ID_INVALID')
  }
  return resourceId
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function requestUrl(origin: string, pathname: string, prefix: string, apiKey: string | null) {
  if (
    !pathname.startsWith(prefix)
    || pathname.startsWith('//')
    || pathname.includes('\\')
    || pathname.includes('#')
    || /[\u0000-\u001f\u007f]/.test(pathname)
  ) {
    throw new GoogleWorkspaceClientError('Google Workspace request path is invalid', 500)
  }
  const url = new URL(pathname, `${origin}/`)
  if (url.origin !== origin) {
    throw new GoogleWorkspaceClientError('Google Workspace request origin is invalid', 500)
  }
  if (apiKey) url.searchParams.set('key', apiKey)
  return url
}

async function accessToken(runtime: GoogleWorkspaceRuntime) {
  try {
    const access = await runtime.authClient.getAccessToken()
    const token = typeof access === 'string' ? access : access?.token
    if (!token) throw new Error('missing token')
    return token
  } catch {
    throw new GoogleWorkspaceClientError(
      'Google service-account authentication failed',
      502,
      'GOOGLE_SERVICE_ACCOUNT_AUTH_FAILED',
    )
  }
}

async function readBoundedResponse(response: Response) {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new GoogleWorkspaceClientError(
      'Google Workspace response exceeded the safe size limit',
      502,
      'GOOGLE_RESPONSE_TOO_LARGE',
    )
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new GoogleWorkspaceClientError(
        'Google Workspace response exceeded the safe size limit',
        502,
        'GOOGLE_RESPONSE_TOO_LARGE',
      )
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function googleUpstreamErrorDetails(bytes: Uint8Array): GoogleUpstreamErrorDetails {
  if (bytes.byteLength === 0) return { reason: '', message: '' }
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      error?: {
        message?: unknown
        status?: unknown
        errors?: Array<{ reason?: unknown }>
      }
    }
    const reasonValue = payload.error?.errors?.[0]?.reason || payload.error?.status
    const reason = typeof reasonValue === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(reasonValue)
      ? reasonValue
      : ''
    const rawMessage = typeof payload.error?.message === 'string' ? payload.error.message : ''
    const message = rawMessage
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
    return { reason, message }
  } catch {
    return { reason: '', message: '' }
  }
}

function upstreamError(status: number, details: GoogleUpstreamErrorDetails = { reason: '', message: '' }) {
  const reason = details.reason ? ` (${details.reason})` : ''
  const detail = details.message ? `: ${details.message}` : ''
  if (status === 400) {
    return new GoogleWorkspaceClientError(
      `Google rejected the integration request${reason}${detail}`,
      422,
      'GOOGLE_REQUEST_REJECTED',
    )
  }
  if (status === 401 || status === 403) {
    return new GoogleWorkspaceClientError(
      `Google denied access for the configured service account${reason}${detail}`,
      422,
      'GOOGLE_ACCESS_DENIED',
    )
  }
  if (status === 404) {
    return new GoogleWorkspaceClientError(
      'The managed Google Workspace resource was not found',
      409,
      'GOOGLE_RESOURCE_NOT_FOUND',
    )
  }
  return new GoogleWorkspaceClientError(
    'Google Workspace request failed',
    502,
    'GOOGLE_WORKSPACE_UPSTREAM_FAILED',
    RETRYABLE_STATUSES.has(status),
  )
}

async function googleJson<T>(
  runtime: GoogleWorkspaceRuntime,
  origin: string,
  pathname: string,
  prefix: string,
  input: GoogleRequestInput = {},
): Promise<T> {
  const url = requestUrl(origin, pathname, prefix, runtime.apiKey)
  const method = input.method || 'GET'
  const attempts = input.idempotent === false ? 1 : 3
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const token = await accessToken(runtime)
      const headers = new Headers({
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      })
      if (input.body !== undefined) headers.set('Content-Type', 'application/json')
      const response = await fetch(url, {
        method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
        cache: 'no-store',
      })
      const bytes = await readBoundedResponse(response)
      if (!response.ok) {
        const error = upstreamError(response.status, googleUpstreamErrorDetails(bytes))
        if (attempt < attempts && error.retryable) {
          await delay(250 * (2 ** (attempt - 1)))
          continue
        }
        throw error
      }
      if (bytes.byteLength === 0) return {} as T
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as T
      } catch {
        throw new GoogleWorkspaceClientError(
          'Google Workspace returned an invalid response',
          502,
          'GOOGLE_RESPONSE_INVALID',
        )
      }
    } catch (error) {
      lastError = error
      if (error instanceof GoogleWorkspaceClientError && !error.retryable) throw error
      if (attempt >= attempts) break
      await delay(250 * (2 ** (attempt - 1)))
    }
  }

  if (lastError instanceof GoogleWorkspaceClientError) throw lastError
  throw new GoogleWorkspaceClientError(
    'Google Workspace is temporarily unavailable',
    502,
    'GOOGLE_WORKSPACE_UNAVAILABLE',
    true,
  )
}

export function createGoogleWorkspaceRuntime(input: {
  serviceAccount: GoogleServiceAccountCredential
  apiKey?: string | null
  credentialVersion?: number
  sharedDriveId?: string | null
  sharedDriveName?: string | null
}): GoogleWorkspaceRuntime {
  return {
    authClient: new JWT({
      email: input.serviceAccount.client_email,
      key: input.serviceAccount.private_key,
      scopes: [DRIVE_SCOPE, SHEETS_SCOPE],
    }),
    apiKey: input.apiKey || null,
    projectId: input.serviceAccount.project_id,
    serviceAccountEmail: input.serviceAccount.client_email,
    privateKeyId: input.serviceAccount.private_key_id,
    credentialVersion: input.credentialVersion || 0,
    sharedDriveId: input.sharedDriveId || null,
    sharedDriveName: input.sharedDriveName || null,
  }
}

export function googleDriveJson<T>(
  runtime: GoogleWorkspaceRuntime,
  pathname: string,
  input: GoogleRequestInput = {},
) {
  return googleJson<T>(runtime, DRIVE_ORIGIN, pathname, '/drive/v3/', input)
}

export function googleSheetsJson<T>(
  runtime: GoogleWorkspaceRuntime,
  pathname: string,
  input: GoogleRequestInput = {},
) {
  return googleJson<T>(runtime, SHEETS_ORIGIN, pathname, '/v4/', input)
}

export async function validateGoogleApiKey(apiKey: string) {
  const url = new URL('/discovery/v1/apis/drive/v3/rest', DRIVE_ORIGIN)
  url.searchParams.set('key', apiKey)
  let lastError: unknown

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
        cache: 'no-store',
      })
      const bytes = await readBoundedResponse(response)
      if (!response.ok) {
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          throw new GoogleWorkspaceClientError(
            'Google rejected the API key',
            422,
            'GOOGLE_API_KEY_INVALID',
          )
        }
        const error = upstreamError(response.status, googleUpstreamErrorDetails(bytes))
        if (attempt < 3 && error.retryable) {
          await delay(250 * (2 ** (attempt - 1)))
          continue
        }
        throw error
      }
      let discovery: { name?: string; version?: string; rootUrl?: string }
      try {
        discovery = JSON.parse(new TextDecoder().decode(bytes)) as typeof discovery
      } catch {
        throw new GoogleWorkspaceClientError(
          'Google API key validation returned an invalid response',
          502,
          'GOOGLE_RESPONSE_INVALID',
        )
      }
      if (
        discovery.name !== 'drive'
        || discovery.version !== 'v3'
        || discovery.rootUrl !== `${DRIVE_ORIGIN}/`
      ) {
        throw new GoogleWorkspaceClientError(
          'Google API key validation returned unexpected metadata',
          502,
          'GOOGLE_RESPONSE_INVALID',
        )
      }
      return
    } catch (error) {
      lastError = error
      if (error instanceof GoogleWorkspaceClientError && !error.retryable) throw error
      if (attempt >= 3) break
      await delay(250 * (2 ** (attempt - 1)))
    }
  }

  if (lastError instanceof GoogleWorkspaceClientError) throw lastError
  throw new GoogleWorkspaceClientError(
    'Google API key validation is temporarily unavailable',
    502,
    'GOOGLE_WORKSPACE_UNAVAILABLE',
    true,
  )
}

export async function validateGoogleServiceAccount(runtime: GoogleWorkspaceRuntime) {
  const parameters = new URLSearchParams({ fields: 'user(emailAddress)' })
  const about = await googleDriveJson<{ user?: { emailAddress?: string } }>(
    runtime,
    `/drive/v3/about?${parameters.toString()}`,
  )
  const authenticatedEmail = String(about.user?.emailAddress || '').trim().toLowerCase()
  if (authenticatedEmail !== runtime.serviceAccountEmail) {
    throw new GoogleWorkspaceClientError(
      'Google authenticated an unexpected service-account identity',
      422,
      'GOOGLE_SERVICE_ACCOUNT_IDENTITY_MISMATCH',
    )
  }
}

export async function validateGoogleSheetsAccess(runtime: GoogleWorkspaceRuntime) {
  const parameters = new URLSearchParams({ fields: 'spreadsheetId' })
  try {
    await googleSheetsJson(
      runtime,
      `/v4/spreadsheets/${SHEETS_ACCESS_PROBE_ID}?${parameters.toString()}`,
    )
  } catch (error) {
    if (
      error instanceof GoogleWorkspaceClientError
      && error.code === 'GOOGLE_RESOURCE_NOT_FOUND'
    ) {
      return
    }
    if (
      error instanceof GoogleWorkspaceClientError
      && error.code === 'GOOGLE_ACCESS_DENIED'
    ) {
      throw new GoogleWorkspaceClientError(
        'Enable Google Sheets API and allow it in the configured Google API key restrictions',
        422,
        'GOOGLE_SHEETS_ACCESS_DENIED',
      )
    }
    throw error
  }
}

async function listVisibleGoogleSharedDrives(runtime: GoogleWorkspaceRuntime) {
  const sharedDrives: GoogleSharedDrive[] = []
  let pageToken = ''
  for (let page = 0; page < 10; page += 1) {
    const parameters = new URLSearchParams({
      pageSize: '100',
      q: 'hidden = false',
      fields: 'nextPageToken,drives(id,name)',
    })
    if (pageToken) parameters.set('pageToken', pageToken)
    const response = await googleDriveJson<{
      drives?: Array<{ id?: string; name?: string }>
      nextPageToken?: string
    }>(runtime, `/drive/v3/drives?${parameters.toString()}`)
    for (const drive of response.drives || []) {
      const id = cleanResourceId(drive.id, 'Shared Drive ID')
      const name = String(drive.name || '').trim()
      if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) continue
      sharedDrives.push({ id, name })
    }
    pageToken = String(response.nextPageToken || '').trim()
    if (!pageToken) return sharedDrives
  }
  throw new GoogleWorkspaceClientError(
    'Shared Drive listing exceeded the safe page limit',
    409,
    'GOOGLE_SHARED_DRIVE_PAGE_LIMIT',
  )
}

export async function verifyAccessibleGoogleSharedDrive(
  runtime: GoogleWorkspaceRuntime,
  sharedDriveIdValue: unknown,
) {
  const sharedDriveId = cleanResourceId(sharedDriveIdValue, 'Shared Drive ID')
  const parameters = new URLSearchParams({ fields: 'id,name,hidden' })
  const drive = await googleDriveJson<{ id?: string; name?: string; hidden?: boolean }>(
    runtime,
    `/drive/v3/drives/${sharedDriveId}?${parameters.toString()}`,
  )
  if (drive.hidden || cleanResourceId(drive.id, 'Shared Drive ID') !== sharedDriveId) {
    throw new GoogleWorkspaceClientError(
      'The selected Shared Drive is not accessible',
      409,
      'GOOGLE_SHARED_DRIVE_UNAVAILABLE',
    )
  }
  const name = String(drive.name || '').trim()
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new GoogleWorkspaceClientError(
      'The selected Shared Drive has invalid metadata',
      409,
      'GOOGLE_SHARED_DRIVE_INVALID',
    )
  }
  const rootParameters = new URLSearchParams({
    supportsAllDrives: 'true',
    fields: 'id,name,capabilities(canAddChildren,canShare)',
  })
  const root = await googleDriveJson<{
    id?: string
    capabilities?: { canAddChildren?: boolean; canShare?: boolean }
  }>(runtime, `/drive/v3/files/${sharedDriveId}?${rootParameters.toString()}`)
  if (
    cleanResourceId(root.id, 'Shared Drive root ID') !== sharedDriveId
    || root.capabilities?.canAddChildren !== true
    || root.capabilities?.canShare !== true
  ) {
    throw new GoogleWorkspaceClientError(
      'The service account needs a Shared Drive role that can create and share content',
      409,
      'GOOGLE_SHARED_DRIVE_INSUFFICIENT_ACCESS',
    )
  }
  return { id: sharedDriveId, name }
}

export async function listAccessibleGoogleSharedDrives(runtime: GoogleWorkspaceRuntime) {
  const visible = await listVisibleGoogleSharedDrives(runtime)
  const writable: GoogleSharedDrive[] = []
  for (let offset = 0; offset < visible.length; offset += 10) {
    const batch = visible.slice(offset, offset + 10)
    const checked = await Promise.all(batch.map(async (drive) => {
      try {
        return await verifyAccessibleGoogleSharedDrive(runtime, drive.id)
      } catch (error) {
        if (
          error instanceof GoogleWorkspaceClientError
          && error.code === 'GOOGLE_SHARED_DRIVE_INSUFFICIENT_ACCESS'
        ) {
          return null
        }
        throw error
      }
    }))
    writable.push(...checked.filter((drive): drive is GoogleSharedDrive => Boolean(drive)))
  }
  return writable
}
