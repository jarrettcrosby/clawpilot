import 'server-only'
import {isIP} from 'node:net'
import {checkServerIdentity} from 'node:tls'
import {Pool,type PoolClient} from 'pg'
import {NativeEmailPublicationHeld,requireNativeEmail} from './nativeEmailPublication'

export type NativeEmailRecoveryPrivatePostgresTarget = Readonly<{
  host:string;port:number;database:string;user:string;systemIdentifier:string;databaseOid:string;
}>
type Options = Readonly<{target:NativeEmailRecoveryPrivatePostgresTarget;password:string;tlsCa?:string;
  /** Disposable tests only. Hostnames and all remote addresses still require TLS. */
  allowLoopbackFixture?:boolean}>
type SessionPin = Readonly<{role:string;pid:number;backendStartedAt:string}>

const NAME=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u
const DNS_LABEL=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?![\s\S])/u
const INTEGER=/^[1-9][0-9]{0,19}(?![\s\S])/u
const TIMESTAMP=/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z(?![\s\S])/u
const namespace='legacy_dispatch_private_postgres_'
const hold=(code:string)=>new NativeEmailPublicationHeld(namespace+code)
function need(ok:unknown,code:string):asserts ok {requireNativeEmail(ok,namespace+code)}
const matches=(input:unknown,pattern:RegExp):input is string=>typeof input==='string'&&pattern.test(input)
const boundedId=(input:unknown,max:bigint):input is string=>matches(input,INTEGER)&&BigInt(input)<=max
const plain=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'
  &&Object.getPrototypeOf(value)===Object.prototype
const allowedKeys=(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[])=>
  required.every(k=>Object.hasOwn(value,k))&&Reflect.ownKeys(value).every(k=>typeof k==='string'
    &&(required.includes(k)||optional.includes(k))&&'value' in (Object.getOwnPropertyDescriptor(value,k)??{}))

// The private connection verifies its own cluster, not only an observer on a
// different socket. Provision only EXECUTE on pg_control_system() to this
// login; it does not require an owner login or membership in a monitoring role.
const OBSERVE=`SELECT d.datname::text AS database_name,d.oid::text AS database_oid,
  control.system_identifier::text AS system_identifier,SESSION_USER::text AS session_role,
  CURRENT_USER::text AS effective_role,a.pid AS pid,
  pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_started_at,
  NOT pg_catalog.pg_is_in_recovery() AS primary_server,
  COALESCE((SELECT tls.ssl FROM pg_catalog.pg_stat_ssl tls WHERE tls.pid=a.pid),false) AS using_tls,
  pg_catalog.current_setting('transaction_isolation')='read committed'
    AND pg_catalog.current_setting('transaction_read_only')='off' AS transaction_profile,
  r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
    AS restricted_login,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS no_role_membership,
  NOT (EXISTS (SELECT 1 FROM pg_catalog.pg_database x WHERE x.datdba=r.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t WHERE t.typowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_tablespace ts WHERE ts.spcowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_foreign_data_wrapper f WHERE f.fdwowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_foreign_server fs WHERE fs.srvowner=r.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extowner=r.oid)
    OR pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')))
    AS no_ownership_or_create
  FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() control
  JOIN pg_catalog.pg_roles r ON r.rolname=SESSION_USER
  JOIN pg_catalog.pg_stat_activity a ON a.pid=pg_catalog.pg_backend_pid()
  WHERE d.datname=pg_catalog.current_database()`

/** Dedicated bounded connection for the one selected maintenance command.
 * It does not grant privileges, drain writers, install settings, or select a
 * production target from environment defaults. The first backend stays pinned
 * for the command, and an unknown commit requires a fresh exact resolution. */
