import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

async function read(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8')
}

const [
  themeBlock,
  proxyExample,
  aliasRoute,
  applicationProxy,
  rootPackageText,
] = await Promise.all([
  read('shopify/extensions/clawpilot-checkout-rate-warmer/blocks/checkout-rate-warmer.liquid'),
  read('shopify/contracts/checkout-rate-warmer-app-proxy.toml.example'),
  read('app_src/app/api/integrations/commerce/shopify/rate-warm/checkout-rate-warmer/route.ts'),
  read('app_src/proxy.ts'),
  read('package.json'),
])

assert.match(
  themeBlock,
  /"default":\s*"\/apps\/clawpilot\/checkout-rate-warmer"/,
  'theme embed must call the child path below the configured proxy root',
)
assert.match(proxyExample, /\[app_proxy\]/)
assert.match(
  proxyExample,
  /url\s*=\s*"https:\/\/dev\.aiapp\.eigenracing\.com\/api\/integrations\/commerce\/shopify\/rate-warm"/,
)
assert.match(proxyExample, /prefix\s*=\s*"apps"/)
assert.match(proxyExample, /subpath\s*=\s*"clawpilot"/)
assert.match(proxyExample, /\bwrite_app_proxy\b/)
assert.match(proxyExample, /\bread_customers\b/)
assert.match(
  aliasRoute,
  /import \{ GET as handleRateWarmRequest \} from '\.\.\/route'/,
  'proxy child route must delegate to the verified parent handler',
)
assert.match(aliasRoute, /return handleRateWarmRequest\(request\)/)
assert.match(
  applicationProxy,
  /normalizedPath === '\/api\/integrations\/commerce\/shopify\/rate-warm'/,
  'the signed app-proxy root must bypass ClawPilot browser-session auth',
)
assert.match(
  applicationProxy,
  /normalizedPath\.startsWith\('\/api\/integrations\/commerce\/shopify\/rate-warm\/'\)/,
  'the signed app-proxy child route must bypass ClawPilot browser-session auth',
)

const rootPackage = JSON.parse(rootPackageText)
assert.equal(
  rootPackage.scripts['test:shopify-rate-warmer-extension'],
  'node scripts/test-shopify-rate-warmer-wiring.mjs && npm --prefix shopify test && npm --prefix shopify --workspace @clawpilot/shopify-checkout-rate-warmer run build',
)
assert.match(
  rootPackage.scripts['test:shopify-carrier-service'],
  /npm run test:shopify-rate-warmer-extension/,
  'carrier-service gate must include the theme rate-warmer gate',
)

console.log('Shopify checkout rate-warmer deployment wiring passed.')
