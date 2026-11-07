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
// Private recovery enrolls four exact FK identities. Portability replaces
// only the verified internal generated name token, not a descriptor field.
for(const [name,source,target] of [
  ['review_batch_fkey','review','verified_batch'],
  ['retained_batch_outbox_id_fkey','retained','review'],
  ['consumed_batch_fkey','consumed','verified_batch'],
  ['account_repairs_operation_id_fkey','account_repairs','account_repair_approvals'],
]){
  const schema='crm_legacy_email_retirement'
  const privateFk={...fk,schema,name,source:`${schema}.${source}`,target:`${schema}.${target}`,
    index:`${schema}.${target}_pkey`,
    definition:`FOREIGN KEY (batch) REFERENCES ${schema}.${target}(batch) ON DELETE RESTRICT`,
    columns:fk.columns.map(c=>({...c,name:'batch',type:'uuid'})),
    operators:fk.operators.map(o=>({...o,operator:'=(uuid,uuid)'}))}
  const privateTrigger={...trigger,relation:`${schema}.${target}`,physicalRelation:privateFk.target,
    constraint:name,constraintRelation:privateFk.source,constraintIndex:privateFk.index,foreignKey:privateFk,
    definition:`CREATE CONSTRAINT TRIGGER "${trigger.name}" AFTER DELETE ON ${privateFk.target} FROM ${privateFk.source} NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "RI_FKey_restrict_del"()`}
  assert.equal(digest(changed(privateTrigger)),digest(changed(rename(privateTrigger,'RI_ConstraintTrigger_a_999991'))),
    `Exact private ${name} action trigger is portable across cluster OIDs`)
  const sourceTrigger={...privateTrigger,relation:privateFk.source,physicalRelation:privateFk.source,
    constraintRelation:privateFk.target,name:'RI_ConstraintTrigger_c_1234',typeMask:5,
    function:'pg_catalog."RI_FKey_check_ins"()',
    definition:`CREATE CONSTRAINT TRIGGER "RI_ConstraintTrigger_c_1234" AFTER INSERT ON ${privateFk.source} FROM ${privateFk.target} NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "RI_FKey_check_ins"()`}
  assert.equal(digest(changed(sourceTrigger)),digest(changed(rename(sourceTrigger,'RI_ConstraintTrigger_c_999991'))),
    `Exact private ${name} source trigger is portable across cluster OIDs`)
  for(const patch of [
    {foreignKey:{...privateFk,schema:'foreign_private'}},
    {foreignKey:{...privateFk,name:'unreviewed_private_fkey'},constraint:'unreviewed_private_fkey'},
    {foreignKey:{...privateFk,source:`${schema}.other`}},
    {foreignKey:{...privateFk,target:`${schema}.other`}},
    {physicalRelation:'wrong'},
    {function:'public.fake()'},
    {internal:false},
    {constraintIndex:'wrong'},
  ]){
    const unsupported={...privateTrigger,...patch}
    assert.notEqual(digest(changed(unsupported)),digest(changed(rename(unsupported,'RI_ConstraintTrigger_a_999991'))),
      `Malformed or foreign private ${name} must retain exact names`)
  }
  for(const [field,value] of Object.entries({validated:false,deleteAction:'c',deferrable:true,
    definition:privateFk.definition+' /* changed */',columns:[...privateFk.columns,{unexpected:true}]})){
    assert.notEqual(digest(changed(privateTrigger)),
      digest(changed({...privateTrigger,foreignKey:{...privateFk,[field]:value}})),
      `Private ${name} complete FK descriptor ${field} remains fingerprinted`)
  }
}
console.log('Production rebind catalog canonicalization: generated-name portability and semantic tamper checks passed')
