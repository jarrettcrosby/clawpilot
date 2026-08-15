#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { copyFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const options = new Map()
const flags = new Set()
for (let index = 0; index < args.length; index += 1) {
  const value = args[index]
  if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`)
  if (['--dry-run', '--uninstall', '--help', '-h'].includes(value)) {
    flags.add(value)
    continue
  }
  const next = args[index + 1]
  if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`)
  options.set(value, next)
  index += 1
}

if (flags.has('--help') || flags.has('-h')) {
  process.stdout.write(`Install the ClawPilot macOS local print agent

Required:
  --name                 Stable local agent name
  --base-url             ClawPilot deployment URL
  --printer-host         Verified Zebra hostname or IP
  --keychain-service     macOS Keychain service containing the credential
  --keychain-account     macOS Keychain account containing the credential

Optional:
  --printer-port         Raw printer port (default 9100)
  --poll-ms              Claim polling interval (default 2000)
  --dry-run              Validate and render the plist without installing
  --uninstall            Stop and remove this named LaunchAgent

The credential must already exist in Keychain. It is never written to the
LaunchAgent property list or copied into the runtime directory.
`)
  process.exit(0)
}

function required(name) {
  const value = String(options.get(name) || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveInteger(name, fallback, maximum = 65_535) {
  const raw = String(options.get(name) || fallback)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`)
  }
  return value
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function safeName(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized || normalized.length > 64) {
    throw new Error('--name must contain 1 to 64 letters or numbers')
  }
  return normalized
}

function validateBaseUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('--base-url must use HTTPS outside local development')
  }
  return url.origin
}

const name = required('--name')
const slug = safeName(name)
const home = os.homedir()
const label = `com.clawpilot.print-agent.${slug}`
const launchAgentsDirectory = path.join(home, 'Library', 'LaunchAgents')
const plistPath = path.join(launchAgentsDirectory, `${label}.plist`)
const runtimeDirectory = path.join(
  home,
  'Library',
  'Application Support',
  'ClawPilot',
  'print-agent',
  slug,
)
const runtimePath = path.join(runtimeDirectory, 'run-local-print-agent.mjs')
const runtimeLibraryDirectory = path.join(runtimeDirectory, 'lib')
const runtimeDeviceHelperPath = path.join(runtimeLibraryDirectory, 'local-print-device.mjs')
const runtimeDeliveryHelperPath = path.join(runtimeLibraryDirectory, 'submit-raw-print.mjs')
const ledgerPath = path.join(runtimeDirectory, 'claim-ledger.json')
const logsDirectory = path.join(home, 'Library', 'Logs', 'ClawPilot')
const stdoutPath = path.join(logsDirectory, `${slug}.log`)
const stderrPath = path.join(logsDirectory, `${slug}.error.log`)
const sourceRuntime = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'run-local-print-agent.mjs',
)
const sourceDeviceHelper = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'lib',
  'local-print-device.mjs',
)
const sourceDeliveryHelper = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'lib',
  'submit-raw-print.mjs',
)
const userDomain = `gui/${process.getuid()}`

if (flags.has('--uninstall')) {
  try {
    execFileSync('/bin/launchctl', ['bootout', userDomain, plistPath], {
      stdio: 'ignore',
    })
  } catch {
    // A stopped or previously removed service needs no further action.
  }
  if (existsSync(plistPath)) {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(plistPath)
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action: 'uninstalled',
    label,
    plistPath,
  })}\n`)
  process.exit(0)
}

const baseUrl = validateBaseUrl(required('--base-url'))
const printerHost = required('--printer-host')
const keychainService = required('--keychain-service')
const keychainAccount = required('--keychain-account')
const printerPort = positiveInteger('--printer-port', 9_100)
const pollMs = positiveInteger('--poll-ms', 2_000, 300_000)
const nodePath = existsSync('/opt/homebrew/bin/node')
  ? '/opt/homebrew/bin/node'
  : process.execPath

const environment = {
  CLAWPILOT_PRINT_AGENT_URL: baseUrl,
  CLAWPILOT_PRINT_AGENT_KEYCHAIN_SERVICE: keychainService,
  CLAWPILOT_PRINT_AGENT_KEYCHAIN_ACCOUNT: keychainAccount,
  CLAWPILOT_PRINTER_HOST: printerHost,
  CLAWPILOT_PRINTER_PORT: String(printerPort),
  CLAWPILOT_PRINT_AGENT_POLL_MS: String(pollMs),
  CLAWPILOT_PRINT_AGENT_LEDGER: ledgerPath,
}

const environmentXml = Object.entries(environment).map(([key, value]) => `
      <key>${xml(key)}</key>
      <string>${xml(value)}</string>`).join('')

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(runtimePath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>${environmentXml}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(runtimeDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`

if (flags.has('--dry-run')) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action: 'validated',
    label,
    plistPath,
    runtimePath,
    runtimeDeviceHelperPath,
    runtimeDeliveryHelperPath,
    ledgerPath,
    credentialEmbedded: plist.includes('cpprint.v1.'),
    printerEndpointStorage: 'local_launch_agent_only',
    plist,
  })}\n`)
  process.exit(0)
}

if (
  !existsSync(sourceRuntime)
  || !existsSync(sourceDeviceHelper)
  || !existsSync(sourceDeliveryHelper)
) {
  throw new Error('The local print-agent runtime is missing')
}
execFileSync(
  '/usr/bin/security',
  ['find-generic-password', '-s', keychainService, '-a', keychainAccount, '-w'],
  { stdio: ['ignore', 'ignore', 'ignore'] },
)

mkdirSync(launchAgentsDirectory, { recursive: true, mode: 0o700 })
mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
mkdirSync(runtimeLibraryDirectory, { recursive: true, mode: 0o700 })
mkdirSync(logsDirectory, { recursive: true, mode: 0o700 })
copyFileSync(sourceRuntime, runtimePath)
copyFileSync(sourceDeviceHelper, runtimeDeviceHelperPath)
copyFileSync(sourceDeliveryHelper, runtimeDeliveryHelperPath)
chmodSync(runtimePath, 0o755)
chmodSync(runtimeDeviceHelperPath, 0o644)
chmodSync(runtimeDeliveryHelperPath, 0o755)
writeFileSync(plistPath, plist, { mode: 0o600 })

try {
  execFileSync('/bin/launchctl', ['bootout', userDomain, plistPath], {
    stdio: 'ignore',
  })
} catch {
  // First install has no prior service to stop.
}
execFileSync('/bin/launchctl', ['bootstrap', userDomain, plistPath], {
  stdio: 'ignore',
})

process.stdout.write(`${JSON.stringify({
  ok: true,
  action: 'installed',
  label,
  plistPath,
  runtimePath,
  ledgerPath,
  stdoutPath,
  stderrPath,
  printerEndpointStorage: 'local_launch_agent_only',
})}\n`)
