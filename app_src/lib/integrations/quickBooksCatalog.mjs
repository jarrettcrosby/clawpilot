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

function signedAmount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function date(value) {
  const candidate = text(value, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null
}

function reference(value) {
  const input = record(value)
  return {
    id: text(input.value, 200) || null,
    name: text(input.name, 500) || null,
  }
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
      currentBalance: signedAmount(account.CurrentBalance),
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
      quantityOnHand: item.QtyOnHand === undefined || item.QtyOnHand === null
        ? null
        : signedAmount(item.QtyOnHand),
      trackQuantity: item.TrackQtyOnHand === true,
      incomeAccountId: referenceId(item.IncomeAccountRef),
      expenseAccountId: referenceId(item.ExpenseAccountRef),
      assetAccountId: referenceId(item.AssetAccountRef),
      active: item.Active !== false,
      taxable: item.Taxable === true,
      sourcePayload: item,
    }
  }).filter((value) => value !== null)
}

function parsePartyRows(payload, entity) {
  const rows = record(record(payload).QueryResponse)[entity]
  if (!Array.isArray(rows)) return []
  return rows.map((value) => {
    const party = record(value)
    const id = text(party.Id, 200)
    const displayName = text(party.DisplayName, 500)
      || text(party.CompanyName, 500)
      || [text(party.GivenName, 200), text(party.FamilyName, 200)].filter(Boolean).join(' ')
    if (!id || !displayName) return null
    return {
      id,
      displayName,
      companyName: text(party.CompanyName, 500) || null,
      email: text(record(party.PrimaryEmailAddr).Address, 320) || null,
      phone: text(record(party.PrimaryPhone).FreeFormNumber, 100) || null,
      currencyCode: text(record(party.CurrencyRef).value, 10) || null,
      balance: signedAmount(party.Balance),
      active: party.Active !== false,
      sourcePayload: party,
    }
  }).filter((value) => value !== null)
}

export function parseQuickBooksCustomers(payload) {
  return parsePartyRows(payload, 'Customer')
}

export function parseQuickBooksVendors(payload) {
  return parsePartyRows(payload, 'Vendor')
}

function firstReference(source, keys) {
  for (const key of keys) {
    const candidate = reference(source[key])
    if (candidate.id || candidate.name) return candidate
  }
  return { id: null, name: null }
}

export function parseQuickBooksTransactions(payload, entityType) {
  const rows = record(record(payload).QueryResponse)[entityType]
  if (!Array.isArray(rows)) return []
  return rows.map((value) => {
    const transaction = record(value)
    const id = text(transaction.Id, 200)
    if (!id) return null
    const party = firstReference(transaction, [
      'CustomerRef', 'VendorRef', 'EntityRef', 'EmployeeRef',
    ])
    const account = firstReference(transaction, [
      'AccountRef', 'DepositToAccountRef', 'APAccountRef', 'ARAccountRef', 'BankAccountRef',
    ])
    const openBalance = signedAmount(transaction.Balance ?? transaction.UnappliedAmt)
    const lifecycleStatus = ['Invoice', 'Bill'].includes(entityType)
      ? openBalance === 0 ? 'Paid' : 'Open'
      : 'Posted'
    return {
      id,
      entityType,
      documentNumber: text(transaction.DocNumber, 200) || null,
      transactionDate: date(transaction.TxnDate),
      dueDate: date(transaction.DueDate),
      partyId: party.id,
      partyName: party.name,
      accountId: account.id,
      accountName: account.name,
      currencyCode: text(record(transaction.CurrencyRef).value, 10) || null,
      totalAmount: signedAmount(transaction.TotalAmt ?? transaction.PaymentAmount),
      openBalance,
      status: text(transaction.TxnStatus, 100) || lifecycleStatus,
      emailStatus: text(transaction.EmailStatus, 100) || null,
      paymentMethod: reference(transaction.PaymentMethodRef).name,
      memo: text(transaction.PrivateNote, 4000)
        || text(record(transaction.CustomerMemo).value, 4000)
        || text(transaction.Memo, 4000)
        || null,
      sourcePayload: transaction,
    }
  }).filter((value) => value !== null)
}

export function parseQuickBooksAttachments(payload) {
  const rows = record(record(payload).QueryResponse).Attachable
  if (!Array.isArray(rows)) return []
  return rows.map((value) => {
    const attachment = record(value)
    const id = text(attachment.Id, 200)
    if (!id) return null
    const rawReferences = Array.isArray(attachment.AttachableRef) ? attachment.AttachableRef : []
    const entityReferences = rawReferences.map((rawReference) => {
      const entity = record(record(rawReference).EntityRef)
      return {
        id: text(entity.value, 200) || null,
        type: text(entity.type, 100) || null,
        name: text(entity.name, 500) || null,
      }
    }).filter((entity) => entity.id || entity.type || entity.name)
    const parsedSize = Number(attachment.Size)
    return {
      id,
      fileName: text(attachment.FileName, 500) || null,
      contentType: text(attachment.ContentType, 200) || null,
      sizeBytes: Number.isFinite(parsedSize) && parsedSize >= 0 ? Math.round(parsedSize) : null,
      note: text(attachment.Note, 4000) || null,
      entityReferences,
      sourcePayload: attachment,
    }
  }).filter((value) => value !== null)
}