export function createNativeEmailRecoveryPrivatePostgres(options:Options) {
  need(plain(options)&&allowedKeys(options,['target','password'],['tlsCa','allowLoopbackFixture']),'configuration')
  const {target:input,password,tlsCa,allowLoopbackFixture}=options
  need(plain(input)&&allowedKeys(input,['host','port','database','user','systemIdentifier','databaseOid']),'target')
  const {host,port,database,user,systemIdentifier,databaseOid}=input
  need(typeof host==='string'&&host.length<=253&&!host.includes('%')
    &&(isIP(host)!==0||host.split('.').every(s=>DNS_LABEL.test(s)))
    &&Number.isSafeInteger(port)&&port>=1&&port<=65535&&matches(database,NAME)&&matches(user,NAME)
    &&boundedId(systemIdentifier,BigInt('18446744073709551615'))&&boundedId(databaseOid,BigInt(4294967295)),'target')
  need(typeof password==='string'&&password.length>0&&!password.includes('\0')&&Buffer.byteLength(password,'utf8')<=4096,'credentials')
  need(allowLoopbackFixture===undefined||typeof allowLoopbackFixture==='boolean','tls_configuration')
  const fixture=allowLoopbackFixture===true
  need(!fixture||((host==='127.0.0.1'||host==='::1')&&tlsCa===undefined),'tls_configuration')
  need(tlsCa===undefined||(typeof tlsCa==='string'&&tlsCa.startsWith('-----BEGIN CERTIFICATE-----')
    &&Buffer.byteLength(tlsCa,'utf8')<=262144&&!tlsCa.includes('\0')),'tls_configuration')
  // node-postgres also reads startup-only replication/binary/option knobs via
  // PG* variables. Don't let a shell select such a fallback for this command.
  need(!Object.keys(process.env).some(key=>/^PG[A-Z0-9_]+$/iu.test(key)),'ambient_configuration')
  const pool=new Pool({host,port,database,user,password,client_encoding:'UTF8',application_name:'clawpilot-native-recovery-private',
    ssl:fixture?false:{rejectUnauthorized:true,...(tlsCa?{ca:tlsCa}:{}),checkServerIdentity:(_name,cert)=>checkServerIdentity(host,cert)},
    max:1,idleTimeoutMillis:0,connectionTimeoutMillis:3000,statement_timeout:8000,lock_timeout:2500,
    idle_in_transaction_session_timeout:10000,query_timeout:10000,keepAlive:true,keepAliveInitialDelayMillis:5000})
  let active=false,poisoned=false,closing:Promise<void>|undefined,pin:SessionPin|null=null
  pool.on('error',()=>{poisoned=true}) // an idle backend failure cannot silently switch the pinned session
  const observe=async(client:PoolClient)=>{
    let rows
    try{({rows}=await client.query(OBSERVE))}catch{poisoned=true;throw hold('identity_unproven')}
    const r=rows[0]
    if(rows.length!==1||!r||r.database_name!==database||r.database_oid!==databaseOid||r.system_identifier!==systemIdentifier
      ||r.session_role!==user||r.effective_role!==user||r.primary_server!==true||r.using_tls!==!fixture||r.transaction_profile!==true
      ||r.restricted_login!==true||r.no_role_membership!==true||r.no_ownership_or_create!==true
      ||!Number.isSafeInteger(r.pid)||r.pid<1||r.pid>2147483647||!matches(r.backend_started_at,TIMESTAMP)
      ||(pin&&(r.pid!==pin.pid||r.backend_started_at!==pin.backendStartedAt))){
      poisoned=true;throw hold('identity_unproven')
    }
    pin??=Object.freeze({role:user,pid:r.pid,backendStartedAt:r.backend_started_at})
  }
  const transaction=async<T>(action:(client:PoolClient)=>Promise<T>):Promise<T>=>{
    need(typeof action==='function'&&!closing&&!poisoned&&!active,'connection_unavailable')
    active=true
    let client:PoolClient|undefined,phase:'connect'|'begin'|'transaction'|'commit'='connect',broken=false
    try{
      client=await pool.connect();phase='begin'
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');phase='transaction'
      await client.query("SET LOCAL search_path=pg_catalog,public; SET LOCAL TIME ZONE 'UTC'; SET LOCAL row_security=on")
      await observe(client)
      const result=await action(client)
      await observe(client)
      phase='commit'
      need((await client.query('COMMIT')).command==='COMMIT','commit_outcome_unknown')
      return result
    }catch(error){
      if(phase==='commit'){
        poisoned=true;broken=true
        // Do not issue another SQL command or retry after COMMIT's outcome is unknown.
        throw hold('commit_outcome_unknown')
      }
      if(phase==='transaction'&&client){
        try{if((await client.query('ROLLBACK')).command!=='ROLLBACK'){poisoned=true;broken=true}}
        catch{poisoned=true;broken=true}
      }else{poisoned=true;broken=true}
      if(error instanceof NativeEmailPublicationHeld)throw error
      throw hold('transaction_failed')
    }finally{active=false;client?.release(broken||poisoned)}
  }
  const close=()=>closing??=(async()=>{try{await pool.end()}catch{throw hold('close_failed')}})()
  return Object.freeze({transaction,close,sessionPin:()=>active||poisoned||closing?null:pin})
}
