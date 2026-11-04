import { archiveCrmRecordInPostgres } from '@/lib/persistence/crm'
import { query } from '@/lib/persistence/postgres'
import { inspectSuiteCrmRecordLifecycle, type SuiteCrmRecordLifecycleIdentity } from '@/lib/crm/suiteCrmRecordLifecycleClient'
import type { SuiteCrmAccountContactModule, SuiteCrmRecordSnapshot } from '@/lib/crm/suiteCrmClient'

const CURSOR_KEY = 'crm.suitecrm.account_contact_lifecycle.cursor'
const MAX_RECORDS_PER_RUN = 100
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const NATIVE_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}(?![\s\S])/
type LocalRecord = { module: SuiteCrmAccountContactModule; local_id: string; pipeline_id: string;
  workspace_id: string | null; owner_email: string; native_id: string; global_id: string;
  protected_identity: boolean; identity_match_count: string | number; cursor_key: string }
export type AccountContactTombstoneResult = { matched: number; archived: number; protected: number;
  held: number; pipelineIds: string[] }
export type SuiteCrmAccountContactLifecycleCounts = { enabled: boolean; scanned: number; inspected: number;
  archived: number; protected: number; held: number; missing: number; errors: number; pending: boolean; pipelineIds: string[] }

// Correlation includes archived copies: an old or cross-pipeline duplicate is
// not permission to fan a native tombstone out to multiple tenant records.
const LOCAL_RECORDS = `WITH records AS (
  SELECT 'Accounts'::text AS module, organization.id::text AS local_id,
    organization.pipeline_id::text AS pipeline_id, pipeline.workspace_organization_id::text AS workspace_id,
    pipeline.owner_email, organization.suitecrm_id AS native_id, organization.reference_code AS global_id,
    (organization.workspace_organization_id IS NOT NULL
      OR organization.relationship_type IN ('workspace_root','workspace_member')) AS protected_identity,
    (SELECT count(*) FROM crm_organizations candidate WHERE lower(candidate.suitecrm_id)=lower(organization.suitecrm_id)
      OR lower(candidate.reference_code)=lower(organization.reference_code)) AS identity_match_count,
    'Accounts:' || organization.id::text AS cursor_key
  FROM crm_organizations organization JOIN pipeline_spaces pipeline ON pipeline.id=organization.pipeline_id
  WHERE organization.suitecrm_id IS NOT NULL
    AND COALESCE(lower(organization.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
  UNION ALL
  SELECT 'Contacts', contact.id::text, contact.pipeline_id::text, pipeline.workspace_organization_id::text,
    pipeline.owner_email, contact.suitecrm_id, contact.reference_code,
    (contact.app_user_email IS NOT NULL OR contact.pipeline_user IS TRUE OR COALESCE(contact.contact_type,'')='pipeline_user'),
    (SELECT count(*) FROM crm_contacts candidate WHERE lower(candidate.suitecrm_id)=lower(contact.suitecrm_id)
      OR lower(candidate.reference_code)=lower(contact.reference_code)), 'Contacts:' || contact.id::text
  FROM crm_contacts contact JOIN pipeline_spaces pipeline ON pipeline.id=contact.pipeline_id
  WHERE contact.suitecrm_id IS NOT NULL
    AND COALESCE(lower(contact.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
)
SELECT * FROM records`

