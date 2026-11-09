#!/usr/bin/env node
// Synthetic pins and an owned temporary directory; no DB or provider.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(new URL(`../app_src/lib/crm/${name}.ts`, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  const result = { exports: {} }
  new Function('require', 'module', 'exports', js)(dependency => {
    if (dependency === 'server-only') return {}
    if (dependency.startsWith('node:')) return require(dependency)
    assert.match(dependency, /^\.\/[A-Za-z0-9]+$/u)
    return load(dependency.slice(2))
  }, result, result.exports)
  modules.set(name, result.exports)
  return result.exports
}

const { nativeEmailCanonicalJson } = load('nativeEmailPublication')
const { parseLegacyEmailTerminalHoldJournal: parse, reserveLegacyEmailTerminalHoldJournal: reserve } =
  load('legacyEmailTerminalHoldJournal')
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const fresh = () => ({ version: 1, purpose: 'clawpilot-private-legacy-email-terminal-hold-journal-v1',
  operationId: uid(1), fenceEpoch: uid(2), manifestDigest: 'a'.repeat(64), approvalDigest: 'b'.repeat(64),
  targetFingerprint: 'c'.repeat(64), expectedRows: 11 })
const code = suffix => error => error?.code === 'legacy_email_terminal_hold_journal_' + suffix
function privateDirectory(run) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'clawpilot-hold-journal-'))
  try { chmodSync(directory, 0o700); run(directory) }
  finally { rmSync(directory, { recursive: true }) }
}

test('terminal hold journal only retains detached, frozen scalar pins', () => {
  const supplied = Object.assign(Object.create(null), fresh())
  const parsed = parse(supplied)
  supplied.expectedRows = 12
  assert.deepEqual(parsed, fresh())
  assert.ok(Object.isFrozen(parsed))
  for (const unrelated of ['clawpilot-private-native-email-archive-journal-v1',
    'clawpilot-private-native-email-account-repair-journal-v1', 'clawpilot-terminal-hold-preview-v1']) {
    assert.throws(() => parse({ ...fresh(), purpose: unrelated }), code('domain'))
  }
})

test('rejects noncanonical scope, unbounded counts and caller traps before reserving', () => {
  privateDirectory(directory => {
    const path = join(directory, 'hold.json'), pins = fresh()
    for (const value of [0, 26, 1.5, '11', NaN]) {
      assert.throws(() => reserve(path, { ...pins, expectedRows: value }), code('pins'))
    }
    for (const field of ['operationId', 'manifestDigest', 'approvalDigest', 'targetFingerprint', 'fenceEpoch']) {
      assert.throws(() => reserve(path, { ...pins, [field]: pins[field] + '\n' }), code('pins'))
    }
    assert.throws(() => reserve(path, { ...pins, signedApproval: {} }), code('shape'))
    assert.throws(() => reserve(path, new Proxy(pins, { ownKeys() { throw Error('unexpected proxy trap') } })), code('shape'))
    let reads = 0
    Object.defineProperty(pins, 'expectedRows', { enumerable: true, get() { reads++; return 11 } })
    assert.throws(() => reserve(path, pins), code('shape'))
    assert.equal(reads, 0)
    assert.deepEqual(readdirSync(directory), [])
  })
})

test('reserves one owner-private canonical file and never overwrites complete or partial bytes', () => {
  privateDirectory(directory => {
    const path = join(directory, 'hold.json'), partial = join(directory, 'partial.json')
    const pins = fresh(), bytes = nativeEmailCanonicalJson(pins) + '\n'
    assert.deepEqual(reserve(path, pins), pins)
    const before = statSync(path)
    assert.equal(before.uid, process.geteuid())
    assert.equal(before.mode & 0o7777, 0o600)
    assert.equal(before.nlink, 1)
    assert.equal(readFileSync(path, 'utf8'), bytes)
    assert.throws(() => reserve(path, pins), code('already_reserved'))
    assert.throws(() => reserve(path, { ...pins, operationId: uid(3) }), code('already_reserved'))
    assert.equal(statSync(path).ino, before.ino)
    assert.equal(readFileSync(path, 'utf8'), bytes)
    writeFileSync(partial, bytes.slice(0, 8), { flag: 'wx', mode: 0o600 })
    assert.throws(() => reserve(partial, pins), code('already_reserved'))
    assert.equal(readFileSync(partial, 'utf8'), bytes.slice(0, 8))
  })
})
