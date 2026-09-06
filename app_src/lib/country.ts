export type CountryCodeNormalizationEntry = Readonly<{
  iso2: string
  aliases: readonly string[]
}>

/**
 * Provider-facing country aliases that ClawPilot can map without guessing.
 *
 * The normalized value is always ISO 3166-1 alpha-2 because parcel-carrier
 * address contracts use that representation. Unknown values remain visible;
 * downstream validation can reject values that do not have alpha-2 shape
 * without silently guessing a country.
 */
export const COUNTRY_CODE_NORMALIZATION_TABLE:
ReadonlyArray<CountryCodeNormalizationEntry> = Object.freeze([
  Object.freeze({
    iso2: 'US',
    aliases: Object.freeze([
      'US',
      'USA',
      'United States',
      'United States of America',
    ]),
  }),
  Object.freeze({
    iso2: 'CA',
    aliases: Object.freeze(['CA', 'CAN', 'Canada']),
  }),
  Object.freeze({
    iso2: 'MX',
    aliases: Object.freeze(['MX', 'MEX', 'Mexico']),
  }),
  Object.freeze({
    iso2: 'GB',
    aliases: Object.freeze([
      'GB',
      'GBR',
      'UK',
      'United Kingdom',
      'Great Britain',
    ]),
  }),
])

function countryAliasKey(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[.'’]/gu, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
}

const COUNTRY_CODE_BY_ALIAS = new Map<string, string>()
for (const entry of COUNTRY_CODE_NORMALIZATION_TABLE) {
  for (const alias of entry.aliases) {
    COUNTRY_CODE_BY_ALIAS.set(countryAliasKey(alias), entry.iso2)
  }
}

export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  return COUNTRY_CODE_BY_ALIAS.get(countryAliasKey(text))
    || text.toUpperCase()
}

export function hasIso3166Alpha2Shape(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{2}$/u.test(value)
}
