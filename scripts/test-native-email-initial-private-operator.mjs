#!/usr/bin/env node
// Runs the emitted production CommonJS modules with ordinary Node resolution.
// Remote command responses below are SYNTHETIC, not authenticated native proof.
import assert from 'node:assert/strict'
import {constants,createHash,generateKeyPairSync,sign} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {chmodSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {isAbsolute,join,resolve} from 'node:path'
assert.equal(process.versions.node.split('.')[0],'24')
assert.equal(process.argv.length,3,'Use --build=/absolute/generated-operator-directory')
const root=process.argv[2].slice('--build='.length);assert.ok(process.argv[2].startsWith('--build=')&&isAbsolute(root))
const manifest=JSON.parse(readFileSync(join(root,'build-manifest.json'),'utf8'))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
for(const [file,expected]of Object.entries(manifest.outputs))assert.equal(sha(readFileSync(join(root,file))),expected)
for(const [file,expected]of Object.entries(manifest.sources))assert.equal(sha(readFileSync(resolve('app_src',file))),expected)
const entry=join(root,manifest.entry)
const plain=spawnSync(process.execPath,[entry,'--action=preview'],{encoding:'utf8',env:{PATH:process.env.PATH}})
assert.notEqual(plain.status,0);assert.match(plain.stderr,/Server Component|Client Component/)
assert.equal(manifest.requiredNodeCondition,'react-server')
if(!process.execArgv.includes('--conditions=react-server')){
  const child=spawnSync(process.execPath,['--conditions=react-server',...process.argv.slice(1)],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}})
  process.stdout.write(child.stdout);process.stderr.write(child.stderr);process.exit(child.status??1)
}
const require=createRequire(entry),{NativeEmailInitialEnrollmentCliTransport:Transport,createNativeEmailInitialCliCommandRunner:createRunner}=require(join(root,'lib/crm/nativeEmailInitialEnrollmentCliTransport.js'))
const {runNativeEmailInitialPrivateOperator:runOperator,reuseVerifiedNativeEmailInitialOrigin:reuseOrigin,
  nativeEmailInitialOperatorDatabaseConfig:databaseConfig,createNativeEmailInitialOperatorTransaction:createTransaction}=require(entry)
const op='1'.repeat(64),hash='2'.repeat(64),sourceDigest=sha('source\n'),binary=realpathSync('/usr/bin/true')
const databaseIdentity={systemIdentifier:'7638853025209610328',databaseOid:'16384',sessionRole:'owner',effectiveRole:'operator'}
const identityDirectory=realpathSync(mkdtempSync(join(tmpdir(),'clawpilot-initial-identity-fixture.')))
process.once('exit',()=>rmSync(identityDirectory,{recursive:true,force:true}))
const railwayIdentityFile=join(identityDirectory,'fixture-identity')
writeFileSync(railwayIdentityFile,'Synthetic fixture only.\n',{flag:'wx',mode:0o600})
const target={railwayBinary:binary,railwayBinarySha256:sha(readFileSync(binary)),projectId:'00000000-0000-4000-8000-000000000001',
  environmentId:'00000000-0000-4000-8000-000000000002',serviceId:'00000000-0000-4000-8000-000000000003',
  deploymentInstanceId:'00000000-0000-4000-8000-000000000004',railwayIdentityFile,nativeInstanceId:'synthetic-operator',
  database:'synthetic_operator',serviceUserId:'1',oauthClientId:'client',cliSourceHash:hash,imagePackageHash:hash}
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']'
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'
  return JSON.stringify(v)}
const leaves=['vendor/autoload.php','public/legacy/include/entryPoint.php','public/legacy/config.php','public/legacy/config_override.php',
  'public/legacy/include/modules_override.php','public/legacy/custom/include/custom_utils.php','public/legacy/custom/application/Ext/Utils/custom_utils.ext.php',
  'public/legacy/custom/application/Ext/Include/modules.ext.php','public/legacy/custom/include/database/MysqliManager.php']
const bootstrap={version:1,purpose:'clawpilot-native-email-initial-bootstrap-pins',operationId:op,cliSourceHash:hash,imagePackageHash:hash,
  bootstrapPins:Object.fromEntries(leaves.map(key=>[key,null])),activeArtifactHash:null}
