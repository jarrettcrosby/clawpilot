function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value, limit = 500) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit)
    : ''
}

function amount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function referenceId(value) {
  return text(record(value).value, 200) || null
}

export function parseQuickBooksCompanyInfo(payload) {
  const company = record(record(payload).CompanyInfo)
  const companyName = text(company.CompanyName, 200)
  if (!companyName) throw new Error('QuickBooks did not return a company name')
  return {
    companyName,
    country: text(company.Country, 10) || null,
  }
}

export function parseQuickBooksAccounts(payload) {
  const rows = record(record(payload).QueryResponse).Account
  if (!Array.isArray(rows)) return []
  return rows.map((value) => {
    const account = record(value)
    const id = text(account.Id, 200)
    const name = text(account.Name, 200)
    if (!id || !name) return null
    return {
      id,
      name,
      fullyQualifiedName: text(account.FullyQualifiedName, 500) || name,
      classification: text(account.Classification, 100) || null,
      accountType: text(account.AccountType, 100) || null,
      accountSubType: text(account.AccountSubType, 100) || null,
      currencyCode: text(record(account.CurrencyRef).value, 10) || null,
      active: account.Active !== false,
      sourcePayload: account,
    }
  }).filter((value) => value !== null)
}

export function parseQuickBooksItems(payload) {
  const rows = record(record(payload).QueryResponse).Item
  if (!Array.isArray(rows)) return []
  return rows.map((value) => {
    const item = record(value)
    const id = text(item.Id, 200)
    const name = text(item.Name, 200)
    if (!id || !name) return null
    return {
      id,
      name,
      fullyQualifiedName: text(item.FullyQualifiedName, 500) || name,
      itemType: text(item.Type, 100) || 'Unknown',
      sku: text(item.Sku, 100) || null,
      description: text(item.Description, 4000) || null,
      unitPrice: amount(item.UnitPrice),
      purchaseCost: amount(item.PurchaseCost),
      incomeAccountId: referenceId(item.IncomeAccountRef),
      expenseAccountId: referenceId(item.ExpenseAccountRef),
      assetAccountId: referenceId(item.AssetAccountRef),
      active: item.Active !== false,
      taxable: item.Taxable === true,
      sourcePayload: item,
    }
  }).filter((value) => value !== null)
}
