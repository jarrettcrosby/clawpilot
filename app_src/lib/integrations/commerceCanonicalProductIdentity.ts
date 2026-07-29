export type CanonicalCommerceProductIdentityCandidate = {
  productId: string
  productGlobalId: string
  sku: string | null
  barcode: string | null
}

export type CanonicalCommerceProductIdentitySelection =
  | { kind: 'none' }
  | {
      kind: 'match'
      candidate: CanonicalCommerceProductIdentityCandidate
      matchedBy: 'stable_sku' | 'stable_barcode' | 'stable_sku_and_barcode'
    }
  | {
      kind: 'ambiguous'
      productGlobalIds: string[]
      reason: 'multiple_products' | 'conflicting_barcode'
    }

function normalizedSku(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase('en-US') || null
}

function normalizedBarcode(value: string | null | undefined) {
  return value?.trim() || null
}

export function selectCanonicalCommerceProductIdentity(input: {
  providerSku: string | null
  barcode: string | null
  candidates: CanonicalCommerceProductIdentityCandidate[]
}): CanonicalCommerceProductIdentitySelection {
  const providerSku = normalizedSku(input.providerSku)
  const barcode = normalizedBarcode(input.barcode)
  if (!providerSku && !barcode) return { kind: 'none' }

  const matches = input.candidates.flatMap((candidate) => {
    const candidateSku = normalizedSku(candidate.sku)
    const candidateBarcode = normalizedBarcode(candidate.barcode)
    const skuMatch = Boolean(providerSku && candidateSku === providerSku)
    const barcodeMatch = Boolean(barcode && candidateBarcode === barcode)
    if (!skuMatch && !barcodeMatch) return []
    return [{
      candidate,
      skuMatch,
      barcodeMatch,
      conflictingBarcode: Boolean(
        skuMatch
        && barcode
        && candidateBarcode
        && candidateBarcode !== barcode,
      ),
    }]
  })

  if (matches.length === 0) return { kind: 'none' }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      productGlobalIds: Array.from(new Set(
        matches.map((match) => match.candidate.productGlobalId),
      )).sort(),
      reason: 'multiple_products',
    }
  }
  const [match] = matches
  if (match.conflictingBarcode) {
    return {
      kind: 'ambiguous',
      productGlobalIds: [match.candidate.productGlobalId],
      reason: 'conflicting_barcode',
    }
  }
  return {
    kind: 'match',
    candidate: match.candidate,
    matchedBy: match.skuMatch && match.barcodeMatch
      ? 'stable_sku_and_barcode'
      : match.barcodeMatch
        ? 'stable_barcode'
        : 'stable_sku',
  }
}
