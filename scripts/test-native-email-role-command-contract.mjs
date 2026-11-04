// Compare actual TS and PHP command validators, not a native ACL acceptance.
// Only an installed PHP image is used; no network, data volume or credentials.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import * as crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const ts=createRequire(resolve(root,'app_src/package.json'))('typescript'),cache=new Map()
function load(path) {
  if(cache.has(path))return cache.get(path).exports
  const module={exports:{}};cache.set(path,module)
  const code=ts.transpileModule(readFileSync(path,'utf8'),{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('require','module','exports',code)(name=>name==='node:crypto'?crypto:load(resolve(dirname(path),name+'.ts')),module,module.exports)
  return module.exports
}
const protocol=load(resolve(root,'app_src/lib/crm/nativeEmailAuthorityTransition.ts'))
const fixture=JSON.parse(execFileSync(process.execPath,['scripts/test-native-email-authority-runtime.mjs','--emit-role-fixture'],{cwd:root,encoding:'utf8'}))
const clone=value=>JSON.parse(JSON.stringify(value)),cases=[]
for(const kind of ['promotion','demotion'])for(const phase of ['revoke','grant'])cases.push({label:kind+' '+phase,command:fixture[kind][phase],accepted:true})
const invalid=(label,change,base=fixture.promotion.grant)=>{const command=clone(base);change(command);cases.push({label,command,accepted:false})}
invalid('no implicit promotion',c=>{delete c.roleChanges})
invalid('no implicit demotion',c=>{delete c.roleChanges},fixture.demotion.revoke)
invalid('empty declaration',c=>{c.roleChanges=[]})
invalid('null declaration',c=>{c.roleChanges=null})
invalid('unknown role key',c=>{c.roleChanges[0].extra=true})
invalid('duplicate declaration',c=>{c.roleChanges.push(clone(c.roleChanges[0]))})
invalid('foreign pipeline',c=>{c.roleChanges[0].pipelineId='foreign'})
invalid('unknown principal',c=>{c.roleChanges[0].userId='unknown'})
invalid('owner role change',c=>{c.roleChanges[0].userId=c.bindings[0].before.owner_id})
invalid('unknown role',c=>{c.roleChanges[0].afterRole='owner'})
invalid('unchanged role',c=>{c.roleChanges[0].afterRole=c.roleChanges[0].beforeRole})
invalid('wrong direction',c=>{Object.assign(c.roleChanges[0],{beforeRole:'editor',afterRole:'viewer'})})
const expected=cases.map(({label,command,accepted})=>{
  let result
  try{result={accepted:true,hash:protocol.prepareNativeEmailAuthorityCommand(command).commandHash}}catch{result={accepted:false}}
  assert.equal(result.accepted,accepted,'TS: '+label);return result
})
const actual=JSON.parse(execFileSync('docker',['run','--rm','-i','--pull=never','--network','none','--read-only',
  '--memory=256m','--cpus=1','--pids-limit=64','--mount',`type=bind,source=${resolve(root,'services/suitecrm/email-audience')},target=/source,readonly`,
  '--mount',`type=bind,source=${resolve(root,'scripts/fixtures/native-email-role-command-contract.php')},target=/fixture.php,readonly`,
  '--entrypoint','php','php:8.3.35-cli-alpine','/fixture.php'],{cwd:root,input:JSON.stringify(cases.map(row=>row.command)),encoding:'utf8',timeout:30000}))
assert.deepEqual(actual,expected,'PHP acceptance and canonical command hashes must agree with TS')
console.log(`PASS ${cases.length} actual TS/PHP retained-role command cases and exact accepted hashes; no native ACL, DB or deployment proof`)
