import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import { availableOrganizationAppDomains, effectiveOrganizationAppDomain, OrganizationWebPreferenceError, readOrganizationWebPreferences, saveOrganizationWebPreferences } from '@/lib/organizationWebPreferences'
import { requireRequestSession, requireRequestUser } from '@/lib/requestUser'
import { availableShortLinkDomains, type ShortLinkActor } from '@/lib/shortlinks'
import { effectiveAuthorizationRole, type AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
function shortLinkActor(actor: AppUser): ShortLinkActor {
  return { ownerEmail: actor.email, organizationId: actor.organizationId!, sourceApp: 'clawpilot', service: false, manageOrganization: true }
}
async function payload(actor: AppUser) {
  if (!actor.organizationId) throw new OrganizationWebPreferenceError('Active organization is required', 403)
  const preferences = await readOrganizationWebPreferences(actor.organizationId)
  const appDomains = availableOrganizationAppDomains()
  const shortLinkDomains = availableShortLinkDomains(shortLinkActor(actor))
  const effectiveApp = effectiveOrganizationAppDomain(preferences)
  const effectiveShortLink = shortLinkDomains.find((choice) => choice.key === preferences.shortLinkDomain) || shortLinkDomains[0]
  return { ok: true, canEdit: ['owner', 'admin'].includes(effectiveAuthorizationRole(actor)), preferences,
    availableAppDomains: appDomains, availableShortLinkDomains: shortLinkDomains,
    effectiveApp, effectiveShortLink, organizationName: actor.organizationName }
}
function failure(error: unknown) {
  const unauthorized = error instanceof Error && error.message === 'Unauthorized'
  return json({ ok: false, error: error instanceof OrganizationWebPreferenceError ? error.message : unauthorized ? 'Sign in to continue.' : 'Unable to load or save organization web settings.' }, error instanceof OrganizationWebPreferenceError ? error.status : unauthorized ? 401 : 500)
}
export async function GET(req: NextRequest) {
  try { return json(await payload(await requireRequestUser(req))) } catch (error) { return failure(error) }
}
export async function PUT(req: NextRequest) {
  try {
    if (!isBrowserSameOriginRequest({ headers: req.headers, requestOrigin: req.nextUrl.origin })) throw new OrganizationWebPreferenceError('A same-origin request is required', 403)
    const session = await requireRequestSession(req)
    if (session.impersonating || session.authenticatedUser !== session.effectiveUser) throw new OrganizationWebPreferenceError('Exit user view before changing organization settings', 403)
    const actor = await requireRequestUser(req)
    if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new OrganizationWebPreferenceError('JSON is required', 415)
    if (Number(req.headers.get('content-length') || 0) > 2048) throw new OrganizationWebPreferenceError('Request is too large', 413)
    const text = await req.text()
    if (Buffer.byteLength(text, 'utf8') > 2048) throw new OrganizationWebPreferenceError('Request is too large', 413)
    let input: Record<string, unknown>
    try { input = JSON.parse(text) } catch { throw new OrganizationWebPreferenceError('Invalid JSON') }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['appDomain', 'shortLinkDomain', 'allowUserShortLinkOverride', 'revision', 'expectedOrganizationId'].includes(key))) throw new OrganizationWebPreferenceError('Invalid organization web settings')
    if (input.expectedOrganizationId !== actor.organizationId) throw new OrganizationWebPreferenceError('The active organization changed. Reload settings before saving.', 409)
    await saveOrganizationWebPreferences(actor, input, availableShortLinkDomains(shortLinkActor(actor)))
    return json(await payload(actor))
  } catch (error) { return failure(error) }
}
