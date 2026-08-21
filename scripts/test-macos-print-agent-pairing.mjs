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
assert.equal(result.credentialInput, 'secure_macos_keychain_pairing_grant_prompt')
assert.equal(result.primaryPairingSecret, 'cppair.v1')
assert.equal(result.legacyManualCompatibility, 'cpprint.v1')
assert.equal(result.printerPort, 9100)
assert.equal(result.printerProbe, 'not_run_dry_run')
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
const pairingPromptOrder = [
  "'ClawPilot URL'",
  "'Unique workspace / printer instance name'",
  "'Printer hostname or IP (stored only on this Mac)'",
  "'Raw printer port'",
]
for (let index = 1; index < pairingPromptOrder.length; index += 1) {
  assert.ok(
    pairingSource.indexOf(pairingPromptOrder[index - 1])
      < pairingSource.indexOf(pairingPromptOrder[index]),
    `Local setup must prompt for ${pairingPromptOrder[index - 1]} before ${pairingPromptOrder[index]}`,
  )
}
assert.ok(
  pairingSource.indexOf('await probePrinter(plan.printerHost, plan.printerPort)')
    < pairingSource.indexOf('await storeRuntimeCredential({'),
  'The local Zebra endpoint must be probed before the cppair grant reaches Keychain',
)
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
  'Download developer preview',
  'Developer-only local printing preview',
  'Verified Print Agent release unavailable',
  'ClawPilot Print Agent v',
  'Download for macOS',
  'Download for Windows',
  'Configure network printer',
  'Local print service',
  'View local agent status',
  'Background LAN print agent',
  'Web app download / manual print',
  'Create pairing code',
  'Finish pairing in the Print Agent',
  'Waiting for connection',
  'Refresh connection status',
  'Configure printers',
  'Pair another workspace',
  'Keep the installed app',
  'credential-free',
  'private network IPv4 address and raw port 9100',
  'never sent to ClawPilot',
  'raw-network ZPL preview',
  'unsigned and not notarized',
  'never distribute to operators',
  'One-time pairing code',
  'Copy Mac pairing command',
  'Local device reference:',
  'View Print Agent status',
  'The app probes',
  'reachability without sending printer bytes or claiming a job',
  'Use Test',
  'Leave the computer on and signed in',
  'Browser download/manual print opens or downloads the document for an operator',
  'cannot send',
  'raw TCP to a Zebra hostname/IP',
  'System service (not implemented)',
  'reserved schema value only',
  'runs in the signed-in user&apos;s background tray',
]) assert.ok(panel.includes(text), `Printer pairing UI is missing: ${text}`)
for (const fragment of [
  "const MACOS_PRINT_AGENT_DOWNLOAD_PATH = '/downloads/ClawPilot-Print-Agent-macOS.zip'",
  "const MACOS_PRINT_AGENT_DOWNLOAD_NAME = 'ClawPilot-Print-Agent-macOS.zip'",
  'const MACOS_PRINT_AGENT_CHECKSUM_PATH = `${MACOS_PRINT_AGENT_DOWNLOAD_PATH}.sha256`',
  "const MACOS_PRINT_AGENT_MANIFEST_PATH = '/downloads/ClawPilot-Print-Agent-macOS.json'",
  "process.env.NEXT_PUBLIC_ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW === 'true'",
  'function DeveloperPrintAgentDownloadButton()',
  'if (!ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW) return null',
  'href={MACOS_PRINT_AGENT_DOWNLOAD_PATH}',
  'download={MACOS_PRINT_AGENT_DOWNLOAD_NAME}',
  'href={MACOS_PRINT_AGENT_CHECKSUM_PATH}',
  'manifest.sha256.slice(0, 12)',
  "manifest.distributionAudience === 'developers-only'",
  'manifest.customerReleaseReady === false',
  "manifest.deliveryBackend === 'raw-network-zpl'",
  'const PRINT_AGENT_HEARTBEAT_RECENT_MS = 30_000',
  'printers.generatedAt',
  'agents.generatedAt',
  "? 'Agent connected'",
  "? 'Connected'",
  "'Agent offline'",
  "'Seen before'",
]) assert.ok(panel.includes(fragment), `Print-agent download UI is missing: ${fragment}`)
assert.ok(
  panel.indexOf('Download developer preview') < panel.indexOf('One-time pairing code'),
  'The developer helper must be obtained before the one-time pairing code',
)
assert.ok(
  panel.indexOf('Download for macOS') < panel.indexOf('One-time pairing code'),
  'The verified customer installer must be offered before the one-time pairing code',
)
assert.equal(
  panel.match(/href=\{MACOS_PRINT_AGENT_DOWNLOAD_PATH\}/g)?.length,
  1,
  'All preview downloads must flow through the default-off developer-only button',
)
assert.ok(panel.includes('open={printAgentSetupReady && Boolean(enrollForm)}'))
assert.ok(panel.includes('open={printAgentSetupReady && Boolean(pairingGrant?.pairingCode)}'))
assert.ok(!panel.includes('Control-click'), 'Customer UI must never present Gatekeeper bypass as setup')
assert.ok(!panel.includes('choose Open'), 'Customer UI must never present Gatekeeper bypass as setup')
const exampleEnv = read('.env.example')
assert.ok(exampleEnv.includes('# NEXT_PUBLIC_ENABLE_DEVELOPER_PRINT_AGENT_PREVIEW=false'))
assert.ok(exampleEnv.includes('Leave disabled for every'))
const webSetupOrder = [
  '2. Enter the local Zebra connection',
  '3. Copy the one-time pairing code',
  '4. Finish pairing in the Print Agent',
]
for (let index = 1; index < webSetupOrder.length; index += 1) {
  assert.ok(
    panel.indexOf(webSetupOrder[index - 1]) < panel.indexOf(webSetupOrder[index]),
    `Web setup must present ${webSetupOrder[index - 1]} before ${webSetupOrder[index]}`,
  )
}
for (const fragment of [
  "action: 'create-pairing-grant'",
  'result.pairingGrant.pairingCode',
  'pairingGrant?.pairingCode',
  'pairingGrant?.expiresAt',
  'the prior code cannot be recovered',
]) assert.ok(panel.includes(fragment), `Short-lived pairing-grant UI is missing: ${fragment}`)
for (const forbidden of [
  'result.credential',
  'setCredential(',
  "'rotate-credential'",
  'cpprint.v1',
]) assert.ok(!panel.includes(forbidden), `Web pairing UI exposes a legacy credential path: ${forbidden}`)
assert.ok(
  !/href=\{?[^\n}]*(?:credential|token)/i.test(panel),
  'A credential or token must never be placed in a print-agent download link',
)
assert.ok(!panel.includes('label="Printer IP"'), 'Hosted printer setup must not collect an IP')

const printerRoute = read('app_src/app/api/operations/printers/route.ts')
assert.ok(!printerRoute.includes("'printerHost'"), 'Hosted printer API must not accept a local endpoint')
assert.ok(!printerRoute.includes("'printerIp'"), 'Hosted printer API must not accept a local endpoint')

const manager = read('scripts/manage-macos-print-agent.mjs')
for (const text of [
  'Pairing complete. The Zebra hostname/IP and raw port were reachable',
  'no label was printed and no ClawPilot print job was claimed',
  'same physical Zebra in another workspace',
]) assert.ok(manager.includes(text), `Local manager handoff is missing: ${text}`)

const persistence = read('app_src/lib/persistence/operationPrintDelivery.ts')
for (const fragment of [
  'normalizeOperationsLocalDeviceReference',
  'local-device.legacy.v1.redacted',
]) assert.ok(persistence.includes(fragment), `Device-reference privacy contract missing: ${fragment}`)

process.stdout.write('macOS print-agent pairing and hosted privacy contracts passed\n')
