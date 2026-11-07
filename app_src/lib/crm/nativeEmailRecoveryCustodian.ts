import 'server-only'
import {constants,sign,type KeyObject} from 'node:crypto'
import type {Socket} from 'node:net'
import {TextDecoder,types} from 'node:util'
import {nativeEmailCanonicalJson,nativeEmailDigest,requireNativeEmail} from './nativeEmailPublication'
import {assertNativeEmailRecoveryCustodyChallenge,type NativeEmailRecoveryCustodyExpected} from './nativeEmailRecoveryCustodyProof'
import {observeNativeEmailRecoveryPostgresFence,type NativeEmailRecoveryPostgresFenceTarget} from './nativeEmailRecoveryPostgresFence'
import {observeNativeEmailRecoveryMariaFence,type NativeEmailRecoveryMariaFenceTarget} from './nativeEmailRecoveryMariaFence'
import {nativeEmailRecoveryStoreBindingFingerprint} from './nativeEmailRecoveryStoreBinding'

type StablePins=Omit<NativeEmailRecoveryCustodyExpected,'nonce'|'phase'>
type PostgresObserver=Parameters<typeof observeNativeEmailRecoveryPostgresFence>[0]
type MariaObserver=Parameters<typeof observeNativeEmailRecoveryMariaFence>[0]
type Retained=Readonly<{authorizedIdleSessions:NativeEmailRecoveryPostgresFenceTarget['authorizedIdleSessions']}>
type WithObserver<Observer>=<T>(signal:AbortSignal,run:(observer:Observer)=>Promise<T>)=>Promise<T>
type WithRetainedClosure=<T>(pins:StablePins,signal:AbortSignal,run:(retained:Retained)=>Promise<T>)=>Promise<T>

