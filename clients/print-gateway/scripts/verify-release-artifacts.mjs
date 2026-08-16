import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertNoConcreteSecretsInPaths,
  assertUniversalMachOPayload,
  assertWindowsX64PayloadTree,
} from '../src/lib/release-payload-verification.mjs'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}
const platform = args.get('--platform')
const directory = path.resolve(args.get('--directory') || 'dist')
const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'))
const sourceCommit = String(
  process.env.CLAWPILOT_RELEASE_SOURCE_COMMIT || process.env.GITHUB_SHA || '',
).trim().toLowerCase()
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
  throw new Error('An exact 40-character release source commit is required')
}

function execute(command, commandArgs, capture = false) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (result.error || result.status !== 0) {
    if (!capture) process.stderr.write(output)
    throw result.error || new Error(`${command} failed with exit ${result.status}`)
  }
  if (!capture && output) process.stdout.write(output)
  return output
}

async function sha256(filePath) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

function findExactlyOne(predicate, label) {
  const matches = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(directory, entry.name))
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label}, found ${matches.length}`)
  return matches[0]
}

function verifyMac() {
  const artifactPath = findExactlyOne((name) => name.endsWith('.dmg'), 'macOS DMG')
  const identity = String(process.env.MACOS_DEVELOPER_ID_APPLICATION || '').trim()
  execute('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', artifactPath])
  const dmgSignature = execute('/usr/bin/codesign', ['-d', '--verbose=4', artifactPath], true)
  if (!dmgSignature.includes(`Authority=${identity}`)) {
    throw new Error('DMG is not signed with the required Developer ID Application identity')
  }
  execute('/usr/bin/xcrun', ['stapler', 'validate', artifactPath])
  execute('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose=4',
    artifactPath,
  ])

  const mountPoint = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-gateway-dmg-'))
  try {
    execute('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, artifactPath])
    const apps = readdirSync(mountPoint).filter((name) => name.endsWith('.app'))
    if (apps.length !== 1) throw new Error(`Expected one application in DMG, found ${apps.length}`)
    const appPath = path.join(mountPoint, apps[0])
    assertNoConcreteSecretsInPaths([appPath])
    assertUniversalMachOPayload(appPath, {
      architecturesFor(filePath) {
        execute('/usr/bin/lipo', ['-verify_arch', 'x86_64', 'arm64', filePath])
        return execute('/usr/bin/lipo', ['-archs', filePath], true).trim().split(/\s+/)
      },
    })
    execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    const appSignature = execute('/usr/bin/codesign', ['-d', '--verbose=4', appPath], true)
    if (
      !appSignature.includes(`Authority=${identity}`)
      || !appSignature.includes(`TeamIdentifier=${process.env.APPLE_TEAM_ID}`)
    ) throw new Error('Application is not signed with the required Developer ID identity and team')
    if (!/flags=0x[0-9a-f]+\(runtime\)/i.test(appSignature)) {
      throw new Error('Application signature is missing the hardened-runtime flag')
    }
    const entitlements = execute('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath], true)
    for (const entitlement of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ]) {
      if (!entitlements.includes(entitlement)) {
        throw new Error(`Application signature is missing expected entitlement ${entitlement}`)
      }
    }
    execute('/usr/bin/xcrun', ['stapler', 'validate', appPath])
    execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
  } finally {
    try { execute('/usr/bin/hdiutil', ['detach', mountPoint]) } catch { /* best effort */ }
    rmSync(mountPoint, { recursive: true, force: true })
  }
  return { artifactPath, architecture: 'universal', notarized: true, stapled: true }
}

function powershellSignature(filePath) {
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${filePath.replaceAll("'", "''")}'`,
    '$result = [ordered]@{',
    "  status = [string]$signature.Status",
    "  subject = [string]$signature.SignerCertificate.Subject",
    "  thumbprint = [string]$signature.SignerCertificate.Thumbprint",
    "  timestampSubject = [string]$signature.TimeStamperCertificate.Subject",
    '}',
    '$result | ConvertTo-Json -Compress',
  ].join('; ')
  return JSON.parse(execute('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], true))
}

function assertValidWindowsSignature(filePath) {
  const signature = powershellSignature(filePath)
  const subject = String(process.env.WIN_SIGNING_SUBJECT || '').trim()
  const thumbprint = String(process.env.WIN_SIGNING_THUMBPRINT || '')
    .replaceAll(/\s/g, '')
    .toUpperCase()
  if (
    signature.status !== 'Valid'
    || signature.subject !== subject
    || !/^[A-F0-9]{40}$/.test(thumbprint)
    || String(signature.thumbprint || '').replaceAll(/\s/g, '').toUpperCase() !== thumbprint
    || !signature.timestampSubject
  ) throw new Error(`Authenticode or RFC 3161 timestamp verification failed for ${path.basename(filePath)}`)
}

function verifyWindows() {
  const artifactPath = findExactlyOne(
    (name) => name.endsWith('.exe'),
    'Windows installer',
  )
  const unpackedDirectory = path.join(directory, 'win-unpacked')
  if (!existsSync(unpackedDirectory)) throw new Error('The unpacked Windows payload is missing')
  const nativeLockHelper = path.join(
    unpackedDirectory,
    'resources',
    'runtime',
    'lib',
    'clawpilot-print-lock.exe',
  )
  if (!existsSync(nativeLockHelper)) {
    throw new Error('The native Windows endpoint-lock helper is missing from the packaged app')
  }
  assertNoConcreteSecretsInPaths([unpackedDirectory])
  const pePayloads = assertWindowsX64PayloadTree(unpackedDirectory, {
    architectureExceptions: [
      'Uninstall ClawPilot Print Agent.exe',
      'resources/elevate.exe',
    ],
  })
  for (const filePath of pePayloads) assertValidWindowsSignature(filePath)
  assertValidWindowsSignature(artifactPath)
  return { artifactPath, architecture: 'x64', notarized: false, stapled: false }
}

if (!['macos', 'windows'].includes(platform)) throw new Error('Expected --platform macos or windows')
const verified = platform === 'macos' ? verifyMac() : verifyWindows()
assertNoConcreteSecretsInPaths([verified.artifactPath])
const digest = await sha256(verified.artifactPath)
const filename = path.basename(verified.artifactPath)
const manifest = {
  schemaVersion: 1,
  product: 'ClawPilot Print Agent',
  version: packageJson.version,
  sourceCommit,
  platform,
  architecture: verified.architecture,
  filename,
  byteLength: statSync(verified.artifactPath).size,
  sha256: digest,
  signed: true,
  notarized: verified.notarized,
  stapled: verified.stapled,
  customerReleaseReady: true,
  credentialEmbedded: false,
  printerEndpointEmbedded: false,
  deliveryBackend: 'raw-network-zpl',
  manifestSignature: 'sigstore-bundle-required-before-publish',
}
const manifestPath = `${verified.artifactPath}.artifact.json`
const checksumPath = `${verified.artifactPath}.sha256`
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
writeFileSync(checksumPath, `${digest}  ${filename}\n`, { mode: 0o644 })
process.stdout.write(`${JSON.stringify({ ok: true, artifactPath: verified.artifactPath, manifestPath, checksumPath })}\n`)
