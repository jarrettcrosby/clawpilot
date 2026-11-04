#!/usr/bin/env node
// Actual local PG + native MariaDB + emitted application operator. The seeded
// data and the local Docker command adapter are fixtures; native source,
// forecasts, signatures, execution, fresh resolution and PG settlement are NOT
// synthetic JSON ports. Service-image/entrypoint proof is opt-in and explicit;
// neither path certifies Railway SSH, signed-in application UI or production.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {createReadStream,lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statfsSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import {createDisposablePostgresRuntime,disposablePostgresDockerArgs,DISPOSABLE_POSTGRES_OWNER_LABEL} from './lib/disposable-postgres-docker.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'
import {runStorageGuard} from './local-storage-guard.mjs'
import {nativeRuntimeFixtureProfile} from './lib/native-runtime-fixture-profile.mjs'
import {auditNativeInitialColdCache} from './lib/native-initial-cold-cache.mjs'

assert.equal(process.versions.node.split('.')[0],'24','Use the supported bundled Node24 runtime')
assert.ok(process.execArgv.includes('--conditions=react-server'),'Run emitted server modules with --conditions=react-server')
const options={major:'16'}
for(const arg of process.argv.slice(2)){
  if(/^--(?:source-zip|build|output)=\//.test(arg)){const at=arg.indexOf('=');const key=arg.slice(2,at);assert.equal(options[key],undefined);options[key]=arg.slice(at+1)}
  else if(/^--postgres-major=(16|18)$/.test(arg))options.major=arg.split('=')[1]
  else if(/^--service-image=sha256:[a-f0-9]{64}$/.test(arg)){assert.equal(options.serviceImage,undefined);options.serviceImage=arg.slice('--service-image='.length)}
  else if(arg==='--replan-after-expiry'){assert.equal(options.replanAfterExpiry,undefined);options.replanAfterExpiry=true}
  else if(arg==='--zip-preflight-only'){assert.equal(options.zipPreflightOnly,undefined);options.zipPreflightOnly=true}
  else throw Error('Use --source-zip=/absolute/SuiteCRM-8.10.1.zip --build=/absolute/emitted-build --output=/absolute/new.json [--postgres-major=16|18] [--zip-preflight-only] [--service-image=sha256:immutable-image-id] [--replan-after-expiry]')
}
assert.ok(!(options.serviceImage&&options.zipPreflightOnly),'Archive-only preflight does not exercise the service image')
assert.ok(!options.replanAfterExpiry||options.serviceImage,'Expiry/replan proof requires the actual service image and true container restart')
assert.ok(isAbsolute(options['source-zip']??'')&&isAbsolute(options.build??'')&&isAbsolute(options.output??''))
assert.ok(options.output.endsWith('.json'),'Use one new JSON evidence artifact')
const outputParent=lstatSync(dirname(options.output));assert.ok(outputParent.isDirectory()&&!outputParent.isSymbolicLink()&&outputParent.uid===process.getuid())
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),id=()=>crypto.randomUUID()
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']'
  :value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value)
const env={...process.env,CI:'',VERCEL:'',VERCEL_ENV:'',CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE:'512m',CLAWPILOT_TEST_POSTGRES_MEMORY:'768m',CLAWPILOT_TEST_POSTGRES_CPUS:'0.5'}
for(const key of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID'])delete env[key]
assert.equal(runStorageGuard({argv:['--preflight'],environment:env}),0)
const archive=realpathSync(options['source-zip']),ZIP_SHA='b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7'
assert.ok(lstatSync(archive).isFile());const archiveHasher=crypto.createHash('sha256')
for await(const chunk of createReadStream(archive))archiveHasher.update(chunk)
assert.equal(archiveHasher.digest('hex'),ZIP_SHA)
const build=realpathSync(options.build),manifest=JSON.parse(readFileSync(join(build,'build-manifest.json'),'utf8'))
assert.equal(manifest.purpose,'clawpilot-native-email-initial-private-operator-build')
const checkBuild=()=>{for(const [p,h]of Object.entries(manifest.sources))assert.equal(sha(readFileSync(resolve('app_src',p))),h,'App source changed: '+p)
  for(const [p,h]of Object.entries(manifest.outputs))assert.equal(sha(readFileSync(join(build,p))),h,'Emitted operator changed: '+p)}
checkBuild()
const appRequire=createRequire(resolve('app_src/package.json')),compiled=createRequire(join(build,manifest.entry)),{Pool}=appRequire('pg')
const fromBuild=file=>compiled(join(build,'lib/crm',file+'.js'))
const {NativeEmailInitialEnrollmentOperator:Operator}=fromBuild('nativeEmailInitialEnrollmentOperator')
const {PostgresNativeEmailInitialEnrollmentStore:Store}=fromBuild('nativeEmailInitialEnrollmentPostgres')
const {NativeEmailInitialEnrollmentCliTransport:Transport}=fromBuild('nativeEmailInitialEnrollmentCliTransport')
const {NativeEmailInitialEnrollmentCoordinator:Coordinator}=fromBuild('nativeEmailInitialEnrollmentCoordinator')
const {createNativeEmailInitialApprovalIssuer:createIssuer}=fromBuild('nativeEmailInitialEnrollmentApproval')
const {createNativeEmailInitialStartupOriginIssuer:createOriginIssuer}=fromBuild('nativeEmailInitialStartupOrigin')
const {nativeEmailCanonicalJson:json}=fromBuild('nativeEmailPublication')
const source=resolve('services/suitecrm'),fixture=resolve('scripts/fixtures/native-email-audience-real'),startupFixture=resolve('scripts/fixtures/native-email-initial-joint-startup.php')
// Exact Docker COPY inputs. In service-image mode /opt/clawpilot and Apache
// configuration MUST come from the immutable built image, never host mounts.
const imageSourceMap={}
const addImageDirectory=(relative,target)=>{for(const entry of readdirSync(join(source,relative),{withFileTypes:true})){
  assert.ok(!entry.isSymbolicLink(),'Image source symlink refused');const from=join(relative,entry.name),to=target+'/'+entry.name
  if(entry.isDirectory())addImageDirectory(from,to);else{assert.ok(entry.isFile());imageSourceMap[join(source,from)]=to}}}
for(const name of ['email-audience','email-search','native-email-scope','record-lifecycle'])addImageDirectory(name,'/opt/clawpilot/'+name)
for(const name of ['bootstrap-client.php','bootstrap-global-id.php','install-email-search.php','install-email-audience.php',
  'install-native-email-scope.php','install-native-email-runtime.php','native-email-startup-check.php','install-native-email-initial-state.php',
  'native-email-initial-cli.php','native-email-initial-install-profile.json','native-email-initial-artifacts.php','native-email-enrolled-startup.php',
  'native-email-maintenance.py','native-email-liveness.json','install-record-lifecycle.php','bootstrap-image-principals.php'])imageSourceMap[join(source,name)]='/opt/clawpilot/'+name
for(const name of ['entrypoint.sh','scheduler-loop.sh','messenger-loop.sh'])imageSourceMap[join(source,name)]='/usr/local/bin/'+name
for(const [name,path]of Object.entries({'apache-site.conf':'/etc/apache2/sites-available/000-default.conf','apache-ports.conf':'/etc/apache2/ports.conf',
  'suitecrm.ini':'/usr/local/etc/php/conf.d/99-suitecrm.ini','supervisord.conf':'/etc/supervisor/conf.d/suitecrm.conf'}))imageSourceMap[join(source,name)]=path
const candidates=[resolve('scripts/test-native-email-initial-joint.mjs'),resolve('scripts/lib/native-initial-cold-cache.mjs'),
  startupFixture,
  ...readdirSync(fixture).filter(p=>p.endsWith('.php')).sort().map(p=>join(fixture,p)),
  ...readdirSync(join(source,'email-audience')).filter(p=>/\.(php|sql)$/.test(p)).sort().map(p=>join(source,'email-audience',p)),
  ...['install-native-email-runtime.php','install-native-email-scope.php','native-email-scope/Patch.php','native-email-scope/Scope.php',
    'native-email-initial-cli.php','native-email-initial-artifacts.php','native-email-enrolled-startup.php','install-native-email-initial-state.php','native-email-initial-install-profile.json'].map(p=>join(source,p)),
  ...readdirSync('db/migrations').filter(p=>/^\d+_.+\.sql$/.test(p)).sort().map(p=>resolve('db/migrations',p)),
  ...(options.serviceImage?[join(source,'Dockerfile'),...Object.keys(imageSourceMap)]:[])]
const sourceHashes=Object.fromEntries(candidates.map(p=>[p,sha(readFileSync(p))]))
const root=realpathSync(mkdtempSync(join(tmpdir(),'clawpilot-initial-joint.'))),owner=id(),label='com.clawpilot.native-initial-joint'
writeFileSync(join(root,'owner.json'),JSON.stringify({owner,pid:process.pid})+'\n',{flag:'wx',mode:0o600})
const suffix=owner.slice(0,8),names={pg:'cp-initial-joint-'+suffix+'-pg',maria:'cp-initial-joint-'+suffix+'-maria',app:'cp-initial-joint-'+suffix+'-app',
  net:'cp-initial-joint-'+suffix+'-native-net',pgnet:'cp-initial-joint-'+suffix+'-pg-net',...(options.serviceImage?{appdata:'cp-initial-joint-'+suffix+'-app-data'}:{})}
const deadline=Date.now()+600000,audits=[],checks=[],commandLog=[],storagePhases=[],appDataBudgets=[],appContainerHistory=[]
let pool,token,secondaryClean=false,cleanupMode=false,cleaned=false,activeTransactions=0,report,imageProof,primaryCleanupAttempted=false,replanEvidence=null
function run(command,args,extra={}){const remaining=cleanupMode?30000:deadline-Date.now();assert.ok(remaining>0,'Joint acceptance total 600-second deadline exceeded')
  return execFileSync(command,args,{encoding:'utf8',stdio:[Object.hasOwn(extra,'input')?'pipe':'ignore','pipe','pipe'],maxBuffer:6000000,
    ...extra,timeout:Math.min(extra.timeout??30000,remaining)})}
const inspect=name=>{try{return JSON.parse(run('docker',['inspect',name]))[0]}catch(e){if(/no such (?:object|container)/i.test(String(e.stderr)))return null;throw e}}
const inspectNet=name=>{try{return JSON.parse(run('docker',['network','inspect',name]))[0]}catch(e){if(/no such network|network .+ not found/i.test(String(e.stderr)))return null;throw e}}
const inspectVolume=()=>{try{return JSON.parse(run('docker',['volume','inspect',names.appdata]))[0]}catch(e){if(/no such volume/i.test(String(e.stderr)))return null;throw e}}
function ownedVolume(){const volume=inspectVolume();if(!volume)return null
  assert.equal(volume.Name,names.appdata);assert.equal(volume.Driver,'local');assert.equal(volume.Scope,'local')
  assert.equal(volume.Labels?.[label],owner);assert.equal(volume.Labels?.[DISPOSABLE_POSTGRES_OWNER_LABEL],token)
  assert.deepEqual(volume.Options??{},{});return volume}
function validateMounts(found){const volumes=found.Mounts.filter(m=>m.Type==='volume')
  if(options.serviceImage&&found.Name==='/'+names.app&&token){assert.equal(volumes.length,1);const volume=ownedVolume();assert.ok(volume)
    assert.equal(volumes[0].Name,names.appdata);assert.equal(volumes[0].Destination,'/var/lib/suitecrm');assert.equal(volumes[0].RW,true)
    assert.equal(volumes[0].Driver,'local');assert.equal(volumes[0].Source,volume.Mountpoint)
  }else assert.equal(volumes.length,0)
}
function removeSecondary(name){const found=inspect(name);if(!found)return
  assert.equal(found.Config.Labels?.[label],owner)
  if(token)assert.equal(found.Config.Labels?.[DISPOSABLE_POSTGRES_OWNER_LABEL],token)
  else assert.ok(['archive-preflight','image-preflight'].includes(found.Config.Labels?.[label+'.phase']))
  validateMounts(found);run('docker',['rm','--force','--volumes',found.Id]);assert.equal(inspect(found.Id),null)}
// The standard guarded runtime owns the primary PG lease. Do not allow its
// automatic exit cleanup to release that lease while a secondary is unknown.
const lifecycle={once(event,handler){if(event==='exit')process.once(event,()=>{if(secondaryClean)handler()})},exit:code=>process.exit(code)}
const runtime=createDisposablePostgresRuntime({environment:env,lifecycle})
function cleanup(){if(cleaned)return;cleanupMode=true
  try{removeSecondary(names.app)
    if(options.serviceImage){const volume=ownedVolume();if(volume){run('docker',['volume','rm',volume.Name]);assert.equal(inspectVolume(),null)}}
    removeSecondary(names.maria);secondaryClean=true
    primaryCleanupAttempted=true;assert.equal(runtime.cleanup(),true)
    for(const name of [names.net,names.pgnet]){const net=inspectNet(name);if(net){assert.equal(net.Labels?.[label],owner);assert.equal(Object.keys(net.Containers??{}).length,0)
      run('docker',['network','rm',net.Id]);assert.equal(inspectNet(net.Id),null)}}
    assert.equal(JSON.parse(readFileSync(join(root,'owner.json'),'utf8')).owner,owner);assert.match(root,/\/clawpilot-initial-joint\.[A-Za-z0-9]+$/)
    rmSync(root,{recursive:true});cleaned=true
  }catch(error){
    // Unknown secondary ownership/state MUST NOT release the guarded primary
    // lease. Preserve exact resource names for an explicit operator inspection.
    const held={version:1,kind:'native-initial-joint-cleanup-held',resourceOwner:owner,resourceNames:names,
      secondaryCleanupComplete:secondaryClean,primaryCleanupAttempted,error:String(error.stack??error),productionTouched:false}
    writeFileSync(options.output.replace(/\.json$/,'.cleanup-held.json'),JSON.stringify(held,null,2)+'\n',{flag:'wx',mode:0o600})
    console.error('JOINT_CLEANUP_HELD='+JSON.stringify(held));throw error
  }finally{cleanupMode=false}}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{try{cleanup()}finally{process.exit(signal==='SIGINT'?130:143)}})
