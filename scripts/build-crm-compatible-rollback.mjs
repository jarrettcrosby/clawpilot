#!/usr/bin/env node
import { resolve } from 'node:path'
import { buildRollbackArtifact, verifyRollbackArtifact } from './lib/crm-compatible-rollback-artifact.mjs'
import { runStorageGuard } from './local-storage-guard.mjs'

const args = process.argv.slice(2)
const options = new Map()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1]
  if (!['--commit', '--output', '--acceptance', '--build-receipt', '--verify', '--manifest-sha256'].includes(key)
    || !value || options.has(key)) throw new Error('Use an explicit commit/output/acceptance/build-receipt, or verify/manifest-sha256')
  options.set(key, value)
}
if (options.has('--verify')) {
  if (options.size !== 2 || !options.has('--manifest-sha256')) throw new Error('Verification requires only --verify and --manifest-sha256')
  const manifest = verifyRollbackArtifact({ directory: resolve(options.get('--verify')), expectedManifestSha256: options.get('--manifest-sha256') })
  console.log(JSON.stringify({ verified: true, commit: manifest.commit, boundary: manifest.certification.boundary }))
} else {
  if (options.size !== 4 || !['--commit', '--output', '--acceptance', '--build-receipt'].every(key => options.has(key))) {
    throw new Error('Build requires --commit SHA40 --output NEW_DIRECTORY --acceptance FILE --build-receipt FILE')
  }
  if (runStorageGuard({ argv: ['--preflight'] }) !== 0) throw new Error('Local storage guard did not pass')
  console.log(JSON.stringify(buildRollbackArtifact({ repository: process.cwd(), commit: options.get('--commit'),
    outputDirectory: resolve(options.get('--output')), acceptanceFile: resolve(options.get('--acceptance')),
    buildFile: resolve(options.get('--build-receipt')) })))
}
