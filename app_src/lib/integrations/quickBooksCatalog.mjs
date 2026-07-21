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

function timestamp(value) {
  const candidate = text(value, 100)
  const parsed = Date.parse(candidate)
  return candidate && Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
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

function postalAddress(value) {
  const address = record(value)
  const lines = [address.Line1, address.Line2, address.Line3, address.Line4, address.Line5]
    .map((line) => text(line, 500))
    .filter(Boolean)
  const city = text(address.City, 200)
  const region = text(address.CountrySubDivisionCode, 100)
  const postalCode = text(address.PostalCode, 40)
  const country = text(address.Country, 100)
  return {
    lines,
    city: city || null,
    region: region || null,
    postalCode: postalCode || null,
    country: country || null,
  }
}

export function parseQuickBooksCompanyInfo(payload) {
  const company = record(record(payload).CompanyInfo)
  const companyName = text(company.CompanyName, 200)
  if (!companyName) throw new Error('QuickBooks did not return a company name')
  return {
    companyName,
    country: text(company.Country, 10) || null,
    legalName: text(company.LegalName, 200) || null,
    email: text(record(company.Email).Address, 320) || null,
    phone: text(record(company.PrimaryPhone).FreeFormNumber, 100) || null,
    address: postalAddress(company.CompanyAddr),
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

function parseTrackingDimensionRows(payload, entity, childFlag, parentKey) {
  const rows = record(record(payload).QueryResponse)[entity]
  if (!Array.isArray(rows)) return []
  return rows.map((value) => {
    const dimension = record(value)
    const id = text(dimension.Id, 200)
    const name = text(dimension.Name, 200)
    if (!id || !name) return null
    return {
      id,
      name,
      fullyQualifiedName: text(dimension.FullyQualifiedName, 500) || name,
      child: dimension[childFlag] === true,
      parentId: referenceId(dimension[parentKey]),
      active: dimension.Active !== false,
      sourcePayload: dimension,
    }
  }).filter((value) => value !== null)
}

export function parseQuickBooksClasses(payload) {
  return parseTrackingDimensionRows(payload, 'Class', 'SubClass', 'ParentRef')
}

export function parseQuickBooksDepartments(payload) {
  return parseTrackingDimensionRows(payload, 'Department', 'SubDepartment', 'ParentRef')
}

export function parseQuickBooksTaxCodes(payload) {
  const rows = record(record(payload).QueryResponse).TaxCode
  if (!Array.isArray(rows)) return []
  return rows.map((value) => {
    const taxCode = record(value)
    const id = text(taxCode.Id, 200)
    const name = text(taxCode.Name, 200)
    if (!id || !name) return null
    return {
      id,
      name,
      description: text(taxCode.Description, 1000) || null,
      taxable: taxCode.Taxable === true,
      active: taxCode.Active !== false,
      sourcePayload: taxCode,
    }
  }).filter((value) => value !== null)
}

function firstReference(source, keys) {
  for (const key of keys) {
    const candidate = reference(source[key])
    if (candidate.id || candidate.name) return candidate
  }
  return { id: null, name: null }
}

function journalEntrySummary(transaction) {
  let debitTotal = 0
  let creditTotal = 0
  let account = { id: null, name: null }
  for (const lineValue of Array.isArray(transaction.Line) ? transaction.Line : []) {
    const line = record(lineValue)
    const detail = record(line.JournalEntryLineDetail)
    const postingType = text(detail.PostingType, 20).toLowerCase()
    const lineAmount = signedAmount(line.Amount)
    if (postingType === 'debit') debitTotal += lineAmount
    if (postingType === 'credit') creditTotal += lineAmount
    if (!account.id && !account.name) account = reference(detail.AccountRef)
  }
  return { debitTotal, creditTotal, account }
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
    const journal = entityType === 'JournalEntry' ? journalEntrySummary(transaction) : null
    const directAccount = firstReference(transaction, [
      'AccountRef', 'DepositToAccountRef', 'APAccountRef', 'ARAccountRef', 'BankAccountRef',
    ])
    const account = directAccount.id || directAccount.name ? directAccount : journal?.account || directAccount
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
      totalAmount: journal ? journal.debitTotal : signedAmount(transaction.TotalAmt ?? transaction.PaymentAmount),
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

function parseInvoiceLines(value, depth = 0, output = []) {
  const lines = Array.isArray(value) ? value : []
  for (const lineValue of lines) {
    const line = record(lineValue)
    const detailType = text(line.DetailType, 100)
    const description = text(line.Description, 4000) || null
    const lineId = text(line.Id, 200) || null
    if (detailType === 'GroupLineDetail') {
      const detail = record(line.GroupLineDetail)
      const group = reference(detail.GroupItemRef)
      output.push({
        id: lineId,
        kind: 'group',
        depth,
        description,
        itemId: group.id,
        itemName: group.name || description || 'Group',
        quantity: null,
        unitPrice: null,
        amount: signedAmount(line.Amount),
        discountPercent: null,
        serviceDate: null,
      })
      parseInvoiceLines(detail.Line, depth + 1, output)
      continue
    }
    if (detailType === 'SalesItemLineDetail') {
      const detail = record(line.SalesItemLineDetail)
      const item = reference(detail.ItemRef)
      output.push({
        id: lineId,
        kind: 'item',
        depth,
        description,
        itemId: item.id,
        itemName: item.name || description || 'Line item',
        quantity: detail.Qty === undefined || detail.Qty === null ? null : signedAmount(detail.Qty),
        unitPrice: detail.UnitPrice === undefined || detail.UnitPrice === null ? null : signedAmount(detail.UnitPrice),
        amount: signedAmount(line.Amount),
        discountPercent: null,
        serviceDate: date(detail.ServiceDate),
      })
      continue
    }
    if (detailType === 'DiscountLineDetail') {
      const detail = record(line.DiscountLineDetail)
      output.push({
        id: lineId,
        kind: 'discount',
        depth,
        description: description || 'Discount',
        itemId: null,
        itemName: 'Discount',
        quantity: null,
        unitPrice: null,
        amount: signedAmount(line.Amount),
        discountPercent: detail.PercentBased === true ? signedAmount(detail.DiscountPercent) : null,
        serviceDate: null,
      })
      continue
    }
    if (detailType === 'SubTotalLineDetail') {
      output.push({
        id: lineId,
        kind: 'subtotal',
        depth,
        description: description || 'Subtotal',
        itemId: null,
        itemName: 'Subtotal',
        quantity: null,
        unitPrice: null,
        amount: signedAmount(line.Amount),
        discountPercent: null,
        serviceDate: null,
      })
      continue
    }
    if (description || line.Amount !== undefined) {
      output.push({
        id: lineId,
        kind: 'description',
        depth,
        description,
        itemId: null,
        itemName: description || 'Line',
        quantity: null,
        unitPrice: null,
        amount: signedAmount(line.Amount),
        discountPercent: null,
        serviceDate: null,
      })
    }
  }
  return output
}

export function parseQuickBooksInvoiceDetail(value) {
  const invoice = record(value)
  const id = text(invoice.Id, 200)
  if (!id) throw new Error('QuickBooks invoice is missing an id')
  const customer = reference(invoice.CustomerRef)
  const lines = parseInvoiceLines(invoice.Line)
  const subtotalLine = [...lines].reverse().find((line) => line.kind === 'subtotal')
  const totalTax = signedAmount(record(invoice.TxnTaxDetail).TotalTax)
  return {
    id,
    documentNumber: text(invoice.DocNumber, 200) || null,
    transactionDate: date(invoice.TxnDate),
    dueDate: date(invoice.DueDate),
    customerId: customer.id,
    customerName: customer.name,
    billingEmail: text(record(invoice.BillEmail).Address, 320) || null,
    billingAddress: postalAddress(invoice.BillAddr),
    shippingAddress: postalAddress(invoice.ShipAddr),
    currencyCode: text(record(invoice.CurrencyRef).value, 10) || null,
    exchangeRate: invoice.ExchangeRate === undefined || invoice.ExchangeRate === null
      ? null
      : signedAmount(invoice.ExchangeRate),
    salesTerm: reference(invoice.SalesTermRef).name,
    shipMethod: reference(invoice.ShipMethodRef).name,
    trackingNumber: text(invoice.TrackingNum, 200) || null,
    customerMemo: text(record(invoice.CustomerMemo).value, 4000) || null,
    privateNote: text(invoice.PrivateNote, 4000) || null,
    subtotal: subtotalLine
      ? subtotalLine.amount
      : signedAmount(invoice.TotalAmt) - totalTax,
    totalTax,
    totalAmount: signedAmount(invoice.TotalAmt),
    balance: signedAmount(invoice.Balance),
    deposit: signedAmount(invoice.Deposit),
    lines,
  }
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

function reportCells(value) {
  const source = record(value)
  const cells = Array.isArray(source.ColData) ? source.ColData : []
  return cells.map((cellValue) => {
    const cell = record(cellValue)
    return {
      value: text(cell.value, 2000),
      id: text(cell.id, 200) || null,
      href: text(cell.href, 2000) || null,
    }
  })
}

function flattenReportRows(value, depth = 0, output = []) {
  const container = record(value)
  const rows = Array.isArray(container.Row) ? container.Row : []
  for (const rowValue of rows) {
    const row = record(rowValue)
    const group = text(row.group, 200) || null
    const rowType = text(row.type, 40).toLowerCase()
    if (rowType === 'section' || row.Header || row.Rows || row.Summary) {
      const headerCells = reportCells(row.Header)
      if (headerCells.some((cell) => cell.value || cell.id) || group) {
        output.push({ kind: 'section', depth, group, cells: headerCells })
      }
      flattenReportRows(row.Rows, depth + 1, output)
      const summaryCells = reportCells(row.Summary)
      if (summaryCells.some((cell) => cell.value || cell.id)) {
        output.push({ kind: 'summary', depth, group, cells: summaryCells })
      }
      continue
    }
    const cells = reportCells(row)
    if (cells.some((cell) => cell.value || cell.id)) {
      output.push({ kind: 'data', depth, group, cells })
    }
  }
  return output
}

export function parseQuickBooksFinancialReport(payload) {
  const source = record(payload)
  const header = record(source.Header)
  const columnRows = Array.isArray(record(source.Columns).Column)
    ? record(source.Columns).Column
    : []
  const options = Array.isArray(header.Option) ? header.Option : []
  const reportName = text(header.ReportName, 200) || 'QuickBooks report'
  const columns = columnRows.map((columnValue) => {
    const column = record(columnValue)
    return {
      title: text(column.ColTitle, 500),
      type: text(column.ColType, 100) || null,
    }
  })
  return {
    reportName,
    reportBasis: text(header.ReportBasis, 100) || null,
    startPeriod: date(header.StartPeriod),
    endPeriod: date(header.EndPeriod),
    currencyCode: text(header.Currency, 10) || null,
    generatedAt: timestamp(header.Time),
    noData: options.some((optionValue) => {
      const option = record(optionValue)
      return text(option.Name, 100) === 'NoReportData' && text(option.Value, 20).toLowerCase() === 'true'
    }),
    options: Object.fromEntries(options.flatMap((optionValue) => {
      const option = record(optionValue)
      const name = text(option.Name, 100)
      return name ? [[name, text(option.Value, 500)]] : []
    })),
    columns,
    rows: flattenReportRows(source.Rows),
  }
}
