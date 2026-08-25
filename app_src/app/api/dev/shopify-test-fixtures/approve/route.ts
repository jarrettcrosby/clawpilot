import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import {
  SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID,
} from '@/lib/integrations/shopifyReversalFixtureRuntime'
import {
  approveShopifyReversalFixtureCommand,
  readShopifyReversalFixtureApprovalIntent,
} from '@/lib/operations/shopifyReversalFixtureCommands'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { appPublicUrl } from '@/lib/publicUrl'
import {
  requireRequestSession,
  requireRequestUserForWorkspace,
} from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  Vary: 'Cookie',
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function html(title: string, content: string, status = 200) {
  return new NextResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:4rem auto;padding:0 1.25rem;color:#171717}code,input,button{font:inherit}code{overflow-wrap:anywhere}label{display:block;margin:1.5rem 0 .4rem}input{box-sizing:border-box;width:100%;padding:.7rem}button{margin-top:1rem;padding:.7rem 1rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem}dt{font-weight:600}dd{margin:0}</style></head><body>${content}</body></html>`, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
    },
  })
}

function safeError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : ''
  const status = error && typeof error === 'object' && 'status' in error
    ? Number(error.status)
    : 500
  const message = error instanceof Error ? error.message : ''
  if (/^SHOPIFY_REVERSAL_FIXTURE_[A-Z0-9_]{1,96}$/u.test(code)) {
    return {
      code,
      status: Number.isInteger(status) && status >= 400 && status <= 599
        ? status
        : 500,
      message: message && message.length <= 500
        ? message
        : 'Fixture approval failed',
    }
  }
  if (message === 'Unauthorized') {
    return { code: 'UNAUTHORIZED', status: 401, message: 'Unauthorized' }
  }
  return {
    code: 'SHOPIFY_REVERSAL_FIXTURE_APPROVAL_FAILED',
    status: 500,
    message: 'Fixture approval failed',
  }
}

async function authenticatedApprover(req: NextRequest) {
  const session = await requireRequestSession(req)
  const actor = await requireRequestUserForWorkspace(
    req,
    SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID,
  )
  const role = effectiveAuthorizationRole(actor)
  if (
    session.legacy === true
    || !['magic_code', 'google_sso', 'operator_password'].includes(
      session.authMethod,
    )
    || session.impersonating
    || session.impersonationStartedAt !== null
    || session.impersonationExpiresAt !== null
    || session.authenticatedUser !== session.effectiveUser
    || session.authenticatedUser !== actor.email
    || session.activeWorkspaceOrganizationId
      !== SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID
    || session.activeWorkspaceRole !== role
    || (role !== 'owner' && role !== 'admin')
  ) {
    const error = new Error(
      'A non-impersonated owner or administrator session in the exact fixture workspace is required',
    ) as Error & { code: string; status: number }
    error.code = 'SHOPIFY_REVERSAL_FIXTURE_APPROVAL_SESSION_REQUIRED'
    error.status = 403
    throw error
  }
  return { session, actor }
}

function assertSameOrigin(req: NextRequest) {
  if (!isBrowserSameOriginRequest({
    headers: req.headers,
    requestOrigin: req.nextUrl.origin,
    trustedOrigins: [appPublicUrl()],
  })) {
    const error = new Error(
      'Fixture approval requires a same-origin ClawPilot browser request',
    ) as Error & { code: string; status: number }
    error.code = 'SHOPIFY_REVERSAL_FIXTURE_APPROVAL_SAME_ORIGIN_REQUIRED'
    error.status = 403
    throw error
  }
}

function assertPostgresStorage() {
  if (!isPostgresStorageEnabled()) {
    const error = new Error(
      'Shopify test fixture approval requires Postgres storage',
    ) as Error & { code: string; status: number }
    error.code = 'SHOPIFY_REVERSAL_FIXTURE_POSTGRES_REQUIRED'
    error.status = 409
    throw error
  }
}

