import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  shopifyReversalFixtureRuntime,
} from '@/lib/integrations/shopifyReversalFixtureRuntime'
import {
  executeShopifyReversalFixtureCommand,
  prepareShopifyReversalFixtureFulfillment,
  prepareShopifyReversalFixtureOrder,
  readShopifyReversalFixtureStatus,
  reconcileShopifyReversalFixtureCommand,
} from '@/lib/operations/shopifyReversalFixtureCommands'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'

export const runtime = 'nodejs'
export const maxDuration = 300

function authorized(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '')
    .replace(/^Bearer\s+/iu, '')
  if (expected.length < 32 || !provided) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function exactKeys(
  body: Record<string, unknown>,
  expected: readonly string[],
) {
  const supplied = Object.keys(body).sort()
  const allowed = [...expected].sort()
  return JSON.stringify(supplied) === JSON.stringify(allowed)
}

function safeError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : ''
  const exposesFixtureError = (
    /^SHOPIFY_REVERSAL_FIXTURE_[A-Z0-9_]{1,96}$/u.test(code)
  )
  const status = error && typeof error === 'object' && 'status' in error
    ? Number(error.status)
    : 500
  const message = error instanceof Error ? error.message : ''
  return {
    code: exposesFixtureError
      ? code
      : 'SHOPIFY_REVERSAL_FIXTURE_FAILED',
    status: exposesFixtureError
      && Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : 500,
    message: exposesFixtureError && message && message.length <= 500
      ? message
      : 'Shopify reversal fixture request failed',
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, {
      status: 401,
    })
  }
  const fixtureRuntime = shopifyReversalFixtureRuntime()
  if (!fixtureRuntime.available) {
    return NextResponse.json({
      ok: false,
      code: fixtureRuntime.blockerCode,
      error: 'Shopify reversal fixtures are unavailable in this runtime',
    }, { status: 403 })
  }
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json({
      ok: false,
      code: 'SHOPIFY_REVERSAL_FIXTURE_POSTGRES_REQUIRED',
      error: 'Shopify reversal fixtures require Postgres storage',
    }, { status: 409 })
  }
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({
      ok: false,
      code: 'SHOPIFY_REVERSAL_FIXTURE_REQUEST_INVALID',
      error: 'A fixed fixture command request is required',
    }, { status: 400 })
  }
  const input = body as Record<string, unknown>
  try {
    let result
    if (
      input.action === 'prepare_order'
      && exactKeys(input, [
        'action', 'organizationId', 'actorEmail', 'idempotencyKey',
      ])
    ) {
      result = await prepareShopifyReversalFixtureOrder({
        organizationId: input.organizationId,
        actorEmail: input.actorEmail,
        idempotencyKey: input.idempotencyKey,
      })
    } else if (
      input.action === 'prepare_fulfillment'
      && exactKeys(input, [
        'action', 'organizationId', 'actorEmail', 'idempotencyKey',
        'predecessorCommandGlobalId', 'orderGlobalId',
      ])
    ) {
      result = await prepareShopifyReversalFixtureFulfillment({
        organizationId: input.organizationId,
        actorEmail: input.actorEmail,
        idempotencyKey: input.idempotencyKey,
        predecessorCommandGlobalId: input.predecessorCommandGlobalId,
        orderGlobalId: input.orderGlobalId,
      })
    } else if (
      input.action === 'execute'
      && exactKeys(input, [
        'action', 'organizationId', 'actorEmail', 'commandGlobalId',
        'intentHash', 'confirmationStatement',
      ])
    ) {
      result = await executeShopifyReversalFixtureCommand({
        organizationId: input.organizationId,
        actorEmail: input.actorEmail,
        commandGlobalId: input.commandGlobalId,
        intentHash: input.intentHash,
        confirmationStatement: input.confirmationStatement,
      })
    } else if (
      input.action === 'reconcile'
      && exactKeys(input, [
        'action', 'organizationId', 'actorEmail', 'commandGlobalId',
      ])
    ) {
      result = await reconcileShopifyReversalFixtureCommand({
        organizationId: input.organizationId,
        actorEmail: input.actorEmail,
        commandGlobalId: input.commandGlobalId,
      })
    } else if (
      input.action === 'status'
      && exactKeys(input, [
        'action', 'organizationId', 'commandGlobalId',
      ])
    ) {
      result = await readShopifyReversalFixtureStatus({
        organizationId: input.organizationId,
        commandGlobalId: input.commandGlobalId,
      })
    } else {
      return NextResponse.json({
        ok: false,
        code: 'SHOPIFY_REVERSAL_FIXTURE_REQUEST_INVALID',
        error: 'Only the fixed prepare, execute, reconcile, and status shapes are accepted',
      }, { status: 400 })
    }
    return NextResponse.json({ ok: true, result }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const safe = safeError(error)
    return NextResponse.json({
      ok: false,
      code: safe.code,
      error: safe.message,
    }, {
      status: safe.status,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