const limits=(memory,cpus)=>['--memory',memory,'--memory-swap',memory,'--cpus',cpus,'--pids-limit','128','--log-driver','json-file','--log-opt','max-size=2m','--log-opt','max-file=1',
  '--label',label+'='+owner,'--label',DISPOSABLE_POSTGRES_OWNER_LABEL+'='+token]
const check=async(name,fn)=>{const result=await fn();checks.push(name);console.log('PASS '+name);return result}
const observeStorage=phase=>{const disk=statfsSync(process.cwd(),{bigint:true}),row={phase,availableBytes:Number(disk.bavail*disk.bsize),capturedAt:new Date().toISOString()}
  storagePhases.push(row);console.log('JOINT_STORAGE_PHASE='+JSON.stringify(row));return row}
const appDataBudget=phase=>{if(!options.serviceImage)return null
  const found=inspect(names.app);assert.ok(found?.State.Running);validateMounts(found)
  const output=run('docker',['exec',names.app,'du','-sk','/var/lib/suitecrm']),match=output.match(/^(\d+)\s+\/var\/lib\/suitecrm\s*$/)
  assert.ok(match,'Exact app-data allocation observation required');const allocatedBytes=Number(match[1])*1024
  assert.ok(Number.isSafeInteger(allocatedBytes)&&allocatedBytes>=0&&allocatedBytes<=640*1024*1024,'Native app data exceeds reviewed640MiB allocation budget')
  const row={phase,allocatedBytes,budgetBytes:640*1024*1024,hardQuota:false};appDataBudgets.push(row);return row}
