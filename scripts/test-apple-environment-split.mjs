#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const project = read('clients/apple/project.yml')
const development = read('clients/apple/Config/Development.xcconfig')
const production = read('clients/apple/Config/Production.xcconfig')
const association = read('app_src/lib/appleAppLinks.ts')
const simulatorBuilds = read('clients/apple/run-xcode-simulator-builds.sh')

for (const fragment of [
  'Development: debug',
  'Production: release',
  'ClawPilotPickingPhoneDev:',
  'ClawPilotPickingWatchDev:',
  'config: Development',
  'config: Production',
]) {
  assert.ok(project.includes(fragment), `Xcode project is missing ${fragment}`)
}

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

console.log('Apple development/production environment split contract passed')
