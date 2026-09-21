import {
  parseQuickBooksTaxClassificationPage,
  quickBooksTaxClassificationPath,
  resolveQuickBooksTaxClassificationChain,
  taxClassificationAppliesToItem,
} from '@/lib/integrations/quickBooksTaxClassifications'
import { matonFetch } from '@/lib/maton'
import { query } from '@/lib/persistence/postgres'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export async function validateQuickBooksTaxClassification(input: {
  organizationId: string
  classificationId: string
  parentId: string | null
  itemType: 'Inventory' | 'NonInventory' | 'Service'
}): Promise<{ id: string; name: string; parentId: string | null } | null> {
  const connection = await query<{ credential_owner_email: string; maton_connection_id: string }>(
    `SELECT credential_owner_email, maton_connection_id
     FROM organization_quickbooks_connections
     WHERE organization_id = $1::uuid AND status = 'active'
     LIMIT 1`,
    [input.organizationId],
  )
  const binding = connection.rows[0]
  if (!binding) throw new Error('Active QuickBooks connection unavailable')
  const readCatalog = async () => {
    const path = quickBooksTaxClassificationPath({ allLevels: true })
    const response = await matonFetch(path, { method: 'GET' }, {
      ownerEmail: binding.credential_owner_email,
      app: 'quickbooks',
      boundConnectionId: binding.maton_connection_id,
    })
    if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) {
      throw new Error('QuickBooks tax classification read failed')
    }
    const raw = await response.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('QuickBooks tax classification response exceeded the supported size')
    }
    const payload = JSON.parse(raw) as unknown
    if (payload && typeof payload === 'object' && 'Fault' in payload) {
      throw new Error('QuickBooks tax classification read failed')
    }
    const catalog = parseQuickBooksTaxClassificationPage(payload)
    if (catalog.length > 5_000) throw new Error('QuickBooks tax classification catalog exceeded the supported size')
    return catalog
  }
  const catalog = await readCatalog()
  const chain = resolveQuickBooksTaxClassificationChain(catalog, input.classificationId)
  if (!chain) return null
  const selected = chain[chain.length - 1]
  if (selected.parentId !== input.parentId
    || chain.some((category) => category.applicableTo.length > 0
      && !taxClassificationAppliesToItem(category, input.itemType))
    || !taxClassificationAppliesToItem(selected, input.itemType)
    || catalog.some((category) => category.parentId === selected.id)) return null
  return { id: selected.id, name: chain.map((category) => category.name).join(':'), parentId: selected.parentId }
}
