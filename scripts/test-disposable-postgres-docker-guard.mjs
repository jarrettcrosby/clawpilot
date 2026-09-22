#!/usr/bin/env node

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DISPOSABLE_POSTGRES_TMPFS_SIZE,
  DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV,
  DISPOSABLE_POSTGRES_LABEL,
  DISPOSABLE_POSTGRES_OWNER_LABEL,
  createDisposablePostgresRuntime,
  disposablePostgresDockerArgs,
  disposablePostgresDockerCleanupArgs,
  disposablePostgresResourceLimits,
} from './lib/disposable-postgres-docker.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scriptsRoot = join(root, 'scripts')
const thisFile = basename(fileURLToPath(import.meta.url))
const postgresEvidence = /(?:POSTGRES_(?:PASSWORD|DB|USER)|pgvector\/pgvector:pg(?:16|18)|postgres:(?:16|18)-alpine)/u
const dockerCall = /(?:command|execFileSync|spawnSync)\(\s*['"]docker['"]\s*,/gu
const rawDockerRemoveCall = /(?:command|execFileSync|spawnSync)\(\s*['"]docker['"]\s*,\s*\[\s*['"]rm['"]/gu
const guardedDockerRemoveCall = /(?:command|execFileSync|spawnSync)\(\s*['"]docker['"]\s*,\s*disposablePostgresDockerCleanupArgs\(/gu
const pureOptions = { environment: {}, runtime: { admit: () => 'unit-owner' } }

assert.equal(
  DISPOSABLE_POSTGRES_TMPFS_SIZE,
  process.env[DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV]?.trim() || '4g',
)

function matchingBracket(source, openIndex) {
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '[') depth += 1
    if (character === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function disposableDockerCalls(path) {
  const source = readFileSync(path, 'utf8')
  const calls = []
  for (const match of source.matchAll(dockerCall)) {
    const arrayStart = source.indexOf('[', match.index + match[0].length)
    if (arrayStart < 0) continue
    const arrayEnd = matchingBracket(source, arrayStart)
    assert.notEqual(arrayEnd, -1, `${path} Docker argument array closes`)
    const beforeArray = source.slice(match.index, arrayStart)
    const arraySource = source.slice(arrayStart, arrayEnd + 1)
    if (!postgresEvidence.test(arraySource)) continue
    calls.push({ beforeArray, arraySource })
  }
  return calls
}

const pg16 = disposablePostgresDockerArgs([
  'run', '--detach', '--rm', '--name', 'pg16-test',
  '-e', 'POSTGRES_PASSWORD=test', 'pgvector/pgvector:pg16',
], pureOptions)
assert.ok(pg16.includes('--rm'))
assert.deepEqual(
  pg16.slice(pg16.indexOf('--tmpfs'), pg16.indexOf('--tmpfs') + 2),
  ['--tmpfs', '/var/lib/postgresql/data:rw,size=4g,mode=1777'],
)

const pg18 = disposablePostgresDockerArgs([
  'create', '--name', 'pg18-test',
  '-e', 'POSTGRES_PASSWORD=test', 'postgres:18-alpine',
], pureOptions)
assert.ok(pg18.includes('--rm'), 'docker create receives automatic cleanup')
assert.deepEqual(
  pg18.slice(pg18.indexOf('--tmpfs'), pg18.indexOf('--tmpfs') + 2),
  ['--tmpfs', '/var/lib/postgresql:rw,size=4g,mode=1777'],
)

for (const [flag, value] of [
  ['--memory', '5g'], ['--memory-swap', '5g'], ['--cpus', '2'],
  ['--pids-limit', '256'], ['--log-driver', 'local'],
]) assert.equal(pg16[pg16.indexOf(flag) + 1], value)
assert.ok(pg16.includes('max-size=10m'))
assert.ok(pg16.includes('max-file=3'))
assert.ok(pg16.includes(`${DISPOSABLE_POSTGRES_LABEL}=true`))
assert.ok(pg16.includes(`${DISPOSABLE_POSTGRES_OWNER_LABEL}=unit-owner`))
assert.deepEqual(disposablePostgresResourceLimits({
  CLAWPILOT_TEST_POSTGRES_MEMORY: '512m',
  CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE: '128m',
  CLAWPILOT_TEST_POSTGRES_CPUS: '0.5',
}), { memory: '512m', tmpfs: '128m', cpus: '0.5' })
const emailRoutingProfile = {
  CLAWPILOT_TEST_POSTGRES_MEMORY: '512m',
  CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE: '256m',
  CLAWPILOT_TEST_POSTGRES_CPUS: '1',
}
const emailRoutingArgs = disposablePostgresDockerArgs([
  'run', '--rm', '-d', '--name', 'clawpilot-email-routing-unit', '--pull', 'never',
  '-e', 'POSTGRES_PASSWORD=unit', '-e', 'POSTGRES_DB=unit',
  '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16',
], { ...pureOptions, environment: emailRoutingProfile })
assert.equal(emailRoutingArgs[emailRoutingArgs.indexOf('--memory') + 1], '512m')
assert.equal(emailRoutingArgs[emailRoutingArgs.indexOf('--memory-swap') + 1], '512m')
assert.equal(emailRoutingArgs[emailRoutingArgs.indexOf('--cpus') + 1], '1')
assert.equal(emailRoutingArgs[emailRoutingArgs.indexOf('--tmpfs') + 1], '/var/lib/postgresql/data:rw,size=256m,mode=1777')
const emailRoutingSource = readFileSync(join(scriptsRoot, 'test-crm-email-routing-postgres.mjs'), 'utf8')
for (const [key, value] of Object.entries(emailRoutingProfile)) {
  assert.ok(emailRoutingSource.includes(`${key}: '${value}'`), 'CRM routing keeps its established lower resource budget')
}
for (const environment of [
  { CLAWPILOT_TEST_POSTGRES_MEMORY: '6g' },
  { CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE: '999g' },
  { CLAWPILOT_TEST_POSTGRES_MEMORY: '1g' },
  { CLAWPILOT_TEST_POSTGRES_CPUS: '0' },
  { CLAWPILOT_TEST_POSTGRES_CPUS: '3' },
]) assert.throws(() => disposablePostgresResourceLimits(environment))
for (const override of [
  '--tmpfs', '--tmpfs=/tmp', '--memory=99g', '-m99g', '--memory-swap=-1',
  '--cpus=99', '--pids-limit=-1', '--log-driver=none', '--log-opt=max-file=0',
  '--label=foreign', '-lforeign', '--mount=type=volume', '-vdata:/data',
  '--privileged', '--oom-kill-disable',
]) assert.throws(() => disposablePostgresDockerArgs([
  'run', '--name', 'safe-test', override, 'postgres:16-alpine',
], pureOptions), /owned by the Docker argument guard/)
for (const nameArgs of [[], ['--name', '--all'], ['--name=a'], ['--name', 'a', '--name', 'b']]) {
  assert.throws(() => disposablePostgresDockerArgs([
    'run', ...nameArgs, 'postgres:16-alpine',
  ], pureOptions), /exact/)
}

// Runtime tests use temporary lease directories and a fake Docker executor.
// They never launch a container, read real Docker data, or remove user data.
const temporaryRoot = mkdtempSync(join(tmpdir(), 'clawpilot-docker-guard-test-'))
const testChildren = []
function fixture(suffix, overrides = {}) {
  const leasePath = join(temporaryRoot, suffix, 'active')
  const containers = new Map()
  const containerIds = new Map()
  const hooks = {}
  const calls = []
  const lifecycle = new EventEmitter()
  const exits = []
  lifecycle.exit = (code) => { exits.push(code); lifecycle.emit('exit', code) }
  const token = `unit-${suffix}`
  const execute = (_command, args) => {
    calls.push(args)
    if (args[0] === 'container') {
      const target = args.at(-1)
      const name = containers.has(target) ? target
        : [...containerIds].find(([candidate, id]) => id === target && containers.has(candidate))?.[0]
      if (name) {
        if (!containerIds.has(name)) containerIds.set(name, (containerIds.size + 1).toString(16).padStart(64, '0'))
        const result = { id: containerIds.get(name), labels: containers.get(name) }
        hooks.afterInspect?.(name, result)
        return JSON.stringify(result)
      }
      const error = new Error('missing')
      error.stderr = `Error: No such object: ${target}`
      throw error
    }
    if (args[0] === 'rm') {
      const name = [...containerIds].find(([, id]) => id === args.at(-1))?.[0]
      if (!name || !containers.has(name)) {
        const error = new Error('already removed')
        error.stderr = `No such container: ${args.at(-1)}`
        throw error
      }
      containers.delete(name)
      return ''
    }
    assert.fail(`Unexpected Docker command: ${args}`)
  }
  const runtime = createDisposablePostgresRuntime({
    platform: 'darwin', leasePath, pid: 1001, token, lifecycle, execute,
    checkHeadroom: () => {}, isProcessAlive: () => false, warn: () => {},
    ...overrides,
  })
  return { runtime, leasePath, containers, containerIds, hooks, calls, lifecycle, exits, token, execute }
}
function simulateContainer(f, name, owner = f.token) {
  f.containers.set(name, {
    [DISPOSABLE_POSTGRES_LABEL]: 'true', [DISPOSABLE_POSTGRES_OWNER_LABEL]: owner,
  })
}
try {
  const low = fixture('low', { checkHeadroom: () => { throw new Error('low disk') } })
  assert.throws(() => low.runtime.admit('low-test'), /low disk/)
  assert.equal(low.calls.length, 0, 'headroom failure precedes Docker inspection and launch')
  assert.equal(existsSync(low.leasePath), false)

  let checked = 0
  const inherited = fixture('inherited', {
    environment: { CI: 'true', RAILWAY_PROJECT_ID: 'local-inherited' },
    checkHeadroom: () => { checked += 1 },
  })
  inherited.runtime.admit('inherited-test')
  assert.equal(checked, 1, 'Mac admission checks disk despite inherited hosted variables')
  inherited.runtime.cleanup()

  const hosted = fixture('hosted', {
    platform: 'linux', environment: { CI: 'true' },
    checkHeadroom: () => assert.fail('hosted runtime read Mac disk'),
  })
  hosted.runtime.admit('hosted-test')
  assert.equal(existsSync(hosted.leasePath), false)
  hosted.runtime.cleanup()

  for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130], ['exit', null]]) {
    const f = fixture(signal)
    f.runtime.admit(`owned-${signal}`)
    simulateContainer(f, `owned-${signal}`)
    f.containers.set('foreign-database', {})
    f.lifecycle.emit(signal)
    assert.equal(f.containers.has(`owned-${signal}`), false)
    assert.equal(f.containers.has('foreign-database'), true)
    assert.equal(existsSync(f.leasePath), false)
    assert.deepEqual(f.calls.filter((args) => args[0] === 'rm'), [
      ['rm', '--force', '--volumes', f.containerIds.get(`owned-${signal}`)],
    ])
    assert.deepEqual(f.exits, exitCode === null ? [] : [exitCode])
  }

  const collision = fixture('collision')
  collision.containers.set('foreign', {})
  assert.throws(() => collision.runtime.admit('foreign'), /left untouched/)
  assert.equal(collision.calls.some((args) => args[0] === 'rm'), false)
  const changed = fixture('changed')
  changed.runtime.admit('changed-test')
  simulateContainer(changed, 'changed-test', 'someone-else')
  assert.equal(changed.runtime.cleanup(), false)
  assert.equal(changed.calls.some((args) => args[0] === 'rm'), false)
  assert.equal(existsSync(changed.leasePath), true, 'unknown owner blocks lease release')

  const replaced = fixture('replaced')
  replaced.runtime.admit('reused-name')
  simulateContainer(replaced, 'reused-name')
  let originalId
  replaced.hooks.afterInspect = (name, result) => {
    originalId = result.id
    replaced.containers.set(name, { [DISPOSABLE_POSTGRES_OWNER_LABEL]: 'foreign' })
    replaced.containerIds.set(name, 'f'.repeat(64))
    delete replaced.hooks.afterInspect
  }
  assert.equal(replaced.runtime.cleanup(), true)
  assert.deepEqual(replaced.calls.filter((args) => args[0] === 'rm'), [
    ['rm', '--force', '--volumes', originalId],
  ])
  assert.equal(replaced.containers.has('reused-name'), true, 'replacement name is never removed')

  const first = fixture('concurrent', { isProcessAlive: () => true })
  first.runtime.admit('first')
  const second = fixture('unused', {
    leasePath: first.leasePath, pid: 1002, token: 'second', isProcessAlive: () => true,
  })
  assert.throws(() => second.runtime.admit('second'), /already reserved/)
  assert.equal(first.runtime.cleanup(), true)
  assert.equal(second.runtime.admit('second'), 'second')
  second.runtime.cleanup()

  const stale = fixture('stale')
  mkdirSync(stale.leasePath, { recursive: true })
  writeFileSync(join(stale.leasePath, 'owner.json'), JSON.stringify({ pid: 99, token: 'old', name: 'old-test' }))
  assert.equal(stale.runtime.admit('new-test'), stale.token, 'absent container and dead owner permit recovery')
  stale.runtime.cleanup()
  const retained = fixture('retained')
  mkdirSync(retained.leasePath, { recursive: true })
  writeFileSync(join(retained.leasePath, 'owner.json'), JSON.stringify({ pid: 99, token: 'old', name: 'old-test' }))
  simulateContainer(retained, 'old-test', 'old')
  assert.throws(() => retained.runtime.admit('new-test'), /still exists/)
  assert.equal(retained.calls.some((args) => args[0] === 'rm'), false)
  const malformed = fixture('malformed')
  mkdirSync(malformed.leasePath, { recursive: true })
  assert.throws(() => malformed.runtime.admit('new-test'), /incomplete/)
  const recovery = fixture('recovery')
  mkdirSync(`${recovery.leasePath}.recovery`, { recursive: true })
  assert.throws(() => recovery.runtime.admit('new-test'), /recovery is in progress/)
  let unavailable = false
  const uncertain = fixture('uncertain', {
    execute: (...args) => {
      if (unavailable) throw new Error('Docker unavailable')
      const error = new Error('absent')
      error.stderr = `No such object: ${args[1].at(-1)}`
      throw error
    },
  })
  uncertain.runtime.admit('uncertain-test')
  unavailable = true
  assert.equal(uncertain.runtime.cleanup(), false)
  assert.equal(existsSync(uncertain.leasePath), true, 'failed inspect preserves lease for manual review')

  // Two real Node processes race on the same atomic lease; Docker stays mocked.
  // The winner holds the lease until both results arrive, avoiding timing-based
  // assumptions about how quickly either child starts.
  const racingLease = join(temporaryRoot, 'race', 'active')
  const helperUrl = new URL('./lib/disposable-postgres-docker.mjs', import.meta.url).href
  const childSource = `
    import { createDisposablePostgresRuntime } from ${JSON.stringify(helperUrl)};
    const runtime = createDisposablePostgresRuntime({
      platform: 'darwin', leasePath: ${JSON.stringify(racingLease)},
      checkHeadroom: () => {}, warn: () => {},
      execute: () => { const e = new Error('absent'); e.stderr = 'No such object: test'; throw e; },
    });
    try {
      runtime.admit('race-' + process.pid);
      process.send({ acquired: true });
      process.on('message', () => { runtime.cleanup(); process.exit(0); });
    } catch (error) {
      process.send({ acquired: false, reason: error.message });
      process.disconnect();
    }
  `
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }))
  testChildren.push(...children)
  const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Lease race test timed out')) }, 10_000)
    child.once('message', (message) => { clearTimeout(timeout); resolve(message) })
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code) => { if (code) { clearTimeout(timeout); reject(new Error(`Lease child exited ${code}`)) } })
  })))
  assert.equal(results.filter((result) => result.acquired).length, 1, 'exactly one cross-process admission wins')
  await Promise.all(children.map((child, index) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    if (results[index].acquired) child.send('release')
  })))
  assert.equal(existsSync(racingLease), false)
} finally {
  await Promise.allSettled(testChildren.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000)
    const timeout = setTimeout(() => { if (child.connected) child.disconnect(); child.unref(); resolve() }, 2_000)
    child.once('exit', () => { clearTimeout(force); clearTimeout(timeout); resolve() })
    child.kill('SIGTERM')
  })))
  rmSync(temporaryRoot, { recursive: true, force: true })
}

