#!/usr/bin/env node
// Actual native initial cutover fixture. The host approval store/evidence edge
// is explicitly synthetic: this is NOT app/PG admission or production proof.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import * as crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statfsSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import {createDisposablePostgresRuntime,DISPOSABLE_POSTGRES_LABEL,DISPOSABLE_POSTGRES_OWNER_LABEL} from './lib/disposable-postgres-docker.mjs'
import {runStorageGuard} from './local-storage-guard.mjs'
import {nativeRuntimeFixtureProfile} from './lib/native-runtime-fixture-profile.mjs'
import {auditNativeInitialColdCache,STOCK_AUDIT_CACHE_PATH,STOCK_AUDIT_CACHE_PARENT} from './lib/native-initial-cold-cache.mjs'

assert.equal(process.versions.node.split('.')[0],'24','Use the supported bundled Node24 runtime')
const options={count:329}
for(const arg of process.argv.slice(2)){
  if(/^--source-zip=\//.test(arg)){assert.ok(!options.zip);options.zip=arg.slice(13)}
  else if(/^--output=\//.test(arg)){assert.ok(!options.output);options.output=arg.slice(9)}
  else if(/^--scale-email-count=(329|334)$/.test(arg)){assert.equal(options.selectedCount,undefined);options.selectedCount=true;options.count=Number(arg.split('=')[1])}
  else if(arg==='--cold-cli'){assert.ok(!options.coldCli);options.coldCli=true}
  else if(arg==='--native-session-capture-only'){assert.ok(!options.nativeSessionCaptureOnly);options.nativeSessionCaptureOnly=true;options.coldCli=true}
  else throw Error('Use --source-zip=/absolute/SuiteCRM-8.10.1.zip [--scale-email-count=329|334] [--cold-cli|--native-session-capture-only] [--output=/absolute/new.json]')
}
assert.ok(isAbsolute(options.zip??''),'Explicit pinned local archive required; this test never downloads')
const archive=realpathSync(options.zip),archiveStat=lstatSync(archive),ZIP_SHA='b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7'
assert.ok(archiveStat.isFile()&&archiveStat.uid===process.getuid()&&archiveStat.size<180000000)
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
assert.equal(sha(readFileSync(archive)),ZIP_SHA)
if(options.output){assert.ok(options.output.endsWith('.json'));const p=lstatSync(dirname(options.output));assert.ok(p.isDirectory()&&!p.isSymbolicLink()&&p.uid===process.getuid())}
const environment={...process.env,CI:'',VERCEL:'',VERCEL_ENV:''}
for(const key of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID'])delete environment[key]
assert.equal(runStorageGuard({argv:['--preflight'],environment}),0)
const totalDeadline=Date.now()+600000;let cleanupMode=false
const run=(command,args,extra={})=>{const remaining=cleanupMode?30000:totalDeadline-Date.now();if(remaining<=0)throw Object.assign(Error('Initial native total 600-second handoff deadline exceeded'),{code:'INITIAL_TOTAL_DEADLINE'})
  return execFileSync(command,args,{encoding:'utf8',stdio:[Object.hasOwn(extra,'input')?'pipe':'ignore','pipe','pipe'],maxBuffer:6000000,...extra,timeout:Math.min(extra.timeout??30000,remaining)})}
const image=tag=>JSON.parse(run('docker',['image','inspect',tag]))[0]
const profile=nativeRuntimeFixtureProfile('8.3.36'),php=image(profile.image),maria=image('mariadb:11.4.13')
assert.ok(php.Config.Env.includes('PHP_VERSION=8.3.36'));assert.deepEqual(Object.keys(php.Config.Volumes??{}),[])
assert.deepEqual(Object.keys(maria.Config.Volumes??{}),['/var/lib/mysql'])
const fixture=resolve('scripts/fixtures/native-email-audience-real'),source=resolve('services/suitecrm')
const candidates=[resolve('scripts/test-native-email-initial-enrollment-native.mjs'),resolve('scripts/lib/native-initial-cold-cache.mjs'),
  ...readdirSync(fixture).filter(p=>p.endsWith('.php')).sort().map(p=>join(fixture,p)),
  ...readdirSync(join(source,'email-audience')).filter(p=>/\.(php|sql)$/.test(p)).sort().map(p=>join(source,'email-audience',p)),
  ...['install-native-email-runtime.php','install-native-email-scope.php','native-email-scope/Patch.php','native-email-scope/Scope.php',
    ...(options.coldCli?['native-email-initial-cli.php','install-native-email-initial-state.php','native-email-initial-install-profile.json']:[])].map(p=>join(source,p)),
  ...['nativeEmailPublication.ts','nativeEmailInitialEnrollment.ts','nativeEmailInitialEnrollmentApproval.ts','nativeEmailCapabilityContract.ts'].map(p=>resolve('app_src/lib/crm',p))]
const hashes=Object.fromEntries(candidates.map(p=>[p,sha(readFileSync(p))]))
const root=mkdtempSync(join(tmpdir(),'clawpilot-initial-native.')),owner=crypto.randomUUID(),LABEL='com.clawpilot.native-initial-enrollment'
writeFileSync(join(root,'owner.json'),JSON.stringify({owner,pid:process.pid}),{flag:'wx',mode:0o600})
const lease=createDisposablePostgresRuntime({environment}),results=[],partialColdChecks=[],storagePhases=[];let current=null,cleaning=false
const observeStorage=phase=>{const stat=statfsSync(process.cwd(),{bigint:true}),observation={phase,availableBytes:Number(stat.bavail*stat.bsize),capturedAt:new Date().toISOString()}
  if(process.platform==='darwin')observation.hostSwapUsage=run('sysctl',['vm.swapusage']).trim().slice(0,512)
  storagePhases.push(observation);console.log('NATIVE_INITIAL_STORAGE_PHASE='+JSON.stringify(observation));return observation}
const inspect=name=>{try{return JSON.parse(run('docker',['inspect',name]))[0]}catch(e){if(/No such (?:object|container)/i.test(String(e.stderr)))return null;throw e}}
const inspectNetwork=name=>{try{return JSON.parse(run('docker',['network','inspect',name]))[0]}catch(e){if(/(?:No such network|network .+ not found)/i.test(String(e.stderr)))return null;throw e}}
const remove=name=>{const c=inspect(name);if(!c)return;assert.equal(c.Config.Labels?.[LABEL],owner);assert.ok(c.Mounts.every(m=>m.Type!=='volume'));run('docker',['rm','--force','--volumes',c.Id]);assert.equal(inspect(c.Id),null)}
function cleanScenario(){if(!current)return;const c=current;if(c.app)remove(c.app);assert.equal(lease.cleanup(),true);if(c.net){const n=inspectNetwork(c.net);if(n){assert.equal(n.Labels?.[LABEL],owner);assert.equal(Object.keys(n.Containers??{}).length,0);run('docker',['network','rm',n.Id]);assert.equal(inspectNetwork(c.net),null)}}current=null}
function cleanup(){if(cleaning)return;cleaning=true;cleanupMode=true;try{cleanScenario();const mark=JSON.parse(readFileSync(join(root,'owner.json')));assert.equal(mark.owner,owner);assert.match(root,/\/clawpilot-initial-native\.[A-Za-z0-9]+$/);rmSync(root,{recursive:true})}finally{cleaning=false;cleanupMode=false}}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{try{cleanup()}finally{process.exit(signal==='SIGINT'?130:143)}})
const limits=(memory,cpus)=>['--memory',memory,'--memory-swap',memory,'--cpus',cpus,'--pids-limit','128','--log-driver','json-file','--log-opt','max-size=2m','--log-opt','max-file=1','--label',LABEL+'='+owner]
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript'),modules=new Map()
function load(path){if(modules.has(path))return modules.get(path);const m={exports:{}};const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('require','module','exports',code)(name=>name==='server-only'?{}:name==='node:crypto'?crypto:load(resolve(dirname(path),name+'.ts')),m,m.exports);modules.set(path,m.exports);return m.exports}
const protocol=load(resolve('app_src/lib/crm/nativeEmailPublication.ts')),approval=load(resolve('app_src/lib/crm/nativeEmailInitialEnrollmentApproval.ts'))
const clone=value=>JSON.parse(JSON.stringify(value)),digest=protocol.nativeEmailDigest
// Protected installer journals contain literal filesystem paths as keys. This
// fixture serializer matches cp_initial_canonical, NOT the native wire grammar.
const installationJson=value=>Array.isArray(value)?'['+value.map(installationJson).join(',')+']':value&&typeof value==='object'
  ?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+installationJson(value[key])).join(',')+'}':JSON.stringify(value)
assert.equal(installationJson({paths:{'public/legacy/config_override.php':'x'},list:[]}),'{"list":[],"paths":{"public/legacy/config_override.php":"x"}}')
assert.throws(()=>digest({paths:{'public/legacy/config_override.php':'x'},list:[]}),error=>error?.code==='invalid_json_key','Native wire key grammar must stay unchanged')
let report
try{
  observeStorage('before-official-extraction')
  run('unzip',['-q',archive,'-d',join(root,'suitecrm')],{timeout:60000})
  const extractedStorage=observeStorage('after-official-extraction')
  extractedStorage.extractedAllocatedKiB=Number.parseInt(run('du',['-sk',join(root,'suitecrm')]).trim().split(/\s+/,1)[0],10)
  assert.ok(Number.isSafeInteger(extractedStorage.extractedAllocatedKiB)&&extractedStorage.extractedAllocatedKiB>0)
  console.log('NATIVE_INITIAL_EXTRACTED_STORAGE='+JSON.stringify({temporaryRoot:root,...extractedStorage}))
  for(const scenario of (options.coldCli?['commit']:['commit','expired-cancel','conflicting-all-rollback'])){
    const suffix=owner.slice(0,8)+'-'+scenario,db='cp-initial-'+suffix+'-db',app='cp-initial-'+suffix+'-app',net='cp-initial-'+suffix+'-net'
    // Retain exact intended names BEFORE any write-capable Docker call. An
    // exception/timeout is an unknown outcome; cleanup inspects ownership.
    current={db,app,net};const token=lease.admit(db)
    run('docker',['network','create','--internal','--label',LABEL+'='+owner,net])
    run('docker',['run','--rm','--detach','--pull=never','--name',db,'--network',net,'--network-alias','db','--read-only',...limits('640m','0.5'),
      '--label',DISPOSABLE_POSTGRES_LABEL+'=true','--label',DISPOSABLE_POSTGRES_OWNER_LABEL+'='+token,
      '--tmpfs','/var/lib/mysql:rw,nosuid,size=320m','--tmpfs','/run/mysqld:rw,nosuid,size=8m','--tmpfs','/tmp:rw,nosuid,size=32m',
      '--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--cap-add','SETGID','--cap-add','SETUID','--security-opt','no-new-privileges',
      '--env','MARIADB_ROOT_PASSWORD=Synthetic-native-root-password-only','--env','MARIADB_DATABASE=suitecrm_native_test',
      '--env','MARIADB_USER=fixture','--env','MARIADB_PASSWORD=Synthetic-native-db-password-only',maria.Id,'--skip-log-bin','--innodb-buffer-pool-size=64M','--max-connections=20','--performance-schema=OFF',
      ...(options.coldCli?['--character-set-server=utf8mb3','--collation-server=utf8mb3_general_ci']:[])])
    // MariaDB's initialization-only temporary server accepts socket queries,
    // then intentionally stops. TCP readiness selects the final service only.
    const sql=text=>run('docker',['exec','--env','MYSQL_PWD=Synthetic-native-db-password-only',db,'mariadb','--protocol=TCP','--host=127.0.0.1',
      '--user=fixture','--database=suitecrm_native_test','--batch','--skip-column-names','--execute='+text])
    let ready=Date.now()+60000;for(;;){try{sql('SELECT 1');break}catch(e){if(e.code==='INITIAL_TOTAL_DEADLINE'||Date.now()>ready)throw e;await new Promise(r=>setTimeout(r,250))}}
    const databaseVersion=sql('SELECT VERSION()').trim();assert.match(databaseVersion,/^11\.4\.13-MariaDB/)
    const bootstrap="set -eu; mkdir -p /var/lib/suitecrm/app; cp -a /official/. /var/lib/suitecrm/app/; cd /var/lib/suitecrm/app; php -d memory_limit=384M bin/console suitecrm:app:install --no-interaction -u fixture-admin -p Synthetic-native-admin-password-only -U fixture -P Synthetic-native-db-password-only -H db -Z 3306 -N suitecrm_native_test -S https://suitecrm-native.invalid -d no -W true >/tmp/native-initial-install.log 2>&1 || { tail -n 50 /tmp/native-initial-install.log; exit 1; }; touch /tmp/native-initial-ready; while [ ! -f /tmp/native-initial-done ]; do sleep 1; done"
    run('docker',['run','--rm','--detach','--pull=never','--name',app,'--network',net,'--read-only',...limits('1152m','1'),
      '--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/var/lib/suitecrm:rw,nosuid,size=640m','--tmpfs','/tmp:rw,nosuid,size=32m',
      '--mount','type=bind,source='+join(root,'suitecrm')+',target=/official,readonly','--mount','type=bind,source='+fixture+',target=/fixture,readonly',
      '--mount','type=bind,source='+source+',target=/source,readonly','--env','CLAWPILOT_NATIVE_INITIAL_FIXTURE=1',
      '--env','CLAWPILOT_NATIVE_INITIAL_FIXTURE_EMAILS='+options.count,...(scenario==='conflicting-all-rollback'?['--env','CLAWPILOT_NATIVE_INITIAL_FIXTURE_CONFLICTING_ALL=1']:[]),
      '--entrypoint','/bin/sh',php.Id,'-c',bootstrap])
    ready=Date.now()+180000;for(;;){try{run('docker',['exec',app,'test','-f','/tmp/native-initial-ready'],{timeout:3000});break}catch(e){if(e.code==='INITIAL_TOTAL_DEADLINE')throw e;const alive=inspect(app);if(!alive?.State.Running)throw Error('Initial bootstrap failed: '+(alive?run('docker',['logs',app]):'container removed'));if(Date.now()>ready)throw Error('Initial native install exceeded 180 seconds');await new Promise(r=>setTimeout(r,500))}}
    for(const name of [app,db]){const c=inspect(name);assert.ok(c.Mounts.every(m=>m.Type!=='volume'));assert.equal(Object.keys(c.HostConfig.PortBindings??{}).length,0)}
    const stage=(name,env=[])=>run('docker',['exec',...env.flatMap(x=>['--env',x]),app,'php','-d','memory_limit=384M','/fixture/native-initial-enrollment.php',name,'--initial-volume-app'],{timeout:45000})
    const read=path=>JSON.parse(run('docker',['exec',app,'php','-r','fwrite(STDOUT,file_get_contents($argv[1]));',path]))
    const write=(path,value)=>run('docker',['exec','--interactive',app,'php','-r',"$p=$argv[1];if(file_exists($p)||is_link($p))throw new Exception('exclusive fixture input');$b=stream_get_contents(STDIN);$h=fopen($p,'x');if(!$h||!chmod($p,0600)||fwrite($h,$b)!==strlen($b))throw new Exception('fixture input failed');fclose($h);",path],{input:JSON.stringify(value)})
    let output=stage('source');const observed=read('/tmp/clawpilot-initial-source.json')
    assert.equal(observed.source.emails.length,options.count);assert.equal(observed.source.principalSuiteCrmUserIds.length,4);assert.deepEqual(observed.scopeCounts,[27,options.count===334?131:126,176])
    const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),pub=keys.publicKey.export({type:'spki',format:'pem'})
    const nativeEnv=['CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=1','SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID=initial-native-fixture-key',
      'SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID=native-initial-fixture','SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='+pub,
      'SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID='+observed.serviceUserId,'SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='+observed.oauthClientId]
    const jsonStage=name=>{const raw=stage(name);const line=raw.split('\n').findLast(x=>x.startsWith('{'));assert.ok(line,'No fixture metadata '+name);return JSON.parse(line)}
    const coldChecks=[]
    const coldCall=(action,artifact,{mutates=false,captureSession=false,installationProof=false}={})=>{
      const before=jsonStage('raw-state'),args=[action,'--operation='+artifact.operationId,'--artifact-sha256='+artifact.artifactHash,'--quiescent']
      if(artifact.planHash)args.push('--plan-sha256='+artifact.planHash)
      if(installationProof)args.push('--with-installation-proof')
      if(action==='execute'||action==='cancel-expired')args.push('--approve-operation='+artifact.operationId)
      let raw,commandFailure
      try{raw=run('docker',['exec',...nativeEnv.flatMap(x=>['--env',x]),app,'php','-d','memory_limit=384M',
        ...(captureSession?['/fixture/native-initial-enrollment.php','native-session-environment','--initial-volume-app',artifact.operationId,artifact.artifactHash]:['/source/native-email-initial-cli.php',...args])],{timeout:45000})}
      catch(error){commandFailure=error}
      // A failed transport is not proof of rollback. Retain the independently
      // collected state even on failure, before rethrowing/owner cleanup.
      const after=jsonStage('raw-state')
      const changes=(a,b)=>[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]))
      const cacheChanged=changes(before.cache,after.cache),criticalChanged=changes(before.critical,after.critical)
      const changed=Object.keys(before.database).filter(t=>before.database[t]!==after.database[t]);assert.deepEqual(Object.keys(after.database),Object.keys(before.database),'Cold CLI created schema')
      const allowed=['acl_actions','securitygroups','securitygroups_users','securitygroups_records','clawpilot_email_bindings','clawpilot_email_identities',
        'clawpilot_email_write_scopes','clawpilot_email_write_permissions','clawpilot_email_initial_enrollments']
      const audit={action:captureSession?'fixture-native-session-environment':action,installationProof,commandSucceeded:commandFailure===undefined,
        commandFailure:commandFailure?{exitStatus:commandFailure.status??null,signal:commandFailure.signal??null,stderr:String(commandFailure.stderr??'').slice(0,1024)}:null,
        tableCount:Object.keys(before.database).length,cacheEntryCount:Object.keys(before.cache).length,
        // Audit maps contain filesystem paths. They are not protocol objects
        // and must not weaken/use the protocol's restricted JSON key grammar.
        beforeStateHash:sha(JSON.stringify(before)),afterStateHash:sha(JSON.stringify(after)),changedTables:changed,cacheUnchanged:cacheChanged.length===0,criticalFilesUnchanged:criticalChanged.length===0,
        changedCache:cacheChanged.map(path=>({path,before:before.cache[path],after:after.cache[path]})),changedCritical:criticalChanged,stockAuditEvidence:before.stockAudit}
      // Retain this bounded metadata-only response even when JSON decoding
      // fails. Do not include the full historical Email capture in logs.
      if(captureSession)audit.nativeSessionRawOutput=String(raw??'').slice(0,8192)
      coldChecks.push(audit);partialColdChecks.push(audit)
      Object.assign(audit,auditNativeInitialColdCache(before.cache,after.cache,before.stockAudit,after.stockAudit))
      assert.equal(criticalChanged.length,0,'Cold CLI changed critical files during '+action+': '+criticalChanged.join(','))
      assert.ok(changed.every(t=>mutates&&allowed.includes(t)),'Cold bootstrap changed unrelated database tables during '+action+': '+changed.join(','))
      if(commandFailure)throw commandFailure
      return {value:JSON.parse(raw.trim()),raw}
    }
    let coldArtifact
    if(options.coldCli){coldArtifact=jsonStage('cli-source-artifact');const captured=coldCall('inspect-source',coldArtifact)
      assert.deepEqual(captured.value,observed.source,'Cold source is not the actual complete source capture')
      const dir='/var/lib/suitecrm/clawpilot-native-email-initial-enrollment-v1/operations/'+observed.operationId
      run('docker',['exec','--interactive',app,'php','-r',"$b=stream_get_contents(STDIN);$p=$argv[1];if(file_exists($p))throw new Exception('exclusive native source');$h=fopen($p,'x');chmod($p,0600);if(fwrite($h,$b)!==strlen($b))throw new Exception('source write');fclose($h);",coldArtifact.sourcePath],{input:captured.raw})
      const binding={operationId:observed.operationId,nativeInstanceId:'native-initial-fixture',appGeneration:7,
        appSourceFingerprint:sha('synthetic-app-initial-source'),sourceArtifactDigest:sha(captured.raw)}
      write(dir+'/install-binding.json',binding);coldArtifact.bindingPath=dir+'/install-binding.json'
      output+='NATIVE_INITIAL_COLD_SOURCE_PASSED=1\n'
      if(options.nativeSessionCaptureOnly){
        const capturedSession=coldCall('inspect-source',coldArtifact,{captureSession:true}).value
        assert.equal(capturedSession.version,1);assert.equal(capturedSession.purpose,'actual-native-database-manager-session-profile')
        assert.equal(capturedSession.nativeSessionOverridesApplied,false);assert.equal(capturedSession.installationExecuted,false)
        assert.equal(capturedSession.permissionExecutionReached,false)
        results.push({scenario:'native-session-capture-only',emailCount:options.count,scopeCounts:observed.scopeCounts,principalCount:4,
          databaseVersion,nativeSession:capturedSession,coldCliChecks:coldChecks,syntheticAppStore:true,appPostgresActivationProven:false})
        output+='NATIVE_INITIAL_ACTUAL_SESSION_CAPTURED=1\n';process.stdout.write(output.split('\n').filter(x=>/^NATIVE_INITIAL_/.test(x)).join('\n')+'\n')
        cleanScenario();continue
      }
    }
    const invokeInstaller=(file,args)=>JSON.parse(run('docker',['exec',app,'php','/source/'+file,...args]))
    const appRoot='/var/lib/suitecrm/app',scopeRoot='/var/lib/suitecrm/clawpilot-native-email-scope-v1',runtimeRoot='/var/lib/suitecrm/clawpilot-native-email-runtime-v1'
    const scope=invokeInstaller('install-native-email-scope.php',['check','--app-root='+appRoot,'--state-root='+scopeRoot]);assert.equal(scope.status,'ready')
    assert.equal(invokeInstaller('install-native-email-scope.php',['apply','--quiescent','--app-root='+appRoot,'--state-root='+scopeRoot]).status,'applied')
    const packet=invokeInstaller('install-native-email-runtime.php',['check','--app-root='+appRoot,'--state-root='+runtimeRoot]);assert.equal(packet.status,'ready')
    assert.equal(invokeInstaller('install-native-email-runtime.php',['apply','--quiescent','--app-root='+appRoot,'--state-root='+runtimeRoot,'--approve-package='+packet.packageHash]).status,'applied')
    let prepared
    if(options.coldCli){
      const installEnv=[...nativeEnv,'SUITECRM_DB_HOST=db','SUITECRM_DB_PORT=3306','SUITECRM_DB_NAME=suitecrm_native_test',
        'SUITECRM_DB_USER=fixture','SUITECRM_DB_PASSWORD=Synthetic-native-db-password-only']
      const installArgs=['--binding-file='+coldArtifact.bindingPath,'--source-artifact='+coldArtifact.sourcePath]
      const install=(action,args=[])=>JSON.parse(run('docker',['exec',...installEnv.flatMap(x=>['--env',x]),app,'php','/source/install-native-email-initial-state.php',action,...installArgs,...args]))
      const inspected=install('check');assert.equal(inspected.status,'ready');assert.equal(install('apply',['--quiescent','--approve-plan='+inspected.planHash]).status,'applied')
      const preparation=value=>{assert.deepEqual(Object.keys(value).sort(),['forecast','installationJournalFingerprint']);assert.match(value.installationJournalFingerprint,/^[a-f0-9]{64}$/);return value}
      coldArtifact=jsonStage('cli-project-artifact');const projected=preparation(coldCall('project',coldArtifact,{installationProof:true}).value)
      write('/tmp/clawpilot-initial-cli-project.json',projected.forecast)
      coldArtifact=jsonStage('cli-prepare-artifact');const preparedProof=preparation(coldCall('prepare',coldArtifact,{installationProof:true}).value)
      const forecast=preparedProof.forecast,plan=read('/tmp/clawpilot-initial-cli-final-plan.json').plan
      assert.equal(preparedProof.installationJournalFingerprint,projected.installationJournalFingerprint)
      assert.equal(preparedProof.installationJournalFingerprint,sha(installationJson(read('/var/lib/suitecrm/clawpilot-native-email-initial-enrollment-v1/manifest.json'))))
      prepared={plan,forecast,installation:{sourceRuntimeFingerprint:forecast.result.sourceRuntimeFingerprint,installedRuntimeFingerprint:forecast.result.installedRuntimeFingerprint,
        installationJournalFingerprint:preparedProof.installationJournalFingerprint}}
      output+='NATIVE_INITIAL_COLD_PREPARE_PASSED=1\n'
    }else{output+=stage('config-schema')+stage('installed-profile')+stage('prepare');prepared=read('/tmp/clawpilot-initial-prepared.json')}
    const p=prepared.plan,f=prepared.forecast,record={state:'reserved',publicationEnabled:false,barrierOperationId:p.operationId,plan:p,
      evidence:{complete:{appEmails:true,nativeEmails:true,nativePrincipals:true,pipelineAuthority:true,nativeDefaults:true},nativeInstanceId:p.nativeInstanceId,
        appGeneration:p.appGeneration,appSourceFingerprint:p.appSourceFingerprint,nativePolicyFingerprint:p.nativePolicyBeforeFingerprint,nativeRuntimeFingerprint:p.nativeRuntimeBeforeFingerprint,
        principalSuiteCrmUserIds:p.principalSuiteCrmUserIds,emails:observed.source.emails,defaults:observed.source.defaults,approvedPipelines:p.pipelines,reviewedRevocations:p.reviewedRevocations},
      planHash:f.planHash,preparedAt:f.preparedAt,nativeDelta:f.nativeDelta,deltaFingerprint:f.deltaFingerprint,...prepared.installation}
    let retained=null
    const store={async issueApproval(op,create){assert.equal(op,p.operationId);if(!retained)retained=clone(create(clone(record)));return clone(retained)}}
    const issuer=approval.createNativeEmailInitialApprovalIssuer(store,{privateKey:keys.privateKey,keyId:'initial-native-fixture-key',nativeInstanceId:p.nativeInstanceId,
      serviceUserId:observed.serviceUserId,oauthClientId:observed.oauthClientId,ttlSeconds:scenario==='expired-cancel'?1:120})
    const authorization=await issuer.issue(p.operationId,f.planHash);write('/tmp/clawpilot-initial-authorization.json',authorization)
    let receipt
    if(options.coldCli){coldArtifact=jsonStage('cli-execution-artifact');receipt=coldCall('execute',coldArtifact,{mutates:true}).value
      assert.equal(receipt.state,'committed');assert.deepEqual(coldCall('resolve',coldArtifact).value,receipt)
      assert.deepEqual(coldCall('execute',coldArtifact).value,receipt)
      output+='NATIVE_INITIAL_COLD_EXECUTE_FRESH_RESOLVE_PASSED=1\nNATIVE_INITIAL_COLD_KNOWN_STOCK_AUDIT_CACHE_TOUCHES='
        +coldChecks.reduce((sum,row)=>sum+row.knownStockAuditCacheTouchCount,0)+'\n'
    }else{
      const env=nativeEnv
      if(scenario==='expired-cancel'){const wait=authorization.proof.expiresAt*1000-Date.now()+100;if(wait>0)await new Promise(r=>setTimeout(r,wait));output+=stage('cancel-expired',env)+stage('resolve',env)}
      else {output+=stage('execute',env);if(scenario==='commit')output+=stage('resolve',env)}
      assert.match(output,scenario==='commit'?/NATIVE_INITIAL_EXECUTION_PASSED=/:scenario==='expired-cancel'?/NATIVE_INITIAL_EXPIRED_CANCELLATION_PASSED=1/:/NATIVE_INITIAL_ROLLBACK_PASSED=1/)
      receipt=scenario==='conflicting-all-rollback'?null:read('/tmp/clawpilot-initial-'+(scenario==='commit'?'receipt':'cancelled-receipt')+'.json')
    }
    if(receipt)assert.equal(receipt.approvalHash,digest(authorization))
    results.push({scenario,emailCount:options.count,scopeCounts:observed.scopeCounts,principalCount:4,blankStatusUnroled:true,databaseVersion,output,
      planHash:f.planHash,deltaFingerprint:f.deltaFingerprint,realNativeReceipt:receipt,coldCliChecks:coldChecks,syntheticAppStore:true,appPostgresActivationProven:false})
    process.stdout.write(output.split('\n').filter(x=>/^NATIVE_INITIAL_/.test(x)).join('\n')+'\n')
    cleanScenario()
  }
  for(const [p,h]of Object.entries(hashes))assert.equal(sha(readFileSync(p)),h,'Source changed during native initial acceptance: '+p)
  report={version:1,kind:'actual-native-initial-enrollment-fixture',sourceVersion:'8.10.1',sourceZipSha256:ZIP_SHA,sourceHashes:hashes,
    runtimeImage:php.Id,phpVersion:'8.3.36',databaseImage:maria.Id,emailCount:options.count,results,hostPorts:0,internalNetwork:true,
    coldCli:Boolean(options.coldCli),nativeSessionCaptureOnly:Boolean(options.nativeSessionCaptureOnly),temporaryRoot:root,storagePhases,coldCacheBoundary:options.coldCli?{stockAuditAtomicReplacementPath:STOCK_AUDIT_CACHE_PATH,
      conditionalParentTimestampPath:STOCK_AUDIT_CACHE_PARENT,stockAuditAtomicReplacementObserved:partialColdChecks.some(row=>row.stockAuditAtomicReplacementObserved),
      knownStockAuditCacheTouchCount:partialColdChecks.reduce((sum,row)=>sum+(row.knownStockAuditCacheTouchCount??0),0),
      zeroCacheWritesProven:false,allUnreviewedCacheUnchanged:true}:null,
    syntheticAppStore:true,appPostgresActivationProven:false,productionTouched:false,capturedAt:new Date().toISOString()}
  if(options.output)writeFileSync(options.output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})
  console.log('PASS actual native initial enrollment: '+(options.nativeSessionCaptureOnly?'metadata-only native DBManager session capture; no install or permission execution':options.coldCli?'fresh cold fixed CLI source/project/prepare/execute/resolve':'3 fresh scenarios')+'; synthetic application store, no PG activation or production proof')
}catch(error){if(options.output)writeFileSync(options.output.replace(/\.json$/,'.failed.json'),JSON.stringify({version:1,failed:true,sourceHashes:hashes,results,partialColdChecks,temporaryRoot:root,storagePhases,error:String(error.stack??error),stdout:String(error.stdout??''),stderr:String(error.stderr??''),productionTouched:false},null,2)+'\n',{flag:'wx',mode:0o600});throw error}
finally{cleanup()}
