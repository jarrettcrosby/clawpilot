import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const directoryIndex = process.argv.indexOf('--directory')
const versionIndex = process.argv.indexOf('--version')
const directory = path.resolve(process.argv[directoryIndex + 1] || '')
const version = String(process.argv[versionIndex + 1] || '').trim()
if (directoryIndex === -1 || versionIndex === -1 || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
  throw new Error('--directory and an exact release --version are required')
}

const index = `ClawPilot-Print-Agent-${version}-release.json`
const releaseIndex = JSON.parse(readFileSync(path.join(directory, index), 'utf8'))
if (!Array.isArray(releaseIndex.artifacts)
  || releaseIndex.artifacts.length < 1
  || releaseIndex.artifacts.length > 2) {
  throw new Error('Release index must contain one or two platform artifacts')
}
const binaries = releaseIndex.artifacts.map((artifact) => String(artifact.filename || ''))
const expectedBinaries = new Map([
  ['macos', `ClawPilot-Print-Agent-${version}-mac-universal.dmg`],
  ['windows', `ClawPilot-Print-Agent-${version}-win-x64.exe`],
])
const platforms = new Set()
for (const artifact of releaseIndex.artifacts) {
  const platform = String(artifact.platform || '')
  if (platforms.has(platform)
    || artifact.filename !== expectedBinaries.get(platform)) {
    throw new Error('Release index contains a duplicate, unsupported, or misnamed platform artifact')
  }
  platforms.add(platform)
}
const signedMetadata = [
  ...binaries.flatMap((filename) => [
    `${filename}.artifact.json`,
    `${filename}.sha256`,
  ]),
  index,
  'SHA256SUMS.txt',
]
const expected = [
  ...binaries,
  ...signedMetadata,
  ...signedMetadata.map((filename) => `${filename}.sigstore.json`),
].sort()
const actual = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort()
if (actual.length !== expected.length || actual.some((name, indexValue) => name !== expected[indexValue])) {
  throw new Error(
    `Release asset set is not the exact selected-platform customer contract. Expected ${expected.join(', ')}; found ${actual.join(', ')}`,
  )
}
process.stdout.write(`${JSON.stringify({ ok: true, assets: actual })}\n`)
