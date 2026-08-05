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
const faireProductImageRoute = readFileSync(
  resolve(
    root,
    'app_src/app/api/crm/products/[productId]/faire-product-image/route.ts',
  ),
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

test('Product image import capability is explicit and provider flow is controlled', () => {
  assert.match(panel, /imageImportAvailable: boolean/)
  assert.match(panel, /typeof payload\.imageImportAvailable !== 'boolean'/)
  assert.match(panel, /Image flow is controlled, not a live mirror/)
  assert.match(panel, /Faire image import \(development only\)/)
  assert.match(panel, /state\?\.imageImportAvailable !== true/)
  assert.match(
    panel,
    /No Faire read or image job will be attempted/,
  )
  assert.match(panel, /exact Shadow simulation and one-use authorization/)
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
  assert.match(
    crmSection,
    /faireChannels=\{productSalesChannels\(editorRecord\)\.filter\(\s*isFaireProductImageChannel/,
  )
  assert.match(crmSection, /\['DRAFT', 'PUBLISHED', 'ACTIVE'\]/)
  assert.match(crmSection, /channel\.normalizedStatus === 'unavailable'/)
  assert.match(crmSection, /channel\.providerActive === false/)
  assert.match(panel, /direction=\{\{ xs: 'column', sm: 'row' \}\}/)
})

test('Shopify publishing stays Shadow and requires one exact resource authorization', () => {
  assert.match(panel, /data-testid="crm-shopify-image-publishing"/)
  assert.match(panel, /\/shopify-product-image/)
  assert.match(panel, /action: 'publish-product-image'/)
  assert.match(panel, /channelStateGlobalId: selectedShopifyChannel/)
  assert.match(panel, /assetId: selectedShopifyAsset/)
  assert.match(panel, /executeProviderWrite/)
  assert.match(panel, /expectedProductReferenceCode/)
  assert.match(panel, /expectedChannelStateRowVersion/)
  assert.match(panel, /expectedChannelSourceRevision/)
  assert.match(panel, /expectedAssetRevision/)
  assert.match(panel, /expectedAssetRowVersion/)
  assert.match(panel, /expectedAssetContentSha256/)
  assert.match(panel, /shadowSimulationEffectGlobalId/)
  assert.doesNotMatch(panel, /idempotencyKey/)
  assert.match(panel, /Shopify received zero writes/)
  assert.match(
    panel,
    /I authorize one provider write for this exact Product, listing, and image revision only/,
  )
  assert.match(panel, /Operations stays globally Shadow/)
  assert.match(
    panel,
    /another Product, listing, image, category, or bulk update/,
  )
  assert.match(panel, /setProjection\(null\)/)
  assert.match(panel, /setActivePublishConfirmed\(false\)/)
  assert.match(panel, /Publishing adds media to Shopify/)
  assert.match(panel, /separate reorder completes/)
  assert.match(panel, /featured position not changed/)
  assert.doesNotMatch(panel, /Publish in Active/)
  assert.doesNotMatch(panel, /activation scope is Active/)
  assert.doesNotMatch(panel, /Shopify primary image (?:published|updated|complete)/i)
})

test('Faire publishing requires exact Shadow simulation and a one-use two-write authorization', () => {
  assert.match(panel, /data-testid="crm-faire-image-publishing"/)
  assert.match(panel, /\/faire-product-image/)
  assert.match(panel, /action: 'publish-product-image'/)
  assert.match(panel, /action: 'reconcile-product-image'/)
  assert.match(panel, /channelStateGlobalId: channel\.globalId/)
  assert.match(panel, /assetId: asset\.id/)
  assert.match(panel, /shadowSimulationEffectGlobalId/)
  assert.match(panel, /zero\s+Faire network requests and zero provider writes/)
  assert.match(
    panel,
    /I authorize the two required Faire provider writes once for this exact Product, listing, and image revision/,
  )
  assert.match(panel, /Current Faire images are preserved/)
  assert.match(panel, /Reconcile by Faire readback/)
  assert.match(panel, /no provider write repeated/)
  assert.match(panel, /payload\.externalEffectGlobalId/)
  assert.match(panel, /state: 'reconciliation_required'/)
  assert.match(panel, /The Faire effect identity was retained/)
  assert.match(panel, /if \(!executeProviderWrite\) setFaireProjection\(null\)/)
  assert.doesNotMatch(panel, /faire.*idempotencyKey/is)
})

test('Faire recovery survives reload and exposes only exact-effect readback', () => {
  assert.match(panel, /type FaireProductImageRecoveryEffect/)
  assert.match(panel, /const loadFaireRecoveryEffects = useCallback/)
  assert.match(panel, /const loadGeneration = \+\+faireRecoveryLoadGeneration\.current/)
  assert.match(panel, /faireRecoveryLoadGeneration\.current !== loadGeneration/)
  assert.match(panel, /fetch\(faireProductImagePath\(productId\), \{/)
  assert.match(panel, /payload\.providerReads !== 0/)
  assert.match(panel, /payload\.providerWrites !== 0/)
  assert.match(panel, /void loadFaireRecoveryEffects\(\)/)
  assert.match(panel, /data-testid="crm-faire-image-recovery"/)
  assert.match(panel, /These records survive page reloads and new\s+operator sessions/)
  assert.match(panel, /Reconcile by read-only Faire readback/)
  assert.match(panel, /Record safe manual-review state/)
  assert.match(panel, /reconcileFaireImage\(\s*effect\.externalEffectGlobalId/)
  assert.match(panel, /fenced to this Product and exact effect/)
  assert.match(panel, /performs zero provider writes/)
  assert.match(panel, /effect remains unresolved for review/)
  const recoveryMarkup = panel.slice(
    panel.indexOf('data-testid="crm-faire-image-recovery"'),
    panel.indexOf('{faireChannels.length === 0'),
  )
  assert.doesNotMatch(recoveryMarkup, /executeProviderWrite/)
  assert.doesNotMatch(recoveryMarkup, /publish-product-image/)
  assert.doesNotMatch(recoveryMarkup, /Checkbox/)
})

test('Faire recovery discovery is tenant/product scoped and performs no provider I/O', () => {
  assert.match(faireProductImageRoute, /export async function GET/)
  assert.match(
    faireProductImageRoute,
    /listFaireProductImageRecoveryEffectsInPostgres\(\{\s*organizationId,\s*productId,/,
  )
  assert.match(faireProductImageRoute, /providerReads: 0/)
  assert.match(faireProductImageRoute, /providerWrites: 0/)
  assert.match(faireProductImageRoute, /\['owner', 'admin'\]\.includes\(role\)/)
  assert.match(faireProductImageRoute, /actor\.permissions\.manageOperations !== true/)
  assert.match(faireProductImageRoute, /session\?\.impersonating/)
  const getHandler = faireProductImageRoute.slice(
    faireProductImageRoute.indexOf('export async function GET'),
    faireProductImageRoute.indexOf('export async function POST'),
  )
  assert.doesNotMatch(getHandler, /executeFaireProductImagePublish/)
  assert.doesNotMatch(getHandler, /reconcileFaireProductImagePublish/)
  assert.doesNotMatch(getHandler, /assertSameOrigin/)
})
