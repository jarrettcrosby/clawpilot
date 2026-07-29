import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

const [
  migration,
  offerMigration,
  intake,
  shopifyIntake,
  faireClient,
  persistence,
  crmPersistence,
  crmTypes,
  crmUi,
  offerProjection,
] = await Promise.all([
  read('db/migrations/0130_operations_product_channel_states.sql'),
  read('db/migrations/0132_operations_product_channel_offers.sql'),
  read('app_src/lib/persistence/commerceIntake.ts'),
  read('app_src/lib/integrations/commerceIntake.ts'),
  read('app_src/lib/integrations/faireCommerceClient.ts'),
  read('app_src/lib/persistence/productChannelStates.ts'),
  read('app_src/lib/persistence/crm.ts'),
  read('app_src/lib/crm/types.ts'),
  read('app_src/components/crm/CrmSection.tsx'),
  read('app_src/lib/integrations/commerceProductChannelOffers.ts'),
])

assert.match(migration, /CREATE TABLE IF NOT EXISTS operations_product_channel_states/)
assert.match(
  migration,
  /'active', 'draft', 'archived', 'unlisted', 'unavailable', 'unknown'/,
)
assert.match(
  migration,
  /UNIQUE \(\s*organization_id, integration_account_id, external_variant_id\s*\)/,
)
assert.match(migration, /independent from crm_products\.active/i)
assert.doesNotMatch(
  migration,
  /account\.status\s*=\s*'active'/i,
  'backfill must retain states for disabled or error connections',
)
assert.match(
  offerMigration,
  /provider_product_title[\s\S]*provider_variant_title[\s\S]*provider_sku/,
)
assert.match(
  offerMigration,
  /wholesale_currency_code[\s\S]*wholesale_price_minor/,
)
assert.match(
  offerMigration,
  /retail_currency_code[\s\S]*retail_price_minor/,
)
assert.match(
  offerMigration,
  /compare_at_currency_code[\s\S]*compare_at_price_minor/,
)
assert.doesNotMatch(
  offerMigration,
  /candidate\.(?:price_minor|compare_at_price_minor)/,
  'historical candidates are ambiguous money evidence and must not backfill channel offers',
)
assert.match(offerMigration, /length\(provider_variant_title\) <= 512/)

assert.match(intake, /upsertProductChannelStateWithClient/)
assert.match(intake, /linkProductChannelStateWithClient/)
assert.match(intake, /normalizeCommerceProductChannelStatus/)
assert.match(intake, /providerProductTitle: product\.title/)
assert.match(intake, /selectCommerceProductChannelOffers/)
assert.match(intake, /compareAtPriceMinor:/)
assert.match(
  offerProjection,
  /provider === 'shopify'[\s\S]*wholesale: null[\s\S]*retail: input\.normalizedWholesalePrice[\s\S]*compareAt: input\.normalizedRetailPrice/,
)
assert.match(
  offerProjection,
  /wholesale: input\.normalizedWholesalePrice[\s\S]*retail: input\.normalizedRetailPrice[\s\S]*compareAt: null/,
)

assert.match(
  shopifyIntake,
  /product_status:active,archived,draft,unlisted/,
  'Shopify catalog intake must explicitly include every product lifecycle',
)
assert.match(
  faireClient,
  /request\('\/products', \{ query: listQuery\(options\) \}\)/,
)
assert.doesNotMatch(
  faireClient,
  /query\.set\(['"](?:active|status|lifecycle_state)['"]/,
  'Faire list requests must not apply an active-only lifecycle filter',
)

assert.match(persistence, /account\.status AS integration_account_status/)
assert.match(persistence, /state\.provider_product_title/)
assert.match(persistence, /state\.wholesale_price_minor::text/)
assert.match(persistence, /state\.retail_price_minor::text/)
assert.match(persistence, /state\.compare_at_price_minor::text/)
assert.doesNotMatch(
  persistence,
  /account\.status\s*=\s*'active'/,
  'CRM projections must retain disabled and error connection facts',
)
assert.match(crmPersistence, /salesChannels:/)
assert.match(crmTypes, /salesChannels: ProductSalesChannelState\[\]/)
assert.match(crmUi, /Sales channel presence/)
assert.match(crmUi, /Wholesale:/)
assert.match(crmUi, /Retail:/)
assert.match(crmUi, /Current:/)
assert.match(crmUi, /Compare at:/)
assert.match(crmUi, /Source active/)
assert.match(crmUi, /does\s+not by itself prove storefront publication/)

console.log('Product channel state contract tests passed')
