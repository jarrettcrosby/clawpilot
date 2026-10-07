import test from 'node:test'
import assert from 'node:assert/strict'
import {canonicalHash,gatewayGlobalId,gatewayVersion,mapGatewayFields,normalizedEmail,parseGatewayFields} from '../app_src/lib/crm/fractionalGatewayModel.ts'

test('gateway IDs preserve native prefixes and canonical fields without HTML loss',()=>{
 assert.ok(gatewayGlobalId('ga1234567','company'));assert.ok(gatewayGlobalId('gc0123456789av','contact'));assert.equal(gatewayGlobalId('gfc0123456789av','contact'),false)
 assert.equal(normalizedEmail('  O.Neil+sample@EXAMPLE.COM '),'o.neil+sample@example.com')
 assert.deepEqual(parseGatewayFields('contact',{displayName:"O'Neil &amp; <x>",email:'o.neil+sample@example.com',phone:null,jobTitle:null}),{displayName:"O'Neil &amp; <x>",email:'o.neil+sample@example.com',phone:null,jobTitle:null})
 assert.throws(()=>parseGatewayFields('contact',{organizationId:'foreign'},true))
 assert.throws(()=>parseGatewayFields('contact',{displayName:' padded '},true))
})
test('unrepresentable source address/country remains unknown rather than clearing a known field',()=>{
 const actual=mapGatewayFields('company',{name:'Company',billing_address_street:'One\nTwo\nThree',billing_address_country:'United States'})
 assert.deepEqual(actual.unavailableFields,['addressLine1','addressLine2','countryCode']);assert.equal(actual.fields.addressLine1,null);assert.equal(actual.sourceFields.address,'One\nTwo\nThree')
 const exact=mapGatewayFields('company',{name:'Company',billing_address_street:'One\nTwo',billing_address_country:'US'});assert.deepEqual(exact.unavailableFields,[]);assert.equal(exact.fields.addressLine2,'Two')
 assert.equal(mapGatewayFields('contact',{full_name:'Person',phone_work:'123',phone_mobile:'999'}).fields.phone,'123')
})
test('versions include parent and private source state while hashes ignore object property order',()=>{
 assert.equal(canonicalHash({b:2,a:1}),canonicalHash({a:1,b:2}))
 const scope={workspaceOrganizationId:'workspace',pipelineId:'pipeline',rootCompanyGlobalId:'ga1234567'},row={id:'record',reference_code:'gc1234568',full_name:'Person',updated_at:'2026-09-24',source_hash:'x',source_payload:{}}
 const parent={id:'parent',reference_code:'ga1234569'},version=gatewayVersion(scope,'instance','contact',row,parent)
 assert.notEqual(version,gatewayVersion(scope,'instance','contact',row,{...parent,id:'other'}))
 assert.notEqual(version,gatewayVersion(scope,'instance','contact',{...row,source_payload:{archived:true}},parent))
 assert.notEqual(version,gatewayVersion(scope,'other-instance','contact',row,parent))
})
