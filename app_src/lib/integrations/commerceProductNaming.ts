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
  if (distinctOptionValues.length > 0) {
    return distinctOptionValues.join(' / ')
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
