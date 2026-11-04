<?php
declare(strict_types=1);
// Pure actual-PHP RSA/ledger/anchor checks. No mysqli stand-in, DB, installer,
// protected-file capability, startup release or current-native proof is faked.
require_once __DIR__.'/../../services/suitecrm/email-audience/NativeEmailStartupOrigin.php';
$O=ClawPilotNativeEmailStartupOrigin::class;$now=time();$checks=0;
function need(bool $value,string $label): void {if(!$value)throw new RuntimeException($label);}
function held(callable $run,string $label): void {global $checks;$failed=false;try{$run();}catch(Throwable $error){$failed=true;}need($failed,$label);$checks++;}
function sign_origin(array $proof,OpenSSLAsymmetricKey $key): array
{$signature='';need(openssl_sign(ClawPilotNativeEmailStartupOrigin::canonical($proof),$signature,$key,OPENSSL_ALGO_SHA256),'fixture signing');return ['proof'=>$proof,'signature'=>base64_encode($signature)];}
$key=openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>3072]);need($key instanceof OpenSSLAsymmetricKey,'fixture RSA3072');
$public=openssl_pkey_get_details($key)['key'];
foreach(['SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID'=>'origin-key','SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID'=>'native-origin',
    'SUITECRM_NATIVE_AUTHORITY_CLIENT_ID'=>'authority-client','SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID'=>'service-user',
    'SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY'=>$public] as $name=>$value)putenv($name.'='.$value);
$h=static fn(string $value)=>hash('sha256',$value);
$pipeline='10000000-0000-4000-8000-000000000001';$workspace='20000000-0000-4000-8000-000000000001';
$local='30000000-0000-4000-8000-000000000001';$group='40000000-0000-4000-8000-000000000001';
$proof=['version'=>1,'purpose'=>'clawpilot-native-email-initial-activation-origin','issuer'=>'clawpilot-pg-initial-enrollment',
    'audience'=>'clawpilot-suitecrm-startup','keyId'=>'origin-key','nativeInstanceId'=>'native-origin','serviceUserId'=>'service-user',
    'oauthClientId'=>'authority-client','issuedAt'=>$now-3600,'operationId'=>$h('operation'),'planHash'=>$h('plan'),
    'approvalHash'=>$h('pending-approval'),'deltaFingerprint'=>$h('delta'),'initialReceiptHash'=>$h('pending-receipt'),
    'originGeneration'=>7,'appSourceFingerprint'=>$h('source'),'installationJournalFingerprint'=>$h('journal'),
    'sourceRuntimeFingerprint'=>$h('source-runtime'),'installedRuntimeFingerprint'=>$h('installed-runtime'),'runtimeFingerprint'=>$h('runtime'),
    'identities'=>[['nativeId'=>'email-1','globalId'=>'gi1234567','localId'=>$local,'pipelineId'=>$pipeline,'workspaceId'=>$workspace]],
    'pipelines'=>[['pipelineId'=>$pipeline,'workspaceId'=>$workspace,'groupId'=>$group]]];
$a=['version'=>1,'purpose'=>'clawpilot-native-email-initial-enrollment-approval','issuer'=>'clawpilot-pg-initial-enrollment',
    'audience'=>'clawpilot-suitecrm-initial-enrollment','keyId'=>$proof['keyId'],'nativeInstanceId'=>$proof['nativeInstanceId'],
    'serviceUserId'=>$proof['serviceUserId'],'oauthClientId'=>$proof['oauthClientId'],'issuedAt'=>$now-7200,'expiresAt'=>$now-6900,
    'operationId'=>$proof['operationId'],'planHash'=>$proof['planHash'],'appGeneration'=>$proof['originGeneration'],
    'appSourceFingerprint'=>$proof['appSourceFingerprint'],'preparedAt'=>'2026-11-03 12:00:00','deltaFingerprint'=>$proof['deltaFingerprint'],
    'sourceRuntimeFingerprint'=>$proof['sourceRuntimeFingerprint'],'installedRuntimeFingerprint'=>$proof['installedRuntimeFingerprint'],
    'installationJournalFingerprint'=>$proof['installationJournalFingerprint']];
