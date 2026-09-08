#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DISPOSABLE_POSTGRES_TMPFS_SIZE,
  DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV,
  disposablePostgresDockerArgs,
  disposablePostgresDockerCleanupArgs,
} from './lib/disposable-postgres-docker.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scriptsRoot = join(root, 'scripts')
const thisFile = basename(fileURLToPath(import.meta.url))
const postgresEvidence = /(?:POSTGRES_(?:PASSWORD|DB|USER)|pgvector\/pgvector:pg(?:16|18)|postgres:(?:16|18)-alpine)/u
const dockerCall = /(?:command|execFileSync|spawnSync)\(\s*['"]docker['"]\s*,/gu
const rawDockerRemoveCall = /(?:command|execFileSync|spawnSync)\(\s*['"]docker['"]\s*,\s*\[\s*['"]rm['"]/gu
const guardedDockerRemoveCall = /(?:command|execFileSync|spawnSync)\(\s*['"]docker['"]\s*,\s*disposablePostgresDockerCleanupArgs\(/gu

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
])
assert.ok(pg16.includes('--rm'))
assert.deepEqual(
  pg16.slice(pg16.indexOf('--tmpfs'), pg16.indexOf('--tmpfs') + 2),
  ['--tmpfs', `/var/lib/postgresql/data:rw,size=${DISPOSABLE_POSTGRES_TMPFS_SIZE},mode=1777`],
)

const pg18 = disposablePostgresDockerArgs([
  'create', '--name', 'pg18-test',
  '-e', 'POSTGRES_PASSWORD=test', 'postgres:18-alpine',
])
assert.ok(pg18.includes('--rm'), 'docker create receives automatic cleanup')
assert.deepEqual(
  pg18.slice(pg18.indexOf('--tmpfs'), pg18.indexOf('--tmpfs') + 2),
  ['--tmpfs', `/var/lib/postgresql:rw,size=${DISPOSABLE_POSTGRES_TMPFS_SIZE},mode=1777`],
)

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
