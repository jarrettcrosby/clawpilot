#!/usr/bin/env node
// Test files are confined to freshly created private temporary directories.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import * as util from 'node:util'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
function load(name, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../app_src/lib/crm/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const known = { 'server-only': {}, 'node:crypto': crypto, 'node:fs': fs, 'node:path': path, 'node:util': util, ...dependencies }
  new Function('require', 'module', 'exports', code)(dependency => {
    assert.ok(Object.hasOwn(known, dependency), dependency)
    return known[dependency]
  }, module, module.exports)
  return module.exports
}
const native = load('nativeEmailPublication')
const loadJournal = (fileSystem = fs) => load('nativeEmailAccountRepairJournal', {
  './nativeEmailPublication': native, 'node:fs': fileSystem,
})
const { parseNativeEmailAccountRepairJournal: parse, reserveNativeEmailAccountRepairJournal: reserve } = loadJournal()
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pins = () => ({
  version: 1, purpose: 'clawpilot-private-native-email-account-repair-journal-v1',
  operationId: uid(1), fenceEpoch: uid(2), reviewDigest: 'a'.repeat(64),
  approvalDigest: 'b'.repeat(64), targetFingerprint: 'c'.repeat(64),
})
const hasCode = code => error => error.code === 'legacy_email_account_repair_journal_' + code

function privateFixture(run) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'clawpilot-repair-journal-'))
  try {
    fs.chmodSync(directory, 0o700)
    return run(directory, path.join(directory, 'repair.json'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('exact journal pins are detached, frozen and round-trip through canonical JSON', () => {
  const input = pins()
  const parsed = parse(Object.assign(Object.create(null), input))
  assert.deepEqual(parsed, input)
  assert.ok(Object.isFrozen(parsed))
  input.approvalDigest = 'd'.repeat(64)
  assert.equal(parsed.approvalDigest, 'b'.repeat(64))
  assert.deepEqual(parse(JSON.parse(native.nativeEmailCanonicalJson(parsed))), parsed)
})

test('strict parser rejects drift, bad shapes and caller-controlled traps without executing them', () => {
  const valid = pins()
  assert.throws(() => parse({ ...valid, secret: 'disallowed' }), hasCode('shape'))
  assert.throws(() => parse({ ...valid, [Symbol('hidden')]: true }), hasCode('shape'))
  assert.throws(() => parse({ ...valid, purpose: 'clawpilot-private-native-email-staging' }), hasCode('domain'))
  assert.throws(() => parse({ ...valid, version: '1' }), hasCode('domain'))
  assert.throws(() => parse(Object.assign(Object.create({ inherited: true }), valid)), hasCode('shape'))
  assert.throws(() => parse(new Proxy(valid, { ownKeys() { throw Error('unexpected trap') } })), hasCode('shape'))
  let reads = 0
  const accessor = { ...valid }
  Object.defineProperty(accessor, 'reviewDigest', { enumerable: true, get() { reads++; return valid.reviewDigest } })
  assert.throws(() => parse(accessor), hasCode('shape'))
  assert.equal(reads, 0)
  for (const key of ['operationId', 'fenceEpoch', 'approvalDigest', 'reviewDigest', 'targetFingerprint']) {
    assert.throws(() => parse({ ...valid, [key]: valid[key] + '\n' }), hasCode('pins'))
  }
  assert.throws(() => parse({ ...valid, approvalDigest: 'A'.repeat(64) }), hasCode('pins'))
})

test('creates one owner-only canonical journal, flushes file then directory, and never reuses it', () => {
  privateFixture((_directory, filename) => {
    const flushed = []
    const observedReserve = loadJournal({
      ...fs,
      fsyncSync(fd) {
        flushed.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file')
        fs.fsyncSync(fd)
      },
    }).reserveNativeEmailAccountRepairJournal
    const expected = pins(), bytes = native.nativeEmailCanonicalJson(expected) + '\n'
    assert.deepEqual(observedReserve(filename, expected), expected)
    assert.deepEqual(flushed, ['file', 'directory'])
    assert.equal(fs.readFileSync(filename, 'utf8'), bytes)
    const before = fs.statSync(filename)
    assert.equal(before.uid, process.geteuid())
    assert.equal(before.mode & 0o7777, 0o600)
    assert.equal(before.nlink, 1)
    assert.throws(() => reserve(filename, expected), hasCode('already_reserved'))
    assert.throws(() => reserve(filename, { ...expected, operationId: uid(3) }), hasCode('already_reserved'))
    assert.equal(fs.statSync(filename).ino, before.ino)
    assert.equal(fs.readFileSync(filename, 'utf8'), bytes)
  })
})

test('refuses noncanonical paths, unsafe directories, symlink parents and symlink files', () => {
  privateFixture((directory, filename) => {
    for (const invalid of ['relative.json', directory + '/./repair.json', directory + '//repair.json',
      filename + '/', directory + '/\nrepair.json']) {
      assert.throws(() => reserve(invalid, pins()), hasCode('path'))
    }
    fs.chmodSync(directory, 0o750)
    assert.throws(() => reserve(filename, pins()), hasCode('directory'))
    assert.equal(fs.existsSync(filename), false)
    fs.chmodSync(directory, 0o700)
    const real = path.join(directory, 'real'), alias = path.join(directory, 'alias')
    fs.mkdirSync(real, { mode: 0o700 })
    fs.symlinkSync(real, alias, 'dir')
    assert.throws(() => reserve(path.join(alias, 'repair.json'), pins()), hasCode('directory'))
    assert.deepEqual(fs.readdirSync(real), [])
    const existing = path.join(directory, 'existing.json')
    fs.writeFileSync(existing, 'unrelated', { mode: 0o600 })
    fs.symlinkSync(existing, filename)
    assert.throws(() => reserve(filename, pins()), hasCode('already_reserved'))
    assert.ok(fs.lstatSync(filename).isSymbolicLink())
    assert.equal(fs.readFileSync(existing, 'utf8'), 'unrelated')
  })
})

test('leaves a partial write or uncertain directory flush untouched; retry is refused', () => {
  for (const interruption of ['partial write', 'directory flush']) {
    privateFixture((_directory, filename) => {
      const failure = Error(interruption)
      const brokenReserve = loadJournal({
        ...fs,
        writeFileSync(fd, data, encoding) {
          if (interruption === 'partial write') {
            fs.writeFileSync(fd, data.slice(0, 9), encoding)
            throw failure
          }
          return fs.writeFileSync(fd, data, encoding)
        },
        fsyncSync(fd) {
          if (interruption === 'directory flush' && fs.fstatSync(fd).isDirectory()) throw failure
          fs.fsyncSync(fd)
        },
      }).reserveNativeEmailAccountRepairJournal
      assert.throws(() => brokenReserve(filename, pins()), error => error === failure)
      const preserved = fs.readFileSync(filename, 'utf8')
      const complete = native.nativeEmailCanonicalJson(pins()) + '\n'
      assert.equal(preserved, interruption === 'partial write' ? complete.slice(0, 9) : complete)
      assert.throws(() => reserve(filename, pins()), hasCode('already_reserved'))
      assert.equal(fs.readFileSync(filename, 'utf8'), preserved)
    })
  }
})