function validGlobal(module: SuiteCrmAccountContactModule, value: unknown): value is string {
  return typeof value === 'string' && (module === 'Accounts' ? /^ga(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/
    : /^gc(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/).test(value)
}
function identity(row: LocalRecord): SuiteCrmRecordLifecycleIdentity {
  return { module: row.module, nativeId: row.native_id, globalId: row.global_id }
}
function exactIdentity(left: SuiteCrmRecordLifecycleIdentity, right: SuiteCrmRecordLifecycleIdentity) {
  return left.module === right.module && left.nativeId === right.nativeId && left.globalId === right.globalId
}
function safeLocal(row: LocalRecord) {
  return (row.module === 'Accounts' || row.module === 'Contacts') && UUID.test(row.local_id)
    && UUID.test(row.pipeline_id) && typeof row.workspace_id === 'string' && UUID.test(row.workspace_id)
    && typeof row.native_id === 'string' && NATIVE_ID.test(row.native_id) && validGlobal(row.module, row.global_id)
    && typeof row.owner_email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(row.owner_email)
    && row.owner_email === row.owner_email.toLowerCase()
    && Number(row.identity_match_count) === 1 && typeof row.protected_identity === 'boolean'
    && row.cursor_key === `${row.module}:${row.local_id}`
}
async function archiveExact(row: LocalRecord) {
  // Revalidated inside the archive transaction: a concurrent rebind or newly
  // ambiguous native identity cannot turn this observation into a deletion.
  return archiveCrmRecordInPostgres({ pipelineId: row.pipeline_id, entity: row.module === 'Accounts' ? 'organizations' : 'contacts',
    id: row.local_id, actorEmail: row.owner_email, emitSuiteCrmOutbox: false, archiveSource: 'suitecrm',
    expectedSuiteCrmIdentity: { nativeId: row.native_id, globalId: row.global_id } })
}

/** Explicit positive tombstones from the authenticated modified-record feed.
 * Missing/invalid global IDs, OR-match conflicts and managed identities hold;
 * absence from a feed never enters this function as deletion evidence. The
 * same opt-in gates both this feed path and the rotating inspection path. */
export async function reconcileSuiteCrmAccountContactTombstone(
  module: SuiteCrmAccountContactModule, snapshot: SuiteCrmRecordSnapshot,
): Promise<AccountContactTombstoneResult> {
  const result: AccountContactTombstoneResult = { matched: 0, archived: 0, protected: 0, held: 0, pipelineIds: [] }
  if (process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED !== '1') return { ...result, held: 1 }
  const deleted = snapshot.attributes.deleted
  if (!(deleted === true || deleted === 1 || deleted === '1' || deleted === 'true')) return result
  const global = snapshot.attributes.global_id_c
  if (!validGlobal(module, global) || !NATIVE_ID.test(snapshot.id)) return { ...result, held: 1 }
  const local = await query<LocalRecord>(`${LOCAL_RECORDS}
    WHERE module=$1 AND (lower(native_id)=lower($2) OR lower(global_id)=lower($3)) ORDER BY cursor_key LIMIT 2`, [module, snapshot.id, global])
  result.matched = local.rows.length
  if (!local.rows.length) return result
  if (local.rows.length !== 1 || !safeLocal(local.rows[0])
    || !exactIdentity(identity(local.rows[0]), { module, nativeId: snapshot.id, globalId: global })) {
    result.held = 1; return result
  }
  const row = local.rows[0]
  if (row.protected_identity) { result.protected = 1; return result }
  const archived = await archiveExact(row)
  if (archived.changed) { result.archived = 1; result.pipelineIds.push(row.pipeline_id) }
  return result
}

/** Rotates known local bindings independently of date_modified. Disabled by
 * default. No provider-wide scan, hard deletion, historical import or 404-as-
 * tombstone inference. Endpoint outages retain this cursor for bounded retry. */
export async function processSuiteCrmAccountContactLifecycle(): Promise<SuiteCrmAccountContactLifecycleCounts> {
  const counts: SuiteCrmAccountContactLifecycleCounts = { enabled: process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED === '1',
    scanned: 0, inspected: 0, archived: 0, protected: 0, held: 0, missing: 0, errors: 0, pending: false, pipelineIds: [] }
  if (!counts.enabled) return counts
  try {
    const cursor = await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1 LIMIT 1', [CURSOR_KEY])
    const value = cursor.rows[0]?.value as { after?: unknown } | undefined
    const after = typeof value?.after === 'string' && /^(Accounts|Contacts):[a-f0-9-]{36}$/.test(value.after) ? value.after : ''
    const local = await query<LocalRecord>(`${LOCAL_RECORDS}
      WHERE cursor_key > $1 ORDER BY cursor_key LIMIT $2`, [after, MAX_RECORDS_PER_RUN])
    counts.scanned = local.rows.length
    const eligible: LocalRecord[] = []
    for (const row of local.rows) {
      if (!safeLocal(row)) counts.held += 1
      else if (row.protected_identity) counts.protected += 1
      else eligible.push(row)
    }
    if (eligible.length) {
      const observed = await inspectSuiteCrmRecordLifecycle(eligible.map(identity))
      // Validate the entire response before archiving any local row, even if a
      // future transport implementation accidentally weakens its pair checks.
      if (observed.length !== eligible.length || observed.some((entry, index) =>
        !exactIdentity(entry, identity(eligible[index])) || !['active', 'deleted', 'missing'].includes(entry.state))) {
        throw new Error('SuiteCRM lifecycle identity changed')
      }
      counts.inspected = observed.length
      const pipelineIds = new Set<string>()
      for (const [index, entry] of observed.entries()) {
        if (entry.state === 'missing') counts.missing += 1
        if (entry.state !== 'deleted') continue
        const row = eligible[index], archived = await archiveExact(row)
        if (archived.changed) {
          counts.archived += 1; pipelineIds.add(row.pipeline_id)
          counts.pipelineIds = [...pipelineIds].sort()
        }
      }
      counts.pipelineIds = [...pipelineIds].sort()
    }
    counts.pending = local.rows.length === MAX_RECORDS_PER_RUN
    await query(`INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2::jsonb,now())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
    [CURSOR_KEY, JSON.stringify({ after: counts.pending ? local.rows.at(-1)!.cursor_key : null })])
  } catch {
    counts.errors += 1
    counts.pending = true
  }
  return counts
}
