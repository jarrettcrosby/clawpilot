#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  beginMacPrintPairingTransaction,
  rollbackMacPrintPairingTransaction,
} from './lib/macos-print-agent-pairing.mjs'

function read(file) {
  return readFileSync(file, 'utf8')
}

const host = '192.0.2.55'
const output = execFileSync(process.execPath, [
  'scripts/pair-macos-print-agent.mjs',
  '--dry-run',
  '--base-url',
  'https://dev.aiapp.eigenracing.com',
  '--instance-name',
  'Test Pro Bakery Bites Zebra',
  '--printer-host',
  host,
  '--printer-port',
  '9100',
], { encoding: 'utf8' })
const result = JSON.parse(output)
assert.equal(result.ok, true)
assert.equal(result.action, 'validated')
assert.equal(result.label, 'com.clawpilot.print-agent.test-pro-bakery-bites-zebra')
assert.equal(result.printerEndpointStorage, 'local_launch_agent_only')
assert.equal(result.credentialInput, 'secure_macos_keychain_prompt')
assert.equal(result.printerPort, 9100)
assert.ok(!output.includes(host), 'Dry-run output must not disclose the local printer endpoint')
assert.ok(!output.includes('cpprint.v1.'), 'Pairing output must never contain a credential')

const productionResult = JSON.parse(execFileSync(process.execPath, [
  'scripts/pair-macos-print-agent.mjs',
  '--dry-run',
  '--base-url',
  'https://aiapp.eigenracing.com',
  '--instance-name',
  'Test Pro Bakery Bites Zebra',
  '--printer-host',
  host,
  '--printer-port',
  '9100',
], { encoding: 'utf8' }))
assert.equal(productionResult.label, result.label)
assert.notEqual(
  productionResult.keychainService,
  result.keychainService,
  'Keychain identities must remain deployment scoped even though a reused instance slug collides locally',
)

const help = execFileSync(process.execPath, [
  'scripts/pair-macos-print-agent.mjs',
  '--help',
], { encoding: 'utf8' })
assert.match(help, /cannot be supplied through command arguments/)
assert.match(help, /never\s+sent to the hosted printer-configuration API/)
const pairingSource = read('scripts/pair-macos-print-agent.mjs')
assert.match(pairingSource, /beginMacPrintPairingTransaction/)
assert.match(pairingSource, /rollbackMacPrintPairingTransaction/)
assert.match(pairingSource, /credentialStored && rollback\.cleaned/)
assert.ok(
  !pairingSource.includes('rmSync(plan.runtimeDirectory'),
  'Pairing must never recursively delete a retained runtime directory',
)

