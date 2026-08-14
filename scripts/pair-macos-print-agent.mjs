#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { normalizedLocalPrinterEndpoint } from './lib/local-print-device.mjs'
import {
  beginMacPrintPairingTransaction,
  completeMacPrintPairingTransaction,
  rollbackMacPrintPairingTransaction,
} from './lib/macos-print-agent-pairing.mjs'

const args = process.argv.slice(2)
const values = new Map()
const flags = new Set()
for (let index = 0; index < args.length; index += 1) {
  const value = args[index]
  if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`)
  if (['--dry-run', '--help', '-h'].includes(value)) {
    flags.add(value)
    continue
  }
  if (value.toLowerCase().includes('credential') || value.toLowerCase().includes('password')) {
    throw new Error('The one-time credential cannot be supplied through command arguments')
  }
  const next = args[index + 1]
  if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`)
  values.set(value, next)
  index += 1
}

if (flags.has('--help') || flags.has('-h')) {
  process.stdout.write(`Pair a Mac with a ClawPilot local print agent

The command prompts locally for a unique workspace/instance name, printer
hostname or IP address, raw printer port, and the one-time agent credential.
The hostname/IP remains in the local LaunchAgent configuration and is never
sent to the hosted printer-configuration API.

Optional:
  --base-url            ClawPilot deployment URL
  --instance-name       Unique local workspace/device instance name
  --printer-host        Local printer hostname or IP (prefer the prompt)
  --printer-port        Raw printer port (default 9100)
  --dry-run             Validate a plan without probing, Keychain, or install

The credential cannot be supplied through command arguments or environment
options. macOS Keychain prompts for it without placing it in argv, logs, or
shell history.
`)
  process.exit(0)
}

function safeName(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized || normalized.length > 64) {
    throw new Error('The instance name must contain 1 to 64 letters or numbers')
  }
  return normalized
}

function baseUrl(value) {
  const parsed = new URL(String(value || '').trim())
  if (
    parsed.protocol !== 'https:'
    && parsed.hostname !== '127.0.0.1'
    && parsed.hostname !== 'localhost'
  ) {
    throw new Error('The ClawPilot base URL must use HTTPS outside local development')
  }
  return parsed.origin
}

function port(value) {
  const parsed = Number(value || 9_100)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('The printer port must be an integer from 1 to 65535')
  }
  return parsed
}

async function promptValue(reader, label, current, fallback = '') {
  if (current) return String(current).trim()
  if (!process.stdin.isTTY) throw new Error(`${label} is required in an interactive terminal`)
  const suffix = fallback ? ` [${fallback}]` : ''
  const answer = String(await reader.question(`${label}${suffix}: `)).trim()
  return answer || fallback
}

async function probePrinter(host, printerPort, timeoutMs = 3_000) {
  await new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host, port: printerPort })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise()
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('The local printer connection timed out'))
    })
    socket.once('error', () => {
      reject(new Error('The local printer could not be reached'))
    })
  })
}

function keychainItemExists(service, account) {
  return spawnSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', service, '-a', account],
    { stdio: 'ignore' },
  ).status === 0
}

function deleteKeychainItem(service, account) {
  spawnSync(
    '/usr/bin/security',
    ['delete-generic-password', '-s', service, '-a', account],
    { stdio: 'ignore' },
  )
}

