#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import './test-crm-reviewed-audience-mode.mjs'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
function declarations(path, names) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return names.map(name => {
    const node = ast.statements.find(node => (ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(ast) === name)))
    assert.ok(node, `Actual ${name} must exist`)
    return node.getText(ast)
  }).join('\n')
}
// Real audience and canonical role permission functions; only database rows
// and the fingerprint dependency are synthetic. This does not prove SQL policy
// trigger concurrency or actual native access and does not contact a provider.
const source = declarations('app_src/lib/users.ts', ['OWNER_PERMISSIONS', 'normalizePermissions', 'permissionsForRole'])
  + '\n' + declarations('app_src/lib/crm/nativeEmailEligibility.ts', ['viewCrmPermission', 'nativeEmailPrincipalIsEligible',
    'nativeEmailManualPipelinePrincipals','nativeEmailEffectivePipelinePrincipals'])
  + '\n' + declarations('app_src/lib/persistence/crm.ts', ['reviewedEmailAudienceUnderNativeControlWithClient'])
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = () => ({ email: 'owner@example.test', suitecrm_user_id: 'native-owner', membership_role: 'owner',
  status:'active',membership_status:'active',membership_permissions: {}, membership_trashed_at: null, access_role: null, native_identity_count: 1 })
const member = () => ({ email: 'reader@example.test', suitecrm_user_id: 'native-reader', membership_role: 'member',
  status:'active',membership_status:'active',membership_permissions: { viewCrm: true }, membership_trashed_at: null, access_role: 'viewer', native_identity_count: 1 })
