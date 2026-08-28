#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const project = read('clients/apple/project.yml')
const development = read('clients/apple/Config/Development.xcconfig')
const production = read('clients/apple/Config/Production.xcconfig')
const association = read('app_src/lib/appleAppLinks.ts')
const simulatorBuilds = read('clients/apple/run-xcode-simulator-builds.sh')
const phonePrivacy = read('clients/apple/Apps/iPhone/PrivacyInfo.xcprivacy')
const watchPrivacy = read('clients/apple/Apps/Watch/PrivacyInfo.xcprivacy')
const developmentArchiveVerifier = read('clients/apple/verify-development-archive.sh')
const productionArchiveVerifier = read('clients/apple/verify-production-archive.sh')
const archiveBuilder = read('clients/apple/archive-apple-app.sh')

for (const fragment of [
  'Development: debug',
  'DevelopmentRelease: release',
  'Production: release',
  'ClawPilotPickingPhoneDev:',
  'ClawPilotPickingWatchDev:',
  'config: Development',
  'config: Production',
  'CURRENT_PROJECT_VERSION: "16"',
  'CLAWPILOT_SOURCE_COMMIT: UNSET',
  'ClawPilotSourceCommit: $(CLAWPILOT_SOURCE_COMMIT)',
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
for (const fragment of [
  'source_commit="$(git -C "${repository_root}" rev-parse --verify HEAD)"',
  'The source checkout must be clean before source-bound simulator builds.',
  '"CLAWPILOT_SOURCE_COMMIT=${source_commit}"',
  'ClawPilotSourceCommit',
  'require_url_schemes_exact',
  'DevelopmentRelease-watchsimulator/ClawPilotPickingWatch.app',
  'Production-watchsimulator/ClawPilotPickingWatch.app',
  '000000000001-dev-build-contract.apps.googleusercontent.com',
  '000000000002-production-build-contract.apps.googleusercontent.com',
]) {
  assert.ok(simulatorBuilds.includes(fragment), `Simulator contract is missing ${fragment}`)
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

assert.ok(
  (statSync(new URL('../clients/apple/verify-development-archive.sh', import.meta.url)).mode & 0o111) !== 0,
  'Development archive verifier must be executable',
)
assert.ok(
  (statSync(new URL('../clients/apple/verify-production-archive.sh', import.meta.url)).mode & 0o111) !== 0,
  'Production archive verifier must be executable',
)
assert.ok(
  (statSync(new URL('../clients/apple/archive-apple-app.sh', import.meta.url)).mode & 0o111) !== 0,
  'Apple archive builder must be executable',
)
for (const fragment of [
  'set +x',
  'CLAWPILOT_GOOGLE_DEV_IOS_CLIENT_ID',
  'CLAWPILOT_GOOGLE_SERVER_CLIENT_ID_SHARED',
  'CLAWPILOT_GOOGLE_DEV_REVERSED_CLIENT_ID',
  'CLAWPILOT_META_DEV_APP_ID',
  'CLAWPILOT_META_DEV_CLIENT_TOKEN',
  'config_value_from_file',
  '#include(\\?)?',
  'depth <= 16',
  'the ignored Local.xcconfig credential overlay is missing',
  '*not-configured*',
  '*placeholder*',
  'GIDClientID',
  'GIDServerClientID',
  'MWDAT:MetaAppID',
  'MWDAT:ClientToken',
  'require_url_schemes_exact',
  'com.eigenracing.ios.picking.dev',
  'com.eigenracing.ios.picking.dev.watch',
  'https://dev.aiapp.eigenracing.com',
  'ApplicationProperties:CFBundleVersion',
  'project_value CURRENT_PROJECT_VERSION',
  'the current project build number',
  'ApplicationProperties:CFBundleIdentifier',
  'ClawPilotPickingPhoneDev',
  'codesign --verify --deep --strict',
  'ClawPilotSourceCommit',
  'the source checkout is not clean',
  'Apple Development: ',
  'Apple Distribution: ',
  'App Store Connect, and TestFlight readiness were not verified',
  'CLAWPILOT_GOOGLE_PRODUCTION_IOS_CLIENT_ID',
  'CLAWPILOT_META_PRODUCTION_APP_ID',
  'com.eigenracing.ios.picking.watch',
  'https://aiapp.eigenracing.com',
  'ClawPilotPickingPhone',
]) {
  assert.ok(
    developmentArchiveVerifier.includes(fragment),
    `Development archive verifier is missing ${fragment}`,
  )
}
assert.match(productionArchiveVerifier, /production "\$@"/)
for (const fragment of [
  'the source checkout must be clean before creating an archive',
  'CLAWPILOT_SOURCE_COMMIT=${source_commit}',
  'ClawPilotPickingPhoneDev',
  'ClawPilotPickingPhone',
  'DevelopmentRelease',
  'Production',
]) {
  assert.ok(archiveBuilder.includes(fragment), `Archive builder is missing ${fragment}`)
}
assert.match(
  developmentArchiveVerifier,
  /require_plist_equal "\$\{phone_plist\}" GIDClientID "\$\{google_client_id\}"/,
  'Signed Google iOS client ID must exactly match the ignored local overlay',
)
assert.match(project, /CURRENT_PROJECT_VERSION: "16"/)
assert.match(
  developmentArchiveVerifier,
  /require_plist_equal "\$\{phone_plist\}" GIDServerClientID "\$\{google_server_client_id\}"/,
  'Signed Google server client ID must exactly match the ignored local overlay',
)
assert.match(
  developmentArchiveVerifier,
  /require_url_schemes_exact "\$\{phone_plist\}" "\$\{expected_meta_url_scheme\}" "\$\{google_callback\}"/,
  'Signed callback set must exactly match the selected environment and ignored local overlay',
)
assert.match(
  developmentArchiveVerifier,
  /require_plist_equal "\$\{phone_plist\}" MWDAT:MetaAppID "\$\{meta_app_id\}"/,
  'Signed Meta app ID must exactly match the ignored local overlay',
)
assert.match(
  developmentArchiveVerifier,
  /require_plist_equal "\$\{phone_plist\}" MWDAT:ClientToken "\$\{meta_client_token\}"/,
  'Signed Meta client token must exactly match the ignored local overlay',
)
for (const secretName of [
  'google_client_id',
  'google_server_client_id',
  'google_callback',
  'meta_app_id',
  'meta_client_token',
]) {
  assert.doesNotMatch(
    developmentArchiveVerifier,
    new RegExp(`(?:echo|printf)[^\\n]*\\$\\{${secretName}\\}`),
    `Development archive verifier must never print ${secretName}`,
  )
}

console.log('Apple development/production environment split contract passed')
