const SHOPIFY_NUMERIC_ID = /^[1-9][0-9]{0,19}$/

export function configuredShopifyNumericIdentifierSet(
  environmentName: 'SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS',
): ReadonlySet<string> | null {
  const raw = String(process.env[environmentName] || '').trim()
  if (!raw) return null
  const identifiers = raw.split(',').map((entry) => entry.trim())
  if (
    identifiers.length < 1
    || identifiers.some((identifier) => !SHOPIFY_NUMERIC_ID.test(identifier))
  ) {
    return null
  }
  return new Set(identifiers)
}

export function hasValidShopifyShadowVariantAllowlist() {
  return configuredShopifyNumericIdentifierSet(
    'SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS',
  ) !== null
}
