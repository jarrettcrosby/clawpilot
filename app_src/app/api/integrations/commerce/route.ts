import { NextRequest, NextResponse } from 'next/server'
import {
  connectFaireCommerce,
  connectShopifyCommerce,
  CommerceIntegrationRequestError,
  createCommerceIntegrationsStateProjector,
  disconnectCommerceIntegration,
  faireOAuthCallbackUrl,
  getCommerceIntegrationsState,
  revealCommerceCredential,
  registerShopifyCatalogWebhookSubscriptions,
  registerShopifyInventoryWebhookSubscriptions,
  registerShopifyScopeWebhookSubscriptions,
  sanitizedCommerceIntegrationError,
  setCommerceIntegrationEnabled,
  setShopifyFulfillmentNotificationPolicy,
  startFaireOAuthCommerce,
  testCommerceConnection,
} from '@/lib/integrations/commerceIntegrations'
import {
  commerceIntakeRuntimeAvailable,
  commerceReadRuntimeAvailable,
} from '@/lib/integrations/commerceIntake'
import {
  CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION,
  CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION,
  COMMERCE_CUSTOM_INTEGRATION_ONBOARDING,
  COMMERCE_CAPABILITY_DEFINITIONS,
  FAIRE_CAPABILITY_SCOPES,
  FAIRE_PROVIDER_AVAILABLE_CAPABILITIES,
  SHOPIFY_ADMIN_API_VERSION,
  SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
  SHOPIFY_CAPABILITY_SCOPES,
  SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS,
  SHOPIFY_PROVIDER_AVAILABLE_CAPABILITIES,
  SHOPIFY_RESTRICTED_ACCESS_SCOPES,
} from '@/lib/integrations/commerceCapabilities'
import {
  FAIRE_API_SCOPES,
  FAIRE_COMMERCE_CAPABILITIES,
} from '@/lib/integrations/faireCommerceClient'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestSession, requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole, type AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 32 * 1024

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
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  const sanitized = sanitizedCommerceIntegrationError(error)
  return json(
    { ok: false, error: sanitized.message, code: sanitized.code },
    sanitized.status,
  )
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CommerceIntegrationRequestError(
      'Sales-channel integrations require Postgres storage',
      503,
      'COMMERCE_POSTGRES_REQUIRED',
    )
  }
}

type CommerceMutationState = Parameters<
  ReturnType<typeof createCommerceIntegrationsStateProjector>
>[0]

async function commerceMutationIntegrations(
  mutation: () => Promise<CommerceMutationState>,
) {
  const project = createCommerceIntegrationsStateProjector()
  return project(await mutation())
}

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new CommerceIntegrationRequestError(
      'Your organization is not configured',
      409,
      'COMMERCE_ORGANIZATION_REQUIRED',
    )
  }
  return actor.organizationId
}

function requireManager(actor: AppUser) {
  if (!operationsCapabilities(actor).canManage) {
    throw new CommerceIntegrationRequestError(
      'Operations-management permission is required to manage sales channels',
      403,
      'COMMERCE_MANAGER_REQUIRED',
    )
  }
}

function requireActivator(actor: AppUser) {
  if (!operationsCapabilities(actor).canActivate) {
    throw new CommerceIntegrationRequestError(
      'Owner or operations-administrator access is required to queue signed receipts for intake',
      403,
      'COMMERCE_ACTIVATOR_REQUIRED',
    )
  }
}

function canRevealCredential(actor: AppUser) {
  const role = effectiveAuthorizationRole(actor)
  return role === 'owner' || role === 'admin'
}

function requireCredentialViewer(actor: AppUser) {
  if (!canRevealCredential(actor)) {
    throw new CommerceIntegrationRequestError(
      'Organization owner or administrator access is required to reveal sales-channel credentials',
      403,
      'COMMERCE_CREDENTIAL_REVEAL_FORBIDDEN',
    )
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CommerceIntegrationRequestError(
      'Sales-channel integration request is too large',
      413,
      'COMMERCE_REQUEST_TOO_LARGE',
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
        throw new CommerceIntegrationRequestError(
          'Sales-channel integration request is too large',
          413,
          'COMMERCE_REQUEST_TOO_LARGE',
        )
      }
      chunks.push(value)
    }
  }
  const raw = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length,
  ).toString('utf8')
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object')
    }
    return value as Record<string, unknown>
  } catch {
    throw new CommerceIntegrationRequestError(
      'Request body must be a JSON object',
      400,
      'COMMERCE_REQUEST_INVALID',
    )
  }
}

