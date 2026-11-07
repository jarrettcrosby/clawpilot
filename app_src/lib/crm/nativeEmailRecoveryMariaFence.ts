import 'server-only'
import {nativeEmailDigest, requireNativeEmail} from './nativeEmailPublication'
import {nativeEmailMariaStoreFingerprint} from './nativeEmailRecoveryStoreBinding'

type Account = Readonly<{user:string; host:string}>
export type NativeEmailRecoveryMariaFenceTarget = Readonly<{
  database:string; hostname:string; serverId:string; serverVersion:string; serverUid:string; observer:Account;
  ordinaryWriterAccounts:readonly Account[];
}>
/** The adapter must own a single direct connection, never a shared or routed pool. */
type Observer = {query:(sql:string, values?:string[])=>Promise<{rows:unknown[]}>}
type Row = Record<string,unknown>

const USER=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}(?![\s\S])/u
const HOST=/^[A-Za-z0-9%_:.][A-Za-z0-9%_:./-]{0,254}(?![\s\S])/u
const EPOCH=/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z(?![\s\S])/u
const POSITIVE=/^[1-9][0-9]{0,19}(?![\s\S])/u
const MAX_ACCOUNTS=24

const IDENTITY=`SELECT DATABASE() AS database_name, @@GLOBAL.hostname AS hostname,
  CAST(@@GLOBAL.server_id AS CHAR) AS server_id, VERSION() AS server_version, @@GLOBAL.server_uid AS server_uid,
  CURRENT_USER() AS \`current_user\`, SUBSTRING_INDEX(SESSION_USER(),'@',1) AS session_login_user,
  CAST(CONNECTION_ID() AS CHAR) AS connection_id, CURRENT_ROLE() AS \`current_role\`,
  CAST(@@SESSION.autocommit AS CHAR) AS autocommit, CAST(@@SESSION.in_transaction AS CHAR) AS in_transaction,
  @@GLOBAL.event_scheduler AS event_scheduler, CAST(@@GLOBAL.wsrep_on AS CHAR) AS wsrep_on,
  @@GLOBAL.wsrep_provider AS wsrep_provider, DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS observed_at`
const PROCESS_GRANT=`SELECT CAST(CONNECTION_ID() AS CHAR) AS connection_id, CAST(COUNT(*) AS CHAR) AS direct_process_grants
  FROM information_schema.USER_PRIVILEGES WHERE BINARY GRANTEE=BINARY ? AND PRIVILEGE_TYPE='PROCESS'`
const CLIENTS=`SELECT CAST(CONNECTION_ID() AS CHAR) AS observer_connection_id, CAST(ID AS CHAR) AS connection_id,
  USER AS process_user, DB AS database_name, COMMAND AS command_name FROM information_schema.PROCESSLIST LIMIT 2`

function accountLocks(userCount:number) {
  // Include all host variants of each approved ordinary user; otherwise a
  // same-name login at a different host could silently bypass an exact lock.
  // Project only the JSON boolean, never authentication material or raw Priv.
  return `SELECT CAST(CONNECTION_ID() AS CHAR) AS connection_id, User AS account_user, Host AS account_host,
    CASE WHEN JSON_TYPE(JSON_EXTRACT(Priv,'$.account_locked'))='BOOLEAN'
      AND JSON_UNQUOTE(JSON_EXTRACT(Priv,'$.account_locked'))='true' THEN '1' ELSE '0' END AS account_locked
    FROM mysql.global_priv WHERE BINARY User IN (${Array(userCount).fill('?').join(',')}) LIMIT ${MAX_ACCOUNTS+1}`
}

function need(value:unknown, code:string):asserts value {
  requireNativeEmail(value,'legacy_dispatch_maria_fence_'+code)
}
const matches=(value:unknown, pattern:RegExp):value is string=>typeof value==='string'&&pattern.test(value)
const row=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value)
const account=(value:unknown):value is Account=>row(value)&&matches(value.user,USER)&&matches(value.host,HOST)
const accountKey=(value:Account)=>`${value.user}@${value.host}`
const threadId=(value:unknown):value is string=>matches(value,POSITIVE)&&(value.length<20||value<='18446744073709551615')
const timestamp=(value:unknown):value is string=>{
  if(!matches(value,EPOCH))return false
  const milliseconds=value.slice(0,-4)+'Z', date=new Date(milliseconds)
  return Number.isFinite(date.valueOf())&&date.toISOString()===milliseconds
}

/** Read-only observations of a closed, standalone MariaDB writer lane.
 * This does not lock an account, drain a session, or prove a continuous
 * production fence. The controller must separately close and retain both
 * stores' writer fences, pin this target independently, and keep ordinary
 * writers stopped across the bounded recovery action and readback.
 *
 * Use an exclusive direct observer with direct PROCESS and authority to
 * read the lock projection, XA inventory, and all inbound replication
 * channels. Do not log rows or forward driver errors; XA and replication
 * inventories may contain private identifiers. Unavailable metadata (even
 * on a server where a feature is believed disabled) is not proof of absence.
 * The direct adapter owns short connection and statement deadlines.
 */
