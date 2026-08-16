import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function legacyMacPrintAgentInstances({
  platform = process.platform,
  homeDirectory = os.homedir(),
} = {}) {
  if (platform !== 'darwin') return []
  const launchAgentsDirectory = path.join(homeDirectory, 'Library', 'LaunchAgents')
  if (!existsSync(launchAgentsDirectory)) return []
  return readdirSync(launchAgentsDirectory, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile()
      && /^com\.clawpilot\.print-agent\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.plist$/.test(entry.name)
    ))
    .map((entry) => entry.name
      .slice('com.clawpilot.print-agent.'.length, -'.plist'.length))
    .sort((left, right) => left.localeCompare(right, 'en'))
}

export function assertLegacyMacMigrationComplete(instances) {
  if (!Array.isArray(instances) || instances.some((entry) => typeof entry !== 'string')) {
    throw new Error('Legacy Mac print-agent detection returned invalid state')
  }
  if (instances.length === 0) return
  throw new Error(
    `Legacy Mac print-agent service${instances.length === 1 ? '' : 's'} detected (${instances.join(', ')}). The older runtime does not share the native app's duplicate-print fences. In ClawPilot, first verify there is no in-flight or pending work. Then reopen the older “ClawPilot Print Agent.command” manager and choose “3. Stop and uninstall an instance” for each listed service. That safe step removes the LaunchAgent property list while retaining its Keychain credential, device key, and delivery ledger for rollback. Reopen this app after the property lists are gone. Pair the same Zebra private LAN IP and port, run the no-print connection test, and print exactly one controlled UPS sandbox label. Do not revoke the old server enrollment until the native app has acknowledged that label. Before any native claim, rollback remains available through the retained legacy state. This app will not stop, uninstall, or revoke legacy services automatically.`,
  )
}
