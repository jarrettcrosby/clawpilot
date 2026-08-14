import { NextRequest, NextResponse } from 'next/server'
import {
  CommerceIntegrationRequestError,
  receiveShopifyWebhook,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import {
  normalizeCommerceAccountGlobalId,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  isShopifyOrderSignalWebhookTopic,
  SHOPIFY_ORDER_SIGNAL_MAX_BYTES,
} from '@/lib/integrations/shopifyOrderWebhook'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_WEBHOOK_BYTES = 512 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function errorResponse(error: unknown) {
  const sanitized = sanitizedCommerceIntegrationError(error)
  return json(
    { ok: false, error: sanitized.message, code: sanitized.code },
    sanitized.status,
  )
}

async function boundedRequestBody(req: NextRequest, maximumBytes: number) {
  if (!req.body) return Buffer.alloc(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined)
      throw new CommerceIntegrationRequestError(
        'Shopify webhook payload is too large',
        413,
        'SHOPIFY_WEBHOOK_TOO_LARGE',
      )
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length)
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ accountGlobalId: string }> },
) {
  let accountGlobalId: string | null = null
  const topic = req.headers.get('x-shopify-topic')
  try {
    if (!isPostgresStorageEnabled()) {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook destination is unavailable',
        503,
        'SHOPIFY_WEBHOOK_UNAVAILABLE',
      )
    }
    const { accountGlobalId: rawAccountGlobalId } = await context.params
    try {
      accountGlobalId = normalizeCommerceAccountGlobalId(rawAccountGlobalId)
    } catch {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook destination is invalid',
        400,
        'SHOPIFY_WEBHOOK_DESTINATION_INVALID',
      )
    }
    const declaredLength = Number(req.headers.get('content-length') || 0)
    const maximumBytes = isShopifyOrderSignalWebhookTopic(topic)
      ? SHOPIFY_ORDER_SIGNAL_MAX_BYTES
      : MAX_WEBHOOK_BYTES
    if (
      Number.isFinite(declaredLength)
      && declaredLength > maximumBytes
    ) {
      throw new CommerceIntegrationRequestError(
        'Shopify webhook payload is too large',
        413,
        'SHOPIFY_WEBHOOK_TOO_LARGE',
      )
    }
    const bytes = await boundedRequestBody(req, maximumBytes)
    const result = await receiveShopifyWebhook({
      accountGlobalId,
      rawBody: bytes,
      hmac: req.headers.get('x-shopify-hmac-sha256'),
      providerEventId: req.headers.get('x-shopify-webhook-id'),
      topic: req.headers.get('x-shopify-topic'),
      sourceDomain: req.headers.get('x-shopify-shop-domain'),
      providerApiVersion: req.headers.get('x-shopify-api-version'),
      providerTriggeredAt: req.headers.get('x-shopify-triggered-at'),
    })
    console.info('[shopify-webhook-ingress]', JSON.stringify({
      ok: true,
      accountGlobalId,
      topic,
      duplicate: result.duplicate,
      payloadBytes: bytes.byteLength,
    }))
    return json({ ok: true, duplicate: result.duplicate })
  } catch (error) {
    const sanitized = sanitizedCommerceIntegrationError(error)
    console.warn('[shopify-webhook-ingress]', JSON.stringify({
      ok: false,
      accountGlobalId,
      topic,
      code: sanitized.code,
      status: sanitized.status,
    }))
    return errorResponse(error)
  }
}
