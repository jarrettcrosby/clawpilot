<?php
declare(strict_types=1);
// Actual Linux filesystem/argument acceptance only, no native bootstrap/DB.
require '/source/native-email-initial-artifacts.php';
function artifact_must(bool $value,string $name): void{if(!$value)throw new RuntimeException('Fixture failed: '.$name);}
function artifact_denied(callable $action,string $name): void{try{$action();}catch(Throwable $e){return;}throw new RuntimeException('Expected refusal: '.$name);}
$checks=[];$op=str_repeat('1',64);$sha=str_repeat('2',64);
$source=['stage-input','--operation='.$op,'--sha256='.$sha,'--previous=none','--quiescent'];
$options=cp_initial_artifact_options($source);artifact_must($options['action']==='stage-input'&&$options['previous']==='none','fixed stage options');
foreach([
    array_merge($source,['stage-input']),array_merge($source,['--quiescent']),array_slice($source,0,-1),
    ['stage-input','--operation='.$op,'--sha256='.$sha,'--quiescent'],
    ['bootstrap','--operation='.$op,'--sha256='.$sha,'--quiescent'],
    ['source-status','--operation='.$op,'--sha256='.$sha,'--quiescent'],
    ['origin-status','--operation='.$op,'--sha256='.$sha,'--quiescent'],
    ['read-origin','--operation='.$op,'--quiescent'],
    ['read-source','--operation='.$op,'--sha256='.$sha,'--previous=none','--quiescent'],
    ['stage-input','--operation=../wrong','--sha256='.$sha,'--previous=none','--quiescent'],
    ['stage-input','--operation='.$op,'--sha256='.$sha,'--previous=none','--quiescent','--file=/etc/passwd'],
] as $args)artifact_denied(static fn()=>cp_initial_artifact_options($args),'closed argument grammar');
$checks[]='fixed argument grammar and operation/hash/previous/quiescence bounds';
$dir='/work/artifact-acceptance';cp_scope_protected_directory($dir,true);
$path=$dir.'/retained.json';$bytes="{\"safe\":true}\n";
cp_initial_artifact_publish_once($path,$bytes);$before=lstat($path);
artifact_must(is_array($before)&&($before['mode']&0777)===0600&&$before['uid']===0&&$before['nlink']===1,'exclusive root0600');
cp_initial_artifact_publish_once($path,$bytes);clearstatcache(true,$path);$after=lstat($path);
artifact_must($before['ino']===$after['ino']&&$before['mtime']===$after['mtime']&&file_get_contents($path)===$bytes,'identical publication replay is nonmutating');
artifact_denied(static fn()=>cp_initial_artifact_publish_once($path,"{\"safe\":false}\n"),'immutable bytes never overwritten');
artifact_must(file_get_contents($path)===$bytes,'refusal preserves original');
$checks[]='exclusive immutable publication and exact-byte retry';
$link=$dir.'/linked.json';artifact_must(symlink($path,$link),'fixture symlink');
artifact_denied(static fn()=>cp_initial_artifact_publish_once($link,$bytes),'symlink leaf refused');
$hard=$dir.'/hard.json';artifact_must(link($path,$hard),'fixture hardlink');
artifact_denied(static fn()=>cp_initial_artifact_publish_once($path,$bytes),'hardlinks refused');
artifact_must(unlink($hard),'fixture hardlink cleanup');
artifact_must(chmod($path,0644),'fixture wrong mode');artifact_denied(static fn()=>cp_initial_artifact_publish_once($path,$bytes),'wrong private mode refused');
artifact_must(chmod($path,0600),'fixture restore mode');
$checks[]='symlink hardlink and incorrect protection fail closed';
$canonical=['bootstrapPins'=>['public/legacy/config.php'=>$sha,'vendor/autoload.php'=>null],'version'=>1];
artifact_must(cp_initial_cli_canonical($canonical)==='{"bootstrapPins":{"public/legacy/config.php":"'.$sha.'","vendor/autoload.php":null},"version":1}','private path-key metadata canonical');
$checks[]='private path-key canonical bytes stay distinct from permission wire grammar';
$sourceDir=$dir.'/source-operation';cp_scope_protected_directory($sourceDir,true);
$source=['version'=>1,'purpose'=>'clawpilot-native-email-initial-source','nativePolicyFingerprint'=>$sha,'nativeRuntimeFingerprint'=>$sha,
    'principalSuiteCrmUserIds'=>['native-user'],'emails'=>[],'defaults'=>[]];
$sourceBytes=cp_initial_cli_canonical($source)."\n";$sourceHash=hash('sha256',$sourceBytes);
$input=['version'=>1,'purpose'=>'clawpilot-native-email-initial-cli-artifact','operationId'=>$op,'nativeInstanceId'=>'retained-fixture',
    'appGeneration'=>7,'appSourceFingerprint'=>$sha,'sourceArtifactDigest'=>null,'database'=>'fixture','serviceUserId'=>'native-user','oauthClientId'=>'native-client',
    'cliSourceHash'=>$sha,'imagePackageHash'=>$sha,'bootstrapPins'=>[],'mappings'=>[],'plan'=>null,'preparedAt'=>null,'authorization'=>null];
