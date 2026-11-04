#!/usr/bin/env node
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {createDisposablePostgresRuntime,DISPOSABLE_POSTGRES_LABEL,DISPOSABLE_POSTGRES_OWNER_LABEL} from './lib/disposable-postgres-docker.mjs'
const root=resolve('.'),key='clawpilot-native-batches-'+process.pid+'-'+randomUUID().slice(0,8)
const database=key+'-db',php=key+'-php',network=key+'-net',label='clawpilot.native-batch.owner'
const docker=(args,extra={})=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],...extra})
const environment={...process.env,CI:'',VERCEL:'',VERCEL_ENV:''}
for(const name of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID'])delete environment[name]
const lease=createDisposablePostgresRuntime({environment});let admitted=false,networkCreated=false
function removePhp(){let current;try{current=JSON.parse(docker(['inspect',php]))[0]}catch{return}
  assert.equal(current.Config.Labels[label],key);docker(['rm','--force','--volumes',current.Id])}
try{
  docker(['image','inspect','mariadb:11.4.13']);docker(['image','inspect','clawpilot-suitecrm-native-acceptance:8.10.1-php83'])
  const token=lease.admit(database);admitted=true
  docker(['network','create','--internal','--label',label+'='+key,network]);networkCreated=true
  docker(['run','--rm','--detach','--pull=never','--name',database,'--network',network,'--network-alias','db',
    '--label',DISPOSABLE_POSTGRES_LABEL+'=true','--label',DISPOSABLE_POSTGRES_OWNER_LABEL+'='+token,
    '--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','128',
    '--tmpfs','/var/lib/mysql:rw,nosuid,nodev,size=256m','--log-driver','json-file','--log-opt','max-size=1m','--log-opt','max-file=1',
    '-e','MARIADB_ROOT_PASSWORD=Synthetic-root-only-password','-e','MARIADB_DATABASE=suitecrm_native_batch_test',
    '-e','MARIADB_USER=fixture','-e','MARIADB_PASSWORD=Synthetic-batch-only-password','mariadb:11.4.13',
    '--skip-log-bin','--innodb-buffer-pool-size=64M','--max-connections=10','--performance-schema=OFF'])
  for(let n=0;;n++){try{docker(['exec',database,'healthcheck.sh','--connect','--innodb_initialized']);break}
    catch(error){if(n>=60)throw error;await new Promise(done=>setTimeout(done,250))}}
  const state=JSON.parse(docker(['inspect',database]))[0]
  assert.ok(state.Mounts.every(m=>m.Type!=='volume'));assert.equal(Object.keys(state.HostConfig.PortBindings||{}).length,0)
  process.stdout.write(docker(['run','--rm','--pull=never','--name',php,'--network',network,'--read-only',
    '--label',label+'='+key,'--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--memory-swap','128m',
    '--cpus','1','--pids-limit','32','--mount','type=bind,source='+root+',target=/repo,readonly',
    '-e','CLAWPILOT_NATIVE_BATCH_DISPOSABLE_TEST=1','--entrypoint','php','clawpilot-suitecrm-native-acceptance:8.10.1-php83',
    '/repo/scripts/fixtures/native-email-write-batches-mariadb.php']))
}finally{
  removePhp();if(admitted)assert.equal(lease.cleanup(),true)
  if(networkCreated){const owned=JSON.parse(docker(['network','inspect',network]))[0]
    assert.equal(owned.Labels[label],key);assert.equal(Object.keys(owned.Containers||{}).length,0);docker(['network','rm',network])}
}
