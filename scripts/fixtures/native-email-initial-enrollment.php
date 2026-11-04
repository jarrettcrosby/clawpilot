<?php
declare(strict_types=1);
// Pure contract/cryptography only: no database, bootstrap, mutation or native
// receipt is created. Reflection reaches only the production value verifier.
require_once __DIR__.'/../../services/suitecrm/email-audience/NativeEmailInitialEnrollment.php';
$C=ClawPilotNativeEmailAuthorityContract::class;$checks=0;
function initialPureNeed(bool $condition,string $message): void {if(!$condition)throw new RuntimeException($message);}
function initialPureReject(callable $run): void {try{$run();}catch(Throwable $error){return;}throw new RuntimeException('Expected a held initial proposal');}
function initialPureId(int $n): string {return '00000000-0000-4000-8000-'.str_pad((string)$n,12,'0',STR_PAD_LEFT);}
function initialPureMatrix(array $readers): array {return array_fill_keys(['view','list','export','edit','delete'],$readers);}
function initialPurePlan(): array
{
    $C=ClawPilotNativeEmailAuthorityContract::class;$principals=['1','denied','viewer'];$pipelines=[];
    foreach([['1','viewer'],['1']] as $index=>$readers){$pipeline=initialPureId(10+$index);$workspace=initialPureId(20+$index);
        $audience=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>'1','allowedSuiteCrmUserIds'=>$readers,
            'workspaceId'=>$workspace,'pipelineId'=>$pipeline],JSON_THROW_ON_ERROR));
        $pipelines[]=['groupId'=>initialPureId(30+$index),'policy'=>['version'=>2,'pipelineId'=>$pipeline,'workspaceId'=>$workspace,
            'ownerSuiteCrmId'=>'1','audienceFingerprint'=>$audience,'principalSuiteCrmUserIds'=>$principals,'futureCreate'=>initialPureMatrix($readers),'historical'=>[]]];}
    $emails=[];foreach($pipelines as $index=>$pipeline){$p=$pipeline['policy'];$before=['localId'=>initialPureId(100+$index),'nativeId'=>'native-'.($index+1),
        'globalId'=>'gi'.(1000000+$index),'pipelineId'=>$p['pipelineId'],'workspaceId'=>$p['workspaceId'],'archived'=>$index===0,
        'recordFingerprint'=>hash('sha256','native-content-'.$index),'capabilities'=>initialPureMatrix(['1','viewer'])];
        $after=$before;$after['capabilities']=$p['futureCreate'];$emails[]=['before'=>$before,'after'=>$after];}
    $defaults=[];foreach(['delete','edit','export','list','view'] as $action)$defaults[]=[
        'before'=>['id'=>'action-'.$action,'action'=>$action,'aclAccess'=>90],
        'after'=>['id'=>'action-'.$action,'action'=>$action,'aclAccess'=>in_array($action,['edit','delete'],true)?75:80]];
    $revocations=[];foreach(['delete','edit','export','list','view'] as $surface)$revocations[]=['nativeId'=>'native-2','surface'=>$surface,'principalId'=>'viewer'];
    return ['version'=>1,'kind'=>'initial_enrollment_plan_v1','operationId'=>hash('sha256','synthetic-operation'),'nativeInstanceId'=>'native-fixture',
        'appGeneration'=>7,'appSourceFingerprint'=>hash('sha256','app-source'),'nativePolicyBeforeFingerprint'=>hash('sha256','before-policy'),
        'nativeRuntimeBeforeFingerprint'=>hash('sha256','source-runtime'),'nativePolicyAfterFingerprint'=>hash('sha256','after-policy'),
        'nativeRuntimeAfterFingerprint'=>hash('sha256','after-runtime'),'principalSuiteCrmUserIds'=>$principals,'defaults'=>$defaults,
        'emails'=>$emails,'pipelines'=>$pipelines,'reviewedRevocations'=>$revocations,'rootEmployeeGrants'=>[]];
}
$check=static function(string $name,callable $run)use(&$checks):void{$run();$checks++;fwrite(STDOUT,'PASS '.$name."\n");};
$plan=initialPurePlan();
$check('native value verifier accepts exact archived identities, retained writers and reviewed revocations without execution',static function()use($plan):void{
    $before=$plan;ClawPilotNativeEmailInitialEnrollment::validatePlan($plan);initialPureNeed($plan===$before,'Value verifier mutated its input');
    $reordered=$plan;foreach($reordered['defaults'] as &$row)$row['after']=array_reverse($row['after'],true);unset($row);
    ClawPilotNativeEmailInitialEnrollment::validatePlan($reordered);
});
$check('native contract rejects identity/content/archive drift, implicit grants and incomplete default coverage',static function()use($plan):void{
    foreach(['nativeId','localId','globalId','pipelineId','workspaceId','recordFingerprint','archived'] as $field){$p=$plan;
        $p['emails'][0]['after'][$field]=$field==='archived'?false:($field==='globalId'?'gi9999999':($field==='nativeId'?'other':($field==='recordFingerprint'?hash('sha256','changed'):initialPureId(999))));
        initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($p));}
    foreach(['view','edit'] as $surface){$p=$plan;$p['emails'][1]['after']['capabilities'][$surface]=['1','viewer'];
        initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($p));}
    $p=$plan;$p['rootEmployeeGrants']=[['userId'=>'viewer']];initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($p));
    $p=$plan;array_pop($p['defaults']);initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($p));
    $p=$plan;$p['defaults'][0]['after']['aclAccess']=90;initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($p));
});
$check('duplicate mappings and unreviewed removal cannot be hidden in a partial native inventory',static function()use($plan):void{
    foreach(['nativeId','localId','globalId'] as $field){$p=$plan;$p['emails'][1]['before'][$field]=$p['emails'][0]['before'][$field];
        initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($p));}
    $p=$plan;array_pop($p['reviewedRevocations']);initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($p));
    $p=$plan;$p['emails'][0]['after']['capabilities']['edit']=['1'];initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($p));
    $p=$plan;$p['activationReceiptHash']=hash('sha256','fake');initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($p));
});
$key=openssl_pkey_new(['private_key_bits'=>3072,'private_key_type'=>OPENSSL_KEYTYPE_RSA]);initialPureNeed($key!==false,'Synthetic RSA key required');
$details=openssl_pkey_get_details($key);putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID=initial-fixture-key');
putenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID=native-fixture');putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='.$details['key']);
$installation=['sourceRuntimeFingerprint'=>$plan['nativeRuntimeBeforeFingerprint'],'installedRuntimeFingerprint'=>hash('sha256','installed-runtime'),
    'installationJournalFingerprint'=>hash('sha256','synthetic-journal')];
