#!/usr/bin/env node
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {nativeRuntimeFixtureProfile} from './lib/native-runtime-fixture-profile.mjs'
import {runStorageGuard} from './local-storage-guard.mjs'
assert.equal(process.versions.node.split('.')[0],'24')
assert.equal(process.argv.length,2)
const env={...process.env,CI:'',VERCEL:'',VERCEL_ENV:''};for(const k of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID'])delete env[k]
assert.equal(runStorageGuard({argv:['--preflight'],environment:env}),0)
const image=nativeRuntimeFixtureProfile('8.3.36').image
const run=(args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024,timeout:30000})
const info=JSON.parse(run(['image','inspect',image]))[0];assert.equal(info.Config.Env.find(x=>x.startsWith('PHP_VERSION=')),'PHP_VERSION=8.3.36')
assert.deepEqual(Object.keys(info.Config.Volumes??{}),[])
const sources=['services/suitecrm/native-email-initial-artifacts.php','services/suitecrm/native-email-initial-cli.php',
  'scripts/fixtures/native-email-initial-artifacts.php']
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex'),hashes=Object.fromEntries(sources.map(p=>[p,sha(p)]))
const owner=randomUUID(),name='cp-initial-artifact-'+process.pid+'-'+owner.slice(0,8),label='com.clawpilot.initial-artifact-fixture'
const common=['run','--rm','--name',name,'--label',label+'='+owner,'--pull=never','--network=none','--read-only','--memory=128m','--memory-swap=128m','--cpus=0.5','--pids-limit=64',
  '--log-driver=json-file','--log-opt=max-size=1m','--log-opt=max-file=1','--cap-drop=ALL','--security-opt=no-new-privileges',
  '--tmpfs','/work:rw,nosuid,nodev,noexec,size=8m,mode=0700','--mount',`type=bind,src=${resolve('services/suitecrm')},dst=/source,readonly`,
  '--mount',`type=bind,src=${resolve('scripts/fixtures/native-email-initial-artifacts.php')},dst=/fixture.php,readonly`,image]
try{
  for(const file of ['/source/native-email-initial-artifacts.php','/fixture.php'])process.stdout.write(run([...common,'-l',file]))
  process.stdout.write(run([...common,'/fixture.php']))
  for(const [path,expected]of Object.entries(hashes))assert.equal(sha(path),expected)
}finally{
  let live
  try{live=JSON.parse(run(['inspect',name]))[0]}catch(e){if(!/no such (?:object|container)/i.test(String(e.stderr)))throw e}
  if(live){assert.equal(live.Config.Labels?.[label],owner);assert.ok(live.Mounts.every(m=>m.Type!=='volume'));run(['rm','--force','--volumes',live.Id])}
}
console.log('PASS 3 consumed source hashes unchanged; exact owned tmpfs container cleaned; no database/volume created')
