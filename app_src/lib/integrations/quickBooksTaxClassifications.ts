/**
 * QuickBooks Automated Sales Tax product classifications. These are not Item
 * ParentRef categories or TaxCode records. The endpoint is documented by
 * Intuit at /v3/company/{realmId}/taxclassification (minorversion >= 34).
 */
export type QuickBooksTaxClassification = {
  id: string
  code: string | null
  name: string
  description: string | null
  level: number
  parentId: string | null
  parentName: string | null
  applicableTo: Array<'Inventory' | 'NonInventory' | 'Service'>
}

const SUPPORTED_ITEM_TYPES = new Set(['Inventory', 'NonInventory', 'Service'])
const DEFAULT_MINOR_VERSION = '75'

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
    : ''
}

export function parseQuickBooksTaxClassificationPage(payload: unknown): QuickBooksTaxClassification[] {
  const responseValue = objectValue(payload).QueryResponse
  if (!responseValue || typeof responseValue !== 'object' || Array.isArray(responseValue)) {
    throw new Error('QuickBooks tax classification response is invalid')
  }
  const response = objectValue(responseValue)
  const rows = response.TaxClassification
  if (rows === undefined) return []
  if (!Array.isArray(rows)) throw new Error('QuickBooks tax classification response is invalid')
  return rows.map((raw) => {
    const row = objectValue(raw)
    const id = cleanText(row.Id, 200)
    const name = cleanText(row.Name, 500)
    const level = Number(row.Level)
    if (!id || !name || !Number.isInteger(level) || level < 1 || level > 20) {
      throw new Error('QuickBooks tax classification record is invalid')
    }
    const parent = objectValue(row.ParentRef)
    const applicable = Array.isArray(row.ApplicableTo) ? row.ApplicableTo : [row.ApplicableTo]
    const applicableTo = [...new Set(applicable.map((value) => cleanText(value, 40)))]
      .filter((value): value is QuickBooksTaxClassification['applicableTo'][number] => SUPPORTED_ITEM_TYPES.has(value))
    return {
      id,
      code: cleanText(row.Code, 200) || null,
      name,
      description: cleanText(row.Description, 1000) || null,
      level,
      parentId: cleanText(parent.value, 200) || null,
      parentName: cleanText(parent.name, 500) || null,
      applicableTo,
    }
  })
}

export function quickBooksTaxClassificationPath(input: {
  parentId?: string
  allLevels?: boolean
  minorVersion?: string
} = {}): string {
  if (input.allLevels && input.parentId) throw new Error('QuickBooks tax classification query is ambiguous')
  const search = new URLSearchParams()
  if (input.parentId) search.set('parentId', input.parentId)
  else if (!input.allLevels) search.set('level', '1')
  search.set('minorversion', input.minorVersion || DEFAULT_MINOR_VERSION)
  return `/quickbooks/v3/company/:realmId/taxclassification?${search.toString()}`
}

/** Resolve a provider row through its exact ParentRef chain to a level-one root. */
export function resolveQuickBooksTaxClassificationChain(
  categories: QuickBooksTaxClassification[],
  selectedId: string,
): QuickBooksTaxClassification[] | null {
  const byId = new Map<string, QuickBooksTaxClassification>()
  for (const category of categories) {
    if (byId.has(category.id)) return null
    byId.set(category.id, category)
  }
  const chain: QuickBooksTaxClassification[] = []
  const seen = new Set<string>()
  let current = byId.get(selectedId)
  while (current && chain.length < 20) {
    if (seen.has(current.id)) return null
    seen.add(current.id)
    chain.push(current)
    if (!current.parentId) return current.level === 1 ? chain.reverse() : null
    const parent = byId.get(current.parentId)
    if (!parent || current.level !== parent.level + 1) return null
    current = parent
  }
  return null
}

export function taxClassificationAppliesToItem(
  classification: QuickBooksTaxClassification,
  itemType: 'Inventory' | 'NonInventory' | 'Service',
): boolean {
  return classification.applicableTo.includes(itemType)
}