cp_initial_artifact_publish_once($sourceDir.'/input.json',cp_initial_cli_canonical($input)."\n");
cp_initial_artifact_publish_once($sourceDir.'/native-source.json',$sourceBytes);
$beforeInput=file_get_contents($sourceDir.'/input.json');$beforeSource=file_get_contents($sourceDir.'/native-source.json');
$status=cp_initial_artifact_source_status($sourceDir,$op);
artifact_must($status===['version'=>1,'purpose'=>'clawpilot-native-email-initial-retained-source-status','operationId'=>$op,
    'nativeInstanceId'=>'retained-fixture','appGeneration'=>7,'appSourceFingerprint'=>$sha,'sourceArtifactDigest'=>$sourceHash,
    'activeArtifactHash'=>hash('sha256',$beforeInput)],'actual retained tuple and file hashes');
artifact_must(file_get_contents($sourceDir.'/input.json')===$beforeInput&&file_get_contents($sourceDir.'/native-source.json')===$beforeSource,'source status nonmutating');
artifact_denied(static fn()=>cp_initial_artifact_source_status($sourceDir,str_repeat('3',64)),'foreign active operation');
artifact_must(chmod($sourceDir.'/native-source.json',0644),'source protection fixture');
artifact_denied(static fn()=>cp_initial_artifact_source_status($sourceDir,$op),'source status private protection');
artifact_must(chmod($sourceDir.'/native-source.json',0600),'restore source protection');
$checks[]='actual protected retained source metadata binds active operation and exact original bytes without bootstrap';
$bop=str_repeat('b',64);$fresh=str_repeat('4',64);
$context=['version'=>1,'purpose'=>'clawpilot-native-email-initial-replan-context','rootOperationId'=>$op,
    'rootInstallationJournalFingerprint'=>$sha,'rootSourceArtifactDigest'=>str_repeat('3',64),'rootStockRuntimeFingerprint'=>str_repeat('6',64),
    'predecessorOperationId'=>$op,'predecessorPlanHash'=>$sha,'predecessorApprovalHash'=>$sha,'predecessorCancellationReceiptHash'=>$sha,
    'previousLineageHash'=>null,'depth'=>1,'cancelledHistoryFingerprint'=>$sha];
$binput=$input;$binput['version']=2;$binput['purpose']='clawpilot-native-email-initial-replan-cli-artifact';
$binput['operationId']=$bop;$binput['installationContext']=$context;
$bsource=$source;$bsource['version']=2;$bsource['purpose']='clawpilot-native-email-initial-installed-source';
$bsource['installationContext']=$context;$bsource['nativeRuntimeFingerprint']=$fresh;
$bbytes=cp_initial_cli_canonical($bsource)."\n";$bhash=hash('sha256',$bbytes);
artifact_must(cp_initial_cli_artifact_shape($binput),'strict replacement artifact shape');cp_initial_cli_source_shape($bsource,$binput);
$bdir=$dir.'/replacement-operation';cp_scope_protected_directory($bdir,true);
cp_initial_artifact_publish_once($bdir.'/input.json',cp_initial_cli_canonical($binput)."\n");
cp_initial_artifact_publish_once($bdir.'/native-source.json',$bbytes);
$bstatus=cp_initial_artifact_source_status($bdir,$bop);
artifact_must($bstatus['sourceArtifactDigest']===$bhash&&$bstatus['operationId']===$bop,'replacement exact retained metadata');
$lineage=$context;$lineage['purpose']='clawpilot-native-email-initial-installation-lineage';
$lineage['freshSourceArtifactDigest']=$bhash;$lineage['freshInstalledRuntimeFingerprint']=$fresh;
$prepared=$binput;$prepared['sourceArtifactDigest']=$bhash;$prepared['mappings']=null;
$prepared['plan']=['kind'=>'initial_enrollment_replan_v1','operationId'=>$bop,'nativeRuntimeBeforeFingerprint'=>$fresh,'installationLineage'=>$lineage];
artifact_must(cp_initial_cli_artifact_shape($prepared),'prepared replacement binds its fresh digest');cp_initial_cli_source_shape($bsource,$prepared);
foreach([
    array_merge($binput,['version'=>1]),array_merge($input,['installationContext'=>$context]),
    array_replace_recursive($binput,['installationContext'=>['rootOperationId'=>$bop]]),
    array_replace_recursive($binput,['installationContext'=>['freshSourceArtifactDigest'=>$bhash]]),
    array_replace_recursive($prepared,['plan'=>['kind'=>'initial_enrollment_plan_v1']]),
    array_merge($prepared,['sourceArtifactDigest'=>str_repeat('5',64)]),
] as $wrong)artifact_denied(static fn()=>cp_initial_cli_artifact_shape($wrong),'mixed or changed replacement artifact');
artifact_denied(static fn()=>cp_initial_cli_source_shape($source,$binput),'stock bytes cannot masquerade as installed source');
artifact_denied(static fn()=>cp_initial_cli_source_shape($bsource,$input),'installed bytes cannot masquerade as stock');
$wrongSource=$bsource;$wrongSource['installationContext']['rootSourceArtifactDigest']=str_repeat('5',64);
artifact_denied(static fn()=>cp_initial_cli_source_shape($wrongSource,$binput),'replacement context is immutable');
$wrongRuntime=$bsource;$wrongRuntime['nativeRuntimeFingerprint']=$sha;
artifact_denied(static fn()=>cp_initial_cli_source_shape($wrongRuntime,$prepared),'prepared source runtime cross-binding');
$checks[]='replacement retained metadata uses distinct installed-source profile and never accepts mixed context or self-referential digest';
$originDir=$dir.'/origin-operation';cp_scope_protected_directory($originDir,true);
artifact_must(cp_initial_artifact_origin($originDir,$op)===null,'missing fixed origin stays absent');
$key=openssl_pkey_new(['private_key_bits'=>3072,'private_key_type'=>OPENSSL_KEYTYPE_RSA]);artifact_must($key!==false,'fixture RSA');
$details=openssl_pkey_get_details($key);artifact_must(is_array($details),'fixture public key');
foreach(['SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID'=>'artifact-fixture-key','SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID'=>'artifact-fixture',
    'SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID'=>'native-user','SUITECRM_NATIVE_AUTHORITY_CLIENT_ID'=>'native-client',
    'SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY'=>$details['key']] as $name=>$value)putenv($name.'='.$value);
