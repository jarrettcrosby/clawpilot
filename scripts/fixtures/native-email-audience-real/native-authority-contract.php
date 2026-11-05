<?php
declare(strict_types=1);
require '/source/email-audience/NativeEmailAuthorityContract.php';
$checks=0;
function authorityContractCheck(bool $ok):void{if(!$ok)throw new RuntimeException('Synthetic authority contract assertion failed');}
function authorityContractDenied(callable $run):void{try{$run();}catch(ClawPilotNativeEmailTransactionRefused $e){return;}throw new RuntimeException('Expected synthetic authority contract refusal');}
function authorityContractBinding(array $readers,string $generation,string $policy):array {
    sort($readers,SORT_STRING);$b=['pipeline_id'=>'pipeline-one','workspace_id'=>'workspace-one','group_id'=>'group-one','generation'=>$generation,
        'owner_id'=>'admin','readers_json'=>json_encode($readers),'audience_fingerprint'=>'','policy_fingerprint'=>$policy,
        'runtime_fingerprint'=>str_repeat('c',64),'enabled'=>'1'];
    $b['audience_fingerprint']=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>'admin','allowedSuiteCrmUserIds'=>$readers,
        'workspaceId'=>'workspace-one','pipelineId'=>'pipeline-one'],JSON_UNESCAPED_SLASHES));return $b;
}
(static function()use(&$checks):void{
    $before=authorityContractBinding(['admin','reader'],'1',str_repeat('a',64));$after=authorityContractBinding(['admin'],'2',str_repeat('b',64));
    $row=['id'=>'membership-one','date_modified'=>'2026-10-30 00:00:00','deleted'=>'0','securitygroup_id'=>'group-one','user_id'=>'reader','primary_group'=>'0','noninheritable'=>'1'];
    $deleted=$row;$deleted['deleted']='1';$deleted['date_modified']='2026-10-30 00:01:00';
    $read=['view'=>['admin','reader'],'list'=>['admin','reader'],'export'=>['admin','reader'],'edit'=>['admin'],'delete'=>['admin']];
    $closed=array_fill_keys(ClawPilotNativeEmailAuthorityContract::SURFACES,['admin']);
    $c=['version'=>1,'operationId'=>str_repeat('d',64),'transitionId'=>str_repeat('e',64),'phase'=>'revoke','generationFrom'=>1,'generationTo'=>2,
        'desiredAppChangeHash'=>str_repeat('f',64),'beforePolicyFingerprint'=>str_repeat('a',64),'afterPolicyFingerprint'=>str_repeat('b',64),
        'beforeBindingsFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest([$before]),'afterBindingsFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest([$after]),
        'runtimeFingerprint'=>str_repeat('c',64),'bindings'=>[['before'=>$before,'after'=>$after]],'membershipChanges'=>[['before'=>$row,'after'=>$deleted]],
        'capabilities'=>[['emailId'=>'email-one','globalId'=>'gi1234567','pipelineId'=>'pipeline-one','before'=>$read,'after'=>$closed]],'pendingPublicationCommand'=>null];
    ClawPilotNativeEmailAuthorityContract::validate($c);$checks++;
    $delta=new ClawPilotNativeEmailAuthorityDelta('revoke',$c['membershipChanges']);$delta->assertBefore([$row]);
    authorityContractCheck($delta->restoreBefore([$deleted])===[$row]);$checks++;
    $native=$row;foreach(['deleted','primary_group','noninheritable'] as $key)$native[$key]=(int)$native[$key];
    $nativeDeleted=$native;$nativeDeleted['deleted']=1;$nativeDeleted['date_modified']=$deleted['date_modified'];
    $delta->assertBefore([$native]);authorityContractCheck($delta->restoreBefore([$nativeDeleted])===[$native]);$checks++;
    $nativeBinding=$before;$nativeBinding['generation']=1;$nativeBinding['enabled']=1;
    authorityContractCheck(ClawPilotNativeEmailAuthorityContract::nativeBinding($nativeBinding)===$before);$checks++;
    $nativeBinding['capability_policy_json']=null;$nativeBinding['capability_policy_fingerprint']=null;
    authorityContractCheck(ClawPilotNativeEmailAuthorityContract::nativeBinding($nativeBinding)===$before);$checks++;
    $bad=$nativeBinding;$bad['capability_policy_json']='{}';authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::nativeBinding($bad));$checks++;
    $bad=$nativeBinding;$bad['capability_policy_fingerprint']=str_repeat('a',64);authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::nativeBinding($bad));$checks++;
    $bad=$nativeBinding;unset($bad['capability_policy_json']);authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::nativeBinding($bad));$checks++;
    $bad=$deleted;$bad['primary_group']='1';authorityContractDenied(fn()=>$delta->restoreBefore([$bad]));$checks++;
    $bad=$c;$bad['bindings'][0]['after']['owner_id']='reader';authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($bad));$checks++;
    $bad=$c;$bad['capabilities'][0]['after']['edit'][]='reader';authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($bad));$checks++;
    $bad=$c;$bad['membershipChanges'][0]['after']['user_id']='other';authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($bad));$checks++;
    $bad=$c;$bad['arbitraryApproval']=true;authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($bad));$checks++;
    $bad=$c;$bad['generationTo']=1;authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($bad));$checks++;
    $bad=$c;$bad['capabilities'][]=$bad['capabilities'][0];authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($bad));$checks++;
    $grantRow=$row;$grantRow['id']='new-membership';$grant=new ClawPilotNativeEmailAuthorityDelta('grant',[['before'=>null,'after'=>$grantRow]]);
    $grant->assertBefore([]);authorityContractCheck($grant->restoreBefore([$grantRow])===[]);$checks++;
    authorityContractDenied(fn()=>new ClawPilotNativeEmailAuthorityDelta('revoke',[['before'=>null,'after'=>$grantRow]]));$checks++;
    $receipt=['result'=>['state'=>'committed','generationFrom'=>1,'readers'=>['admin','reader']],'replayed'=>true];
    $reloaded=json_decode(ClawPilotNativeEmailAuthorityContract::canonical($receipt),true,16,JSON_THROW_ON_ERROR);
    authorityContractCheck($receipt!==$reloaded && ClawPilotNativeEmailAuthorityContract::canonical($receipt)===ClawPilotNativeEmailAuthorityContract::canonical($reloaded));
    foreach(['type','value','list-order','extra-key'] as $change) {
        $bad=$reloaded;
        if($change==='type')$bad['result']['generationFrom']='1';
        elseif($change==='value')$bad['replayed']=false;
        elseif($change==='list-order')$bad['result']['readers']=['reader','admin'];
        else $bad['result']['unexpected']=null;
        authorityContractCheck(ClawPilotNativeEmailAuthorityContract::canonical($receipt)!==ClawPilotNativeEmailAuthorityContract::canonical($bad));
    }
    $checks++;
    // Independent v2 vectors. The raw pretty-printed policy bytes are part of
    // the binding preimage, while future-policy hashes use decoded canonical JSON.
    $pipeline='11111111-1111-4111-8111-111111111111';
    $makeV2=static function(array $readers,string $generation,string $policy)use($pipeline):array {
        $b=authorityContractBinding($readers,$generation,$policy);$b['pipeline_id']=$pipeline;
        $b['audience_fingerprint']=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>'admin','allowedSuiteCrmUserIds'=>$readers,
            'workspaceId'=>'workspace-one','pipelineId'=>$pipeline],JSON_UNESCAPED_SLASHES));
        $future=['view'=>$readers,'list'=>$readers,'export'=>$readers,'edit'=>['admin','editor'],'delete'=>['admin','editor']];
        $p=['version'=>2,'pipelineId'=>$pipeline,'workspaceId'=>'workspace-one','ownerSuiteCrmId'=>'admin','audienceFingerprint'=>$b['audience_fingerprint'],
            'principalSuiteCrmUserIds'=>['admin','editor','outsider','reader'],'futureCreate'=>$future,'historical'=>[]];
        $b['capability_policy_json']=json_encode($p,JSON_PRETTY_PRINT);unset($p['historical']);
        $b['capability_policy_fingerprint']=ClawPilotNativeEmailAuthorityContract::digest($p);return $b;
    };
    $v2=$c;$v2['version']=2;$vb=$makeV2(['admin','editor','reader'],'1',str_repeat('a',64));$va=$makeV2(['admin','editor'],'2',str_repeat('b',64));
    $v2['bindings']=[['before'=>$vb,'after'=>$va]];$v2['capabilities'][0]['pipelineId']=$pipeline;
    $v2['capabilities'][0]['before']=json_decode($vb['capability_policy_json'],true)['futureCreate'];
    $v2['capabilities'][0]['after']=json_decode($va['capability_policy_json'],true)['futureCreate'];
    $reHash=static function(array $value):array {
        $value['beforeBindingsFingerprint']=ClawPilotNativeEmailAuthorityContract::digest(array_column($value['bindings'],'before'));
        $value['afterBindingsFingerprint']=ClawPilotNativeEmailAuthorityContract::digest(array_column($value['bindings'],'after'));return $value;
    };$v2=$reHash($v2);
    ClawPilotNativeEmailAuthorityContract::validate($v2);$checks++;
    authorityContractCheck(ClawPilotNativeEmailAuthorityContract::nativeBinding($vb,2)===$vb);$checks++;
    authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::nativeBinding($vb));$checks++;
    $legacy=$before+['capability_policy_json'=>null,'capability_policy_fingerprint'=>null];
    authorityContractCheck(ClawPilotNativeEmailAuthorityContract::nativeBinding($legacy,2)===$legacy);$checks++;
    $bad=$v2;unset($bad['bindings'][0]['before']['capability_policy_json']);authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($bad));$checks++;
    $bad=$v2;$bad['bindings'][0]['after']['capability_policy_json']=null;$bad['bindings'][0]['after']['capability_policy_fingerprint']=null;
    authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($reHash($bad)));$checks++;
    foreach(['principal','future-right','history','hash'] as $change) {
        $bad=$v2;$p=json_decode($bad['bindings'][0]['after']['capability_policy_json'],true);
        if($change==='principal')$p['principalSuiteCrmUserIds']=['admin','editor','reader'];
        elseif($change==='future-right')$p['futureCreate']['edit']=['admin'];
        elseif($change==='history')$p['historical']=[['suiteCrmId'=>'email-one','globalId'=>'gi1234567','capabilities'=>$p['futureCreate']]];
        $bad['bindings'][0]['after']['capability_policy_json']=json_encode($p);unset($p['historical']);
        $bad['bindings'][0]['after']['capability_policy_fingerprint']=$change==='hash'?str_repeat('0',64):ClawPilotNativeEmailAuthorityContract::digest($p);
        authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($reHash($bad)));$checks++;
    }
    $bad=$v2;$bad['capabilities'][0]['after']['edit']=['admin'];authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($bad));$checks++;
    $bad=$v2;$bad['pendingPublicationCommand']=['version'=>2];authorityContractDenied(fn()=>ClawPilotNativeEmailAuthorityContract::validate($bad));$checks++;
})();
fwrite(STDOUT,"NATIVE_AUTHORITY_CONTRACT_PASSED=checks={$checks}; pure PHP validation and exact delta only; no native execution or deployment proof.\n");
