#!/usr/bin/env node
// Actual helper and claim/delivery functions; SQL transactions are modeled.
// Native authority, actual PostgreSQL locking and production are separate gates.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
function load(text, deps) {
  const module = { exports: {} }
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('module', 'exports', 'require', code)(module, module.exports, name => {
    assert.ok(Object.hasOwn(deps, name), 'Unexpected dependency ' + name); return deps[name]
  })
  return module.exports
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = id(1), B = id(2), C = id(3), email = 'member@example.test'
const copy = value => JSON.parse(JSON.stringify(value))
const helperSource = source('app_src/lib/invitationWorkspaceScope.ts')
const invitationSource = source('app_src/lib/invitations.ts')
const ast = ts.createSourceFile('invitations.ts', invitationSource, ts.ScriptTarget.Latest, true)
const functionSource = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)
function invite(primary = A, assigned = [A, B], overrides = {}) {
  return { id: id(10), email, workspace_organization_id: primary, workspace_organization_ids: assigned,
    token_digest: 'a'.repeat(64), expires_at: '2099-01-01', accepted_at: null, revoked_at: null,
    delivery_pending_at: null, sent_at: '2026-10-30', ...overrides }
}
function harness(initial = [invite()]) {
  let invitations = copy(initial)
  const userRow = { email, status: 'invited', reference_code: null, suitecrm_user_id: null }
  let userDeleted = false
  const memberships = new Map([A, B, C].map(organization_id => [organization_id,
    { organization_id, status: 'invited', trashed_at: null, user_status: 'active' }]))
  const queries = [], log = []
  const tx = { async query(sql, values = []) {
    queries.push({ sql, values }); log.push(sql.replace(/\s+/g, ' ').trim())
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('SELECT email FROM app_users')) return { rows: [{ email }] }
    if (normalized.startsWith('SELECT organization_id FROM app_user_organization_memberships')) {
      assert.match(sql, /ORDER BY organization_id FOR UPDATE/); return { rows: [...memberships.values()].map(copy) }
    }
    if (normalized.startsWith('SELECT membership.organization_id')) return { rows: values[1].flatMap(id => memberships.has(id) ? [copy(memberships.get(id))] : []) }
    if (normalized.startsWith('SELECT id::text, workspace_organization_id')) {
      assert.match(sql, /accepted_at IS NULL AND expires_at > now\(\)/)
      assert.match(sql, /revoked_at IS NULL OR delivery_pending_at IS NOT NULL/)
      return { rows: invitations.filter(row => !row.accepted_at && row.expires_at > '2026-10-30'
        && (!row.revoked_at || row.delivery_pending_at) && (row.workspace_organization_id === values[1] || row.workspace_organization_ids?.includes(values[1]))).map(copy) }
    }
    if (normalized.startsWith('UPDATE app_user_invitations SET workspace_organization_id')) {
      const row = invitations.find(row => row.id === values[0]); row.workspace_organization_id = values[1]
      row.workspace_organization_ids = copy(values[2]); if (!values[2].length) row.revoked_at ||= 'now'
      return { rows: [] }
    }
    if (normalized.startsWith('SELECT workspace_organization_id::text')) {
      assert.match(sql, /email = \$2/); assert.match(sql, /FOR UPDATE/)
      return { rows: invitations.filter(row => row.id === values[0] && row.email === values[1]
        && !row.accepted_at && row.delivery_pending_at && row.expires_at > '2026-10-30').map(copy) }
    }
    if (normalized.startsWith('SELECT id::text, delivery_pending_at')) return { rows: [] }
    if (normalized.startsWith('SELECT id::text FROM app_user_invitations')) return { rows: invitations.filter(row => !row.accepted_at && !row.revoked_at).map(row => ({ id: row.id })) }
    if (normalized.startsWith('INSERT INTO app_user_invitations')) {
      const row = invite(values[2], values[3], { id: id(20), token_digest: values[4], delivery_pending_at: 'now', revoked_at: 'now' })
      invitations.push(row); return { rows: [{ id: row.id, expires_at: row.expires_at, supersedes_id: values[7] }] }
    }
    if (normalized.startsWith('UPDATE app_user_invitations SET revoked_at')) {
      for (const row of invitations) if (row.email === values[0] && row.id !== values[1] && !row.accepted_at && !row.revoked_at) row.revoked_at = 'now'
      return { rows: [] }
    }
    if (normalized.startsWith('UPDATE app_user_invitations SET delivery_id')) {
      const row = invitations.find(row => row.id === values[0] && row.delivery_pending_at && !row.accepted_at)
      if (!row) return { rows: [] }
      row.delivery_pending_at = null; row.revoked_at = null; row.sent_at = 'now'; return { rows: [{ id: row.id }] }
    }
    if (normalized.startsWith('UPDATE app_users SET invited_by')) return { rows: [] }
    if (normalized.startsWith('DELETE FROM app_user_invitations WHERE id')) {
      invitations = invitations.filter(row => row.id !== values[0] || !row.delivery_pending_at); return { rows: [] }
    }
    if (normalized.startsWith('DELETE FROM app_users user_record')) {
      assert.match(sql, /to_jsonb\(user_record\) = \$2::jsonb/)
      assert.match(sql, /jsonb_agg\(to_jsonb\(membership\) ORDER BY membership.organization_id\)/)
      assert.match(sql, /jsonb_array_elements\(\$3::jsonb\)/)
      const sorted = values => values.map(row => JSON.stringify(row)).sort()
      if (userRow.status === 'invited' && JSON.stringify(userRow) === values[1]
        && JSON.stringify(sorted([...memberships.values()])) === JSON.stringify(sorted(JSON.parse(values[2])))
        && !invitations.length) { userDeleted = true; return { rows: [{ reference_code: null }] } }
      return { rows: [] }
    }
    assert.fail('Unexpected SQL ' + normalized)
  } }
  const lockCrmNativeEmailAuthorityWithClient = async client => { assert.equal(client, tx); log.push('CONTROL') }
  const helper = load(helperSource, { './persistence/crmNativeEmailAuthority': { lockCrmNativeEmailAuthorityWithClient } })
  const withTransaction = async callback => {
    const before = copy(invitations)
    try { return await callback(tx) } catch (error) { invitations = before; throw error }
  }
  const delivery = load(`import {withTransaction,invitationWorkspaceIds,lockInvitationUserWithClient,requireInvitedWorkspaceScopeWithClient,lockCrmNativeEmailAuthorityWithClient} from 'deps';
    const INVITATION_DELIVERY_STALE_MINUTES=2,INVITATION_LIFETIME_DAYS=7;
    export ${functionSource('claimInvitation')}\nexport ${functionSource('markInvitationDelivered')}\nexport ${functionSource('rollbackInvitation')}`, {
    deps: { withTransaction, ...helper, lockCrmNativeEmailAuthorityWithClient },
  })
  return { helper, delivery, tx, queries, log, memberships, userRow, userDeleted: () => userDeleted, rows: () => copy(invitations),
    remove: organizationId => withTransaction(client => helper.removeWorkspaceFromPendingInvitationsWithClient(client, { email, organizationId })),
    mark: () => delivery.markInvitationDelivered({ email, invitationId: id(10), actorEmail: 'owner@example.test', deliveryId: 'test-delivery' }),
    claim: () => delivery.claimInvitation({ email, actorEmail: 'owner@example.test', digest: 'b'.repeat(64),
      fromAddress: 'test@example.test', organizationId: A, organizationIds: [A, B] }),
  }
}
let checks = 0
async function check(label, fn) { await fn(); checks++; console.log('PASS ' + label) }
await check('scope ordering matches primary-first token acceptance and rejects malformed IDs', () => {
  const { helper } = harness()
  assert.deepEqual(helper.invitationWorkspaceIds(B, [A, B, C, A]), [B, A, C])
  assert.throws(() => helper.invitationWorkspaceIds('invalid', []))
})
await check('removing primary or secondary workspace preserves exact remaining token expiry and rights', async () => {
  for (const [primary, assigned, target, expected] of [[A, [A, B, C], A, [B, C]], [B, [A, B, C], A, [B, C]]]) {
    const original = invite(primary, assigned), h = harness([original]), result = await h.remove(target), row = h.rows()[0]
    assert.deepEqual(result, { trimmedInvitationIds: [id(10)], revokedInvitationIds: [] })
    assert.equal(row.workspace_organization_id, expected[0]); assert.deepEqual(row.workspace_organization_ids, expected)
    for (const key of ['token_digest', 'expires_at', 'accepted_at', 'revoked_at', 'sent_at']) assert.equal(row[key], original[key])
    assert.equal(h.log[0], 'CONTROL'); assert.match(h.log[1], /SELECT email FROM app_users.*FOR UPDATE/)
  }
})
await check('last workspace is revoked without changing accepted expired or unrelated invitations', async () => {
  const untouched = [invite(A, [A], { id: id(11), accepted_at: 'past' }), invite(A, [A], { id: id(12), expires_at: '2020-01-01' }), invite(B, [B], { id: id(13) })]
  const h = harness([invite(A, [A]), ...untouched]), result = await h.remove(A)
  assert.deepEqual(result.revokedInvitationIds, [id(10)])
  assert.equal(h.rows()[0].workspace_organization_id, null); assert.deepEqual(h.rows()[0].workspace_organization_ids, [])
  assert.ok(h.rows()[0].revoked_at); assert.deepEqual(h.rows().slice(1), untouched)
})
await check('in-flight initially revoked invitation is trimmed and actual delivery activates only remaining scope', async () => {
  const h = harness([invite(A, [A, B], { delivery_pending_at: 'past', revoked_at: 'past' })])
  await h.remove(A); h.memberships.get(A).status = 'disabled'; h.memberships.get(A).trashed_at = 'now'
  await h.mark(); assert.deepEqual(h.rows()[0].workspace_organization_ids, [B]); assert.equal(h.rows()[0].revoked_at, null)
  assert.equal(h.rows()[0].token_digest, 'a'.repeat(64))
})
await check('actual delivery cannot reactivate empty trashed disabled missing or expired scopes', async () => {
  for (const fault of ['empty', 'trashed', 'disabled', 'missing', 'expired']) {
    const h = harness([invite(A, [A], { delivery_pending_at: 'past', revoked_at: 'past', ...(fault === 'expired' ? { expires_at: '2020-01-01' } : {}) })])
    if (fault === 'empty') await h.remove(A)
    if (fault === 'trashed') h.memberships.get(A).trashed_at = 'now'
    if (fault === 'disabled') h.memberships.get(A).status = 'disabled'
    if (fault === 'missing') h.memberships.delete(A)
    const before = h.rows(); await assert.rejects(h.mark); assert.deepEqual(h.rows(), before)
    assert.ok(!h.queries.some(({ sql }) => /SET\s+delivery_id/.test(sql)))
  }
})
await check('actual claim validates current memberships under control-first lock before any invitation write', async () => {
  const h = harness([]); await h.claim(); assert.equal(h.rows().length, 1)
  assert.equal(h.log[0], 'CONTROL'); assert.match(h.log[1], /SELECT email FROM app_users.*FOR UPDATE/)
  const invalid = harness([]); invalid.memberships.get(B).trashed_at = 'now'
  await assert.rejects(invalid.claim); assert.equal(invalid.rows().length, 0)
  assert.ok(!invalid.queries.some(({ sql }) => /INSERT INTO app_user_invitations/.test(sql)))
})
await check('failed delivery validation does not revoke an unrelated active invitation', async () => {
  const old = invite(B, [B], { id: id(11) }), h = harness([invite(A, [A], { revoked_at: 'past', delivery_pending_at: 'past' }), old])
  h.memberships.get(A).status = 'disabled'; await assert.rejects(h.mark)
  assert.deepEqual(h.rows()[1], old)
})
await check('token lookup explicitly refuses trashed invited memberships and helper never rewrites token or expiry', () => {
  assert.match(functionSource('invitationByToken'), /membership\.trashed_at IS NOT NULL/)
  const update = helperSource.slice(helperSource.indexOf('UPDATE app_user_invitations'))
  assert.doesNotMatch(update, /token_digest\s*=|expires_at\s*=|INSERT INTO|DELETE FROM/)
})
await check('actual invitation rollback always takes control before user locks even when retaining the user', async () => {
  const h = harness([invite(A, [A], { delivery_pending_at: 'past', revoked_at: 'past' })])
  await h.delivery.rollbackInvitation({ invitation: { id: id(10) }, email, deleteUser: false,
    producedUserRowJson: null, producedMembershipRowJsons: [] })
  assert.equal(h.log[0], 'CONTROL'); assert.match(h.log[1], /SELECT email FROM app_users.*FOR UPDATE/)
  assert.equal(h.rows().length, 0); assert.equal(h.userDeleted(), false)
})
await check('new-user rollback deletes only its exact full user and entire produced membership inventory', async () => {
  for (const fault of ['none', 'new-membership', 'trash', 'identity', 'missing-provenance']) {
    const h = harness([invite(A, [A, B], { delivery_pending_at: 'past', revoked_at: 'past' })]); h.memberships.delete(C)
    const producedUserRowJson = JSON.stringify(h.userRow)
    const producedMembershipRowJsons = [...h.memberships.values()].map(row => JSON.stringify(row))
    if (fault === 'new-membership') h.memberships.set(C, { organization_id: C, status: 'invited', trashed_at: null, user_status: 'active' })
    if (fault === 'trash') { h.memberships.get(A).status = 'disabled'; h.memberships.get(A).trashed_at = 'now' }
    if (fault === 'identity') h.userRow.suitecrm_user_id = id(30)
    await h.delivery.rollbackInvitation({ invitation: { id: id(10) }, email, deleteUser: true,
      producedUserRowJson: fault === 'missing-provenance' ? null : producedUserRowJson, producedMembershipRowJsons })
    assert.equal(h.userDeleted(), fault === 'none'); assert.equal(h.rows().length, 0)
  }
})
console.log(`PASS ${checks} invitation scope/delivery groups; modeled SQL, no database/native/production proof`)
