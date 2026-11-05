#!/usr/bin/env node
// Actual PHP route catch, a throwing service and real PHP error log. This is
// only a logging/privacy contract; no OAuth/native/database proof.
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
const root=mkdtempSync(join(tmpdir(),'clawpilot-authority-diagnostic-'))
const route=readFileSync('services/suitecrm/email-audience/authority-routes.php','utf8')
const catchBody=route.slice(route.indexOf('}catch(Throwable $error){')+'}catch(Throwable $error){'.length,route.lastIndexOf('\n        }'))
assert.ok(catchBody.includes('error_log('));assert.doesNotMatch(catchBody,/getMessage|getTrace|\$command|\$authorization|\$body|\$request/)
const test=`<?php
class ClawPilotNativeEmailTransactionRefused extends RuntimeException{function __construct(public string $holdCode){parent::__construct('SECRET_EXCEPTION');}}
class Response{function withJson($value,$status){return ['value'=>$value,'status'=>$status];}}
$run=static function($error){$response=new Response;${catchBody}};
foreach(['commit_deadline_exceeded','authority_before_policy_changed','SECRET_TOKEN\nBAD'] as $code){
 $result=$run(new ClawPilotNativeEmailTransactionRefused($code));
 if($result!==['value'=>['ok'=>false,'code'=>'NATIVE_EMAIL_AUTHORITY_HELD'],'status'=>409])throw new RuntimeException('Public diagnostic leaked');}
$run(new RuntimeException('SECRET_EXCEPTION'));
echo "DIAGNOSTIC_CONTRACT_PASSED=1\\n";
`
try{
  writeFileSync(join(root,'test.php'),test)
  const output=execFileSync('docker',['run','--rm','--pull=never','--name','clawpilot-authority-log-'+randomUUID().slice(0,8),'--network','none','--read-only',
    '--memory','64m','--memory-swap','64m','--cpus','0.5','--pids-limit','32','--tmpfs','/tmp:rw,size=8m',
    '--mount',`type=bind,source=${root},target=/fixture,readonly`,'--entrypoint','/bin/sh','clawpilot-suitecrm-native-acceptance:8.10.1-php83','-ec',
    'php -d log_errors=1 -d error_log=/tmp/diagnostic.log /fixture/test.php; cat /tmp/diagnostic.log'],
  {encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']})
  assert.match(output,/DIAGNOSTIC_CONTRACT_PASSED=1/);assert.match(output,/CLAWPILOT_NATIVE_AUTHORITY_HELD=commit_deadline_exceeded/)
  assert.match(output,/CLAWPILOT_NATIVE_AUTHORITY_HELD=authority_before_policy_changed/)
  assert.match(output,/CLAWPILOT_NATIVE_AUTHORITY_HELD=unexpected_native_failure/)
  assert.doesNotMatch(output,/SECRET_EXCEPTION|SECRET_TOKEN|BAD/)
  console.log('PASS actual PHP catch logs only bounded hold codes, sanitizes unexpected errors and retains generic public 409')
}finally{rmSync(root,{recursive:true,force:true})}