const copy = value => JSON.parse(JSON.stringify(value))
function harness(readers = [owner(), member()], scopeOverride) {
  const queries = []
  const scope = scopeOverride === undefined ? [{ workspace_id: id(1), owner_email: 'owner@example.test',
    owner_native_id: 'native-owner', is_demo: false }] : scopeOverride
  const client = { async query(sql, params) {
    queries.push(sql)
    assert.doesNotMatch(sql, /FOR (?:SHARE|UPDATE)|INSERT |UPDATE |DELETE /i,
      'Audience must remain plain read under caller-owned native control')
    assert.deepEqual(copy(params), [id(2)])
    if (sql.includes('owner_user.suitecrm_user_id AS owner_native_id')) {
      assert.match(sql, /NOT pipeline.reference_access_disabled/)
      assert.match(sql, /workspace.id = pipeline.workspace_organization_id/)
      return { rows: copy(scope) }
    }
    assert.match(sql, /JOIN LATERAL/)
    assert.match(sql, /LEFT JOIN app_users/)
    assert.match(sql, /LEFT JOIN app_user_organization_memberships/)
    assert.match(sql, /workspace_member.organization_id = pipeline.workspace_organization_id/)
    assert.match(sql, /identity_user.suitecrm_user_id = app_user.suitecrm_user_id/)
    assert.match(sql, /LIMIT 501/)
    return { rows: copy(readers) }
  } }
  const runtime = { exports: {}, collectNativeEmailRootSourcesWithClient:async()=>[],projectNativeEmailRootReaders:()=>[],
    requireNativeEmail:(condition,code)=>assert.ok(condition,code), suiteCrmEmailAudienceFingerprint: value =>
    crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') }
  vm.runInNewContext(compiled, runtime)
  return { run: () => runtime.exports.reviewedEmailAudienceUnderNativeControlWithClient(client, id(2)), queries }
}

test('native audience includes the explicit pipeline owner and valid workspace CRM readers', async () => {
  const h = harness(), result = await h.run()
  assert.deepEqual(copy(result.allowedSuiteCrmUserIds), ['native-owner', 'native-reader'])
  assert.equal(result.ownerSuiteCrmId, 'native-owner')
  assert.equal(result.workspaceId, id(1))
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(h.queries.length, 2)
})

test('canonical owner override is preserved and valid denied/inactive members are excluded without losing intent', async () => {
  await harness([{ ...owner(), membership_permissions: { viewCrm: false } }]).run()
  for (const membership_role of ['member', 'admin']) {
    const result=await harness([owner(), { ...member(), membership_role,membership_permissions: { viewCrm: false } }]).run()
    assert.deepEqual(copy(result.allowedSuiteCrmUserIds),['native-owner'])
  }
  for(const denied of [{status:'disabled'},{status:'invited'},{membership_status:'disabled'},{membership_status:'invited'},
    {membership_trashed_at:'2026-10-30T12:00:00Z'}]){
    assert.deepEqual(copy((await harness([owner(),{...member(),...denied}]).run()).allowedSuiteCrmUserIds),['native-owner'])
    await assert.rejects(harness([{...owner(),...denied},member()]).run(),/unambiguous active CRM readers/)
  }
  const result = await harness([owner(), { ...member(), membership_role: 'admin', membership_permissions: {} }]).run()
  assert.equal(result.allowedSuiteCrmUserIds.length, 2, 'Canonical default viewCrm remains enabled')
})

test('malformed, ambiguous or missing identities still hold even for denied readers', async () => {
  for (const change of [
    { membership_trashed_at: 'invalid' }, { membership_role: 'unexpected' }, {status:'unknown'}, {membership_status:null},
    { membership_permissions: null }, { membership_permissions: [] }, { membership_permissions: { viewCrm: 'false' } },
    { access_role: null }, { access_role: 'owner' }, { suitecrm_user_id: null },
    { suitecrm_user_id: 'native-reader\n' }, { native_identity_count: 2 },
  ]) await assert.rejects(harness([owner(), { ...member(), ...change }]).run(), /unambiguous active CRM readers/)
  await assert.rejects(harness([owner(), member(), member()]).run(), /unambiguous active CRM readers/)
  await assert.rejects(harness([owner(), { ...member(), suitecrm_user_id: 'native-owner' }]).run(), /unambiguous active CRM readers/)
  await assert.rejects(harness([owner(),{...member(),status:'disabled',suitecrm_user_id:null}]).run(),/unambiguous active CRM readers/)
})

test('explicit app-only members retain app scope without becoming native readers or duplicate null identities', async () => {
  const appOnly = { ...member(), email: 'app-only@example.test', suitecrm_user_id: null, native_identity_count: 0 }
  const expected = copy(await harness().run())
  for (const permission of [true, false]) {
    const actual = copy(await harness([owner(), member(), { ...appOnly, membership_permissions: { viewCrm: permission } },
      { ...appOnly, email: 'app-only-two@example.test' }]).run())
    assert.deepEqual(actual, expected, 'Native audience and fingerprint must not change with app-only sharing or module status')
  }
  for (const invalid of [{ native_identity_count: null }, { native_identity_count: '0' }, { native_identity_count: 1 },
    { native_identity_count: 2 }, { suitecrm_user_id: undefined }, { membership_status: null }, { access_role: null }]) {
    await assert.rejects(harness([owner(), { ...appOnly, ...invalid }]).run(), /unambiguous active CRM readers/)
  }
  await assert.rejects(harness([owner(), appOnly, appOnly]).run(), /unambiguous active CRM readers/)
  await assert.rejects(harness([{ ...owner(), suitecrm_user_id: null, native_identity_count: 0 }]).run(), /unambiguous active CRM readers/)
})

test('missing owner membership, inconsistent owner identity, absent/disabled scope and excessive audience hold', async () => {
  await assert.rejects(harness([member()]).run(), /unambiguous active CRM readers/)
  await assert.rejects(harness([{ ...owner(), suitecrm_user_id: 'different-owner' }]).run(), /unambiguous active CRM readers/)
  await assert.rejects(harness([], []).run(), /unambiguous active CRM readers/)
  await assert.rejects(harness([owner()], [{ workspace_id: id(1), owner_email: owner().email,
    owner_native_id: owner().suitecrm_user_id, is_demo: true }]).run(), /unambiguous active CRM readers/)
  await assert.rejects(harness(Array.from({ length: 501 }, (_, i) => ({ ...member(), email: `reader${i}@example.test`,
    suitecrm_user_id: `native-${i}` }))).run(), /unambiguous active CRM readers/)
})
