import { createHash } from 'node:crypto'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const ID = /^[a-z0-9][a-z0-9-]{0,35}(?![\s\S])/iu
const GLOBAL = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const HASH = /^[a-f0-9]{64}(?![\s\S])/u
const required = ['global_id_c','name','date_sent_received','type','status','parent_type','parent_id',
  'assigned_user_id','description','description_html']
const headers = ['from_addr_name','to_addrs_names','cc_addrs_names','bcc_addrs_names','reply_to_addrs_names']
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0
const match = (value, pattern) => typeof value === 'string' && pattern.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key))
const equal = (a,b) => sharedEmailCanonicalJson(a) === sharedEmailCanonicalJson(b)
const need = (ok, reason) => { if (!ok) throw new Error(`Shared SuiteCRM Email projection held: ${reason}`) }

/** Wire-compatible with PHP's sorted keys, unescaped slashes and Unicode. */
export function sharedEmailCanonicalJson(value) {
  function sort(input) {
    if (Array.isArray(input)) return input.map(sort)
    if (object(input)) return Object.fromEntries(Object.keys(input).sort(compare).map(key=>[key,sort(input[key])]))
    return input
  }
  return JSON.stringify(sort(value)).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')
}

function ids(value) {
  need(Array.isArray(value) && value.length<=25 && value.every(id=>match(id,ID)), 'relationship_identity')
  need(new Set(value.map(id=>id.toLowerCase())).size===value.length, 'duplicate_relationship')
  return [...value].sort(compare)
}

function links(value, expectedKeys) {
  need(exact(value,expectedKeys), 'relationship_shape')
  const accounts=ids(value.accounts), contacts=ids(value.contacts)
  need(Array.isArray(value.contactAccounts) && value.contactAccounts.length===contacts.length, 'contact_accounts')
  const contactAccounts=value.contactAccounts.map(entry=>{
    need(exact(entry,['contactId','accountId']) && match(entry.contactId,ID) && accounts.includes(entry.accountId), 'contact_accounts')
    return {contactId:entry.contactId,accountId:entry.accountId}
  }).sort((a,b)=>compare(a.contactId,b.contactId))
  need(equal(contactAccounts.map(entry=>entry.contactId),contacts), 'contact_accounts')
  return {accounts,contacts,contactAccounts}
}

/** Derive a create-only projection from an exact App job + independently
 * observed live relationship rows. This validates placement, not readers.
 * The deprecated per-pipeline native role payload has no authority here.
 * This function performs no I/O and grants no permission to write. */
export function prepareBpoSharedEmailProjection({ payload, pin, pipelineId, liveRelationships }) {
  need(match(pipelineId,UUID) && object(pin) && match(pin.interactionId,UUID) && match(pin.nativeId,UUID)
    && match(pin.globalId,GLOBAL), 'exact_identity')
  need(object(payload) && payload.entity==='interactions' && payload.localId===pin.interactionId && payload.pipelineId===pipelineId
    && payload.suiteCrmId===pin.nativeId && payload.suiteCrmModule==='Emails' && payload.previousSuiteCrmModule===undefined,
    'outbox_scope')
  const a=payload.attributes
  need(object(a) && required.every(key=>Object.hasOwn(a,key)) && a.global_id_c===pin.globalId
    && a.type==='archived' && ['read','sent'].includes(a.status) && a.description_html==='' && match(a.assigned_user_id,ID), 'email_attributes')
  for (const [key,value] of Object.entries(a)) {
    const cap=key==='description'?100000:key==='name'?255:8000
    need((required.includes(key)||headers.includes(key)) && typeof value==='string' && Buffer.byteLength(value,'utf8')<=cap
      && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value) && Buffer.from(value,'utf8').toString('utf8')===value, 'email_attributes')
  }
  need(a.name.trim()===a.name && !/[\r\n]/u.test(a.name) && a.from_addr_name
    && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?(?![\s\S])/u.test(a.date_sent_received), 'email_attributes')
  const old=payload.emailProjection
  need(exact(old,['version','accounts','contacts','contactAccounts','previousManaged','audience']) && old.version===1
    && exact(old.previousManaged,['accounts','contacts']) && ids(old.previousManaged.accounts).length===0
    && ids(old.previousManaged.contacts).length===0, 'create_requires_no_prior_projection')
  const oldLinks=links(old,['version','accounts','contacts','contactAccounts','previousManaged','audience'])
  const current=links(liveRelationships,['accounts','contacts','contactAccounts','parentType','parentId'])
  need(equal(oldLinks,current) && a.parent_type===liveRelationships.parentType && a.parent_id===liveRelationships.parentId
    && ((a.parent_type==='' && a.parent_id==='') || (a.parent_type==='Accounts' && current.accounts.includes(a.parent_id))), 'relationships_changed')
  const relationships=payload.relationships??[]
  need(Array.isArray(relationships) && relationships.length<=50, 'outbox_relationships')
  for (const relation of relationships) need(exact(relation,['linkFieldName','relatedModuleName','relatedBeanId'])
    && ['accounts','contacts'].includes(relation.linkFieldName) && match(relation.relatedBeanId,ID)
    && relation.relatedModuleName===(relation.linkFieldName==='accounts'?'Accounts':'Contacts'), 'outbox_relationships')
  for (const link of ['accounts','contacts']) need(equal(current[link],ids(relationships.filter(r=>r.linkFieldName===link)
    .map(r=>r.relatedBeanId))), 'outbox_relationships')
  const projection={suiteCrmId:pin.nativeId,attributes:{...a},...current,previousManaged:{accounts:[],contacts:[]},expectedBeforeFingerprint:null}
  const projectionFingerprint=createHash('sha256').update(sharedEmailCanonicalJson(projection)).digest('hex')
  if (pin.projectionFingerprint!==undefined) need(match(pin.projectionFingerprint,HASH)
    && pin.projectionFingerprint===projectionFingerprint,'reviewed_projection_changed')
  return { projection, projectionFingerprint }
}
