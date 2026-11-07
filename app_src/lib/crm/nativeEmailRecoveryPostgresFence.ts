import 'server-only'
import {nativeEmailDigest, requireNativeEmail} from './nativeEmailPublication'
import {nativeEmailPostgresStoreFingerprint} from './nativeEmailRecoveryStoreBinding'

type SessionPin = Readonly<{role:string; pid:number; backendStartedAt:string}>
export type NativeEmailRecoveryPostgresFenceTarget = Readonly<{
  database:string; databaseOid:string; systemIdentifier:string; verifierRole:string;
  ordinaryWriterRoles:readonly string[]; authorizedIdleSessions:readonly SessionPin[];
}>
type Observer = {query:(sql:string, values?:string[][])=>Promise<{rows:unknown[]}>}
type Row = Record<string,unknown>
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/u
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u
const clientType='client backend'
const clusterBackgrounds = new Set(['archiver','autovacuum launcher','background writer','checkpointer','io worker','walwriter'])
const bootstrapRoleOid='10'
const MAX_ACTIVITIES=128

// pg_stat_activity can reuse a local snapshot in a transaction. Explicitly
// clear it on the same dedicated session before querying it. This does not
// change durable data or other sessions. Check read-committed so catalog
// observations cannot come from an older repeatable-read snapshot either.
const CLEAR_SNAPSHOT = `SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.pg_stat_clear_snapshot()`
const OBSERVE = `WITH observation AS MATERIALIZED (
  SELECT pg_catalog.current_database() AS database, d.oid::text AS database_oid,
    control.system_identifier::text AS system_identifier, SESSION_USER::text AS session_user,
    CURRENT_USER::text AS current_user, pg_catalog.pg_backend_pid() AS pid,
    pg_catalog.pg_has_role(CURRENT_USER, 'pg_read_all_stats', 'USAGE') AS stats_visible,
    pg_catalog.current_setting('track_activities') = 'on' AS track_activities,
    pg_catalog.current_setting('transaction_read_only') = 'on' AS read_only,
    pg_catalog.current_setting('transaction_isolation') = 'read committed' AS read_committed,
    pg_catalog.pg_is_in_recovery() AS in_recovery,
    pg_catalog.to_char(pg_catalog.statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
  FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() control
  WHERE d.datname = pg_catalog.current_database()
), activities AS MATERIALIZED (
  SELECT pid, usename::text AS role, usesysid::text AS role_oid, datid::text AS database_oid, backend_type, state,
    xact_start IS NOT NULL AS in_transaction,
    pg_catalog.to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_started_at
  FROM pg_catalog.pg_stat_activity LIMIT ${MAX_ACTIVITIES+1}
), roles AS MATERIALIZED (
  SELECT rolname::text AS role, rolcanlogin AS can_login FROM pg_catalog.pg_roles
  WHERE rolname::text = ANY($1::text[])
)
SELECT observation.*,
  COALESCE((SELECT pg_catalog.jsonb_agg(activities) FROM activities), '[]'::jsonb) AS activities,
  COALESCE((SELECT pg_catalog.jsonb_agg(roles) FROM roles), '[]'::jsonb) AS roles,
  (SELECT count(*)::text FROM pg_catalog.pg_prepared_xacts) AS prepared_count
FROM observation`

function need(value:unknown, code:string):asserts value {
  requireNativeEmail(value, 'legacy_dispatch_postgres_fence_'+code)
}
const matches=(v:unknown,re:RegExp):v is string=>typeof v==='string'&&re.test(v)&&!v.endsWith('\n')
const isPid=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>0&&v<=2147483647
const isRow=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)

/** Observe a PostgreSQL writer drain without changing roles, data or sessions.
 * This is a point-in-time assertion, not a writer fence, a MariaDB observation,
 * or authority to call the publisher. The controller must separately stop
 * producers, retain the login fence, and recheck around the authorized action.
 * Use an exclusive dedicated direct session in read-committed, read-only mode,
 * with authenticated pg_read_all_stats plus pg_control_system() visibility. */
