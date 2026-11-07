import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { planCiAppTests } from './run-ci-app-tests.mjs'

const alias = 'npm run test:production-cutover'
const catalog = 'node scripts/test-production-rebind-history-schema-attestation.mjs'
const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const top = scripts.test.split(' && ')
const cutover = scripts['test:production-cutover'].split(' && ')
const aliasIndex = top.indexOf(alias)
const catalogIndex = cutover.indexOf(catalog)
assert.ok(aliasIndex > 0 && catalogIndex > 0 && catalogIndex < cutover.length - 1)
const expected = [
  'npm run pretest',
  ...top.slice(0, aliasIndex),
  ...cutover.slice(0, catalogIndex),
  ...cutover.slice(catalogIndex + 1),
  ...top.slice(aliasIndex + 1),
]
const original = JSON.stringify(scripts)
const plan = planCiAppTests(scripts)
assert.deepEqual(plan, expected.map(command => command.split(' ')), 'Keep every non-matrix command in the exact package order')
assert.equal(JSON.stringify(scripts), original, 'Planning cannot change the default package chains')
assert.ok(Object.isFrozen(plan) && plan.every(Object.isFrozen), 'Reviewed argv cannot be changed between planning and launch')
assert.deepEqual(plan.slice(-3), [
  ['npm', 'run', 'test:migrated-production-provider-rebind'],
  ['npm', 'run', 'test:tenant-retirement'],
  ['npm', 'run', 'verify:docs'],
])

const tiny = {
  pretest: 'node scripts/local-storage-guard.mjs --preflight',
  test: `npm run test:before && ${alias} && npm run verify:docs`,
  'test:production-cutover': `node scripts/test-first.mjs && ${catalog} && npm run test:after`,
  'test:before': 'true',
  'test:after': 'true',
  'verify:docs': 'true',
}
assert.deepEqual(planCiAppTests(tiny), [
  ['npm', 'run', 'pretest'], ['npm', 'run', 'test:before'], ['node', 'scripts/test-first.mjs'],
  ['npm', 'run', 'test:after'], ['npm', 'run', 'verify:docs'],
])
const denied = [
  [null, /pretest lifecycle/],
  [{ ...tiny, pretest: undefined }, /pretest lifecycle/],
  [{ ...tiny, test: undefined }, /Invalid package script: test/],
  [{ ...tiny, 'test:production-cutover': undefined }, /Missing npm command/],
  [{ ...tiny, test: 'npm run test:before' }, /one top-level/],
  [{ ...tiny, test: `${tiny.test} && ${alias}` }, /one top-level/],
  [{ ...tiny, 'test:production-cutover': 'npm run test:after' }, /one full catalog/],
  [{ ...tiny, 'test:production-cutover': `${tiny['test:production-cutover']} && ${catalog}` }, /one full catalog/],
  [{ ...tiny, 'test:production-cutover': `${tiny['test:production-cutover']} && ${alias}` }, /one full catalog/],
  [{ ...tiny, test: `${tiny.test} && ${catalog}` }, /one full catalog/],
  [{ ...tiny, test: `${tiny.test} && npm run test` }, /one full catalog/],
  [{ ...tiny, test: `npm run pretest && ${tiny.test}` }, /one full catalog/],
  [{ ...tiny, test: `${tiny.test} && npm run nonexistent` }, /Missing npm command/],
  [{ ...tiny, test: `${tiny.test}; echo no` }, /Unsupported command syntax/],
  [{ ...tiny, test: `${tiny.test} && npm run verify:docs -- --focus` }, /Unsupported command syntax/],
  [{ ...tiny, 'test:production-cutover': `${catalog} --check-calendar-schema-delta` }, /Unsupported command syntax/],
  [{ ...tiny, 'test:production-cutover': `${catalog} && node scripts/../escape.mjs` }, /Unsupported command syntax/],
  [{ ...tiny, 'test:production-cutover': `${catalog} && node scripts/two.mjs\n` }, /Unsupported command syntax/],
  [{ ...tiny, test: [alias, ...Array(128).fill('npm run test:before')].join(' && ') }, /Too many commands/],
  [{ ...tiny, test: alias.repeat(2_000) }, /Invalid package script/],
  ...['posttest', 'pretest:production-cutover', 'posttest:production-cutover', 'prepretest', 'postpretest']
    .map(name => [{ ...tiny, [name]: 'true' }, /Review the CI partition for the new npm lifecycle/]),
]
for (const [input, error] of denied) assert.throws(() => planCiAppTests(input), error)

const runner = fileURLToPath(new URL('./run-ci-app-tests.mjs', import.meta.url))
for (const [ci, args] of [['false', []], ['true', ['--skip-anything']]]) {
  const refused = spawnSync(process.execPath, [runner, ...args], {
    env: { ...process.env, CI: ci }, encoding: 'utf8', timeout: 5_000,
  })
  assert.equal(refused.error, undefined)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /requires CI=true and accepts no arguments/)
  assert.equal(refused.stdout, '', 'Rejected CLI invocations cannot start a package command')
}

console.log(`CI app test plan passed: ${plan.length} ordered invocations; ${denied.length} malformed plans and 2 unsafe CLI invocations refused`)