function transactionPaths(root, slug) {
  const runtimeDirectory = path.join(root, 'runtime', slug)
  const libraryDirectory = path.join(runtimeDirectory, 'lib')
  return {
    runtimeDirectory,
    plistPath: path.join(root, 'LaunchAgents', `com.clawpilot.print-agent.${slug}.plist`),
    managedRuntimePaths: [
      path.join(runtimeDirectory, 'run-local-print-agent.mjs'),
      path.join(libraryDirectory, 'local-print-device.mjs'),
      path.join(libraryDirectory, 'submit-raw-print.mjs'),
    ],
    managedRuntimeDirectories: [libraryDirectory],
    durableStatePaths: [
      path.join(runtimeDirectory, 'claim-ledger.json'),
      path.join(runtimeDirectory, 'device-reference.key'),
    ],
  }
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-print-pairing-'))
try {
  const retained = transactionPaths(sandbox, 'retained-uninstalled')
  mkdirSync(retained.runtimeDirectory, { recursive: true, mode: 0o700 })
  const retainedLedger = '{"version":2,"claims":{},"deliveries":{}}\n'
  const retainedDeviceKey = 'retained-device-reference-key\n'
  writeFileSync(retained.durableStatePaths[0], retainedLedger, { mode: 0o600 })
  writeFileSync(retained.durableStatePaths[1], retainedDeviceKey, { mode: 0o600 })
  assert.throws(
    () => beginMacPrintPairingTransaction(retained),
    /Retained local print-agent state exists/,
  )
  assert.equal(readFileSync(retained.durableStatePaths[0], 'utf8'), retainedLedger)
  assert.equal(readFileSync(retained.durableStatePaths[1], 'utf8'), retainedDeviceKey)

  const deploymentCollision = transactionPaths(sandbox, 'same-slug-different-deployment')
  mkdirSync(deploymentCollision.runtimeDirectory, { recursive: true, mode: 0o700 })
  const otherDeploymentLedger = '{"version":2,"claims":{"prior":{}},"deliveries":{}}\n'
  writeFileSync(deploymentCollision.durableStatePaths[0], otherDeploymentLedger, { mode: 0o600 })
  assert.throws(
    () => beginMacPrintPairingTransaction(deploymentCollision),
    /Retained local print-agent state exists/,
    'A same-slug pairing for another deployment must refuse the shared local runtime',
  )
  assert.equal(
    readFileSync(deploymentCollision.durableStatePaths[0], 'utf8'),
    otherDeploymentLedger,
  )

  const failedFresh = transactionPaths(sandbox, 'failed-fresh-pairing')
  const transaction = beginMacPrintPairingTransaction(failedFresh)
  mkdirSync(path.dirname(failedFresh.plistPath), { recursive: true, mode: 0o700 })
  mkdirSync(failedFresh.managedRuntimeDirectories[0], { recursive: true, mode: 0o700 })
  for (const candidate of failedFresh.managedRuntimePaths) {
    writeFileSync(candidate, '// pairing-owned installer artifact\n', { mode: 0o600 })
  }
  writeFileSync(failedFresh.plistPath, '<plist/>\n', { mode: 0o600 })
  assert.deepEqual(rollbackMacPrintPairingTransaction(transaction), {
    cleaned: true,
    reason: 'attempt_owned_artifacts_removed',
  })
  assert.equal(existsSync(failedFresh.runtimeDirectory), false)
  assert.equal(existsSync(failedFresh.plistPath), false)

  const becameDurable = transactionPaths(sandbox, 'durable-during-pairing')
  const durableTransaction = beginMacPrintPairingTransaction(becameDurable)
  mkdirSync(path.dirname(becameDurable.plistPath), { recursive: true, mode: 0o700 })
  writeFileSync(becameDurable.plistPath, '<plist/>\n', { mode: 0o600 })
  writeFileSync(becameDurable.durableStatePaths[0], retainedLedger, { mode: 0o600 })
  assert.deepEqual(rollbackMacPrintPairingTransaction(durableTransaction), {
    cleaned: false,
    reason: 'durable_print_state_present',
  })
  assert.equal(readFileSync(becameDurable.durableStatePaths[0], 'utf8'), retainedLedger)
  assert.equal(existsSync(becameDurable.plistPath), true)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

const panel = read('app_src/components/operations/PrinterConfigurationPanel.tsx')
for (const text of [
  'Connect on this Mac',
  'Pair another workspace',
  'The printer IP stays on this Mac',
  'Copy Mac pairing command',
  'Local device reference:',
]) assert.ok(panel.includes(text), `Printer pairing UI is missing: ${text}`)
assert.ok(!panel.includes('label="Printer IP"'), 'Hosted printer setup must not collect an IP')

const printerRoute = read('app_src/app/api/operations/printers/route.ts')
assert.ok(!printerRoute.includes("'printerHost'"), 'Hosted printer API must not accept a local endpoint')
assert.ok(!printerRoute.includes("'printerIp'"), 'Hosted printer API must not accept a local endpoint')

const persistence = read('app_src/lib/persistence/operationPrintDelivery.ts')
for (const fragment of [
  'normalizeOperationsLocalDeviceReference',
  'local-device.legacy.v1.redacted',
]) assert.ok(persistence.includes(fragment), `Device-reference privacy contract missing: ${fragment}`)

process.stdout.write('macOS print-agent pairing and hosted privacy contracts passed\n')
