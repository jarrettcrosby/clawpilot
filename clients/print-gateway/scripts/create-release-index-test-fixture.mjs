import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}
const output = path.resolve(args.get('--output') || '')
const version = String(args.get('--version') || '')
const sourceCommit = String(args.get('--source-commit') || '').toLowerCase()
if (
  !args.has('--output')
  || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)
  || !/^[a-f0-9]{40}$/.test(sourceCommit)
) {
  throw new Error('--output, exact --version, and exact 40-character --source-commit are required')
}
mkdirSync(output, { recursive: true, mode: 0o700 })
if (readdirSync(output).length !== 0) {
  throw new Error('The deterministic release-index fixture directory must be empty')
}

const definitions = [
  {
    platform: 'macos',
    architecture: 'universal',
    filename: `ClawPilot-Print-Agent-${version}-mac-universal.dmg`,
    notarized: true,
    stapled: true,
  },
  {
    platform: 'windows',
    architecture: 'x64',
    filename: `ClawPilot-Print-Agent-${version}-win-x64.exe`,
    notarized: false,
    stapled: false,
  },
]
const artifacts = definitions.map((definition) => {
  const artifactPath = path.join(output, definition.filename)
  const bytes = Buffer.from([
    'ClawPilot Print Agent release-index contract fixture',
    `version=${version}`,
    `sourceCommit=${sourceCommit}`,
    `platform=${definition.platform}`,
    '',
  ].join('\n'), 'utf8')
  writeFileSync(artifactPath, bytes, { mode: 0o600 })
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const manifest = {
    schemaVersion: 1,
    product: 'ClawPilot Print Agent',
    version,
    sourceCommit,
    platform: definition.platform,
    architecture: definition.architecture,
    filename: definition.filename,
    byteLength: statSync(artifactPath).size,
    sha256,
    signed: true,
    notarized: definition.notarized,
    stapled: definition.stapled,
    customerReleaseReady: true,
    credentialEmbedded: false,
    printerEndpointEmbedded: false,
    deliveryBackend: 'raw-network-zpl',
    manifestSignature: 'sigstore-bundle-required-before-publish',
  }
  writeFileSync(
    `${artifactPath}.artifact.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    `${artifactPath}.sha256`,
    `${sha256}  ${definition.filename}\n`,
    { mode: 0o600 },
  )
  return {
    filename: definition.filename,
    byteLength: manifest.byteLength,
    sha256,
  }
})

process.stdout.write(`${JSON.stringify({
  ok: true,
  fixtureOnly: true,
  inputDirectory: output,
  version,
  sourceCommit,
  artifacts,
})}\n`)