function approvalForm(input: {
  commandGlobalId: string
  phase: string
  intentHash: string
  confirmationStatement: string
  expiresAt: string
}) {
  return `<h1>Approve Shopify test fixture</h1>
<dl><dt>Command</dt><dd><code>${escapeHtml(input.commandGlobalId)}</code></dd><dt>Action</dt><dd>${escapeHtml(input.phase)}</dd><dt>Expires</dt><dd>${escapeHtml(input.expiresAt)}</dd><dt>Intent</dt><dd><code>${escapeHtml(input.intentHash)}</code></dd></dl>
<form method="post" autocomplete="off">
<input type="hidden" name="commandGlobalId" value="${escapeHtml(input.commandGlobalId)}">
<input type="hidden" name="intentHash" value="${escapeHtml(input.intentHash)}">
<label for="confirmationStatement">Type <code>${escapeHtml(input.confirmationStatement)}</code></label>
<input id="confirmationStatement" name="confirmationStatement" required pattern="${escapeHtml(input.confirmationStatement)}" spellcheck="false">
<button type="submit">Approve once</button>
</form>`
}

export async function GET(req: NextRequest) {
  try {
    const { actor } = await authenticatedApprover(req)
    assertPostgresStorage()
    const commandGlobalId = req.nextUrl.searchParams.get('command')
    if (!commandGlobalId || req.nextUrl.searchParams.size !== 1) {
      return html('Invalid fixture approval', '<h1>Invalid fixture approval</h1><p>An exact command is required.</p>', 400)
    }
    const intent = await readShopifyReversalFixtureApprovalIntent({
      organizationId: SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID,
      actorEmail: actor.email,
      commandGlobalId,
    })
    return html('Approve Shopify test fixture', approvalForm(intent))
  } catch (error) {
    const safe = safeError(error)
    return html(
      'Fixture approval failed',
      `<h1>Fixture approval failed</h1><p>${escapeHtml(safe.message)}</p><p><code>${escapeHtml(safe.code)}</code></p>`,
      safe.status,
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req)
    const contentType = String(req.headers.get('content-type') || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase()
    const contentLength = Number(req.headers.get('content-length') || '0')
    if (
      contentType !== 'application/x-www-form-urlencoded'
      || !Number.isSafeInteger(contentLength)
      || contentLength < 1
      || contentLength > 4096
    ) {
      return html('Invalid fixture approval', '<h1>Invalid fixture approval</h1><p>The exact approval form is required.</p>', 400)
    }
    const raw = await req.text()
    if (Buffer.byteLength(raw, 'utf8') > 4096) {
      return html('Invalid fixture approval', '<h1>Invalid fixture approval</h1><p>The approval form is too large.</p>', 413)
    }
    const form = new URLSearchParams(raw)
    const keys = [...form.keys()].sort()
    if (
      JSON.stringify(keys) !== JSON.stringify([
        'commandGlobalId',
        'confirmationStatement',
        'intentHash',
      ])
      || keys.some((key) => form.getAll(key).length !== 1)
    ) {
      return html('Invalid fixture approval', '<h1>Invalid fixture approval</h1><p>The exact approval fields are required.</p>', 400)
    }
    const { session, actor } = await authenticatedApprover(req)
    assertPostgresStorage()
    const result = await approveShopifyReversalFixtureCommand({
      organizationId: SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID,
      actorEmail: actor.email,
      browserSessionId: session.id,
      commandGlobalId: form.get('commandGlobalId'),
      intentHash: form.get('intentHash'),
      confirmationStatement: form.get('confirmationStatement'),
    })
    return html(
      'Shopify test fixture approved',
      `<h1>Approved once</h1><p>Command <code>${escapeHtml(result.commandGlobalId)}</code> is approved for the exact unexpired intent. Return to the command runner to execute it.</p>`,
    )
  } catch (error) {
    const safe = safeError(error)
    return html(
      'Fixture approval failed',
      `<h1>Fixture approval failed</h1><p>${escapeHtml(safe.message)}</p><p><code>${escapeHtml(safe.code)}</code></p>`,
      safe.status,
    )
  }
}
