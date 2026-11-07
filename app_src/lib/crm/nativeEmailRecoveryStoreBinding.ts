import 'server-only'
import { types } from 'node:util'
import { nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'

type PostgresStore = Readonly<{database:string;databaseOid:string;systemIdentifier:string}>
type MariaStore = Readonly<{database:string;hostname:string;serverId:string;serverVersion:string;serverUid:string}>
type StoreBinding = Readonly<{targetFingerprint:string;postgresStoreFingerprint:string;mariaStoreFingerprint:string}>

const PG_DATABASE=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u
const MARIA_DATABASE=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(?![\s\S])/u
const HOSTNAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}(?![\s\S])/u
const MARIA_VERSION=/^[1-9][0-9]?\.[0-9]{1,3}\.[0-9]{1,3}-MariaDB(?:[-+._~A-Za-z0-9]{0,80})(?![\s\S])/u
const MARIA_UID=/^[A-Za-z0-9+/]{27}=(?![\s\S])/u
const POSITIVE=/^[1-9][0-9]{0,19}(?![\s\S])/u
const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const matches=(value:unknown,pattern:RegExp):value is string=>typeof value==='string'&&pattern.test(value)
const bounded=(value:unknown,max:bigint)=>matches(value,POSITIVE)&&BigInt(value)<=max
const UINT32=BigInt('4294967295'),UINT64=BigInt('18446744073709551615')

function need(ok:unknown,code:string):asserts ok {
  requireNativeEmail(ok,'native_email_recovery_store_binding_'+code)
}
function exact(value:unknown,keys:readonly string[]) {
  need(value&&typeof value==='object'&&!types.isProxy(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
    &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{
      const field=Object.getOwnPropertyDescriptor(value,key)
      return field?.enumerable&&'value' in field
    }),'shape')
}

/** Bind the observed primary cluster and database, not merely a login or DSN. */
export function nativeEmailPostgresStoreFingerprint(input:PostgresStore) {
  exact(input,['database','databaseOid','systemIdentifier'])
  const {database,databaseOid,systemIdentifier}=input
  need(matches(database,PG_DATABASE)&&bounded(databaseOid,UINT32)&&bounded(systemIdentifier,UINT64),'postgres_identity')
  return nativeEmailDigest({version:1,purpose:'clawpilot-native-email-custody-postgres-store-v1',database,databaseOid,systemIdentifier})
}

/** MariaDB's global server UID is a canonical base64 SHA-1 value. An absent
 * UID or the server's literal "unknown" fallback is not a store identity. */
export function nativeEmailMariaStoreFingerprint(input:MariaStore) {
  exact(input,['database','hostname','serverId','serverVersion','serverUid'])
  const {database,hostname,serverId,serverVersion,serverUid}=input
  need(matches(database,MARIA_DATABASE)&&matches(hostname,HOSTNAME)&&bounded(serverId,UINT32)
    &&matches(serverVersion,MARIA_VERSION)&&matches(serverUid,MARIA_UID)
    &&Buffer.from(serverUid,'base64').toString('base64')===serverUid,'maria_identity')
  return nativeEmailDigest({version:1,purpose:'clawpilot-native-email-custody-maria-store-v1',
    database,hostname,serverId,serverVersion,serverUid})
}

/** A signed target and both independently observed stores belong together. */
export function nativeEmailRecoveryStoreBindingFingerprint(input:StoreBinding) {
  exact(input,['targetFingerprint','postgresStoreFingerprint','mariaStoreFingerprint'])
  const {targetFingerprint,postgresStoreFingerprint,mariaStoreFingerprint}=input
  need([targetFingerprint,postgresStoreFingerprint,mariaStoreFingerprint].every(value=>matches(value,HASH)),'fingerprint')
  return nativeEmailDigest({version:1,purpose:'clawpilot-native-email-custody-stores-v1',
    targetFingerprint,postgresStoreFingerprint,mariaStoreFingerprint})
}
