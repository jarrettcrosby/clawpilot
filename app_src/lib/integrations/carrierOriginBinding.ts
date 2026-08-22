function warehouseCarrierAddress(value: unknown) {
  const address = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    line1: address.line1 ?? address.address1 ?? address.street,
    line2: address.line2 ?? address.address2 ?? null,
    city: address.city,
    region:
      address.regionCode
      ?? address.region
      ?? address.state
      ?? address.provinceCode,
    postalCode: address.postalCode ?? address.zip,
    countryCode: address.countryCode ?? address.country,
  }
}

function canonicalCarrierAddress(value: unknown) {
  const address = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const part = (item: unknown) => String(item || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
  const line1 = part(address.line1)
  const city = part(address.city)
  const region = part(address.region)
  const postalCode = part(address.postalCode).replace(/[\s-]/g, '')
  const countryCode = part(address.countryCode || 'US').toUpperCase()
  if (!line1 || !city || !region || !postalCode || !countryCode) return null
  return {
    line1,
    line2: part(address.line2) || null,
    city,
    region,
    postalCode,
    countryCode,
  }
}

export function carrierSenderOriginMatches(input: {
  senderOriginWarehouseGlobalId: string | null
  warehouseGlobalId: string
  warehouseAddress: unknown
  registeredCarrierAddress: unknown
}) {
  const explicitWarehouseGlobalId = String(
    input.senderOriginWarehouseGlobalId || '',
  ).trim()
  if (explicitWarehouseGlobalId) {
    return explicitWarehouseGlobalId === input.warehouseGlobalId
  }
  const warehouseAddress = canonicalCarrierAddress(
    warehouseCarrierAddress(input.warehouseAddress),
  )
  const registeredAddress = canonicalCarrierAddress(
    input.registeredCarrierAddress,
  )
  return Boolean(
    warehouseAddress
    && registeredAddress
    && JSON.stringify(warehouseAddress) === JSON.stringify(registeredAddress),
  )
}
