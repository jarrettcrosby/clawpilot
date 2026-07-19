import {
  authenticateToast,
  getToastMenuCatalogV2,
  getToastStandardRestaurant,
  listToastAnalyticsRestaurants,
  normalizeToastApiBaseUrl,
  normalizeToastClientId,
  normalizeToastRestaurantGuid,
  ToastClientError,
  type ToastRuntimeCredential,
} from '@/lib/integrations/toastClient'
import {
  decryptToastClientSecret,
  encryptToastClientSecret,
  normalizeToastAccessType,
  normalizeToastClientSecret,
  normalizeToastOrganizationId,
  type ToastAccessType,
} from '@/lib/integrations/toastCredentialCrypto'
import {
  deleteToastCredentialInPostgres,
  markToastCredentialVerifiedInPostgres,
  queueToastSyncForDateInPostgres,
  readToastIntegrationStateFromPostgres,
  readToastRuntimeCredentialFromPostgres,
  replaceToastAnalyticsLocationsInPostgres,
  setToastLocationSelectedInPostgres,
  setToastSyncEnabledInPostgres,
  upsertToastStandardLocationInPostgres,
  writeToastCredentialInPostgres,
} from '@/lib/persistence/toastIntegrations'
import {
  readPosCatalogFromPostgres,
  readToastCatalogRefreshTargetsInPostgres,
  recordToastMenuCatalogCheckInPostgres,
  recordToastMenuCatalogErrorInPostgres,
  recordToastMenuCatalogUnavailableInPostgres,
  replaceToastMenuCatalogInPostgres,
} from '@/lib/persistence/posCatalog'

