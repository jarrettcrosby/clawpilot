const DAY_MS = 24 * 60 * 60 * 1000

function utcDate(value) {
  const date = value ? new Date(`${value}T12:00:00.000Z`) : new Date()
  if (!Number.isFinite(date.getTime())) throw new Error('DEMO_ANCHOR_DATE must use YYYY-MM-DD')
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12))
}

function shifted(anchor, days, hour = 15) {
  const value = new Date(anchor.getTime() - days * DAY_MS)
  value.setUTCHours(hour, 0, 0, 0)
  return value.toISOString()
}

function day(anchor, days) {
  return shifted(anchor, days).slice(0, 10)
}

export function buildDemoDataset(anchorValue = '') {
  const anchor = utcDate(anchorValue)
  const organizations = [
    ['qb-customer-101', 'Acorn Ridge Retail', 'acorn.ridge@demo.clawpilot.example', '+1-202-555-0101'],
    ['qb-customer-102', 'Beacon Forge Supply', 'beacon.forge@demo.clawpilot.example', '+1-202-555-0102'],
    ['qb-customer-103', 'Cedar Harbor Foods', 'cedar.harbor@demo.clawpilot.example', '+1-202-555-0103'],
    ['qb-customer-104', 'Driftwood Outdoor Goods', 'driftwood@demo.clawpilot.example', '+1-202-555-0104'],
    ['qb-customer-105', 'Elmstone Health Systems', 'elmstone@demo.clawpilot.example', '+1-202-555-0105'],
    ['qb-customer-106', 'Foxglove Market Group', 'foxglove@demo.clawpilot.example', '+1-202-555-0106'],
    ['qb-customer-107', 'Granite Home Products', 'granite.home@demo.clawpilot.example', '+1-202-555-0107'],
    ['qb-customer-108', 'Highline Logistics Network', 'highline@demo.clawpilot.example', '+1-202-555-0108'],
  ].map(([providerId, name, email, phone], index) => ({
    providerId,
    name,
    email,
    phone,
    priority: ['A+', 'A', 'B', 'B', 'C', 'A', 'B', 'C'][index],
    city: ['Boston', 'Chicago', 'Providence', 'Denver', 'Raleigh', 'New York', 'Portland', 'Atlanta'][index],
    state: ['MA', 'IL', 'RI', 'CO', 'NC', 'NY', 'OR', 'GA'][index],
  }))

  const people = [
    ['qb-customer-101', 'Rowan Vale', 'rowan.vale@demo.clawpilot.example', 'VP Operations'],
    ['qb-customer-102', 'Ellis North', 'ellis.north@demo.clawpilot.example', 'Director of Supply Chain'],
    ['qb-customer-103', 'Marlow Reed', 'marlow.reed@demo.clawpilot.example', 'General Manager'],
    ['qb-customer-104', 'Sage Holloway', 'sage.holloway@demo.clawpilot.example', 'Head of Partnerships'],
    ['qb-customer-105', 'Arden Lake', 'arden.lake@demo.clawpilot.example', 'Finance Director'],
    ['qb-customer-106', 'Remy Stone', 'remy.stone@demo.clawpilot.example', 'SVP Sales'],
    ['qb-customer-107', 'Emery Fields', 'emery.fields@demo.clawpilot.example', 'Controller'],
    ['qb-customer-108', 'Alden Frost', 'alden.frost@demo.clawpilot.example', 'Chief Operating Officer'],
  ].map(([organizationProviderId, fullName, email, title], index) => ({
    organizationProviderId,
    fullName,
    email,
    title,
    phone: `+1-202-555-${String(1201 + index)}`,
  }))

  const products = [
    ['qb-item-201', 'Account Review', 'ARV', 'Service', 950, 0],
    ['qb-item-202', 'Logistics Design', 'LOG', 'Service', 4200, 0],
    ['qb-item-203', 'API Integration', 'API', 'Service', 7800, 0],
    ['qb-item-204', 'Managed Operations', 'MOP', 'Service', 2500, 0],
    ['qb-item-205', 'Restaurant Analytics', 'RAN', 'Service', 1800, 0],
    ['qb-item-206', 'Reconciliation Support', 'REC', 'Service', 1250, 0],
  ].map(([providerId, name, sku, type, price, cost]) => ({ providerId, name, sku, type, price, cost }))

  const opportunities = [
    ['Acorn Ridge Expansion', 'qb-customer-101', 'Proposal', 'Open', 68000, 75, 18, ['qb-item-202', 'qb-item-203']],
    ['Beacon Forge Systems Review', 'qb-customer-102', 'Needs Analysis', 'Open', 28500, 45, 34, ['qb-item-201', 'qb-item-206']],
    ['Cedar Harbor Reporting Rollout', 'qb-customer-103', 'Negotiation', 'Open', 42000, 85, 12, ['qb-item-205']],
    ['Driftwood Integration Program', 'qb-customer-104', 'Qualified Lead', 'Open', 96000, 35, 58, ['qb-item-203', 'qb-item-204']],
    ['Elmstone Finance Modernization', 'qb-customer-105', 'Closed', 'Closed', 54000, 100, -9, ['qb-item-204', 'qb-item-206']],
    ['Foxglove Multi-site Launch', 'qb-customer-106', 'Proposal', 'Open', 76000, 70, 29, ['qb-item-202', 'qb-item-204']],
    ['Granite Data Review', 'qb-customer-107', 'Loss', 'Abandoned', 31000, 0, -38, ['qb-item-201', 'qb-item-203']],
    ['Highline Operations Pilot', 'qb-customer-108', 'Demo', 'Open', 18500, 55, 44, ['qb-item-204']],
  ].map(([name, organizationProviderId, stage, status, amount, probability, closeOffset, productIds], index) => ({
    sourceKey: `demo:opportunity:${index + 1}`,
    name,
    organizationProviderId,
    stage,
    status,
    amount,
    probability,
    expectedClose: day(anchor, -Number(closeOffset)),
    priority: ['high', 'medium', 'high', 'medium', 'medium', 'low', 'low', 'medium'][index],
    productIds,
  }))

  const interactionOffsets = [2, 5, 8, 12, 16, 21, 27, 33, 38, 44, 51, 57, 63, 69, 74, 79, 84, 89]
  const interactions = interactionOffsets.map((daysAgo, index) => {
    const organization = organizations[index % organizations.length]
    const person = people[index % people.length]
    const kind = ['Email', 'Call', 'Meeting'][index % 3]
    return {
      sourceKey: `demo:interaction:${index + 1}`,
      organizationProviderId: organization.providerId,
      contactEmail: person.email,
      kind,
      subject: `${kind}: ${['next steps', 'commercial review', 'implementation planning', 'quarterly follow-up'][index % 4]}`,
      occurredAt: shifted(anchor, daysAgo, 14 + (index % 4)),
      description: `${kind} touchpoint recorded for the rolling demo history. Follow-up and context are synthetic.`,
      direction: index % 4 === 0 ? 'inbound' : 'outbound',
    }
  })

  const invoiceOffsets = [6, 14, 24, 35, 47, 59, 72, 86]
  const invoices = invoiceOffsets.map((daysAgo, index) => {
    const organization = organizations[index]
    const itemA = products[index % products.length]
    const itemB = products[(index + 2) % products.length]
    const lines = [
      { item: itemA, quantity: index % 2 ? 2 : 1 },
      { item: itemB, quantity: 1 },
    ]
    const subtotal = lines.reduce((sum, line) => sum + Number(line.item.price) * line.quantity, 0)
    const tax = Math.round(subtotal * 0.0625 * 100) / 100
    const total = subtotal + tax
    const paid = index >= 3 || index === 1
    return {
      providerId: `qb-invoice-${301 + index}`,
      documentNumber: `D-${String(4101 + index)}`,
      organizationProviderId: organization.providerId,
      partyName: organization.name,
      transactionDate: day(anchor, daysAgo),
      dueDate: day(anchor, daysAgo - 30),
      total,
      balance: paid ? 0 : total,
      status: paid ? 'Paid' : 'Open',
      lines,
      memo: ['Implementation milestone', 'Monthly service period', 'Analytics and support'][index % 3],
    }
  })

  return {
    version: 1,
    anchorDate: anchor.toISOString().slice(0, 10),
    windows: { recent: 30, followUp: 60, context: 90, financial: 365 },
    organizations,
    people,
    products,
    opportunities,
    interactions,
    invoices,
    vendors: [
      { id: 'qb-vendor-401', name: 'Lantern Office Supply', email: 'lantern.billing@demo.clawpilot.example', balance: 0 },
      { id: 'qb-vendor-402', name: 'Moonrise Technology', email: 'moonrise.accounts@demo.clawpilot.example', balance: 1840 },
      { id: 'qb-vendor-403', name: 'Riverbend Services', email: 'riverbend.billing@demo.clawpilot.example', balance: 620 },
    ],
    accounts: [
      ['1000', 'Operating Checking', 'Bank', 'Bank', 142850],
      ['1100', 'Accounts Receivable', 'Asset', 'Accounts Receivable', 28750],
      ['2000', 'Accounts Payable', 'Liability', 'Accounts Payable', -2460],
      ['4000', 'Service Revenue', 'Revenue', 'Income', 318400],
      ['4100', 'Implementation Revenue', 'Revenue', 'Income', 126800],
      ['5000', 'Cost of Services', 'Expense', 'Cost of Goods Sold', -103200],
      ['6100', 'Software and Tools', 'Expense', 'Expense', -28400],
      ['6200', 'Marketing', 'Expense', 'Expense', -17600],
    ].map(([id, name, classification, type, balance]) => ({ id, name, classification, type, balance })),
    generatedAt: shifted(anchor, 0, 12),
  }
}
