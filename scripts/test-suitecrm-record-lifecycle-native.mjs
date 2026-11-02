#!/usr/bin/env node
// Opt-in pinned real SuiteCRM/OAuth acceptance. Synthetic data; no host ports,
// external network, provider credentials, downloads, or production writes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createDisposablePostgresRuntime, DISPOSABLE_POSTGRES_LABEL, DISPOSABLE_POSTGRES_OWNER_LABEL } from './lib/disposable-postgres-docker.mjs'
import { runStorageGuard } from './local-storage-guard.mjs'

const argument=process.argv.slice(2)
assert.equal(argument.length,1,'Use --source-zip=/absolute/owned/SuiteCRM-8.10.1.zip')
assert.ok(argument[0].startsWith('--source-zip='))
const archive=argument[0].slice('--source-zip='.length)
assert.ok(isAbsolute(archive))
const stat=lstatSync(archive)
assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&stat.size<180000000)
const sha='b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7'
assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'),sha,'Only the pinned official release is admitted')
assert.equal(runStorageGuard({argv:['--preflight'],environment:process.env}),0)
const execute=(command,args,extra={})=>execFileSync(command,args,{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,...extra})
const docker=(args,extra)=>execute('docker',args,extra)
const image=tag=>JSON.parse(docker(['image','inspect',tag]))[0]
const php=image('clawpilot-suitecrm-native-acceptance:8.10.1-php83'),db=image('mariadb:11.4.13')
assert.ok(php.Config.Env.includes('PHP_VERSION=8.3.35'))
assert.deepEqual(Object.keys(php.Config.Volumes||{}),[])
assert.deepEqual(Object.keys(db.Config.Volumes||{}),['/var/lib/mysql'])
const root=mkdtempSync(join(tmpdir(),'clawpilot-record-native.')),owner=randomUUID()
writeFileSync(join(root,'owner.json'),JSON.stringify({owner,pid:process.pid}),{flag:'wx',mode:0o600})
const name='clawpilot-record-native-'+process.pid+'-'+owner.slice(0,8),database=name+'-db',app=name+'-app',network=name+'-net'
const label='com.clawpilot.record-lifecycle-native-owner'
const lease=createDisposablePostgresRuntime({environment:process.env})
let admitted=false,networkCreated=false,appCreated=false,cleaning=false
function ownedContainer(candidate) {
  let current
  try { current=JSON.parse(docker(['inspect',candidate],{stdio:['ignore','pipe','pipe']}))[0] }
  catch(error) { if(/No such (?:object|container)/i.test(String(error.stderr)))return;throw error }
  assert.equal(current.Config.Labels[label],owner,'Never remove an unowned or replacement container')
  docker(['rm','--force','--volumes',current.Id])
}
function cleanup() {
  if(cleaning)return;cleaning=true
  const failures=[],attempt=fn=>{try{fn()}catch(error){failures.push(error)}}
  if(appCreated)attempt(()=>ownedContainer(app))
  if(admitted)attempt(()=>assert.equal(lease.cleanup(),true))
  if(networkCreated)attempt(()=>{
    const current=JSON.parse(docker(['network','inspect',network]))[0]
    assert.equal(current.Labels[label],owner);assert.equal(Object.keys(current.Containers||{}).length,0)
    docker(['network','rm',current.Id])
  })
  attempt(()=>{
    assert.equal(JSON.parse(readFileSync(join(root,'owner.json'),'utf8')).owner,owner)
    assert.match(root,/\/clawpilot-record-native\.[a-zA-Z0-9]+$/)
    rmSync(root,{recursive:true}) // Exact owner-marked extracted synthetic fixture only.
  })
  if(failures.length)throw new AggregateError(failures,'Exact native fixture cleanup failed')
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{try{cleanup()}finally{process.exit(signal==='SIGINT'?130:143)}})
const limits=(memory,cpus)=>['--memory',memory,'--memory-swap',memory,'--cpus',cpus,'--pids-limit','128',
  '--log-driver','local','--log-opt','max-size=2m','--log-opt','max-file=2','--label',label+'='+owner]
try {
  const leaseOwner=lease.admit(database);admitted=true
  execute('unzip',['-q',archive,'-d',join(root,'suitecrm')])
  docker(['network','create','--internal','--label',label+'='+owner,network]);networkCreated=true
  docker(['run','--rm','-d','--pull=never','--name',database,'--network',network,'--network-alias','db',
    ...limits('640m','0.5'),'--label',DISPOSABLE_POSTGRES_LABEL+'=true','--label',DISPOSABLE_POSTGRES_OWNER_LABEL+'='+leaseOwner,
    '--tmpfs','/var/lib/mysql:rw,nosuid,size=320m',
    '-e','MARIADB_ROOT_PASSWORD=Synthetic-native-root-password-only','-e','MARIADB_DATABASE=suitecrm_native_test',
    '-e','MARIADB_USER=fixture','-e','MARIADB_PASSWORD=Synthetic-native-db-password-only',db.Id,
    '--skip-log-bin','--innodb-buffer-pool-size=64M','--max-connections=20','--performance-schema=OFF'])
  for(let attempt=0;;attempt++) {
    try{docker(['exec',database,'healthcheck.sh','--connect','--innodb_initialized'],{stdio:['ignore','pipe','pipe']});break}
    catch(error){if(attempt>80)throw error;await new Promise(resolve=>setTimeout(resolve,500))}
  }
  docker(['create','--rm','--pull=never','--name',app,'--network',network,'--read-only',
    ...limits('1152m','1'),'--cap-drop','ALL','--security-opt','no-new-privileges',
    '--tmpfs','/app:rw,nosuid,size=640m','--tmpfs','/tmp:rw,nosuid,size=32m',
    '--mount','type=bind,source='+join(root,'suitecrm')+',target=/source/suitecrm,readonly',
    '--mount','type=bind,source='+resolve('scripts/fixtures/record-lifecycle-native')+',target=/fixture,readonly',
    '--mount','type=bind,source='+resolve('services/suitecrm')+',target=/package,readonly',
    '-e','CLAWPILOT_RECORD_LIFECYCLE_NATIVE_TEST=1','--entrypoint','/bin/sh',php.Id,'/fixture/bootstrap.sh'])
  appCreated=true
  let output
  try { output=docker(['start','--attach',app],{timeout:240000}) }
  catch(error) {
    const text=String(error.stdout||'')+'\n'+String(error.stderr||'')
    throw new Error('Isolated native acceptance failed:\n'+text.split('\n').filter(line=>!/^Deprecated:/.test(line)).slice(-18).join('\n'))
  }
  assert.match(output,/NATIVE_RECORD_LIFECYCLE_ACCEPTANCE_PASSED=7/)
  console.log(output.split('\n').filter(line=>/^(PASS |NATIVE_RECORD_)/.test(line)).join('\n'))
  console.log('PASS pinned SuiteCRM 8.10.1 / PHP 8.3.35 / MariaDB 11.4.13; real OAuth and V8 delete, no production proof')
} finally { cleanup() }
