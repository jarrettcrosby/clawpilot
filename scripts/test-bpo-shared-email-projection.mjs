import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareBpoSharedEmailProjection, sharedEmailCanonicalJson } from './lib/bpo-shared-email-projection.mjs'

function fixture() {
  const pin={ interactionId:'10000000-0000-4000-8000-000000000001',nativeId:'20000000-0000-4000-8000-000000000001',globalId:'gi123456789abc' }
  const pipelineId='587c8746-ecf6-40ae-8c50-e456f99ad555'
  const accounts=['customer','supplier'], contacts=['contact-one','contact-two']
  const contactAccounts=[{contactId:'contact-one',accountId:'customer'},{contactId:'contact-two',accountId:'supplier'}]
  const liveRelationships={accounts,contacts,contactAccounts,parentType:'Accounts',parentId:'customer'}
  const payload={entity:'interactions',localId:pin.interactionId,suiteCrmId:pin.nativeId,suiteCrmModule:'Emails',pipelineId,
    attributes:{global_id_c:pin.globalId,type:'archived',status:'read',name:'Synthetic email',description:'héllo\u2028https://example.invalid',
      description_html:'',date_sent_received:'2026-11-09 20:00:00',assigned_user_id:'fixture-owner',
      parent_type:'Accounts',parent_id:'customer',from_addr_name:'author@example.invalid'},
    emailProjection:{version:1,accounts:[...accounts].reverse(),contacts:[...contacts],contactAccounts:structuredClone(contactAccounts).reverse(),
      previousManaged:{accounts:[],contacts:[]},audience:{policy:'obsolete'}},
    relationships:[...accounts.map(relatedBeanId=>({linkFieldName:'accounts',relatedModuleName:'Accounts',relatedBeanId})),
      ...contacts.map(relatedBeanId=>({linkFieldName:'contacts',relatedModuleName:'Contacts',relatedBeanId}))],
  }
  return { pin,pipelineId,payload,liveRelationships }
}

test('one exact projection retains both companies, their own contacts and customer primary, without copying role data',()=>{
  const request=fixture(), original=structuredClone(request)
  const {projection,projectionFingerprint}=prepareBpoSharedEmailProjection(request)
  assert.deepEqual(request,original)
  assert.deepEqual(projection.accounts,['customer','supplier'])
  assert.deepEqual(projection.contactAccounts,request.liveRelationships.contactAccounts)
  assert.equal(projection.attributes.parent_id,'customer')
  assert.equal(projection.expectedBeforeFingerprint,null)
  assert.equal(Object.hasOwn(projection,'audience'),false)
  request.pin.projectionFingerprint=projectionFingerprint
  request.payload.emailProjection.audience={ policy:'pipeline-internal',allowedSuiteCrmUserIds:['unused'] }
  assert.deepEqual(prepareBpoSharedEmailProjection(request),{projection,projectionFingerprint})
  assert.match(sharedEmailCanonicalJson(projection),/héllo\\u2028https:\/\/example\.invalid/u)
  request.payload.attributes.description+=' changed'
  assert.throws(()=>prepareBpoSharedEmailProjection(request),/reviewed_projection_changed/u)
})

test('holds stale mappings, primary drift, malformed headers, aliases, old links and module transitions',()=>{
  for(const [change,pattern] of [
    [r=>{r.liveRelationships.contactAccounts[1].accountId='customer'},/relationships_changed/u],
    [r=>{r.liveRelationships.parentId='supplier'},/relationships_changed/u],
    [r=>{r.payload.relationships.pop()},/outbox_relationships/u],
    [r=>{r.payload.emailProjection.accounts.push('CUSTOMER')},/duplicate_relationship/u],
    [r=>{r.payload.emailProjection.previousManaged.accounts.push('old')},/create_requires_no_prior_projection/u],
    [r=>{r.payload.attributes.from_addr_name=''},/email_attributes/u],
    [r=>{r.payload.attributes.assigned_user_id=undefined},/email_attributes/u],
    [r=>{r.payload.previousSuiteCrmModule='Notes'},/outbox_scope/u],
    [r=>{r.payload.attributes.unexpected='unknown'},/email_attributes/u],
  ]) {
    const request=fixture()
    change(request)
    assert.throws(()=>prepareBpoSharedEmailProjection(request),pattern)
  }
})
