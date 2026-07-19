import { readQuickBooksCompanyInfo } from '@/lib/integrations/quickBooksClient'
import { resolveUserMatonGatewayCredential } from '@/lib/integrations/matonGatewayCredentials'
import { stageCrmRecordWithClient } from '@/lib/persistence/crm'
import { syncPipelineProductDropdownCatalogInPostgres } from '@/lib/persistence/pipeline'
import { withTransaction } from '@/lib/persistence/postgres'
import { configureQuickBooksCrmSyncInPostgres } from '@/lib/persistence/quickBooksCrmSync'
import {
  bindQuickBooksConnectionInPostgres,
  disconnectQuickBooksConnectionInPostgres,
  queueQuickBooksCatalogSyncInPostgres,
  readQuickBooksCachedItemsInPostgres,
  readQuickBooksIntegrationStateFromPostgres,
  setQuickBooksCatalogSyncEnabledInPostgres,
  updateQuickBooksMappingsInPostgres,
  type QuickBooksMappingKey,
} from '@/lib/persistence/quickBooksIntegrations'

export class QuickBooksIntegrationRequestError extends Error {
  status: number
  code: string

  constructor(message: string, status = 400, code = 'QUICKBOOKS_REQUEST_INVALID') {
    super(message)
    this.name = 'QuickBooksIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

function sanitizedError(error: unknown) {
  if (error instanceof QuickBooksIntegrationRequestError) return error
  const message = error instanceof Error ? error.message : ''
  if (/already bound/i.test(message)) {
    return new QuickBooksIntegrationRequestError(message, 409, 'QUICKBOOKS_COMPANY_ALREADY_BOUND')
  }
  if (/API key|required|connection|Maton/i.test(message)) {
    return new QuickBooksIntegrationRequestError(
      'Select an ACTIVE QuickBooks connection in Maton before connecting this organization',
      409,
      'QUICKBOOKS_MATON_CONNECTION_REQUIRED',
    )
  }
  return new QuickBooksIntegrationRequestError('QuickBooks integration request failed', 500, 'QUICKBOOKS_INTERNAL_ERROR')
}

export function sanitizeQuickBooksIntegrationError(error: unknown) {
  return sanitizedError(error)
}

export async function getQuickBooksIntegrationState(organizationId: string) {
  return readQuickBooksIntegrationStateFromPostgres(organizationId)
}

export async function bindSelectedQuickBooksConnection(input: {
  organizationId: string
  actorEmail: string
}) {
  try {
    const credential = await resolveUserMatonGatewayCredential({
      ownerEmail: input.actorEmail,
      app: 'quickbooks',
    })
    const company = await readQuickBooksCompanyInfo(input.actorEmail, credential.connectionId)
    await bindQuickBooksConnectionInPostgres({
      organizationId: input.organizationId,
      ownerEmail: input.actorEmail,
      connectionId: credential.connectionId,
      company,
      actorEmail: input.actorEmail,
    })
    await queueQuickBooksCatalogSyncInPostgres({ organizationId: input.organizationId, actorEmail: input.actorEmail })
    return readQuickBooksIntegrationStateFromPostgres(input.organizationId)
  } catch (error) {
    throw sanitizedError(error)
  }
}

export async function disconnectQuickBooksConnection(input: { organizationId: string; actorEmail: string }) {
  await disconnectQuickBooksConnectionInPostgres(input)
  return readQuickBooksIntegrationStateFromPostgres(input.organizationId)
}

export async function queueQuickBooksCatalogSync(input: { organizationId: string; actorEmail: string }) {
  await queueQuickBooksCatalogSyncInPostgres(input)
  return readQuickBooksIntegrationStateFromPostgres(input.organizationId)
}

export async function configureQuickBooksCatalogSync(input: {
  organizationId: string
  enabled: boolean
  actorEmail: string
}) {
  await setQuickBooksCatalogSyncEnabledInPostgres(input)
  return readQuickBooksIntegrationStateFromPostgres(input.organizationId)
}

export async function configureQuickBooksCrmSync(input: {
  organizationId: string
  pipelineId: string
  customerSyncEnabled: boolean
  productSyncEnabled: boolean
  actorEmail: string
}) {
  await configureQuickBooksCrmSyncInPostgres(input)
  return readQuickBooksIntegrationStateFromPostgres(input.organizationId)
}

export async function saveQuickBooksAccountMappings(input: {
  organizationId: string
  restaurantGuid: string
  mappings: Partial<Record<QuickBooksMappingKey, string | null>>
  actorEmail: string
}) {
  await updateQuickBooksMappingsInPostgres(input)
  return readQuickBooksIntegrationStateFromPostgres(input.organizationId)
}

export async function importQuickBooksProducts(input: {
  organizationId: string
  pipelineId: string
  itemIds: unknown
  actorEmail: string
}) {
  const itemIds = Array.isArray(input.itemIds)
    ? [...new Set(input.itemIds.map((value) => String(value || '').trim()).filter(Boolean))]
    : []
  if (itemIds.length === 0 || itemIds.length > 100) {
    throw new QuickBooksIntegrationRequestError('Select between 1 and 100 QuickBooks products or services')
  }
  const items = await readQuickBooksCachedItemsInPostgres({ organizationId: input.organizationId, itemIds })
  if (items.length !== itemIds.length) {
    throw new QuickBooksIntegrationRequestError('One or more QuickBooks catalog items are unavailable')
  }
  const eligible = items.filter((item) => item.active && item.itemType.toLowerCase() !== 'category')
  if (!eligible.length) throw new QuickBooksIntegrationRequestError('Select at least one active product or service')

  const result = await withTransaction(async (client) => {
    const existing = await client.query<{ source_key: string; normalized_name: string }>(
      `SELECT source_key, lower(name) AS normalized_name FROM crm_products WHERE pipeline_id = $1::uuid`,
      [input.pipelineId],
    )
    const byName = new Map(existing.rows.map((row) => [row.normalized_name, row.source_key]))
    let imported = 0
    let skipped = 0
    for (const item of eligible) {
      const sourceKey = `quickbooks:item:${item.id}`
      const productName = item.fullyQualifiedName || item.name
      const existingSource = byName.get(productName.toLowerCase())
      if (existingSource && existingSource !== sourceKey) {
        skipped += 1
        continue
      }
      await stageCrmRecordWithClient(client, {
        pipelineId: input.pipelineId,
        entity: 'products',
        sourceKey,
        sourcePayload: { provider: 'quickbooks', itemId: item.id, item: item.sourcePayload },
        actorEmail: input.actorEmail,
        fields: {
          name: productName,
          sku: item.sku || undefined,
          productType: item.itemType.toLowerCase() === 'service' ? 'Service' : 'Good',
          category: item.itemType,
          status: 'Active',
          price: item.unitPrice,
          cost: item.purchaseCost,
          description: item.description || undefined,
          active: true,
        },
      })
      byName.set(productName.toLowerCase(), sourceKey)
      imported += 1
    }
    return { imported, skipped }
  })
  await syncPipelineProductDropdownCatalogInPostgres({ pipelineId: input.pipelineId, actorEmail: input.actorEmail })
  return result
}
