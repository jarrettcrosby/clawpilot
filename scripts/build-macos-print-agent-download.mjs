#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeterministicZip } from './lib/deterministic-zip.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputArgumentIndex = process.argv.indexOf('--output')
const outputPath = outputArgumentIndex === -1
  ? path.join(root, 'app_src', 'public', 'downloads', 'ClawPilot-Print-Agent-macOS.zip')
  : path.resolve(process.argv[outputArgumentIndex + 1] || '')
if (!outputPath) throw new Error('--output requires a path')

const archiveRoot = 'ClawPilot Print Agent'
const version = '0.1.0-preview.3'
const runtimeFiles = [
  'install-macos-print-agent.mjs',
  'manage-macos-print-agent.mjs',
  'pair-macos-print-agent.mjs',
  'run-local-print-agent.mjs',
  'lib/local-print-device.mjs',
  'lib/macos-print-agent-credential.mjs',
  'lib/macos-print-agent-pairing.mjs',
  'lib/submit-raw-print.mjs',
]

const command = `#!/bin/bash
set -u

AGENT_DOWNLOAD_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_EXECUTABLE=""
for CANDIDATE in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ]; then
    NODE_EXECUTABLE="$CANDIDATE"
    break
  fi
done

if [ -z "$NODE_EXECUTABLE" ]; then
  echo "ClawPilot Print Agent requires Node.js 20 or newer on this Mac."
  echo "Install Node.js from https://nodejs.org, then open this file again."
  read -r -p "Press Return to close..."
  exit 1
fi

NODE_MAJOR="$($NODE_EXECUTABLE -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ClawPilot Print Agent requires Node.js 20 or newer."
  echo "This Mac is using Node.js $($NODE_EXECUTABLE --version)."
  read -r -p "Press Return to close..."
  exit 1
fi

"$NODE_EXECUTABLE" "$AGENT_DOWNLOAD_DIR/runtime/manage-macos-print-agent.mjs"
RESULT=$?
echo
read -r -p "Press Return to close..."
exit "$RESULT"
`

const readme = `ClawPilot Print Agent for macOS
==================================

Version ${version}

DEVELOPER-ONLY PREVIEW — NOT FOR OPERATOR OR CUSTOMER DISTRIBUTION

This unsigned preview exercises ClawPilot's first-party raw-ZPL local print
service on controlled development Macs. It supports a network Zebra-compatible
printer reachable by hostname or IP on raw TCP port 9100. It does not support
USB-only printers, PDF/PNG, office documents, Windows, or arbitrary printer
drivers.

Download first, then finish web setup
-------------------------------------

1. Download and extract this credential-free ZIP.
2. Open "ClawPilot Print Agent.command" and choose "Pair a workspace and
   printer" so the local endpoint prompts are ready.
3. In the ClawPilot web app, open Operations > Printing > Agents.
4. Create a short-lived pairing code for the exact workspace and warehouse.
5. Keep the code dialog open while pairing this Mac.

Install or pair
---------------

1. This preview requires Node.js 20 or newer from https://nodejs.org.
2. Extract the ZIP.
3. Open "ClawPilot Print Agent.command" only on a controlled development Mac.
4. Choose "Pair a workspace and printer".
5. Enter a unique workspace/printer instance name, the printer hostname or IP,
   and its raw port (normally 9100).
6. The helper tests raw endpoint reachability without printing or claiming a
   ClawPilot job.
7. Paste the short-lived cppair code only at the macOS Keychain prompt.

Gatekeeper may block this unsigned preview. Do not bypass or disable Gatekeeper
on an operator/customer Mac. Customer setup remains unavailable until the
native application is Developer ID signed and Apple notarized.

The helper redeems the short-lived pairing code over HTTPS and atomically
replaces it in macOS Keychain with the long-lived runtime credential. Neither
secret is put in the LaunchAgent property list, command arguments, logs, or
this download. Direct entry of a cpprint runtime credential exists only for
explicit legacy/manual compatibility and is not the normal web workflow. The
printer hostname or IP remains in the local LaunchAgent and is not sent to
ClawPilot's hosted printer-configuration API. The hosted service receives only
an opaque local device reference after acknowledged delivery.

Multiple workspaces may use the same physical printer. Pair each workspace's
web-enrolled agent as a separate, uniquely named local instance. Writes to the
same endpoint are serialized by an operating-system lock.

Test, stop, uninstall, or re-pair
---------------------------------

Open the same .command file again. Its menu can test LaunchAgent/runtime/
Keychain presence and raw printer reachability without printing a label or
claiming a job. Uninstall stops and removes only the selected LaunchAgent. It
intentionally preserves the Keychain item, device key, and delivery ledger so
lost acknowledgements or uncertain physical output cannot cause a duplicate.

For a new credential, revoke or rotate the prior web agent, uninstall its local
LaunchAgent, create a new short-lived pairing code, and pair a new unique
instance. Retained state is not silently deleted or reused.

Distribution status
-------------------

This developer-only macOS preview ZIP is not code-signed or notarized. It is
not a .pkg or a native .app and is intentionally hidden from normal ClawPilot
operator setup. A Developer ID signed and Apple-notarized native app can
replace this preview without changing ClawPilot's web enrollment, credential,
ledger, claim fencing, or device-privacy contracts.
`

