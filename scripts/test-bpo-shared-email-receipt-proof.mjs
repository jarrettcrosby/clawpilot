import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { sharedEmailCanonicalJson } from './lib/bpo-shared-email-projection.mjs'
import { createSharedBpoEmailReceiptVerifier } from './lib/bpo-shared-email-receipt-proof.mjs'

test('native readback verifier accepts a signed exact projection and holds caller-supplied or write-authority evidence',()=>{
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072})
  const keyId='isolated-native-readback'
  const verify=createSharedBpoEmailReceiptVerifier({publicKeyPem:publicKey.export({type:'spki',format:'pem'}),keyId})
  const result={version:1,state:'exact',kind:'created',globalId:'gi123456789abc',observedAt:'2026-11-09T20:15:01.234Z'}
  for (const [i,field] of ['workspaceId','pipelineId','interactionId','jobId','nativeId'].entries()) {
    result[field]=`abcdef00-0000-4000-8000-00000000000${i+1}`
  }
  for (const [i,field] of ['inventoryFingerprint','preimageFingerprint','projectionFingerprint','appOriginFingerprint',
    'appDeploymentFingerprint','nativeOriginFingerprint','nativeDeploymentFingerprint','snapshotFingerprint','receiptFingerprint'].entries()) {
    result[field]=String(i).repeat(64)
  }
  const proof={purpose:'clawpilot-shared-bpo-email-readback-v1',keyId,result}
  const signed=proof=>({proof,signature:sign('RSA-SHA256',Buffer.from(sharedEmailCanonicalJson(proof)),privateKey).toString('base64')})
  const envelope=signed(proof)
  assert.deepEqual(verify(envelope),result)
  assert.ok(Object.isFrozen(verify(envelope)))
  assert.throws(()=>verify({...envelope,proof:{...proof,result:{...result,globalId:'gi123456789abd'}}}),/signature/u)
  assert.throws(()=>verify(signed({...proof,purpose:'clawpilot-shared-bpo-email-create-v1'})),/envelope/u)
  assert.throws(()=>verify(signed({...proof,keyId:'other'})),/envelope/u)
  assert.throws(()=>verify(signed({...proof,result:{...result,description:'must not leave native'}})),/envelope/u)
  assert.throws(()=>verify(signed({...proof,result:{...result,observedAt:'2026-02-30T20:15:01.234Z'}})),/result/u)
})
