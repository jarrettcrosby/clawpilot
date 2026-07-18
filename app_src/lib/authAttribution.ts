import crypto from 'crypto'

export const AUTH_CONTEXT_HEADER = 'x-clawpilot-auth-context'
export const AUTH_CONTEXT_PROOF_HEADER = 'x-clawpilot-auth-proof'

export type RequestAuthAttribution = {
  sessionId: string
  authenticatedUser: string
  effectiveUser: string
  activeWorkspaceOrganizationId: string
  impersonating: boolean
}
function secret(): string {
  const value = String(process.env.APP_SESSION_SECRET || process.env.NEXTAUTH_SECRET || '')
  if (value.length < 32) throw new Error('APP_SESSION_SECRET must contain at least 32 characters')
  return value
}

function sign(value: string): string {
  return crypto.createHmac('sha256', secret()).update(`clawpilot-auth-context:v1\n${value}`).digest('base64url')
}

export function createAuthAttributionHeaders(input: RequestAuthAttribution): Record<string, string> {
  const payload = Buffer.from(JSON.stringify(input)).toString('base64url')
  return {
    [AUTH_CONTEXT_HEADER]: payload,
    [AUTH_CONTEXT_PROOF_HEADER]: sign(payload),
  }
}

export function verifyAuthAttributionHeaders(headers: Pick<Headers, 'get'>): RequestAuthAttribution | null {
  const payload = String(headers.get(AUTH_CONTEXT_HEADER) || '')
  const proof = String(headers.get(AUTH_CONTEXT_PROOF_HEADER) || '')
  if (!payload || !proof) return null
  const expected = sign(payload)
  if (proof.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RequestAuthAttribution
    if (
      !/^[0-9a-f-]{36}$/i.test(String(parsed.sessionId || ''))
      || !/^[0-9a-f-]{36}$/i.test(String(parsed.activeWorkspaceOrganizationId || ''))
      || !String(parsed.authenticatedUser || '').includes('@')
      || !String(parsed.effectiveUser || '').includes('@')
      || parsed.impersonating !== (parsed.authenticatedUser !== parsed.effectiveUser)
    ) return null
    return {
      sessionId: parsed.sessionId,
      authenticatedUser: parsed.authenticatedUser.toLowerCase(),
      effectiveUser: parsed.effectiveUser.toLowerCase(),
      activeWorkspaceOrganizationId: parsed.activeWorkspaceOrganizationId.toLowerCase(),
      impersonating: parsed.impersonating,
    }
  } catch {
    return null
  }
}