$approval=sign_origin($a,$key);$proof['approvalHash']=$O::digest($approval);
$result=['generation'=>7,'appSourceFingerprint'=>$proof['appSourceFingerprint'],'beforePolicyFingerprint'=>$h('before'),
    'afterPolicyFingerprint'=>$h('after'),'sourceRuntimeFingerprint'=>$proof['sourceRuntimeFingerprint'],
    'installedRuntimeFingerprint'=>$proof['installedRuntimeFingerprint'],'runtimeFingerprint'=>$proof['runtimeFingerprint'],
    'identityFingerprint'=>$h('identity'),'capabilitiesFingerprint'=>$h('capabilities'),'bindingsFingerprint'=>$h('bindings'),
    'defaultsFingerprint'=>$h('defaults'),'emailCount'=>1,'principalCount'=>2];
$receipt=['version'=>1,'purpose'=>'clawpilot-native-email-initial-enrollment-receipt','operationId'=>$proof['operationId'],
    'planHash'=>$proof['planHash'],'approvalHash'=>$proof['approvalHash'],'state'=>'committed','result'=>$result];
$proof['initialReceiptHash']=$O::digest($receipt);$envelope=sign_origin($proof,$key);
$row=['operation_id'=>$proof['operationId'],'plan_hash'=>$proof['planHash'],'delta_fingerprint'=>$proof['deltaFingerprint'],
    'approval_hash'=>$proof['approvalHash'],'approval_json'=>$O::canonical($approval),'receipt_json'=>$O::canonical($receipt),'state'=>'committed'];
need($O::verifyEnvelope($envelope,$now)===$proof,'actual RSA3072 origin accepted');$O::verifyLedger($proof,$row,$now);$checks++;
foreach(['purpose'=>'clawpilot-native-email-initial-enrollment-approval','issuer'=>'other','audience'=>'other',
    'nativeInstanceId'=>'other','oauthClientId'=>'other','serviceUserId'=>'other','keyId'=>'other',
    'originGeneration'=>0,'issuedAt'=>$now+31] as $name=>$value){$changed=$proof;$changed[$name]=$value;
    held(fn()=>$O::verifyEnvelope(sign_origin($changed,$key),$now),'signed invalid '.$name.' refused');}
$changed=$proof;$changed['expiresAt']=$now+60;held(fn()=>$O::verifyEnvelope(sign_origin($changed,$key),$now),'expiry is not a new alternate wire');
$changed=$envelope;$changed['signature']=substr($changed['signature'],0,-1).'!';held(fn()=>$O::verifyEnvelope($changed,$now),'base64 profile');
$changed=$envelope;$changed['proof']['planHash']=$h('different');held(fn()=>$O::verifyEnvelope($changed,$now),'unsigned mutation');
$changed=$proof;$changed['identities'][]=$changed['identities'][0];held(fn()=>$O::verifyEnvelope(sign_origin($changed,$key),$now),'duplicate anchors');
$changed=$proof;$changed['identities'][0]['workspaceId']='20000000-0000-4000-8000-000000000002';
held(fn()=>$O::verifyEnvelope(sign_origin($changed,$key),$now),'cross-workspace anchors');
foreach(['operation_id'=>$h('other'),'approval_hash'=>$h('other'),'state'=>'cancelled','receipt_json'=>$O::canonical($receipt).' '] as $field=>$value){
    $changed=$row;$changed[$field]=$value;held(fn()=>$O::verifyLedger($proof,$changed,$now),'stored origin '.$field);}
$changed=$receipt;$changed['result']['generation']=8;$changedRow=$row;$changedRow['receipt_json']=$O::canonical($changed);
$changedProof=$proof;$changedProof['initialReceiptHash']=$O::digest($changed);
held(fn()=>$O::verifyLedger($changedProof,$changedRow,$now),'origin generation is immutable even with receipt hash changed');
$bindings=[['pipeline_id'=>$pipeline,'workspace_id'=>$workspace,'group_id'=>$group,'generation'=>'12','enabled'=>'1']];
$identities=[['email_id'=>'email-1','global_id'=>'gi1234567','local_id'=>$local,'pipeline_id'=>$pipeline,'workspace_id'=>$workspace,
    'capabilities_json'=>'legitimately changed current capabilities, not an origin comparison']];