export async function observeNativeEmailRecoveryPostgresFence(client:Observer, supplied:NativeEmailRecoveryPostgresFenceTarget) {
  need(supplied&&matches(supplied.verifierRole,NAME)&&Array.isArray(supplied.ordinaryWriterRoles)
    &&Array.isArray(supplied.authorizedIdleSessions),'target_invalid')
  const {database,databaseOid,systemIdentifier,verifierRole}=supplied
  let expectedStoreFingerprint:string
  try { expectedStoreFingerprint=nativeEmailPostgresStoreFingerprint({database,databaseOid,systemIdentifier}) }
  catch { need(false,'target_invalid') }
  const ordinary=[...supplied.ordinaryWriterRoles]
  const operators=supplied.authorizedIdleSessions.map(p=>({role:p?.role,pid:p?.pid,backendStartedAt:p?.backendStartedAt}))
  need(ordinary.length>0&&ordinary.length<=24&&ordinary.every(r=>matches(r,NAME)&&r!==verifierRole)
    &&new Set(ordinary).size===ordinary.length&&operators.length<=8
    &&operators.every(p=>matches(p.role,NAME)&&p.role!==verifierRole&&!ordinary.includes(p.role)&&isPid(p.pid)
      &&matches(p.backendStartedAt,TIME))&&new Set(operators.map(p=>p.pid)).size===operators.length,'inventory_invalid')
  const expectedRoles=new Map<string,boolean>([[verifierRole,true],...ordinary.map(r=>[r,false] as const),
    ...operators.map(p=>[p.role,true] as const)])
  let result:{rows:unknown[]}, snapshot:{rows:unknown[]}
  try { snapshot=await client.query(CLEAR_SNAPSHOT); result=await client.query(OBSERVE,[[...expectedRoles.keys()].sort()]) }
  catch { need(false,'observation_failed') }
  need(Array.isArray(snapshot?.rows)&&snapshot.rows.length===1&&isRow(snapshot.rows[0])&&isPid(snapshot.rows[0].pid),
    'observation_shape')
  need(Array.isArray(result?.rows)&&result.rows.length===1&&isRow(result.rows[0]),'observation_shape')
  const row=result.rows[0]
  need(row.database===database&&row.database_oid===databaseOid&&row.system_identifier===systemIdentifier
    &&row.current_user===verifierRole&&row.session_user===verifierRole&&row.pid===snapshot.rows[0].pid
    &&row.in_recovery===false,'identity_unproven')
  const storeFingerprint=nativeEmailPostgresStoreFingerprint({database:row.database,databaseOid:row.database_oid,
    systemIdentifier:row.system_identifier})
  need(storeFingerprint===expectedStoreFingerprint,'identity_unproven')
  need(row.stats_visible===true&&row.track_activities===true&&row.read_only===true&&row.read_committed===true&&matches(row.observed_at,TIME),
    'visibility_unproven')
  need(row.prepared_count==='0','prepared_transactions_present_or_unproven')
  need(Array.isArray(row.roles)&&row.roles.length===expectedRoles.size,'role_inventory_unproven')
  const roles=new Map<string,boolean>()
  for (const role of row.roles) {
    need(isRow(role)&&typeof role.role==='string'&&typeof role.can_login==='boolean'
      &&!roles.has(role.role)&&expectedRoles.get(role.role)===role.can_login,'role_inventory_unproven')
    roles.set(role.role,role.can_login)
  }
  need(Array.isArray(row.activities)&&row.activities.length>0&&row.activities.length<=MAX_ACTIVITIES,'session_inventory_unproven')
  const seen=new Set<number>(), observedOperators=new Set<number>()
  let observedVerifier=false
  for (const activity of row.activities) {
    need(isRow(activity)&&isPid(activity.pid)&&!seen.has(activity.pid),'session_inventory_unproven')
    seen.add(activity.pid)
    if(activity.pid===row.pid){
      need(activity.backend_type===clientType&&activity.role===verifierRole&&activity.database_oid===databaseOid
        &&activity.state==='active'&&activity.in_transaction===true&&matches(activity.backend_started_at,TIME),'observer_session_unproven')
      observedVerifier=true
      continue
    }
    if (typeof activity.backend_type==='string'&&(clusterBackgrounds.has(activity.backend_type)
        ||activity.backend_type==='logical replication launcher')) {
      // PostgreSQL 18 reports IO workers. The unconnected logical launcher
      // reports the bootstrap role, but its connected workers are never allowed.
      const systemRole=activity.backend_type==='logical replication launcher'
        ?activity.role_oid===bootstrapRoleOid&&matches(activity.role,NAME):activity.role_oid===null&&activity.role===null
      need(systemRole&&activity.database_oid===null&&activity.state===null&&activity.in_transaction===false,'unexpected_session')
      continue
    }
    const pin=operators.find(p=>p.pid===activity.pid)
    need(pin&&activity.backend_type===clientType&&activity.role===pin.role&&activity.database_oid===databaseOid
      &&activity.state==='idle'&&activity.in_transaction===false&&activity.backend_started_at===pin.backendStartedAt,'unexpected_session')
    observedOperators.add(pin.pid)
  }
  need(observedVerifier&&observedOperators.size===operators.length,'session_inventory_unproven')
  return Object.freeze({version:1 as const, observedAt:row.observed_at,storeFingerprint,
    targetFingerprint:nativeEmailDigest({database,databaseOid,systemIdentifier,verifierRole,
      ordinaryWriterRoles:[...ordinary].sort(),authorizedIdleSessions:[...operators].sort((a,b)=>a.pid-b.pid)}),
    closedOrdinaryRoles:ordinary.length, authorizedIdleSessions:operators.length, preparedTransactions:0 as const})
}
