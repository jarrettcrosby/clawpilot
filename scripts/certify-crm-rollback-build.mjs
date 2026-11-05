#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertExternalRollbackOutput, canonicalJson, committedRollbackIdentity, ROLLBACK_BUILD_FORMAT,
  rollbackReceiptSource, sha256, writeRollbackSourceArchive } from './lib/crm-compatible-rollback-artifact.mjs'
import { runStorageGuard } from './local-storage-guard.mjs'

const args = process.argv.slice(2)
assert.ok(args.length === 4 && args[0] === '--commit' && args[2] === '--receipt',
  'Use --commit SHA40 --receipt NEW_FILE outside the repository')
assert.match(process.version, /^v24\./u, 'Use the supported Node 24 runtime')
const source = committedRollbackIdentity(process.cwd(), args[1])
const receiptPath = assertExternalRollbackOutput(process.cwd(), args[3])
if (runStorageGuard({ argv: ['--preflight'] }) !== 0) throw new Error('Local storage guard did not pass')
const temporary = mkdtempSync(join(tmpdir(), 'clawpilot-rollback-build-'))
try {
  const archivePath = join(temporary, 'source.tar')
  writeRollbackSourceArchive(process.cwd(), source.commit, archivePath)
  execFileSync('tar', ['-xf', archivePath, '-C', temporary], { timeout: 30_000, stdio: 'pipe' })
  // Reuse installed dependencies without installing, copying user runtime data,
  // loading local env files or writing into the user's existing Next output.
  symlinkSync(resolve('app_src/node_modules'), join(temporary, 'source/app_src/node_modules'), 'dir')
  const environment = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(environment, { PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`,
    NEXT_TELEMETRY_DISABLED: '1', APP_AUTH_REQUIRED: '1', CLAWPILOT_EXECUTION_ENABLED: '0' })
  execFileSync('npm', ['run', 'build'], { cwd: join(temporary, 'source'), env: environment,
    stdio: 'inherit', timeout: 15 * 60_000 })
  assert.deepEqual(committedRollbackIdentity(process.cwd(), args[1]), source, 'Source changed during rollback-floor build')
  const outputFiles = Object.fromEntries([
    'app_src/.next/BUILD_ID', 'app_src/.next/build-manifest.json', 'app_src/.next/routes-manifest.json',
  ].map(path => [path, sha256(readFileSync(join(temporary, 'source', path)))]))
  const receipt = { format: ROLLBACK_BUILD_FORMAT, status: 'passed', source: rollbackReceiptSource(source),
    command: ['npm', 'run', 'build'], nodeVersion: process.version, platform: process.platform, arch: process.arch,
    environmentMode: 'isolated-committed-source-no-provider-credentials', outputFiles }
  writeFileSync(receiptPath, canonicalJson(receipt), { flag: 'wx', mode: 0o444 })
  console.log(JSON.stringify({ buildReceipt: receiptPath, sourceCommit: source.commit, receiptSha256: sha256(canonicalJson(receipt)) }))
} finally {
  // Only this invocation's newly allocated private build directory is removed;
  // no worktree, user data, installed dependency tree or prior artifact is touched.
  assert.ok(temporary.startsWith(join(tmpdir(), 'clawpilot-rollback-build-')))
  rmSync(temporary, { recursive: true })
}
