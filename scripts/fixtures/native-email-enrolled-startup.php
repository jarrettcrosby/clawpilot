<?php
declare(strict_types=1);
// Pure retained-artifact value checks only. No root capability, config include,
// mysqli substitute, current ACL inspection or real startup success is faked.
require_once __DIR__.'/../../services/suitecrm/native-email-enrolled-startup.php';
$checks=0;$h=static fn(string $text):string=>hash('sha256',$text);
function startup_need(bool $value,string $label): void {if(!$value)throw new RuntimeException($label);}
function startup_held(callable $run,string $label): void
{global $checks;$held=false;try{$run();}catch(Throwable $error){$held=true;}startup_need($held,$label);$checks++;}
$authorization=['proof'=>['preparedAt'=>'2026-11-03 12:00:00'],'signature'=>'synthetic-only-signature'];
$plan=['kind'=>'initial_enrollment_plan_v1','operationId'=>$h('operation'),'synthetic'=>'historical shape only, not a current native matrix'];
$binding=['operationId'=>$h('operation'),'nativeInstanceId'=>'native-startup-fixture','appGeneration'=>7,
    'appSourceFingerprint'=>$h('source'),'sourceArtifactDigest'=>$h('source-bytes')];
$proof=['version'=>1,'operationId'=>$binding['operationId'],'nativeInstanceId'=>$binding['nativeInstanceId'],'originGeneration'=>7,
    'appSourceFingerprint'=>$binding['appSourceFingerprint'],'serviceUserId'=>'service-user','oauthClientId'=>'authority-client',
    'approvalHash'=>ClawPilotNativeEmailStartupOrigin::digest($authorization),'planHash'=>ClawPilotNativeEmailStartupOrigin::digest($plan)];
$artifact=['version'=>1,'purpose'=>'clawpilot-native-email-initial-cli-artifact','operationId'=>$binding['operationId'],
    'nativeInstanceId'=>$binding['nativeInstanceId'],'appGeneration'=>7,'appSourceFingerprint'=>$binding['appSourceFingerprint'],
    'sourceArtifactDigest'=>$binding['sourceArtifactDigest'],'database'=>'startup_fixture','serviceUserId'=>'service-user','oauthClientId'=>'authority-client',
    'cliSourceHash'=>hash_file('sha256',__DIR__.'/../../services/suitecrm/native-email-initial-cli.php'),
    'imagePackageHash'=>$h('package'),'bootstrapPins'=>array_fill_keys(CP_INITIAL_CLI_BOOTSTRAP_LEAVES,null),
    'mappings'=>null,'plan'=>$plan,'preparedAt'=>$authorization['proof']['preparedAt'],'authorization'=>$authorization];
startup_need(cp_native_startup_artifact($artifact,$proof,$binding)===$artifact,'exact retained value bindings');$checks++;
foreach(['operationId'=>$h('other'),'nativeInstanceId'=>'different','appGeneration'=>8,'appSourceFingerprint'=>$h('other'),
    'serviceUserId'=>'other-user','oauthClientId'=>'other-client','sourceArtifactDigest'=>$h('other'),
    'database'=>'bad-database; DROP TABLE','cliSourceHash'=>$h('other')] as $key=>$value){
    $changed=$artifact;$changed[$key]=$value;startup_held(fn()=>cp_native_startup_artifact($changed,$proof,$binding),'retained '.$key.' must not change');}
foreach(['authorization'=>null,'plan'=>null,'mappings'=>[],'preparedAt'=>'2026-11-03 12:00:01'] as $key=>$value){
    $changed=$artifact;$changed[$key]=$value;startup_held(fn()=>cp_native_startup_artifact($changed,$proof,$binding),'unsigned/source/other preparation artifact '.$key);}
