#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const migration = read('db/migrations/0037_audit_activity_indexes.sql')
for (const fragment of [
  'ADD COLUMN IF NOT EXISTS event_key text',
  'ADD COLUMN IF NOT EXISTS subject text',
  'ADD COLUMN IF NOT EXISTS organization_id uuid',
  'ADD COLUMN IF NOT EXISTS is_system boolean',
  'CREATE TRIGGER trg_clawpilot_scope_audit_event',
  'idx_audit_events_organization_time',
  'idx_audit_events_system_time',
  "'project.task.'",
  'ON CONFLICT (event_key)',
]) {
  assert.ok(migration.includes(fragment), `audit migration missing ${fragment}`)
}

const audit = read('app_src/lib/audit.ts')
assert.ok(audit.includes("event.is_system = true"), 'global scope must select only platform system events')
assert.ok(audit.includes('event.organization_id = ANY($1::uuid[])'), 'organization scope must use the event-time organization snapshot')
assert.ok(audit.includes("lower(COALESCE(event.subject, '')) = $1"), 'self scope must include events targeting the user')
assert.ok(audit.includes("input.scope === 'global' ? Promise.resolve([])"), 'global system scope must exclude tenant task history')
assert.ok(audit.includes("input.scope === 'global' ? [] : readPipelineEvents"), 'global system scope must exclude tenant pipeline activity')
assert.ok(audit.includes("if (scope === 'global')"), 'global system scope must short-circuit tenant resource discovery')
assert.ok(audit.includes('boardIds: []'), 'global system scope must not load project board IDs')
assert.ok(audit.includes('pipelineIds: []'), 'global system scope must not load pipeline IDs')
assert.ok(audit.includes('SAFE_DETAIL_KEYS'), 'audit DTOs must use a display allowlist')
assert.ok(audit.includes('SENSITIVE_KEY'), 'audit DTOs must retain defense-in-depth secret redaction')
assert.ok(!audit.includes("? 'TRUE'"), 'global scope cannot use an unrestricted tenant query')

const writer = read('app_src/lib/auditWriter.ts')
for (const fragment of ['subject, organization_id, is_system', 'ON CONFLICT (event_key)', 'input.subject', 'input.organizationId']) {
  assert.ok(writer.includes(fragment), `audit writer missing ${fragment}`)
}

const crmAdapter = read('app_src/lib/persistence/crm.ts')
assert.ok(crmAdapter.includes('referenceCode: row.reference_code'), 'CRM audit rows must carry the navigable Global ID')
assert.ok(crmAdapter.includes('recordTitle: title || row.reference_code'), 'CRM audit rows must carry a readable target label')
assert.ok(crmAdapter.includes("WHERE sync_outbox.status IN ('succeeded', 'dead')"), 'CRM restaging must requeue a previously consumed content revision')
assert.ok(crmAdapter.includes('RETURNING idempotency_key'), 'CRM restaging must observe whether SuiteCRM work was inserted or requeued')
assert.ok(crmAdapter.includes('if (suiteCrmOutboxKey)'), 'CRM audit rows must only be written for actual outbox inserts')
assert.ok(crmAdapter.includes('eventKey: `crm-stage:${suiteCrmOutboxKey}`'), 'CRM queue audit rows need deterministic event keys')

const crmAuditDedupe = read('db/migrations/0038_dedupe_crm_stage_audit.sql')
for (const fragment of [
  "event.event_type = 'crm.record.staged'",
  "outbox.target_system = 'suitecrm'",
  "outbox.operation = 'upsert_record'",
  "event_key = 'crm-stage:' || keeper.idempotency_key",
]) {
  assert.ok(crmAuditDedupe.includes(fragment), `CRM audit dedupe migration missing ${fragment}`)
}

const authAudit = read('app_src/lib/authAudit.ts')
assert.ok(authAudit.includes('actor: authenticatedActor ? email : null'), 'unverified login claims cannot be recorded as authenticated actors')
assert.ok(authAudit.includes('subject: email'), 'login attempts must target the claimed user separately')
assert.ok(authAudit.includes('networkFingerprint'), 'login activity must retain a non-reversible network fingerprint')
assert.ok(!authAudit.includes("'x-forwarded-for':"), 'raw client addresses must not be placed in audit payloads')

const route = read('app_src/app/api/activity/route.ts')
for (const fragment of ['parseCursor', "Buffer.from(value, 'base64url')", 'authorizeActivityScope', 'nextCursor']) {
  assert.ok(route.includes(fragment), `activity endpoint missing ${fragment}`)
}

const activityUi = read('app_src/components/activity/ActivityLogPage.tsx')
for (const fragment of ['My activity', 'Organization', 'Global system', '/api/activity?', 'Event details']) {
  assert.ok(activityUi.includes(fragment), `activity UI missing ${fragment}`)
}
assert.ok(!activityUi.includes('defaultModule'), 'activity must not default to the currently selected module')
assert.ok(!activityUi.includes('/api/pipeline/activity'), 'activity must not depend on selected pipeline history')

const header = read('app_src/components/AppHeader.tsx')
assert.ok(header.includes("fetch('/api/activity?limit=100'"), 'header badge must use the scoped activity endpoint')
assert.ok(!header.includes("fetch('/api/pipeline/activity')"), 'header must not use selected pipeline history')

const users = read('app_src/lib/users.ts')
for (const fragment of ['viewOrganizationAudit', 'viewSystemAudit', "eventType: 'user.profile.updated'", "eventType: 'user.access.updated'"]) {
  assert.ok(users.includes(fragment), `user audit contract missing ${fragment}`)
}

console.log('PASS test-audit-activity')
