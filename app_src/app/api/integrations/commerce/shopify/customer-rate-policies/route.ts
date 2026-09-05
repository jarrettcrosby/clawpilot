import { NextRequest, NextResponse } from 'next/server'
import {
  decryptCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  normalizeShopifyShopDomain,
  requestShopifyAccessToken,
  sanitizedShopifyCommerceError,
  shopifyAdminGraphql,
  ShopifyCommerceClientError,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  maskShopifyCustomerEmailsInText,
  normalizeShopifyCustomerSearchQuery,
  SHOPIFY_SHADOW_POLICY_DEFAULT_DURATION_MINUTES,
  SHOPIFY_SHADOW_POLICY_DEFAULT_LIFETIME_MODE,
  SHOPIFY_SHADOW_POLICY_LIFETIME_MODES,
  SHOPIFY_SHADOW_POLICY_MAX_DURATION_MINUTES,
  SHOPIFY_SHADOW_POLICY_MIN_DURATION_MINUTES,
  searchShopifyCustomers,
  ShopifyCustomerRatePolicyError,
} from '@/lib/integrations/shopifyCustomerRatePolicy'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  integrationCredentialRuntimeMaintenanceResponse,
} from '@/lib/integrations/integrationCredentialRuntimeHttp'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  customerRatePolicyError,
  listShopifyCustomerRatePoliciesFromPostgres,
  readAvailableShopifyCheckoutServicesFromPostgres,
  readShopifyCustomerRatePolicyFromPostgres,
  readShopifyCustomerRatePolicySummaryFromPostgres,
  removeShopifyCustomerRatePolicyInPostgres,
  ShopifyCustomerRatePolicyPersistenceError,
  upsertShopifyCustomerRatePolicyInPostgres,
} from '@/lib/persistence/shopifyCustomerRatePolicies'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_REQUEST_BYTES = 32 * 1024
const CUSTOMER_SEARCH_TIMEOUT_MS = 10_000

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

function errorResponse(error: unknown) {
  const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
  if (maintenance) return maintenance
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  if (
    error instanceof ShopifyCustomerRatePolicyPersistenceError
    || error instanceof ShopifyCustomerRatePolicyError
  ) {
    return json(
      {
        ok: false,
        error: maskShopifyCustomerEmailsInText(error.message),
        code: error.code,
      },
      error.status,
    )
  }
  if (error instanceof ShopifyCommerceClientError) {
    const sanitized = sanitizedShopifyCommerceError(error)
    return json(
      {
        ok: false,
        error: maskShopifyCustomerEmailsInText(sanitized.message),
        code: sanitized.code,
      },
      sanitized.status,
    )
  }
  const sanitized = customerRatePolicyError(error)
  return json(
    {
      ok: false,
      error: maskShopifyCustomerEmailsInText(sanitized.message),
      code: sanitized.code,
    },
    sanitized.status,
  )
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_REQUEST_TOO_LARGE',
      'Shopify customer rate policy request is too large',
      413,
    )
  }
  const reader = req.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ShopifyCustomerRatePolicyPersistenceError(
          'SHOPIFY_CUSTOMER_POLICY_REQUEST_TOO_LARGE',
          'Shopify customer rate policy request is too large',
          413,
        )
      }
      chunks.push(value)
    }
  }
  try {
    const parsed = JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        length,
      ).toString('utf8'),
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_REQUEST_INVALID',
      'Shopify customer rate policy request must be a JSON object',
    )
  }
}

function only(body: Record<string, unknown>, allowedFields: string[]) {
  const unsupported = Object.keys(body).find(
    (field) => !allowedFields.includes(field),
  )
  if (unsupported) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_REQUEST_INVALID',
      'Shopify customer rate policy request includes an unsupported field',
    )
  }
}

function optionalInteger(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN
}

async function actorContext(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_POSTGRES_REQUIRED',
      'Shopify customer rate policies require Postgres storage',
      503,
    )
  }
  const actor = await requireRequestUser(req)
  if (!operationsCapabilities(actor).canManage) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_MANAGER_REQUIRED',
      'Operations-management permission is required',
      403,
    )
  }
  return {
    actor,
    organizationId: activeOperationsOrganizationId(actor),
  }
}