assert.deepEqual(
  disposablePostgresDockerCleanupArgs('clawpilot-pg-test.1'),
  ['rm', '--force', '--volumes', 'clawpilot-pg-test.1'],
)
assert.throws(
  () => disposablePostgresDockerCleanupArgs(''),
  /one exact Docker container name/u,
)
assert.throws(
  () => disposablePostgresDockerCleanupArgs('--all'),
  /one exact Docker container name/u,
)

let guardedCalls = 0
let guardedCleanupCalls = 0
for (const entry of readdirSync(scriptsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.mjs') || entry.name === thisFile) {
    continue
  }
  const path = join(scriptsRoot, entry.name)
  const source = readFileSync(path, 'utf8')
  assert.doesNotMatch(
    source,
    rawDockerRemoveCall,
    `${entry.name} does not bypass volume-safe disposable PostgreSQL cleanup`,
  )
  guardedCleanupCalls += [...source.matchAll(guardedDockerRemoveCall)].length
  for (const call of disposableDockerCalls(path)) {
    guardedCalls += 1
    assert.match(
      call.beforeArray,
      /disposablePostgresDockerArgs\(\s*$/u,
      `${entry.name} guards its disposable PostgreSQL Docker arguments`,
    )
    assert.match(
      call.arraySource,
      /['"]--rm['"]/u,
      `${entry.name} keeps Docker --rm cleanup`,
    )
  }
}

assert.ok(guardedCalls >= 88, 'the disposable PostgreSQL acceptance inventory did not shrink')
assert.ok(guardedCleanupCalls >= 10, 'the volume-safe forced-cleanup inventory did not shrink')
console.log(
  `disposable PostgreSQL Docker guard passed: ${guardedCalls} run/create calls use bounded, version-aware tmpfs storage and --rm cleanup; ${guardedCleanupCalls} forced cleanup calls remove anonymous volumes`,
)
