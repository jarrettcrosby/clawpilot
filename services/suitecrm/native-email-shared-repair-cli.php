<?php
declare(strict_types=1);

// Private stock SuiteCRM transport. No HTTP entrypoint, DDL, role activation,
// App/PG connection, or alternate destination. One exact pinned slot per call.
require_once __DIR__.'/email-audience/SharedBpoEmailCreatePermit.php';
require_once __DIR__.'/email-audience/SharedBpoEmailNativeAbsence.php';
require_once __DIR__.'/email-audience/SharedBpoEmailReceipt.php';

const CP_SHARED_REPAIR_CLI='/opt/clawpilot/native-email-shared-repair-cli.php';
const CP_SHARED_REPAIR_ROOT='/var/lib/suitecrm';
const CP_SHARED_REPAIR_PINS=CP_SHARED_REPAIR_ROOT.'/clawpilot-shared-repair/pins.json';
const CP_SHARED_REPAIR_LEGACY=CP_SHARED_REPAIR_ROOT.'/app/public/legacy';
const CP_SHARED_REPAIR_WORKSPACE='c6c49765-9bf6-4223-9261-7553499f5d92';
const CP_SHARED_REPAIR_PIPELINE='587c8746-ecf6-40ae-8c50-e456f99ad555';
const CP_SHARED_REPAIR_RAILWAY=[
    'projectId'=>'RAILWAY_PROJECT_ID','environmentId'=>'RAILWAY_ENVIRONMENT_ID','serviceId'=>'RAILWAY_SERVICE_ID',
    'deploymentId'=>'RAILWAY_DEPLOYMENT_ID','replicaId'=>'RAILWAY_REPLICA_ID','gitCommit'=>'RAILWAY_GIT_COMMIT_SHA',
];
const CP_SHARED_REPAIR_BOOTSTRAP=[
    'vendor/autoload.php','public/legacy/include/entryPoint.php','public/legacy/config.php','public/legacy/config_override.php',
    'public/legacy/include/modules_override.php','public/legacy/custom/include/custom_utils.php',
    'public/legacy/custom/application/Ext/Utils/custom_utils.ext.php','public/legacy/custom/application/Ext/Include/modules.ext.php',
    'public/legacy/custom/include/database/MysqliManager.php',
];
const CP_SHARED_REPAIR_BINDINGS=['releaseFingerprint','appDeploymentFingerprint','nativeDeploymentFingerprint',
    'appOriginFingerprint','nativeOriginFingerprint','inventoryFingerprint'];
const CP_SHARED_REPAIR_HASH='/\A[a-f0-9]{64}\z/';
const CP_SHARED_REPAIR_UUID='/\A[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z/';
const CP_SHARED_REPAIR_GLOBAL='/\Agi(?:[0-9]{7}|[0-9a-v]{12})\z/';

function cp_shared_repair_need(bool $ok,string $reason): void
{if(!$ok)throw new RuntimeException('shared_repair_'.$reason);}
function cp_shared_repair_match(mixed $value,string $regex): bool
{return is_string($value)&&preg_match($regex,$value)===1;}
function cp_shared_repair_keys(mixed $value,array $keys): void
{
    cp_shared_repair_need(is_array($value)&&!array_is_list($value),'shape');
    $actual=array_keys($value);sort($actual,SORT_STRING);sort($keys,SORT_STRING);
    cp_shared_repair_need($keys===$actual,'shape');
}

/** Stable one-slot input; the caller may not provide target, manifest pins,
 * database name, credentials, key, alternate account, or nonce. */