$scopes=[['pipeline_id'=>$pipeline,'operation_id'=>$h('later-authority'),'command_hash'=>$h('later-command')]];
$permissions=[['email_id'=>'email-1','pipeline_id'=>$pipeline,'operation_id'=>$h('later-authority'),'command_hash'=>$h('later-command'),'source_kind'=>'authority']];
$O::verifyAnchors($proof,$bindings,$identities,$scopes,$permissions);$checks++;
$changed=$bindings;$changed[0]['generation']='6';held(fn()=>$O::verifyAnchors($proof,$changed,$identities,$scopes,$permissions),'generation rollback');
$changed=$bindings;$changed[0]['enabled']='0';held(fn()=>$O::verifyAnchors($proof,$changed,$identities,$scopes,$permissions),'disabled binding');
$changed=$identities;$changed[0]['global_id']='gi7654321';held(fn()=>$O::verifyAnchors($proof,$bindings,$changed,$scopes,$permissions),'identity rewrite');
held(fn()=>$O::verifyAnchors($proof,$bindings,$identities,[],$permissions),'erased scope is not unmanaged fallback');
held(fn()=>$O::verifyAnchors($proof,$bindings,$identities,$scopes,[]),'erased permission');
$otherPipeline='10000000-0000-4000-8000-000000000002';$otherBinding=$bindings[0];$otherBinding['pipeline_id']=$otherPipeline;
$otherBinding['group_id']='40000000-0000-4000-8000-000000000002';$otherIdentity=$identities[0];$otherIdentity['email_id']='email-2';
$otherIdentity['pipeline_id']=$otherPipeline;$otherIdentity['global_id']='gi7654321';$otherIdentity['local_id']='30000000-0000-4000-8000-000000000002';
$otherScope=$scopes[0];$otherScope['pipeline_id']=$otherPipeline;$otherPermission=$permissions[0];$otherPermission['pipeline_id']=$otherPipeline;$otherPermission['email_id']='email-2';
held(fn()=>$O::verifyAnchors($proof,[$otherBinding],[$otherIdentity],[$otherScope],[$otherPermission]),'entire original scope erasure');
$otherIdentity['pipeline_id']=$pipeline;$otherPermission['pipeline_id']=$pipeline;
held(fn()=>$O::verifyAnchors($proof,$bindings,[$otherIdentity],$scopes,[$otherPermission]),'entire original identity erasure');
$cap=new ReflectionClass(ClawPilotNativeEmailStartupOriginAuthority::class);
need($cap->isFinal()&&$cap->getConstructor()->isPrivate(),'root capability cannot be a public wire constructor');$checks++;
$proofV2=$proof;$proofV2['version']=2;$proofV2['installationRootOperationId']=$h('root-A-operation');
$proofV2['installationLineageHash']=$h('full-B-lineage');
need($O::verifyEnvelope(sign_origin($proofV2,$key),$now)===$proofV2,'strict RSA v2 origin accepted');$O::verifyLedger($proofV2,$row,$now);$checks++;
foreach(['installationRootOperationId','installationLineageHash'] as $field){
    $changed=$proofV2;unset($changed[$field]);held(fn()=>$O::verifyEnvelope(sign_origin($changed,$key),$now),'v2 missing '.$field);
    $changed=$proof;$changed[$field]=$proofV2[$field];held(fn()=>$O::verifyEnvelope(sign_origin($changed,$key),$now),'v1 cannot grow '.$field);
    $changed=sign_origin($proofV2,$key);$changed['proof'][$field]=$h('unsigned-change');held(fn()=>$O::verifyEnvelope($changed,$now),'v2 unsigned '.$field);
}
$changed=$proofV2;$changed['installationRootOperationId']=$changed['operationId'];held(fn()=>$O::verifyEnvelope(sign_origin($changed,$key),$now),'v2 root cannot be B itself');
$changed=$proofV2;$changed['version']=3;held(fn()=>$O::verifyEnvelope(sign_origin($changed,$key),$now),'unknown origin version');
fwrite(STDOUT,'NATIVE_STARTUP_ORIGIN_PURE_PASSED='.$checks."\nBOUNDARY: actual RSA/value/ledger/anchor validation only; no protected-file token, native DB or startup release proof\n");
