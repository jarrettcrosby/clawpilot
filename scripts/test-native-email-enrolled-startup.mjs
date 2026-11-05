#!/usr/bin/env node
// Source/real shell branch and pure-PHP value checks only. The shell stubs the
// startup verifier, so none of this certifies enrolled native readiness.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,readFileSync,writeFileSync,chmodSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,isAbsolute} from 'node:path'
const root=resolve('.'),read=path=>readFileSync(join(root,path),'utf8')
const wrapper=read('services/suitecrm/native-email-enrolled-startup.php'),entry=read('services/suitecrm/entrypoint.sh'),
 check=read('services/suitecrm/native-email-startup-check.php')
const paths=['services/suitecrm/native-email-enrolled-startup.php','services/suitecrm/native-email-startup-check.php',
 'services/suitecrm/entrypoint.sh','services/suitecrm/apache-ports.conf','services/suitecrm/apache-site.conf',
 'scripts/fixtures/native-email-enrolled-startup.php','scripts/test-native-email-enrolled-startup.mjs']
const digest=path=>createHash('sha256').update(readFileSync(join(root,path))).digest('hex'),hashes=Object.fromEntries(paths.map(path=>[path,digest(path)]))
const offset=(text,needle)=>{const at=text.indexOf(needle);assert.ok(at>=0,needle);return at}
assert.ok(offset(wrapper,'cp_initial_cli_installation_files($artifact)')<offset(wrapper,'$db=cp_initial_cli_cold_bootstrap($artifact)'))
assert.ok(offset(wrapper,'cp_native_startup_files($artifact,$proof)')<offset(wrapper,'$db=cp_initial_cli_cold_bootstrap($artifact)'))
assert.match(wrapper,/ClawPilotNativeEmailStartupOrigin::verifyArtifact\(\$proof,\$artifact,\$binding\)/)
assert.match(wrapper,/\$lineage\['rootStockRuntimeFingerprint'\]/)
assert.ok(offset(wrapper,'cp_initial_cli_pins($artifact)')<offset(wrapper,'$db=cp_initial_cli_cold_bootstrap($artifact)'))
assert.ok(offset(wrapper,'ClawPilotNativeEmailStartupOriginAuthority::fromProtectedFile(')<offset(wrapper,'$snapshot=$service->inspectStartupOrigin($origin)'))
assert.ok(offset(wrapper,'$snapshot=$service->inspectStartupOrigin($origin)')<offset(wrapper,"return 'enrolled'"))
assert.match(wrapper,/cp_initial_installer_lock\(\$context\)/)
assert.match(wrapper,/finally\{flock\(\$lock,LOCK_UN\);fclose\(\$lock\);\}/)
assert.doesNotMatch(wrapper,/\b(?:file_put_contents|cp_scope_write|rename|putenv|openssl_sign|shell_exec|proc_open|exec)\s*\(/)
assert.doesNotMatch(wrapper,/\b(?:INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/)
assert.doesNotMatch(wrapper,/\$service->(?:execute|resolve|cancel|prepare|project)\(/)
assert.match(wrapper,/CP_NATIVE_STARTUP_CERTIFICATE='activation-origin\.json'/)
assert.match(wrapper,/SUITECRM.*|cp_initial_cli_identity\(\$artifact\)/)
assert.match(check,/if\(file_exists\(\$initialState\)\)\{[\s\S]*?return cp_native_email_enrolled_startup\(\);/)
assert.match(check,/\$appRoot===CP_INITIAL_CLI_APP/)
assert.ok(offset(check,'return cp_native_email_enrolled_startup();')<offset(check,"$runtime=file_exists($runtimeState)"))
assert.equal(read('services/suitecrm/apache-ports.conf'),'Listen 8080\n')
assert.match(wrapper,new RegExp("CP_NATIVE_STARTUP_APACHE_SITE_SHA256='"+digest('services/suitecrm/apache-site.conf')+"'"))
const start=offset(entry,'  enrolled)'),end=offset(entry,'  legacy|runtime)'),branch=entry.slice(start,end)
const commands=branch.split('\n').filter(line=>!/^\s*#/.test(line)).join('\n')
assert.match(branch,/exec \/usr\/local\/bin\/apache2-foreground/)
assert.doesNotMatch(commands,/\b(?:sed|touch|chown|su|supervisord|bootstrap-client|bootstrap-global|messenger|cache:)\b/)
assert.ok(end<offset(entry,'require_value()'))
const syntax=spawnSync('/bin/bash',['-n',join(root,'services/suitecrm/entrypoint.sh')],{stdio:'pipe'})
assert.ifError(syntax.error);assert.equal(syntax.status,0,'bash syntax')
console.log('PASS static startup order: protected files before include, typed origin plus full current inspection before enrolled return; no write/replay API')
let shellChecks=0
const temp=mkdtempSync(join(tmpdir(),'clawpilot-enrolled-shell-')),sentinel=join(temp,'called')
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'"
try{
 const stub=(name,body)=>{const path=join(temp,name);writeFileSync(path,'#!/bin/bash\nset -euo pipefail\n'+body+'\n',{mode:0o700});chmodSync(path,0o700)}
 stub('php',`printf '%s\\n' php-check >> ${quote(sentinel)}\nprintf '%s\\n' "\${STARTUP_STUB_MODE:-enrolled}"\nexit "\${STARTUP_STUB_STATUS:-0}"`)
 for(const name of ['su','cp','chown','chmod','touch','openssl','sed','a2enmod','a2dismod','supervisord'])stub(name,
  `printf '%s\\n' ${quote('unexpected-'+name)} >> ${quote(sentinel)}\nexit 74`)
 const env={PATH:temp+':'+process.env.PATH,SUITECRM_VERSION:'8.10.1',CLAWPILOT_NATIVE_INITIAL_MAINTENANCE:'0'}
 for(const [more,status]of [[{STARTUP_STUB_STATUS:'73'},73],[{STARTUP_STUB_MODE:'unknown'},1],[{PORT:'9090'},1]]){
  const result=spawnSync('/bin/bash',[join(root,'services/suitecrm/entrypoint.sh')],{env:{...env,...more},encoding:'utf8',timeout:5000})
  assert.ifError(result.error);assert.equal(result.status,status,result.stderr);shellChecks++
 }
 assert.equal(readFileSync(sentinel,'utf8'),'php-check\nphp-check\nphp-check\n','failed or unknown verification and wrong port cannot reach any normal setup writer')
 // The exact command can be proven statically here. Do not accidentally start
 // a real host Apache if a developer has one at the image-fixed absolute path.
 assert.ok(!branch.includes('supervisord'))
 console.log('PASS '+shellChecks+' actual shell early-refusal branches; verifier is explicitly stubbed, no Apache readiness claim')
}finally{rmSync(temp,{recursive:true,force:true})}
const args=process.argv.slice(2);assert.ok(args.length<=1&&(!args.length||args[0].startsWith('--php=')))
const php=args.length?args[0].slice(6):'php';if(args.length)assert.ok(isAbsolute(php))
const result=spawnSync(php,['scripts/fixtures/native-email-enrolled-startup.php'],{encoding:'utf8',timeout:15000,maxBuffer:100000})
if(result.error?.code==='ENOENT'&&!args.length)console.log('SKIP actual PHP values: local PHP unavailable; execute fixture in parent-owned PHP runtime')
else{assert.ifError(result.error);assert.equal(result.status,0,(result.stderr||'')+(result.stdout||''));assert.match(result.stdout,/NATIVE_ENROLLED_STARTUP_VALUES_PASSED=[1-9][0-9]*/);process.stdout.write(result.stdout)}
for(const [path,sha]of Object.entries(hashes))assert.equal(digest(path),sha,'Source changed during focused gate: '+path)
console.log(JSON.stringify({kind:'native-enrolled-startup-component',staticChecks:true,realShellRefusals:shellChecks,
 fullNativeInspection:false,nativeColdRestart:false,fullDockerImage:false,production:false,sourceHashes:hashes}))
