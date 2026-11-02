#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root=fileURLToPath(new URL('..',import.meta.url))
execFileSync(process.execPath,['scripts/local-storage-guard.mjs','--preflight'],{cwd:root,stdio:'inherit'})
const key=`clawpilot-record-lifecycle-${process.pid}-${randomUUID().slice(0,8)}`
const network=`${key}-net`,database=`${key}-db`,php=`${key}-php`
const docker=(args,options={})=>execFileSync('docker',args,{encoding:'utf8',timeout:60000,...options})
let networkCreated=false
function removeOwned(name) {
  let owner
  try { owner=docker(['inspect','--format','{{index .Config.Labels "clawpilot.test.owner"}}',name],{stdio:'pipe'}).trim() }
  catch { return }
  if(owner!==key)throw new Error('Refusing cleanup of an unowned test container')
  docker(['rm','--force','--volumes',name])
}
try {
  docker(['image','inspect','mariadb:11.4.13'])
  docker(['image','inspect','clawpilot-suitecrm-native-acceptance:8.10.1-php83'])
  docker(['network','create','--internal','--label',`clawpilot.test.owner=${key}`,network]);networkCreated=true
  docker(['run','--rm','-d','--pull','never','--name',database,'--network',network,'--network-alias','db',
    '--label',`clawpilot.test.owner=${key}`,'--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','128',
    '--tmpfs','/var/lib/mysql:rw,nosuid,nodev,size=256m','--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=2',
    '-e','MARIADB_ROOT_PASSWORD=Synthetic-root-password-only','-e','MARIADB_DATABASE=clawpilot_record_lifecycle_test',
    '-e','MARIADB_USER=fixture','-e','MARIADB_PASSWORD=Synthetic-record-lifecycle-db-password-only','mariadb:11.4.13'])
  for(let attempt=0;;attempt++) {
    try { docker(['exec',database,'healthcheck.sh','--connect','--innodb_initialized'],{stdio:'pipe'});break }
    catch(error) { if(attempt>45)throw error;await new Promise(resolve=>setTimeout(resolve,500)) }
  }
  const output=docker(['run','--rm','--pull','never','--name',php,'--network',network,'--read-only',
    '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--memory-swap','128m','--cpus','1','--pids-limit','64',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=32m','--label',`clawpilot.test.owner=${key}`,
    '-v',`${root}:/repo:ro`,'-w','/repo','-e','CLAWPILOT_RECORD_LIFECYCLE_DISPOSABLE_TEST=1',
    '--entrypoint','php','clawpilot-suitecrm-native-acceptance:8.10.1-php83','scripts/fixtures/suitecrm-record-lifecycle-mariadb.php'])
  process.stdout.write(output)
} finally {
  // Only exact locally-created resources, never broad prune or unknown volumes.
  removeOwned(php)
  removeOwned(database)
  if(networkCreated)docker(['network','rm',network])
}
