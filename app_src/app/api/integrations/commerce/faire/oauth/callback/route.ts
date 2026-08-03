import { NextRequest, NextResponse } from 'next/server'
import {
  CommerceIntegrationRequestError,
  completeFaireOAuthCommerce,
  discardFaireOAuthCommerce,
  purgeExpiredFaireOAuthCommerce,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import {
  readFaireOAuthCallbackAuthorizationCode,
} from '@/lib/integrations/faireOAuthCallback'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { appPublicUrl } from '@/lib/publicUrl'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestSession, requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function resultUrl(status: 'connected' | 'error', code?: string) {
  const url = new URL('/', appPublicUrl())
  url.searchParams.set('settings', 'integrations')
  url.searchParams.set('integration', 'commerce')
  url.searchParams.set('faireOauth', status)
  if (code) url.searchParams.set('faireOauthCode', code)
  return url
}

function redirect(status: 'connected' | 'error', code?: string) {
  return NextResponse.redirect(resultUrl(status, code), {
    status: 303,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

export async function GET(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      throw new CommerceIntegrationRequestError(
        'Sales-channel integrations require Postgres storage',
        503,
        'COMMERCE_POSTGRES_REQUIRED',
      )
    }
    const session = await requireRequestSession(req)
    const actor = await requireRequestUser(req)
    if (!actor.organizationId) {
      throw new CommerceIntegrationRequestError(
        'Your organization is not configured',
        409,
        'COMMERCE_ORGANIZATION_REQUIRED',
      )
    }
    if (!operationsCapabilities(actor).canManage) {
      throw new CommerceIntegrationRequestError(
        'Operations-management permission is required to manage sales channels',
        403,
        'COMMERCE_MANAGER_REQUIRED',
      )
    }
    await purgeExpiredFaireOAuthCommerce()
    const state = req.nextUrl.searchParams.get('state')
    const authorizationCode = readFaireOAuthCallbackAuthorizationCode(
      req.nextUrl.searchParams,
    )
    const providerDenied = req.nextUrl.searchParams.has('error')
    if (providerDenied || !state || !authorizationCode) {
      if (state) {
        await discardFaireOAuthCommerce({
          organizationId: actor.organizationId,
          browserSessionId: session.id,
          actorEmail: actor.email,
          state,
        })
      }
      throw new CommerceIntegrationRequestError(
        providerDenied
          ? 'Faire authorization was not approved'
          : 'Faire OAuth callback was incomplete',
        400,
        providerDenied
          ? 'FAIRE_OAUTH_AUTHORIZATION_DENIED'
          : 'FAIRE_OAUTH_CALLBACK_INVALID',
      )
    }
    await completeFaireOAuthCommerce({
      organizationId: actor.organizationId,
      browserSessionId: session.id,
      actorEmail: actor.email,
      state,
      authorizationCode,
    })
    return redirect('connected')
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return redirect('error', 'UNAUTHORIZED')
    }
    const sanitized = sanitizedCommerceIntegrationError(error)
    return redirect('error', sanitized.code)
  }
}