function cp_shared_repair_input(mixed $input,string $action,array $slots): array
{
    cp_shared_repair_keys($input,$action==='create'?['localId','projection','permit']:['localId','projection']);
    $id=$input['localId'];
    cp_shared_repair_need(cp_shared_repair_match($id,CP_SHARED_REPAIR_UUID)&&isset($slots[$id]),'slot_unreviewed');
    $slot=$slots[$id];$projection=$input['projection'];
    cp_shared_repair_need(is_array($projection)&&!array_is_list($projection),'projection');
    $command=ClawPilotNativeEmailProjection::validate($projection);
    cp_shared_repair_need($command['suiteCrmId']===$slot['nativeId']&&$command['attributes']['global_id_c']===$slot['globalId']
        &&$command['expectedBeforeFingerprint']===null&&$command['previousManaged']===['accounts'=>[],'contacts'=>[]]
        &&hash_equals($slot['projectionFingerprint'],ClawPilotNativeEmailAuthorityContract::digest($command))
        &&hash_equals($slot['projectionFingerprint'],ClawPilotNativeEmailAuthorityContract::digest($projection)),'projection_changed');
    if($action==='create')cp_shared_repair_need(is_array($input['permit'])&&!array_is_list($input['permit']),'permit');
    return [$slot,$command,$input['permit']??null];
}

/** Exact 11+8 protected allowlist, never a mailbox/account selector. */
function cp_shared_repair_pins(mixed $pins): array
{
    cp_shared_repair_keys($pins,['version','target','bindings','expectEmailTemplates','keyId','publicKeyPem','bootstrapPins','original11','later8']);
    cp_shared_repair_need($pins['version']===1&&is_bool($pins['expectEmailTemplates'])
        &&cp_shared_repair_match($pins['keyId'],'/\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z/')
        &&is_string($pins['publicKeyPem'])&&strlen($pins['publicKeyPem'])<=1024&&str_starts_with($pins['publicKeyPem'],'-----BEGIN PUBLIC KEY-----'),'pins');
    $target=$pins['target'];
    cp_shared_repair_keys($target,[...array_keys(CP_SHARED_REPAIR_RAILWAY),'database','databasePrincipal','serviceUserId','oauthClientId']);
    foreach(CP_SHARED_REPAIR_RAILWAY as $key=>$_)cp_shared_repair_need(cp_shared_repair_match($target[$key],
        $key==='gitCommit'?'/\A[a-f0-9]{40}\z/':CP_SHARED_REPAIR_UUID),'target');
    cp_shared_repair_need(cp_shared_repair_match($target['database'],'/\A[A-Za-z0-9_]{1,64}\z/')
        &&cp_shared_repair_match($target['databasePrincipal'],'/\A[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@[A-Za-z0-9._:%-]{1,255}\z/')
        &&cp_shared_repair_match($target['serviceUserId'],'/\A[A-Za-z0-9][A-Za-z0-9-]{0,35}\z/')
        &&cp_shared_repair_match($target['oauthClientId'],CP_SHARED_REPAIR_UUID),'target');
    cp_shared_repair_keys($pins['bindings'],CP_SHARED_REPAIR_BINDINGS);
    foreach($pins['bindings'] as $hash)cp_shared_repair_need(cp_shared_repair_match($hash,CP_SHARED_REPAIR_HASH),'binding');
    cp_shared_repair_keys($pins['bootstrapPins'],CP_SHARED_REPAIR_BOOTSTRAP);
    foreach($pins['bootstrapPins'] as $hash)cp_shared_repair_need($hash===null||cp_shared_repair_match($hash,CP_SHARED_REPAIR_HASH),'bootstrap_pin');
    cp_shared_repair_need($pins['bootstrapPins']['public/legacy/include/entryPoint.php']==='8f54a619a83286ab80937f818a67cf4fa98efd40f15b074da774023ec940ee73'
        &&is_string($pins['bootstrapPins']['vendor/autoload.php'])&&is_string($pins['bootstrapPins']['public/legacy/config.php'])
        &&$pins['bootstrapPins']['public/legacy/custom/include/database/MysqliManager.php']===null,'bootstrap_profile');
    $slots=[];$seen=['nativeId'=>[],'globalId'=>[],'slotFingerprint'=>[],'nonce'=>[]];
    foreach(['original11'=>11,'later8'=>8] as $group=>$count){
        cp_shared_repair_need(is_array($pins[$group])&&array_is_list($pins[$group])&&count($pins[$group])===$count,'cohort');
        foreach($pins[$group] as $slot){
            cp_shared_repair_keys($slot,['localId','nativeId','globalId','projectionFingerprint','slotFingerprint','nonce']);
            foreach(['localId'=>CP_SHARED_REPAIR_UUID,'nativeId'=>CP_SHARED_REPAIR_UUID,'globalId'=>CP_SHARED_REPAIR_GLOBAL,
                'projectionFingerprint'=>CP_SHARED_REPAIR_HASH,'slotFingerprint'=>CP_SHARED_REPAIR_HASH,'nonce'=>CP_SHARED_REPAIR_HASH] as $key=>$pattern)
                cp_shared_repair_need(cp_shared_repair_match($slot[$key],$pattern),'slot');
            cp_shared_repair_need(!isset($slots[$slot['localId']]),'duplicate_slot');
            foreach($seen as $field=>&$values){cp_shared_repair_need(!isset($values[$slot[$field]]),'duplicate_slot');$values[$slot[$field]]=true;}
            unset($values);$slots[$slot['localId']]=$slot;
        }
    }
    return $slots;
}

