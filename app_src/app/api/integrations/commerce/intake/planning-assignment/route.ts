import { NextRequest, NextResponse } from 'next/server'
import {
  inspectShopifyOrderPlanningAssignment,
  ShopifyOrderPlanningAuthorityError,
} from '@/lib/integrations/shopifyOrderPlanningAuthority'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_REQUEST_BYTES = 8 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new ShopifyOrderPlanningAuthorityError(
      'Your organization is not configured',
      409,
      'COMMERCE_ORGANIZATION_REQUIRED',
    )
  }
  return actor.organizationId
}

async function body(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ShopifyOrderPlanningAuthorityError(
      'Shopify planning-assignment request is too large',
      413,
      'SHOPIFY_ORDER_PLANNING_REQUEST_TOO_LARGE',
    )
  }
  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new ShopifyOrderPlanningAuthorityError(
      'Shopify planning-assignment request is too large',
      413,
      'SHOPIFY_ORDER_PLANNING_REQUEST_TOO_LARGE',
    )
  }
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new ShopifyOrderPlanningAuthorityError(
      'Shopify planning-assignment request must be a JSON object',
      400,
      'SHOPIFY_ORDER_PLANNING_REQUEST_INVALID',
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (!isPostgresStorageEnabled()) {
      throw new ShopifyOrderPlanningAuthorityError(
        'Shopify order planning requires Postgres storage',
        503,
        'SHOPIFY_ORDER_PLANNING_POSTGRES_REQUIRED',
      )
    }
    if (!operationsCapabilities(actor).canManage) {
      throw new ShopifyOrderPlanningAuthorityError(
        'Operations-management permission is required to inspect Shopify fulfillment routing',
        403,
        'SHOPIFY_ORDER_PLANNING_MANAGER_REQUIRED',
      )
    }
    const input = await body(req)
    if (input.action !== 'inspect') {
      throw new ShopifyOrderPlanningAuthorityError(
        'Shopify planning-assignment action is invalid',
        400,
        'SHOPIFY_ORDER_PLANNING_ACTION_INVALID',
      )
    }
    const assignment = await inspectShopifyOrderPlanningAssignment({
      organizationId: organizationId(actor),
      accountGlobalId: input.accountGlobalId,
      candidateGlobalId: input.candidateGlobalId,
      expectedCandidateRowVersion: input.expectedCandidateRowVersion,
    })
    return json({ ok: true, assignment })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json(
        { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
        401,
      )
    }
    if (error instanceof ShopifyOrderPlanningAuthorityError) {
      return json(
        { ok: false, error: error.message, code: error.code },
        error.status,
      )
    }
    return json(
      {
        ok: false,
        error: 'Shopify fulfillment routing could not be inspected',
        code: 'SHOPIFY_ORDER_PLANNING_INTERNAL_ERROR',
      },
      500,
    )
  }
}