export async function observeNativeEmailRecoveryMariaFence(client:Observer, supplied:NativeEmailRecoveryMariaFenceTarget) {
  need(supplied&&account(supplied.observer)
    &&Array.isArray(supplied.ordinaryWriterAccounts)&&supplied.ordinaryWriterAccounts.length>0
    &&supplied.ordinaryWriterAccounts.length<=MAX_ACCOUNTS,'target_invalid')
  const {database,hostname,serverId,serverVersion,serverUid}=supplied
  let expectedStoreFingerprint:string
  try { expectedStoreFingerprint=nativeEmailMariaStoreFingerprint({database,hostname,serverId,serverVersion,serverUid}) }
  catch { need(false,'target_invalid') }
  const observer={user:supplied.observer.user,host:supplied.observer.host}
  const ordinary=supplied.ordinaryWriterAccounts.map(value=>{
    need(account(value)&&value.user!==observer.user,'inventory_invalid')
    return {user:value.user,host:value.host}
  })
  const expected=new Set(ordinary.map(accountKey))
  need(expected.size===ordinary.length,'inventory_invalid')
  const users=[...new Set(ordinary.map(value=>value.user))].sort()
  const rows=async(sql:string, parameters?:string[])=>{
    let result:{rows:unknown[]}
    try { result=await client.query(sql,parameters) } catch { need(false,'observation_failed') }
    need(Array.isArray(result?.rows),'observation_shape')
    return result.rows
  }
  const one=async(sql:string, parameters?:string[])=>{
    const data=await rows(sql,parameters)
    need(data.length===1&&row(data[0]),'observation_shape')
    return data[0]
  }
  const identity=async()=>{
    const data=await one(IDENTITY)
    need(data.database_name===database&&data.hostname===hostname&&data.server_id===serverId
      &&data.server_version===serverVersion&&data.server_uid===serverUid
      &&data.current_user===accountKey(observer)&&data.session_login_user===observer.user
      &&threadId(data.connection_id),'identity_unproven')
    const storeFingerprint=nativeEmailMariaStoreFingerprint({database:data.database_name,hostname:data.hostname,
      serverId:data.server_id,serverVersion:data.server_version,serverUid:data.server_uid})
    need(storeFingerprint===expectedStoreFingerprint,'identity_unproven')
    need(data.current_role===null&&data.autocommit==='ON'&&data.in_transaction==='0','observer_session_unproven')
    need(data.event_scheduler==='OFF'&&data.wsrep_on==='OFF'&&data.wsrep_provider==='none','background_writers_unproven')
    need(timestamp(data.observed_at),'observation_clock_unproven')
    return {id:data.connection_id,at:data.observed_at,storeFingerprint}
  }

  const before=await identity()
  // Quoted grantee syntax is MariaDB's exact USER_PRIVILEGES representation.
  // Account input disallows quote/backslash, and the value is parameterized.
  const direct=await one(PROCESS_GRANT,[`'${observer.user}'@'${observer.host}'`])
  need(direct.connection_id===before.id&&direct.direct_process_grants==='1','process_visibility_unproven')
  const locks=await rows(accountLocks(users.length),users)
  need(locks.length===expected.size,'account_locks_unproven')
  const seen=new Set<string>()
  for(const lock of locks){
    need(row(lock)&&lock.connection_id===before.id&&lock.account_locked==='1'&&matches(lock.account_user,USER)
      &&matches(lock.account_host,HOST),'account_locks_unproven')
    const key=accountKey({user:lock.account_user,host:lock.account_host})
    need(expected.has(key)&&!seen.has(key),'account_locks_unproven')
    seen.add(key)
  }
  const verifyClients=async()=>{
    const clients=await rows(CLIENTS)
    need(clients.length===1&&row(clients[0]),'client_drain_unproven')
    const client=clients[0]
    need(client.observer_connection_id===before.id&&client.connection_id===before.id&&client.process_user===observer.user
      &&client.database_name===database&&(client.command_name==='Query'||client.command_name==='Execute'),'client_drain_unproven')
  }
  await verifyClients()
  need((await rows('XA RECOVER')).length===0,'prepared_transactions_present')
  need((await rows('SHOW ALL SLAVES STATUS')).length===0,'inbound_replication_present')
  await verifyClients()
  const after=await identity()
  need(after.id===before.id,'connection_changed')
  need(after.storeFingerprint===before.storeFingerprint,'identity_unproven')
  need(after.at>=before.at,'observation_clock_unproven')
  return Object.freeze({version:1 as const, observationStartedAt:before.at, observedAt:after.at,storeFingerprint:after.storeFingerprint,
    targetFingerprint:nativeEmailDigest({database,hostname,serverId,serverVersion,serverUid,observer,
      ordinaryWriterAccounts:[...ordinary].sort((a,b)=>accountKey(a)<accountKey(b)?-1:1)}),
    closedOrdinaryAccounts:ordinary.length, otherClients:0 as const, preparedTransactions:0 as const,
    inboundReplicationChannels:0 as const, eventSchedulerOff:true as const, wsrepDisabled:true as const})
}
