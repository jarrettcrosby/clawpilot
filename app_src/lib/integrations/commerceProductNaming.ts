export type CommerceProductNameInput = {
  productTitle: string
  variantTitle?: string | null
  selectedOptions?: ReadonlyArray<{
    name?: string | null
    value?: string | null
  }> | null
}

function compact(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function comparable(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function isDefaultVariant(value: string) {
  const normalized = comparable(value)
    .replace(/[\s._/-]+/g, ' ')
    .trim()
  return normalized === 'default' || normalized === 'default title'
}

function isUnicodeAlphaNumeric(value: string | undefined) {
  return Boolean(value && /[\p{L}\p{N}]/u.test(value))
}

function productTitleContainsOptionPhrase(
  productTitle: string,
  optionValue: string,
) {
  const titlePoints = Array.from(comparable(productTitle))
  const optionPoints = Array.from(comparable(optionValue))
  if (optionPoints.length === 0 || optionPoints.length > titlePoints.length) {
    return false
  }
  for (
    let start = 0;
    start <= titlePoints.length - optionPoints.length;
    start += 1
  ) {
    if (!optionPoints.every(
      (point, offset) => titlePoints[start + offset] === point,
    )) {
      continue
    }
    const before = titlePoints[start - 1]
    const after = titlePoints[start + optionPoints.length]
    if (
      !isUnicodeAlphaNumeric(before)
      && !isUnicodeAlphaNumeric(after)
    ) {
      return true
    }
  }
  return false
}

function stripProductTitlePrefix(productTitle: string, variantTitle: string) {
  const comparableProduct = comparable(productTitle)
  const comparableVariant = comparable(variantTitle)
  if (!comparableVariant.startsWith(comparableProduct)) return variantTitle
  const boundary = comparableVariant.slice(
    comparableProduct.length,
    comparableProduct.length + 1,
  )
  if (boundary && !/[\s·:|/–—-]/u.test(boundary)) return variantTitle
  const remainder = variantTitle.slice(productTitle.length)
    .replace(/^[\s·:|/–—-]+/u, '')
    .trim()
  return remainder || ''
}

export function commerceVariantLabel(input: CommerceProductNameInput): string | null {
  const productTitle = compact(input.productTitle)
  const optionValues = (input.selectedOptions || [])
    .map((option) => compact(option?.value))
    .filter((value) => value && !isDefaultVariant(value))
  const distinctOptionValues = optionValues.filter((value, index) => (
    optionValues.findIndex((candidate) => comparable(candidate) === comparable(value)) === index
  ))
  const unrepresentedOptionValues = distinctOptionValues.filter((value) => (
    !productTitleContainsOptionPhrase(productTitle, value)
  ))
  if (unrepresentedOptionValues.length > 0) {
    return unrepresentedOptionValues.join(' / ')
  }
  if (distinctOptionValues.length > 0) {
    return null
  }

  const variantTitle = compact(input.variantTitle)
  if (!variantTitle || isDefaultVariant(variantTitle)) return null
  if (comparable(variantTitle) === comparable(productTitle)) return null
  const suffix = stripProductTitlePrefix(productTitle, variantTitle)
  if (!suffix || isDefaultVariant(suffix)) return null
  return suffix
}

export function commerceProductDisplayName(input: CommerceProductNameInput): string {
  const productTitle = compact(input.productTitle)
  const variantLabel = commerceVariantLabel(input)
  return variantLabel ? `${productTitle} · ${variantLabel}` : productTitle
}