function addCredentialToKeychain(service, account) {
  process.stdout.write(
    'Paste the one-time ClawPilot agent credential at the secure macOS Keychain prompt.\n',
  )
  const result = spawnSync(
    '/usr/bin/security',
    ['add-generic-password', '-s', service, '-a', account, '-w'],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error('The credential was not stored in macOS Keychain')
  const credential = execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', service, '-a', account, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
  if (!/^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i.test(credential)) {
    deleteKeychainItem(service, account)
    throw new Error('The stored value is not a valid one-time ClawPilot agent credential')
  }
}

const reader = createInterface({ input: process.stdin, output: process.stdout })
let plan
try {
  const configuredBaseUrl = baseUrl(await promptValue(
    reader,
    'ClawPilot URL',
    values.get('--base-url'),
    'https://dev.aiapp.eigenracing.com',
  ))
  const instanceName = await promptValue(
    reader,
    'Unique workspace / printer instance name',
    values.get('--instance-name'),
  )
  const slug = safeName(instanceName)
  const printerHost = await promptValue(
    reader,
    'Printer hostname or IP (stored only on this Mac)',
    values.get('--printer-host'),
  )
  const printerPort = port(await promptValue(
    reader,
    'Raw printer port',
    values.get('--printer-port'),
    '9100',
  ))
  normalizedLocalPrinterEndpoint(printerHost, printerPort)
  const deploymentSlug = new URL(configuredBaseUrl).hostname
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const keychainService = `com.clawpilot.print-agent.${deploymentSlug}.${slug}`
  const keychainAccount = slug
  const label = `com.clawpilot.print-agent.${slug}`
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  const runtimeDirectory = path.join(
    os.homedir(),
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
  const deviceKeyPath = path.join(runtimeDirectory, 'device-reference.key')
  plan = {
    configuredBaseUrl,
    instanceName,
    slug,
    printerHost,
    printerPort,
    keychainService,
    keychainAccount,
    label,
    plistPath,
    runtimeDirectory,
    runtimePath,
    runtimeLibraryDirectory,
    runtimeDeviceHelperPath,
    runtimeDeliveryHelperPath,
    ledgerPath,
    deviceKeyPath,
  }
} finally {
  reader.close()
}

if (flags.has('--dry-run')) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action: 'validated',
    instanceName: plan.instanceName,
    label: plan.label,
    baseUrl: plan.configuredBaseUrl,
    printerPort: plan.printerPort,
    printerEndpointStorage: 'local_launch_agent_only',
    credentialInput: 'secure_macos_keychain_prompt',
    keychainService: plan.keychainService,
    keychainAccount: plan.keychainAccount,
  })}\n`)
  process.exit(0)
}

if (process.platform !== 'darwin') {
  throw new Error('Mac pairing requires macOS')
}
if (existsSync(plan.plistPath)) {
  throw new Error('That local instance name is already installed; choose a unique workspace instance name')
}
if (keychainItemExists(plan.keychainService, plan.keychainAccount)) {
  throw new Error('That local instance name already has a Keychain credential; choose a unique workspace instance name')
}

const pairingTransaction = beginMacPrintPairingTransaction({
  runtimeDirectory: plan.runtimeDirectory,
  plistPath: plan.plistPath,
  managedRuntimePaths: [
    plan.runtimePath,
    plan.runtimeDeviceHelperPath,
    plan.runtimeDeliveryHelperPath,
  ],
  managedRuntimeDirectories: [plan.runtimeLibraryDirectory],
  durableStatePaths: [plan.ledgerPath, plan.deviceKeyPath],
})
let credentialStored = false
try {
  await probePrinter(plan.printerHost, plan.printerPort)
  addCredentialToKeychain(plan.keychainService, plan.keychainAccount)
  credentialStored = true
  const installer = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'install-macos-print-agent.mjs',
  )
  execFileSync(process.execPath, [
    installer,
    '--name',
    plan.instanceName,
    '--base-url',
    plan.configuredBaseUrl,
    '--printer-host',
    plan.printerHost,
    '--printer-port',
    String(plan.printerPort),
    '--keychain-service',
    plan.keychainService,
    '--keychain-account',
    plan.keychainAccount,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  completeMacPrintPairingTransaction(pairingTransaction)
} catch (error) {
  const rollback = rollbackMacPrintPairingTransaction(pairingTransaction)
  if (credentialStored && rollback.cleaned) {
    deleteKeychainItem(plan.keychainService, plan.keychainAccount)
  }
  if (!rollback.cleaned) {
    process.stderr.write(
      `Pairing failed; local print state was preserved (${rollback.reason}). Choose a unique instance name or recover the retained instance.\n`,
    )
  }
  throw error
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  action: 'paired',
  instanceName: plan.instanceName,
  label: plan.label,
  printerEndpointStorage: 'local_launch_agent_only',
})}\n`)
