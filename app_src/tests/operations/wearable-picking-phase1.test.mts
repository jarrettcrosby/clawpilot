import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

test('wearable queue is signed-worker scoped and read only', () => {
  const persistence = read('lib/persistence/wearablePicking.ts')
  assert.match(persistence, /lower\(pick\.assigned_to\) = \$2/)
  assert.match(persistence, /pick\.status = 'ready'/)
  assert.match(persistence, /orders\.status = 'released'/)
  assert.match(persistence, /plan\.status = 'released'/)
  assert.match(persistence, /wave\.status = 'released'/)
  assert.match(persistence, /operations_product_channel_states channel/)
  assert.match(persistence, /channel\.provider_barcode/)
  assert.match(persistence, /channel\.provider_sku = line\.channel_sku/)
  assert.doesNotMatch(persistence, /line\.barcode_snapshot/)
  assert.doesNotMatch(persistence, /\b(?:INSERT|UPDATE|DELETE)\b/)
})

test('wearable route keeps existing ClawPilot authorization boundary', () => {
  const route = read('app/api/operations/picks/route.ts')
  assert.match(route, /requireRequestUser\(req\)/)
  assert.match(route, /capabilities\.canView/)
  assert.match(route, /capabilities\.canManage/)
  assert.match(route, /capabilities\.canExecute/)
  assert.match(route, /Cache-Control': 'private, no-store'/)
})

test('Phase 1 confirmation reuses the audited Operations command', () => {
  const route = read('app/api/operations/route.ts')
  const persistence = read('lib/persistence/operations.ts')
  assert.match(route, /action === 'confirm-picks'/)
  assert.match(route, /idempotencyKeyValue\(req\)/)
  assert.match(persistence, /confirmOperationsOrderPicksFromPostgres/)
  assert.match(persistence, /OPERATIONS_ORDER_VERSION_CONFLICT/)
  assert.match(persistence, /operations\.pick\.completed/)
  assert.match(persistence, /operations\.order\.picks_confirmed/)
})

test('Meta universal-link metadata and callback remain public without exposing app data', () => {
  const proxy = read('proxy.ts')
  const association = read('lib/appleAppLinks.ts')
  const callback = read('app/ios/route.ts')
  assert.match(proxy, /pathname === '\/\.well-known\/apple-app-site-association'/)
  assert.match(proxy, /pathname === '\/apple-app-site-association'/)
  assert.match(proxy, /pathname === '\/ios'/)
  assert.match(proxy, /if \(isPublicAppleAppLink\(pathname\)\) return NextResponse\.next\(\)/)
  assert.match(association, /CN2T77JHQQ\.com\.eigenracing\.ios\.picking/)
  assert.match(association, /'\/': '\/ios\*'/)
  assert.doesNotMatch(callback, /requireRequestUser|resolveRequestSession|operations|pipeline/)
})

test('Meta DAT callback uses the app URL scheme and camera access requires registration', () => {
  const project = read('../clients/apple/project.yml')
  const app = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const dashboard = read('../clients/apple/Apps/iPhone/PickingDashboardView.swift')
  assert.match(project, /CLAWPILOT_META_URL_SCHEME: "clawpilot-meta"/)
  assert.match(project, /CLAWPILOT_META_APP_LINK_SCHEME: "clawpilot-meta:\/\/"/)
  assert.match(app, /\.onOpenURL \{ url in Task \{ await model\.handleMetaURL\(url\) \} \}/)
  assert.match(app, /guard MetaWearablesAppBridge\.isRegistered else/)
  assert.match(dashboard, /else if model\.canRequestMetaCamera/)
  assert.match(dashboard, /Button\("Allow camera access"\)/)
  assert.match(app, /await loadQueue\(readAloud: false\)/)
})

test('iPhone picking UI supports a dismissible one-time-code flow and branded icon', () => {
  const project = read('../clients/apple/project.yml')
  const dashboard = read('../clients/apple/Apps/iPhone/PickingDashboardView.swift')
  assert.match(project, /ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon/)
  assert.match(project, /UILaunchScreen: \{\}/)
  assert.match(dashboard, /Image\("ClawPilotMark"\)/)
  assert.match(dashboard, /\.textContentType\(\.oneTimeCode\)/)
  assert.match(dashboard, /ToolbarItemGroup\(placement: \.keyboard\)/)
  assert.match(dashboard, /Button\("Done"\) \{ authenticationField = nil \}/)
  assert.match(dashboard, /\.scrollDismissesKeyboard\(\.interactively\)/)
})
