import {
  readQuickBooksTaxClassifications,
  taxClassificationAppliesToItem,
} from '@/lib/integrations/quickBooksTaxClassifications'
import { matonFetch } from '@/lib/maton'
import { query } from '@/lib/persistence/postgres'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export async function validateQuickBooksTaxClassification(input: {
  organizationId: string
  classificationId: string
  itemType: 'Inventory' | 'NonInventory' | 'Service'
}): Promise<{ id: string; name: string } | null> {
  const connection = await query<{ credential_owner_email: string; maton_connection_id: string }>(
    `SELECT credential_owner_email, maton_connection_id
     FROM organization_quickbooks_connections
     WHERE organization_id = $1::uuid AND status = 'active'
     LIMIT 1`,
    [input.organizationId],
  )
  const binding = connection.rows[0]
  if (!binding) throw new Error('Active QuickBooks connection unavailable')
  const categories = await readQuickBooksTaxClassifications(async (path) => {
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
    return payload
  })
  const selected = categories.find((category) => category.id === input.classificationId)
  if (!selected || !taxClassificationAppliesToItem(selected, input.itemType)
    || categories.some((category) => category.parentId === selected.id)) return null
  const parentName = selected.parentName
    || (selected.parentId ? categories.find((category) => category.id === selected.parentId)?.name : null)
  return { id: selected.id, name: parentName
    ? `${parentName}:${selected.name}` : selected.name }
}
