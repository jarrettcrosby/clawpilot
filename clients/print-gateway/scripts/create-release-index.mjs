import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const inputIndex = process.argv.indexOf('--input')
const outputIndex = process.argv.indexOf('--output')
const inputDirectory = path.resolve(process.argv[inputIndex + 1] || '')
const outputDirectory = path.resolve(process.argv[outputIndex + 1] || '')
if (inputIndex === -1 || outputIndex === -1) throw new Error('--input and --output are required')

function filesRecursively(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesRecursively(fullPath) : [fullPath]
  })
}

const manifests = filesRecursively(inputDirectory)
  .filter((filePath) => filePath.endsWith('.artifact.json'))
  .map((filePath) => ({ filePath, value: JSON.parse(readFileSync(filePath, 'utf8')) }))
if (manifests.length < 1 || manifests.length > 2) {
  throw new Error(`Expected one or two verified platform manifests, found ${manifests.length}`)
}
const platforms = new Set(manifests.map(({ value }) => value.platform))
if (platforms.size !== manifests.length
  || [...platforms].some((platform) => !['macos', 'windows'].includes(platform))) {
  throw new Error('A customer release contains a duplicate or unsupported platform artifact')
}
const versions = new Set(manifests.map(({ value }) => value.version))
if (versions.size !== 1) throw new Error('Platform artifact versions do not match')
const sourceCommits = new Set(manifests.map(({ value }) => value.sourceCommit))
if (sourceCommits.size !== 1 || !/^[a-f0-9]{40}$/.test([...sourceCommits][0] || '')) {
  throw new Error('Platform artifacts do not identify the same exact source commit')
}
for (const { value } of manifests) {
  if (value.signed !== true || value.customerReleaseReady !== true) {
    throw new Error(`${value.platform} artifact is not signature-verified and release-ready`)
  }
  if (value.platform === 'macos' && (value.notarized !== true || value.stapled !== true)) {
    throw new Error('macOS artifact is not notarized and stapled')
  }
}

const version = [...versions][0]
const index = {
  schemaVersion: 1,
  product: 'ClawPilot Print Agent',
  version,
  sourceCommit: [...sourceCommits][0],
  customerReleaseReady: true,
  artifacts: manifests.map(({ value }) => value).sort((left, right) => left.platform.localeCompare(right.platform)),
  signature: 'sigstore-bundle-required-before-publish',
}
const indexName = `ClawPilot-Print-Agent-${version}-release.json`
const indexPath = path.join(outputDirectory, indexName)
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o644 })

const checksumLines = []
for (const value of index.artifacts) {
  const candidates = filesRecursively(inputDirectory).filter(
    (filePath) => path.basename(filePath) === value.filename,
  )
  if (candidates.length !== 1 || statSync(candidates[0]).size !== value.byteLength) {
    throw new Error(`Artifact bytes are missing or changed for ${value.filename}`)
  }
  const digest = createHash('sha256').update(readFileSync(candidates[0])).digest('hex')
  if (digest !== value.sha256) throw new Error(`Artifact digest changed for ${value.filename}`)
  checksumLines.push(`${digest}  ${value.filename}`)
}
const indexDigest = createHash('sha256').update(readFileSync(indexPath)).digest('hex')
checksumLines.push(`${indexDigest}  ${indexName}`)
writeFileSync(path.join(outputDirectory, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, { mode: 0o644 })
process.stdout.write(`${JSON.stringify({ ok: true, version, indexPath })}\n`)
