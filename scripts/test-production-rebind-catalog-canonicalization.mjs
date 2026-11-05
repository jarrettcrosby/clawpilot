#!/usr/bin/env node
import assert from 'node:assert/strict'
import { productionRebindHistorySchemaDigest as digest } from './production-rebind-history-schema-attestation.mjs'

const fk = {
  schema:'public', name:'orders_user_fkey', type:'f', source:'orders', target:'app_users',
  definition:'FOREIGN KEY (owner_email) REFERENCES app_users(email) ON DELETE RESTRICT',
  validated:true, enforced:true, deferrable:false, initiallyDeferred:false,
  updateAction:'a', deleteAction:'r', matchType:'s', deleteColumnNumbers:null,
  hasParent:false, local:true, inheritanceCount:0, noInherit:true, index:'app_users_pkey',
  columns:[{side:'source',name:'owner_email',position:1,type:'text'},
    {side:'target',name:'email',position:1,type:'text'}],
  operators:['foreignForeign','parentForeign','parentParent'].map(kind=>({kind,position:1,operator:'=(text,text)'})),
}
const trigger = {
  relation:'public.app_users', physicalRelation:'app_users', name:'RI_ConstraintTrigger_a_1234',
  enabled:'O', internal:true, typeMask:9, argumentCount:0, argumentsHex:'', when:null,
  function:'pg_catalog."RI_FKey_restrict_del"()', constraint:fk.name,
  constraintRelation:'public.orders', deferrable:false, initiallyDeferred:false,
  parentTrigger:null, attributeNumbers:'', oldTransitionTable:null, newTransitionTable:null,
  constraintIndex:fk.index, foreignKey:fk, comment:null,
  definition:'CREATE CONSTRAINT TRIGGER "RI_ConstraintTrigger_a_1234" AFTER DELETE ON app_users FROM orders NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "RI_FKey_restrict_del"()',
}
const catalog = {triggers:[trigger],functions:[{source:"BEGIN RETURN 'RI_ConstraintTrigger_a_1234  x'; END"}]}
const rename = (t, name) => ({...t,name,definition:t.definition.replace(`"${t.name}"`,`"${name}"`)})
const changed = (t) => ({...catalog,triggers:[t]})
assert.equal(digest(catalog),digest(changed(rename(trigger,'RI_ConstraintTrigger_a_98765'))),
  'Only verified generated name tokens are OID-independent')
for(const [field,value] of Object.entries({
  physicalRelation:'wrong',enabled:'D',internal:false,typeMask:17,argumentCount:1,argumentsHex:'01',
  when:'true',function:'public.fake()',constraint:'other',constraintRelation:'public.other',
  deferrable:true,initiallyDeferred:true,parentTrigger:'other',attributeNumbers:'1',
  oldTransitionTable:'old',newTransitionTable:'new',constraintIndex:'other',foreignKey:null,comment:'new',
  definition:trigger.definition+' /* extra */',
})) assert.notEqual(digest(catalog),digest(changed({...trigger,[field]:value})),field)
for(const field of Object.keys(fk)){
  const value=fk[field]
  const altered=typeof value==='boolean'?!value:typeof value==='number'?value+1:
    Array.isArray(value)?[...value,{unexpected:true}]:`${value}-altered`
  assert.notEqual(digest(catalog),digest(changed({...trigger,foreignKey:{...fk,[field]:altered}})),`FK ${field}`)
}
for(const name of ['RI_ConstraintTrigger_a_0','RI_ConstraintTrigger_a_1234_extra','customer_trigger']) {
  const nonGenerated=rename(trigger,name)
  assert.notEqual(digest(changed(nonGenerated)),digest(changed(rename(nonGenerated,name+'1'))),name)
}
for(const patch of [{internal:false},{foreignKey:null},{function:'public.fake()'},{parentTrigger:'clone'}]) {
  const unsupported={...trigger,...patch}
  assert.notEqual(digest(changed(unsupported)),digest(changed(rename(unsupported,'RI_ConstraintTrigger_a_5678'))),
    'Unsupported or user-created generated-looking triggers retain exact names')
}
const external={...trigger,internal:false,name:'custom_after_delete'}
assert.equal(digest({...catalog,triggers:[trigger,external]}),digest({...catalog,triggers:[external,trigger]}))
assert.notEqual(digest(catalog),digest({...catalog,triggers:[trigger,trigger]}),'Duplicate guards are not discarded')
assert.notEqual(digest(catalog),digest({...catalog,functions:[{source:catalog.functions[0].source.replace('  x',' x')}]}),
  'Function text remains byte-for-byte, including literals and repeated generated-looking names')
console.log('Production rebind catalog canonicalization: generated-name portability and semantic tamper checks passed')
