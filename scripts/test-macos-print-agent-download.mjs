#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function storedZipEntries(archive) {
  const entries = new Map()
  let offset = 0
  while (offset + 30 <= archive.byteLength && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8)
    const compressedLength = archive.readUInt32LE(offset + 18)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    assert.equal(method, 0, 'Download ZIP entries must use deterministic stored bytes')
    const nameStart = offset + 30
    const contentStart = nameStart + nameLength + extraLength
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8')
    entries.set(name, archive.subarray(contentStart, contentStart + compressedLength))
    offset = contentStart + compressedLength
  }
  return entries
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-print-agent-download-'))
try {
  const outputPath = path.join(sandbox, 'ClawPilot-Print-Agent-macOS.zip')
  const build = JSON.parse(execFileSync(process.execPath, [
    'scripts/build-macos-print-agent-download.mjs',
    '--output',
    outputPath,
  ], { encoding: 'utf8' }))
  assert.equal(build.ok, true)
  assert.equal(build.version, '0.1.0-preview.1')
  assert.equal(build.filename, 'ClawPilot-Print-Agent-macOS.zip')
  assert.equal(build.credentialEmbedded, false)
  assert.equal(build.signed, false)
  assert.equal(build.notarized, false)
  assert.equal(build.nodeRuntimeBundled, false)
  assert.equal(build.artifactHref, '/downloads/ClawPilot-Print-Agent-macOS.zip')
  assert.equal(build.checksumHref, '/downloads/ClawPilot-Print-Agent-macOS.zip.sha256')
  assert.match(build.sha256, /^[a-f0-9]{64}$/)
  assert.equal(
    readFileSync(build.checksumPath, 'utf8'),
    `${build.sha256}  ClawPilot-Print-Agent-macOS.zip\n`,
  )
  const manifest = JSON.parse(readFileSync(build.manifestPath, 'utf8'))
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    version: '0.1.0-preview.1',
    platform: 'macos',
    architecture: 'node-runtime-portable',
    artifactHref: '/downloads/ClawPilot-Print-Agent-macOS.zip',
    filename: 'ClawPilot-Print-Agent-macOS.zip',
    byteLength: build.byteLength,
    sha256: build.sha256,
    checksumHref: '/downloads/ClawPilot-Print-Agent-macOS.zip.sha256',
    credentialEmbedded: false,
    signed: false,
    notarized: false,
    nodeMinimumMajor: 20,
    nodeRuntimeBundled: false,
    deliveryBackend: 'raw-network-zpl',
  })

  const archive = readFileSync(outputPath)
  assert.equal(archive.readUInt32LE(0), 0x04034b50)
  const entries = storedZipEntries(archive)
  const prefix = 'ClawPilot Print Agent/'
  for (const required of [
    'ClawPilot Print Agent.command',
    'README.txt',
    'VERSION.txt',
    'runtime/install-macos-print-agent.mjs',
    'runtime/manage-macos-print-agent.mjs',
    'runtime/pair-macos-print-agent.mjs',
    'runtime/run-local-print-agent.mjs',
    'runtime/lib/local-print-device.mjs',
    'runtime/lib/macos-print-agent-credential.mjs',
    'runtime/lib/macos-print-agent-pairing.mjs',
    'runtime/lib/submit-raw-print.mjs',
  ]) assert.ok(entries.has(`${prefix}${required}`), `Download is missing ${required}`)

  const command = entries.get(`${prefix}ClawPilot Print Agent.command`).toString('utf8')
  assert.match(command, /Node\.js 20 or newer/)
  assert.match(command, /runtime\/manage-macos-print-agent\.mjs/)
  assert.doesNotMatch(command, /cpprint\.v1\./)

  const readme = entries.get(`${prefix}README.txt`).toString('utf8')
  for (const requirement of [
    'Download and extract this credential-free ZIP',
    'Operations > Printing',
    'short-lived cppair code',
    'Do not disable Gatekeeper',
    'unique workspace/printer instance name',
    'macOS Keychain',
    'printer hostname or IP',
    'without printing a label or\nclaiming a job',
    'delivery ledger',
    'not code-signed or notarized',
  ]) assert.ok(readme.includes(requirement), `README is missing ${requirement}`)
  assert.equal(entries.get(`${prefix}VERSION.txt`).toString('utf8'), '0.1.0-preview.1\n')

  assert.deepEqual(
    entries.get(`${prefix}runtime/run-local-print-agent.mjs`),
    readFileSync('scripts/run-local-print-agent.mjs'),
    'Download must contain the exact lost-ack-fenced runtime under test',
  )
  assert.deepEqual(
    entries.get(`${prefix}runtime/lib/submit-raw-print.mjs`),
    readFileSync('scripts/lib/submit-raw-print.mjs'),
    'Download must contain the exact raw-delivery uncertainty fence under test',
  )
  assert.ok(
    !/cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/i.test(archive.toString('utf8')),
    'Download must not contain a concrete runtime credential',
  )

  const secondOutputPath = path.join(sandbox, 'second.zip')
  const secondBuild = JSON.parse(execFileSync(process.execPath, [
    'scripts/build-macos-print-agent-download.mjs',
    '--output',
    secondOutputPath,
  ], { encoding: 'utf8' }))
  assert.equal(secondBuild.sha256, build.sha256)
  assert.deepEqual(
    readFileSync(secondOutputPath),
    archive,
    'Identical print-agent sources must produce identical download bytes',
  )

  const publishedPath = 'app_src/public/downloads/ClawPilot-Print-Agent-macOS.zip'
  assert.equal(existsSync(publishedPath), true, 'Published web download is missing')
  assert.deepEqual(
    readFileSync(publishedPath),
    archive,
    'Published web download must exactly match the current tested agent sources',
  )
  assert.equal(
    readFileSync(`${publishedPath}.sha256`, 'utf8'),
    `${build.sha256}  ClawPilot-Print-Agent-macOS.zip\n`,
  )
  assert.equal(
    JSON.parse(readFileSync(
      'app_src/public/downloads/ClawPilot-Print-Agent-macOS.json',
      'utf8',
    )).sha256,
    build.sha256,
  )

  const manager = readFileSync('scripts/manage-macos-print-agent.mjs', 'utf8')
  for (const contract of [
    'Pair a workspace and printer',
    'Test an installed printer connection',
    'Stop and uninstall an instance',
    'Pair another workspace or re-pair with a new instance',
    "['find-generic-password', '-s', service, '-a', account]",
    "'--uninstall',",
  ]) assert.ok(manager.includes(contract), `Manager is missing ${contract}`)
  assert.ok(!manager.includes('delete-generic-password'))
  assert.ok(!manager.includes('rmSync('))
  assert.ok(!manager.includes('CLAWPILOT_PRINT_AGENT_CREDENTIAL'))
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

process.stdout.write('downloadable macOS print-agent artifact contracts passed\n')