const entries = [
  {
    path: `${archiveRoot}/ClawPilot Print Agent.command`,
    content: command,
    mode: 0o755,
  },
  {
    path: `${archiveRoot}/README.txt`,
    content: readme,
    mode: 0o644,
  },
  {
    path: `${archiveRoot}/VERSION.txt`,
    content: `${version}\n`,
    mode: 0o644,
  },
  ...runtimeFiles.map((relativePath) => ({
    path: `${archiveRoot}/runtime/${relativePath}`,
    content: readFileSync(path.join(root, 'scripts', relativePath)),
    mode: relativePath.startsWith('lib/') ? 0o644 : 0o755,
  })),
]

const archive = createDeterministicZip(entries)
const archiveText = archive.toString('utf8')
const sha256 = createHash('sha256').update(archive).digest('hex')
const checksumPath = `${outputPath}.sha256`
const manifestPath = outputPath.replace(/\.zip$/i, '.json')
const artifactHref = `/downloads/${path.basename(outputPath)}`
const checksumHref = `${artifactHref}.sha256`
const manifest = {
  schemaVersion: 1,
  version,
  platform: 'macos',
  architecture: 'node-runtime-portable',
  artifactHref,
  filename: path.basename(outputPath),
  byteLength: archive.byteLength,
  sha256,
  checksumHref,
  credentialEmbedded: false,
  releaseChannel: 'developer-preview',
  distributionAudience: 'developers-only',
  customerReleaseReady: false,
  signed: false,
  notarized: false,
  requiresDeveloperIdSigning: true,
  requiresAppleNotarization: true,
  nodeMinimumMajor: 20,
  nodeRuntimeBundled: false,
  deliveryBackend: 'raw-network-zpl',
}
mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o755 })
writeFileSync(outputPath, archive, { mode: 0o644 })
writeFileSync(checksumPath, `${sha256}  ${path.basename(outputPath)}\n`, { mode: 0o644 })
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
process.stdout.write(`${JSON.stringify({
  ok: true,
  version,
  outputPath,
  checksumPath,
  manifestPath,
  artifactHref,
  checksumHref,
  filename: path.basename(outputPath),
  byteLength: archive.byteLength,
  sha256,
  credentialEmbedded: /cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/i.test(archiveText),
  releaseChannel: 'developer-preview',
  distributionAudience: 'developers-only',
  customerReleaseReady: false,
  signed: false,
  notarized: false,
  nodeRuntimeBundled: false,
})}\n`)
