#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  GENERATED_ARTIFACT_PATHS,
  GIB,
  assessHeadroom,
  collectDockerSummary,
  collectGeneratedArtifacts,
  detectHostedEnvironment,
  parseDockerSystemDf,
  parseWorktreePorcelain,
  readThresholds,
  runStorageGuard,
} from './local-storage-guard.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const guardPath = resolve(root, 'scripts/local-storage-guard.mjs')

test('hosted CI, Railway, and Vercel bypass without reading local disk', () => {
  assert.equal(detectHostedEnvironment({ CI: 'true' }), 'CI')
  assert.equal(detectHostedEnvironment({ CI: 'false' }), null)
  assert.equal(detectHostedEnvironment({ RAILWAY_ENVIRONMENT_ID: 'id' }), 'Railway')
  assert.equal(detectHostedEnvironment({ VERCEL_ENV: 'preview' }), 'Vercel')
  const output = []
  const code = runStorageGuard({
    argv: ['--preflight'],
    environment: { CI: '1' },
    repositoryRoot: root,
    write: (message) => output.push(message),
    readSpace: () => assert.fail('hosted guard read local disk'),
  })
  assert.equal(code, 0)
  assert.match(output.join(''), /LOCAL_STORAGE_PREFLIGHT_SKIPPED hosted=CI/)
})

test('thresholds implement configurable fail, warning, and pass bands', () => {
  const defaults = readThresholds({})
  assert.deepEqual([defaults.minimumGiB, defaults.warningGiB], [15, 25])
  assert.equal(assessHeadroom(14.99 * GIB, defaults), 'fail')
  assert.equal(assessHeadroom(15 * GIB, defaults), 'warn')
  assert.equal(assessHeadroom(25 * GIB, defaults), 'ok')
  const configured = readThresholds({
    CLAWPILOT_MIN_FREE_GIB: '20.5',
    CLAWPILOT_WARN_FREE_GIB: '30',
  })
  assert.deepEqual([configured.minimumGiB, configured.warningGiB], [20.5, 30])
  assert.throws(
    () => readThresholds({ CLAWPILOT_MIN_FREE_GIB: '25', CLAWPILOT_WARN_FREE_GIB: '20' }),
    /greater than or equal/,
  )
  assert.throws(() => readThresholds({ CLAWPILOT_MIN_FREE_GIB: 'zero' }), /positive number/)
})

test('local preflight fails below minimum and only warns in the warning band', () => {
  const failed = []
  assert.equal(runStorageGuard({
    argv: ['--preflight'],
    environment: {},
    repositoryRoot: root,
    write: () => {},
    writeError: (message) => failed.push(message),
    readSpace: () => ({ availableBytes: 14 * GIB, totalBytes: 100 * GIB }),
  }), 1)
  assert.match(failed.join(''), /LOCAL_STORAGE_PREFLIGHT_FAILED[\s\S]*No files were removed/)

  const warned = []
  assert.equal(runStorageGuard({
    argv: ['--preflight'],
    environment: {},
    repositoryRoot: root,
    write: (message) => warned.push(message),
    readSpace: () => ({ availableBytes: 23 * GIB, totalBytes: 100 * GIB }),
  }), 0)
  assert.match(warned.join(''), /LOCAL_STORAGE_PREFLIGHT_WARNING/)
})

test('worktree parser retains path and prunable evidence', () => {
  assert.deepEqual(parseWorktreePorcelain([
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/dev',
    '',
    'worktree /tmp/old',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n')), [
    { path: '/repo', prunable: false },
    { path: '/tmp/old', prunable: true },
  ])
})

test('generated artifact inventory is allowlisted, measured, and deduplicated', () => {
  const existing = new Set(['/repo/app_src/.next', '/repo/app_src/node_modules', '/repo-two/tmp'])
  const artifacts = collectGeneratedArtifacts(['/repo', '/repo', '/repo-two'], {
    pathExists: (path) => existing.has(path),
    measure: (path) => path.length,
  })
  assert.deepEqual(artifacts.map(({ path }) => path).sort(), [...existing].sort())
  assert.equal(artifacts.length, new Set(artifacts.map(({ path }) => path)).size)
  assert.ok(GENERATED_ARTIFACT_PATHS.includes('app_src/.next'))
})

test('Docker audit reports system allocation and local volume count read-only', () => {
  const fixture = [
    'TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE',
    'Images          4         2         3.2GB     1.1GB (34%)',
    'Local Volumes   127       4         18.56GB   17GB (91%)',
  ].join('\n')
  assert.deepEqual(parseDockerSystemDf(fixture)[1], {
    type: 'Local Volumes', total: 127, active: 4, size: '18.56GB', reclaimable: '17GB (91%)',
  })
  const calls = []
  const summary = collectDockerSummary((_command, args) => {
    calls.push(args)
    return args[0] === 'system' ? fixture : 'one\ntwo\nthree\n'
  })
  assert.equal(summary.volumeCount, 3)
  assert.deepEqual(calls, [['system', 'df'], ['volume', 'ls', '-q']])
  assert.deepEqual(collectDockerSummary(() => { throw new Error('daemon stopped') }), {
    available: false, error: 'daemon stopped',
  })
})

test('unknown cleanup modes are rejected and guard source has no deletion primitive', () => {
  for (const argument of ['--clean', '--prune']) {
    assert.equal(runStorageGuard({ argv: [argument], repositoryRoot: root, writeError: () => {} }), 2)
  }
  const source = readFileSync(guardPath, 'utf8')
  for (const forbidden of [
    /\brmSync\b/,
    /\bunlinkSync\b/,
    /\brmdirSync\b/,
    /docker[^\n]*(?:prune|rm)/i,
    /git[^\n]*worktree[^\n]*(?:prune|remove)/i,
    /npm[^\n]*cache[^\n]*(?:clean|force)/i,
  ]) assert.doesNotMatch(source, forbidden)
})

test('root build/test and supported local startup invoke preflight before mutation', () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.prebuild, 'node scripts/local-storage-guard.mjs --preflight')
  assert.equal(packageJson.scripts.pretest, 'node scripts/local-storage-guard.mjs --preflight')
  assert.equal(packageJson.scripts['storage:preflight'], 'node scripts/local-storage-guard.mjs --preflight')
  assert.match(packageJson.scripts.test, /npm run test:local-storage-guard/)
  const devStart = readFileSync(resolve(root, 'scripts/dev-start.sh'), 'utf8')
  const preflightAt = devStart.indexOf('npm run storage:preflight')
  for (const mutation of ['mkdir -p', 'seed_from_candidates "', 'npm install', 'rm -rf .next']) {
    assert.ok(preflightAt > -1 && preflightAt < devStart.indexOf(mutation), `preflight must precede ${mutation}`)
  }
})
