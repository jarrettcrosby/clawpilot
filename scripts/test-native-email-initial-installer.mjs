#!/usr/bin/env node
// Fresh independently pinned MariaDB schema profile / real DDL recovery gate.
// One guarded DB, internal network, no ports, pulls, live config or providers.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {createDisposablePostgresRuntime,DISPOSABLE_POSTGRES_LABEL,DISPOSABLE_POSTGRES_OWNER_LABEL} from './lib/disposable-postgres-docker.mjs'
import {runStorageGuard} from './local-storage-guard.mjs'

assert.equal(process.versions.node.split('.')[0],'24','Use the supported bundled Node 24 runtime')
const options={generate:false}
for(const arg of process.argv.slice(2)){
 if(arg==='--generate-profile'){assert.equal(options.generate,false);options.generate=true}
 else if(arg.startsWith('--source-zip=')){assert.equal(options.zip,undefined);options.zip=arg.slice(13)}
 else if(arg.startsWith('--output=')){assert.equal(options.output,undefined);options.output=arg.slice(9)}
 else throw Error('Use [--generate-profile] [--source-zip=/absolute/SuiteCRM-8.10.1.zip] --output=/absolute/new-local-validation.json')
}
assert.ok(isAbsolute(options.output??''),'Private new local validation output is required')
const evidenceRoot=resolve('output/local-validation'),outputPath=resolve(options.output)
assert.ok(relative(evidenceRoot,outputPath)&&!relative(evidenceRoot,outputPath).startsWith('..')&&outputPath.endsWith('.json'))
assert.equal(existsSync(outputPath),false,'Never overwrite an evidence artifact')
assert.ok(lstatSync(dirname(outputPath)).isDirectory()&&!lstatSync(dirname(outputPath)).isSymbolicLink())
const environment={...process.env,CI:'',VERCEL:'',VERCEL_ENV:''}
for(const key of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID'])delete environment[key]
assert.equal(runStorageGuard({argv:['--preflight'],environment}),0)
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const source=resolve('services/suitecrm'),fixture=resolve('scripts/fixtures/native-email-initial-installer.php')
const files=['scripts/test-native-email-initial-installer.mjs','scripts/fixtures/native-email-initial-installer.php',
 'services/suitecrm/install-native-email-initial-state.php','services/suitecrm/install-native-email-runtime.php','services/suitecrm/install-native-email-scope.php',
 'services/suitecrm/native-email-scope/Scope.php','services/suitecrm/native-email-scope/Patch.php',
 ...readdirSync(join(source,'email-audience')).filter(name=>/\.(php|sql)$/.test(name)).map(name=>'services/suitecrm/email-audience/'+name)]
// The DDL generator carries forward a separately reviewed native verification
// session, so the source profile is consumed and hash-checked in BOTH modes.
files.push('services/suitecrm/native-email-initial-install-profile.json')
const sourceHashes=Object.fromEntries(files.map(path=>[path,sha(readFileSync(path))]))
const totalDeadline=Date.now()+300000;let cleanupMode=false
const run=(args,extra={})=>{const remaining=cleanupMode?30000:totalDeadline-Date.now();assert.ok(remaining>0,'Initial installer gate exceeded its five-minute total deadline')
 return execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:1048576,...extra,timeout:Math.min(extra.timeout??30000,remaining)})}
const owner=randomUUID(),prefix='cp-initial-state-'+owner.slice(0,10),label='com.clawpilot.initial-state-installer'
const names={db:prefix+'-db',php:prefix+'-php',net:prefix+'-net'}
const root=mkdtempSync(join(tmpdir(),'clawpilot-initial-installer.'));writeFileSync(join(root,'owner.json'),JSON.stringify({owner,pid:process.pid}),{flag:'wx',mode:0o600})
const lease=createDisposablePostgresRuntime({environment});let dbAdmitted=false,phpAttempted=false,networkAttempted=false,cleaning=false
const inspect=(kind,name)=>{try{return JSON.parse(run([kind,'inspect',name]))[0]}catch(error){if(/No such (?:object|container|network)|network .+ not found/i.test(String(error.stderr)))return null;throw error}}
function cleanup(){if(cleaning)return;cleaning=true;cleanupMode=true
 try{if(phpAttempted){const c=inspect('container',names.php);if(c){assert.equal(c.Config.Labels?.[label],owner);assert.ok(c.Mounts.every(m=>m.Type!=='volume'));run(['rm','--force','--volumes',c.Id]);assert.equal(inspect('container',c.Id),null)}}
  if(dbAdmitted)assert.equal(lease.cleanup(),true)
  if(networkAttempted){const n=inspect('network',names.net);if(n){assert.equal(n.Labels?.[label],owner);assert.equal(Object.keys(n.Containers??{}).length,0);run(['network','rm',n.Id]);assert.equal(inspect('network',n.Id),null)}}
  assert.equal(JSON.parse(readFileSync(join(root,'owner.json'))).owner,owner);assert.match(root,/\/clawpilot-initial-installer\.[A-Za-z0-9]+$/);rmSync(root,{recursive:true})
 }finally{cleaning=false;cleanupMode=false}}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{try{cleanup()}finally{process.exit(signal==='SIGINT'?130:143)}})
