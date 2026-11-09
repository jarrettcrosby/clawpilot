import { createPublicKey, verify } from 'node:crypto'
import { sharedEmailCanonicalJson } from './bpo-shared-email-projection.mjs'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const GLOBAL = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const HASH = /^[a-f0-9]{64}(?![\s\S])/u
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\s\S])/u
const keyLabel = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?![\s\S])/u
const match = (value,re) => typeof value==='string' && re.test(value)
const exact = (value,keys) => value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key))
const need = (ok, reason) => { if (!ok) throw new Error(`Shared SuiteCRM Email receipt held: ${reason}`) }
const ids = ['workspaceId','pipelineId','interactionId','jobId','nativeId']
const fingerprints = ['inventoryFingerprint','preimageFingerprint','projectionFingerprint','appOriginFingerprint',
  'appDeploymentFingerprint','nativeOriginFingerprint','nativeDeploymentFingerprint','snapshotFingerprint','receiptFingerprint']
const resultKeys = ['version','state','kind',...ids,'globalId',...fingerprints,'observedAt']

/** The key must be configured outside the request from the independently
 * trusted native readback operator. Never point this verifier at the create
 * approval issuer's key: authorization to write is not evidence of a write.
 * The App settlement additionally checks freshness against its DB clock and
 * compares every scope pin before changing the exact terminal records. */
export function createSharedBpoEmailReceiptVerifier({publicKeyPem,keyId}) {
  need(match(keyId,keyLabel) && typeof publicKeyPem==='string' && publicKeyPem.length<=1024
    && /^-----BEGIN PUBLIC KEY-----\r?\n/.test(publicKeyPem), 'key')
  let key
  try { key=createPublicKey(publicKeyPem) } catch { need(false,'key') }
  need(key.asymmetricKeyType==='rsa' && key.asymmetricKeyDetails?.modulusLength===3072,'key')
  return function verifyNativeReceipt(envelope) {
    need(exact(envelope,['proof','signature']) && exact(envelope.proof,['purpose','keyId','result']), 'envelope')
    const {purpose,keyId:observedKey,result}=envelope.proof
    need(purpose==='clawpilot-shared-bpo-email-readback-v1' && observedKey===keyId && exact(result,resultKeys), 'envelope')
    need(result.version===1 && result.state==='exact' && ['created','exact-existing'].includes(result.kind)
      && ids.every(field=>match(result[field],UUID)) && match(result.globalId,GLOBAL)
      && fingerprints.every(field=>match(result[field],HASH)) && match(result.observedAt,UTC)
      && Number.isFinite(Date.parse(result.observedAt)) && new Date(result.observedAt).toISOString()===result.observedAt, 'result')
    const signature=envelope.signature
    need(match(signature,/^[a-zA-Z0-9+/]{512}(?![\s\S])/u), 'signature')
    const bytes=Buffer.from(signature,'base64')
    const clean=Object.fromEntries(resultKeys.map(field=>[field,result[field]]))
    need(bytes.length===384 && bytes.toString('base64')===signature
      && verify('RSA-SHA256',Buffer.from(sharedEmailCanonicalJson({purpose,keyId,result:clean})),key,bytes),'signature')
    return Object.freeze(clean)
  }
}