export class ToastIntegrationRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status = 400, code = 'TOAST_REQUEST_INVALID') {
    super(message)
    this.name = 'ToastIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

function normalizedBusinessDate(value: unknown) {
  const raw = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ToastIntegrationRequestError('Business date must use YYYY-MM-DD', 400, 'TOAST_DATE_INVALID')
  }
  const date = new Date(`${raw}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new ToastIntegrationRequestError('Business date is invalid', 400, 'TOAST_DATE_INVALID')
  }
  const today = new Date().toISOString().slice(0, 10)
  if (raw > today) throw new ToastIntegrationRequestError('Business date cannot be in the future', 400, 'TOAST_DATE_INVALID')
  return raw
}

function sanitizeError(error: unknown): ToastIntegrationRequestError {
  if (error instanceof ToastIntegrationRequestError) return error
  if (error instanceof ToastClientError) {
    return new ToastIntegrationRequestError(error.message, error.status, error.code)
  }
  const message = error instanceof Error ? error.message : ''
  if (message === 'Toast credential encryption is not configured') {
    return new ToastIntegrationRequestError(message, 503, 'TOAST_ENCRYPTION_UNAVAILABLE')
  }
  if (message === 'Stored Toast credential could not be decrypted') {
    return new ToastIntegrationRequestError(message, 500, 'TOAST_CREDENTIAL_INVALID')
  }
  return new ToastIntegrationRequestError('Toast integration request failed', 500, 'TOAST_INTERNAL_ERROR')
}

export function sanitizedToastIntegrationError(error: unknown) {
  return sanitizeError(error)
}

async function runtimeCredential(organizationIdValue: unknown, accessTypeValue: unknown): Promise<ToastRuntimeCredential> {
  const organizationId = normalizeToastOrganizationId(organizationIdValue)
  const accessType = normalizeToastAccessType(accessTypeValue)
  const stored = await readToastRuntimeCredentialFromPostgres(organizationId, accessType)
  if (!stored) {
    throw new ToastIntegrationRequestError(
      `Toast ${accessType} credentials are not configured`,
      409,
      'TOAST_CREDENTIAL_REQUIRED',
    )
  }
  return {
    accessType,
    apiBaseUrl: stored.apiBaseUrl,
    clientId: stored.clientId,
    clientSecret: decryptToastClientSecret(stored.secret, organizationId, accessType),
  }
}

async function verifyCredential(credential: ToastRuntimeCredential) {
  if (credential.accessType === 'analytics') {
    await listToastAnalyticsRestaurants(credential)
  } else {
    await authenticateToast(credential)
  }
}

export async function getToastIntegrationState(organizationIdValue: unknown) {
  return readToastIntegrationStateFromPostgres(normalizeToastOrganizationId(organizationIdValue))
}

export async function updateToastCredential(input: {
  organizationId: unknown
  accessType: unknown
  apiBaseUrl: unknown
  clientId: unknown
  clientSecret: unknown
  actorEmail: string
}) {
  try {
    const organizationId = normalizeToastOrganizationId(input.organizationId)
    const accessType = normalizeToastAccessType(input.accessType)
    const apiBaseUrl = normalizeToastApiBaseUrl(input.apiBaseUrl)
    const clientId = normalizeToastClientId(input.clientId)
    const clientSecret = normalizeToastClientSecret(input.clientSecret)
    const candidate: ToastRuntimeCredential = { accessType, apiBaseUrl, clientId, clientSecret }
    await verifyCredential(candidate)
    const encrypted = encryptToastClientSecret(clientSecret, organizationId, accessType)
    return writeToastCredentialInPostgres({
      organizationId,
      accessType,
      apiBaseUrl,
      clientId,
      clientSecret: { ...encrypted, lastFour: clientSecret.slice(-4) },
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitizeError(error)
  }
}

export async function testToastCredential(input: {
  organizationId: unknown
  accessType: unknown
}) {
  const organizationId = normalizeToastOrganizationId(input.organizationId)
  const accessType = normalizeToastAccessType(input.accessType)
  try {
    await verifyCredential(await runtimeCredential(organizationId, accessType))
    await markToastCredentialVerifiedInPostgres({ organizationId, accessType, errorCode: null })
    return readToastIntegrationStateFromPostgres(organizationId)
  } catch (error) {
    const sanitized = sanitizeError(error)
    await markToastCredentialVerifiedInPostgres({ organizationId, accessType, errorCode: sanitized.code }).catch(() => undefined)
    throw sanitized
  }
}

export async function refreshToastAnalyticsLocations(input: {
  organizationId: unknown
  actorEmail: string
}) {
  const organizationId = normalizeToastOrganizationId(input.organizationId)
  try {
    const locations = await listToastAnalyticsRestaurants(await runtimeCredential(organizationId, 'analytics'))
    await markToastCredentialVerifiedInPostgres({ organizationId, accessType: 'analytics', errorCode: null })
    return replaceToastAnalyticsLocationsInPostgres({ organizationId, locations, actorEmail: input.actorEmail })
  } catch (error) {
    const sanitized = sanitizeError(error)
    await markToastCredentialVerifiedInPostgres({ organizationId, accessType: 'analytics', errorCode: sanitized.code }).catch(() => undefined)
    throw sanitized
  }
}

export async function verifyToastStandardLocation(input: {
  organizationId: unknown
  restaurantGuid: unknown
  actorEmail: string
}) {
  const organizationId = normalizeToastOrganizationId(input.organizationId)
  try {
    const location = await getToastStandardRestaurant(
      await runtimeCredential(organizationId, 'standard'),
      normalizeToastRestaurantGuid(input.restaurantGuid),
    )
    await markToastCredentialVerifiedInPostgres({ organizationId, accessType: 'standard', errorCode: null })
    return upsertToastStandardLocationInPostgres({ organizationId, location, actorEmail: input.actorEmail })
  } catch (error) {
    const sanitized = sanitizeError(error)
    await markToastCredentialVerifiedInPostgres({ organizationId, accessType: 'standard', errorCode: sanitized.code }).catch(() => undefined)
    throw sanitized
  }
}

export async function selectToastLocation(input: {
  organizationId: unknown
  restaurantGuid: unknown
  selected: unknown
  actorEmail: string
}) {
  try {
    return setToastLocationSelectedInPostgres({
      organizationId: normalizeToastOrganizationId(input.organizationId),
      restaurantGuid: normalizeToastRestaurantGuid(input.restaurantGuid),
      selected: input.selected === true,
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitizeError(error)
  }
}

export async function configureToastAutomaticSync(input: {
  organizationId: unknown
  enabled: unknown
  actorEmail: string
}) {
  try {
    return setToastSyncEnabledInPostgres({
      organizationId: normalizeToastOrganizationId(input.organizationId),
      enabled: input.enabled === true,
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitizeError(error)
  }
}

export async function queueToastSync(input: {
  organizationId: unknown
  businessDate: unknown
  actorEmail: string
}) {
  try {
    const result = await queueToastSyncForDateInPostgres({
      organizationId: normalizeToastOrganizationId(input.organizationId),
      businessDate: normalizedBusinessDate(input.businessDate),
      actorEmail: input.actorEmail,
    })
    if (result.queued === 0) {
      throw new ToastIntegrationRequestError(
        'Select at least one verified Toast location before syncing',
        409,
        'TOAST_LOCATION_REQUIRED',
      )
    }
    return result
  } catch (error) {
    throw sanitizeError(error)
  }
}

export async function refreshToastMenuCatalog(input: {
  organizationId: unknown
  actorEmail: string
  force?: boolean
}) {
  const organizationId = normalizeToastOrganizationId(input.organizationId)
  try {
    const targets = await readToastCatalogRefreshTargetsInPostgres(organizationId)
    if (!targets.length) {
      throw new ToastIntegrationRequestError(
        'Select at least one verified Toast Standard location before refreshing the menu catalog',
        409,
        'TOAST_CATALOG_LOCATION_REQUIRED',
      )
    }
    const credential = await runtimeCredential(organizationId, 'standard')
    const locations: Array<Record<string, unknown>> = []
    for (const target of targets) {
      try {
        const source = await getToastMenuCatalogV2({
          credential,
          restaurantGuid: target.restaurantGuid,
          currentSourceRevision: target.sourceRevision,
          force: input.force === true,
        })
        if (source.status === 'updated') {
          const persisted = await replaceToastMenuCatalogInPostgres({
            organizationId,
            restaurantName: target.restaurantName,
            catalog: source.catalog,
          })
          locations.push({ restaurantGuid: target.restaurantGuid, ...persisted })
          continue
        }
        if (source.status === 'unchanged') {
          const checked = await recordToastMenuCatalogCheckInPostgres({
            organizationId,
            restaurantGuid: target.restaurantGuid,
            sourceRevision: source.metadata.sourceRevision,
          })
          locations.push({ restaurantGuid: target.restaurantGuid, ...checked })
          continue
        }
        const unavailable = await recordToastMenuCatalogUnavailableInPostgres({
          organizationId,
          restaurantGuid: target.restaurantGuid,
          sourceRevision: source.metadata?.sourceRevision || null,
          reason: source.reason,
          errorCode: source.errorCode,
        })
        locations.push({ restaurantGuid: target.restaurantGuid, ...unavailable })
      } catch (error) {
        const sanitized = sanitizeError(error)
        await recordToastMenuCatalogErrorInPostgres({
          organizationId,
          restaurantGuid: target.restaurantGuid,
          errorCode: sanitized.code,
        }).catch(() => undefined)
        locations.push({
          restaurantGuid: target.restaurantGuid,
          status: 'error',
          errorCode: sanitized.code,
        })
      }
    }
    return {
      refresh: { force: input.force === true, locations },
      catalog: await readPosCatalogFromPostgres(organizationId),
    }
  } catch (error) {
    throw sanitizeError(error)
  }
}

export async function disconnectToastCredential(input: {
  organizationId: unknown
  accessType: unknown
  actorEmail: string
}) {
  try {
    return deleteToastCredentialInPostgres({
      organizationId: normalizeToastOrganizationId(input.organizationId),
      accessType: normalizeToastAccessType(input.accessType),
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    throw sanitizeError(error)
  }
}

export type { ToastAccessType }
