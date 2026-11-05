#!/usr/bin/env node
// Fast PHP orchestration test only: framework/SQL stand-ins, no native ACL or
// database proof. It catches CLI/global-scope handoff errors before the full run.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {generateKeyPairSync,randomUUID} from 'node:crypto'
const root=mkdtempSync(join(tmpdir(),'clawpilot-combined-harness-')),name='clawpilot-combined-harness-'+randomUUID().slice(0,8)
const source=readFileSync('scripts/fixtures/native-email-audience-real/native-app-pg.php','utf8')
assert.match(source,/\(static function\(\)use\(\$argv\):void/)
const shim=`<?php
function must($ok,$message){if(!$ok)throw new RuntimeException($message);}
class DBManagerFactory{static $manager;static function getInstance(){return self::$manager;}}
DBManagerFactory::$manager=(object)['database'=>(object)['fixture'=>true]];$GLOBALS['db']=DBManagerFactory::$manager;
if(!is_dir('/app/public/legacy'))mkdir('/app/public/legacy',0755,true);
chdir('/app/public/legacy');
foreach(['custom/include/ClawPilot','custom/application/Ext/Api/V8/Config'] as $dir)if(!is_dir($dir))mkdir($dir,0755,true);
if(!is_file('config_override.php'))file_put_contents('config_override.php',"<?php\\n");
$GLOBALS['sugar_config']=['dbconfig'=>['db_name'=>'suitecrm_native_test']];require 'config_override.php';
function rows($sql){return [['id'=>'1']];}function fresh($module,$id){return (object)['id'=>$id];}
function selectUser($user){$GLOBALS['current_user']=$user;}
#[AllowDynamicProperties] class FixtureClient{public $id='00000000-0000-4000-8000-000000000901';function save($notify){return true;}}
function native($module){return new FixtureClient;}
class ClawPilotNativeEmailRuntime{static function attest($db){must($GLOBALS['db']===DBManagerFactory::getInstance(),'Global native manager overwritten');
  must(($GLOBALS['sugar_config']['clawpilot_managed_email_write_scope']??false)===true,'Fresh worker flag missing');return str_repeat('a',64);}}
function authorityRows($db,$sql){if(str_contains($sql,'runtime_fingerprint'))return [['runtime_fingerprint'=>str_repeat('a',64)]];
 return [['email_id'=>'00000000-0000-4000-8000-000000000101','global_id'=>'gi1234567','local_id'=>'00000000-0000-4000-8000-000000000102',
 'pipeline_id'=>'00000000-0000-4000-8000-000000000103','workspace_id'=>'00000000-0000-4000-8000-000000000104']];}
function authorityContent($db){must($GLOBALS['db']===DBManagerFactory::getInstance(),'Global native manager overwritten');return str_repeat('b',64);}
`
try{
  writeFileSync(join(root,'actual.php'),source.replace("require '/fixture/native-authority-transition.php';","require '/fixture/shim.php';"))
  writeFileSync(join(root,'shim.php'),shim)
  writeFileSync(join(root,'public.pem'),generateKeyPairSync('rsa',{modulusLength:3072}).publicKey.export({type:'spki',format:'pem'}))
  const output=execFileSync('docker',['run','--rm','--pull=never','--name',name,'--network','none','--read-only',
    '--memory','128m','--memory-swap','128m','--cpus','0.5','--pids-limit','32','--tmpfs','/tmp:rw,size=8m','--tmpfs','/app:rw,size=16m',
    '--mount',`type=bind,source=${root},target=/fixture,readonly`,'--mount',`type=bind,source=${resolve('services/suitecrm')},target=/source,readonly`,
    '-e','CLAWPILOT_NATIVE_FIXTURE_APP_PG=1','-e','CLAWPILOT_NATIVE_FIXTURE_REMEDIATION=1','--entrypoint','/bin/sh',
    'clawpilot-suitecrm-native-acceptance:8.10.1-php83','-ec',
    'php -l /fixture/actual.php; php /fixture/actual.php prepare </fixture/public.pem; php /fixture/actual.php profile; php /fixture/actual.php content'],
  {encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']})
  assert.match(output,/NATIVE_APP_PG_PREPARED=1/);assert.match(output,/NATIVE_APP_PG_FRESH_RUNTIME_PASSED=1/)
  assert.match(output,/"contentDigest":"b{64}"/)
  console.log('PASS combined CLI argv, native global manager, persisted fresh-worker flag, source copying and content handoff; simulated framework/SQL only')
}finally{rmSync(root,{recursive:true,force:true})}
