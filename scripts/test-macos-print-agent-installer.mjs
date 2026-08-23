#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const output = execFileSync(process.execPath, [
  'scripts/install-macos-print-agent.mjs',
  '--dry-run',
  '--name',
  'FHMXLAB35 Zebra',
  '--base-url',
  'https://dev.aiapp.eigenracing.com',
  '--printer-host',
  'FHMXLAB35.local',
  '--keychain-service',
  'com.clawpilot.print-agent.dev',
  '--keychain-account',
  'FHMXLAB35',
], { encoding: 'utf8' })

const result = JSON.parse(output)
assert.equal(result.ok, true)
assert.equal(result.action, 'validated')
assert.equal(result.label, 'com.clawpilot.print-agent.fhmxlab35-zebra')
assert.equal(result.credentialEmbedded, false)
assert.equal(result.printerEndpointStorage, 'local_launch_agent_only')
assert.match(result.plist, /CLAWPILOT_PRINT_AGENT_KEYCHAIN_SERVICE/)
assert.match(result.plist, /FHMXLAB35\.local/)
assert.doesNotMatch(result.plist, /CLAWPILOT_PRINT_AGENT_CREDENTIAL/)
assert.doesNotMatch(result.plist, /cpprint\.v1\./)
assert.match(result.runtimePath, /Application Support\/ClawPilot\/print-agent/)
assert.match(result.runtimeDeviceHelperPath, /print-agent.*lib\/local-print-device\.mjs/)
assert.match(result.runtimeDeliveryHelperPath, /print-agent.*lib\/submit-raw-print\.mjs/)
if (process.platform === 'darwin') {
  const expectedNodePath = existsSync('/opt/homebrew/bin/node')
    ? '/opt/homebrew/bin/node'
    : process.execPath
  assert.match(result.plist, new RegExp(`<string>${expectedNodePath}</string>`))
}

process.stdout.write('macOS print-agent installer contracts passed\n')