async function providerCustomerSearch(input: {
  organizationId: string
  accountGlobalId: string
  search: unknown
  cursor: unknown
  pageSize: number | undefined
}) {
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
  })
  if (!runtime || runtime.provider !== 'shopify') {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_CREDENTIAL_REQUIRED',
      'A configured Shopify connection is required to search customers',
      409,
    )
  }
  if (
    runtime.verificationStatus !== 'verified'
    || runtime.status === 'error'
  ) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_VERIFICATION_REQUIRED',
      'Verify the Shopify connection before searching customers',
      409,
    )
  }
  let storedCredential
  try {
    storedCredential = decryptCommerceCredential(
      runtime.encrypted,
      runtime.organizationId,
      runtime.provider,
      runtime.environment,
      runtime.externalAccountId,
    )
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_CREDENTIAL_INVALID',
      'Stored Shopify credentials are unavailable',
      500,
    )
  }
  if (
    storedCredential.provider !== 'shopify'
    || storedCredential.authMode !== 'shopify_client_credentials'
  ) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_CREDENTIAL_INVALID',
      'Stored Shopify credentials are unavailable',
      500,
    )
  }
  const shopDomain = normalizeShopifyShopDomain(
    runtime.configuration.shopDomain,
  )
  const grant = await requestShopifyAccessToken(
    {
      shopDomain,
      clientId: storedCredential.clientId,
      clientSecret: storedCredential.clientSecret,
    },
    { timeoutMs: CUSTOMER_SEARCH_TIMEOUT_MS },
  )
  return searchShopifyCustomers({
    credential: {
      shopDomain,
      accessToken: grant.accessToken,
    },
    grantedScopes: grant.grantedScopes,
    graphql: shopifyAdminGraphql,
    search: input.search,
    cursor: input.cursor,
    pageSize: input.pageSize,
    timeoutMs: CUSTOMER_SEARCH_TIMEOUT_MS,
  })
}

function safeCustomerSearchError(error: unknown) {
  if (isIntegrationCredentialRuntimeGateError(error)) throw error
  if (
    error instanceof ShopifyCustomerRatePolicyPersistenceError
    || error instanceof ShopifyCustomerRatePolicyError
  ) {
    return {
      code: error.code,
      message: maskShopifyCustomerEmailsInText(error.message),
    }
  }
  if (error instanceof ShopifyCommerceClientError) {
    const sanitized = sanitizedShopifyCommerceError(error)
    return {
      code: sanitized.code,
      message: maskShopifyCustomerEmailsInText(sanitized.message),
    }
  }
  return {
    code: 'SHOPIFY_CUSTOMER_SEARCH_UNAVAILABLE',
    message: 'Shopify customer search is unavailable',
  }
}

async function removePolicy(
  context: Awaited<ReturnType<typeof actorContext>>,
  body: Record<string, unknown>,
) {
  const result = await removeShopifyCustomerRatePolicyInPostgres({
    organizationId: context.organizationId,
    accountGlobalId: body.accountGlobalId,
    customerGid: body.customerGid,
    expectedRowVersion: body.expectedRowVersion,
    actorEmail: context.actor.email,
  })
  return json({ ok: true, ...result })
}

async function customerSearchResponse(
  context: Awaited<ReturnType<typeof actorContext>>,
  body: Record<string, unknown>,
) {
  only(body, [
    'action',
    'accountGlobalId',
    'search',
    'customerCursor',
    'customerPageSize',
  ])
  const normalizedSearch = normalizeShopifyCustomerSearchQuery(body.search)
  const maskedSearch = maskShopifyCustomerEmailsInText(normalizedSearch)
  if (!normalizedSearch) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_SEARCH_REQUIRED',
      'Enter a Shopify customer name, email, or Customer GID to search',
    )
  }
  try {
    const result = await providerCustomerSearch({
      organizationId: context.organizationId,
      accountGlobalId: String(body.accountGlobalId || ''),
      search: normalizedSearch,
      cursor: body.customerCursor,
      pageSize: optionalInteger(body.customerPageSize),
    })
    return json({
      ok: true,
      customers: result.customers,
      customerSearch: {
        available: true,
        queried: true,
        query: result.query,
        nextCursor: result.nextCursor,
        hasNextPage: result.hasNextPage,
        errorCode: null,
        error: null,
      },
    })
  } catch (error) {
    const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
    if (maintenance) return maintenance
    const safe = safeCustomerSearchError(error)
    return json({
      ok: true,
      customers: [],
      customerSearch: {
        available: false,
        queried: true,
        query: maskedSearch,
        nextCursor: null,
        hasNextPage: false,
        errorCode: safe.code,
        error: safe.message,
      },
    })
  }
}

