#!/usr/bin/env node
// Actual local PG + native MariaDB + emitted application operator. The seeded
// data and the local Docker command adapter are fixtures; native source,
// forecasts, signatures, execution, fresh resolution and PG settlement are NOT
// synthetic JSON ports. Service-image/entrypoint proof is opt-in and explicit;
// neither path certifies Railway SSH, signed-in application UI or production.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {execFileSync,spawnSync} from 'node:child_process'
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
const MEETING_SCALAR_COLUMNS=Object.freeze(['name','description','date_start','date_end','duration_hours','duration_minutes',
  'location','status','parent_id','parent_type','date_modified','modified_user_id'])
const MEETING_EMPTY_RELATE_IDS=Object.freeze(['assigned_user_id','repeat_parent_id'])
const MEETING_EMPTY_CUSTOM_STRINGS=Object.freeze(['jjwg_maps_address_c','jjwg_maps_geocode_status_c'])
function assertNativeMeetingScalarRow(before,after,{attributes={},write=false}={}){
  assert.ok(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after))
  assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort(),'Native Meeting row schema/identity shape changed')
  const comparableBefore={...before},normalized=[]
  for(const field of MEETING_EMPTY_RELATE_IDS)if(before[field]!==after[field]){
    // Pinned stock SugarBean::populateFromRow plus DBManager::updateSQL maps
    // unset SQLNULL id/dbType=id fields to ''. This is NOT permission to clear
    // a real ID, reverse the normalization, or explicitly send an ID edit.
    assert.ok(write&&before[field]===null&&after[field]===''&&!Object.hasOwn(attributes,field),
      'Unreviewed native empty relate-ID transition: '+field)
    comparableBefore[field]='';normalized.push(field)
  }
  const withoutScalars=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!MEETING_SCALAR_COLUMNS.includes(key)))
  assert.deepEqual(withoutScalars(after),withoutScalars(comparableBefore),'Scalar edit changed an unrelated Meeting column')
  return normalized
}
function assertNativeMeetingCustomRow(before,after,{attributes={},write=false}={}){
  assert.ok(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after))
  assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort(),'Native Meeting custom row schema/identity shape changed')
  const comparableBefore={...before},normalized=[]
  for(const field of MEETING_EMPTY_CUSTOM_STRINGS)if(before[field]!==after[field]){
    // Stock hydration maps SQLNULL to ''; DynamicField::save persists these
    // two nullable GoogleMaps varchar fields even when absent the API request.
    // No real content clear, reverse transition, coordinate or ID edit allowed.
    assert.ok(write&&before[field]===null&&after[field]===''&&!Object.hasOwn(attributes,field),
      'Unreviewed native empty custom-string transition: '+field)
    comparableBefore[field]='';normalized.push(field)
  }
  assert.deepEqual(after,comparableBefore,'Scalar edit changed an unrelated Meeting custom column')
  return normalized
}
if(process.argv.length===3&&process.argv[2]==='--meeting-empty-relate-id-self-test'){
  const base={id:'selected-meeting',assigned_user_id:null,repeat_parent_id:null,created_by:'actor',name:'before',outlook_id:null}
  const accepted=[],rejected=[]
  for(const fields of [[],['assigned_user_id'],['repeat_parent_id'],[...MEETING_EMPTY_RELATE_IDS]]){
    const before=structuredClone(base),after={...before,name:'after'};for(const field of fields)after[field]=''
    assert.deepEqual(assertNativeMeetingScalarRow(before,after,{write:true,attributes:{name:'after'}}),fields)
    assert.deepEqual(before,base,'Audit comparison mutated the original row');accepted.push(fields)
  }
  for(const field of MEETING_EMPTY_RELATE_IDS){
    for(const [from,to]of [['real-id',''],['real-id','other-id'],[null,'real-id'],['',null],['','real-id'],[null,' '],[null,0],[0,'']]){
      assert.throws(()=>assertNativeMeetingScalarRow({...base,[field]:from},{...base,[field]:to},{write:true}))
      rejected.push({field,from,to})
    }
    assert.throws(()=>assertNativeMeetingScalarRow(base,{...base,[field]:''},{write:true,attributes:{[field]:''}}));rejected.push({field,explicit:true})
    assert.throws(()=>assertNativeMeetingScalarRow(base,{...base,[field]:''},{write:false}));rejected.push({field,readOnly:true})
  }
  assert.throws(()=>assertNativeMeetingScalarRow(base,{...base,outlook_id:''},{write:true}));rejected.push({unrelatedNull:true})
  assert.throws(()=>assertNativeMeetingScalarRow(base,{...base,created_by:'other'},{write:true}));rejected.push({ownership:true})
  const absent={...base};delete absent.repeat_parent_id
  assert.throws(()=>assertNativeMeetingScalarRow(absent,{...base,repeat_parent_id:''},{write:true}));rejected.push({missingColumn:true})
  const customBase={id_c:'selected-meeting',global_id_c:'gm1234567',jjwg_maps_address_c:null,
    jjwg_maps_geocode_status_c:null,jjwg_maps_lat_c:'0.00000000',jjwg_maps_lng_c:'0.00000000',unrelated_custom_c:null}
  const customAccepted=[],customRejected=[]
  for(const fields of [[],['jjwg_maps_address_c'],['jjwg_maps_geocode_status_c'],[...MEETING_EMPTY_CUSTOM_STRINGS]]){
    const before=structuredClone(customBase),after={...before};for(const field of fields)after[field]=''
    assert.deepEqual(assertNativeMeetingCustomRow(before,after,{write:true,attributes:{name:'after'}}),fields)
    assert.deepEqual(before,customBase,'Custom audit comparison mutated the original row');customAccepted.push(fields)
  }
  for(const field of MEETING_EMPTY_CUSTOM_STRINGS){
    for(const [from,to]of [['real-content',''],['real-content','changed'],[null,'real-content'],['',null],['','real-content'],[null,' '],[null,0],[0,'']]){
      assert.throws(()=>assertNativeMeetingCustomRow({...customBase,[field]:from},{...customBase,[field]:to},{write:true}))
      customRejected.push({field,from,to})
    }
    assert.throws(()=>assertNativeMeetingCustomRow(customBase,{...customBase,[field]:''},{write:true,attributes:{[field]:''}}));customRejected.push({field,explicit:true})
    assert.throws(()=>assertNativeMeetingCustomRow(customBase,{...customBase,[field]:''},{write:false}));customRejected.push({field,readOnly:true})
  }
  for(const field of ['id_c','global_id_c','jjwg_maps_lat_c','jjwg_maps_lng_c','unrelated_custom_c']){
    assert.throws(()=>assertNativeMeetingCustomRow(customBase,{...customBase,[field]:''},{write:true}));customRejected.push({protectedField:field})
  }
  const customAbsent={...customBase};delete customAbsent.jjwg_maps_address_c
  assert.throws(()=>assertNativeMeetingCustomRow(customAbsent,{...customBase,jjwg_maps_address_c:''},{write:true}));customRejected.push({missingColumn:true})
  console.log(JSON.stringify({kind:'pure-native-meeting-empty-relate-id-audit',passed:true,accepted:accepted.length,rejected:rejected.length,
    exactFields:MEETING_EMPTY_RELATE_IDS,customStrings:{accepted:customAccepted.length,rejected:customRejected.length,exactFields:MEETING_EMPTY_CUSTOM_STRINGS},
    directional:'SQLNULL-to-empty-only-when-not-sent',databaseCreated:false,nativeHttpExecuted:false}))
  process.exit(0)
}
const options={major:'16'}
for(const arg of process.argv.slice(2)){
  if(/^--(?:source-zip|build|output)=\//.test(arg)){const at=arg.indexOf('=');const key=arg.slice(2,at);assert.equal(options[key],undefined);options[key]=arg.slice(at+1)}
  else if(/^--postgres-major=(16|18)$/.test(arg))options.major=arg.split('=')[1]
  else if(/^--service-image=sha256:[a-f0-9]{64}$/.test(arg)){assert.equal(options.serviceImage,undefined);options.serviceImage=arg.slice('--service-image='.length)}
  else if(arg==='--replan-after-expiry'){assert.equal(options.replanAfterExpiry,undefined);options.replanAfterExpiry=true}
  else if(arg==='--with-record-lifecycle'){assert.equal(options.withRecordLifecycle,undefined);options.withRecordLifecycle=true}
  else if(arg==='--with-meeting-roundtrip'){assert.equal(options.withMeetingRoundtrip,undefined);options.withMeetingRoundtrip=true}
  else if(arg==='--with-legacy-recovery'){assert.equal(options.withLegacyRecovery,undefined);options.withLegacyRecovery=true}
  else if(arg==='--with-held-original-recovery'){assert.equal(options.withHeldOriginalRecovery,undefined);options.withHeldOriginalRecovery=true}
  else if(arg==='--with-legacy-account-repair'){assert.equal(options.withLegacyAccountRepair,undefined);options.withLegacyAccountRepair=true}
  else if(arg==='--with-private-maintenance-dispatch'){assert.equal(options.withPrivateMaintenanceDispatch,undefined);options.withPrivateMaintenanceDispatch=true}
  else if(arg==='--with-scoped-recovery-postgres'){assert.equal(options.withScopedRecoveryPostgres,undefined);options.withScopedRecoveryPostgres=true}
  else if(arg==='--with-unmanaged-app-only'){assert.equal(options.withUnmanagedAppOnly,undefined);options.withUnmanagedAppOnly=true}
  else if(arg==='--zip-preflight-only'){assert.equal(options.zipPreflightOnly,undefined);options.zipPreflightOnly=true}
  else throw Error('Use --source-zip=/absolute/SuiteCRM-8.10.1.zip --build=/absolute/emitted-build --output=/absolute/new.json [--postgres-major=16|18] [--zip-preflight-only] [--service-image=sha256:immutable-image-id] [--replan-after-expiry] [--with-record-lifecycle] [--with-meeting-roundtrip] [--with-legacy-recovery|--with-held-original-recovery] [--with-legacy-account-repair] [--with-private-maintenance-dispatch] [--with-scoped-recovery-postgres] [--with-unmanaged-app-only]')
}
if(options.withHeldOriginalRecovery){
  assert.ok(!options.withLegacyRecovery&&!options.withLegacyAccountRepair&&options.withPrivateMaintenanceDispatch&&options.withScopedRecoveryPostgres,
    'The same-original run is isolated and requires private maintenance plus scoped PostgreSQL roles')
  options.withLegacyRecovery=true
}
assert.ok(!(options.serviceImage&&options.zipPreflightOnly),'Archive-only preflight does not exercise the service image')
assert.ok(!options.replanAfterExpiry||options.serviceImage,'Expiry/replan proof requires the actual service image and true container restart')
assert.ok(!options.withRecordLifecycle||options.serviceImage,'Authenticated record lifecycle proof requires the actual service image')
assert.ok(!options.withMeetingRoundtrip||options.withRecordLifecycle&&options.serviceImage,'Meeting roundtrip requires lifecycle OAuth and the actual service image')
assert.ok(!options.withLegacyRecovery||options.withRecordLifecycle&&options.serviceImage,'Legacy recovery requires lifecycle OAuth and the actual service image')
assert.ok(!options.withLegacyAccountRepair||options.withLegacyRecovery,'Account repair requires the isolated legacy recovery scenario')
assert.ok(!options.withPrivateMaintenanceDispatch||options.withLegacyRecovery&&!options.withMeetingRoundtrip,
  'Private maintenance dispatch requires the isolated legacy recovery scenario')
assert.ok(!options.withScopedRecoveryPostgres||options.withPrivateMaintenanceDispatch,
  'Scoped PostgreSQL recovery requires private maintenance dispatch')
assert.ok(!options.withUnmanagedAppOnly||options.serviceImage,'Unmanaged app-only acceptance requires the actual native service image')
if(options.withMeetingRoundtrip)assert.equal(process.env.TZ,'UTC','Launch the opt-in native meeting fixture with explicit TZ=UTC; do not rewrite native API dates')
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
const {createNativeEmailInitialOperatorTransaction:createPinnedTransaction}=compiled(join(build,manifest.entry))
const {NativeEmailInitialEnrollmentCoordinator:Coordinator}=fromBuild('nativeEmailInitialEnrollmentCoordinator')
const {createNativeEmailInitialApprovalIssuer:createIssuer}=fromBuild('nativeEmailInitialEnrollmentApproval')
const {createNativeEmailInitialStartupOriginIssuer:createOriginIssuer}=fromBuild('nativeEmailInitialStartupOrigin')
const {nativeEmailCanonicalJson:json}=fromBuild('nativeEmailPublication')
const source=resolve('services/suitecrm'),fixture=resolve('scripts/fixtures/native-email-audience-real'),startupFixture=resolve('scripts/fixtures/native-email-initial-joint-startup.php')
const meetingModule=options.withMeetingRoundtrip?await import('./lib/native-joint-meeting-roundtrip.mjs'):null
const legacyRecoveryModule=options.withLegacyRecovery?await import('./lib/native-joint-legacy-email-recovery.mjs'):null
const heldRecoveryModule=options.withHeldOriginalRecovery?await import('./lib/native-joint-held-original-recovery.mjs'):null
if(meetingModule){assert.equal(typeof meetingModule.runNativeJointMeetingRoundtrip,'function')
  assert.equal(typeof meetingModule.prepareNativeJointMeetingFixture,'function')
  assert.ok(Array.isArray(meetingModule.MEETING_ROUNDTRIP_SOURCE_PATHS)&&meetingModule.MEETING_ROUNDTRIP_SOURCE_PATHS.length>0)
  for(const path of meetingModule.MEETING_ROUNDTRIP_SOURCE_PATHS){assert.match(path,/^(?:app_src|scripts)\/[A-Za-z0-9_./-]+$/)
    assert.ok(path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'Exact repository-owned meeting source paths required')}}
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
  'native-email-maintenance.py','native-email-liveness.json','native-email-recovery-cli.php','install-record-lifecycle.php','bootstrap-image-principals.php'])imageSourceMap[join(source,name)]='/opt/clawpilot/'+name
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
  ...(options.serviceImage?[join(source,'Dockerfile'),...Object.keys(imageSourceMap)]:[]),
  ...(meetingModule?[resolve('scripts/lib/native-joint-meeting-roundtrip.mjs'),...meetingModule.MEETING_ROUNDTRIP_SOURCE_PATHS.map(path=>resolve(path))]:[]),
  ...(legacyRecoveryModule?legacyRecoveryModule.nativeJointLegacyEmailRecoverySources().map(path=>resolve(path)):[]),
  ...(heldRecoveryModule?heldRecoveryModule.HELD_ORIGINAL_FIXTURE_SOURCES.map(path=>resolve(path)):[])]
