#!/usr/bin/env node
// Filesystem-only isolated PHP test. No DB, host port, provider or live config.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {createHash,randomBytes} from 'node:crypto'
import {resolve} from 'node:path'

assert.equal(process.argv.length,2,'This fixture takes no remote or image arguments')
execFileSync(process.execPath,['scripts/local-storage-guard.mjs','--preflight'],{stdio:'inherit'})
const entrypoint=readFileSync('services/suitecrm/entrypoint.sh','utf8')
const startup=entrypoint.indexOf('$(php /opt/clawpilot/native-email-startup-check.php)')
assert.ok(startup>0&&startup<entrypoint.indexOf('require_value()')&&startup<entrypoint.indexOf('rm -rf "$APP_ROOT"'),
  'Startup hold must precede normal bootstrap and application mutation')
assert.match(entrypoint,/if \[\[ "\$CLAWPILOT_NATIVE_RUNTIME_MODE" == "legacy" \]\]; then\s+su [^\n]+install-email-audience\.php/)
assert.match(entrypoint,/if \[\[ "\$CLAWPILOT_NATIVE_RUNTIME_MODE" == "legacy" \]\]; then\s+if \[\[ "\$\{CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED:-\}" == "1" \]\]; then/)
execFileSync('/bin/bash',['-n','services/suitecrm/entrypoint.sh'],{stdio:'pipe'})
const execute=args=>execFileSync('docker',args,{encoding:'utf8',timeout:60000,maxBuffer:131072,stdio:['ignore','pipe','pipe']})
const name='clawpilot-runtime-install-fs-'+process.pid+'-'+randomBytes(5).toString('hex')
const label='com.clawpilot.runtime-install-fs-test',owner=randomBytes(24).toString('hex')
const image=JSON.parse(execute(['image','inspect','clawpilot-suitecrm-native-acceptance:8.10.1-php83-8.3.36']))[0]
assert.ok(image.Config.Env.includes('PHP_VERSION=8.3.36'),'Exact cached PHP patch required')
assert.equal(Object.keys(image.Config.Volumes??{}).length,0,'Filesystem fixture image must declare no volumes')
const paths=['services/suitecrm/install-native-email-runtime.php','services/suitecrm/install-native-email-scope.php',
  'services/suitecrm/native-email-scope/Patch.php','scripts/fixtures/native-email-runtime-installer.php',
  'services/suitecrm/native-email-startup-check.php','services/suitecrm/entrypoint.sh',
  'services/suitecrm/Dockerfile','scripts/test-native-email-runtime-installer.mjs']
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const hashes=Object.fromEntries(paths.map(path=>[path,digest(path)]))
let created=false
try{
  execute(['create','--rm','--pull=never','--name',name,'--label',label+'='+owner,'--network','none',
    '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--memory-swap','128m',
    '--cpus','0.5','--pids-limit','32','--log-driver','json-file','--log-opt','max-size=1m','--log-opt','max-file=1',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=32m','--mount','type=bind,source='+resolve('services/suitecrm')+',target=/source,readonly',
    '--mount','type=bind,source='+resolve(paths[3])+',target=/fixture.php,readonly',
    '--env','CLAWPILOT_RUNTIME_INSTALLER_TEST=1','--entrypoint','php',image.Id,'/fixture.php'])
  created=true
  const output=execute(['start','--attach',name])
  assert.match(output,/NATIVE_RUNTIME_INSTALLER_PASSED=6;/)
  for(const [path,hash]of Object.entries(hashes))assert.equal(digest(path),hash,'Installer source changed during test: '+path)
  console.log(output.trim())
  console.log(JSON.stringify({kind:'native-runtime-installer-filesystem-proof',php:'8.3.36',image:image.Id,
    sourceHashes:hashes,syntheticPackageContents:true,nativeDatabase:false,productionTouched:false}))
}finally{
  if(created){
    let found=null
    try{found=JSON.parse(execute(['inspect',name]))[0]}catch(error){
      const message=String(error.stderr??'').toLowerCase()
      if(error.status!==1||!message.includes('no such object: '+name)&&!message.includes('no such container: '+name))throw error
    }
    if(found){assert.equal(found.Config.Labels[label],owner,'Refuse cleanup of another owner');
      assert.ok(found.Mounts.every(mount=>mount.Type!=='volume'),'Unexpected fixture volume requires inspection')
      execute(['rm','--force','--volumes',name])}
  }
}