const replanContext={version:1,purpose:'clawpilot-native-email-initial-replan-context',rootOperationId:'3'.repeat(64),
  rootInstallationJournalFingerprint:hash,rootSourceArtifactDigest:hash,rootStockRuntimeFingerprint:'4'.repeat(64),
  predecessorOperationId:'3'.repeat(64),predecessorPlanHash:hash,predecessorApprovalHash:hash,
  predecessorCancellationReceiptHash:hash,previousLineageHash:null,depth:1,cancelledHistoryFingerprint:hash}
let checks=0;async function check(name,fn){await fn();checks++;console.log('PASS '+name)}
const held=e=>e?.code?.startsWith('initial_')||/initial_/.test(e?.message??'')
await check('compiled production marker still refuses ordinary Node import; react-server runs actual emitted modules',()=>{
  assert.equal(manifest.purpose,'clawpilot-native-email-initial-private-operator-build');assert.ok(Object.keys(manifest.sources).length>=20)
  for(const file of Object.keys(manifest.outputs).filter(f=>f.endsWith('.js')&&!f.includes('/node_modules/'))){
    const source=readFileSync(join(root,file),'utf8');assert.doesNotMatch(source,/new Function\(|transpileModule\(/)}
})
await check('every SSH call pins the exact Railway instance and private identity before the fixed PHP command',async()=>{
  const calls=[];const runner=async command=>{calls.push(command);const args=command.args
    assert.deepEqual(args.slice(0,13),['ssh','--project',target.projectId,'--environment',target.environmentId,'--service',target.serviceId,
      '--deployment-instance',target.deploymentInstanceId,'--identity-file',railwayIdentityFile,'--','php'])
    assert.equal(command.program,binary);assert.ok(args.includes('--quiescent'))
    if(args.includes('bootstrap'))return canonical(bootstrap)+'\n'
    if(args.includes('stage-input')){const input=JSON.parse(command.stdin);assert.equal(input.operationId,op)
      assert.equal(args.find(a=>a.startsWith('--sha256=')),'--sha256='+sha(command.stdin));assert.ok(args.includes('--previous=none'))
      assert.deepEqual(Object.keys(input.bootstrapPins).sort(),[...leaves].sort());return canonical({operationId:op,sha256:sha(command.stdin),replayed:false})+'\n'}
    if(args.includes('inspect-source'))return canonical({version:1,purpose:'clawpilot-native-email-initial-source'})+'\n'
    if(args.includes('retain-source'))return canonical({operationId:op,sourceArtifactDigest:sha(command.stdin)})+'\n'
    throw Error('unexpected command')}
  const transport=new Transport(target,runner),source={operationId:op,nativeInstanceId:target.nativeInstanceId,appGeneration:1,appSourceFingerprint:hash,mappings:[]}
  const bytes=await transport.inspectSource(source);assert.equal(JSON.parse(bytes).purpose,'clawpilot-native-email-initial-source');assert.equal(calls.length,4)
})
await check('missing or malformed target pins and unsafe identities fail before invoking any remote command',async()=>{
  const {deploymentInstanceId,railwayIdentityFile:identity,...legacy}=target
  let calls=0;const runner=async()=>{calls++;return ''}
  for(const invalid of [legacy,{...target,deploymentInstanceId:[]},{...target,deploymentInstanceId:'--latest'},
    {...target,deploymentInstanceId:deploymentInstanceId+'\n'},{...target,railwayIdentityFile:'relative'},
    {...target,railwayIdentityFile:identity+'\0'},{...target,railwayIdentityFile:identity+'-missing'},
    {...target,railwayIdentityFile:identityDirectory}])assert.throws(()=>new Transport(invalid,runner),held)
  const linked=join(identityDirectory,'fixture-link')
  symlinkSync(identity,linked)
  assert.throws(()=>new Transport({...target,railwayIdentityFile:linked},runner),held)
  const transport=new Transport(target,runner)
  chmodSync(identity,0o644)
  try{
    assert.throws(()=>new Transport(target,runner),held)
    await assert.rejects(transport.originStatus(op),held)
  }finally{chmodSync(identity,0o600)}
  assert.equal(calls,0)
  const legacyConfig=join(identityDirectory,'legacy-config.json')
  const bytes=JSON.stringify({version:1,purpose:'clawpilot-native-email-initial-private-operator',
    selection:{actorEmail:'fixture@example.invalid',operatorAccountId:op,rootWorkspaceId:op,nativeInstanceId:target.nativeInstanceId},
    native:legacy,databaseName:'fixture',databaseIdentity,artifactDirectory:identityDirectory,issuer:{keyId:'fixture',publicKey:'fixture'}})
  writeFileSync(legacyConfig,bytes,{flag:'wx',mode:0o600})
  await assert.rejects(runOperator(['--action=preview','--config='+legacyConfig,'--config-sha256='+sha(bytes)]),
    e=>e?.code==='initial_cli_transport_shape'||e?.message==='initial_cli_transport_shape')
})
await check('changed CLI package metadata, noncanonical responses and wrong instance fail closed before staging',async()=>{
  const source={operationId:op,nativeInstanceId:target.nativeInstanceId,appGeneration:1,appSourceFingerprint:hash,mappings:[]}
  for(const response of [canonical({...bootstrap,cliSourceHash:'3'.repeat(64)})+'\n',JSON.stringify(bootstrap)+'\n',canonical({...bootstrap,operationId:'3'.repeat(64)})+'\n']){
    let calls=0;await assert.rejects(new Transport(target,async()=>{calls++;return response}).inspectSource(source),held);assert.equal(calls,1)}
  let calls=0;await assert.rejects(new Transport(target,async()=>{calls++;return ''}).inspectSource({...source,nativeInstanceId:'other'}),held);assert.equal(calls,0)
})
await check('compiled replan transport uses distinct installed-source action and exact immutable context',async()=>{
  const calls=[],nativeSource={version:2,purpose:'clawpilot-native-email-initial-installed-source',installationContext:replanContext}
  const transport=new Transport(target,async command=>{calls.push(command)
    if(command.args.includes('bootstrap'))return canonical(bootstrap)+'\n'
    if(command.args.includes('stage-input')){const input=JSON.parse(command.stdin)
      assert.equal(input.version,2);assert.equal(input.purpose,'clawpilot-native-email-initial-replan-cli-artifact')
      assert.deepEqual(input.installationContext,replanContext);assert.equal(input.sourceArtifactDigest,null);assert.equal(input.plan,null)
      return canonical({operationId:op,sha256:sha(command.stdin),replayed:false})+'\n'}
    if(command.args.includes('inspect-installed-source'))return canonical(nativeSource)+'\n'
    assert.ok(command.args.includes('retain-source'));assert.equal(command.stdin,canonical(nativeSource)+'\n')
    return canonical({operationId:op,sourceArtifactDigest:sha(command.stdin)})+'\n'})
  const source={operationId:op,nativeInstanceId:target.nativeInstanceId,appGeneration:1,appSourceFingerprint:hash,mappings:[]}
  assert.equal(await transport.inspectInstalledSource(source,replanContext),canonical(nativeSource)+'\n')
  assert.equal(calls.length,4);assert.ok(calls.every(c=>!c.args.includes('inspect-source')&&!c.args.includes('execute')))
  let n=0;await assert.rejects(new Transport(target,async()=>{n++;return ''}).inspectInstalledSource(source,{...replanContext,approved:true}),held)
  assert.equal(n,0)
})
await check('compiled installed-source transport refuses stock or changed-context bytes before retention',async()=>{
  for(const nativeSource of [{version:1,purpose:'clawpilot-native-email-initial-source'},
    {version:2,purpose:'clawpilot-native-email-initial-installed-source',installationContext:{...replanContext,rootSourceArtifactDigest:'5'.repeat(64)}}]){
    const calls=[],transport=new Transport(target,async c=>{calls.push(c)
      if(c.args.includes('bootstrap'))return canonical(bootstrap)+'\n'
      if(c.args.includes('stage-input'))return canonical({operationId:op,sha256:sha(c.stdin),replayed:false})+'\n'
      assert.ok(c.args.includes('inspect-installed-source'));return canonical(nativeSource)+'\n'})
    await assert.rejects(transport.inspectInstalledSource({operationId:op,nativeInstanceId:target.nativeInstanceId,appGeneration:1,appSourceFingerprint:hash,mappings:[]},replanContext),held)
    assert.equal(calls.length,3);assert.ok(calls.every(c=>!c.args.includes('retain-source')))
  }
})
await check('retained read binds actual private metadata to operation instance generation SQL source and independent source digest',async()=>{
  const source={operationId:op,nativeInstanceId:target.nativeInstanceId,appGeneration:1,appSourceFingerprint:hash,mappings:[],sourceArtifactDigest:sourceDigest}
  const status={version:1,purpose:'clawpilot-native-email-initial-retained-source-status',operationId:op,nativeInstanceId:target.nativeInstanceId,
    appGeneration:1,appSourceFingerprint:hash,sourceArtifactDigest:sourceDigest,activeArtifactHash:hash}
  const calls=[],transport=new Transport(target,async c=>{calls.push(c)
    if(c.args.includes('source-status'))return canonical(status)+'\n'
    assert.ok(c.args.includes('read-source'));assert.ok(c.args.includes('--sha256='+sourceDigest));return 'source\n'})
  assert.equal(await transport.readSource(source),'source\n');assert.equal(calls.length,2)
  assert.ok(calls.every(c=>!c.args.includes('inspect-source')&&!c.args.includes('stage-input')))
  for(const changed of [{...status,operationId:'3'.repeat(64)},{...status,nativeInstanceId:'other'},{...status,appGeneration:2},
    {...status,appSourceFingerprint:'3'.repeat(64)},{...status,sourceArtifactDigest:'3'.repeat(64)}]){
    let n=0;await assert.rejects(new Transport(target,async()=>{n++;return canonical(changed)+'\n'}).readSource(source),held);assert.equal(n,1)
  }
})
await check('remote origin recovery is fixed operation/hash exact-byte read not a replacement certificate',async()=>{
  const origin={proof:{purpose:'clawpilot-native-email-initial-activation-origin',operationId:op},signature:'synthetic-transport-only'}
  const bytes=canonical(origin),digest=sha(bytes),calls=[]
  const transport=new Transport(target,async c=>{calls.push(c)
    if(c.args.includes('origin-status'))return canonical({version:1,purpose:'clawpilot-native-email-initial-retained-origin-status',operationId:op,originSha256:digest})+'\n'
    assert.ok(c.args.includes('read-origin'));assert.ok(c.args.includes('--sha256='+digest));return bytes})
  assert.equal(await transport.originStatus(op),digest);assert.equal(await transport.readOrigin(op,digest),bytes)
  assert.equal(calls.length,2);assert.ok(calls.every(c=>!c.args.includes('publish-origin')))
  await assert.rejects(new Transport(target,async()=>bytes+'\n').readOrigin(op,digest),held)
})
await check('remote execute failure never retries; fresh resolver path is independent and missing retained source refuses',async()=>{
  const transport=new Transport(target,async()=>{throw Error('synthetic remote outcome lost')})
  const plan={operationId:op,nativeInstanceId:target.nativeInstanceId},planHash=sha(canonical(plan))
  const execution={plan,planHash,nativeDelta:{},approval:{proof:{planHash,preparedAt:'2026-11-03 00:00:00'}}}
  await assert.rejects(transport.execute(execution),held)
  transport.retainSourceDigest(op,sourceDigest);assert.throws(()=>transport.retainSourceDigest(op,'4'.repeat(64)),held)
  await assert.rejects(transport.execute(execution),/synthetic remote outcome lost/)
})
await check('private CLI rejects absent explicit operation approval before database access',async()=>{
  await assert.rejects(runOperator(['--action=reserve','--config=/not-opened','--config-sha256='+hash,'--operation='+op,'--source-sha256='+hash]),held)
  await assert.rejects(runOperator(['--action=execute','--config=/not-opened','--config-sha256='+hash,'--operation='+op,'--plan-sha256='+hash,'--approve-operation='+'5'.repeat(64)]),held)
  await assert.rejects(runOperator(['--action=preview','--config=/not-opened','--config-sha256='+hash,'--approve-operation='+op]),held)
  await assert.rejects(runOperator(['--action=recover-source','--config=/not-opened','--config-sha256='+hash,'--operation='+op,'--source-sha256='+hash,'--approve-operation='+op]),held)
  await assert.rejects(runOperator(['--action=recover-source','--config=/not-opened','--config-sha256='+hash,'--operation='+op,'--source-sha256='+hash,'--source-artifact-sha256='+hash]),held)
  const base=['--action=capture-replan-source','--config=/not-opened','--config-sha256='+hash,'--operation='+op,'--source-sha256='+hash]
  await assert.rejects(runOperator(base),held)
  await assert.rejects(runOperator([...base,'--predecessor-operation='+replanContext.rootOperationId,'--root-source-artifact-sha256='+hash,
    '--approve-operation='+op]),held)
  await assert.rejects(runOperator([...base,'--predecessor-operation='+op,'--approve-predecessor='+op,
    '--root-source-artifact-sha256='+hash,'--approve-operation='+op]),held)
  await assert.rejects(runOperator(['--action=preview','--config=/not-opened','--config-sha256='+hash,
    '--predecessor-operation='+replanContext.rootOperationId]),held)
})
await check('database parser rejects remote host and SSL overrides behind a loopback URL',()=>{
  const valid=databaseConfig('postgresql://owner:private@localhost:5433/fixture','fixture',databaseIdentity.sessionRole)
  assert.equal(valid.host,'localhost');assert.equal(valid.port,5433);assert.equal(valid.ssl,false);assert.equal(valid.database,'fixture')
  for(const url of ['postgresql://owner:private@localhost/fixture?host=remote.example&sslmode=disable',
    'postgresql://owner:private@localhost/fixture?host=remote.example','postgresql://owner:private@remote.example/fixture?sslmode=disable',
    'postgresql://owner:private@remote.example/fixture?sslmode=verify-full&sslmode=disable','postgresql://owner:private@localhost/fixture?user=other',
    'postgresql://other:private@localhost/fixture'])
    assert.throws(()=>databaseConfig(url,'fixture',databaseIdentity.sessionRole),held)
  assert.deepEqual(databaseConfig('postgresql://owner:private@remote.example/fixture?sslmode=verify-full','fixture',databaseIdentity.sessionRole).ssl,
    {rejectUnauthorized:true})
})
await check('every checked-out transaction binds physical cluster, database and both roles before its application query',async()=>{
  const identity={database_name:'fixture',database_oid:databaseIdentity.databaseOid,system_identifier:databaseIdentity.systemIdentifier,
    session_role:databaseIdentity.sessionRole,effective_role:databaseIdentity.effectiveRole,primary_server:true}
  const scripts=[[identity],[{...identity,system_identifier:'1'}],[identity]]
  const events=[]
  const pool={async connect(){const script=scripts.shift(),calls=[];events.push(calls)
    return {async query(sql,values){calls.push(sql)
      if(sql.includes('pg_catalog.pg_control_system()')){
        for(const expected of ['pg_catalog.pg_database','pg_catalog.current_database()','pg_catalog.pg_is_in_recovery()','SESSION_USER','CURRENT_USER'])
          assert.ok(sql.includes(expected))
        return {rows:script}
      }
      if(sql==='SELECT fixture'){assert.deepEqual(values,[37]);return {rows:[{value:37}]}}
      return {rows:[]}
    },release(){calls.push('RELEASE')}}
  }}
  const transaction=createTransaction(pool,'fixture',databaseIdentity)
  const work=async db=>(await db.query('SELECT fixture',[37])).rows[0].value
  assert.equal(await transaction(work),37)
  await assert.rejects(transaction(()=>assert.fail('Wrong cluster ran application SQL')),held)
  assert.equal(await transaction(work),37)
  for(const [index,steps]of events.entries()){
    assert.equal(steps[0],'BEGIN');assert.match(steps[1],/pg_catalog\.pg_control_system\(\)/u)
    assert.deepEqual(steps.slice(2),index===1?['ROLLBACK','RELEASE']:['SELECT fixture','COMMIT','RELEASE'])
  }
  for(const rows of [[],[identity,identity],[{...identity,database_name:'other'}],[{...identity,database_oid:'42'}],
    [{...identity,session_role:'other'}],[{...identity,effective_role:'other'}],[{...identity,primary_server:false}],
    new Error('postgres permission denied fixture private details')]){
    const steps=[]
    const tx=createTransaction({async connect(){return {async query(sql){steps.push(sql)
      if(sql.includes('pg_catalog.pg_control_system()')){if(rows instanceof Error)throw rows;return {rows}}
      return {rows:[]}
    },release(){steps.push('RELEASE')}}}},'fixture',databaseIdentity)
    await assert.rejects(tx(()=>assert.fail('Unproven session ran application SQL')),
      e=>e?.code==='initial_private_operator_database_identity_unproven'&&!JSON.stringify(e).includes('private details'))
    assert.deepEqual(steps.slice(2),['ROLLBACK','RELEASE'])
  }
  for(const pins of [null,{...databaseIdentity,systemIdentifier:42},{...databaseIdentity,systemIdentifier:'18446744073709551616'},
    {...databaseIdentity,databaseOid:'4294967296'},{...databaseIdentity,databaseOid:'016384'},
    {...databaseIdentity,sessionRole:'owner\n'},{...databaseIdentity,effectiveRole:''},{...databaseIdentity,unexpected:true}]){
    assert.throws(()=>createTransaction({connect(){assert.fail('Invalid config attempted to connect')}},'fixture',pins),held)
  }
})
await check('lost origin publication retries reuse original signed bytes after fresh immutable-origin verification',()=>{
  const keys=generateKeyPairSync('rsa',{modulusLength:3072}),publicKey=keys.publicKey.export({type:'spki',format:'pem'})
  const proof={version:1,purpose:'clawpilot-native-email-initial-activation-origin',issuedAt:Math.floor(Date.now()/1000)-60,
    operationId:op,planHash:hash,initialReceiptHash:'6'.repeat(64)}
  const envelope={proof,signature:sign('sha256',Buffer.from(canonical(proof),'ascii'),{key:keys.privateKey,padding:constants.RSA_PKCS1_PADDING}).toString('base64')}
  const fresh={proof:{...proof,issuedAt:proof.issuedAt+30},signature:'not-used-as-retained-proof'}
  assert.deepEqual(reuseOrigin(fresh,envelope,publicKey),envelope)
  assert.throws(()=>reuseOrigin({...fresh,proof:{...fresh.proof,planHash:'7'.repeat(64)}},envelope,publicKey),held)
  assert.throws(()=>reuseOrigin(fresh,{...envelope,signature:'A'.repeat(512)},publicKey),held)
})
await check('actual child receives fixed production mode but not arbitrary application environment',async()=>{
  const key='CLAWPILOT_INITIAL_TEST_NONSECRET_SENTINEL',previous=process.env[key],previousMode=process.env.NODE_ENV
  process.env[key]='must-not-be-inherited';process.env.NODE_ENV='test'
  try{const value=JSON.parse(await createRunner(1000,100)({program:process.execPath,args:['-e',
    'process.stdout.write(JSON.stringify({mode:process.env.NODE_ENV,leaked:Object.hasOwn(process.env,"CLAWPILOT_INITIAL_TEST_NONSECRET_SENTINEL"),keys:Object.keys(process.env).sort()}))']}))
    assert.equal(value.mode,'production');assert.equal(value.leaked,false)
    const allowed=['NODE_ENV','PATH','HOME','USER','LOGNAME','TMPDIR','SSH_AUTH_SOCK','RAILWAY_API_TOKEN','RAILWAY_TOKEN','RAILWAY_CONFIG_DIR']
    // CoreFoundation adds this locale metadata on macOS even for a stripped
    // spawn environment; it is not copied by the application allowlist.
    if(process.platform==='darwin')allowed.push('__CF_USER_TEXT_ENCODING')
    assert.ok(value.keys.every(key=>allowed.includes(key)),
      'Unexpected child environment keys: '+JSON.stringify(value.keys.filter(key=>!allowed.includes(key))))
  }finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous
    if(previousMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousMode}
})
await check('owned transport ignoring SIGTERM returns bounded unknown without retry and is force-cleaned',async()=>{
  const run=createRunner(250,100),start=Date.now();let calls=0
  await assert.rejects((()=>{calls++;return run({program:process.execPath,args:['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]})})(),/remote_outcome_unknown/)
  assert.equal(calls,1);assert.ok(Date.now()-start<2000)
  await new Promise(resolve=>setTimeout(resolve,250))
  assert.throws(()=>createRunner(60001,100),held)
})
console.log(JSON.stringify({passed:true,checks,buildSourceCount:Object.keys(manifest.sources).length,
  boundary:'compiled production graph and synthetic command contract only; no PG/native activation or production proof'}))
