// Actual private PHP comparator against the prior canonical digest behavior.
// Pure bounded matrices only; not native ACL, database or transaction proof.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
const surfaces=['view','list','export','edit','delete'],cases=[]
const clone=value=>JSON.parse(JSON.stringify(value))
const canonical=value=>JSON.stringify(Array.isArray(value)?value.map(sort):sort(value))
function sort(value){return Array.isArray(value)?value.map(sort):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex')
const add=(actual,expected)=>cases.push({actual,expected})
for(const count of [0,1,12,500]){
 const readers=Array.from({length:count},(_,i)=>String(i).padStart(36,'0'))
 const matrix=Object.fromEntries(surfaces.map(surface=>[surface,readers.slice(0,surface==='edit'||surface==='delete'?Math.min(2,count):count)]))
 add(clone(matrix),clone(matrix));add(Object.fromEntries(Object.entries(matrix).reverse()),clone(matrix))
 for(const surface of surfaces){
  for(const replacement of [[],['unexpected'],[...matrix[surface]].reverse(),[...matrix[surface],'extra']]){
   const changed=clone(matrix);changed[surface]=replacement;add(changed,clone(matrix))
  }
 }
 const missing=clone(matrix);delete missing.view;add(missing,clone(matrix))
 add({...clone(matrix),extra:[]},clone(matrix))
}
const actual=JSON.parse(execFileSync('docker',['run','--rm','-i','--pull=never','--network','none','--read-only','--workdir','/',
 '--memory=128m','--cpus=0.5','--pids-limit=32','--mount',`type=bind,source=${resolve('services/suitecrm/email-audience')},target=/source,readonly`,
 '--mount',`type=bind,source=${resolve('services/suitecrm/native-email-scope')},target=/native-email-scope,readonly`,
 '--mount',`type=bind,source=${resolve('scripts/fixtures/native-email-capability-matrix-comparison.php')},target=/fixture.php,readonly`,
 '--mount',`type=bind,source=${resolve('scripts/fixtures/native-email-acl-refresh-action.php')},target=/modules/ACLActions/ACLAction.php,readonly`,
 '--entrypoint','php','php:8.3.35-cli-alpine','/fixture.php'],{input:JSON.stringify(cases),encoding:'utf8',timeout:30000}))
assert.deepEqual(actual.matrices,cases.map(c=>digest(c.actual)===digest(c.expected)))
assert.deepEqual(actual.refreshCalls,[['first',true],['first',true],['first',true],['second',true],['second',true]],
 'Every explicit scan refreshes native actions; its first ACL call does not duplicate that load and ordinary users remain independent')
console.log(`PASS ${cases.length} actual PHP direct matrix comparisons and forced scan refresh sequencing; no ACL action is replaced`)
