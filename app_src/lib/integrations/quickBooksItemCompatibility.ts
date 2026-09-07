type StoredQuickBooksItem = Record<string, unknown>

function itemRecord(input: unknown): StoredQuickBooksItem {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as StoredQuickBooksItem
    : {}
}

export function quickBooksItemPurchaseInformationEnabled(input: unknown) {
  const item = itemRecord(input)
  if (String(item.itemType || '') === 'Inventory') return true
  if (typeof item.purchaseInformationEnabled === 'boolean') {
    return item.purchaseInformationEnabled
  }
  return Boolean(
    item.expenseAccountId
    || item.preferredVendorId
    || String(item.purchaseDescription || '').trim()
    || (item.purchaseCost !== null && item.purchaseCost !== undefined)
  )
}

export function normalizeQuickBooksItemDraftForStoredCompatibility(input: unknown): StoredQuickBooksItem {
  const item = itemRecord(input)
  const inventory = String(item.itemType || '') === 'Inventory'
  return {
    ...item,
    purchaseDescription: item.purchaseDescription ?? null,
    purchaseInformationEnabled: quickBooksItemPurchaseInformationEnabled(item),
    purchaseCost: typeof item.purchaseCost === 'number' ? item.purchaseCost : 0,
    expenseAccountId: item.expenseAccountId ?? null,
    expenseAccountName: item.expenseAccountName ?? null,
    assetAccountId: item.assetAccountId ?? null,
    assetAccountName: item.assetAccountName ?? null,
    preferredVendorId: item.preferredVendorId ?? null,
    preferredVendorName: item.preferredVendorName ?? null,
    parentCategoryId: item.parentCategoryId ?? null,
    parentCategoryName: item.parentCategoryName ?? null,
    trackQuantity: inventory,
    quantityOnHand: item.quantityOnHand ?? null,
    inventoryStartDate: item.inventoryStartDate ?? null,
    reorderPoint: item.reorderPoint ?? null,
  }
}