$changed=$artifact;$changed['authorization']['signature']='changed';startup_held(fn()=>cp_native_startup_artifact($changed,$proof,$binding),'authorization bytes match signed historical origin');
$changed=$artifact;$changed['plan']['synthetic']='changed';startup_held(fn()=>cp_native_startup_artifact($changed,$proof,$binding),'historical plan bytes match origin, not current state');
$changed=$artifact;$changed['bootstrapPins']['public/legacy/config.php']='invalid';startup_held(fn()=>cp_native_startup_artifact($changed,$proof,$binding),'bootstrap pin digest grammar');
$changed=$artifact;unset($changed['bootstrapPins']['public/legacy/config.php']);startup_held(fn()=>cp_native_startup_artifact($changed,$proof,$binding),'bootstrap pin completeness');
$changed=$artifact;$changed['allowStartup']=true;startup_held(fn()=>cp_native_startup_artifact($changed,$proof,$binding),'no boolean startup bypass');
$changed=$binding;$changed['appGeneration']=8;startup_held(fn()=>cp_native_startup_artifact($artifact,$proof,$changed),'installation generation');
$lineage=['version'=>1,'purpose'=>'clawpilot-native-email-initial-installation-lineage','rootOperationId'=>$binding['operationId'],
    'rootInstallationJournalFingerprint'=>$h('root-journal'),'rootSourceArtifactDigest'=>$binding['sourceArtifactDigest'],
    'rootStockRuntimeFingerprint'=>$h('root-stock'),'predecessorOperationId'=>$binding['operationId'],'predecessorPlanHash'=>$h('root-plan'),
    'predecessorApprovalHash'=>$h('root-approval'),'predecessorCancellationReceiptHash'=>$h('root-cancelled-receipt'),
    'previousLineageHash'=>null,'depth'=>1,'cancelledHistoryFingerprint'=>$h('complete-history'),
    'freshSourceArtifactDigest'=>$h('B-fresh-source'),'freshInstalledRuntimeFingerprint'=>$h('B-installed-runtime')];
$operationB=$h('operation-B');$L=ClawPilotNativeEmailInitialInstallationLineage::class;
$artifactB=$artifact;$artifactB['version']=2;$artifactB['purpose']='clawpilot-native-email-initial-replan-cli-artifact';
$artifactB['operationId']=$operationB;$artifactB['appGeneration']=9;$artifactB['appSourceFingerprint']=$h('B-app-source');
$artifactB['sourceArtifactDigest']=$lineage['freshSourceArtifactDigest'];$artifactB['installationContext']=$L::contextFromLineage($lineage,$operationB);
$artifactB['plan']=['kind'=>'initial_enrollment_replan_v1','operationId'=>$operationB,'installationLineage'=>$lineage,
    'nativeRuntimeBeforeFingerprint'=>$lineage['freshInstalledRuntimeFingerprint']];
$proofB=$proof;$proofB['version']=2;$proofB['operationId']=$operationB;$proofB['originGeneration']=9;
$proofB['appSourceFingerprint']=$artifactB['appSourceFingerprint'];$proofB['planHash']=ClawPilotNativeEmailStartupOrigin::digest($artifactB['plan']);
$proofB['installationRootOperationId']=$lineage['rootOperationId'];$proofB['installationLineageHash']=$L::digest($lineage,$operationB);
$proofB['sourceRuntimeFingerprint']=$lineage['freshInstalledRuntimeFingerprint'];$proofB['installedRuntimeFingerprint']=$lineage['freshInstalledRuntimeFingerprint'];
$proofB['installationJournalFingerprint']=$L::effectiveInstallationJournalFingerprint($lineage,$operationB);
startup_need(cp_native_startup_artifact($artifactB,$proofB,$binding)===$artifactB,'B artifact binds B origin and unchanged original A installation');$checks++;
foreach(['installationRootOperationId','installationLineageHash','installationJournalFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint'] as $field){
    $changed=$proofB;$changed[$field]=$h('changed');startup_held(fn()=>cp_native_startup_artifact($artifactB,$changed,$binding),'B proof '.$field.' binding');}
$changed=$artifactB;unset($changed['installationContext']);startup_held(fn()=>cp_native_startup_artifact($changed,$proofB,$binding),'B context required');
$changed=$artifactB;$changed['installationContext']['freshSourceArtifactDigest']=$lineage['freshSourceArtifactDigest'];
startup_held(fn()=>cp_native_startup_artifact($changed,$proofB,$binding),'context cannot contain its own fresh artifact digest');
$changed=$binding;$changed['operationId']=$operationB;startup_held(fn()=>cp_native_startup_artifact($artifactB,$proofB,$changed),'Root A journal cannot be rebound to B');
$changed=$artifact;$changed['installationContext']=$artifactB['installationContext'];startup_held(fn()=>cp_native_startup_artifact($changed,$proof,$binding),'direct A artifact has no replan fields');
$changed=$proofB;$changed['version']=1;startup_held(fn()=>cp_native_startup_artifact($artifactB,$changed,$binding),'B cannot use v1 origin');
fwrite(STDOUT,'NATIVE_ENROLLED_STARTUP_VALUES_PASSED='.$checks."\nBOUNDARY: synthetic values only; no native DB, protected root files, restart readiness or production proof\n");
