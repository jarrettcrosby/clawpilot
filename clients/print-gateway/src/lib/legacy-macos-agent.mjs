import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CLAWPILOT_LAUNCH_AGENT_PATTERN = /^com\.clawpilot\.print-agent\.([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.plist$/
const TAURI_LAUNCH_AGENT_NAME = 'com.printagent.app.plist'
const TAURI_EXECUTABLE_PATH = '/Applications/Print Agent.app/Contents/MacOS/print-agent'
const MAX_PROCESS_LISTING_BYTES = 1_048_576
const MAX_PROCESS_LISTING_LINES = 65_536

function systemMacProcessListing() {
  const result = spawnSync('/bin/ps', ['-axo', 'command='], {
    encoding: 'utf8',
    maxBuffer: MAX_PROCESS_LISTING_BYTES,
    timeout: 2_000,
    windowsHide: true,
  })
  if (result.error) {
    throw new Error(`Legacy Mac print-agent process detection failed: ${result.error.code || 'process listing error'}`)
  }
  if (result.signal || result.status !== 0) {
    throw new Error('Legacy Mac print-agent process detection failed')
  }
  return result.stdout
}

function normalizedProcessCommands(processListing) {
  if (typeof processListing !== 'string') {
    throw new Error('Legacy Mac print-agent process detection returned invalid state')
  }
  if (
    Buffer.byteLength(processListing, 'utf8') > MAX_PROCESS_LISTING_BYTES
    || processListing.includes('\0')
  ) {
    throw new Error('Legacy Mac print-agent process detection returned invalid state')
  }
  const commands = processListing.split(/\r?\n/)
  if (commands.length > MAX_PROCESS_LISTING_LINES) {
    throw new Error('Legacy Mac print-agent process detection returned invalid state')
  }
  return commands.map((command) => command.trim()).filter(Boolean)
}

function exactTauriProcessIsRunning(processListing) {
  return normalizedProcessCommands(processListing).some((command) => (
    command === TAURI_EXECUTABLE_PATH
    || command.startsWith(`${TAURI_EXECUTABLE_PATH} `)
  ))
}

function assertLegacyMacPrintAgentDetection(detection) {
  if (
    !detection
    || typeof detection !== 'object'
    || Array.isArray(detection)
    || !Array.isArray(detection.clawPilotInstances)
    || detection.clawPilotInstances.some((entry) => (
      typeof entry !== 'string'
      || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(entry)
    ))
    || new Set(detection.clawPilotInstances).size !== detection.clawPilotInstances.length
    || typeof detection.tauriLaunchAgentPresent !== 'boolean'
    || typeof detection.tauriProcessRunning !== 'boolean'
  ) {
    throw new Error('Legacy Mac print-agent detection returned invalid state')
  }
  return detection
}

export function legacyMacPrintAgentDetection({
  platform = process.platform,
  homeDirectory = os.homedir(),
  listProcesses = systemMacProcessListing,
} = {}) {
  if (platform !== 'darwin') {
    return {
      clawPilotInstances: [],
      tauriLaunchAgentPresent: false,
      tauriProcessRunning: false,
    }
  }
  if (typeof homeDirectory !== 'string' || !path.isAbsolute(homeDirectory)) {
    throw new Error('Legacy Mac print-agent detection returned invalid state')
  }
  if (typeof listProcesses !== 'function') {
    throw new Error('Legacy Mac print-agent process detection returned invalid state')
  }

  const launchAgentsDirectory = path.join(homeDirectory, 'Library', 'LaunchAgents')
  let entries = []
  if (existsSync(launchAgentsDirectory)) {
    entries = readdirSync(launchAgentsDirectory, { withFileTypes: true })
  }
  const clawPilotInstances = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => CLAWPILOT_LAUNCH_AGENT_PATTERN.exec(entry.name)?.[1] || null)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en'))
  const detection = {
    clawPilotInstances,
    tauriLaunchAgentPresent: existsSync(path.join(launchAgentsDirectory, TAURI_LAUNCH_AGENT_NAME)),
    tauriProcessRunning: exactTauriProcessIsRunning(listProcesses()),
  }
  return assertLegacyMacPrintAgentDetection(detection)
}

export function legacyMacPrintAgentInstances(options = {}) {
  return legacyMacPrintAgentDetection(options).clawPilotInstances
}

export function legacyMacMigrationIsBlocked(detection) {
  const state = assertLegacyMacPrintAgentDetection(detection)
  return state.clawPilotInstances.length > 0
    || state.tauriLaunchAgentPresent
    || state.tauriProcessRunning
}

export function legacyMacMigrationMessage(detection) {
  const state = assertLegacyMacPrintAgentDetection(detection)
  if (!legacyMacMigrationIsBlocked(state)) return null

  const detected = []
  const instructions = []
  if (state.tauriLaunchAgentPresent || state.tauriProcessRunning) {
    const evidence = [
      state.tauriLaunchAgentPresent ? 'auto-start LaunchAgent' : null,
      state.tauriProcessRunning ? 'running tray process' : null,
    ].filter(Boolean).join(' and ')
    detected.push(`the older Tauri “Print Agent” app (${evidence})`)
    instructions.push(
      'For the older Tauri tray app, first turn off its auto-start setting, then Quit the app. Preserve “/Applications/Print Agent.app” and “~/Library/Application Support/print-agent” with its configuration for rollback. Do not delete its LaunchAgent or configuration manually.',
    )
  }
  if (state.clawPilotInstances.length > 0) {
    detected.push(
      `legacy ClawPilot print-agent service${state.clawPilotInstances.length === 1 ? '' : 's'} (${state.clawPilotInstances.join(', ')})`,
    )
    instructions.push(
      'For each legacy ClawPilot service, reopen the older “ClawPilot Print Agent.command” manager and choose “3. Stop and uninstall an instance”. That safe action removes its LaunchAgent property list while retaining its Keychain credential, device key, and delivery ledger for rollback.',
    )
  }
  return `Legacy local printing detected: ${detected.join(' and ')}. These older runtimes do not share this app’s duplicate-print fences, so Pair, Start, and enabling start-at-login are blocked. First verify in ClawPilot that there is no in-flight or pending work. ${instructions.join(' ')} Reopen this app only after the old auto-start entries are disabled and the old processes have quit. Then pair the same Zebra private LAN IP and port, run the no-print connection test, and print exactly one controlled UPS sandbox label. Do not revoke an old server enrollment until this app has acknowledged that label. Before any native claim, rollback remains available through the retained legacy state. This app will not stop, delete, uninstall, or revoke either older runtime automatically.`
}

export function assertLegacyMacMigrationComplete(detection) {
  const message = legacyMacMigrationMessage(detection)
  if (message) throw new Error(message)
}