function cp_shared_repair_trusted_scope(array $pins,array $slot,string $policy): array
{
    return ['action'=>'create-missing','keyId'=>$pins['keyId'],'workspaceId'=>CP_SHARED_REPAIR_WORKSPACE,
        'pipelineId'=>CP_SHARED_REPAIR_PIPELINE,'lane'=>'failed','policyStateFingerprint'=>$policy,...$pins['bindings'],...$slot];
}

function cp_shared_repair_target(array $pins): void
{
    foreach(CP_SHARED_REPAIR_RAILWAY as $key=>$name)cp_shared_repair_need(getenv($name)===$pins['target'][$key],'target_changed');
    cp_shared_repair_need(getenv('SUITECRM_CLIENT_ID')===$pins['target']['oauthClientId']
        &&getenv('CLAWPILOT_SHARED_BPO_EMAIL_ENABLED')==='1'
        &&getenv('CLAWPILOT_SHARED_BPO_EMAIL_TEMPLATES')===($pins['expectEmailTemplates']?'1':'0'),'target_changed');
    foreach(['CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED','CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED'] as $flag)
        cp_shared_repair_need(in_array(getenv($flag),[false,'','0'],true),'managed_mode');
    foreach(['clawpilot-native-email-runtime-v1','clawpilot-native-email-scope-v1','clawpilot-native-email-initial-enrollment-v1'] as $name){
        $path=CP_SHARED_REPAIR_ROOT.'/'.$name;
        cp_shared_repair_need(!file_exists($path)&&!is_link($path),'managed_mode');
    }
}

