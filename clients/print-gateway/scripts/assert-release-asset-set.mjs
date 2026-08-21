import { readdirSync } from 'node:fs'
import path from 'node:path'

const directoryIndex = process.argv.indexOf('--directory')
const versionIndex = process.argv.indexOf('--version')
const directory = path.resolve(process.argv[directoryIndex + 1] || '')
const version = String(process.argv[versionIndex + 1] || '').trim()
if (directoryIndex === -1 || versionIndex === -1 || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
  throw new Error('--directory and an exact release --version are required')
}

const mac = `ClawPilot-Print-Agent-${version}-mac-universal.dmg`
const windows = `ClawPilot-Print-Agent-${version}-win-x64.exe`
const index = `ClawPilot-Print-Agent-${version}-release.json`
const signedMetadata = [
  `${mac}.artifact.json`,
  `${mac}.sha256`,
  `${windows}.artifact.json`,
  `${windows}.sha256`,
  index,
  'SHA256SUMS.txt',
]
const expected = [
  mac,
  windows,
  ...signedMetadata,
  ...signedMetadata.map((filename) => `${filename}.sigstore.json`),
].sort()
const actual = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort()
if (actual.length !== expected.length || actual.some((name, indexValue) => name !== expected[indexValue])) {
  throw new Error(
    `Release asset set is not the exact 14-file customer contract. Expected ${expected.join(', ')}; found ${actual.join(', ')}`,
  )
}
process.stdout.write(`${JSON.stringify({ ok: true, assets: actual })}\n`)