function only(body: Record<string, unknown>, fields: string[]) {
  const unsupported = Object.keys(body).find(
    (field) => !fields.includes(field),
  )
  if (unsupported) {
    throw new CommerceIntegrationRequestError(
      `Unsupported sales-channel action field: ${unsupported}`,
      400,
      'COMMERCE_REQUEST_INVALID',
    )
  }
}

function capabilityCatalog() {
  return {
    classification: 'commerce_sales_channels',
    onboarding: {
      ...COMMERCE_CUSTOM_INTEGRATION_ONBOARDING,
      faire: {
        ...COMMERCE_CUSTOM_INTEGRATION_ONBOARDING.faire,
        callbackUrl: faireOAuthCallbackUrl(),
      },
    },
    definitions: COMMERCE_CAPABILITY_DEFINITIONS,
    providers: {
      shopify: {
        label: 'Shopify',
        classification: 'commerce_platform_sales_channel',
        apiVersion: SHOPIFY_ADMIN_API_VERSION,
        environmentSupport: ['sandbox', 'production'],
        environmentNote:
          'Sandbox denotes a Shopify development or test store; Shopify uses the same Admin API host model.',
        providerAvailableCapabilities:
          SHOPIFY_PROVIDER_AVAILABLE_CAPABILITIES,
        implementation: CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION,
        capabilityScopes: SHOPIFY_CAPABILITY_SCOPES,
        providerScopes: SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
        restrictedScopes: SHOPIFY_RESTRICTED_ACCESS_SCOPES,
        constraints: {
          acceptedReceiptTopics: SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS,
          customerAndOrderTopics: false,
          payloadRetentionLifecycle: false,
          heldOrderPreview: {
            mode: 'development_read_only_diagnostic',
            requiredScope: 'read_orders',
            sandboxOnly: true,
            maxOrders: 25,
            maxLinesPerOrder: 20,
            retentionHours: 24,
            rawPayloadStored: false,
            directCustomerFieldsStored: false,
            canonicalOrderImport: false,
            shopifyWrites: false,
            syncCursorAdvancement: false,
          },
        },
      },
      faire: {
        label: 'Faire',
        classification: FAIRE_COMMERCE_CAPABILITIES.classification,
        apiVersion: 'external-api-v2',
        environmentSupport: ['production'],
        environmentNote: 'Faire does not publish a sandbox environment.',
        providerAvailableCapabilities: FAIRE_PROVIDER_AVAILABLE_CAPABILITIES,
        implementation: CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION,
        capabilityScopes: FAIRE_CAPABILITY_SCOPES,
        providerScopes: FAIRE_API_SCOPES,
        constraints: {
          webhooks: false,
          returnWrites: false,
          retailerCustomApi: false,
          inventoryReadMode: 'selector_only',
        },
      },
    },
    activationBoundary: {
      receiptIntakeOnly: true,
      domainWorkersActivated: false,
      readReconciliationWorkersActivated: commerceReadRuntimeAvailable(),
      canonicalOrderImport: commerceIntakeRuntimeAvailable(),
      inventoryMutation: false,
      fulfillmentExport: false,
      multiMerchantOauth: false,
      faireBrandApiKey: true,
      faireCustomAppOauth: true,
    },
  }
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    requireManager(actor)
    const capabilities = operationsCapabilities(actor)
    return json({
      ok: true,
      canManage: true,
      canActivate: capabilities.canActivate,
      canRevealCredentials: canRevealCredential(actor),
      intakeAvailable: commerceIntakeRuntimeAvailable(),
      reconciliationAvailable: commerceReadRuntimeAvailable(),
      integrations: await getCommerceIntegrationsState(
        organizationId(actor),
      ),
      catalog: capabilityCatalog(),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    requireManager(actor)
    const organization = organizationId(actor)
    const body = await requestBody(req)
    const action = String(body.action || '').trim()

    if (action === 'reveal-credential') {
      only(body, ['action', 'accountGlobalId'])
      requireCredentialViewer(actor)
      const credential = await revealCommerceCredential({
        organizationId: organization,
        accountGlobalId: body.accountGlobalId,
        actorEmail: actor.email,
      })
      return json({
        ok: true,
        canManage: true,
        canActivate: operationsCapabilities(actor).canActivate,
        canRevealCredentials: true,
        credential,
      })
    }

    if (action === 'connect-shopify') {
      only(body, [
        'action',
        'environment',
        'displayName',
        'shopDomain',
        'clientId',
        'clientSecret',
        'confirmLiveAccess',
      ])
      if (body.confirmLiveAccess !== true) {
        throw new CommerceIntegrationRequestError(
          'Confirm that ClawPilot may verify this Shopify credential',
          400,
          'COMMERCE_LIVE_ACCESS_CONFIRMATION_REQUIRED',
        )
      }
      const integrations = await commerceMutationIntegrations(
        () => connectShopifyCommerce({
          organizationId: organization,
          environment: body.environment,
          displayName: body.displayName,
          shopDomain: body.shopDomain,
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          actorEmail: actor.email,
        }),
      )
      return json({
        ok: true,
        canManage: true,
        canActivate: operationsCapabilities(actor).canActivate,
        integrations,
        catalog: capabilityCatalog(),
      })
    }

    if (action === 'register-shopify-inventory-webhooks') {
      only(body, ['action', 'accountGlobalId', 'confirmProviderWrites'])
      requireActivator(actor)
      if (body.confirmProviderWrites !== true) {
        throw new CommerceIntegrationRequestError(
          'Confirm the exact Shopify inventory webhook registrations',
          400,
          'COMMERCE_PROVIDER_WRITE_CONFIRMATION_REQUIRED',
        )
      }
      const integrations = await commerceMutationIntegrations(
        () => registerShopifyInventoryWebhookSubscriptions({
          organizationId: organization,
          accountGlobalId: body.accountGlobalId,
          actorEmail: actor.email,
        }),
      )
      return json({
        ok: true,
        canManage: true,
        canActivate: true,
        integrations,
        catalog: capabilityCatalog(),
      })
    }

    if (action === 'register-shopify-scope-webhooks') {
      only(body, ['action', 'accountGlobalId', 'confirmProviderWrites'])
      requireActivator(actor)
      if (body.confirmProviderWrites !== true) {
        throw new CommerceIntegrationRequestError(
          'Confirm the exact Shopify access-scope safety webhook registration',
          400,
          'COMMERCE_PROVIDER_WRITE_CONFIRMATION_REQUIRED',
        )
      }
      const integrations = await commerceMutationIntegrations(
        () => registerShopifyScopeWebhookSubscriptions({
          organizationId: organization,
          accountGlobalId: body.accountGlobalId,
          actorEmail: actor.email,
        }),
      )
      return json({
        ok: true,
        canManage: true,
        canActivate: true,
        integrations,
        catalog: capabilityCatalog(),
      })
    }

    if (action === 'register-shopify-catalog-webhooks') {
      only(body, ['action', 'accountGlobalId', 'confirmProviderWrites'])
      requireActivator(actor)
      if (body.confirmProviderWrites !== true) {
        throw new CommerceIntegrationRequestError(
          'Confirm the exact Shopify catalog webhook registrations',
          400,
          'COMMERCE_PROVIDER_WRITE_CONFIRMATION_REQUIRED',
        )
      }
      const integrations = await commerceMutationIntegrations(
        () => registerShopifyCatalogWebhookSubscriptions({
          organizationId: organization,
          accountGlobalId: body.accountGlobalId,
          actorEmail: actor.email,
        }),
      )
      return json({
        ok: true,
        canManage: true,
        canActivate: true,
        integrations,
        catalog: capabilityCatalog(),
      })
    }

    if (action === 'start-faire-oauth') {
      only(body, [
        'action',
        'displayName',
        'applicationId',
        'applicationSecret',
        'scopeProfile',
        'confirmLiveAccess',
      ])
      if (body.confirmLiveAccess !== true) {
        throw new CommerceIntegrationRequestError(
          'Confirm that ClawPilot may redirect to Faire, exchange the authorization code, and verify the production brand profile',
          400,
          'COMMERCE_LIVE_ACCESS_CONFIRMATION_REQUIRED',
        )
      }
      const session = await requireRequestSession(req)
      const oauth = await startFaireOAuthCommerce({
        organizationId: organization,
        browserSessionId: session.id,
        actorEmail: actor.email,
        displayName: body.displayName,
        applicationId: body.applicationId,
        applicationSecret: body.applicationSecret,
        scopeProfile: body.scopeProfile,
      })
      return json({
        ok: true,
        ...oauth,
      })
    }

    if (action === 'connect-faire-api-key') {
      only(body, [
        'action',
        'displayName',
        'accessToken',
        'confirmLiveAccess',
      ])
      if (body.confirmLiveAccess !== true) {
        throw new CommerceIntegrationRequestError(
          'Confirm that ClawPilot may make one read-only Faire brand-profile request to verify this API key',
          400,
          'COMMERCE_LIVE_ACCESS_CONFIRMATION_REQUIRED',
        )
      }
      const integrations = await commerceMutationIntegrations(
        () => connectFaireCommerce({
          organizationId: organization,
          displayName: body.displayName,
          accessToken: body.accessToken,
          actorEmail: actor.email,
        }),
      )
      return json({
        ok: true,
        canManage: true,
        canActivate: operationsCapabilities(actor).canActivate,
        integrations,
        catalog: capabilityCatalog(),
      })
    }

    if (action === 'test-connection') {
      only(body, ['action', 'accountGlobalId'])
      const integrations = await commerceMutationIntegrations(
        () => testCommerceConnection({
          organizationId: organization,
          accountGlobalId: body.accountGlobalId,
          actorEmail: actor.email,
        }),
      )
      return json({
        ok: true,
        canManage: true,
        canActivate: operationsCapabilities(actor).canActivate,
        integrations,
        catalog: capabilityCatalog(),
      })
    }

    if (
      action === 'set-receipt-intake'
      || action === 'set-enabled'
    ) {
      only(body, ['action', 'accountGlobalId', 'enabled'])
      if (body.enabled === true) requireActivator(actor)
      const integrations = await commerceMutationIntegrations(
        () => setCommerceIntegrationEnabled({
          organizationId: organization,
          accountGlobalId: body.accountGlobalId,
          enabled: body.enabled,
          actorEmail: actor.email,
        }),
      )
      return json({
        ok: true,
        canManage: true,
        canActivate: operationsCapabilities(actor).canActivate,
        integrations,
        catalog: capabilityCatalog(),
      })
    }

    if (action === 'set-shopify-fulfillment-notification-policy') {
      only(body, [
        'action',
        'accountGlobalId',
        'expectedRevision',
        'notifyCustomerDefault',
        'reason',
        'confirmCustomerNotifications',
      ])
      requireActivator(actor)
      const integrations = await commerceMutationIntegrations(
        () => setShopifyFulfillmentNotificationPolicy({
          organizationId: organization,
          accountGlobalId: body.accountGlobalId,
          expectedRevision: body.expectedRevision,
          notifyCustomerDefault: body.notifyCustomerDefault,
          reason: body.reason,
          confirmCustomerNotifications: body.confirmCustomerNotifications,
          actorEmail: actor.email,
        }),
      )
      return json({
        ok: true,
        canManage: true,
        canActivate: true,
        canRevealCredentials: canRevealCredential(actor),
        integrations,
        catalog: capabilityCatalog(),
      })
    }

    if (action === 'disconnect') {
      only(body, ['action', 'accountGlobalId'])
      const integrations = await commerceMutationIntegrations(
        () => disconnectCommerceIntegration({
          organizationId: organization,
          accountGlobalId: body.accountGlobalId,
          actorEmail: actor.email,
        }),
      )
      return json({
        ok: true,
        canManage: true,
        canActivate: operationsCapabilities(actor).canActivate,
        integrations,
        catalog: capabilityCatalog(),
      })
    }

    throw new CommerceIntegrationRequestError(
      'Unsupported sales-channel integration action',
      400,
      'COMMERCE_ACTION_UNSUPPORTED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}
