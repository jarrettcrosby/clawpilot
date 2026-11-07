#!/usr/bin/env node
// Synthetic scalar pins and test-owned temporary files only.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(new URL('../app_src/package.json', import.meta.url)), ts = require('typescript')
function load(name, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../app_src/lib/crm/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(dependency => {
    if (Object.hasOwn(dependencies, dependency)) return dependencies[dependency]
    if (dependency === 'server-only') return {}
    assert.ok(dependency.startsWith('node:'), dependency)
    return require(dependency)
  }, module, module.exports)
  return module.exports
}

const native = load('nativeEmailPublication')
const shared = { './nativeEmailPublication': native }
const repair = load('nativeEmailAccountRepairJournal', shared)
const { parseNativeEmailArchiveJournal: parse, reserveNativeEmailArchiveJournal: reserve } = load('nativeEmailArchiveJournal', {
  ...shared, './nativeEmailAccountRepairJournal': repair,
})
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pins = () => ({
  version: 1, purpose: 'clawpilot-private-native-email-archive-journal-v1',
  operationId: uid(1), fenceEpoch: uid(2), manifestDigest: 'a'.repeat(64),
  approvalDigest: 'b'.repeat(64), targetFingerprint: 'c'.repeat(64),
})
const hasCode = code => error => error.code === 'legacy_email_archive_journal_' + code
function withPrivateDirectory(run) {
  const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'clawpilot-archive-journal-'))
  try {
    fs.chmodSync(directory, 0o700)
    run(directory)
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
}

test('exact archive pins are detached, frozen and distinct from account repair journals', () => {
  const input = Object.assign(Object.create(null), pins())
  const parsed = parse(input)
  assert.deepEqual(parsed, pins())
  assert.ok(Object.isFrozen(parsed))
  input.manifestDigest = 'd'.repeat(64)
  assert.equal(parsed.manifestDigest, 'a'.repeat(64))
  const { manifestDigest, ...base } = pins()
  const other = { ...base, purpose: 'clawpilot-private-native-email-account-repair-journal-v1', reviewDigest: manifestDigest }
  assert.throws(() => parse(other), hasCode('shape'))
  assert.throws(() => repair.parseNativeEmailAccountRepairJournal(parsed), /account_repair_journal_shape/u)
})

test('rejects unrelated fields, malformed scope and caller traps before touching the filesystem', () => {
  withPrivateDirectory(directory => {
    const filename = join(directory, 'archive.json')
    const input = pins()
    for (const field of ['operationId', 'manifestDigest', 'approvalDigest', 'targetFingerprint', 'fenceEpoch']) {
      assert.throws(() => reserve(filename, { ...input, [field]: input[field] + '\n' }), hasCode('pins'))
    }
    assert.throws(() => reserve(filename, { ...input, purpose: 'other' }), hasCode('domain'))
    assert.throws(() => reserve(filename, { ...input, version: 2 }), hasCode('domain'))
    assert.throws(() => reserve(filename, { ...input, envelope: {} }), hasCode('shape'))
    assert.throws(() => reserve(filename, { ...input, [Symbol('hidden')]: 1 }), hasCode('shape'))
    assert.throws(() => reserve(filename, new Proxy(input, { ownKeys() { throw Error('unexpected proxy trap') } })), hasCode('shape'))
    let reads = 0
    const accessor = { ...input }
    Object.defineProperty(accessor, 'operationId', { enumerable: true, get() { reads++; return uid(1) } })
    assert.throws(() => reserve(filename, accessor), hasCode('shape'))
    assert.equal(reads, 0)
    assert.deepEqual(fs.readdirSync(directory), [])
  })
})

test('creates one protected canonical reservation and never overwrites a complete or partial attempt', () => {
  withPrivateDirectory(directory => {
    const filename = join(directory, 'archive.json'), partial = join(directory, 'partial.json')
    const expected = pins(), bytes = native.nativeEmailCanonicalJson(expected) + '\n'
    assert.deepEqual(reserve(filename, expected), expected)
    const entry = fs.statSync(filename)
    assert.equal(entry.mode & 0o7777, 0o600)
    assert.equal(entry.uid, process.geteuid())
    assert.equal(entry.nlink, 1)
    assert.equal(fs.readFileSync(filename, 'utf8'), bytes)
    assert.throws(() => reserve(filename, expected), hasCode('already_reserved'))
    assert.throws(() => reserve(filename, { ...expected, manifestDigest: 'd'.repeat(64) }), hasCode('already_reserved'))
    assert.equal(fs.statSync(filename).ino, entry.ino)
    assert.equal(fs.readFileSync(filename, 'utf8'), bytes)
    fs.writeFileSync(partial, bytes.slice(0, 8), { flag: 'wx', mode: 0o600 })
    assert.throws(() => reserve(partial, expected), hasCode('already_reserved'))
    assert.equal(fs.readFileSync(partial, 'utf8'), bytes.slice(0, 8))
  })
})