function cp_shared_repair_bootstrap(array $pins): mysqli
{
    global $sugar_config,$sugar_version,$sugar_db_version,$sugar_flavor,$db,$locale,$timedate;
    cp_shared_repair_need(!defined('sugarEntry')&&!isset($GLOBALS['installing'])&&!isset($GLOBALS['current_user']),'fresh_process');
    $app=CP_SHARED_REPAIR_ROOT.'/app';
    foreach($pins['bootstrapPins'] as $relative=>$expected){
        $path=$app.'/'.$relative;
        cp_shared_repair_need($expected===null?(!file_exists($path)&&!is_link($path)):
            (is_file($path)&&realpath($path)===$path&&hash_equals($expected,hash_file('sha256',$path))),'bootstrap_changed');
    }
    cp_shared_repair_need(chdir(CP_SHARED_REPAIR_LEGACY),'legacy_root');
    $_REQUEST=[];$_GET=[];$_POST=[];$_COOKIE=[];$_SESSION=[];$_SERVER['REQUEST_URI']='';
    define('sugarEntry',true);$GLOBALS['installing']=true;
    try {
        require CP_SHARED_REPAIR_LEGACY.'/include/entryPoint.php';
        require_once 'modules/ACLActions/ACLAction.php';
        require_once 'modules/ACLRoles/ACLRole.php';
        require_once 'modules/SecurityGroups/SecurityGroup.php';
        $cfg=$sugar_config['dbconfig']??null;
        cp_shared_repair_need(is_array($cfg)&&($sugar_config['installed']??true)!==false
            &&($cfg['db_name']??null)===$pins['target']['database']&&($cfg['db_type']??null)==='mysql'
            &&is_string($cfg['db_host_name']??null)&&!str_starts_with($cfg['db_host_name'],'p:')
            &&in_array($cfg['db_manager']??null,[null,'','MysqliManager'],true)&&empty($cfg['db_manager_class'])
            &&empty($sugar_config['mysqli_disabled'])&&session_status()!==PHP_SESSION_ACTIVE
            &&DBManagerFactory::$instances===[],'database_config');
        LoggerManager::getLogger()->setLevel('off');
        $GLOBALS['error_notice']='';$GLOBALS['use_current_user_login']=false;$GLOBALS['current_entity']=null;
        $GLOBALS['sugar_version']=$sugar_version;$GLOBALS['sugar_flavor']=$sugar_flavor;
        $GLOBALS['timedate']=TimeDate::getInstance();$GLOBALS['locale']=new Localization();
        $GLOBALS['current_language']=get_current_language();
        $GLOBALS['js_version_key']=md5($sugar_config['unique_key'].$sugar_version.$sugar_flavor);
        $db=DBManagerFactory::getInstance();
        cp_shared_repair_need($db instanceof MysqliManager&&get_class($db)==='MysqliManager'&&$db->database instanceof mysqli
            &&DBManagerFactory::$instances===[''=>$db],'database_manager');
        $GLOBALS['db']=$db;
        cp_shared_repair_origin($db->database,$pins);
        $actor=BeanFactory::newBean('Users');$actorId=$pins['target']['serviceUserId'];
        cp_shared_repair_need($actor instanceof User&&get_class($actor)==='User'&&$actor->retrieve($actorId,false)
            &&$actor->id===$actorId&&$actor->status==='Active'&&$actor->isAdmin(),'service_user');
        $GLOBALS['current_user']=$actor;$_SESSION=[];$_REQUEST=[];
        return $db->database;
    } finally {unset($GLOBALS['installing']);}
}

