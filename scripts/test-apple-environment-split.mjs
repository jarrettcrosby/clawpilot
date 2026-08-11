#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const project = read('clients/apple/project.yml')
const development = read('clients/apple/Config/Development.xcconfig')
const production = read('clients/apple/Config/Production.xcconfig')
const association = read('app_src/lib/appleAppLinks.ts')
const simulatorBuilds = read('clients/apple/run-xcode-simulator-builds.sh')
const phonePrivacy = read('clients/apple/Apps/iPhone/PrivacyInfo.xcprivacy')
const watchPrivacy = read('clients/apple/Apps/Watch/PrivacyInfo.xcprivacy')

for (const fragment of [
  'Development: debug',
  'DevelopmentRelease: release',
  'Production: release',
  'ClawPilotPickingPhoneDev:',
  'ClawPilotPickingWatchDev:',
  'config: Development',
  'config: Production',
]) {
  assert.ok(project.includes(fragment), `Xcode project is missing ${fragment}`)
}

assert.match(
  project,
  /ClawPilotPickingPhoneDev:[\s\S]*?run:\n\s+config: Development[\s\S]*?profile:\n\s+config: DevelopmentRelease[\s\S]*?archive:\n\s+config: DevelopmentRelease/,
)
assert.match(
  project,
  /ClawPilotPickingWatchDev:[\s\S]*?run:\n\s+config: Development[\s\S]*?profile:\n\s+config: DevelopmentRelease[\s\S]*?archive:\n\s+config: DevelopmentRelease/,
)
assert.equal(
  (project.match(/DevelopmentRelease: Config\/Development\.xcconfig/g) || []).length,
  2,
  'Both app targets must use development IDs and origin for DevelopmentRelease',
)

for (const fragment of [
  'CLAWPILOT_DISPLAY_NAME = ClawPilot Dev',
  'CLAWPILOT_SERVER_ORIGIN = https:/$()/dev.aiapp.eigenracing.com',
  'CLAWPILOT_PHONE_BUNDLE_IDENTIFIER = com.eigenracing.ios.picking.dev',
  'CLAWPILOT_WATCH_BUNDLE_IDENTIFIER = com.eigenracing.ios.picking.dev.watch',
  'CLAWPILOT_ASSOCIATED_DOMAIN = dev.aiapp.eigenracing.com',
  'CLAWPILOT_META_URL_SCHEME = clawpilot-meta-dev',
]) {
  assert.ok(development.includes(fragment), `Development config is missing ${fragment}`)
}

for (const fragment of [
  'CLAWPILOT_DISPLAY_NAME = ClawPilot',
  'CLAWPILOT_SERVER_ORIGIN = https:/$()/aiapp.eigenracing.com',
  'CLAWPILOT_PHONE_BUNDLE_IDENTIFIER = com.eigenracing.ios.picking',
  'CLAWPILOT_WATCH_BUNDLE_IDENTIFIER = com.eigenracing.ios.picking.watch',
  'CLAWPILOT_ASSOCIATED_DOMAIN = aiapp.eigenracing.com',
  'CLAWPILOT_META_URL_SCHEME = clawpilot-meta',
]) {
  assert.ok(production.includes(fragment), `Production config is missing ${fragment}`)
}

assert.notEqual(development, production)
assert.match(association, /CN2T77JHQQ\.com\.eigenracing\.ios\.picking'/)
assert.match(association, /CN2T77JHQQ\.com\.eigenracing\.ios\.picking\.dev'/)
for (const scheme of [
  '-scheme ClawPilotPickingPhoneDev',
  '-scheme ClawPilotPickingWatchDev',
  '-scheme ClawPilotPickingPhone',
  '-scheme ClawPilotPickingWatch',
]) {
  assert.ok(simulatorBuilds.includes(scheme), `Simulator gate is missing ${scheme}`)
}

assert.match(
  simulatorBuilds,
  /-scheme ClawPilotPickingPhoneDev \\\n+\s+-configuration DevelopmentRelease/,
)
assert.match(
  simulatorBuilds,
  /DevelopmentRelease-iphonesimulator\/ClawPilotPicking\.app/,
)
assert.match(simulatorBuilds, /verify_privacy_manifests "\$\{phone_app\}"/)

for (const fragment of [
  'NSPrivacyAccessedAPICategoryUserDefaults',
  'CA92.1',
  'NSPrivacyAccessedAPICategoryFileTimestamp',
  'C617.1',
]) {
  assert.ok(phonePrivacy.includes(fragment), `iPhone privacy manifest is missing ${fragment}`)
}
for (const fragment of [
  'NSPrivacyAccessedAPICategoryUserDefaults',
  'CA92.1',
]) {
  assert.ok(watchPrivacy.includes(fragment), `Watch privacy manifest is missing ${fragment}`)
}
assert.ok(
  !watchPrivacy.includes('NSPrivacyAccessedAPICategoryFileTimestamp'),
  'Watch must not declare the iPhone-only file metadata reason',
)

console.log('Apple development/production environment split contract passed')
