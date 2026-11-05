<?php
declare(strict_types=1);
// Private offline transport only. No route, installer, signer, DDL, config
// writer, PG connection or activation. An artifact hash is NOT PG authority.
require_once __DIR__.'/install-native-email-runtime.php';

const CP_INITIAL_CLI_APP='/var/lib/suitecrm/app';
const CP_INITIAL_CLI_STATE='/var/lib/suitecrm/clawpilot-native-email-initial-enrollment-v1';
const CP_INITIAL_CLI_RUNTIME='/var/lib/suitecrm/clawpilot-native-email-runtime-v1';
const CP_INITIAL_CLI_SCOPE='/var/lib/suitecrm/clawpilot-native-email-scope-v1';
const CP_INITIAL_CLI_ENTRYPOINT='8f54a619a83286ab80937f818a67cf4fa98efd40f15b074da774023ec940ee73';
const CP_INITIAL_CLI_BOOTSTRAP_LEAVES=[
    'vendor/autoload.php','public/legacy/include/entryPoint.php','public/legacy/config.php','public/legacy/config_override.php',
    'public/legacy/include/modules_override.php','public/legacy/custom/include/custom_utils.php',
    'public/legacy/custom/application/Ext/Utils/custom_utils.ext.php','public/legacy/custom/application/Ext/Include/modules.ext.php',
    'public/legacy/custom/include/database/MysqliManager.php',
];

