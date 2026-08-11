import { OAuth2Client } from 'google-auth-library'

export type VerifiedGoogleIdentity = {
  subject: string
  email: string
  displayName: string | null
}

export class GoogleSsoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'GoogleSsoError'
  }
}

export type GoogleSsoClientConfiguration = {
  configured: boolean
  clientId: string | null
}

export function googleSsoClientConfiguration(): GoogleSsoClientConfiguration {
  const value = String(process.env.GOOGLE_SSO_SERVER_CLIENT_ID || '').trim()
  return value.endsWith('.apps.googleusercontent.com')
    ? { configured: true, clientId: value }
    : { configured: false, clientId: null }
}

function serverClientId(): string {
  const configuration = googleSsoClientConfiguration()
  if (!configuration.clientId) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_NOT_CONFIGURED',
      'Google sign-in is not configured',
      503,
    )
  }
  return configuration.clientId
}

export async function verifyGoogleIdentityToken(
  rawToken: unknown,
): Promise<VerifiedGoogleIdentity> {
  const idToken = String(rawToken || '').trim()
  if (!idToken || idToken.length > 8_192) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_TOKEN_INVALID',
      'Google sign-in could not be verified',
      401,
    )
  }

  const audience = serverClientId()
  let payload
  try {
    const ticket = await new OAuth2Client(audience).verifyIdToken({
      idToken,
      audience,
    })
    payload = ticket.getPayload()
  } catch {
    throw new GoogleSsoError(
      'GOOGLE_SSO_TOKEN_INVALID',
      'Google sign-in could not be verified',
      401,
    )
  }

  const subject = String(payload?.sub || '').trim()
  const email = String(payload?.email || '').trim().toLowerCase()
  if (
    !subject
    || !email.includes('@')
    || email.length > 254
    || payload?.email_verified !== true
  ) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_EMAIL_UNVERIFIED',
      'Use a verified Google account email',
      401,
    )
  }

  const displayName = String(payload?.name || '').trim()
  return {
    subject,
    email,
    displayName: displayName || null,
  }
}
