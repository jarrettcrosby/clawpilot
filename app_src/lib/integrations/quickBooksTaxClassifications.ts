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
// Intuit documents level-one categories and their level-two children.
const DEFAULT_MAX_DEPTH = 2
const DEFAULT_MAX_RECORDS = 20_000

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
  minorVersion?: string
} = {}): string {
  const search = new URLSearchParams()
  if (input.parentId) search.set('parentId', input.parentId)
  else search.set('level', '1')
  search.set('minorversion', input.minorVersion || DEFAULT_MINOR_VERSION)
  return `/quickbooks/v3/company/:realmId/taxclassification?${search.toString()}`
}

/**
 * Read the company-specific category tree using the existing bound QuickBooks
 * connection's request function. The caller owns auth, pacing, and retries.
 */
export async function readQuickBooksTaxClassifications(
  request: (pathname: string) => Promise<unknown>,
  options: { minorVersion?: string; maxDepth?: number; maxRecords?: number } = {},
): Promise<QuickBooksTaxClassification[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || !Number.isInteger(maxRecords) || maxRecords < 1) {
    throw new Error('QuickBooks tax classification read limits are invalid')
  }
  const result: QuickBooksTaxClassification[] = []
  const seen = new Set<string>()
  const pending: Array<{ parent: QuickBooksTaxClassification | null; depth: number }> = [{ parent: null, depth: 1 }]
  while (pending.length) {
    const { parent, depth } = pending.shift()!
    const page = parseQuickBooksTaxClassificationPage(await request(quickBooksTaxClassificationPath({
      parentId: parent?.id,
      minorVersion: options.minorVersion,
    })))
    for (const row of page) {
      if (seen.has(row.id)) continue
      if (result.length >= maxRecords) throw new Error('QuickBooks tax classification catalog exceeded the supported size')
      if (parent && row.parentId && row.parentId !== parent.id) {
        throw new Error('QuickBooks tax classification parent is inconsistent')
      }
      if (row.level !== depth) throw new Error('QuickBooks tax classification level is inconsistent')
      const classification = parent && !row.parentId
        ? { ...row, parentId: parent.id, parentName: parent.name }
        : row
      seen.add(classification.id)
      result.push(classification)
      if (depth < maxDepth) pending.push({ parent: classification, depth: depth + 1 })
    }
  }
  return result
}

export function taxClassificationAppliesToItem(
  classification: QuickBooksTaxClassification,
  itemType: 'Inventory' | 'NonInventory' | 'Service',
): boolean {
  return classification.applicableTo.includes(itemType)
}