const nativePaths={app:'/var/lib/suitecrm/app',scope:'/var/lib/suitecrm/clawpilot-native-email-scope-v1',runtime:'/var/lib/suitecrm/clawpilot-native-email-runtime-v1',state:'/var/lib/suitecrm/clawpilot-native-email-initial-enrollment-v1'}
// This checksum-pinned official archive is extracted ONCE inside the native
// app-data target: 640MiB tmpfs by default, or one explicitly owned temporary
// named volume with the same observed budget for the opt-in restart gate.
// Neither path creates a host39,499-file tree or relaxes the host disk guard.
const extractionPhp=String.raw`
$path="/official.zip";$destination="/var/lib/suitecrm/app";
if(hash_file("sha256",$path)!=="${ZIP_SHA}")throw new RuntimeException("Pinned official archive changed");
$zip=new ZipArchive();if($zip->open($path,ZipArchive::CHECKCONS)!==true)throw new RuntimeException("Cannot read pinned ZIP");
if($zip->numFiles!==39499||count(scandir($destination))!==2)throw new RuntimeException("Fresh exact archive destination required");
$total=0;$seen=[];$modes=[];
for($i=0;$i<$zip->numFiles;$i++){
  $name=$zip->getNameIndex($i);$entry=$zip->statIndex($i);$opsys=0;$attributes=0;
  if(!is_string($name)||$name===""||str_contains($name,"\0")||str_contains($name,"\\")||str_starts_with($name,"/")
    ||preg_match("/^[A-Za-z]:/D",$name)===1||isset($seen[$name])||!is_array($entry)
    ||!$zip->getExternalAttributesIndex($i,$opsys,$attributes))throw new RuntimeException("Unsafe ZIP entry");
  foreach(explode("/",rtrim($name,"/")) as $part)if($part===""||$part==="."||$part==="..")throw new RuntimeException("Escaping ZIP path");
  $directory=str_ends_with($name,"/");$kind=($attributes>>16)&0170000;
  if($opsys!==3||$kind!==($directory?0040000:0100000))throw new RuntimeException("Linked or nonregular ZIP entry");
  $seen[$name]=true;$modes[$name]=($attributes>>16)&0777;$total+=(int)$entry["size"];
}
if($total!==380723809||!$zip->extractTo($destination)||!$zip->close())throw new RuntimeException("Incomplete pinned extraction");
foreach($modes as $name=>$mode){
  $file=$destination."/".rtrim($name,"/");
  if(!chmod($file,$mode))throw new RuntimeException("Cannot preserve reviewed ZIP permissions");
  clearstatcache(true,$file);$meta=lstat($file);
  if(!is_array($meta)||($meta["mode"]&0777)!==$mode||($meta["mode"]&07000)!==0)throw new RuntimeException("Extracted entry permissions changed");
}
$count=0;$actualBytes=0;
foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($destination,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::SELF_FIRST) as $file){
  if($file->isLink())throw new RuntimeException("Extracted link refused");$count++;if($file->isFile())$actualBytes+=$file->getSize();
}
if($count!==39499||$actualBytes!==380723809)throw new RuntimeException("Extracted official tree changed");
fwrite(STDOUT,"JOINT_PINNED_EXTRACTION_PASSED=1\n");`
assert.ok(!extractionPhp.includes("'"),'Fixed PHP program must remain a safe single-quoted shell argument')
try{
  observeStorage('before-guarded-primary-admission')
  if(options.serviceImage){
    const image=JSON.parse(run('docker',['image','inspect',options.serviceImage]))[0]
    assert.equal(image.Id,options.serviceImage);assert.equal(image.Os,'linux');assert.equal(image.Architecture,'amd64')
    assert.deepEqual(image.Config.Entrypoint,['/usr/local/bin/entrypoint.sh']);assert.ok(image.Config.Env.includes('PHP_VERSION=8.3.36'))
    assert.ok(Object.hasOwn(image.Config.ExposedPorts,'8080/tcp'));assert.deepEqual(Object.keys(image.Config.Volumes??{}),[])
    const expected=Object.fromEntries(Object.entries(imageSourceMap).map(([path,target])=>[target,sha(readFileSync(path))]))
    const actual=JSON.parse(run('docker',['run','--rm','--interactive','--name',names.app,'--label',label+'='+owner,'--label',label+'.phase=image-preflight',
      '--pull=never','--platform=linux/amd64','--network=none','--read-only','--memory=128m','--memory-swap=128m','--cpus=0.5','--pids-limit=64',
      '--cap-drop=ALL','--security-opt=no-new-privileges','--log-driver=json-file','--log-opt=max-size=1m','--log-opt=max-file=1',
      '--entrypoint','php',image.Id,'-r',
      '$expected=json_decode(stream_get_contents(STDIN),true,64,JSON_THROW_ON_ERROR);$actual=[];foreach($expected as $path=>$hash){'
        +'clearstatcache(true,$path);$m=lstat($path);if(!is_array($m)||!is_file($path)||is_link($path)||$m["uid"]!==0||$m["gid"]!==0'
        +'||!hash_equals($hash,hash_file("sha256",$path)))throw new RuntimeException("Image COPY source drift");$actual[$path]=$hash;}'
        +'fwrite(STDOUT,json_encode($actual,JSON_THROW_ON_ERROR));'],{input:JSON.stringify(expected)}))
    assert.deepEqual(actual,expected)
    imageProof={id:image.Id,os:image.Os,architecture:image.Architecture,entrypoint:image.Config.Entrypoint,
      configuredExposedPorts:Object.keys(image.Config.ExposedPorts).sort(),imageCopySourceHashes:actual,
      dockerfileSha256:sha(readFileSync(join(source,'Dockerfile'))),hostRuntimeSourceOverlay:false}
  }
  if(options.zipPreflightOnly){
    const php=JSON.parse(run('docker',['image','inspect',nativeRuntimeFixtureProfile('8.3.36').image]))[0]
    assert.ok(php.Config.Env.includes('PHP_VERSION=8.3.36'));assert.deepEqual(Object.keys(php.Config.Volumes??{}),[])
    const cut=extractionPhp.indexOf('if($total!==380723809||!$zip->extractTo');assert.ok(cut>0)
    const validation='token_get_all("<?php ".base64_decode($argv[1],true),TOKEN_PARSE);mkdir("/var/lib/suitecrm/app",0700,true);'
      +extractionPhp.slice(0,cut)+'if($total!==380723809)throw new RuntimeException("Official central-directory size changed");$zip->close();'
      +'fwrite(STDOUT,json_encode(["phpSyntaxPassed"=>true,"archiveSha256"=>hash_file("sha256",$path),"entryCount"=>count($seen),"uncompressedBytes"=>$total,"unixPermissionsRead"=>true,"extractionExecuted"=>false,"databaseCreated"=>false],JSON_THROW_ON_ERROR));'
    const result=JSON.parse(run('docker',['run','--rm','--name',names.app,'--label',label+'='+owner,'--label',label+'.phase=archive-preflight',
      '--pull=never','--network=none','--read-only','--memory=128m','--memory-swap=128m','--cpus=0.5','--pids-limit=64','--cap-drop=ALL','--security-opt=no-new-privileges',
      '--log-driver=json-file','--log-opt=max-size=1m','--log-opt=max-file=1','--tmpfs','/var/lib/suitecrm:rw,nosuid,nodev,noexec,size=8m,mode=0700',
      '--mount','type=bind,source='+archive+',target=/official.zip,readonly',php.Id,'-r',validation,Buffer.from(extractionPhp).toString('base64')]))
    assert.equal(result.archiveSha256,ZIP_SHA);assert.equal(result.entryCount,39499);assert.equal(result.uncompressedBytes,380723809)
    assert.equal(result.phpSyntaxPassed,true);assert.equal(result.extractionExecuted,false);assert.equal(result.databaseCreated,false)
    observeStorage('after-central-directory-only-preflight')
    writeFileSync(options.output,JSON.stringify({version:1,kind:'native-initial-joint-archive-preflight-only',passed:true,resourceOwner:owner,resourceNames:names,
      sourceHashes,result,storagePhases,productionTouched:false},null,2)+'\n',{flag:'wx',mode:0o600})
    console.log('PASS actual PHP token parsing and pinned central-directory metadata; no extraction or database executed')
  }else{
  const pgArgs=disposablePostgresDockerArgs(['run','--rm','--detach','--pull','never','--name',names.pg,'--network',names.pgnet,
    '--env','POSTGRES_PASSWORD=initial_joint_fixture','--env','POSTGRES_DB=initial_joint_fixture','--publish','127.0.0.1::5432','pgvector/pgvector:pg'+options.major],{runtime,environment:env})
  token=pgArgs.find(a=>a.startsWith(DISPOSABLE_POSTGRES_OWNER_LABEL+'=')).split('=')[1]
  assert.equal(pgArgs.filter(a=>a==='--publish').length,1);assert.equal(pgArgs[pgArgs.indexOf('--publish')+1],'127.0.0.1::5432')
  run('docker',['network','create','--internal','--label',label+'='+owner,names.net])
  run('docker',['network','create','--label',label+'='+owner,names.pgnet])
  assert.equal(inspectNet(names.net).Internal,true);assert.equal(inspectNet(names.pgnet).Internal,false)
  run('docker',pgArgs)
  const port=run('docker',['port',names.pg,'5432/tcp']).match(/^127\.0\.0\.1:(\d+)\s*$/)?.[1];assert.ok(port)
  assert.deepEqual(inspect(names.pg).NetworkSettings.Ports['5432/tcp'],[{HostIp:'127.0.0.1',HostPort:port}])
  pool=new Pool({host:'127.0.0.1',port:Number(port),database:'initial_joint_fixture',user:'postgres',password:'initial_joint_fixture',ssl:false,max:3,statement_timeout:10000})
  let until=Date.now()+30000;for(;;){try{await pool.query('SELECT 1');break}catch(e){if(Date.now()>until)throw e;await new Promise(r=>setTimeout(r,100))}}
  const q=(sql,values=[])=>pool.query(sql,values)
  const transaction=async fn=>{const client=await pool.connect();activeTransactions++
    try{await client.query('BEGIN');const value=await fn({query:(sql,values=[])=>client.query(sql,values)});await client.query('COMMIT');return value}
    catch(e){await client.query('ROLLBACK');throw e}finally{activeTransactions--;client.release()}}
  await check('actual PostgreSQL migrations through retained initial enrollment on the guarded primary',async()=>{
    const client=await pool.connect();try{for(const p of candidates.filter(p=>p.includes('/db/migrations/')))
      await applyMigrationSqlForTest(client,p.split('/').at(-1),readFileSync(p,'utf8'))}finally{client.release()}})
  const image=tag=>JSON.parse(run('docker',['image','inspect',tag]))[0],php=image(options.serviceImage??nativeRuntimeFixtureProfile('8.3.36').image),maria=image('mariadb:11.4.13')
  assert.ok(php.Config.Env.includes('PHP_VERSION=8.3.36'));assert.deepEqual(Object.keys(php.Config.Volumes??{}),[])
  run('docker',['run','--rm','--detach','--pull=never','--name',names.maria,'--network',names.net,'--network-alias','db','--read-only',...limits('640m','0.5'),
    '--tmpfs','/var/lib/mysql:rw,nosuid,size=320m','--tmpfs','/run/mysqld:rw,nosuid,size=8m','--tmpfs','/tmp:rw,nosuid,size=32m',
    '--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--cap-add','SETGID','--cap-add','SETUID','--security-opt','no-new-privileges',
    '--env','MARIADB_ROOT_PASSWORD=Synthetic-native-root-password-only','--env','MARIADB_DATABASE=suitecrm_native_test',
    '--env','MARIADB_USER=fixture','--env','MARIADB_PASSWORD=Synthetic-native-db-password-only',maria.Id,'--skip-log-bin','--innodb-buffer-pool-size=64M','--max-connections=20',
    '--performance-schema=OFF','--character-set-server=utf8mb3','--collation-server=utf8mb3_general_ci'])
  const sql=text=>run('docker',['exec','--env','MYSQL_PWD=Synthetic-native-db-password-only',names.maria,'mariadb','--protocol=TCP','--host=127.0.0.1',
    '--user=fixture','--database=suitecrm_native_test','--batch','--skip-column-names','--execute='+text])
  until=Date.now()+60000;for(;;){try{sql('SELECT 1');break}catch(e){if(Date.now()>until)throw e;await new Promise(r=>setTimeout(r,250))}}
  const constructionBudget=options.serviceImage
    ?'joint_budget() { joint_blocks=$(du -sk /var/lib/suitecrm); joint_blocks=${joint_blocks%%[[:space:]]*}; [ "$joint_blocks" -le 655360 ]; printf "JOINT_APP_DATA_BUDGET=%s:%s\\n" "$1" "$joint_blocks"; }; '
    :'joint_budget() { :; }; '
  const bootstrap="set -eu; "+constructionBudget+"mkdir -p /var/lib/suitecrm/app; joint_budget before-extraction; php -d memory_limit=384M -r '"+extractionPhp+"'; joint_budget after-extraction; cd /var/lib/suitecrm/app; php -d memory_limit=384M bin/console suitecrm:app:install --no-interaction -u fixture-admin -p Synthetic-native-admin-password-only -U fixture -P Synthetic-native-db-password-only -H db -Z 3306 -N suitecrm_native_test -S https://suitecrm-native.invalid -d no -W true >/tmp/native-initial-install.log 2>&1 || { tail -n 50 /tmp/native-initial-install.log; exit 1; }; joint_budget after-official-installation; touch /tmp/native-initial-ready; while [ ! -f /tmp/native-initial-done ]; do sleep 1; done"
  observeStorage('before-native-tmpfs-extraction-and-installation')
  if(options.serviceImage){
    assert.equal(runStorageGuard({argv:['--preflight'],environment:env}),0)
    assert.equal(inspectVolume(),null,'Never reuse an existing app data volume')
    assert.equal(run('docker',['volume','create','--driver=local','--label',label+'='+owner,'--label',DISPOSABLE_POSTGRES_OWNER_LABEL+'='+token,names.appdata]).trim(),names.appdata)
    assert.ok(ownedVolume())
  }
  const appDataMount=options.serviceImage?['--mount','type=volume,source='+names.appdata+',target=/var/lib/suitecrm,volume-nocopy']
    :['--tmpfs','/var/lib/suitecrm:rw,nosuid,size=640m']
  const fixtureMounts=['--mount','type=bind,source='+fixture+',target=/fixture,readonly',
    '--mount','type=bind,source='+startupFixture+',target=/joint-startup.php,readonly',
    '--mount','type=bind,source='+source+',target=/source,readonly']
  run('docker',['run','--rm','--detach','--pull=never','--name',names.app,'--network',names.net,'--read-only',...limits('1152m','1'),
    ...(options.serviceImage?['--platform=linux/amd64']:[]),
    '--cap-drop','ALL','--security-opt','no-new-privileges',...appDataMount,'--tmpfs','/tmp:rw,nosuid,size=32m',
    '--mount','type=bind,source='+archive+',target=/official.zip,readonly',...fixtureMounts,
    ...(options.serviceImage?[]:['--mount','type=bind,source='+source+',target=/opt/clawpilot,readonly']),
    '--env','CLAWPILOT_NATIVE_INITIAL_FIXTURE=1','--env','CLAWPILOT_NATIVE_INITIAL_FIXTURE_EMAILS=329','--entrypoint','/bin/sh',php.Id,'-c',bootstrap])
  appContainerHistory.push({phase:'fixture-construction',id:inspect(names.app).Id})
  until=Date.now()+180000;for(;;){try{run('docker',['exec',names.app,'test','-f','/tmp/native-initial-ready'],{timeout:3000});break}catch(e){
    const alive=inspect(names.app);if(!alive?.State.Running)throw Error('Native installation failed: '+(alive?run('docker',['logs',names.app]):'owned container absent'))
    if(Date.now()>until)throw e;await new Promise(r=>setTimeout(r,500))}}
  observeStorage('after-native-tmpfs-extraction-and-installation')
  appDataBudget('after-extraction-and-official-installation')
  const constructionLog=run('docker',['logs',names.app]);assert.match(constructionLog,/JOINT_PINNED_EXTRACTION_PASSED=1/)
  if(options.serviceImage){const rows=[...constructionLog.matchAll(/^JOINT_APP_DATA_BUDGET=([a-z-]+):(\d+)$/gm)]
    assert.deepEqual(rows.map(row=>row[1]),['before-extraction','after-extraction','after-official-installation'])
    for(const row of rows){const allocatedBytes=Number(row[2])*1024;assert.ok(Number.isSafeInteger(allocatedBytes)&&allocatedBytes<=640*1024*1024)
      appDataBudgets.push({phase:row[1],allocatedBytes,budgetBytes:640*1024*1024,hardQuota:false})}}
  for(const name of [names.pg,names.maria,names.app])validateMounts(inspect(name))
  for(const name of [names.maria,names.app])assert.equal(Object.keys(inspect(name).HostConfig.PortBindings??{}).length,0)
  const stage=name=>run('docker',['exec',names.app,'php','-d','memory_limit=384M','/fixture/native-initial-enrollment.php',name,'--initial-volume-app'],{timeout:45000})
  const readNative=path=>JSON.parse(run('docker',['exec',names.app,'php','-r','fwrite(STDOUT,file_get_contents($argv[1]));',path]))
  appDataBudget('before-synthetic-source-construction')
  stage('source');const observed=readNative('/tmp/clawpilot-initial-source.json');appDataBudget('after-synthetic-source-construction')
  assert.equal(observed.source.emails.length,329);assert.equal(observed.source.principalSuiteCrmUserIds.length,4)
  const selection={actorEmail:'joint.owner@example.invalid',operatorAccountId:id(),rootWorkspaceId:id(),nativeInstanceId:'native-initial-fixture'}
  const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),publicKey=keys.publicKey.export({type:'spki',format:'pem'}),keyId='initial-joint-fixture-key'
  const nativeEnv=['CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=1','SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID='+keyId,
    'SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID='+selection.nativeInstanceId,'SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='+publicKey,
    'SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID='+observed.serviceUserId,'SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='+observed.oauthClientId]
  const deniedIds=observed.source.principalSuiteCrmUserIds.filter(p=>![observed.serviceUserId,observed.viewerId].includes(p));assert.equal(deniedIds.length,2)
  const people=[{email:selection.actorEmail,native:observed.serviceUserId,role:'owner'},
    {email:'joint.viewer@example.invalid',native:observed.viewerId,role:'member'},...deniedIds.map((native,i)=>({email:'joint.denied'+i+'@example.invalid',native,role:'member'}))]
  await check('actual app mappings and complete current authority seeded from the fresh native fixture identities',async()=>{
    for(const person of people)await q(`WITH ref AS(SELECT allocate_crm_reference('gu') AS code)
      INSERT INTO app_users(email,role,status,suitecrm_user_id,suitecrm_username,reference_code,crm_user_enabled)
      SELECT $1,$2,'active',$3,code,code,true FROM ref`,[person.email,person.role,person.native])
    await q(`INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by) VALUES($1,'Joint operator root','root',$2,$2)`,[selection.rootWorkspaceId,selection.actorEmail])
    await q(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
      VALUES($1,$2,'owner','active','{}'::jsonb,$1,$1)`,[selection.actorEmail,selection.rootWorkspaceId])
    await q(`INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)`,
      [selection.operatorAccountId,selection.rootWorkspaceId,selection.actorEmail])
    await q(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)`,
      [selection.operatorAccountId,selection.rootWorkspaceId,selection.actorEmail])
    for(const {policy}of observed.pipelines){
      await q(`INSERT INTO workspace_organizations(id,name,parent_id,organization_type,created_by,updated_by) VALUES($1,$2,$3,'member',$4,$4)`,
        [policy.workspaceId,'Joint native scope '+policy.pipelineId,selection.rootWorkspaceId,selection.actorEmail])
      for(const person of people)await q(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
        VALUES($1,$2,$3,'active',$4,$5,$5)`,[person.email,policy.workspaceId,person.role,{viewCrm:policy.futureCreate.view.includes(person.native)},selection.actorEmail])
      await q(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)`,
        [selection.operatorAccountId,policy.workspaceId,selection.actorEmail])
      await q('INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)',[policy.pipelineId,'Joint native pipeline',selection.actorEmail,policy.workspaceId])
      for(const person of people.filter(p=>p.role!=='owner'))await q('INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role) VALUES($1,$2,$3)',[policy.pipelineId,person.email,'editor'])
    }
    await q(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,reference_code,source_payload)
      SELECT e."localId"::uuid,e."pipelineId"::uuid,'joint-native-'||e."nativeId",'Actual joint seeded native Email',
      encode(digest(e."nativeId",'sha256'),'hex'),e."nativeId",'Emails',now(),e."globalId",jsonb_build_object('archived',e.archived)
      FROM jsonb_to_recordset($1::jsonb) AS e("localId" text,"pipelineId" text,"nativeId" text,"globalId" text,archived boolean)`,[JSON.stringify(observed.source.emails)])
  })
  const verification={publicKey,keyId,serviceUserId:observed.serviceUserId,oauthClientId:observed.oauthClientId}
  const initialStore=new Store(transaction,selection,undefined,verification),preview=await initialStore.preview(),operationId=observed.operationId
  await check('real SQL source reservation is committed before native source transport or any offline installation',async()=>{
    assert.equal(preview.publicationEnabled,false);assert.equal(preview.activeOperationId,null)
    await initialStore.reserve(operationId,preview.sourceFingerprint)
    assert.equal((await q('SELECT active_initial_enrollment_id FROM crm_native_email_publication_control WHERE singleton')).rows[0].active_initial_enrollment_id,operationId)
    assert.equal((await q('SELECT count(*)::int AS n FROM crm_interactions')).rows[0].n,329)
  })
  const rawState=()=>{const output=stage('raw-state'),line=output.split('\n').findLast(x=>x.startsWith('{'));assert.ok(line);return JSON.parse(line)}
  const invoke=(script,args,extra={})=>run('docker',['exec',...(extra.input!==undefined?['--interactive']:[]),...nativeEnv.flatMap(x=>['--env',x]),names.app,
    'php','-d','memory_limit=384M',script,...args],{timeout:45000,...extra})
  const packet=JSON.parse(invoke('/opt/clawpilot/install-native-email-runtime.php',['check','--app-root='+nativePaths.app,'--state-root='+nativePaths.runtime]))
  const binary=realpathSync('/usr/bin/true'),target={railwayBinary:binary,railwayBinarySha256:sha(readFileSync(binary)),projectId:id(),environmentId:id(),serviceId:id(),
    nativeInstanceId:selection.nativeInstanceId,database:'suitecrm_native_test',serviceUserId:observed.serviceUserId,oauthClientId:observed.oauthClientId,
    cliSourceHash:sha(readFileSync(join(source,'native-email-initial-cli.php'))),imagePackageHash:packet.packageHash}
  let loseNativeCommitResponse=true,nativeExecutionCount=0,nativeResolutionBeforePgActivation=false,activationOperationId=operationId
  const expectedCancellations=new Set(),nativeCancellationOperations=[],freshCancellationResolutions=[]
  const actualCommand=async command=>{
    assert.equal(activeTransactions,0,'Native I/O occurred under a PG transaction')
    assert.equal(command.program,binary)
    assert.deepEqual(command.args.slice(0,9),['ssh','--project',target.projectId,'--environment',target.environmentId,'--service',target.serviceId,'--','php'])
    const script=command.args[9],args=command.args.slice(10),action=args[0],commandOperation=args.find(arg=>arg.startsWith('--operation='))?.slice('--operation='.length)
    assert.ok(['/opt/clawpilot/native-email-initial-cli.php','/opt/clawpilot/native-email-initial-artifacts.php'].includes(script))
    const isExecute=script.endsWith('/native-email-initial-cli.php')&&action==='execute',isCancel=script.endsWith('/native-email-initial-cli.php')&&action==='cancel-expired'
    if(isCancel)assert.ok(expectedCancellations.has(commandOperation),'Only the exact deliberately expired fixture operation may cancel')
    if(script.endsWith('/native-email-initial-cli.php')&&action==='resolve'){
      const control=(await q('SELECT enabled FROM crm_native_email_publication_control WHERE singleton')).rows[0]
      if(!control.enabled){const state=(await q('SELECT state FROM crm_native_email_initial_enrollments WHERE operation_id=$1',[commandOperation])).rows[0].state
        if(state==='unknown'){assert.equal(commandOperation,activationOperationId);nativeResolutionBeforePgActivation=true}
        else{assert.ok(expectedCancellations.has(commandOperation));assert.ok(['dispatched','cancelled'].includes(state))
          if(state==='dispatched')freshCancellationResolutions.push(commandOperation)}}
    }
    appDataBudget('before-native-'+action);const before=rawState();let output,failure
    try{output=invoke(script,args,command.stdin===undefined?{}:{input:command.stdin})}catch(e){failure=e}
    const after=rawState(),changed=Object.keys(before.database).filter(t=>before.database[t]!==after.database[t]);appDataBudget('after-native-'+action)
    assert.deepEqual(Object.keys(after.database),Object.keys(before.database),'Transport command created schema')
    const allowed=['acl_actions','securitygroups','securitygroups_users','securitygroups_records','clawpilot_email_bindings','clawpilot_email_identities',
      'clawpilot_email_write_scopes','clawpilot_email_write_permissions','clawpilot_email_initial_enrollments']
    assert.ok(changed.every(t=>isExecute&&allowed.includes(t)||isCancel&&t==='clawpilot_email_initial_enrollments'),
      'Unrelated native table changed: '+changed.join(','))
    assert.deepEqual(after.critical,before.critical,'Transport command changed critical native files')
    const cache=auditNativeInitialColdCache(before.cache,after.cache,before.stockAudit,after.stockAudit)
    audits.push({script,action,operationId:commandOperation,commandSucceeded:!failure,tableCount:Object.keys(before.database).length,changedTables:changed,
      beforeStateHash:sha(JSON.stringify(before)),afterStateHash:sha(JSON.stringify(after)),criticalFilesUnchanged:true,...cache})
    commandLog.push({script,action,operationId:commandOperation})
    if(failure)throw failure
    if(isExecute){nativeExecutionCount++;const actualReceipt=JSON.parse(output);assert.equal(actualReceipt.state,'committed')
      if(loseNativeCommitResponse){loseNativeCommitResponse=false;throw Error('Deliberate loss AFTER actual native COMMIT; fresh resolution required')}}
    if(isCancel){assert.ok(expectedCancellations.has(commandOperation));assert.equal(JSON.parse(output).state,'cancelled');nativeCancellationOperations.push(commandOperation)}
    return output
  }
  let native=new Transport(target,actualCommand),operator=new Operator(transaction,selection,native)
  const captured=await check('compiled operator captures all native source through actual root-private stage/CLI/retention transport',()=>operator.captureSource(operationId,preview.sourceFingerprint))
  assert.equal(captured.source.mappings.length,329);native.retainSourceDigest(operationId,captured.sourceArtifactDigest)
  const opDir=nativePaths.state+'/operations/'+operationId,bindingPath=opDir+'/install-binding.json',sourcePath=opDir+'/native-source.json'
  const binding={operationId,nativeInstanceId:selection.nativeInstanceId,appGeneration:preview.generation,appSourceFingerprint:preview.sourceFingerprint,sourceArtifactDigest:captured.sourceArtifactDigest}
  invoke('/opt/clawpilot/native-email-initial-artifacts.php',['read-source','--operation='+operationId,'--sha256='+captured.sourceArtifactDigest,'--quiescent'])
  run('docker',['exec','--interactive',names.app,'php','-r',"$p=$argv[1];$b=stream_get_contents(STDIN);if(file_exists($p)||is_link($p))throw new Exception('exclusive joint binding');$h=fopen($p,'x');chmod($p,0600);if(fwrite($h,$b)!==strlen($b)||!fflush($h)||!fsync($h))throw new Exception('joint binding write');fclose($h);",bindingPath],{input:stable(binding)+'\n'})
  await check('genuine offline scope/runtime/schema/config installers consume the real reserved-source binding',async()=>{
    appDataBudget('before-offline-installers')
    const scopeArgs=['--app-root='+nativePaths.app,'--state-root='+nativePaths.scope]
    assert.equal(JSON.parse(invoke('/opt/clawpilot/install-native-email-scope.php',['check',...scopeArgs])).status,'ready')
    assert.equal(JSON.parse(invoke('/opt/clawpilot/install-native-email-scope.php',['apply','--quiescent',...scopeArgs])).status,'applied')
    const runtimeArgs=['--app-root='+nativePaths.app,'--state-root='+nativePaths.runtime]
    const current=JSON.parse(invoke('/opt/clawpilot/install-native-email-runtime.php',['check',...runtimeArgs]));assert.equal(current.packageHash,packet.packageHash)
    assert.equal(JSON.parse(invoke('/opt/clawpilot/install-native-email-runtime.php',['apply','--quiescent','--approve-package='+current.packageHash,...runtimeArgs])).status,'applied')
    const installEnv=[...nativeEnv,'SUITECRM_DB_HOST=db','SUITECRM_DB_PORT=3306','SUITECRM_DB_NAME=suitecrm_native_test','SUITECRM_DB_USER=fixture','SUITECRM_DB_PASSWORD=Synthetic-native-db-password-only']
    const args=['--binding-file='+bindingPath,'--source-artifact='+sourcePath]
    const install=(action,extra=[])=>JSON.parse(run('docker',['exec',...installEnv.flatMap(x=>['--env',x]),names.app,'php','/opt/clawpilot/install-native-email-initial-state.php',action,...args,...extra]))
    const inspected=install('check');assert.equal(inspected.status,'ready');assert.equal(install('apply',['--quiescent','--approve-plan='+inspected.planHash]).status,'applied')
    appDataBudget('after-offline-installers')
  })
  await check('fresh operator recovers exact same-A original source after installation without a new stock source inspection',async()=>{
    // Simulate a new operator process after an interrupted forward workflow.
    // The independently retained source digest is not recomputed from whatever
    // native bytes happen to exist after installation.
    native=new Transport(target,actualCommand);operator=new Operator(transaction,selection,native)
    const from=commandLog.length,recovered=await operator.recoverRetainedSource(operationId,preview.sourceFingerprint,captured.sourceArtifactDigest)
    assert.deepEqual(recovered.source,captured.source);assert.equal(recovered.sourceBytes,captured.sourceBytes)
    assert.equal(recovered.sourceArtifactDigest,captured.sourceArtifactDigest)
    assert.ok(commandLog.slice(from).some(row=>row.action==='read-source'))
    assert.ok(commandLog.slice(from).every(row=>row.action!=='inspect-source'),'Recovery must not recapture the installed runtime as stock source')
    assert.equal((await initialStore.preview()).sourceFingerprint,preview.sourceFingerprint)
    native.retainSourceDigest(operationId,recovered.sourceArtifactDigest)
  })
  let input={operationId,appSourceFingerprint:preview.sourceFingerprint,sourceArtifactDigest:captured.sourceArtifactDigest,preparedAt:new Date().toISOString().slice(0,19).replace('T',' ')}
  const candidate=await check('real SQL authority and actual rollback-only native forecasts produce the reviewed candidate',()=>operator.prepareForReview(input))
  assert.equal(candidate.executable,false);assert.equal(candidate.material.plan.emails.length,329);assert.equal(candidate.material.plan.pipelines.length,3)
  let material=candidate.material
  const reviewedStore=(selectedInput,selectedMaterial)=>new Store(transaction,selection,
    {expectedPlanHash:selectedMaterial.planHash,read:()=>operator.readReviewedMaterial(selectedInput,selectedMaterial.planHash)},verification)
  let store=reviewedStore(input,material)
  const issuerConfig={privateKey:keys.privateKey,keyId,nativeInstanceId:selection.nativeInstanceId,serviceUserId:observed.serviceUserId,oauthClientId:observed.oauthClientId}
  let issuer=createIssuer(store,issuerConfig),coordinator=new Coordinator(store,issuer,native)
  let verifyHistoricalRootAfterActivation,verifyAncestorPreservation
  if(options.replanAfterExpiry){
    const rootOperationId=operationId,rootMaterial=material,rootSourceDigest=captured.sourceArtifactDigest,cancelled=[]
    const originalInstallerFiles=JSON.parse(run('docker',['exec',names.app,'php','-r',
      '$out=[];foreach(array_slice($argv,1) as $path){$bytes=file_get_contents($path);$m=lstat($path);'
        +'if(!is_string($bytes)||!is_array($m)||is_link($path)||$m["uid"]!==0||($m["mode"]&0777)!==0600||strlen($bytes)>4194304)throw new RuntimeException("Original fixture install file required");'
        +'$out[substr($path,strlen("/var/lib/suitecrm/"))]=["sha256"=>hash("sha256",$bytes),"size"=>strlen($bytes),"bytesBase64"=>base64_encode($bytes),"uid"=>$m["uid"],"gid"=>$m["gid"],"mode"=>$m["mode"]&0777];}'
        +'fwrite(STDOUT,json_encode($out,JSON_THROW_ON_ERROR));',
      nativePaths.scope+'/manifest.json',nativePaths.runtime+'/manifest.json',nativePaths.state+'/manifest.json',sourcePath,bindingPath],{maxBuffer:16000000}))
    assert.equal(originalInstallerFiles[sourcePath.slice('/var/lib/suitecrm/'.length)].sha256,rootSourceDigest)
    const rootObservation=(selected=rootOperationId)=>JSON.parse(run('docker',['exec',names.app,'php','-d','memory_limit=384M','/fixture/native-initial-enrollment.php',
      'joint-retained-state','--initial-volume-app',selected],{timeout:45000,maxBuffer:16000000}))
    const sqlObservation=async selected=>(await q(`SELECT to_jsonb(e) AS enrollment,to_jsonb(r) AS reservation
      FROM crm_native_email_initial_enrollments e JOIN crm_native_email_initial_reservations r USING(operation_id) WHERE e.operation_id=$1`,[selected])).rows[0]
    const summarizeRoot=observation=>({files:Object.fromEntries(Object.entries(observation.files).map(([path,row])=>[path,
      {sha256:row.sha256,size:row.size,uid:row.uid,gid:row.gid,mode:row.mode}])),nativeCancellationSha256:sha(json(observation.nativeCancellation)),
      observedBytesCompared:true,excludesOnlyNewOrigin:observation.excludedNewOrigin})
    const expireAndCancel=async(selectedInput,selectedMaterial,selectedStore)=>{
      const selected=selectedMaterial.plan.operationId,shortIssuer=createIssuer(selectedStore,{...issuerConfig,ttlSeconds:2})
      const approval=await shortIssuer.issue(selected,selectedMaterial.planHash)
      assert.equal(approval.proof.expiresAt-approval.proof.issuedAt,2)
      const selectedExecution=(await selectedStore.readExecution(selected)).execution
      const waitMs=Math.max(0,approval.proof.expiresAt*1000-Date.now()+1100);assert.ok(waitMs<=3100,'Only actual bounded two-second approval expiry may be awaited')
      await new Promise(resolve=>setTimeout(resolve,waitMs));assert.ok(Math.floor(Date.now()/1000)>=approval.proof.expiresAt)
      expectedCancellations.add(selected)
      const before=rawState(),result=await new Coordinator(selectedStore,shortIssuer,native).cancelExpired(selected),after=rawState()
      assert.equal(result.state,'cancelled');assert.ok(freshCancellationResolutions.includes(selected));assert.ok(nativeCancellationOperations.includes(selected))
      assert.deepEqual(Object.keys(before.database).filter(table=>before.database[table]!==after.database[table]),['clawpilot_email_initial_enrollments'])
      assert.deepEqual(after.critical,before.critical)
      const control=(await q('SELECT enabled,active_initial_enrollment_id FROM crm_native_email_publication_control WHERE singleton')).rows[0]
      assert.equal(control.enabled,false);assert.equal(control.active_initial_enrollment_id,null)
      const sql=await sqlObservation(selected);assert.equal(sql.enrollment.state,'cancelled');assert.equal(sql.reservation.state,'cancelled')
      assert.equal(sql.enrollment.receipt_hash,result.receiptHash);assert.equal(sql.enrollment.approval_canonical,json(approval))
      cancelled.push({operationId:selected,planHash:selectedMaterial.planHash,sourceArtifactDigest:selectedInput.sourceArtifactDigest,
        approvalSha256:sha(json(approval)),cancellationReceiptHash:result.receiptHash,actualExpiry:{issuedAt:approval.proof.issuedAt,expiresAt:approval.proof.expiresAt,waitedMs:waitMs},
        lineage:selectedMaterial.plan.kind==='initial_enrollment_replan_v1'?selectedMaterial.plan.installationLineage:null})
      return {execution:selectedExecution,sql}
    }
    const cancelledA=await check('real two-second A approval expires without execution, native cancellation freshly resolves and PostgreSQL settles',()=>expireAndCancel(input,material,store))
    const originalRoot=rootObservation(),originalRootSql=cancelledA.sql
    for(const [path,bytes]of Object.entries(originalInstallerFiles))assert.deepEqual(originalRoot.files[path],bytes,
      'Original source/installer journal/binding changed while A expired/cancelled')
    const ancestorSnapshots=new Map([[rootOperationId,{native:originalRoot,sql:originalRootSql}]])
    const assertRootPreserved=async phase=>{
      const ancestors=[];for(const [selected,original]of ancestorSnapshots){const current=rootObservation(selected)
        assert.deepEqual(current,original.native,'Original ancestor source/input/installers/cancellation changed during '+phase)
        assert.deepEqual(await sqlObservation(selected),original.sql,'Actual SQL ancestor evidence changed during '+phase)
        ancestors.push({operationId:selected,...summarizeRoot(current)})}
      return {phase,ancestors}
    }
    replanEvidence={version:1,kind:'actual-expired-A-to-B-to-C-replan',rootOperationId,rootSourceArtifactDigest:rootSourceDigest,
      rootOriginal:summarizeRoot(originalRoot),rootPreservation:[],cancelled,contexts:[],contentMutation:null,delayedRootRefusals:[]}
    replanEvidence.originalInstallerFilesFrozenBeforeExpiry=Object.fromEntries(Object.entries(originalInstallerFiles).map(([path,row])=>[path,{sha256:row.sha256,size:row.size}]))
    replanEvidence.signedInputFrozenAfterActualCancellation=true
    const delayedRoot=async phase=>{
      const before=rawState(),receipt=await native.resolve(cancelledA.execution);assert.equal(receipt.state,'cancelled')
      await assert.rejects(native.execute(cancelledA.execution),error=>/initial_operation_cancelled/.test(String(error.stderr??error)))
      const after=rawState();assert.deepEqual(after.database,before.database,'Delayed cancelled A changed native tables')
      assert.deepEqual(after.critical,before.critical,'Delayed cancelled A changed critical files')
      replanEvidence.delayedRootRefusals.push({phase,historicalResolveState:receipt.state,executeRefused:true,
        beforeStateSha256:sha(stable(before)),afterStateSha256:sha(stable(after)),nativeTablesUnchanged:true})
      replanEvidence.rootPreservation.push(await assertRootPreserved(phase))
    }
    await check('one explicit content-only fixture update occurs after cancelled A and before B fresh capture',async()=>{
      appDataBudget('before-intentional-content-only-fixture-update')
      const before=rawState(),output=run('docker',['exec',names.app,'php','/fixture/native-initial-enrollment.php','joint-content-update','--initial-volume-app',rootOperationId])
      const mutation=JSON.parse(output),after=rawState(),changed=Object.keys(before.database).filter(table=>before.database[table]!==after.database[table])
      assert.equal(mutation.purpose,'joint-intentional-content-only-fixture-update');assert.equal(mutation.emailId,rootMaterial.plan.emails[0].before.nativeId)
      assert.equal(mutation.table,'emails_text');assert.equal(mutation.field,'description');assert.deepEqual(changed,['emails_text'])
      assert.deepEqual(after.critical,before.critical);assert.deepEqual(after.cache,before.cache);assert.deepEqual(after.stockAudit,before.stockAudit)
      assert.notEqual(mutation.before.description,mutation.after.description)
      assert.deepEqual({...mutation.after,description:mutation.before.description},mutation.before)
      audits.push({script:'/fixture/native-initial-enrollment.php',action:'intentional-fixture-content-only-update',tableCount:Object.keys(before.database).length,
        changedTables:changed,fixtureConstructionOnly:true,exactEmailId:mutation.emailId,exactField:mutation.field,changedRows:1,
        beforeStateHash:sha(stable(before)),afterStateHash:sha(stable(after)),criticalFilesUnchanged:true,cacheUnchanged:true})
      replanEvidence.contentMutation=mutation
      appDataBudget('after-intentional-content-only-fixture-update')
    })
    await check('cancelled A historical resolution and delayed execution do not replay its obsolete before content',()=>delayedRoot('after-content-edit-before-B'))
    for(const [index,label]of ['B','C'].entries()){
      const predecessor=index===0?rootOperationId:input.operationId,newOperation=sha('joint-replan-'+label+':'+id()),nextPreview=await initialStore.preview()
      await initialStore.reserve(newOperation,nextPreview.sourceFingerprint)
      const context=await initialStore.readReplanContext(newOperation,predecessor,rootSourceDigest)
      assert.equal(context.rootOperationId,rootOperationId);assert.equal(context.predecessorOperationId,predecessor);assert.equal(context.depth,index+1)
      assert.equal(context.previousLineageHash,index===0?null:sha(json(material.plan.installationLineage)))
      const nativeHistory=[...ancestorSnapshots.values()].map(({native})=>{const row=native.nativeCancellation
        return {operationId:row.operation_id,planHash:row.plan_hash,deltaFingerprint:row.delta_fingerprint,approvalHash:row.approval_hash,
          cancellationReceiptHash:sha(json(JSON.parse(row.receipt_json)))}}).sort((a,b)=>a.operationId.localeCompare(b.operationId))
      assert.equal(context.cancelledHistoryFingerprint,sha(json(nativeHistory)));assert.equal(context.depth,nativeHistory.length)
      const predecessorRow=ancestorSnapshots.get(predecessor).native.nativeCancellation
      assert.equal(context.predecessorPlanHash,predecessorRow.plan_hash);assert.equal(context.predecessorApprovalHash,predecessorRow.approval_hash)
      assert.equal(context.predecessorCancellationReceiptHash,sha(json(JSON.parse(predecessorRow.receipt_json))))
      replanEvidence.contexts.push({operationId:newOperation,label,...context,nativeFiveFieldHistory:nativeHistory})
      const nextCaptured=await check('actual reserved '+label+' installed-source capture independently verifies fresh content and full cancellation history',
        ()=>operator.captureReplanSource(newOperation,nextPreview.sourceFingerprint,context))
      native.retainSourceDigest(newOperation,nextCaptured.sourceArtifactDigest)
      const parsed=JSON.parse(nextCaptured.sourceBytes),original=JSON.parse(captured.sourceBytes)
      assert.equal(parsed.version,2);assert.equal(parsed.purpose,'clawpilot-native-email-initial-installed-source')
      assert.equal(parsed.installationContext.depth,index+1);assert.equal(parsed.emails.length,329);assert.deepEqual(parsed.principalSuiteCrmUserIds,original.principalSuiteCrmUserIds)
      assert.equal(parsed.nativePolicyFingerprint,original.nativePolicyFingerprint);assert.notEqual(parsed.nativeRuntimeFingerprint,original.nativeRuntimeFingerprint)
      const changed=parsed.emails.filter((row,i)=>row.recordFingerprint!==original.emails[i].recordFingerprint)
      assert.equal(changed.length,1);assert.equal(changed[0].nativeId,replanEvidence.contentMutation.emailId)
      for(const [i,row]of parsed.emails.entries())assert.deepEqual({...row,recordFingerprint:original.emails[i].recordFingerprint},original.emails[i],
        'Replan source changed something beyond the one explicit current content fingerprint')
      assert.equal(replanEvidence.contentMutation.originalRecordFingerprint,original.emails[0].recordFingerprint)
      replanEvidence.contexts.at(-1).freshSelectedRecordFingerprint=changed[0].recordFingerprint
      input={operationId:newOperation,appSourceFingerprint:nextPreview.sourceFingerprint,sourceArtifactDigest:nextCaptured.sourceArtifactDigest,
        preparedAt:new Date().toISOString().slice(0,19).replace('T',' ')}
      material=(await operator.prepareForReview(input)).material;assert.equal(material.plan.kind,'initial_enrollment_replan_v1')
      assert.equal(material.plan.installationLineage.rootOperationId,rootOperationId)
      assert.equal(material.plan.installationLineage.freshSourceArtifactDigest,nextCaptured.sourceArtifactDigest)
      assert.equal(material.plan.installationLineage.freshInstalledRuntimeFingerprint,parsed.nativeRuntimeFingerprint)
      store=reviewedStore(input,material)
      if(label==='B'){const retainedB=await check('real B expires and cancels so C must bind the exact second-level signed lineage',()=>expireAndCancel(input,material,store))
        ancestorSnapshots.set(newOperation,{native:rootObservation(newOperation),sql:retainedB.sql})}
      replanEvidence.rootPreservation.push(await assertRootPreserved('after-'+label+'-preparation'+(label==='B'?'-and-cancellation':'')))
    }
    activationOperationId=input.operationId;replanEvidence.effectiveOperationId=activationOperationId
    replanEvidence.effectiveLineageHash=sha(json(material.plan.installationLineage));replanEvidence.historyDepth=2
    verifyHistoricalRootAfterActivation=()=>delayedRoot('after-C-activation')
    verifyAncestorPreservation=async phase=>replanEvidence.rootPreservation.push(await assertRootPreserved(phase))
    issuer=createIssuer(store,issuerConfig);coordinator=new Coordinator(store,issuer,native)
  }
  const settled=await check('actual native COMMIT response loss is settled only by fresh native resolution and real PG activation',()=>coordinator.execute(activationOperationId,material.planHash))
  assert.equal(settled.state,'activated');assert.equal(nativeExecutionCount,1);assert.equal(nativeResolutionBeforePgActivation,true)
  const terminal=(await q('SELECT state,receipt_hash FROM crm_native_email_initial_enrollments WHERE operation_id=$1',[activationOperationId])).rows[0]
  assert.equal(terminal.state,'activated');assert.equal(terminal.receipt_hash,settled.receiptHash)
  const control=(await q('SELECT enabled,active_initial_enrollment_id FROM crm_native_email_publication_control WHERE singleton')).rows[0]
  assert.equal(control.enabled,true);assert.equal(control.active_initial_enrollment_id,null)
  const beforeResume=commandLog.length;assert.deepEqual(await coordinator.resume(activationOperationId),settled);assert.equal(commandLog.length,beforeResume)
  const execution=(await store.readExecution(activationOperationId)).execution,receipt=await native.resolve(execution);assert.equal(receipt.state,'committed')
  if(verifyHistoricalRootAfterActivation)await check('delayed expired A remains cancelled and zero-mutation after C actual activation',verifyHistoricalRootAfterActivation)
  await check('actual committed SQL origin is signed after COMMIT and published as exact protected native certificate bytes',async()=>{
    assert.equal(await native.originStatus(activationOperationId),null)
    const origin=await createOriginIssuer(transaction,selection,issuerConfig).issue(activationOperationId,material.planHash)
    assert.equal(origin.proof.identities.length,329);assert.equal(origin.proof.pipelines.length,3)
    assert.equal(origin.proof.version,options.replanAfterExpiry?2:1)
    if(options.replanAfterExpiry){assert.equal(origin.proof.installationRootOperationId,operationId)
      assert.equal(origin.proof.installationLineageHash,replanEvidence.effectiveLineageHash);replanEvidence.originProof=origin.proof}
    const published=await native.publishOrigin(origin);assert.equal(published.operationId,activationOperationId)
    assert.deepEqual(await native.publishOrigin(origin),published)
    const actual=run('docker',['exec',names.app,'php','-r','fwrite(STDOUT,file_get_contents($argv[1]));',nativePaths.state+'/activation-origin.json'])
    assert.equal(actual,json(origin));assert.equal(sha(actual),published.originSha256)
    assert.equal(await native.originStatus(activationOperationId),published.originSha256)
    assert.equal(await native.readOrigin(activationOperationId,published.originSha256),json(origin))
  })
  if(verifyAncestorPreservation)await verifyAncestorPreservation('after-C-origin-publication')
  const startupComponent=await check('fresh PHP verifies actual SQL-issued origin and completes the full current native startup inspection',async()=>{
    const before=rawState();let output,failure
    const componentEnv=nativeEnv.filter(value=>!value.startsWith('CLAWPILOT_NATIVE_INITIAL_MAINTENANCE='))
      .concat(['CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=0','CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED=1','CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED=1'])
    try{output=run('docker',['exec',...componentEnv.flatMap(x=>['--env',x]),names.app,'php','-d','memory_limit=384M','/joint-startup.php'],{timeout:45000})}
    catch(error){failure=error}
    const after=rawState(),changed=Object.keys(before.database).filter(table=>before.database[table]!==after.database[table])
    const audit={script:'/joint-startup.php',action:'inspect-current-startup-component',commandSucceeded:!failure,
      tableCount:Object.keys(before.database).length,changedTables:changed,beforeStateHash:sha(JSON.stringify(before)),afterStateHash:sha(JSON.stringify(after)),
      criticalFilesUnchanged:JSON.stringify(before.critical)===JSON.stringify(after.critical),
      ...auditNativeInitialColdCache(before.cache,after.cache,before.stockAudit,after.stockAudit)}
    audits.push(audit);commandLog.push({script:'/joint-startup.php',action:'inspect-current-startup-component'})
    assert.deepEqual(after.database,before.database,'Current startup component changed native tables')
    assert.deepEqual(after.critical,before.critical,'Current startup component changed critical files')
    if(failure)throw failure
    const result=JSON.parse(output);assert.equal(result.kind,'native-current-startup-component')
    assert.equal(result.actualCurrentNativeInspectionCompleted,true);assert.equal(result.nativeTransactionRolledBack,true)
    assert.equal(result.emailCount,329);assert.equal(result.pipelineCount,3);assert.equal(result.principalCount,4)
    assert.equal(result.originVersion,options.replanAfterExpiry?2:1)
    assert.equal(result.apacheWrapperProven,false);assert.equal(result.fullImageProven,false);return result
  })
  if(verifyAncestorPreservation)await verifyAncestorPreservation('after-C-current-startup-component')
  let serviceStartup=null
  if(options.serviceImage){
    serviceStartup=await check('immutable service image completes enrolled entrypoint and a true second-container restart on the same owned app data',async()=>{
      const fileState=()=>JSON.parse(run('docker',['exec',names.app,'php','-d','memory_limit=384M','/joint-startup.php','--service-files'],{timeout:45000,maxBuffer:24000000}))
      const processState=()=>JSON.parse(run('docker',['exec',names.app,'php','/joint-startup.php','--service-processes']))
      const phases=[],certificateBefore=run('docker',['exec',names.app,'php','-r','fwrite(STDOUT,hash_file("sha256",$argv[1]));',nativePaths.state+'/activation-origin.json'])
      const entrypointEnvironment=nativeEnv.filter(value=>!value.startsWith('CLAWPILOT_NATIVE_INITIAL_MAINTENANCE='))
        .concat(['CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=0','CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED=1','CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED=1',
          'CLAWPILOT_NATIVE_INITIAL_FIXTURE=1','PORT=8080'])
      const expectedBody=readFileSync(join(source,'native-email-liveness.json'),'utf8')
      assert.deepEqual(JSON.parse(expectedBody),{service:'suitecrm',mode:'normal',live:true,ready:null})
      for(const phase of ['enrolled-first-container','enrolled-second-container-restart']){
        appDataBudget('before-'+phase);const before=rawState(),filesBefore=fileState(),volumeBefore=ownedVolume()
        assert.ok(volumeBefore);observeStorage('before-'+phase)
        assert.equal(runStorageGuard({argv:['--preflight'],environment:env}),0)
        removeSecondary(names.app);assert.equal(inspect(names.app),null);assert.deepEqual(ownedVolume(),volumeBefore)
        // No entrypoint override, extra command or source overlay is present.
        // This is the actual configured service-image ENTRYPOINT as PID1.
        run('docker',['run','--rm','--detach','--pull=never','--platform=linux/amd64','--name',names.app,'--network',names.net,'--read-only',
          ...limits('1152m','1'),'--cap-drop=ALL','--cap-add=SETUID','--cap-add=SETGID','--security-opt=no-new-privileges',
          ...appDataMount,'--tmpfs','/tmp:rw,nosuid,size=32m','--tmpfs','/run/apache2:rw,nosuid,nodev,noexec,size=4m,mode=0755',
          '--tmpfs','/run/lock/apache2:rw,nosuid,nodev,noexec,size=1m,mode=0755',...fixtureMounts,
          ...entrypointEnvironment.flatMap(value=>['--env',value]),php.Id])
        const started=inspect(names.app);assert.ok(started?.State.Running);validateMounts(started)
        assert.equal(started.Image,options.serviceImage);assert.deepEqual(started.Config.Entrypoint,['/usr/local/bin/entrypoint.sh'])
        assert.equal(started.HostConfig.ReadonlyRootfs,true);assert.equal(Object.keys(started.HostConfig.PortBindings??{}).length,0)
        assert.ok(started.Mounts.every(m=>!['/opt/clawpilot','/usr/local/bin/entrypoint.sh','/etc/apache2/ports.conf',
          '/etc/apache2/sites-available/000-default.conf'].some(path=>m.Destination===path||path.startsWith(m.Destination+'/'))),'Image entrypoint/config overlay refused')
        assert.ok(!appContainerHistory.some(row=>row.id===started.Id),'Restart must use a genuinely new container instance')
        appContainerHistory.push({phase,id:started.Id})
        let response,ready=false;const readyUntil=Date.now()+45000
        for(;;){try{response=run('docker',['exec',names.app,'curl','--silent','--show-error','--fail','--max-time','2','--include',
          'http://127.0.0.1:8080/_clawpilot/liveness'],{timeout:3000});ready=true;break}catch(error){
          const current=inspect(names.app)
          if(!current?.State.Running)throw Error('Actual enrolled entrypoint exited before Apache liveness: '+(current?run('docker',['logs',current.Id]):'owned --rm container is absent'))
          if(Date.now()>readyUntil)throw error;await new Promise(resolve=>setTimeout(resolve,250))}}
        assert.equal(ready,true)
        const boundary=response.indexOf('\r\n\r\n');assert.ok(boundary>0)
        const headers=response.slice(0,boundary),body=response.slice(boundary+4)
        assert.match(headers,/^HTTP\/1\.[01] 200 /);assert.match(headers,/\r\nCache-Control: no-store\r?\n/i)
        assert.match(headers,/\r\nX-Content-Type-Options: nosniff\r?\n/i);assert.equal(body,expectedBody)
        assert.throws(()=>run('docker',['exec',names.app,'curl','--silent','--fail','--max-time','2','http://127.0.0.1:80/_clawpilot/liveness'],{timeout:3000}),
          'Inherited image EXPOSE80 must not become an actual listener')
        const processes=processState();assert.deepEqual(processes.forbidden,[])
        const master=processes.apache.filter(process=>process.pid===1&&process.uid===0);assert.equal(master.length,1,'Apache must be actual container PID1')
        assert.ok(processes.apache.some(process=>process.parentPid===1&&process.uid===33),'Actual www-data Apache child required')
        const after=rawState(),filesAfter=fileState(),changedTables=Object.keys(before.database).filter(table=>before.database[table]!==after.database[table])
        const changedFiles=[...new Set([...Object.keys(filesBefore),...Object.keys(filesAfter)])].filter(path=>JSON.stringify(filesBefore[path])!==JSON.stringify(filesAfter[path]))
        const permitted=['app/public/legacy/cache/modules/Audit','app/public/legacy/cache/modules/Audit/Auditvardefs.php']
        const cache=auditNativeInitialColdCache(before.cache,after.cache,before.stockAudit,after.stockAudit)
        const audit={script:'/usr/local/bin/entrypoint.sh',action:phase,commandSucceeded:true,tableCount:Object.keys(before.database).length,
          changedTables,beforeStateHash:sha(JSON.stringify(before)),afterStateHash:sha(JSON.stringify(after)),
          criticalFilesUnchanged:JSON.stringify(before.critical)===JSON.stringify(after.critical),fileCount:Object.keys(filesBefore).length,
          beforeFilesHash:sha(JSON.stringify(filesBefore)),afterFilesHash:sha(JSON.stringify(filesAfter)),changedFiles,
          fileDifferences:changedFiles.map(path=>({path,before:filesBefore[path]??null,after:filesAfter[path]??null})),...cache}
        audits.push(audit);commandLog.push({script:'/usr/local/bin/entrypoint.sh',action:phase})
        assert.deepEqual(after.database,before.database,'Actual enrolled startup/restart changed native tables')
        assert.deepEqual(after.critical,before.critical,'Actual enrolled startup/restart changed critical files')
        assert.deepEqual(Object.keys(filesAfter),Object.keys(filesBefore),'Actual enrolled startup/restart added or removed native paths')
        assert.ok(changedFiles.every(path=>permitted.includes(path)),'Actual enrolled startup/restart changed an unreviewed native file: '+changedFiles.join(','))
        assert.equal(run('docker',['exec',names.app,'php','-r','fwrite(STDOUT,hash_file("sha256",$argv[1]));',nativePaths.state+'/activation-origin.json']),certificateBefore)
        appDataBudget('after-'+phase);observeStorage('after-'+phase)
        phases.push({phase,containerId:started.Id,actualConfiguredEntrypoint:true,apachePid1:true,apacheProcesses:processes.apache,
          backgroundWorkersOff:true,httpPort:8080,httpLiveness:true,httpBody:JSON.parse(body),httpProvesAppReadiness:false,
          actualCurrentNativeInspectionCompletedBeforeApache:true,volumeName:volumeBefore.Name,auditIndex:audits.length-1})
      }
      assert.equal(phases.length,2);assert.notEqual(phases[0].containerId,phases[1].containerId)
      return{version:1,kind:'actual-full-service-image-enrolled-entrypoint-and-container-restart',passed:true,image:imageProof,
        restartMethod:'remove-recreate-distinct-container-retaining-exact-owned-named-volume',phases,
        actualConfiguredEntrypoint:true,apacheWrapperProven:true,fullImageProven:true,trueContainerRestartProven:true,
        currentNativeInspectionProven:true,backgroundWorkersOff:true,railwaySshProven:false,productionTouched:false}
    })
  }
  if(verifyAncestorPreservation){await verifyAncestorPreservation('after-C-two-real-service-container-starts')
    const columns=['operationId','state','planHash','approvalHash','deltaFingerprint','receiptHash']
    replanEvidence.nativeTerminalInventory=sql('SELECT operation_id,state,plan_hash,approval_hash,delta_fingerprint,SHA2(receipt_json,256) FROM clawpilot_email_initial_enrollments ORDER BY operation_id')
      .trim().split('\n').map(line=>Object.fromEntries(line.split('\t').map((value,index)=>[columns[index],value])))
    assert.equal(replanEvidence.nativeTerminalInventory.length,3)
    assert.equal(replanEvidence.nativeTerminalInventory.filter(row=>row.state==='cancelled').length,2)
    assert.deepEqual(replanEvidence.nativeTerminalInventory.filter(row=>row.state==='committed').map(row=>row.operationId),[activationOperationId])
    replanEvidence.sqlTerminalInventory=(await q('SELECT operation_id,state,plan_hash,receipt_hash FROM crm_native_email_initial_enrollments ORDER BY operation_id')).rows
    assert.equal(replanEvidence.sqlTerminalInventory.length,3);assert.equal(replanEvidence.sqlTerminalInventory.filter(row=>row.state==='cancelled').length,2)
    assert.deepEqual(replanEvidence.sqlTerminalInventory.filter(row=>row.state==='activated').map(row=>row.operation_id),[activationOperationId])
  }
  for(const [p,h]of Object.entries(sourceHashes))assert.equal(sha(readFileSync(p)),h,'Consumed source changed: '+p)
  checkBuild()
  report={version:1,kind:'actual-local-native-initial-joint-rehearsal',passed:true,postgresMajor:Number(options.major),sourceZipSha256:ZIP_SHA,resourceOwner:owner,resourceNames:names,
    sourceHashes,buildManifestSha256:sha(readFileSync(join(build,'build-manifest.json'))),checks,audits,commandLog,storagePhases,startupComponent,
    serviceStartup,imageProof,appDataBudgets,appContainerHistory,replanEvidence,
    emailCount:329,principalCount:4,pipelineCount:3,actualPgReservation:true,actualSqlAuthorityCollector:true,actualNativeCli:true,
    actualNativeForecasts:true,actualDurableRsaApproval:true,actualNativeCommit:true,actualFreshNativeResolve:true,actualPgActivation:true,
    lostActualNativeCommitResponseRecovered:true,nativeExecuteCount:nativeExecutionCount,actualSqlOriginSignedAndPublished:true,actualCurrentNativeStartupInspection:true,
    fixtureDataSynthetic:true,nativeResponsesSynthetic:false,railwaySshProven:false,fullImageProven:!!serviceStartup,enrolledStartupProven:!!serviceStartup,
    productionTouched:false,reviewedResources:{pg:{tmpfs:'512m',memory:'768m',cpus:'0.5'},maria:{memory:'640m',cpus:'0.5'},
      php:{memory:'1152m',cpus:'1',...(options.serviceImage?{appDataNamedVolume:true,appDataObservedBudgetBytes:640*1024*1024,appDataHardQuota:false,apacheRunTmpfs:'4m',apacheLockTmpfs:'1m'}:{appDataTmpfs:'640m'})}},capturedAt:new Date().toISOString()}
  writeFileSync(options.output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})
  console.log('PASS joint actual local PG/native enrollment; service-image/entrypoint proof='+!!serviceStartup+'; no synthetic native response, Railway or production proof')
  }
}catch(error){
  writeFileSync(options.output.replace(/\.json$/,'.failed.json'),JSON.stringify({version:1,failed:true,resourceOwner:owner,resourceNames:names,sourceHashes,checks,audits,commandLog,storagePhases,
    imageProof,appDataBudgets,appContainerHistory,replanEvidence,
    error:String(error.stack??error),stdout:String(error.stdout??''),stderr:String(error.stderr??''),productionTouched:false},null,2)+'\n',{flag:'wx',mode:0o600});throw error
}finally{try{if(pool)await pool.end()}finally{cleanup()}}