const sourceHashes=Object.fromEntries(candidates.map(p=>[p,sha(readFileSync(p))]))
const root=realpathSync(mkdtempSync(join(tmpdir(),'clawpilot-initial-joint.'))),owner=id(),label='com.clawpilot.native-initial-joint'
writeFileSync(join(root,'owner.json'),JSON.stringify({owner,pid:process.pid})+'\n',{flag:'wx',mode:0o600})
const suffix=owner.slice(0,8),names={pg:'cp-initial-joint-'+suffix+'-pg',maria:'cp-initial-joint-'+suffix+'-maria',app:'cp-initial-joint-'+suffix+'-app',
  net:'cp-initial-joint-'+suffix+'-native-net',pgnet:'cp-initial-joint-'+suffix+'-pg-net',...(options.serviceImage?{appdata:'cp-initial-joint-'+suffix+'-app-data'}:{})}
const deadline=Date.now()+600000,audits=[],checks=[],commandLog=[],storagePhases=[],appDataBudgets=[],appContainerHistory=[]
let pool,token,secondaryClean=false,cleanupMode=false,cleaned=false,activeTransactions=0,report,imageProof,primaryCleanupAttempted=false,replanEvidence=null
let meetingRoundtrip=null
let legacyRecovery=null
let meetingFixtureSeeds=null
let unmanagedAppOnly=null
const meetingPrivateValues=[]
const redactMeetingSecrets=value=>{let result=String(value??'');for(const secret of meetingPrivateValues)if(secret.length>=24)result=result.replaceAll(secret,'[private-synthetic-fixture-value]');return result}
const recordLifecycle=options.withRecordLifecycle?{version:1,kind:'actual-joint-record-lifecycle',fixtureDataSynthetic:true,
  oauthMiddlewareSynthetic:false,endpointResponsesSynthetic:false,enabledBeforeRootSource:true,setup:[],httpPhases:[]}:null
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
  const databaseIdentity=(await q(`SELECT c.system_identifier::pg_catalog.text AS "systemIdentifier",
    d.oid::pg_catalog.text AS "databaseOid",SESSION_USER::pg_catalog.text AS "sessionRole",
    CURRENT_USER::pg_catalog.text AS "effectiveRole"
    FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() c
    WHERE d.datname=pg_catalog.current_database()`)).rows[0]
  const pinnedTransaction=createPinnedTransaction(pool,'initial_joint_fixture',databaseIdentity)
  const transaction=async fn=>{activeTransactions++;try{return await pinnedTransaction(fn)}finally{activeTransactions--}}
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
    ...(options.withPrivateMaintenanceDispatch?['--performance-schema=ON','--performance-schema-consumer-events-statements-history-long=ON',
      '--performance-schema-events-statements-history-long-size=256']:['--performance-schema=OFF']),
    '--character-set-server=utf8mb3','--collation-server=utf8mb3_general_ci'])
  const fixtureSql=text=>run('docker',['exec','--env','MYSQL_PWD=Synthetic-native-db-password-only',names.maria,'mariadb','--protocol=TCP','--host=127.0.0.1',
    '--user=fixture','--database=suitecrm_native_test','--batch','--skip-column-names','--execute='+text])
  let sql=fixtureSql
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
    '--env','CLAWPILOT_NATIVE_INITIAL_FIXTURE=1','--env','CLAWPILOT_NATIVE_INITIAL_FIXTURE_EMAILS=329',
    ...(options.withRecordLifecycle?['--env','CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=1']:[]),
    ...(options.withMeetingRoundtrip?['--env','CLAWPILOT_NATIVE_JOINT_MEETING_ROUNDTRIP=1']:[]),'--entrypoint','/bin/sh',php.Id,'-c',bootstrap])
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
  const lifecycleFixture=(mode,{user,timeout=45000}={})=>JSON.parse(run('docker',['exec',...(user?['--user',user]:[]),names.app,
    'php','-d','memory_limit=384M','-d','display_errors=0','/fixture/native-joint-lifecycle.php',mode],{timeout}))
  appDataBudget('before-synthetic-source-construction')
  if(options.withRecordLifecycle){
    // Exact synthetic OAuth setup is fixture construction, before RootA source
    // capture or any approved installer packet. No recursive chmod/chown or
    // added container capability is used. Stock CryptKey admits mode0640.
    recordLifecycle.setup.push(lifecycleFixture('prepare-directory'))
    recordLifecycle.setup.push(lifecycleFixture('prepare-keys',{user:'33:0'}))
    recordLifecycle.setup.push(lifecycleFixture('finalize-keys'))
  }
  stage('source');const observed=readNative('/tmp/clawpilot-initial-source.json');appDataBudget('after-synthetic-source-construction')
  if(options.withRecordLifecycle){recordLifecycle.fixture=lifecycleFixture('metadata')
    assert.equal(recordLifecycle.fixture.warmup.actualTokenIssuedBeforeRootSource,true)
    assert.equal(recordLifecycle.fixture.warmup.temporaryRouterStopped,true)
    assert.deepEqual(recordLifecycle.fixture.records.map(row=>row.module),['Accounts','Contacts'])}
  assert.equal(observed.source.emails.length,329);assert.equal(observed.source.principalSuiteCrmUserIds.length,4)
  const selection={actorEmail:'joint.owner@example.invalid',operatorAccountId:id(),rootWorkspaceId:id(),nativeInstanceId:'native-initial-fixture'}
  const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),publicKey=keys.publicKey.export({type:'spki',format:'pem'}),keyId='initial-joint-fixture-key'
  const nativeEnv=['CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=1','SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID='+keyId,
    'SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID='+selection.nativeInstanceId,'SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='+publicKey,
    'SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID='+observed.serviceUserId,'SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='+observed.oauthClientId,
    ...(options.withRecordLifecycle?['CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=1','SUITECRM_CLIENT_ID='+observed.oauthClientId]:[]),
    ...(options.withMeetingRoundtrip?['CLAWPILOT_NATIVE_JOINT_MEETING_ROUNDTRIP=1']:[])]
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
    if(options.withUnmanagedAppOnly){
      const workspaceId=observed.pipelines[0].policy.workspaceId,pipelineId=id()
      const ownerEmail='joint.app-only.owner@example.invalid',targetEmail='joint.app-only.target@example.invalid'
      for(const email of [ownerEmail,targetEmail]){
        await q(`WITH ref AS(SELECT allocate_crm_reference('gu') AS code)
          INSERT INTO app_users(email,role,status,organization_id,permissions,suitecrm_user_id,suitecrm_username,reference_code,crm_user_enabled)
          SELECT $1,'member','active',$2,'{"viewCrm":true}'::jsonb,NULL,NULL,code,false FROM ref`,[email,workspaceId])
        await q(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
          VALUES($1,$2,'member','active','{"viewCrm":true}'::jsonb,$3,$3)`,[email,workspaceId,selection.actorEmail])
      }
      await q('INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)',
        [pipelineId,'Synthetic independently app-only pipeline',ownerEmail,workspaceId])
      assert.equal((await q('SELECT clawpilot_crm_native_unmanaged_pipeline_footprint($1::uuid) AS safe',[pipelineId])).rows[0].safe,true)
      assert.equal((await q('SELECT clawpilot_crm_native_unmanaged_pipeline_retained($1::uuid) AS safe',[pipelineId])).rows[0].safe,false)
      unmanagedAppOnly={fixtureOnly:true,pipelineId,workspaceId,ownerEmail,targetEmail,
        ownerNativeIdentity:null,footprintBeforeReservation:true,retainedAuthorityBeforeActivation:false,passed:false}
    }
    await q(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,reference_code,source_payload)
      SELECT e."localId"::uuid,e."pipelineId"::uuid,'joint-native-'||e."nativeId",'Actual joint seeded native Email',
      encode(digest(e."nativeId",'sha256'),'hex'),e."nativeId",'Emails',now(),e."globalId",jsonb_build_object('archived',e.archived)
      FROM jsonb_to_recordset($1::jsonb) AS e("localId" text,"pipelineId" text,"nativeId" text,"globalId" text,archived boolean)`,[JSON.stringify(observed.source.emails)])
    if(options.withMeetingRoundtrip){
      // Like the329 interaction fixture rows above, these two explicit INSERTs
      // are synthetic setup, not a production Account/Contact adoption path.
      const [account,contact]=recordLifecycle.fixture.records,policy=observed.pipelines[0].policy
      const accountId=id(),contactId=id(),contactEmail='joint-meeting-contact@example.invalid'
      const payload={fixtureOnly:true,source:'joint-native-meeting-prerequisite',accountAdoptionProven:false}
      await q(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,source_key,identity_key,name,account_type,relationship_type,
        source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code,created_by,updated_by)
        VALUES($1,$2,$3,$4,$4,'Synthetic initial related first','Customer','customer',$5,$6,'synced',now(),$7,$8,$8)`,
        [accountId,policy.pipelineId,account.nativeId,'customer:name:synthetic initial related first',payload,
          sha('joint-meeting-native-account:'+account.nativeId),account.globalId,selection.actorEmail])
      await q(`INSERT INTO crm_contacts(id,pipeline_id,organization_id,suitecrm_id,source_key,identity_key,full_name,last_name,email,
        source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$5,'Initial first','Initial first',$6,$7,$8,'synced',now(),$9,$10,$10)`,
        [contactId,policy.pipelineId,accountId,contact.nativeId,'email:'+contactEmail,contactEmail,payload,
          sha('joint-meeting-native-contact:'+contact.nativeId),contact.globalId,selection.actorEmail])
      meetingFixtureSeeds={fixtureOnly:true,phase:'before-RootA-source-reservation',method:'explicit-synthetic-PG-INSERT',
        pipelineId:policy.pipelineId,account:{localId:accountId,nativeId:account.nativeId,globalId:account.globalId},
        contact:{localId:contactId,nativeId:contact.nativeId,globalId:contact.globalId,email:contactEmail},accountContactAdoptionProven:false}
    }
  })
  if(meetingModule){
    // Actual users.ensureOwnerUser normalizes configured-owner permissions.
    // Prepare it before RootA; never bypass authorization or trigger a new
    // global-owner authority transition after native initial activation.
    const mappingSql=`SELECT email,suitecrm_user_id,suitecrm_username,reference_code,crm_user_enabled,role,status
      FROM app_users ORDER BY email`
    const before=(await q(mappingSql)).rows,policy=observed.pipelines[0].policy
    assert.equal(before.length,4+(unmanagedAppOnly?2:0))
    assert.deepEqual(before.filter(row=>row.suitecrm_user_id!==null).map(row=>[row.email,row.suitecrm_user_id]),
      people.map(row=>[row.email,row.native]).sort(([a],[b])=>a.localeCompare(b)))
    assert.deepEqual(before.filter(row=>row.suitecrm_user_id===null).map(row=>({email:row.email,
      suitecrm_username:row.suitecrm_username,crm_user_enabled:row.crm_user_enabled,role:row.role,status:row.status})),
    unmanagedAppOnly?[unmanagedAppOnly.ownerEmail,unmanagedAppOnly.targetEmail].sort().map(email=>({email,
      suitecrm_username:null,crm_user_enabled:false,role:'member',status:'active'})):[])
    const beforeControl=(await q('SELECT enabled,active_initial_enrollment_id FROM crm_native_email_publication_control WHERE singleton')).rows[0]
    assert.equal(beforeControl.enabled,false);assert.equal(beforeControl.active_initial_enrollment_id,null)
    const prepared=await meetingModule.prepareNativeJointMeetingFixture({query:q,withTransaction:transaction,getPostgresPool:()=>pool,
      authority:{actorEmail:selection.actorEmail,pipelineId:policy.pipelineId,workspaceOrganizationId:policy.workspaceId},deadline})
    assert.equal(prepared.passed,true);assert.equal(prepared.configuredOwnerEmail,selection.actorEmail)
    assert.equal(prepared.actualEnsureOwnerUser,true)
    assert.deepEqual((await q(mappingSql)).rows,before,'Configured-owner preparation changed a mapped native principal identity or eligibility')
    const afterControl=(await q('SELECT enabled,active_initial_enrollment_id FROM crm_native_email_publication_control WHERE singleton')).rows[0]
    assert.equal(afterControl.enabled,false);assert.equal(afterControl.active_initial_enrollment_id,null)
    meetingFixtureSeeds.ownerNormalization={...prepared,phase:'before-RootA-source-reservation',nativePrincipalMappingsPreserved:4,
      appOnlyIdentitiesPreserved:unmanagedAppOnly?2:0}
    console.log('PASS actual configured owner normalization prepared before RootA without bypassing user or scope authorization')
  }
  const legacyArchive=legacyRecoveryModule?await check(heldRecoveryModule?'exact failed original remains in its original outbox before native activation':
    'exact failed original is retained before native activation with a durable archive receipt',async()=>{
    const {suiteCrmId,globalId}=legacyRecoveryModule.JOINT_LEGACY_EMAIL_NATIVE_IDENTITY
    assert.match(suiteCrmId,/^[a-f0-9-]{36}$/u);assert.match(globalId,/^gi[0-9]{7}$/u)
    const policy=observed.pipelines[0].policy
    const related=JSON.parse(sql(`SELECT JSON_ARRAYAGG(JSON_OBJECT('accountId',a.id,'contactId',c.id) ORDER BY a.name)
      FROM accounts a JOIN accounts_contacts ac ON ac.account_id=a.id AND ac.deleted=0
      JOIN contacts c ON c.id=ac.contact_id AND c.deleted=0 WHERE a.deleted=0 AND
      ((a.name='Synthetic initial related first' AND c.last_name='Initial first') OR
       (a.name='Synthetic initial related second' AND c.last_name='Initial second'))`))
    assert.equal(related.length,2)
    const assertNativeAbsent=async()=>{
      assert.equal(activeTransactions,0)
      assert.equal(sql(`SELECT (SELECT count(*) FROM emails WHERE id='${suiteCrmId}')
        +(SELECT count(*) FROM emails_cstm WHERE id_c='${suiteCrmId}' OR global_id_c='${globalId}')
        +(SELECT count(*) FROM emails_text WHERE email_id='${suiteCrmId}')
        +(SELECT count(*) FROM emails_beans WHERE email_id='${suiteCrmId}')
        +(SELECT count(*) FROM emails_email_addr_rel WHERE email_id='${suiteCrmId}')
        +(SELECT count(*) FROM securitygroups_records WHERE record_id='${suiteCrmId}')`).trim(),'0')
    }
    const initialize=heldRecoveryModule?heldRecoveryModule.holdNativeJointOriginalEmail:legacyRecoveryModule.archiveNativeJointLegacyEmail
    return initialize({query:q,withTransaction:transaction,getPostgresPool:()=>pool,
      authority:{...selection,pipelineId:policy.pipelineId,workspaceId:policy.workspaceId,ownerNativeId:observed.serviceUserId},
      assertNativeAbsent,related,repairFirst:options.withLegacyAccountRepair===true})
  }):null
  const verification={publicKey,keyId,serviceUserId:observed.serviceUserId,oauthClientId:observed.oauthClientId}
  const initialStore=new Store(transaction,selection,undefined,verification),preview=await initialStore.preview(),operationId=observed.operationId
  await check('real SQL source reservation is committed before native source transport or any offline installation',async()=>{
    assert.equal(preview.publicationEnabled,false);assert.equal(preview.activeOperationId,null)
    await initialStore.reserve(operationId,preview.sourceFingerprint)
    assert.equal((await q('SELECT active_initial_enrollment_id FROM crm_native_email_publication_control WHERE singleton')).rows[0].active_initial_enrollment_id,operationId)
    // The exact failed recovery source is still retained in the app, but has
    // no native identity to enroll. The native source count stays at 329.
    const counts=(await q(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE suitecrm_synced_at IS NOT NULL)::int AS synced FROM crm_interactions`)).rows[0]
    assert.deepEqual(counts,{total:329+(legacyArchive?1:0),synced:329})
  })
  const rawState=()=>{const output=stage('raw-state'),line=output.split('\n').findLast(x=>x.startsWith('{'));assert.ok(line);return JSON.parse(line)}
  const invoke=(script,args,extra={})=>run('docker',['exec',...(extra.input!==undefined?['--interactive']:[]),...nativeEnv.flatMap(x=>['--env',x]),names.app,
    'php','-d','memory_limit=384M',script,...args],{timeout:45000,...extra})
  const packet=JSON.parse(invoke('/opt/clawpilot/install-native-email-runtime.php',['check','--app-root='+nativePaths.app,'--state-root='+nativePaths.runtime]))
  const initialIdentityFile=join(root,'initial-fixture-identity')
  writeFileSync(initialIdentityFile,'Synthetic fixture; never sent to SSH.\n',{flag:'wx',mode:0o600})
  const binary=realpathSync('/usr/bin/true'),target={railwayBinary:binary,railwayBinarySha256:sha(readFileSync(binary)),projectId:id(),environmentId:id(),serviceId:id(),
    deploymentInstanceId:id(),railwayIdentityFile:initialIdentityFile,
    nativeInstanceId:selection.nativeInstanceId,database:'suitecrm_native_test',serviceUserId:observed.serviceUserId,oauthClientId:observed.oauthClientId,
    cliSourceHash:sha(readFileSync(join(source,'native-email-initial-cli.php'))),imagePackageHash:packet.packageHash}
  let loseNativeCommitResponse=true,nativeExecutionCount=0,nativeResolutionBeforePgActivation=false,activationOperationId=operationId
  const expectedCancellations=new Set(),nativeCancellationOperations=[],freshCancellationResolutions=[]
  const actualCommand=async command=>{
    assert.equal(activeTransactions,0,'Native I/O occurred under a PG transaction')
    assert.equal(command.program,binary)
    assert.deepEqual(command.args.slice(0,13),['ssh','--project',target.projectId,'--environment',target.environmentId,'--service',target.serviceId,
      '--deployment-instance',target.deploymentInstanceId,'--identity-file',initialIdentityFile,'--','php'])
    const script=command.args[13],args=command.args.slice(14),action=args[0],commandOperation=args.find(arg=>arg.startsWith('--operation='))?.slice('--operation='.length)
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
  if(unmanagedAppOnly)await check('actual native activation retains app-only exclusion and independent sharing/lifecycle without native changes',async()=>{
    const p=unmanagedAppOnly,sqlState=async()=>((await q(`SELECT jsonb_build_object(
      'control',(SELECT to_jsonb(c) FROM crm_native_email_publication_control c WHERE singleton),
      'policies',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY pipeline_id) FROM crm_native_email_capability_policies c),'[]'::jsonb),
      'admissions',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY operation_id) FROM crm_native_email_publication_admissions c),'[]'::jsonb)
      ) AS state`)).rows[0].state)
    const beforeNative=rawState(),beforeSql=await sqlState()
    assert.equal((await q('SELECT clawpilot_crm_native_unmanaged_pipeline_retained($1::uuid) AS safe',[p.pipelineId])).rows[0].safe,true)
    assert.equal(material.plan.pipelines.some(row=>row.policy.pipelineId===p.pipelineId),false)
    assert.equal(material.plan.emails.length,329);assert.equal(material.plan.pipelines.length,3)
    for(const email of [p.targetEmail,people[1].email]){
      await q(`INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by)
        VALUES($1,$2,'viewer',$3)`,[p.pipelineId,email,p.ownerEmail])
      await q(`UPDATE pipeline_space_members SET access_role='editor',updated_at=clock_timestamp()
        WHERE pipeline_id=$1 AND user_email=$2`,[p.pipelineId,email])
    }
    await q(`UPDATE app_users SET status='disabled' WHERE email=$1`,[p.targetEmail])
    await q('DELETE FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2',[p.pipelineId,p.targetEmail])
    await q(`UPDATE app_users SET status='active' WHERE email=$1`,[p.targetEmail])
    await q(`UPDATE app_users SET status='disabled' WHERE email=$1`,[p.ownerEmail])
    await q(`UPDATE app_users SET status='active' WHERE email=$1`,[p.ownerEmail])
    await q(`UPDATE app_users SET permissions='{"viewCrm":false}'::jsonb WHERE email=$1`,[p.ownerEmail])
    await q(`UPDATE app_users SET permissions='{"viewCrm":true}'::jsonb WHERE email=$1`,[p.ownerEmail])
    await q(`UPDATE app_user_organization_memberships SET status='disabled',trashed_at=clock_timestamp(),
      trashed_by=$3,pre_trash_status='active' WHERE user_email=$1 AND organization_id=$2`,[p.ownerEmail,p.workspaceId,selection.actorEmail])
    await q(`UPDATE app_user_organization_memberships SET status='active',trashed_at=NULL,trashed_by=NULL,pre_trash_status=NULL
      WHERE user_email=$1 AND organization_id=$2`,[p.ownerEmail,p.workspaceId])
    assert.deepEqual(await sqlState(),beforeSql,'Independent app-only mutations changed native SQL authority')
    assert.deepEqual(rawState(),beforeNative,'Independent app-only mutations changed native data/files')
    p.passed=true;p.actualActivatedNativeReceipt=true;p.activeMappedMemberRetained=true
    p.staleUnmappedIntentRemoved=true;p.ownerDisableRestore=true;p.ownerModuleRestore=true;p.ownerTrashRestore=true
  })
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
      const lifecycleAudit=async(phase,probe)=>{
        const before=rawState(),filesBefore=fileState(),journalBefore=readNative(nativePaths.runtime+'/manifest.json')
        const pins=['app/public/legacy/custom/include/ClawPilot/RecordLifecycle.php',
          'app/public/legacy/custom/include/ClawPilot/record-lifecycle-routes.php',
          'app/public/legacy/custom/application/Ext/Api/V8/Config/routes.php',
          'clawpilot-native-email-runtime-v1/manifest.json']
        for(const pin of pins)assert.ok(filesBefore[pin]?.sha256,'Actual installed lifecycle file missing: '+pin)
        assert.equal(journalBefore.packageHash,packet.packageHash)
        const result=await probe(),after=rawState(),filesAfter=fileState(),processes=processState()
        const changedTables=Object.keys(before.database).filter(table=>before.database[table]!==after.database[table])
        const changedFiles=[...new Set([...Object.keys(filesBefore),...Object.keys(filesAfter)])]
          .filter(path=>JSON.stringify(filesBefore[path])!==JSON.stringify(filesAfter[path]))
        const cache=auditNativeInitialColdCache(before.cache,after.cache,before.stockAudit,after.stockAudit)
        const allowedAuditPaths=['app/public/legacy/cache/modules/Audit','app/public/legacy/cache/modules/Audit/Auditvardefs.php']
        audits.push({script:'/fixture/native-joint-lifecycle.php',action:phase,commandSucceeded:true,
          tableCount:Object.keys(before.database).length,changedTables,changedFiles,
          beforeStateHash:sha(stable(before)),afterStateHash:sha(stable(after)),
          beforeFilesHash:sha(stable(filesBefore)),afterFilesHash:sha(stable(filesAfter)),
          fileDifferences:changedFiles.map(path=>({path,before:filesBefore[path]??null,after:filesAfter[path]??null})),
          criticalFilesUnchanged:JSON.stringify(before.critical)===JSON.stringify(after.critical),...cache})
        assert.deepEqual(after.database,before.database,'Authenticated lifecycle inspection/denial wrote a native table')
        assert.deepEqual(after.critical,before.critical,'Lifecycle HTTP bootstrap changed critical native files')
        assert.deepEqual(Object.keys(filesAfter),Object.keys(filesBefore),'Lifecycle HTTP bootstrap added or removed a native path')
        assert.ok(changedFiles.every(path=>allowedAuditPaths.includes(path)),
          'Lifecycle HTTP bootstrap changed an unreviewed file; inspect exact warmup provenance: '+changedFiles.join(','))
        for(const pin of pins)assert.deepEqual(filesAfter[pin],filesBefore[pin],'Installed lifecycle bytes/metadata changed: '+pin)
        assert.deepEqual(readNative(nativePaths.runtime+'/manifest.json'),journalBefore)
        assert.deepEqual(processes.forbidden,[],'Temporary lifecycle router must be stopped before the process inventory')
        return{phase,...result,installedPackageHash:journalBefore.packageHash,installedFiles:Object.fromEntries(pins.map(pin=>[pin,filesBefore[pin].sha256])),
          installedBytesAndPackageUnchanged:true,nativeTablesUnchanged:true,temporaryRouterAbsentFromProcessInventory:true,auditIndex:audits.length-1}
      }
      const phases=[],certificateBefore=run('docker',['exec',names.app,'php','-r','fwrite(STDOUT,hash_file("sha256",$argv[1]));',nativePaths.state+'/activation-origin.json'])
      const entrypointEnvironment=nativeEnv.filter(value=>!value.startsWith('CLAWPILOT_NATIVE_INITIAL_MAINTENANCE='))
        .concat(['CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=0','CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED=1','CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED=1',
          'CLAWPILOT_NATIVE_INITIAL_FIXTURE=1','PORT=8080'])
      const expectedBody=readFileSync(join(source,'native-email-liveness.json'),'utf8')
      assert.deepEqual(JSON.parse(expectedBody),{service:'suitecrm',mode:'normal',live:true,ready:null})
      if(options.withRecordLifecycle){
        recordLifecycle.disabledProbe=await check('real OAuth protected lifecycle route refuses flag0 without changing installed bytes or package',
          ()=>lifecycleAudit('record-lifecycle-disabled',()=>lifecycleFixture('disabled',{timeout:20000})))
        assert.equal(recordLifecycle.disabledProbe.code,'NATIVE_RECORD_LIFECYCLE_DISABLED')
        assert.equal(recordLifecycle.disabledProbe.temporaryRouterStopped,true)
        recordLifecycle.httpBounds={perRequestSeconds:6,requestsPerVerifier:3,temporaryRouterStartupSeconds:3,
          temporaryRouterShutdownSeconds:1,disabledProbeSeconds:20,eachEnrolledStartSeconds:45,entireJointRehearsalSeconds:600}
      }
      for(const phase of ['enrolled-first-container','enrolled-second-container-restart']){
        appDataBudget('before-'+phase);const before=rawState(),filesBefore=fileState(),volumeBefore=ownedVolume()
        assert.ok(volumeBefore);observeStorage('before-'+phase)
        assert.equal(runStorageGuard({argv:['--preflight'],environment:env}),0)
        removeSecondary(names.app);assert.equal(inspect(names.app),null);assert.deepEqual(ownedVolume(),volumeBefore)
        // No entrypoint override, extra command or source overlay is present.
        // This is the actual configured service-image ENTRYPOINT as PID1.
        // Retain an exited service container long enough to read its bounded
        // failure log; owner-checked removeSecondary/finally always removes it.
        run('docker',['run','--detach','--pull=never','--platform=linux/amd64','--name',names.app,'--network',names.net,'--read-only',
          ...limits('1152m','1'),'--cap-drop=ALL','--cap-add=SETUID','--cap-add=SETGID','--security-opt=no-new-privileges',
          ...appDataMount,'--tmpfs','/tmp:rw,nosuid,size=32m','--tmpfs','/run/apache2:rw,nosuid,nodev,noexec,size=4m,mode=0755',
          '--tmpfs','/run/lock/apache2:rw,nosuid,nodev,noexec,size=1m,mode=0755',...fixtureMounts,
          ...entrypointEnvironment.flatMap(value=>['--env',value]),php.Id])
        const started=inspect(names.app)
        const stoppedService=found=>{
          if(!found)return Error('Actual enrolled entrypoint container disappeared before Apache liveness')
          assert.equal(found.Config.Labels?.[label],owner);assert.equal(found.Config.Labels?.[DISPOSABLE_POSTGRES_OWNER_LABEL],token)
          const logs=spawnSync('docker',['logs','--tail','20',found.Id],{encoding:'utf8',timeout:5000,maxBuffer:500000})
          const lines=logs.status===0?`${logs.stdout}${logs.stderr}`.slice(-2000):'bounded logs unavailable'
          return Error(`Actual enrolled entrypoint exited (${found.State.ExitCode}) before Apache liveness: ${lines}`)
        }
        if(!started?.State.Running)throw stoppedService(started)
        validateMounts(started)
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
          if(!current?.State.Running)throw stoppedService(current)
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
        const startupAuditIndex=audits.length-1
        assert.deepEqual(after.database,before.database,'Actual enrolled startup/restart changed native tables')
        assert.deepEqual(after.critical,before.critical,'Actual enrolled startup/restart changed critical files')
        assert.deepEqual(Object.keys(filesAfter),Object.keys(filesBefore),'Actual enrolled startup/restart added or removed native paths')
        assert.ok(changedFiles.every(path=>permitted.includes(path)),'Actual enrolled startup/restart changed an unreviewed native file: '+changedFiles.join(','))
        assert.equal(run('docker',['exec',names.app,'php','-r','fwrite(STDOUT,hash_file("sha256",$argv[1]));',nativePaths.state+'/activation-origin.json']),certificateBefore)
        if(options.withRecordLifecycle){
          assert.ok(started.Config.Env.includes('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=1'))
          assert.ok(started.Config.Env.includes('SUITECRM_CLIENT_ID='+observed.oauthClientId))
          const lifecycle=await check('actual Apache stock OAuth inspects exact synthetic Account/Contact after '+phase,
            ()=>lifecycleAudit('record-lifecycle-'+phase,()=>lifecycleFixture('http-active',{timeout:25000})))
          assert.equal(lifecycle.status,200);assert.equal(lifecycle.unauthenticatedStatus,401);assert.equal(lifecycle.mismatchStatus,409)
          assert.deepEqual(lifecycle.records.map(row=>row.state),['active','active','missing'])
          assert.deepEqual(lifecycle.records.slice(0,2).map(({module,nativeId,globalId})=>({module,nativeId,globalId})),recordLifecycle.fixture.records)
          assert.deepEqual(lifecycleFixture('metadata'),recordLifecycle.fixture,'Retained synthetic OAuth fixture changed across actual restart')
          recordLifecycle.httpPhases.push({...lifecycle,containerId:started.Id})
        }
        appDataBudget('after-'+phase);observeStorage('after-'+phase)
        phases.push({phase,containerId:started.Id,actualConfiguredEntrypoint:true,apachePid1:true,apacheProcesses:processes.apache,
          backgroundWorkersOff:true,httpPort:8080,httpLiveness:true,httpBody:JSON.parse(body),httpProvesAppReadiness:false,
          actualCurrentNativeInspectionCompletedBeforeApache:true,volumeName:volumeBefore.Name,auditIndex:startupAuditIndex})
      }
      assert.equal(phases.length,2);assert.notEqual(phases[0].containerId,phases[1].containerId)
      if(options.withRecordLifecycle){assert.equal(recordLifecycle.httpPhases.length,2)
        assert.notEqual(recordLifecycle.httpPhases[0].containerId,recordLifecycle.httpPhases[1].containerId)
        recordLifecycle.passed=true;recordLifecycle.actualTwoContainerRestartsWithLifecycleEnabled=true}
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
  if(meetingModule){
    await check('actual joined Calendar import, ClawPilot edit and native V8 edit preserve one meeting and event without replay duplicates',async()=>{
      assert.equal(serviceStartup?.passed,true);assert.equal(recordLifecycle?.passed,true)
      const meetingUntil=Math.min(deadline,Date.now()+120000),nativeAudits=[]
      meetingRoundtrip={version:1,kind:'actual-joined-meeting-roundtrip',passed:false,nativeAudits,
        bounds:{totalSeconds:120,nativeHttpRequests:60,aggregateResponseBytes:2097152,httpSeconds:6},
        fixtureSeeding:meetingFixtureSeeds,testProcessTimezone:'UTC',nonUtcServerPortabilityProven:false,
        nativeResponsesSynthetic:false,oauthResponsesSynthetic:false,calendarAdapterControlled:true,productionTouched:false}
      const fixtureCall=(mode,input)=>JSON.parse(run('docker',['exec',...(input===undefined?[]:['--interactive']),names.app,
        'php','-d','memory_limit=384M','-d','display_errors=0','/fixture/native-joint-meeting.php',mode],
        {timeout:Math.max(1,Math.min(12000,meetingUntil-Date.now())),...(input===undefined?{}:{input:JSON.stringify(input)})}))
      // These synthetic credentials remain only in private fixture storage and
      // this process/pipe. Never attach them or a native OAuth body to evidence.
      const fixtureCredentials=fixtureCall('credentials'),policy=observed.pipelines[0].policy
      meetingPrivateValues.push(fixtureCredentials.clientSecret,fixtureCredentials.accessToken)
      const authority={actorEmail:selection.actorEmail,pipelineId:policy.pipelineId,workspaceOrganizationId:policy.workspaceId}
      assert.equal(fixtureCredentials.clientId,observed.oauthClientId)
      const fileState=()=>JSON.parse(run('docker',['exec',names.app,'php','-d','memory_limit=384M','/joint-startup.php','--service-files'],{timeout:45000,maxBuffer:24000000}))
      let nativeMeetingId=null,nativeGlobalId=null,requests=0,responseBytes=0,grants=0
      const beforeAll=rawState(),filesBefore=fileState(),initialRows=fixtureCall('rows',{nativeMeetingId:null})
      assert.equal(initialRows.meetings?.otherCount,0,'The meeting fixture must not adopt any existing native Meeting')
      const allowedTables=['meetings','meetings_cstm','meetings_contacts','meetings_users','meetings_audit','oauth2tokens','vcals','accounts','contacts']
      // Pinned stock SugarBean::update_parent_relationships queues the old
      // parent for SugarRelationship::resaveRelatedBeans. SugarBean::save then
      // touches these2 timestamp/actor columns; no business mutation is allowed.
      const parentMutableFields=['date_modified','modified_user_id']
      const parentBusinessRow=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!parentMutableFields.includes(key)))
      const parentIds={accounts:fixtureCredentials.nativeAccountId,contacts:fixtureCredentials.nativeContactId}
      const originalParents={}
      for(const table of Object.keys(parentIds)){assert.equal(initialRows[table]?.selected.length,1)
        originalParents[table]=parentBusinessRow(initialRows[table].selected[0])}
      const stableFreeBusy=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['content','date_modified'].includes(key)))
      assert.equal(initialRows.vcals?.selected.length,1,'Actual stock free/busy cache must be prewarmed before RootA')
      const originalFreeBusy=stableFreeBusy(initialRows.vcals.selected[0])
      const validateRows=rows=>{
        for(const [table,nativeId]of Object.entries(parentIds)){assert.equal(rows[table]?.selected.length,1,'Exact existing fixture parent row required')
          const row=rows[table].selected[0];assert.equal(row.id,nativeId);assert.equal(String(row.deleted),'0')
          assert.deepEqual(parentBusinessRow(row),originalParents[table],'A business/identity/ownership field of the fixture parent changed')
          assert.equal(row.modified_user_id,observed.serviceUserId,'Unexpected parent timestamp actor')
          assert.match(row.date_modified,/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/)}
        assert.ok((rows.meetings?.selected.length??0)<=1);assert.ok((rows.meetings_cstm?.selected.length??0)<=1)
        for(const row of rows.meetings?.selected??[]){assert.equal(row.id,nativeMeetingId);assert.equal(String(row.deleted),'0')
          if(row.parent_id){assert.ok(['Accounts','Contacts'].includes(row.parent_type))
            assert.equal(row.parent_id,row.parent_type==='Accounts'?fixtureCredentials.nativeAccountId:fixtureCredentials.nativeContactId)}
          else assert.ok(!row.parent_type)
          assert.ok(!row.assigned_user_id||row.assigned_user_id===observed.serviceUserId)}
        for(const row of rows.meetings_cstm?.selected??[]){assert.equal(row.id_c,nativeMeetingId)
          if(nativeGlobalId!==null)assert.equal(row.global_id_c,nativeGlobalId)}
        for(const [table,key,expected]of [['meetings_contacts','contact_id',fixtureCredentials.nativeContactId],['meetings_users','user_id',observed.serviceUserId]]){
          assert.ok((rows[table]?.selected.length??0)<=2,'Unexpected duplicate physical meeting relationship')
          for(const row of rows[table]?.selected??[]){assert.equal(row.meeting_id,nativeMeetingId);assert.equal(row[key],expected)
            assert.ok(['0','1'].includes(String(row.deleted)))}}
        const auditFields=['name','description','date_start','date_end','duration_hours','duration_minutes','location','status','parent_id','parent_type','assigned_user_id','global_id_c']
        for(const row of rows.meetings_audit?.selected??[]){assert.equal(row.parent_id,nativeMeetingId)
          assert.ok(auditFields.includes(row.field_name),'Unrequested native meeting audit field changed')}
        assert.equal(rows.vcals?.selected.length,1,'Exactly one active actor/vfb/sugar free-busy cache row required')
        const freebusy=rows.vcals.selected[0];assert.equal(freebusy.user_id,observed.serviceUserId)
        assert.equal(freebusy.type,'vfb');assert.equal(freebusy.source,'sugar');assert.equal(String(freebusy.deleted),'0')
        assert.deepEqual(stableFreeBusy(freebusy),originalFreeBusy,'Derived free/busy immutable row identity changed')
        assert.equal(typeof freebusy.content,'string');assert.ok(Buffer.byteLength(freebusy.content,'utf8')<=65536)
        assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(freebusy.content))
        const normalizedLines=freebusy.content.replace(/\r\n/g,'\n');assert.ok(!normalizedLines.includes('\r'),'Bare CR in stock free/busy content')
        const lines=normalizedLines.replace(/\n[ \t]/g,'').split('\n');assert.equal(lines.pop(),'')
        assert.ok(lines.length>=10&&lines.length<=2048&&lines.every(line=>line.length<=1024))
        assert.deepEqual(lines.slice(0,4),['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SuiteCRM//SuiteCRM Calendar//EN','BEGIN:VFREEBUSY'])
        assert.deepEqual(lines.slice(-2),['END:VFREEBUSY','END:VCALENDAR'])
        const timestamp='(?:[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}|[0-9]{8}T[0-9]{6}Z)'
        for(const label of ['DTSTART','DTEND','DTSTAMP'])assert.equal(lines.filter(line=>new RegExp('^'+label+':'+timestamp+'$').test(line)).length,1)
        assert.equal(lines.filter(line=>/^ORGANIZER;CN=[^\r\n]{1,256}:VFREEBUSY$/.test(line)).length,1)
        for(const line of lines.slice(4,-2))assert.ok(/^ORGANIZER;CN=[^\r\n]{1,256}:VFREEBUSY$/.test(line)
          ||new RegExp('^(?:DTSTART|DTEND|DTSTAMP):'+timestamp+'$').test(line)
          ||/^FREEBUSY:[0-9]{8}T[0-9]{6}Z\/[0-9]{8}T[0-9]{6}Z$/.test(line)
          ||/^X-FREEBUSY-ID:[a-zA-Z0-9-]{1,64}$/.test(line)||/^X-FREEBUSY-TYPE:(?:Meeting|Call|Task)$/.test(line),
        'Unrecognized content in derived stock VCALENDAR/VFREEBUSY cache')
      }
      const nativeFetch=async(resource,init={})=>{
        assert.ok(Date.now()<meetingUntil,'Meeting helper120-second deadline exceeded')
        assert.equal(activeTransactions,0,'Meeting native HTTP occurred inside a PostgreSQL transaction')
        assert.ok(typeof resource==='string'||resource instanceof URL,'Only explicit native URLs admitted')
        const url=new URL(String(resource));assert.equal(url.origin,'https://suitecrm-joint.example.invalid')
        assert.ok(url.pathname.startsWith('/legacy/Api/'));assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(url.hash,'')
        const method=String(init.method||'GET').toUpperCase(),body=init.body===undefined||init.body===null?null:String(init.body)
        assert.ok(['GET','POST','PATCH'].includes(method));assert.ok(++requests<=60)
        init.signal?.throwIfAborted()
        const grant=url.pathname==='/legacy/Api/access_token'&&method==='POST'
        const moduleWrite=url.pathname==='/legacy/Api/V8/module'&&['POST','PATCH'].includes(method)
        const relationshipWrite=method==='POST'&&/\/Meetings\/[^/]+\/relationships\/(?:contacts|accounts)$/.test(url.pathname)
        const targetMatch=url.pathname.match(/^\/legacy\/Api\/V8\/module\/Meetings\/([a-f0-9-]{36})(?:\/relationships\/(?:contacts|accounts))?$/i)
        const payload=moduleWrite?JSON.parse(body):null,targetId=payload?.data?.id??targetMatch?.[1]
        if(targetId){assert.match(targetId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
          if(nativeMeetingId===null)nativeMeetingId=targetId;else assert.equal(targetId,nativeMeetingId,'Native HTTP attempted a second meeting identity')}
        if(moduleWrite){assert.equal(payload.data.type,'Meetings');const globalId=payload.data.attributes?.global_id_c
          if(globalId!==undefined){assert.match(globalId,/^gm(?:[0-9]{7}|[0-9a-v]{12})$/)
            if(nativeGlobalId===null)nativeGlobalId=globalId;else assert.equal(globalId,nativeGlobalId)}}
        for(const module of ['Accounts','Contacts']){const match=url.pathname.match(new RegExp('^/legacy/Api/V8/module/'+module+'/([^/]+)$'))
          if(match)assert.equal(match[1],module==='Accounts'?fixtureCredentials.nativeAccountId:fixtureCredentials.nativeContactId)}
        if(grant)assert.equal(++grants,1,'Only one actual production-client OAuth grant is needed')
        const before=rawState(),rowsBefore=fixtureCall('rows',{nativeMeetingId})
        const wire=fixtureCall('request',{url:String(url),method,headers:[...new Headers(init.headers||{}).entries()],body})
        if(grant){const token=JSON.parse(wire.body).access_token;if(typeof token==='string')meetingPrivateValues.push(token)}
        const after=rawState(),rowsAfter=fixtureCall('rows',{nativeMeetingId}),changed=Object.keys(before.database).filter(table=>before.database[table]!==after.database[table])
        assert.deepEqual(Object.keys(after.database),Object.keys(before.database),'Meeting HTTP created an unreviewed native table')
        assert.ok(changed.every(table=>grant?table==='oauth2tokens':(moduleWrite||relationshipWrite)&&allowedTables.includes(table)&&table!=='oauth2tokens'),
          'Meeting HTTP changed an unrelated native table: '+changed.join(','))
        const parentColumnChanges=[]
        for(const table of allowedTables){assert.equal(rowsAfter[table]===null,rowsBefore[table]===null)
          if(rowsBefore[table]===null)continue
          assert.equal(rowsAfter[table].otherSha256,rowsBefore[table].otherSha256,'Meeting HTTP changed unrelated native '+table+' rows')
          assert.equal(rowsAfter[table].otherCount,rowsBefore[table].otherCount)
          if(Object.hasOwn(parentIds,table)){
            assert.equal(rowsBefore[table].selected.length,1);assert.equal(rowsAfter[table].selected.length,1)
            const prior=rowsBefore[table].selected[0],next=rowsAfter[table].selected[0]
            assert.deepEqual(Object.keys(next).sort(),Object.keys(prior).sort())
            const columns=Object.keys(prior).filter(key=>prior[key]!==next[key]).sort()
            assert.ok(columns.every(key=>parentMutableFields.includes(key)),'Relationship re-save changed an unreviewed parent column')
            if(columns.length)parentColumnChanges.push({table,nativeId:parentIds[table],changedColumns:columns})
          }
          if(table==='oauth2tokens'){
            const prior=rowsBefore[table].selected,next=rowsAfter[table].selected
            if(!grant)assert.equal(sha(stable(next)),sha(stable(prior)),'Ordinary V8 request changed OAuth token rows')
            else{assert.equal(next.length,prior.length+1);for(const old of prior)assert.equal(sha(stable(next.find(row=>row.id===old.id))),sha(stable(old)))
              for(const row of next.filter(row=>!prior.some(old=>old.id===row.id))){assert.equal(row.client,observed.oauthClientId)
                assert.equal(row.assigned_user_id,observed.serviceUserId);assert.equal(String(row.deleted),'0');assert.equal(String(row.token_is_revoked),'0')}}
          }
        }
        validateRows(rowsAfter);assert.deepEqual(after.critical,before.critical,'Meeting HTTP changed protected native files')
        const emptyRelateIdNormalizations=[]
        for(const old of rowsBefore.meetings?.selected??[]){const next=rowsAfter.meetings.selected.find(row=>row.id===old.id)
          assert.ok(next,'Scalar meeting flow removed its original row')
          const fields=assertNativeMeetingScalarRow(old,next,{attributes:payload?.data?.attributes??{},write:moduleWrite||relationshipWrite})
          if(fields.length)emptyRelateIdNormalizations.push({nativeMeetingId,fields,direction:'SQLNULL-to-empty',notPresentInRequest:true})}
        const emptyCustomStringNormalizations=[]
        for(const old of rowsBefore.meetings_cstm?.selected??[]){const next=rowsAfter.meetings_cstm.selected.find(row=>row.id_c===old.id_c)
          assert.ok(next,'Scalar meeting flow removed its original custom row')
          const fields=assertNativeMeetingCustomRow(old,next,{attributes:payload?.data?.attributes??{},write:moduleWrite||relationshipWrite})
          if(fields.length)emptyCustomStringNormalizations.push({nativeMeetingId,fields,direction:'SQLNULL-to-empty',notPresentInRequest:true})}
        for(const table of ['meetings_contacts','meetings_users','meetings_audit'])for(const old of rowsBefore[table]?.selected??[]){
          const next=rowsAfter[table].selected.find(row=>(row.id??row.id_c)===(old.id??old.id_c))
          assert.deepEqual(next,old,'Meeting flow changed or removed an existing native custom/relationship/audit row')}
        const cache=auditNativeInitialColdCache(before.cache,after.cache,before.stockAudit,after.stockAudit)
        responseBytes+=Buffer.byteLength(wire.body,'utf8');assert.ok(responseBytes<=2097152,'Meeting HTTP aggregate response ceiling exceeded')
        nativeAudits.push({method,path:url.pathname,status:wire.status,tableCount:Object.keys(before.database).length,changedTables:changed,
          exactNativeMeetingId:nativeMeetingId,unrelatedRowsUnchanged:true,criticalFilesUnchanged:true,
          stockFreeBusy:{nativeRowId:originalFreeBusy.id,userId:observed.serviceUserId,type:'vfb',source:'sugar',
            mutableFieldsOnly:['content','date_modified'],contentSha256:sha(rowsAfter.vcals.selected[0].content)},
          beforeStateHash:sha(stable(before)),afterStateHash:sha(stable(after)),
          actualOAuthGrant:grant,parentColumnChanges,emptyRelateIdNormalizations,emptyCustomStringNormalizations,
          sentAttributeNames:moduleWrite?Object.keys(payload.data.attributes).sort():[],
          selectedRowCounts:Object.fromEntries(allowedTables.map(table=>[table,rowsAfter[table]?.selected.length??null])),...cache})
        init.signal?.throwIfAborted();assert.ok(Date.now()<meetingUntil,'Meeting helper120-second deadline exceeded')
        return new Response([204,205,304].includes(wire.status)?null:wire.body,{status:wire.status,headers:wire.headers})
      }
      const result=await meetingModule.runNativeJointMeetingRoundtrip({query:q,withTransaction:transaction,getPostgresPool:()=>pool,
        nativeFetch,fixture:fixtureCredentials,authority,deadline:meetingUntil})
      assert.ok(Date.now()<=meetingUntil,'Meeting helper120-second deadline exceeded');assert.equal(result.passed,true)
      const afterAll=rawState(),filesAfter=fileState(),rowsAfter=fixtureCall('rows',{nativeMeetingId})
      validateRows(rowsAfter);assert.equal(rowsAfter.meetings.selected.length,1);assert.equal(rowsAfter.meetings_cstm.selected.length,1)
      const activeContacts=rowsAfter.meetings_contacts.selected.filter(row=>String(row.deleted)==='0')
      assert.equal(activeContacts.length,1,'Native Meeting must have exactly one durable undeleted fixture Contact relationship')
      assert.equal(activeContacts[0].meeting_id,nativeMeetingId);assert.equal(activeContacts[0].contact_id,fixtureCredentials.nativeContactId)
      assert.deepEqual(Object.keys(afterAll.database),Object.keys(beforeAll.database))
      const changedTables=Object.keys(beforeAll.database).filter(table=>beforeAll.database[table]!==afterAll.database[table])
      assert.ok(changedTables.every(table=>allowedTables.includes(table)))
      assert.deepEqual(afterAll.critical,beforeAll.critical);assert.deepEqual(Object.keys(filesAfter),Object.keys(filesBefore))
      const changedFiles=Object.keys(filesBefore).filter(path=>JSON.stringify(filesBefore[path])!==JSON.stringify(filesAfter[path]))
      assert.ok(changedFiles.every(path=>['app/public/legacy/cache/modules/Audit','app/public/legacy/cache/modules/Audit/Auditvardefs.php'].includes(path)),
        'Meeting HTTP introduced unreviewed file drift; inspect exact pre-RootA warmup: '+changedFiles.join(','))
      for(const secret of meetingPrivateValues)assert.ok(!JSON.stringify(result).includes(secret),'Meeting evidence leaked a fixture credential')
      meetingRoundtrip={...meetingRoundtrip,...result,nativeAudits,nativeHttpRequests:requests,aggregateNativeResponseBytes:responseBytes,
        actualProductionClientOAuthGrants:grants,nativeMeetingId,nativeGlobalId,tableCount:Object.keys(beforeAll.database).length,
        nativeContactAssociation:{activeRows:1,nativeMeetingId,nativeContactId:fixtureCredentials.nativeContactId},
        derivedStockFreeBusy:{nativeRowId:originalFreeBusy.id,userId:observed.serviceUserId,type:'vfb',source:'sugar',
          prewarmedBeforeRootA:true,immutableIdentityUnchanged:true,onlyContentAndDateModifiedMutable:true},
        derivedStockParentTouches:{provenance:{sourceZipSha256:ZIP_SHA,
          queue:'SugarBean::update_parent_relationships',drain:'SugarRelationship::resaveRelatedBeans',timestampWriter:'SugarBean::save'},
          allowedColumns:parentMutableFields,exactParentIds:parentIds,businessIdentityOwnershipFieldsUnchanged:true,
          changes:nativeAudits.flatMap(audit=>audit.parentColumnChanges.map(change=>({method:audit.method,path:audit.path,...change})))},
        derivedStockEmptyRelateIds:{provenance:{sourceZipSha256:ZIP_SHA,
          hydration:'SugarBean::populateFromRow',write:'DBManager::updateSQL/isNullable/emptyValue',
          assignedUserDefinition:'include/SugarObjects/implements/assignable/vardefs.php:dbType=id',
          repeatParentDefinition:'modules/Meetings/vardefs.php:type=id'},
          exactFields:MEETING_EMPTY_RELATE_IDS,directional:'SQLNULL-to-empty-only-when-not-sent',
          changes:nativeAudits.flatMap(audit=>audit.emptyRelateIdNormalizations.map(change=>({method:audit.method,path:audit.path,...change})))},
        derivedStockEmptyCustomStrings:{provenance:{sourceZipSha256:ZIP_SHA,
          hydration:'SugarBean::populateFromRow',save:'SugarBean::save -> DynamicField::save',
          definitions:'install/suite_install/GoogleMaps.php:Meetings nullable varchar'},
          exactFields:MEETING_EMPTY_CUSTOM_STRINGS,directional:'SQLNULL-to-empty-only-when-not-sent',
          identityGlobalIdCoordinatesAndOtherColumnsUnchanged:true,
          changes:nativeAudits.flatMap(audit=>audit.emptyCustomStringNormalizations.map(change=>({method:audit.method,path:audit.path,...change})))},
        changedTables,changedFiles,unrelatedNativeRowsUnchanged:true,protectedNativeFilesUnchanged:true,
        beforeStateSha256:sha(stable(beforeAll)),afterStateSha256:sha(stable(afterAll)),allAppFilesAudited:Object.keys(filesBefore).length}
      appDataBudget('after-joined-meeting-roundtrip')
      if(verifyAncestorPreservation)await verifyAncestorPreservation('after-C-joined-meeting-roundtrip')
    })
  }
  if(legacyRecoveryModule) {
    legacyRecovery=await check('actual joined private held Email commits once and lost native response settles only through exact resolution',async()=>{
      assert.equal(serviceStartup?.passed,true);assert.equal(recordLifecycle?.passed,true)
      const {suiteCrmId,globalId}=legacyRecoveryModule.JOINT_LEGACY_EMAIL_NATIVE_IDENTITY
      assert.match(suiteCrmId,/^[a-f0-9-]{36}$/u);assert.match(globalId,/^gi[0-9]{7}$/u)
      // The operator plans a fresh deterministic group ID; the stock fixture
      // inventory's placeholder is not the applied enrollment authority.
      const pipelineId=observed.pipelines[0].policy.pipelineId
      assert.match(pipelineId,/^[a-f0-9-]{36}$/u)
      const enrolled=material.plan.pipelines.filter(row=>row.policy.pipelineId===pipelineId)
      assert.equal(enrolled.length,1)
      const {policy,groupId}=enrolled[0];assert.match(groupId,/^[a-f0-9-]{36}$/u)
      assert.equal(policy.ownerSuiteCrmId,observed.serviceUserId,'Recovery audience must retain the exact enrolled native owner')
      assert.equal(sql(`SELECT group_id FROM clawpilot_email_bindings WHERE pipeline_id='${pipelineId}'`).trim(),groupId,
        'Native binding must match the approved enrollment plan before recovery')
      const recoveryUntil=Math.min(deadline,Date.now()+90000)
      let maintenance,maintenanceFixture,recoveryApp
      if(options.withPrivateMaintenanceDispatch){
        const role='fixture_recovery_dispatch',password='Synthetic-maintenance-'+crypto.randomBytes(18).toString('hex')
        const transportAttestationKey=crypto.randomBytes(32),transportAttestationKeyBase64=transportAttestationKey.toString('base64')
        meetingPrivateValues.push(password,transportAttestationKeyBase64)
        const rootSql=text=>run('docker',['exec','--env','MYSQL_PWD=Synthetic-native-root-password-only',names.maria,'mariadb',
          '--user=root','--database=suitecrm_native_test','--batch','--skip-column-names','--execute='+text])
        const roleSql=text=>run('docker',['exec','--env','MYSQL_PWD='+password,names.maria,'mariadb','--protocol=TCP','--host=127.0.0.1',
          '--user='+role,'--database=suitecrm_native_test','--batch','--skip-column-names','--execute='+text])
        const volume=ownedVolume();assert.ok(volume)
        removeSecondary(names.app);assert.equal(inspect(names.app),null);assert.deepEqual(ownedVolume(),volume)
        // Stock Account/Contact bean hydration reads the installed Global ID
        // tables; Contact also inspects its native user relationship.
        const readTables=['accounts','accounts_contacts','accounts_cstm','acl_actions','acl_roles','acl_roles_actions','acl_roles_users',
          'aow_actions','aow_conditions','aow_workflow','config','contacts','contacts_cstm','contacts_users','email_addresses','email_addr_bean_rel','emails','emails_beans',
          'emails_cstm','emails_email_addr_rel','emails_text','fields_meta_data','oauth2clients','outbound_email','securitygroups',
          'securitygroups_acl_roles','securitygroups_default','securitygroups_records','securitygroups_users','user_preferences','users',
          'clawpilot_email_bindings','clawpilot_email_identities','clawpilot_email_operations','clawpilot_email_write_permissions','clawpilot_email_write_scopes']
        const insertTables=['emails','emails_beans','emails_cstm','emails_text','securitygroups_records',
          'clawpilot_email_identities','clawpilot_email_operations','clawpilot_email_write_permissions']
        const updateTables=['emails','emails_beans','emails_cstm','emails_text']
        const grant=(priv,tables)=>tables.map(table=>`GRANT ${priv} ON suitecrm_native_test.\`${table}\` TO '${role}'@'%';`).join('\n')
        rootSql(`CREATE USER '${role}'@'%' IDENTIFIED BY '${password}';
          GRANT EVENT, TRIGGER ON \`suitecrm\\_native\\_test\`.* TO '${role}'@'%';
          ${grant('SELECT',readTables)} ${grant('INSERT',insertTables)} ${grant('UPDATE',updateTables)}
          ALTER USER 'fixture'@'%' ACCOUNT LOCK; SET GLOBAL event_scheduler=OFF;`)
        assert.throws(()=>fixtureSql('SELECT 1'),error=>/account is locked/i.test(String(error.stderr)))
        assert.equal(roleSql('SELECT CURRENT_USER(),DATABASE()').trim(),`${role}@%\tsuitecrm_native_test`)
        assert.throws(()=>roleSql('SELECT id FROM meetings LIMIT 0'),error=>/denied/i.test(String(error.stderr)))
        assert.throws(()=>roleSql('UPDATE users SET status=status WHERE 0'),error=>/denied/i.test(String(error.stderr)))
        assert.throws(()=>roleSql('UPDATE oauth2clients SET deleted=deleted WHERE 0'),error=>/denied/i.test(String(error.stderr)))
        assert.throws(()=>roleSql('UPDATE outbound_email SET deleted=deleted WHERE 0'),error=>/denied/i.test(String(error.stderr)))
        assert.equal(roleSql("SELECT COUNT(*) FROM outbound_email WHERE type='system' AND deleted=0").trim(),'1',
          'Stock installed fixture must already have its exact system mailer; the private login must not create it')
        sql=rootSql
        const cliSourceHash=sha(readFileSync(join(source,'native-email-recovery-cli.php')))
        const mariaIdentity=JSON.parse(sql("SELECT JSON_OBJECT('database',DATABASE(),'hostname',@@GLOBAL.hostname,'serverId',CAST(@@GLOBAL.server_id AS CHAR),'serverVersion',@@GLOBAL.version,'serverUid',@@GLOBAL.server_uid)"))
        assert.equal(mariaIdentity.database,'suitecrm_native_test')
        assert.match(mariaIdentity.serverUid,/^[A-Za-z0-9+/]{27}=$/)
        const mariaStoreFingerprint=sha(stable({version:1,purpose:'clawpilot-native-email-custody-maria-store-v1',...mariaIdentity}))
        const nativeTarget={projectId:id(),environmentId:id(),serviceId:id(),deploymentId:id(),deploymentInstanceId:id(),replicaId:id(),
          nativeInstanceId:selection.nativeInstanceId,database:'suitecrm_native_test',databasePrincipal:`${role}@%`,
          serviceUserId:observed.serviceUserId,oauthClientId:observed.oauthClientId,cliSourceHash,imagePackageHash:packet.packageHash,mariaStoreFingerprint}
        const identityEnv={RAILWAY_PROJECT_ID:nativeTarget.projectId,RAILWAY_ENVIRONMENT_ID:nativeTarget.environmentId,
          RAILWAY_SERVICE_ID:nativeTarget.serviceId,RAILWAY_DEPLOYMENT_ID:nativeTarget.deploymentId,RAILWAY_REPLICA_ID:nativeTarget.replicaId}
        const fenceEnv=[...nativeEnv,'CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED=1','CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED=1','PORT=8080',
          'SUITECRM_NATIVE_RECOVERY_DB_USER='+role,'SUITECRM_NATIVE_RECOVERY_DB_PASSWORD='+password,
          ...Object.entries(identityEnv).map(([key,value])=>`${key}=${value}`)]
        run('docker',['run','--rm','--detach','--pull=never','--platform=linux/amd64','--name',names.app,'--network',names.net,'--read-only',
          ...limits('1152m','1'),'--cap-drop=ALL','--security-opt=no-new-privileges',...appDataMount,
          '--tmpfs','/tmp:rw,nosuid,size=32m',...fixtureMounts,...fenceEnv.flatMap(value=>['--env',value]),php.Id])
        const started=inspect(names.app);assert.ok(started?.State.Running);validateMounts(started)
        assert.equal(started.Image,options.serviceImage);assert.deepEqual(started.Config.Entrypoint,['/usr/local/bin/entrypoint.sh'])
        assert.ok(!appContainerHistory.some(row=>row.id===started.Id));appContainerHistory.push({phase:'private-maintenance-dispatch',id:started.Id})
        const maintenanceHealth=()=>JSON.parse(run('docker',['exec',names.app,'curl','--silent','--fail','--max-time','2',
          'http://127.0.0.1:8080/_clawpilot/liveness'],{timeout:3500}))
        for(const startUntil=Date.now()+15000;;){try{assert.deepEqual(maintenanceHealth(),{service:'suitecrm',mode:'maintenance',live:true,ready:false});break}
          catch(error){if(Date.now()>startUntil||!inspect(names.app)?.State.Running)throw error;await new Promise(r=>setTimeout(r,250))}}
        const deniedStatus=run('docker',['exec',names.app,'curl','--silent','--show-error','--max-time','2','-X','POST','--output','/dev/null',
          '--write-out','%{http_code}','http://127.0.0.1:8080/legacy/Api/V8/custom/clawpilot-email-publication/publish']).trim()
        assert.equal(deniedStatus,'405')
        const assertFence=()=>{
          assert.equal(inspect(names.app)?.Id,started.Id);assert.equal(maintenanceHealth().mode,'maintenance')
          assert.equal(rootSql('SELECT @@global.event_scheduler').trim(),'OFF')
          assert.equal(rootSql('SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID()').trim(),'0')
        }
        assertFence()
        const keypair=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),keyId='joint-recovery-dispatch-key',fenceEpoch=id()
        const expiresAt=Math.floor(recoveryUntil/1000)
        const bootstrapPins=JSON.parse(run('docker',['exec',names.app,'php','-r',
          '$value=json_decode(file_get_contents($argv[1]),true,64,JSON_THROW_ON_ERROR);echo json_encode($value["bootstrapPins"],JSON_THROW_ON_ERROR);',
          nativePaths.state+'/operations/'+activationOperationId+'/input.json']))
        const config={version:2,target:nativeTarget,bootstrapPins,fenceEpoch,expiresAt,keyId,transportAttestationKey:transportAttestationKeyBase64,
          publicKeyPem:keypair.publicKey.export({type:'spki',format:'pem'})}
        run('docker',['exec','--interactive',names.app,'php','-r',
          '$p=$argv[1];$b=stream_get_contents(STDIN);$f=fopen($p,"x");if(!$f||!chmod($p,0600)||fwrite($f,$b)!==strlen($b)||!fflush($f)||!fsync($f))exit(2);fclose($f);',
          nativePaths.state+'/dispatch-fence.json'],{input:stable(config)+'\n'})
        recoveryApp=legacyRecoveryModule.loadNativeJointLegacyEmailRecoveryApp({query:q,withTransaction:transaction,getPostgresPool:()=>pool})
        const {maintenanceCli,maintenanceDuplex}=recoveryApp
        const localBinary=realpathSync('/usr/bin/true'),railwayIdentityFile=join(root,'synthetic-recovery-identity')
        writeFileSync(railwayIdentityFile,'Synthetic fixture; never sent to SSH.\n',{flag:'wx',mode:0o600})
        // The production argv is inspected, not executed. The replacement
        // runs only the exact owned Docker container on the fixture's Unix
        // socket; the duplex runner deliberately inherits no Docker config.
        const dockerBinary=realpathSync(run('/usr/bin/which',['docker']).trim())
        assert.ok(lstatSync(dockerBinary).isFile())
        const dockerContext=run(dockerBinary,['context','show']).trim()
        const dockerHost=(!process.env.DOCKER_CONTEXT&&process.env.DOCKER_HOST)||
          run(dockerBinary,['context','inspect',dockerContext,'--format','{{.Endpoints.docker.Host}}']).trim()
        assert.ok(dockerHost.startsWith('unix:///'),'Private maintenance fixture requires a local Unix Docker socket')
        const dockerSocket=realpathSync(dockerHost.slice('unix://'.length))
        assert.ok(lstatSync(dockerSocket).isSocket())
        const dockerPrefix=['--host','unix://'+dockerSocket]
        const [dockerApp]=JSON.parse(run(dockerBinary,[...dockerPrefix,'inspect',started.Id],
          {env:{...process.env,DOCKER_HOST:'',DOCKER_CONTEXT:''}}))
        assert.equal(dockerApp.Id,started.Id);assert.equal(dockerApp.Config.Labels?.[label],owner)
        const attestedActions=[];let rejectedBeforeAuthentication=false
        const bridge=heldRecoveryModule?heldRecoveryModule.createNativeJointHeldOriginalTransport({maintenanceCli,target:nativeTarget,
          root,dockerBinary,dockerSocket,containerId:started.Id,railwayIdentityFile,transportAttestationKey,
          assertOutsideTransaction:()=>assert.equal(activeTransactions,0)})
          :maintenanceCli.createNativeEmailRecoveryCliTransport({target:nativeTarget,railwayBinary:localBinary,
          railwayBinarySha256:sha(readFileSync(localBinary)),railwayIdentityFile,transportAttestationKey},async spec=>{
          assert.equal(activeTransactions,0);assert.equal(spec.program,localBinary)
          const script='/opt/clawpilot/native-email-recovery-cli.php'
          assert.deepEqual(spec.args.slice(0,-2),['ssh','--project',nativeTarget.projectId,'--environment',nativeTarget.environmentId,
            '--service',nativeTarget.serviceId,'--deployment-instance',nativeTarget.deploymentInstanceId,'--identity-file',railwayIdentityFile,'--','php',script])
          const [action,nonce]=spec.args.slice(-2);assert.ok(['prepare','publish','resolve'].includes(action));assert.match(nonce,/^[0-9a-f]{64}$/u)
          if(action==='publish'&&!rejectedBeforeAuthentication){
            // Reject this fixture's first publish before a ready frame (and
            // before the runner can ask for any authorized packet bytes).
            rejectedBeforeAuthentication=true
            throw Error('legacy_dispatch_transport_destination_unverified')
          }
          const start=rootSql('SELECT COALESCE(MAX(TIMER_START),0) FROM performance_schema.events_statements_history_long').trim()
          assert.match(start,/^\d+$/u)
          const runDuplex=maintenanceDuplex.createNativeEmailRecoveryDuplexCommandRunner(Math.max(1,Math.min(20000,recoveryUntil-Date.now())))
          try{return await runDuplex({...spec,program:dockerBinary,args:[...dockerPrefix,'exec','--interactive',started.Id,
            'php','-d','memory_limit=384M','-d','display_errors=0',script,action,nonce],
            verifyReady:line=>{const verified=spec.verifyReady(line);if(verified)attestedActions.push(action);return verified}})}
          catch(error){
            // This observer is available only in the isolated synthetic test.
            // Do not export SQL text, messages, rows, account names or hosts.
            const failures=rootSql(`SELECT MYSQL_ERRNO, IF(MYSQL_ERRNO IN (1142,1146),
                SUBSTRING_INDEX(SUBSTRING_INDEX(MESSAGE_TEXT,CHAR(39),-2),CHAR(39),1),'')
              FROM performance_schema.events_statements_history_long
              WHERE TIMER_START>${start} AND CURRENT_SCHEMA='suitecrm_native_test' AND MYSQL_ERRNO>0
              ORDER BY TIMER_START DESC LIMIT 12`).trim().split('\n').filter(Boolean).map(line=>{
                const [errno,rawTable]=line.split('\t');const table=(rawTable??'').replace(/^suitecrm_native_test\./u,'')
                return {errno:/^\d{1,5}$/u.test(errno)?Number(errno):null,
                  ...(table&&/^[a-z][a-z0-9_]{0,63}$/u.test(table)?{table}:{})}
              })
            throw Error(redactMeetingSecrets(error.message)+'\nSynthetic MariaDB error metadata: '+JSON.stringify(failures))
          }
        })
        assert.equal(bridge.targetFingerprint,sha(stable(nativeTarget)))
        let busy=false
        maintenance={signer:{keyId,key:keypair.privateKey,targetFingerprint:bridge.targetFingerprint},
          withVerifiedFence:async callback=>{assert.equal(busy,false);busy=true;try{assertFence();return await callback({
            fenceEpoch,targetFingerprint:bridge.targetFingerprint,expiresAt})}finally{busy=false;assertFence()}},
          exchange:packet=>{assert.equal(busy,true);return bridge.exchange(packet)},
          exchangePublish:input=>{assert.equal(busy,true);return bridge.exchangePublish(input)}}
        maintenanceFixture={actualMaintenanceEntrypoint:true,ordinaryHttpPostStatus:deniedStatus,normalDatabaseLoginLocked:true,
          distinctNativeDatabasePrincipal:true,deniedUnrelatedReadsAndWrites:true,nonAuditNativeConnectionsDrained:true,
          eventSchedulerOff:true,roleTableReadGrants:readTables.length,roleTableInsertGrants:insertTables.length,
          roleTableUpdateGrants:updateTables.length,roleSchemaEventTriggerMetadataPrivileges:true,
          actualLocalSameProcessReadiness:true,attestedActions:heldRecoveryModule?bridge.attestedActions:attestedActions,
          get firstPublishRejectedBeforeAuthentication(){return heldRecoveryModule?bridge.firstPublishRejectedBeforeAuthentication:rejectedBeforeAuthentication},
          postgresLeastPrivilegeProven:false,externalProductionDrainProven:false}
      }
      const inspectNative=async op=>{
        assert.equal(activeTransactions,0)
        if(op!==null){assert.match(op,/^[a-f0-9]{64}$/u)
          assert.equal(sql(`SELECT state FROM clawpilot_email_operations WHERE operation_id='${op}' AND email_id='${suiteCrmId}'`).trim(),'committed')
          assert.equal(sql(`SELECT SHA2(description,256) FROM emails_text WHERE email_id='${suiteCrmId}' AND deleted=0`).trim(),legacyRecoveryModule.JOINT_LEGACY_EMAIL_BODY_SHA256)
          assert.equal(sql(`SELECT parent_id FROM emails WHERE id='${suiteCrmId}' AND deleted=0`).trim(),legacyArchive.related[0].accountId)
          const links=JSON.parse(sql(`SELECT JSON_ARRAYAGG(JSON_OBJECT('module',bean_module,'id',bean_id)
            ORDER BY BINARY bean_module,BINARY bean_id) FROM emails_beans WHERE email_id='${suiteCrmId}' AND deleted=0`))
          assert.deepEqual(links,[...legacyArchive.accounts.map(id=>({module:'Accounts',id})),
            ...legacyArchive.contacts.map(id=>({module:'Contacts',id}))])
          assert.equal(sql(`SELECT count(*) FROM securitygroups_records WHERE record_id='${suiteCrmId}' AND module='Emails' AND deleted=0 AND securitygroup_id='${groupId}'`).trim(),'1')}
        return JSON.parse(sql(`SELECT JSON_OBJECT(
          'emails',(SELECT count(*) FROM emails WHERE id='${suiteCrmId}'),
          'custom',(SELECT count(*) FROM emails_cstm WHERE id_c='${suiteCrmId}' AND BINARY global_id_c=BINARY '${globalId}'),
          'global',(SELECT count(*) FROM emails_cstm WHERE global_id_c='${globalId}'),
          'text',(SELECT count(*) FROM emails_text WHERE email_id='${suiteCrmId}'),
          'groups',(SELECT count(*) FROM securitygroups_records WHERE record_id='${suiteCrmId}'),
          'managed',(SELECT count(*) FROM clawpilot_email_identities WHERE email_id='${suiteCrmId}' OR global_id='${globalId}'),
          'operations',(SELECT count(*) FROM clawpilot_email_operations WHERE email_id='${suiteCrmId}'))`))
      }
      const invokeNative=(action,body)=>JSON.parse(run('docker',['exec','--interactive','--env','CLAWPILOT_NATIVE_JOINT_LEGACY_RECOVERY=1',
        names.app,'php','-d','memory_limit=384M','-d','display_errors=0','/fixture/native-joint-legacy-email-recovery.php',action],
        {input:body,timeout:Math.max(1,Math.min(12000,recoveryUntil-Date.now()))}))
      const recover=heldRecoveryModule?heldRecoveryModule.runNativeJointHeldOriginalRecovery:legacyRecoveryModule.runNativeJointLegacyEmailRecovery
      const result=await recover({query:q,withTransaction:transaction,getPostgresPool:()=>pool,
        authority:{actorEmail:selection.actorEmail,pipelineId:policy.pipelineId,workspaceId:policy.workspaceId,ownerNativeId:observed.serviceUserId},
        deadline:recoveryUntil,invokeNative,assertOutsideTransaction:()=>assert.equal(activeTransactions,0),inspectNative,archive:legacyArchive,
        held:heldRecoveryModule?legacyArchive:undefined,app:heldRecoveryModule?recoveryApp:undefined,maintenance,
        scopedRecoveryPostgres:options.withScopedRecoveryPostgres===true})
      assert.equal(result.passed,true);appDataBudget('after-joined-private-held-email-recovery')
      if(maintenanceFixture){assert.equal(maintenanceFixture.firstPublishRejectedBeforeAuthentication,true)
        assert.deepEqual(maintenanceFixture.attestedActions,['prepare','prepare','publish','resolve'])}
      return maintenanceFixture?{...result,maintenanceFixture}:result
    })
  }
  for(const [p,h]of Object.entries(sourceHashes))assert.equal(sha(readFileSync(p)),h,'Consumed source changed: '+p)
  checkBuild()
  report={version:1,kind:'actual-local-native-initial-joint-rehearsal',passed:true,postgresMajor:Number(options.major),sourceZipSha256:ZIP_SHA,resourceOwner:owner,resourceNames:names,
    sourceHashes,buildManifestSha256:sha(readFileSync(join(build,'build-manifest.json'))),checks,audits,commandLog,storagePhases,startupComponent,
    serviceStartup,imageProof,appDataBudgets,appContainerHistory,replanEvidence,recordLifecycle,meetingRoundtrip,meetingFixtureSeeds,legacyRecovery,unmanagedAppOnly,
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
    imageProof,appDataBudgets,appContainerHistory,replanEvidence,recordLifecycle,meetingRoundtrip,meetingFixtureSeeds,legacyRecovery,unmanagedAppOnly,
    error:redactMeetingSecrets(error.stack??error),stdout:redactMeetingSecrets(error.stdout),stderr:redactMeetingSecrets(error.stderr),productionTouched:false},null,2)+'\n',{flag:'wx',mode:0o600})
  if(meetingPrivateValues.length)throw Error(redactMeetingSecrets(error.stack??error));throw error
}finally{try{if(pool)await pool.end()}finally{cleanup()}}
