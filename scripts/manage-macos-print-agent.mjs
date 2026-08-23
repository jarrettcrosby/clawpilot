#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const launchAgentsDirectory = path.join(os.homedir(), 'Library', 'LaunchAgents')
const labelPrefix = 'com.clawpilot.print-agent.'

function installedInstances() {
  if (!existsSync(launchAgentsDirectory)) return []
  return readdirSync(launchAgentsDirectory, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile()
      && entry.name.startsWith(labelPrefix)
      && entry.name.endsWith('.plist')
    ))
    .map((entry) => ({
      slug: entry.name.slice(labelPrefix.length, -'.plist'.length),
      label: entry.name.slice(0, -'.plist'.length),
      plistPath: path.join(launchAgentsDirectory, entry.name),
    }))
    .filter((entry) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(entry.slug))
    .sort((left, right) => left.slug.localeCompare(right.slug, 'en'))
}

function plistValue(plistPath, key) {
  const result = spawnSync(
    '/usr/bin/plutil',
    ['-extract', key, 'json', '-o', '-', plistPath],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  if (result.status !== 0) throw new Error('The installed LaunchAgent configuration is invalid')
  return JSON.parse(result.stdout)
}

async function chooseInstalled(reader, purpose) {
  const instances = installedInstances()
  if (instances.length === 0) {
    process.stdout.write('No installed ClawPilot print-agent instances were found on this Mac.\n')
    return null
  }
  process.stdout.write(`\nChoose the instance to ${purpose}:\n`)
  instances.forEach((instance, index) => {
    process.stdout.write(`  ${index + 1}. ${instance.slug}\n`)
  })
  const answer = String(await reader.question('Instance number: ')).trim()
  const index = Number(answer) - 1
  if (!Number.isSafeInteger(index) || !instances[index]) {
    process.stdout.write('No instance was selected.\n')
    return null
  }
  return instances[index]
}

function pairNewInstance() {
  process.stdout.write(`
Before pairing, create a short-lived Print Agent pairing code in ClawPilot's
web app. Use a unique instance name for each workspace, even
when several workspaces share the same physical printer.

The cppair code will be requested by macOS Keychain, redeemed over HTTPS, and
replaced there with the runtime credential. The printer hostname/IP
will remain on this Mac.

`)
  execFileSync(process.execPath, [
    path.join(scriptDirectory, 'pair-macos-print-agent.mjs'),
  ], { stdio: 'inherit' })
  process.stdout.write(`
Pairing complete. The Zebra hostname/IP and raw port were reachable from this
Mac; no label was printed and no ClawPilot print job was claimed. Return to
Operations > Printing > Agents to confirm Connected, then assign the agent to
the workspace's logical printer profile.

To use this same physical Zebra in another workspace, switch workspaces in
ClawPilot, create a new pairing code, and choose option 4 with a unique local
instance name. You may enter the same local hostname/IP and port.
`)
}

function serviceIsRunning(instance) {
  return spawnSync(
    '/bin/launchctl',
    ['print', `gui/${process.getuid()}/${instance.label}`],
    { stdio: 'ignore' },
  ).status === 0
}

function keychainItemExists(environment) {
  const service = String(environment.CLAWPILOT_PRINT_AGENT_KEYCHAIN_SERVICE || '')
  const account = String(environment.CLAWPILOT_PRINT_AGENT_KEYCHAIN_ACCOUNT || '')
  if (!service || !account) return false
  return spawnSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', service, '-a', account],
    { stdio: 'ignore' },
  ).status === 0
}

function testInstalledInstance(instance) {
  const environment = plistValue(instance.plistPath, 'EnvironmentVariables')
  const programArguments = plistValue(instance.plistPath, 'ProgramArguments')
  const runtimePath = String(programArguments?.[1] || '')
  const running = serviceIsRunning(instance)
  const credentialStored = keychainItemExists(environment)
  const runtimePresent = existsSync(runtimePath)
  process.stdout.write(`\nLaunchAgent: ${running ? 'running' : 'not running'}\n`)
  process.stdout.write(`Credential: ${credentialStored ? 'present in macOS Keychain' : 'missing'}\n`)
  process.stdout.write(`Runtime: ${runtimePresent ? 'installed' : 'missing'}\n`)
  if (!runtimePresent) throw new Error('The installed runtime is missing')

  const probe = spawnSync(process.execPath, [runtimePath, '--probe'], {
    env: {
      ...process.env,
      CLAWPILOT_PRINTER_HOST: String(environment.CLAWPILOT_PRINTER_HOST || ''),
      CLAWPILOT_PRINTER_PORT: String(environment.CLAWPILOT_PRINTER_PORT || '9100'),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (probe.status !== 0 || !probe.stdout.includes('printer_reachable')) {
    throw new Error('The configured printer hostname/IP and port could not be reached from this Mac')
  }
  process.stdout.write('Printer connection: reachable (no label was printed)\n')
  process.stdout.write(
    "ClawPilot authorization and last-seen status remain visible in the web app; this local test does not claim a job.\n",
  )
}

function uninstallInstance(instance) {
  execFileSync(process.execPath, [
    path.join(scriptDirectory, 'install-macos-print-agent.mjs'),
    '--uninstall',
    '--name',
    instance.slug,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  process.stdout.write(`
The ${instance.slug} LaunchAgent was stopped and removed. Its Keychain item,
device key, and delivery ledger were intentionally retained so an uncertain or
already-delivered label cannot be silently resent.

To re-pair, revoke or rotate the old Print Agent in the ClawPilot web app, then
pair a new unique workspace instance. Retained state is never deleted by this
download.
`)
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('The downloadable ClawPilot Print Agent currently supports macOS only')
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  try {
    let finished = false
    while (!finished) {
      process.stdout.write(`
ClawPilot Print Agent

  1. Pair a workspace and printer
  2. Test an installed printer connection
  3. Stop and uninstall an instance
  4. Pair another workspace or re-pair with a new instance
  5. Exit
`)
      const choice = String(await reader.question('Choose 1-5: ')).trim()
      if (choice === '1' || choice === '4') {
        pairNewInstance()
      } else if (choice === '2') {
        const instance = await chooseInstalled(reader, 'test')
        if (instance) testInstalledInstance(instance)
      } else if (choice === '3') {
        const instance = await chooseInstalled(reader, 'uninstall')
        if (instance) {
          const confirmation = String(await reader.question(
            `Type ${instance.slug} to stop this instance: `,
          )).trim()
          if (confirmation === instance.slug) uninstallInstance(instance)
          else process.stdout.write('Uninstall cancelled.\n')
        }
      } else if (choice === '5') {
        finished = true
      } else {
        process.stdout.write('Choose a number from 1 through 5.\n')
      }
    }
  } finally {
    reader.close()
  }
}

main().catch((error) => {
  process.stderr.write(`Print Agent setup stopped: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