export async function GET(req: NextRequest) {
  try {
    const context = await actorContext(req)
    const accountGlobalId = String(
      req.nextUrl.searchParams.get('accountGlobalId') || '',
    )
    const page = optionalInteger(req.nextUrl.searchParams.get('page'))
    const pageSize = optionalInteger(req.nextUrl.searchParams.get('pageSize'))
    const includeRemoved =
      req.nextUrl.searchParams.get('includeRemoved') === 'true'
    const customerGid = req.nextUrl.searchParams.get('customerGid')
    const [listed, summary, services, exactPolicy] = await Promise.all([
      listShopifyCustomerRatePoliciesFromPostgres({
        organizationId: context.organizationId,
        accountGlobalId,
        page,
        pageSize,
        includeRemoved,
      }),
      readShopifyCustomerRatePolicySummaryFromPostgres({
        organizationId: context.organizationId,
        accountGlobalId,
      }),
      readAvailableShopifyCheckoutServicesFromPostgres({
        organizationId: context.organizationId,
        accountGlobalId,
      }),
      customerGid !== null
        ? readShopifyCustomerRatePolicyFromPostgres({
            organizationId: context.organizationId,
            accountGlobalId,
            customerGid,
            includeRemoved,
          })
        : Promise.resolve(null),
    ])
    return json({
      ok: true,
      ...listed,
      summary: {
        policyCount: summary.policyCount,
        removedCount: summary.removedCount,
        simulatedCount: summary.simulatedCount,
        untilTurnedOffSimulatedCount:
          summary.untilTurnedOffSimulatedCount,
        expiredSimulatedCount: summary.expiredSimulatedCount,
        blockedCount: summary.blockedCount,
        enforcedCount: summary.enforcedCount,
        errorCount: summary.errorCount,
        earliestShadowExpiresAt: summary.earliestShadowExpiresAt,
      },
      shadowPolicyLimits: {
        defaultLifetimeMode: SHOPIFY_SHADOW_POLICY_DEFAULT_LIFETIME_MODE,
        supportedLifetimeModes: SHOPIFY_SHADOW_POLICY_LIFETIME_MODES,
        defaultDurationMinutes:
          SHOPIFY_SHADOW_POLICY_DEFAULT_DURATION_MINUTES,
        minimumDurationMinutes: SHOPIFY_SHADOW_POLICY_MIN_DURATION_MINUTES,
        maximumDurationMinutes: SHOPIFY_SHADOW_POLICY_MAX_DURATION_MINUTES,
      },
      availableServices: services.availableServices,
      availableServicesTruncated: services.availableServicesTruncated,
      ...(customerGid !== null ? { policy: exactPolicy } : {}),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const context = await actorContext(req)
    const body = await requestBody(req)
    const action = String(body.action || '').trim()
    if (action === 'search') return customerSearchResponse(context, body)
    if (action === 'upsert') {
      only(body, [
        'action',
        'accountGlobalId',
        'customerGid',
        'mode',
        'serviceCodes',
        'shadowLifetimeMode',
        'shadowDurationMinutes',
        'shadowTestChargeMode',
        'shadowTestServiceCode',
        'shadowTestSubsidyReason',
        'expectedRowVersion',
      ])
      const result = await upsertShopifyCustomerRatePolicyInPostgres({
        organizationId: context.organizationId,
        accountGlobalId: body.accountGlobalId,
        customerGid: body.customerGid,
        mode: body.mode,
        serviceCodes: body.serviceCodes,
        shadowLifetimeMode: body.shadowLifetimeMode,
        shadowDurationMinutes: body.shadowDurationMinutes,
        shadowTestChargeMode: body.shadowTestChargeMode,
        shadowTestServiceCode: body.shadowTestServiceCode,
        shadowTestSubsidyReason: body.shadowTestSubsidyReason,
        expectedRowVersion: body.expectedRowVersion,
        actorEmail: context.actor.email,
      })
      return json({ ok: true, ...result })
    }
    if (action === 'remove') {
      only(body, [
        'action',
        'accountGlobalId',
        'customerGid',
        'expectedRowVersion',
      ])
      return removePolicy(context, body)
    }
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_ACTION_INVALID',
      'Shopify customer rate policy action is invalid',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const context = await actorContext(req)
    const body = await requestBody(req)
    only(body, [
      'accountGlobalId',
      'customerGid',
      'expectedRowVersion',
    ])
    return removePolicy(context, body)
  } catch (error) {
    return errorResponse(error)
  }
}