$uuid='00000000-0000-4000-8000-000000000001';
$proof=['version'=>1,'purpose'=>'clawpilot-native-email-initial-activation-origin','issuer'=>'clawpilot-pg-initial-enrollment',
    'audience'=>'clawpilot-suitecrm-startup','keyId'=>'artifact-fixture-key','nativeInstanceId'=>'artifact-fixture','serviceUserId'=>'native-user','oauthClientId'=>'native-client',
    'issuedAt'=>time(),'operationId'=>$op,'planHash'=>$sha,'approvalHash'=>$sha,'deltaFingerprint'=>$sha,'initialReceiptHash'=>$sha,'originGeneration'=>7,
    'appSourceFingerprint'=>$sha,'installationJournalFingerprint'=>$sha,'sourceRuntimeFingerprint'=>$sha,'installedRuntimeFingerprint'=>$sha,'runtimeFingerprint'=>$sha,
    'identities'=>[['nativeId'=>'email-fixture','globalId'=>'gi1000000','localId'=>$uuid,'pipelineId'=>$uuid,'workspaceId'=>$uuid]],
    'pipelines'=>[['pipelineId'=>$uuid,'workspaceId'=>$uuid,'groupId'=>$uuid]]];
artifact_must(openssl_sign(cp_initial_cli_canonical($proof),$signature,$key,OPENSSL_ALGO_SHA256),'fixture signature');
$originBytes=cp_initial_cli_canonical(['proof'=>$proof,'signature'=>base64_encode($signature)]);
cp_initial_artifact_publish_once($originDir.'/activation-origin.json',$originBytes);
$origin=cp_initial_artifact_origin($originDir,$op);
artifact_must($origin['bytes']===$originBytes&&$origin['stat']['sha256']===hash('sha256',$originBytes),'actual fixed origin signature and bytes');
artifact_denied(static fn()=>cp_initial_artifact_origin($originDir,str_repeat('3',64)),'foreign origin operation');
artifact_must(chmod($originDir.'/activation-origin.json',0644),'origin protection fixture');
artifact_denied(static fn()=>cp_initial_artifact_origin($originDir,$op),'origin private protection');
artifact_must(chmod($originDir.'/activation-origin.json',0600),'restore origin protection');
putenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID=other-instance');
artifact_denied(static fn()=>cp_initial_artifact_origin($originDir,$op),'origin configured identity signature boundary');
artifact_must(file_get_contents($originDir.'/activation-origin.json')===$originBytes,'origin refusal never replaces bytes');
$checks[]='fixed retained origin verifies actual signature operation protection and preserves bytes for recovery';
foreach($checks as $check)fwrite(STDOUT,'PASS '.$check."\n");
fwrite(STDOUT,json_encode(['passed'=>true,'checks'=>count($checks),'boundary'=>'actual Linux protected files and parser only; no native CRM/PG/provider execution'],JSON_THROW_ON_ERROR)."\n");