/** Re-observe store and time without emitting native account or host details. */
function cp_shared_repair_origin(mysqli $db,array $pins): array
{
    $result=$db->query("SELECT CURRENT_USER() AS principal,DATABASE() AS database_name,@@GLOBAL.hostname AS hostname,
        CAST(@@GLOBAL.server_id AS CHAR) AS server_id,@@GLOBAL.version AS server_version,@@GLOBAL.server_uid AS server_uid,
        CAST(UNIX_TIMESTAMP() AS UNSIGNED) AS epoch,DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') AS observed_at");
    cp_shared_repair_need($result instanceof mysqli_result&&$result->num_rows===1,'origin');
    try {$row=$result->fetch_assoc();}finally {$result->free();}
    cp_shared_repair_need($row['principal']===$pins['target']['databasePrincipal']&&$row['database_name']===$pins['target']['database']
        &&cp_shared_repair_match($row['hostname'],'/\A[A-Za-z0-9][A-Za-z0-9_.-]{0,254}\z/')
        &&cp_shared_repair_match($row['server_id'],'/\A[1-9][0-9]{0,9}\z/')&&(float)$row['server_id']<=4294967295
        &&cp_shared_repair_match($row['server_version'],'/\A11\.4\.13-MariaDB[-+._~A-Za-z0-9]{0,80}\z/')
        &&cp_shared_repair_match($row['server_uid'],'~\A[A-Za-z0-9+/]{27}=\z~')
        &&(is_int($row['epoch'])||ctype_digit($row['epoch']))&&(int)$row['epoch']>0
        &&cp_shared_repair_match($row['observed_at'],'/\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}000Z\z/'),'origin');
    $hash=ClawPilotNativeEmailAuthorityContract::digest(['version'=>1,'purpose'=>'clawpilot-native-email-custody-maria-store-v1',
        'database'=>$row['database_name'],'hostname'=>$row['hostname'],'serverId'=>$row['server_id'],
        'serverVersion'=>$row['server_version'],'serverUid'=>$row['server_uid']]);
    cp_shared_repair_need(hash_equals($pins['bindings']['nativeOriginFingerprint'],$hash),'origin_changed');
    return ['epoch'=>(int)$row['epoch'],'observedAt'=>substr($row['observed_at'],0,-4).'Z'];
}

function cp_shared_repair_read(mysqli $db,array $pins,array $slot,array $command,string $action,?array $permit): array
{
    $profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>$pins['target']['database']];
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
    $base=['version'=>1,'nativeId'=>$slot['nativeId'],'globalId'=>$slot['globalId'],'projectionFingerprint'=>$slot['projectionFingerprint']];
    try {
        $policy=ClawPilotNativeEmailProjection::sharedLoginPolicyState($db,$tx);
        $base['policyStateFingerprint']=$policy;
        // Verify configured service client; does not grant access. Existing
        // transaction pins policy and user rows; this locks the exact client.
        $client=$db->prepare('SELECT id,assigned_user_id FROM oauth2clients WHERE id=? AND deleted=0 AND is_confidential=1 AND allowed_grant_type=\'client_credentials\' FOR UPDATE');
        cp_shared_repair_need($client instanceof mysqli_stmt,'client');
        $clientId=$pins['target']['oauthClientId'];
        try {
            cp_shared_repair_need($client->bind_param('s',$clientId)&&$client->execute(),'client');
            $clients=$client->get_result()->fetch_all(MYSQLI_ASSOC);
            cp_shared_repair_need($clients===[['id'=>$clientId,'assigned_user_id'=>$pins['target']['serviceUserId']]],'client');
        } finally {$client->close();}
        $snapshot=ClawPilotNativeEmailProjection::snapshot($db,$tx,$slot['nativeId']);
        $journal=$db->query("SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='clawpilot_shared_bpo_email_receipts'");
        cp_shared_repair_need($journal instanceof mysqli_result,'journal');
        try {$tables=$journal->fetch_all(MYSQLI_ASSOC);}finally {$journal->free();}
        cp_shared_repair_need($tables===[]||$tables===[['ENGINE'=>'InnoDB','TABLE_TYPE'=>'BASE TABLE']],'journal');
        $ready=$tables!==[];
        $origin=$pins['bindings']['nativeOriginFingerprint'];
        if(!$snapshot['exists']){
            ClawPilotSharedBpoEmailNativeAbsence::assertAbsent($db,$tx,$slot['nativeId'],$slot['globalId'],$pins['expectEmailTemplates']);
            if($ready)cp_shared_repair_need(ClawPilotSharedBpoEmailReceipt::observe($db,$tx,$origin,$slot['nativeId'],$slot['globalId'],
                $slot['projectionFingerprint'],$snapshot['fingerprint'])===null,'orphan_receipt');
        }
        $time=cp_shared_repair_origin($db,$pins);
        $tx->rollback();
    }catch(Throwable $error){try{$tx->rollback();}catch(Throwable $ignored){}throw $error;}

    if($action==='create'){
        cp_shared_repair_need($ready&&!$snapshot['exists'],'create_requires_absent_ready_journal');
        $scope=cp_shared_repair_trusted_scope($pins,$slot,$policy);
        $authorization=ClawPilotSharedBpoEmailCreatePermit::verify($permit??[],$scope,$command,$pins['publicKeyPem'],$time['epoch']);
        cp_shared_repair_target($pins);
        // Exactly one native transaction performs record+links+receipt.
        ClawPilotNativeEmailProjection::createShared($db,$profile,$command,$authorization,$scope,$pins['expectEmailTemplates']);
    } elseif(!$snapshot['exists']) {
        cp_shared_repair_need($action==='inspect','unknown_outcome_absent');
        $proof=$base+['state'=>'absent','journalReady'=>$ready,'observedAt'=>$time['observedAt']];
        return $proof+['evidenceFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest(['clawpilot-native-shared-absence-v1',$proof])];
    }

    $exact=ClawPilotNativeEmailProjection::observeSharedExact($db,$profile,$command,$policy,$pins['expectEmailTemplates'],$ready?$origin:null);
    if(!$ready){
        $exact['kind']='exact-existing';
        $exact['receiptFingerprint']=ClawPilotNativeEmailAuthorityContract::digest(['clawpilot-shared-bpo-exact-existing-v1',$origin,
            $slot['nativeId'],$slot['globalId'],$slot['projectionFingerprint'],$exact['snapshotFingerprint']]);
    }
    cp_shared_repair_origin($db,$pins);
    return $base+['state'=>$action==='create'?'created':'exact','journalReady'=>$ready]+$exact;
}

function cp_shared_repair_run(array $args): array
{
    cp_shared_repair_need(count($args)===2&&in_array($args[0],['inspect','create','readback'],true)
        &&preg_match('/\A--pins-sha256=([a-f0-9]{64})\z/',$args[1],$match)===1,'arguments');
    cp_shared_repair_need(realpath(__FILE__)===CP_SHARED_REPAIR_CLI&&function_exists('posix_geteuid')&&posix_geteuid()===0,'operator');
    $dir=dirname(CP_SHARED_REPAIR_PINS);$d=@lstat($dir);$f=@lstat(CP_SHARED_REPAIR_PINS);
    cp_shared_repair_need(realpath($dir)===$dir&&is_array($d)&&($d['mode']&0177777)===0040700&&$d['uid']===0
        &&realpath(CP_SHARED_REPAIR_PINS)===CP_SHARED_REPAIR_PINS&&is_array($f)&&($f['mode']&0177777)===0100600
        &&$f['uid']===0&&$f['nlink']===1&&$f['size']>0&&$f['size']<=32768,'protected_pins');
    $h=fopen(CP_SHARED_REPAIR_PINS,'rb');cp_shared_repair_need(is_resource($h),'protected_pins');
    try {
        cp_shared_repair_need(flock($h,LOCK_EX|LOCK_NB),'operator_busy');
        $locked=fstat($h);$bytes=stream_get_contents($h,32769);
        cp_shared_repair_need(is_array($locked)&&$locked['ino']===$f['ino']&&$locked['dev']===$f['dev']&&is_string($bytes)
            &&strlen($bytes)===$f['size']&&hash_equals($match[1],hash('sha256',$bytes)),'pins_changed');
        $pins=json_decode($bytes,true,24,JSON_THROW_ON_ERROR);$slots=cp_shared_repair_pins($pins);cp_shared_repair_target($pins);
        $packet=stream_get_contents(STDIN,600001);
        cp_shared_repair_need(is_string($packet)&&strlen($packet)<=600000&&feof(STDIN),'input_bound');
        [$slot,$command,$permit]=cp_shared_repair_input(json_decode($packet,true,32,JSON_THROW_ON_ERROR),$args[0],$slots);
        $db=cp_shared_repair_bootstrap($pins);
        return cp_shared_repair_read($db,$pins,$slot,$command,$args[0],$permit);
    } finally {fclose($h);}
}

if(PHP_SAPI==='cli'&&realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    ini_set('display_errors','0');ini_set('log_errors','0');
    ob_start(static fn(string $bytes):string=>'',4096);
    try {$result=ClawPilotNativeEmailAuthorityContract::canonical(cp_shared_repair_run(array_slice($argv,1)));}
    catch(Throwable $error){
        ob_end_clean();
        $code=($error instanceof ClawPilotNativeEmailTransactionRefused||$error instanceof ClawPilotNativeEmailProjectionRefused)
            ?$error->holdCode:$error->getMessage();
        $code=cp_shared_repair_match($code,'/\A(?:shared_repair_|shared_bpo_|shared_existing_)[a-z_]{1,75}\z/')?$code:'shared_repair_held';
        fwrite(STDERR,'Shared Email repair held: '.$code."\n");exit(1);
    }
    ob_end_clean();fwrite(STDOUT,$result."\n");
}