function cp_initial_cli_need(bool $value,string $code): void
{if(!$value)throw new RuntimeException('initial_cli_'.$code);}
function cp_initial_cli_hash(mixed $value): void
{cp_initial_cli_need(is_string($value)&&preg_match('/^[a-f0-9]{64}$/D',$value)===1,'hash');}
function cp_initial_cli_id(mixed $value,int $max=36): void
{cp_initial_cli_need(is_string($value)&&strlen($value)<=$max&&preg_match('/^[A-Za-z0-9][A-Za-z0-9-]*$/D',$value)===1,'identity');}
function cp_initial_cli_keys(mixed $value,array $keys): void
{cp_initial_cli_need(is_array($value)&&!array_is_list($value),'shape');$actual=array_keys($value);sort($actual,SORT_STRING);sort($keys,SORT_STRING);cp_initial_cli_need($actual===$keys,'shape');}
/** Transport shape only, never installation, cancellation or PG authority. */
function cp_initial_cli_artifact_shape(array $a): bool
{
    $replan=($a['version']??null)===2;
    cp_initial_cli_keys($a,['version','purpose','operationId','nativeInstanceId','appGeneration','appSourceFingerprint','sourceArtifactDigest',
        'database','serviceUserId','oauthClientId','cliSourceHash','imagePackageHash','bootstrapPins','mappings','plan','preparedAt','authorization',
        ...($replan?['installationContext']:[])]);
    cp_initial_cli_need($replan?$a['purpose']==='clawpilot-native-email-initial-replan-cli-artifact'
        :$a['version']===1&&$a['purpose']==='clawpilot-native-email-initial-cli-artifact','artifact_domain');
    cp_initial_cli_hash($a['operationId']);
    if($replan){require_once __DIR__.'/email-audience/NativeEmailInitialInstallationLineage.php';
        $context=ClawPilotNativeEmailInitialInstallationLineage::prepareContext($a['installationContext'],$a['operationId']);
        if($a['plan']!==null){cp_initial_cli_need(is_array($a['plan'])&&($a['plan']['kind']??null)==='initial_enrollment_replan_v1','replan_required');
            $lineage=ClawPilotNativeEmailInitialInstallationLineage::prepare($a['plan']['installationLineage']??null,$a['operationId']);
            cp_initial_cli_need(cp_initial_cli_canonical($context)===cp_initial_cli_canonical(
                ClawPilotNativeEmailInitialInstallationLineage::contextFromLineage($lineage,$a['operationId']))
                &&$a['sourceArtifactDigest']===$lineage['freshSourceArtifactDigest'],'replan_context_changed');}
    }elseif($a['plan']!==null)cp_initial_cli_need(is_array($a['plan'])&&($a['plan']['kind']??null)==='initial_enrollment_plan_v1','stock_plan_required');
    return $replan;
}
function cp_initial_cli_source_shape(array $source,array $artifact): void
{
    $replan=cp_initial_cli_artifact_shape($artifact);
    cp_initial_cli_keys($source,['version','purpose','nativePolicyFingerprint','nativeRuntimeFingerprint','principalSuiteCrmUserIds','emails','defaults',
        ...($replan?['installationContext']:[])]);
    cp_initial_cli_need($replan?$source['version']===2&&$source['purpose']==='clawpilot-native-email-initial-installed-source'
        :$source['version']===1&&$source['purpose']==='clawpilot-native-email-initial-source','source_domain');
    cp_initial_cli_hash($source['nativePolicyFingerprint']);cp_initial_cli_hash($source['nativeRuntimeFingerprint']);
    if($replan){$context=ClawPilotNativeEmailInitialInstallationLineage::prepareContext($source['installationContext'],$artifact['operationId']);
        cp_initial_cli_need(cp_initial_cli_canonical($context)===cp_initial_cli_canonical($artifact['installationContext']),'source_context_changed');
        if($artifact['plan']!==null){$lineage=ClawPilotNativeEmailInitialInstallationLineage::prepare($artifact['plan']['installationLineage'],$artifact['operationId']);
            cp_initial_cli_need($source['nativeRuntimeFingerprint']===$lineage['freshInstalledRuntimeFingerprint']
                &&($artifact['plan']['nativeRuntimeBeforeFingerprint']??null)===$lineage['freshInstalledRuntimeFingerprint'],'source_runtime_changed');}}
}
function cp_initial_cli_options(array $args): array
{
    $out=['action'=>'inspect-source','operation'=>null,'artifact-sha256'=>null,'plan-sha256'=>null,'approve-operation'=>null,'quiescent'=>false,'with-installation-proof'=>false];$seen=[];
    foreach($args as $arg){cp_initial_cli_need(is_string($arg),'argument');
        if(in_array($arg,['inspect-source','inspect-installed-source','project','prepare','execute','resolve','cancel-expired'],true)){$key='action';$value=$arg;}
        elseif($arg==='--quiescent'){$key='quiescent';$value=true;}
        elseif($arg==='--with-installation-proof'){$key='with-installation-proof';$value=true;}
        elseif(preg_match('/^--(operation|artifact-sha256|plan-sha256|approve-operation)=([a-f0-9]{64})$/D',$arg,$m)===1){$key=$m[1];$value=$m[2];}
        else throw new RuntimeException('initial_cli_unknown_argument');
        cp_initial_cli_need(!isset($seen[$key]),'duplicate_argument');$seen[$key]=true;$out[$key]=$value;
    }
    cp_initial_cli_hash($out['operation']);cp_initial_cli_hash($out['artifact-sha256']);
    $source=in_array($out['action'],['inspect-source','inspect-installed-source'],true);cp_initial_cli_need($source?$out['plan-sha256']===null:is_string($out['plan-sha256']),'plan_pin');
    $mutating=in_array($out['action'],['execute','cancel-expired'],true);
    cp_initial_cli_need($mutating?$out['approve-operation']===$out['operation']:$out['approve-operation']===null,'explicit_operation_approval');
    cp_initial_cli_need(!$out['with-installation-proof']||in_array($out['action'],['project','prepare'],true),'installation_proof_action');
    cp_initial_cli_need($out['quiescent'],'explicit_quiescence');return $out;
}
function cp_initial_cli_protected_file(string $path,int $cap): array
{
    $stat=cp_scope_snapshot($path);cp_initial_cli_need($stat!==null&&$stat['uid']===0&&$stat['mode']===0600&&$stat['size']<=$cap,'protected_artifact');
    $bytes=(string)file_get_contents($path);cp_initial_cli_need(strlen($bytes)===$stat['size']&&hash('sha256',$bytes)===$stat['sha256'],'artifact_read_changed');
    return ['bytes'=>$bytes,'stat'=>$stat];
}
function cp_initial_cli_artifact(array $options): array
{
    cp_scope_protected_directory(CP_INITIAL_CLI_STATE,false);
    cp_scope_protected_directory(CP_INITIAL_CLI_STATE.'/operations',false);
    $dir=CP_INITIAL_CLI_STATE.'/operations/'.$options['operation'];cp_scope_protected_directory($dir,false);
    cp_initial_cli_need(stat(CP_INITIAL_CLI_STATE)['dev']===stat(CP_INITIAL_CLI_APP)['dev'],'state_filesystem');
    $read=cp_initial_cli_protected_file($dir.'/input.json',4194304);
    cp_initial_cli_need(hash_equals($options['artifact-sha256'],$read['stat']['sha256']),'artifact_pin_changed');
    $a=json_decode($read['bytes'],true,64,JSON_THROW_ON_ERROR);
    $replan=cp_initial_cli_artifact_shape($a);
    cp_initial_cli_need($a['operationId']===$options['operation']&&is_int($a['appGeneration'])&&$a['appGeneration']>0&&$a['appGeneration']<=9007199254740991,'artifact_identity');
    cp_initial_cli_id($a['nativeInstanceId']);cp_initial_cli_id($a['serviceUserId']);cp_initial_cli_id($a['oauthClientId']);
    foreach(['appSourceFingerprint','cliSourceHash','imagePackageHash'] as $key)cp_initial_cli_hash($a[$key]);
    cp_initial_cli_need(is_string($a['database'])&&preg_match('/^[A-Za-z0-9_]{1,64}$/D',$a['database'])===1,'database');
    cp_initial_cli_need(hash_equals($a['cliSourceHash'],hash_file('sha256',__FILE__)),'cli_source_changed');
    cp_initial_cli_keys($a['bootstrapPins'],CP_INITIAL_CLI_BOOTSTRAP_LEAVES);
    if(in_array($options['action'],['inspect-source','inspect-installed-source'],true)){
        cp_initial_cli_need($replan===($options['action']==='inspect-installed-source'),'source_profile');
        cp_initial_cli_need(is_array($a['mappings'])&&array_is_list($a['mappings'])&&$a['plan']===null
            &&$a['authorization']===null&&$a['preparedAt']===null&&$a['sourceArtifactDigest']===null,'source_artifact');
    }
    else {
        cp_initial_cli_hash($a['sourceArtifactDigest']);cp_initial_cli_need($a['mappings']===null&&is_array($a['plan'])&&is_string($a['preparedAt']),'prepared_artifact');
        cp_initial_cli_need(($a['plan']['operationId']??null)===$a['operationId']&&($a['plan']['nativeInstanceId']??null)===$a['nativeInstanceId']
            &&($a['plan']['appGeneration']??null)===$a['appGeneration']&&($a['plan']['appSourceFingerprint']??null)===$a['appSourceFingerprint'],'plan_identity');
        $planHash=hash('sha256',cp_initial_cli_canonical($a['plan']));cp_initial_cli_need(hash_equals($options['plan-sha256'],$planHash),'plan_pin_changed');
        if(in_array($options['action'],['execute','resolve','cancel-expired'],true))cp_initial_cli_need(is_array($a['authorization'])
            &&($a['authorization']['proof']['preparedAt']??null)===$a['preparedAt'],'authorization_required');
        else cp_initial_cli_need($a['authorization']===null,'unsigned_prepare_only');
    }
    return $a;
}
function cp_initial_cli_canonical(mixed $value): string
{
    if(is_array($value)){if(!array_is_list($value))ksort($value,SORT_STRING);
        foreach($value as $key=>$entry)$value[$key]=json_decode(cp_initial_cli_canonical($entry),true,64,JSON_THROW_ON_ERROR);}
    return json_encode($value,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
}
function cp_initial_cli_pins(array $artifact): void
{
    foreach(CP_INITIAL_CLI_BOOTSTRAP_LEAVES as $relative){$expected=$artifact['bootstrapPins'][$relative];
        if($expected!==null)cp_initial_cli_hash($expected);$actual=cp_runtime_snapshot(CP_INITIAL_CLI_APP,$relative);
        cp_initial_cli_need($expected===null?$actual===null:$actual!==null&&hash_equals($expected,$actual['sha256']),'bootstrap_input_changed');}
    cp_initial_cli_need($artifact['bootstrapPins']['public/legacy/include/entryPoint.php']===CP_INITIAL_CLI_ENTRYPOINT
        &&is_string($artifact['bootstrapPins']['vendor/autoload.php'])&&is_string($artifact['bootstrapPins']['public/legacy/config.php'])
        &&$artifact['bootstrapPins']['public/legacy/custom/include/database/MysqliManager.php']===null,'bootstrap_profile');
    $context=cp_runtime_context(CP_INITIAL_CLI_APP,CP_INITIAL_CLI_RUNTIME,__DIR__);
    cp_initial_cli_need(hash_equals($artifact['imagePackageHash'],$context['packageHash']),'image_package_changed');
}
function cp_initial_cli_identity(array $artifact): void
{
    foreach(['nativeInstanceId'=>'SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID','serviceUserId'=>'SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID',
        'oauthClientId'=>'SUITECRM_NATIVE_AUTHORITY_CLIENT_ID'] as $key=>$env){$actual=(string)getenv($env);
        cp_initial_cli_need($actual!==''&&hash_equals($actual,$artifact[$key]),'dedicated_identity_unconfigured');}
    $keyId=(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID');cp_initial_cli_id($keyId,64);
    $pem=(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY');cp_initial_cli_need(strlen($pem)>=100&&strlen($pem)<=8192
        &&str_starts_with($pem,'-----BEGIN PUBLIC KEY-----'),'issuer_unconfigured');
    $key=openssl_pkey_get_public($pem);$details=$key===false?false:openssl_pkey_get_details($key);
    cp_initial_cli_need(is_array($details)&&$details['type']===OPENSSL_KEYTYPE_RSA&&$details['bits']===3072,'issuer_key_profile');
}
/** Pinned real entryPoint, but NOT its ordinary body/after_entry_point hook.
 * Do not add normal application startup, caches, login or hook dispatch here.
 * Actual fresh-process DB/cache nonmutation requires its separate native gate. */
function cp_initial_cli_cold_bootstrap(array $artifact): mysqli
{
    global $sugar_config,$sugar_version,$sugar_db_version,$sugar_flavor,$db,$locale,$timedate;
    cp_initial_cli_need(!defined('sugarEntry')&&!isset($GLOBALS['installing'])&&!isset($GLOBALS['current_user']),'fresh_process_required');
    cp_initial_cli_need(chdir(CP_INITIAL_CLI_APP.'/public/legacy'),'legacy_root');
    $_REQUEST=[];$_GET=[];$_POST=[];$_COOKIE=[];$_SESSION=[];$_SERVER['REQUEST_URI']='';
    define('sugarEntry',true);$GLOBALS['installing']=true;
    try{require CP_INITIAL_CLI_APP.'/public/legacy/include/entryPoint.php';
    require_once 'modules/ACLActions/ACLAction.php';
    require_once 'modules/ACLRoles/ACLRole.php';
    require_once 'modules/SecurityGroups/SecurityGroup.php';
    cp_initial_cli_need(is_array($sugar_config)&&($sugar_config['installed']??true)!==false
        &&($sugar_config['dbconfig']['db_name']??null)===$artifact['database']&&($sugar_config['dbconfig']['db_type']??null)==='mysql'
        &&empty($sugar_config['dbconfig']['db_manager_class'])&&empty($sugar_config['mysqli_disabled']),'native_database_config');
    $GLOBALS['error_notice']='';$GLOBALS['use_current_user_login']=false;$GLOBALS['current_entity']=null;
    $GLOBALS['sugar_version']=$sugar_version;$GLOBALS['sugar_flavor']=$sugar_flavor;
    $GLOBALS['timedate']=TimeDate::getInstance();$GLOBALS['locale']=new Localization();
    $GLOBALS['current_language']=get_current_language();
    $GLOBALS['js_version_key']=md5($sugar_config['unique_key'].$sugar_version.$sugar_flavor);
    $db=DBManagerFactory::getInstance();cp_initial_cli_need($db instanceof MysqliManager&&get_class($db)==='MysqliManager'
        &&$db->database instanceof mysqli,'native_database_manager');$GLOBALS['db']=$db;
    $user=BeanFactory::newBean('Users');cp_initial_cli_need($user instanceof User&&get_class($user)==='User'
        &&(bool)$user->retrieve($artifact['serviceUserId'],false),'service_user');
    $GLOBALS['current_user']=$user;$_SESSION=[];$_REQUEST=[];
    return $db->database;
    }finally{unset($GLOBALS['installing']);}
}
/** Actual immutable installation FILE verification, before persisted config
 * or entryPoint includes. Replacement operations retain the original binding;
 * they never rewrite/adopt/recover an installation under the new operation. */
function cp_initial_cli_installation_files(array $artifact): array
{
    $helper=__DIR__.'/install-native-email-initial-state.php';cp_initial_cli_need(is_file($helper)&&!is_link($helper),'installation_verifier_unavailable');
    require_once $helper;
    cp_initial_cli_need(function_exists('cp_initial_installation_context')&&function_exists('cp_initial_installation_verify_files'),'installation_verifier_unavailable');
    $replan=cp_initial_cli_artifact_shape($artifact);
    $context=cp_initial_installation_context(CP_INITIAL_CLI_APP,CP_INITIAL_CLI_STATE,__DIR__);
    if($replan){
        $manifest=cp_initial_install_load($context);cp_initial_cli_need($manifest!==null&&$manifest['phase']==='applied','root_installation_required');
        $binding=$manifest['plan']['binding'];$selected=$artifact['installationContext'];
        cp_initial_cli_need($binding['operationId']===$selected['rootOperationId']&&$binding['nativeInstanceId']===$artifact['nativeInstanceId']
            &&$manifest['plan']['sourceArtifactDigest']===$selected['rootSourceArtifactDigest'],'root_installation_changed');
    }else $binding=array_intersect_key($artifact,array_fill_keys(['operationId','nativeInstanceId','appGeneration','appSourceFingerprint','sourceArtifactDigest'],true));
    $pins=cp_initial_installation_verify_files($context,$binding);cp_initial_cli_keys($pins,['sourceRuntimeFingerprint','installationJournalFingerprint']);
    foreach($pins as $hash)cp_initial_cli_hash($hash);
    if($replan)cp_initial_cli_need($pins['sourceRuntimeFingerprint']===$selected['rootStockRuntimeFingerprint']
        &&$pins['installationJournalFingerprint']===$selected['rootInstallationJournalFingerprint'],'root_installation_changed');
    return ['context'=>$context,'binding'=>$binding,'pins'=>$pins];
}
/** Actual root file/schema/database-profile check; not native enrollment or
 * cancellation-history proof. Those are independently observed by Native. */
function cp_initial_cli_installation_root(array $artifact,mysqli $db): array
{
    $root=cp_initial_cli_installation_files($artifact);
    $pins=cp_initial_installation_verify($root['context'],$db,$root['binding']);
    cp_initial_cli_need(cp_initial_cli_canonical($pins)===cp_initial_cli_canonical($root['pins']),'installation_changed_during_bootstrap');
    return $root;
}
function cp_initial_cli_installation(array $artifact,mysqli $db,string $action): array
{
    $root=cp_initial_cli_installation_root($artifact,$db);$pins=$root['pins'];
    if(cp_initial_cli_artifact_shape($artifact)){
        $lineage=ClawPilotNativeEmailInitialInstallationLineage::prepare($artifact['plan']['installationLineage']??null,$artifact['operationId']);
        $read=cp_initial_cli_protected_file(CP_INITIAL_CLI_STATE.'/operations/'.$artifact['operationId'].'/native-source.json',1800000);
        cp_initial_cli_need($read['stat']['sha256']===$artifact['sourceArtifactDigest']
            &&$read['stat']['sha256']===$lineage['freshSourceArtifactDigest'],'replan_source_changed');
        $source=json_decode($read['bytes'],true,64,JSON_THROW_ON_ERROR);cp_initial_cli_source_shape($source,$artifact);
        cp_initial_cli_need($read['bytes']===cp_initial_cli_canonical($source)."\n"
            &&$source['nativeRuntimeFingerprint']===$lineage['freshInstalledRuntimeFingerprint']
            &&$artifact['plan']['nativeRuntimeBeforeFingerprint']===$lineage['freshInstalledRuntimeFingerprint'],'replan_source_changed');
        $pins=['sourceRuntimeFingerprint'=>$source['nativeRuntimeFingerprint'],
            'installationJournalFingerprint'=>ClawPilotNativeEmailInitialInstallationLineage::effectiveInstallationJournalFingerprint($lineage,$artifact['operationId'])];
    }
    if(in_array($action,['project','prepare'],true))$installed=ClawPilotNativeEmailRuntime::attestInitialInstalled($db);
    else {$installed=$artifact['authorization']['proof']['installedRuntimeFingerprint']??null;cp_initial_cli_hash($installed);}
    return ['sourceRuntimeFingerprint'=>$pins['sourceRuntimeFingerprint'],'installedRuntimeFingerprint'=>$installed,
        'installationJournalFingerprint'=>$pins['installationJournalFingerprint']];
}
function cp_initial_cli_run(array $args): array
{
    cp_initial_cli_need(PHP_SAPI==='cli'&&PHP_OS_FAMILY==='Linux'&&PHP_VERSION_ID===80336&&function_exists('posix_geteuid')&&posix_geteuid()===0,'runtime_profile');
    $options=cp_initial_cli_options($args);cp_scope_quiescent($options['quiescent']);
    cp_scope_path(CP_INITIAL_CLI_APP);$artifact=cp_initial_cli_artifact($options);cp_initial_cli_identity($artifact);cp_initial_cli_pins($artifact);
    $lockPath=CP_INITIAL_CLI_STATE.'/cli.lock';cp_initial_cli_protected_file($lockPath,0);$lock=fopen($lockPath,'rb');
    cp_initial_cli_need(is_resource($lock)&&flock($lock,LOCK_EX|LOCK_NB),'operator_busy');
    try{
        // Reread under the retained global CLI lock before any native include.
        cp_initial_cli_need(cp_initial_cli_canonical(cp_initial_cli_artifact($options))===cp_initial_cli_canonical($artifact),'artifact_changed_under_lock');
        cp_initial_cli_pins($artifact);$installed=$options['action']!=='inspect-source';
        if($installed){cp_initial_cli_need(cp_runtime_check(cp_runtime_context(CP_INITIAL_CLI_APP,CP_INITIAL_CLI_RUNTIME,__DIR__))['status']==='applied','runtime_not_installed');
            cp_initial_cli_need(cp_scope_check(cp_scope_context(CP_INITIAL_CLI_APP,CP_INITIAL_CLI_SCOPE))['status']==='applied','scope_not_installed');
            cp_initial_cli_installation_files($artifact);}
        $db=cp_initial_cli_cold_bootstrap($artifact);
        // One image-canonical helper/Patch graph prevents alternate-path class
        // or function redeclaration. Installed helpers were independently
        // package-journal checked byte-for-byte before any native bootstrap;
        // SuiteCRM business beans/core still execute from the actual app tree.
        require_once __DIR__.'/email-audience/NativeEmailInitialEnrollment.php';
        $service=new ClawPilotNativeEmailInitialEnrollment($db,['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>$artifact['database']],
            $artifact['serviceUserId'],$artifact['oauthClientId']);
        if(!$installed)return $service->inspectSource($artifact['mappings']);
        if($options['action']==='inspect-installed-source'){
            cp_initial_cli_installation_root($artifact,$db);
            return $service->inspectInstalledSource($artifact['mappings'],$artifact['installationContext'],$artifact['operationId']);
        }
        $installation=cp_initial_cli_installation($artifact,$db,$options['action']);
        if(in_array($options['action'],['execute','cancel-expired'],true))cp_initial_cli_need(getenv('CLAWPILOT_NATIVE_INITIAL_MAINTENANCE')==='1','maintenance_required');
        $result=match($options['action']){
            'project'=>$service->project($artifact['plan'],$artifact['preparedAt'],$installation),
            'prepare'=>$service->prepare($artifact['plan'],$artifact['preparedAt'],$installation),
            'execute'=>$service->execute($artifact['plan'],$artifact['authorization'],$installation),
            'resolve'=>$service->resolve($artifact['plan'],$artifact['authorization']),
            'cancel-expired'=>$service->cancelExpired($artifact['plan'],$artifact['authorization'],$installation),
        };
        // Optional private preparation response. The journal pin comes from
        // the SAME protected files/config/schema verification used by this
        // actual forecast, never a caller-supplied hash or cached JSON claim.
        return $options['with-installation-proof']?
            ['forecast'=>$result,'installationJournalFingerprint'=>$installation['installationJournalFingerprint']]:$result;
    }finally{flock($lock,LOCK_UN);fclose($lock);}
}
if(PHP_SAPI==='cli'&&realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    try{ini_set('display_errors','0');$value=cp_initial_cli_run(array_slice($argv,1));fwrite(STDOUT,cp_initial_cli_canonical($value)."\n");}
    catch(Throwable $error){$code=$error instanceof ClawPilotNativeEmailTransactionRefused?$error->holdCode:$error->getMessage();
        if(!is_string($code)||preg_match('/^(?:initial_cli_|initial_|runtime_|authority_|managed_|unknown_|unsafe_|native_)[A-Za-z0-9_:.-]{1,160}$/D',$code)!==1)$code='initial_cli_held';
        fwrite(STDERR,'Native initial CLI held: '.$code."\n");exit(1);}
}