$forecast=['planHash'=>$C::digest($plan),'preparedAt'=>gmdate('Y-m-d H:i:s'),'deltaFingerprint'=>hash('sha256','synthetic-delta')];
$proof=['version'=>1,'purpose'=>'clawpilot-native-email-initial-enrollment-approval','issuer'=>'clawpilot-pg-initial-enrollment',
    'audience'=>'clawpilot-suitecrm-initial-enrollment','keyId'=>'initial-fixture-key','nativeInstanceId'=>'native-fixture',
    'serviceUserId'=>'1','oauthClientId'=>'initial-client','issuedAt'=>time(),'expiresAt'=>time()+120,'operationId'=>$plan['operationId'],
    'planHash'=>$forecast['planHash'],'appGeneration'=>$plan['appGeneration'],'appSourceFingerprint'=>$plan['appSourceFingerprint'],
    'preparedAt'=>$forecast['preparedAt'],'deltaFingerprint'=>$forecast['deltaFingerprint']]+$installation;
$sign=static function(array $p)use($C,$key):array{$signature='';initialPureNeed(openssl_sign($C::canonical($p),$signature,$key,OPENSSL_ALGO_SHA256),'Synthetic signature required');return ['proof'=>$p,'signature'=>base64_encode($signature)];};
$reflection=new ReflectionClass(ClawPilotNativeEmailInitialEnrollment::class);$service=$reflection->newInstanceWithoutConstructor();
foreach(['serviceUserId'=>'1','oauthClientId'=>'initial-client'] as $name=>$value)$reflection->getProperty($name)->setValue($service,$value);
$verify=$reflection->getMethod('verifyApproval');
$check('fixed initial-purpose RSA approval verifies only its exact plan, delta, journal and dedicated identity',static function()use($verify,$service,$plan,$forecast,$proof,$sign,$installation):void{
    $verify->invoke($service,$plan,$forecast,$sign($proof),$installation);
    foreach(['purpose','issuer','audience','operationId','planHash','preparedAt','deltaFingerprint','appSourceFingerprint',
        'sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint','serviceUserId','oauthClientId'] as $field){$p=$proof;
        $p[$field]=str_contains($field,'Fingerprint')||str_ends_with($field,'Hash')||$field==='operationId'?hash('sha256','changed'):'other';
        initialPureReject(static fn()=>$verify->invoke($service,$plan,$forecast,$sign($p),$installation));}
});
$check('unsigned/tampered/ordinary-authority/expired approvals cannot authorize initial mutation',static function()use($verify,$service,$plan,$forecast,$proof,$sign,$installation):void{
    $authorization=$sign($proof);$authorization['signature']=str_repeat('A',512);
    initialPureReject(static fn()=>$verify->invoke($service,$plan,$forecast,$authorization,$installation));
    $p=$proof;$p['purpose']='clawpilot-native-email-authority-approval';initialPureReject(static fn()=>$verify->invoke($service,$plan,$forecast,$sign($p),$installation));
    $p=$proof;$p['issuedAt']=time()-240;$p['expiresAt']=time()-1;initialPureReject(static fn()=>$verify->invoke($service,$plan,$forecast,$sign($p),$installation));
    $p=$proof;$p['expiresAt']=$p['issuedAt']+301;initialPureReject(static fn()=>$verify->invoke($service,$plan,$forecast,$sign($p),$installation));
    $p=$proof;$p['extra']='unexpected';initialPureReject(static fn()=>$verify->invoke($service,$plan,$forecast,$sign($p),$installation));
});
fwrite(STDOUT,'NATIVE_INITIAL_ENROLLMENT_PURE_PASSED='.$checks."\n");
fwrite(STDOUT,"BOUNDARY: synthetic signatures and value validation only; no SQL, installed runtime, native receipt or PG activation proof\n");