try{
 const php=JSON.parse(run(['image','inspect','clawpilot-suitecrm-native-acceptance:8.10.1-php83-8.3.36']))[0]
 const maria=JSON.parse(run(['image','inspect','mariadb:11.4.13']))[0]
 assert.ok(php.Config.Env.includes('PHP_VERSION=8.3.36'));assert.deepEqual(Object.keys(php.Config.Volumes??{}),[]);assert.deepEqual(Object.keys(maria.Config.Volumes??{}),['/var/lib/mysql'])
 const official=join(root,'official')
 if(!options.generate){assert.ok(isAbsolute(options.zip??''),'Exact already-downloaded SuiteCRM archive required')
  const archive=realpathSync(options.zip);assert.ok(lstatSync(archive).isFile()&&lstatSync(archive).uid===process.getuid())
  assert.equal(sha(readFileSync(archive)),'b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7')
  execFileSync('unzip',['-q',archive,'-d',official],{timeout:60000,stdio:'pipe'})
 }
 const token=lease.admit(names.db);dbAdmitted=true
 networkAttempted=true;run(['network','create','--internal','--label',label+'='+owner,names.net])
 const limits=(memory,cpus)=>['--memory',memory,'--memory-swap',memory,'--cpus',cpus,'--pids-limit','128','--log-driver','json-file','--log-opt','max-size=1m','--log-opt','max-file=1','--label',label+'='+owner]
 run(['run','--rm','--detach','--pull=never','--name',names.db,'--network',names.net,'--network-alias','db','--read-only',...limits('512m','0.5'),
  '--label',DISPOSABLE_POSTGRES_LABEL+'=true','--label',DISPOSABLE_POSTGRES_OWNER_LABEL+'='+token,
  '--tmpfs','/var/lib/mysql:rw,nosuid,size=256m','--tmpfs','/run/mysqld:rw,nosuid,size=8m','--tmpfs','/tmp:rw,nosuid,size=16m',
  '--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--cap-add','SETGID','--cap-add','SETUID','--security-opt','no-new-privileges',
  '--env','MARIADB_ROOT_PASSWORD=Synthetic-initial-installer-db-only','--env','MARIADB_DATABASE=initial_install_fixture',maria.Id,
  '--skip-log-bin','--innodb-buffer-pool-size=64M','--max-connections=12','--performance-schema=OFF'])
 const ready=Date.now()+60000
 // MariaDB's initialization-only socket server is not the final TCP server
 // used by PHP. Do not admit the fixture merely because that socket responds.
 for(;;){try{run(['exec','--env','MYSQL_PWD=Synthetic-initial-installer-db-only',names.db,'mariadb','--protocol=tcp','--host=127.0.0.1','--user=root','--database=initial_install_fixture','--execute=SELECT 1'],{timeout:3000});break}
  catch(error){assert.ok(Date.now()<ready,'Initial fixture database did not become ready');await new Promise(r=>setTimeout(r,200))}}
 // Independent fresh local schema, deliberately matching the SELECT-only r429
 // production defaults. Never infer expected DDL from existing live tables.
 assert.equal(run(['exec','--env','MYSQL_PWD=Synthetic-initial-installer-db-only',names.db,'mariadb','--protocol=tcp','--host=127.0.0.1','--user=root','--database=initial_install_fixture','--batch','--skip-column-names',
  '--execute=SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()']).trim(),'0')
 run(['exec','--env','MYSQL_PWD=Synthetic-initial-installer-db-only',names.db,'mariadb','--protocol=tcp','--host=127.0.0.1','--user=root','--database=initial_install_fixture',
  '--execute=ALTER DATABASE initial_install_fixture CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci'])
 phpAttempted=true
 run(['create','--rm','--pull=never','--name',names.php,'--network',names.net,'--read-only',...limits('256m','0.5'),
  '--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,size=160m',
  '--mount','type=bind,source='+source+',target=/source,readonly','--mount','type=bind,source='+fixture+',target=/fixture.php,readonly',
  ...(!options.generate?['--mount','type=bind,source='+official+',target=/official,readonly']:[]),
  '--env','CLAWPILOT_INITIAL_INSTALLER_FIXTURE=1','--entrypoint','php',php.Id,'-d','memory_limit=192M','/fixture.php',options.generate?'generate-profile':'acceptance'])
 const c=inspect('container',names.php);assert.ok(c.Mounts.every(m=>m.Type!=='volume'));assert.equal(Object.keys(c.HostConfig.PortBindings??{}).length,0)
 const output=run(['start','--attach',names.php],{timeout:180000})
 for(const [path,hash]of Object.entries(sourceHashes))assert.equal(sha(readFileSync(path)),hash,'Installer source changed during actual gate: '+path)
 if(options.generate){const profile=JSON.parse(output);assert.equal(profile.purpose,'clawpilot-native-email-initial-install-profile');writeFileSync(outputPath,output,{flag:'wx',mode:0o600})
  console.log(JSON.stringify({kind:'independent-fresh-native-schema-profile',candidate:outputPath,sha256:sha(output),tables:Object.keys(profile.tables).length,
   nativeVerificationEnvironmentGenerated:false,
   databaseImage:maria.Id,phpImage:php.Id,sourceHashes,production:false}))
 }else{assert.match(output,/NATIVE_INITIAL_INSTALLER_PASSED=10;/);process.stdout.write(output)
  const report={kind:'native-initial-installer-actual-ddl-proof',databaseImage:maria.Id,phpImage:php.Id,sourceHashes,output,
   nativeDdl:true,configCas:true,sourceCaptureSynthetic:true,nativeVerificationEnvironmentGenerated:false,nativeEnrollment:false,production:false}
  writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({...report,output:undefined}))}
}catch(error){const failed=outputPath.replace(/\.json$/,'.failed.json');if(!existsSync(failed))writeFileSync(failed,JSON.stringify({failed:true,error:String(error.stack??error),stdout:String(error.stdout??''),stderr:String(error.stderr??''),sourceHashes,production:false},null,2)+'\n',{flag:'wx',mode:0o600});throw error}
finally{cleanup()}