type CustodianOptions=Readonly<{
  pins:StablePins; keyId:string; key:KeyObject
  postgresTarget:Omit<NativeEmailRecoveryPostgresFenceTarget,'authorizedIdleSessions'>
  postgresWriterRole:string
  mariaTarget:NativeEmailRecoveryMariaFenceTarget
  withRetainedClosure:WithRetainedClosure
  withPostgresObserver:WithObserver<PostgresObserver>
  withMariaObserver:WithObserver<MariaObserver>
}>
const MAX_FRAME=8192, MAX_NONCES=256, DEADLINE_MS=5000, LF=10
const HASH=/^[a-f0-9]{64}(?![\s\S])/u
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const KEY_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/u
const ROLE=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u
const stableHashes=['targetFingerprint','storeBindingFingerprint','operationId','requestFingerprint','controllerConfigHash','producerInventoryHash'] as const
const stableFields=['fenceEpoch','expiresAt',...stableHashes] as const
const proofPurpose='clawpilot-native-email-recovery-custody-v2'
const nowSeconds=()=>Math.floor(Date.now()/1000)
const match=(value:unknown,pattern:RegExp):value is string=>typeof value==='string'&&pattern.test(value)
function need(value:unknown,code:string):asserts value {requireNativeEmail(value,'legacy_dispatch_custodian_'+code)}
function exact(value:unknown,fields:readonly string[]):asserts value is Record<string,unknown> {
  need(value&&typeof value==='object'&&!types.isProxy(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
    &&Reflect.ownKeys(value).length===fields.length&&fields.every(field=>{
      const descriptor=Object.getOwnPropertyDescriptor(value,field)
      return descriptor?.enumerable&&'value' in descriptor
    }),'shape')
}
function snapshot<T>(input:T):T {
  // Prevent mutable caller-owned config from changing the destinations after
  // validation. Exact database/role checks are made by the real observers.
  const value=structuredClone(input)
  const freeze=(part:unknown)=>{
    if(part&&typeof part==='object'&&!Object.isFrozen(part)){
      for(const child of Object.values(part))freeze(child)
      Object.freeze(part)
    }
  }
  freeze(value)
  return value
}

/** The separately protected provider must acquire/retain/release its actual
 * scope outside the signer. A wrapper cannot substitute a returned observation
 * for running our callback, call it twice, or return early and still sign. */
async function insideScope<Input,Result>(signal:AbortSignal,
  enter:(run:(value:Input)=>Promise<Result>)=>Promise<Result>,
  action:(value:Input,stillInside:()=>void)=>Promise<Result>,checkDeadline:()=>void):Promise<Result> {
  let calls=0, completed=false, open=true, observation:Result|undefined
  const stillInside=()=>{checkDeadline();need(open&&!signal.aborted&&calls===1,'scope_lost')}
  try {
    const returned=await enter(value=>{
      const pending=(async()=>{
        calls++
        stillInside()
        observation=await action(value,stillInside)
        stillInside()
        completed=true
        return observation
      })()
      // A broken provider that does not await its callback still cannot sign
      // or leak an asynchronous rejection outside the server's error scope.
      void pending.catch(()=>{})
      return pending
    })
    stillInside()
    need(completed&&returned===observation,'scope_unproven')
    return returned
  } finally {open=false}
}

/** Bind to a separately owned Unix server. This code never locks writers,
 * accepts a client idle-session pin, or makes snapshots prove continuity.
 * withRetainedClosure must be the independent capability holding both real
 * writer closures over the whole window. Its observer providers must open one
 * direct read-only connection, honor signal/timeouts, and close it before
 * resolving. Return from a successful callback is not authority to reopen. */
export function createNativeEmailRecoveryCustodian(options:CustodianOptions):(socket:Socket)=>void {
  const {pins,keyId,key,postgresWriterRole,withRetainedClosure,withPostgresObserver,withMariaObserver}=options
  exact(pins,stableFields)
  need(stableHashes.every(field=>match(pins[field],HASH))&&match(pins.fenceEpoch,UUID)
    &&Number.isSafeInteger(pins.expiresAt)&&nowSeconds()<pins.expiresAt&&pins.expiresAt-nowSeconds()<=900,'window')
  need(match(keyId,KEY_ID)&&!types.isProxy(key)&&types.isKeyObject(key),'signer')
  const signer=structuredClone(key)
  need(signer.type==='private'&&signer.asymmetricKeyType==='rsa'&&signer.asymmetricKeyDetails?.modulusLength===3072,'signer')
  need([withRetainedClosure,withPostgresObserver,withMariaObserver].every(value=>typeof value==='function'),'scope_unproven')
  const stable=snapshot(pins), postgres=snapshot(options.postgresTarget), maria=snapshot(options.mariaTarget)
  need(match(postgresWriterRole,ROLE)&&postgresWriterRole!==postgres.verifierRole
    &&Array.isArray(postgres.ordinaryWriterRoles)&&!postgres.ordinaryWriterRoles.includes(postgresWriterRole),'writer_pin')
  const nonces=new Set<string>()
  let serving=false

  const prove=async(wire:string,signal:AbortSignal,checkDeadline:()=>void):Promise<string>=>{
    checkDeadline()
    const challenge:unknown=JSON.parse(wire)
    assertNativeEmailRecoveryCustodyChallenge(challenge)
    need(nativeEmailCanonicalJson(challenge)+'\n'===wire&&stableFields.every(field=>challenge[field]===stable[field])
      &&nowSeconds()<stable.expiresAt&&!signal.aborted,'challenge')
    const {nonce,phase}=challenge
    need(nonces.size<MAX_NONCES&&!nonces.has(nonce),'nonce')
    nonces.add(nonce)
    return insideScope<Retained,string>(signal,run=>withRetainedClosure(stable,signal,run),async(retained,stillInside)=>{
      exact(retained,['authorizedIdleSessions'])
      const idle=snapshot(retained.authorizedIdleSessions)
      need(Array.isArray(idle)&&idle.length<=1&&idle.every(pin=>{
        exact(pin,['pid','role','backendStartedAt'])
        return pin.role===postgresWriterRole
      }),'writer_pin')
      stillInside()
      const pg=await insideScope<PostgresObserver,Awaited<ReturnType<typeof observeNativeEmailRecoveryPostgresFence>>>(signal,
        run=>withPostgresObserver(signal,run),async(client,stillObserving)=>observeNativeEmailRecoveryPostgresFence({
          query:(sql,values)=>{stillInside();stillObserving();return client.query(sql,values)}
        },{...postgres,authorizedIdleSessions:idle}),checkDeadline)
      stillInside()
      const my=await insideScope<MariaObserver,Awaited<ReturnType<typeof observeNativeEmailRecoveryMariaFence>>>(signal,
        run=>withMariaObserver(signal,run),async(client,stillObserving)=>observeNativeEmailRecoveryMariaFence({
          query:(sql,values)=>{stillInside();stillObserving();return client.query(sql,values)}
        },maria),checkDeadline)
      stillInside()
      // The requested pin is an expectation, not observation evidence. Bind
      // the exact native target to both actual stores before signing.
      const storeBindingFingerprint=nativeEmailRecoveryStoreBindingFingerprint({targetFingerprint:stable.targetFingerprint,
        postgresStoreFingerprint:pg.storeFingerprint,mariaStoreFingerprint:my.storeFingerprint})
      need(storeBindingFingerprint===stable.storeBindingFingerprint,'store_binding')
      const now=Date.now(), issuedAt=Math.floor(now/1000)
      need([pg.observedAt,my.observationStartedAt,my.observedAt].every(stamp=>{
        const time=Date.parse(stamp)
        return Number.isFinite(time)&&time>=now-DEADLINE_MS&&time<=now+2000
      }),'observation_time')
      need(issuedAt<stable.expiresAt&&stable.expiresAt-issuedAt<=900,'window')
      // Both actual observer providers have closed. Signing is still scoped
      // to the independent retained writer closure; no credentials or rows.
      const proof=Object.freeze({version:2,purpose:proofPurpose,keyId,nonce,phase,...stable,storeBindingFingerprint,issuedAt,retainedClosure:true,
        postgresObservationHash:nativeEmailDigest(pg),mariaObservationHash:nativeEmailDigest(my)})
      const signature=sign('sha256',Buffer.from(nativeEmailCanonicalJson(proof),'ascii'),
        {key:signer,padding:constants.RSA_PKCS1_PADDING}).toString('base64')
      const response=nativeEmailCanonicalJson({proof,signature})+'\n'
      need(Buffer.byteLength(response)<=MAX_FRAME,'response')
      return response
    },checkDeadline)
  }

  return socket=>{
    if(serving||nowSeconds()>=stable.expiresAt){socket.destroy();return}
    serving=true
    const abort=new AbortController(),chunks:Buffer[]=[]
    const startedAt=process.hrtime.bigint(), limit=BigInt(DEADLINE_MS)*BigInt(1_000_000)
    const checkDeadline=()=>need(process.hrtime.bigint()-startedAt<limit,'deadline')
    let bytes=0, frame=false,closed=false,running=false,responding=false
    const release=()=>{if(closed&&!running)serving=false}
    const fail=()=>{
      if(closed)return
      closed=true
      clearTimeout(timer)
      abort.abort()
      socket.destroy()
      release()
    }
    const timer=setTimeout(fail,DEADLINE_MS)
    socket.on('data',(chunk:Buffer)=>{
      if(closed)return
      const end=chunk.indexOf(LF)
      if(frame||bytes+chunk.length>MAX_FRAME||(end!==-1&&end!==chunk.length-1)){fail();return}
      frame=end!==-1
      bytes+=chunk.length;chunks.push(chunk)
      if(!frame)return
      // The client writes one LF-terminated line and does not half-close.
      // Give already queued excess data a chance to invalidate that frame.
      setImmediate(()=>{
        if(closed)return
        running=true
        void (async()=>{
          try {
            const wire=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks,bytes))
            const response=await prove(wire,abort.signal,checkDeadline)
            checkDeadline()
            if(closed||abort.signal.aborted||nowSeconds()>=stable.expiresAt){fail();return}
            responding=true
            socket.end(response)
            socket.destroySoon()
          } catch {fail()}
          finally {running=false;release()}
        })()
      })
    })
    socket.on('error',fail)
    socket.once('end',()=>{if(!responding)fail()})
    socket.once('close',fail)
  }
}
