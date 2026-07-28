import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

const [
  migration,
  intake,
  shopifyIntake,
  faireClient,
  persistence,
  crmPersistence,
  crmTypes,
  crmUi,
] = await Promise.all([
  read('db/migrations/0130_operations_product_channel_states.sql'),
  read('app_src/lib/persistence/commerceIntake.ts'),
  read('app_src/lib/integrations/commerceIntake.ts'),
  read('app_src/lib/integrations/faireCommerceClient.ts'),
  read('app_src/lib/persistence/productChannelStates.ts'),
  read('app_src/lib/persistence/crm.ts'),
  read('app_src/lib/crm/types.ts'),
  read('app_src/components/crm/CrmSection.tsx'),
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

assert.match(intake, /upsertProductChannelStateWithClient/)
assert.match(intake, /linkProductChannelStateWithClient/)
assert.match(intake, /normalizeCommerceProductChannelStatus/)

assert.match(
  shopifyIntake,
  /product_status:ACTIVE,ARCHIVED,DRAFT,UNLISTED/,
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
assert.doesNotMatch(
  persistence,
  /account\.status\s*=\s*'active'/,
  'CRM projections must retain disabled and error connection facts',
)
assert.match(crmPersistence, /salesChannels:/)
assert.match(crmTypes, /salesChannels: ProductSalesChannelState\[\]/)
assert.match(crmUi, /Sales channel presence/)
assert.match(crmUi, /Source active/)
assert.match(crmUi, /does\s+not by itself prove storefront publication/)

console.log('Product channel state contract tests passed')
