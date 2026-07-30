import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const panel = readFileSync(
  resolve(root, 'app_src/components/crm/ProductImagePanel.tsx'),
  'utf8',
)
const crmSection = readFileSync(
  resolve(root, 'app_src/components/crm/CrmSection.tsx'),
  'utf8',
)

test('Product image panel uses the manager-scoped immutable asset API', () => {
  assert.match(
    panel,
    /\/api\/crm\/products\/\$\{encodeURIComponent\(productId\)\}\/images/,
  )
  assert.match(panel, /if \(!canManage \|\| !PRODUCT_ID_PATTERN\.test\(productId\)\)/)
  assert.match(panel, /cache: 'no-store'/)
  assert.match(panel, /credentials: 'same-origin'/)
  assert.match(panel, /form\.set\('image', selectedFile\)/)
  assert.match(panel, /form\.set\('altText', altText\.trim\(\)\)/)
  assert.match(panel, /form\.set\('setPrimary', String\(setPrimary\)\)/)
  assert.match(panel, /action: 'set-primary'/)
  assert.match(panel, /expectedRowVersion: asset\.rowVersion/)
})

test('Product image evidence includes an authenticated inline preview', () => {
  assert.match(panel, /Revision \$\{asset\.assetRevision\}/)
  assert.match(panel, /Row v\$\{asset\.rowVersion\}/)
  assert.match(panel, /asset\.pixelWidth/)
  assert.match(panel, /hashPrefix\(asset\.contentSha256\)/)
  assert.match(
    panel,
    /src=\{`\$\{apiPath\(productId\)\}\/\$\{encodeURIComponent\(asset\.id\)\}`\}/,
  )
  assert.match(panel, /alt=\{asset\.altText\}/)
  assert.match(panel, /loading="lazy"/)
  assert.match(panel, /Only organization owners and administrators/)
  assert.doesNotMatch(panel, /\bhref=/)
  assert.doesNotMatch(panel, /\bdownload\b/)
})

test('CRM Product editor integrates the responsive image panel', () => {
  assert.match(
    crmSection,
    /import ProductImagePanel from '@\/components\/crm\/ProductImagePanel'/,
  )
  assert.match(crmSection, /productId=\{textValue\(editorRecord, 'id'\)\}/)
  assert.match(crmSection, /canManage=\{canManageHierarchy\}/)
  assert.match(
    crmSection,
    /shopifyChannels=\{productSalesChannels\(editorRecord\)\.filter/,
  )
  assert.match(panel, /direction=\{\{ xs: 'column', sm: 'row' \}\}/)
})

test('Shopify publishing is an exact Shadow or explicitly confirmed Active command', () => {
  assert.match(panel, /data-testid="crm-shopify-image-publishing"/)
  assert.match(panel, /\/shopify-product-image/)
  assert.match(panel, /action: 'publish-product-image'/)
  assert.match(panel, /channelStateGlobalId: selectedShopifyChannel/)
  assert.match(panel, /assetId: selectedShopifyAsset/)
  assert.match(panel, /executeProviderWrite/)
  assert.doesNotMatch(panel, /idempotencyKey/)
  assert.match(panel, /Shopify received zero writes/)
  assert.match(panel, /I confirm this exact Active Shopify image write/)
  assert.match(panel, /Publishing adds media to Shopify/)
  assert.match(panel, /separate reorder completes/)
  assert.match(panel, /featured position not changed/)
  assert.doesNotMatch(panel, /Shopify primary image (?:published|updated|complete)/i)
})
