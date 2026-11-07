<?php
declare(strict_types=1);

// Private, one-action transport. No HTTP routes, installer, signer, database
// grants or process/config writers. The operator must separately attest and
// retain both writer drains; a protected fence file is not a drain by itself.
require_once __DIR__.'/native-email-enrolled-startup.php';
require_once __DIR__.'/email-audience/NativeEmailRecoveryDispatchPermit.php';
require_once __DIR__.'/email-audience/NativeEmailPublisher.php';

const CP_RECOVERY_CLI_PATH='/opt/clawpilot/native-email-recovery-cli.php';
const CP_RECOVERY_CLI_FENCE=CP_INITIAL_CLI_STATE.'/dispatch-fence.json';
const CP_RECOVERY_CLI_PACKET_LIMIT=650000;
const CP_RECOVERY_CLI_INPUT_TIMEOUT_NS=8000000000;
const CP_RECOVERY_CLI_REPLY_LIMIT=850000;
const CP_RECOVERY_CLI_READY_HELPER_SHA256='23434e30b5fcbae9d64b51b96ba98309b3ee3ff84ca11995b0ec4e4a539f9f23';
const CP_RECOVERY_CLI_TARGET_KEYS=['projectId','environmentId','serviceId','deploymentId','deploymentInstanceId','replicaId','nativeInstanceId',
    'database','databasePrincipal','mariaStoreFingerprint','serviceUserId','oauthClientId','cliSourceHash','imagePackageHash'];

function cp_recovery_cli_need(bool $condition,string $code): void
{if(!$condition)throw new RuntimeException('native_recovery_cli_'.$code);}

function cp_recovery_cli_epoch(mixed $value): bool
{return is_int($value)&&$value>0&&$value<=9007199254740991;}

function cp_recovery_cli_uuid(mixed $value): bool
{return is_string($value)&&preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/D',$value)===1;}

function cp_recovery_cli_env(string $name,string $expected): void
{
    $actual=getenv($name);
    cp_recovery_cli_need(is_string($actual)&&hash_equals($expected,$actual),'target_identity');
}

function cp_recovery_cli_fence(): array
{
    cp_scope_protected_directory(CP_INITIAL_CLI_STATE,false);
    cp_scope_path(CP_INITIAL_CLI_APP);
    $state=stat(CP_INITIAL_CLI_STATE);$app=stat(CP_INITIAL_CLI_APP);
    cp_recovery_cli_need(is_array($state)&&is_array($app)&&$state['dev']===$app['dev'],'state_filesystem');
    $read=cp_initial_cli_protected_file(CP_RECOVERY_CLI_FENCE,32768);
    $fence=json_decode($read['bytes'],true,24,JSON_THROW_ON_ERROR);
    cp_initial_cli_keys($fence,['version','target','bootstrapPins','fenceEpoch','expiresAt','keyId','publicKeyPem','transportAttestationKey']);
    cp_recovery_cli_need($fence['version']===2&&cp_recovery_cli_uuid($fence['fenceEpoch'])
        &&cp_recovery_cli_epoch($fence['expiresAt'])&&is_string($fence['keyId'])
        &&preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/D',$fence['keyId'])===1
        &&is_string($fence['publicKeyPem'])&&strlen($fence['publicKeyPem'])<=8192
        &&is_string($fence['transportAttestationKey'])&&strlen($fence['transportAttestationKey'])===44,'fence_shape');
    cp_initial_cli_keys($fence['bootstrapPins'],CP_INITIAL_CLI_BOOTSTRAP_LEAVES);
    $target=$fence['target'];cp_initial_cli_keys($target,CP_RECOVERY_CLI_TARGET_KEYS);
    // The SSH selector is independently verified before provisioning. The
    // local Railway replica environment is a separate identity, not an alias.
    cp_recovery_cli_need(cp_recovery_cli_uuid($target['deploymentInstanceId']),'target_shape');
    foreach(['projectId'=>'RAILWAY_PROJECT_ID','environmentId'=>'RAILWAY_ENVIRONMENT_ID','serviceId'=>'RAILWAY_SERVICE_ID',
        'deploymentId'=>'RAILWAY_DEPLOYMENT_ID','replicaId'=>'RAILWAY_REPLICA_ID'] as $key=>$name){
        cp_recovery_cli_need(cp_recovery_cli_uuid($target[$key]),'target_shape');cp_recovery_cli_env($name,$target[$key]);
    }
    foreach(['nativeInstanceId'=>'SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID','serviceUserId'=>'SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID',
        'oauthClientId'=>'SUITECRM_NATIVE_AUTHORITY_CLIENT_ID'] as $key=>$name){
        cp_initial_cli_id($target[$key]);cp_recovery_cli_env($name,$target[$key]);
    }
    cp_recovery_cli_need(is_string($target['database'])&&preg_match('/^[A-Za-z0-9_]{1,64}$/D',$target['database'])===1
        &&is_string($target['databasePrincipal'])&&preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@[A-Za-z0-9._:%-]{1,255}$/D',
            $target['databasePrincipal'])===1,'target_database');
    foreach(['mariaStoreFingerprint','cliSourceHash','imagePackageHash'] as $key)cp_initial_cli_hash($target[$key]);
    cp_recovery_cli_need(hash_equals($target['cliSourceHash'],hash_file('sha256',__FILE__)),'cli_source_changed');
    return ['value'=>$fence,'sha256'=>$read['stat']['sha256']];
}

/** Verify only retained protected origin, files and package here. Native
 * policy and write authority are independently checked in the Publisher. */
function cp_recovery_cli_pins(array $fence): void
{
    $target=$fence['target'];
    $certificate=cp_initial_private(CP_INITIAL_CLI_STATE.'/'.CP_NATIVE_STARTUP_CERTIFICATE,262144);
    $envelope=json_decode($certificate,true,64,JSON_THROW_ON_ERROR);
    cp_recovery_cli_need(is_array($envelope)&&ClawPilotNativeEmailStartupOrigin::canonical($envelope)===$certificate,'origin_canonical');
    $origin=ClawPilotNativeEmailStartupOrigin::verifyEnvelope($envelope,time());
    cp_recovery_cli_need($origin['nativeInstanceId']===$target['nativeInstanceId']&&$origin['serviceUserId']===$target['serviceUserId']
        &&$origin['oauthClientId']===$target['oauthClientId'],'origin_target_changed');
    cp_scope_protected_directory(CP_INITIAL_CLI_STATE.'/operations',false);
    $dir=CP_INITIAL_CLI_STATE.'/operations/'.$origin['operationId'];cp_scope_protected_directory($dir,false);
    $input=cp_initial_private($dir.'/input.json');$artifact=json_decode($input,true,64,JSON_THROW_ON_ERROR);
    cp_recovery_cli_need(is_array($artifact)&&$artifact['database']===$target['database']
        &&$artifact['imagePackageHash']===$target['imagePackageHash']
        &&cp_initial_cli_canonical($artifact['bootstrapPins'])===cp_initial_cli_canonical($fence['bootstrapPins']),'origin_pins_changed');
    cp_native_startup_files($artifact,$origin);cp_initial_cli_identity($artifact);cp_initial_cli_pins($artifact);
    cp_recovery_cli_need(cp_runtime_check(cp_runtime_context(CP_INITIAL_CLI_APP,CP_INITIAL_CLI_RUNTIME,__DIR__))['status']==='applied'
        &&cp_scope_check(cp_scope_context(CP_INITIAL_CLI_APP,CP_INITIAL_CLI_SCOPE))['status']==='applied','installation_not_applied');
}

/** Exact stock cold path, with only the two credential slots changed in
 * memory before the first connection; never edit persisted SuiteCRM config. */
function cp_recovery_cli_bootstrap(array $target): mysqli
{
    global $sugar_config,$sugar_version,$sugar_db_version,$sugar_flavor,$db,$locale,$timedate;
    cp_recovery_cli_need(!defined('sugarEntry')&&!isset($GLOBALS['installing'])&&!isset($GLOBALS['current_user'])
        &&!class_exists('DBManagerFactory',false)&&session_status()!==PHP_SESSION_ACTIVE,'fresh_process_required');
    $user=getenv('SUITECRM_NATIVE_RECOVERY_DB_USER');$password=getenv('SUITECRM_NATIVE_RECOVERY_DB_PASSWORD');
    cp_recovery_cli_need(is_string($user)&&$user===explode('@',$target['databasePrincipal'],2)[0]
        &&is_string($password)&&strlen($password)>0&&strlen($password)<=4096&&!str_contains($password,"\0"),'database_credential_required');
    cp_recovery_cli_need(chdir(CP_INITIAL_CLI_APP.'/public/legacy'),'legacy_root');
    $_REQUEST=[];$_GET=[];$_POST=[];$_COOKIE=[];$_SESSION=[];$_SERVER['REQUEST_URI']='';
    define('sugarEntry',true);$GLOBALS['installing']=true;
    try {
        require CP_INITIAL_CLI_APP.'/public/legacy/include/entryPoint.php';
        cp_recovery_cli_need(($GLOBALS['installing']??null)===true&&session_status()!==PHP_SESSION_ACTIVE
            &&class_exists('DBManagerFactory',false)&&DBManagerFactory::$instances===[]&&!isset($GLOBALS['current_user'])
            &&is_array($sugar_config)&&($sugar_config['installed']??true)!==false,'cold_entrypoint_changed');
        $config=$sugar_config['dbconfig']??null;
        cp_recovery_cli_need(is_array($config)&&($config['db_name']??null)===$target['database']&&($config['db_type']??null)==='mysql'
            &&is_string($config['db_user_name']??null)&&$config['db_user_name']!==''&&$config['db_user_name']!==$user
            &&is_string($config['db_password']??null)&&is_string($config['db_host_name']??null)&&$config['db_host_name']!==''
            // The stock installer persists this exact manager name; the stock
            // fallback also resolves to it. No alternate manager is allowed.
            &&!str_starts_with($config['db_host_name'],'p:')&&in_array($config['db_manager']??null,[null,'','MysqliManager'],true)
            &&empty($config['db_manager_class'])
            &&empty($sugar_config['mysqli_disabled']),'native_database_config');
        $sugar_config['dbconfig']['db_user_name']=$user;$sugar_config['dbconfig']['db_password']=$password;
        unset($config,$user,$password);
        // The stock manager can otherwise log full SQL, including Email
        // content. This is process-local, not a change to persisted config.
        LoggerManager::getLogger()->setLevel('off');
        cp_recovery_cli_need(DBManagerFactory::$instances===[],'premature_database_manager');
        $db=DBManagerFactory::getInstance();
        cp_recovery_cli_need($db instanceof MysqliManager&&get_class($db)==='MysqliManager'&&$db->database instanceof mysqli
            &&DBManagerFactory::$instances===[''=>$db],'native_database_manager');
        $GLOBALS['db']=$db;
        cp_recovery_cli_db_identity($db->database,$target);
        require_once 'modules/ACLActions/ACLAction.php';
        require_once 'modules/ACLRoles/ACLRole.php';
        require_once 'modules/SecurityGroups/SecurityGroup.php';
        $GLOBALS['error_notice']='';$GLOBALS['use_current_user_login']=false;$GLOBALS['current_entity']=null;
        $GLOBALS['sugar_version']=$sugar_version;$GLOBALS['sugar_flavor']=$sugar_flavor;
        $GLOBALS['timedate']=TimeDate::getInstance();$GLOBALS['locale']=new Localization();
        $GLOBALS['current_language']=get_current_language();
        $GLOBALS['js_version_key']=md5($sugar_config['unique_key'].$sugar_version.$sugar_flavor);
        $principal=BeanFactory::newBean('Users');
        cp_recovery_cli_need($principal instanceof User&&get_class($principal)==='User'
            &&(bool)$principal->retrieve($target['serviceUserId'],false)&&$principal->id===$target['serviceUserId']
            &&$principal->isAdmin()&&$principal->status==='Active','service_user');
        cp_recovery_cli_need(DBManagerFactory::$instances===[''=>$db]&&session_status()!==PHP_SESSION_ACTIVE,'bootstrap_side_effect');
        $GLOBALS['current_user']=$principal;$_SESSION=[];$_REQUEST=[];
        return $db->database;
    }catch(mysqli_sql_exception $error){
        // The server error code, unlike its message, contains no query,
        // account, or host information. Keep output deliberately bounded.
        $category=match($error->getCode()){1044,1045,1142,1143,1227=>'access_denied',
            1049,1054,1146=>'schema_changed',default=>'query_failed'};
        throw new RuntimeException('native_recovery_cli_bootstrap_'.$category);
    }catch(Throwable $error){
        if($error instanceof RuntimeException&&preg_match('/^native_recovery_cli_[a-z_]{1,64}$/D',$error->getMessage())===1)throw $error;
        throw new RuntimeException('native_recovery_cli_bootstrap_failed');
    }finally{unset($GLOBALS['installing']);}
}

/** Role/session/clock are validated independently; they cannot name a store.
 * Hash the exact strings returned by MariaDB, never a config or host alias. */
function cp_recovery_cli_maria_store_fingerprint(array $row): string
{
    foreach(['database_name'=>'/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/D','hostname'=>'/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/D',
        'server_id'=>'/^[1-9][0-9]{0,9}$/D','server_version'=>'/^[1-9][0-9]?\.[0-9]{1,3}\.[0-9]{1,3}-MariaDB(?:[-+._~A-Za-z0-9]{0,80})$/D',
        'server_uid'=>'~^[A-Za-z0-9+/]{27}=$~D'] as $key=>$pattern){
        cp_recovery_cli_need(is_string($row[$key]??null)&&preg_match($pattern,$row[$key])===1,'native_database_identity');
    }
    $uid=base64_decode($row['server_uid'],true);
    cp_recovery_cli_need((float)$row['server_id']<=4294967295&&is_string($uid)&&strlen($uid)===20
        &&base64_encode($uid)===$row['server_uid'],'native_database_identity');
    return ClawPilotNativeEmailPublisher::digest(['version'=>1,'purpose'=>'clawpilot-native-email-custody-maria-store-v1',
        'database'=>$row['database_name'],'hostname'=>$row['hostname'],'serverId'=>$row['server_id'],
        'serverVersion'=>$row['server_version'],'serverUid'=>$row['server_uid']]);
}

function cp_recovery_cli_db_identity_row(mixed $row,array $target): int
{
    cp_recovery_cli_need(is_array($row),'native_database_identity');
    $epoch=$row['epoch']??null;
    cp_recovery_cli_need(($row['principal']??null)===($target['databasePrincipal']??false)&&($row['database_name']??null)===($target['database']??false)
        &&is_string($target['mariaStoreFingerprint']??null)&&preg_match('/^[a-f0-9]{64}$/D',$target['mariaStoreFingerprint'])===1
        &&hash_equals($target['mariaStoreFingerprint'],cp_recovery_cli_maria_store_fingerprint($row))
        &&(is_int($epoch)||(is_string($epoch)&&preg_match('/^[1-9][0-9]{0,15}$/D',$epoch)===1))
        &&cp_recovery_cli_epoch((int)$epoch),'native_database_identity');
    return (int)$epoch;
}

function cp_recovery_cli_db_identity(mysqli $db,array $target): int
{
    try {
        $result=$db->query('SELECT CURRENT_USER() AS principal,DATABASE() AS database_name,@@GLOBAL.hostname AS hostname,'
            .'CAST(@@GLOBAL.server_id AS CHAR) AS server_id,@@GLOBAL.version AS server_version,@@GLOBAL.server_uid AS server_uid,'
            .'CAST(UNIX_TIMESTAMP() AS UNSIGNED) AS epoch');
    } catch(mysqli_sql_exception) {
        // A missing identity variable is a hold, not an older-server fallback.
        throw new RuntimeException('native_recovery_cli_native_database_identity');
    }
    cp_recovery_cli_need($result instanceof mysqli_result&&$result->num_rows===1,'native_database_identity');
    try {return cp_recovery_cli_db_identity_row($result->fetch_assoc(),$target);}
    finally {$result->free();}
}

/** Read exactly one bounded packet followed by EOF, on the connection that
 * just received readiness. Nonblocking reads cannot extend the CLI lock lease. */
function cp_recovery_cli_read_packet($stream): string
{
    $deadline=hrtime(true)+CP_RECOVERY_CLI_INPUT_TIMEOUT_NS;
    cp_recovery_cli_need(stream_set_blocking($stream,false),'input_stream');
    $bytes='';
    while(!feof($stream)){
        $remaining=$deadline-hrtime(true);
        cp_recovery_cli_need($remaining>0,'input_timeout');
        $microseconds=intdiv($remaining+999,1000);
        $read=[$stream];$write=null;$except=null;
        $ready=stream_select($read,$write,$except,intdiv($microseconds,1000000),$microseconds%1000000);
        cp_recovery_cli_need($ready===1&&hrtime(true)<$deadline,'input_timeout');
        $chunk=fread($stream,min(8192,CP_RECOVERY_CLI_PACKET_LIMIT+1-strlen($bytes)));
        cp_recovery_cli_need(is_string($chunk),'input_stream');
        $bytes.=$chunk;
        cp_recovery_cli_need(strlen($bytes)<=CP_RECOVERY_CLI_PACKET_LIMIT,'input_bound');
    }
    cp_recovery_cli_need(hrtime(true)<$deadline,'input_timeout');
    return $bytes;
}

function cp_recovery_cli_packet(string $bytes): array
{
    $packet=json_decode($bytes,true,48,JSON_THROW_ON_ERROR);
    cp_initial_cli_keys($packet,['command','nativePolicyFingerprint','allowedReaderSuiteCrmUserIds','permit']);
    cp_recovery_cli_need(cp_initial_cli_canonical($packet)."\n"===$bytes,'input_canonical');
    $command=$packet['command'];
    cp_initial_cli_keys($command,['version','operationId','mode','workspaceId','pipelineId','generation','audienceFingerprint',
        'suiteCrmId','globalId','localId','expectedRecordFingerprint','projection','capabilityPolicyFingerprint',
        'principalSuiteCrmUserIds','expectedCapabilities']);
    cp_recovery_cli_need($command['version']===2&&$command['mode']==='publish'&&$command['expectedRecordFingerprint']===null
        &&is_array($command['projection'])&&!array_is_list($command['projection']),'command_scope');
    cp_initial_cli_hash($command['operationId']);cp_initial_cli_hash($packet['nativePolicyFingerprint']);
    $readers=$packet['allowedReaderSuiteCrmUserIds'];
    cp_recovery_cli_need(is_array($readers)&&array_is_list($readers)&&count($readers)>0&&count($readers)<=500
        &&is_array($command['expectedCapabilities'])&&($command['expectedCapabilities']['view']??null)===$readers,'reader_scope');
    foreach($readers as $reader)cp_initial_cli_id($reader,64);
    $sorted=$readers;sort($sorted,SORT_STRING);
    cp_recovery_cli_need($readers===$sorted&&count(array_unique($readers,SORT_STRING))===count($readers),'reader_scope');
    cp_initial_cli_keys($packet['permit'],['proof','signature']);
    $packet['commandHash']=ClawPilotNativeEmailPublisher::digest($command);
    $packet['requestFingerprint']=ClawPilotNativeEmailPublisher::digest(['commandHash'=>$packet['commandHash'],
        'allowedReaderSuiteCrmUserIds'=>$readers,'nativePolicyFingerprint'=>$packet['nativePolicyFingerprint']]);
    return $packet;
}

function cp_recovery_cli_run(array $args): array
{
    cp_recovery_cli_need(PHP_SAPI==='cli'&&PHP_OS_FAMILY==='Linux'&&PHP_VERSION_ID===80336&&function_exists('posix_geteuid')
        &&posix_geteuid()===0&&realpath($_SERVER['SCRIPT_FILENAME']??'')===CP_RECOVERY_CLI_PATH&&__FILE__===CP_RECOVERY_CLI_PATH,
        'root_runtime_required');
    foreach(['CLAWPILOT_NATIVE_INITIAL_MAINTENANCE','CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED','CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED'] as $flag)
        cp_recovery_cli_env($flag,'1');
    cp_recovery_cli_need(count($args)===2&&in_array($args[0],['prepare','publish','resolve'],true)
        &&is_string($args[1])&&preg_match('/^[a-f0-9]{64}$/D',$args[1])===1,'action');
    [$action,$nonce]=$args;
    cp_scope_quiescent(true);
    $retained=cp_recovery_cli_fence();
    $lockPath=CP_INITIAL_CLI_STATE.'/cli.lock';cp_initial_cli_protected_file($lockPath,0);$lock=fopen($lockPath,'rb');
    cp_recovery_cli_need(is_resource($lock)&&flock($lock,LOCK_EX|LOCK_NB),'operator_busy');
    try {
        cp_scope_quiescent(true);
        $fence=cp_recovery_cli_fence();cp_recovery_cli_need(hash_equals($retained['sha256'],$fence['sha256']),'fence_changed');
        $fence=$fence['value'];$target=$fence['target'];
        cp_recovery_cli_pins($fence);
        cp_recovery_cli_need(hash_equals($retained['sha256'],cp_recovery_cli_fence()['sha256']),'fence_changed');
        // The helper is private to the image, not part of the installed
        // HTTP runtime package. Pin its exact bytes via the reviewed CLI hash.
        $readyPath=__DIR__.'/email-audience/NativeEmailRecoveryReadyProof.php';
        $readySource=cp_scope_snapshot($readyPath);
        cp_recovery_cli_need($readySource!==null&&$readySource['uid']===0&&($readySource['mode']&0022)===0
            &&hash_equals(CP_RECOVERY_CLI_READY_HELPER_SHA256,$readySource['sha256']),'ready_helper_changed');
        require_once $readyPath;
        $targetFingerprint=ClawPilotNativeEmailPublisher::digest($target);
        $ready=cp_recovery_cli_ready_line($action,$fence['expiresAt'],$fence['fenceEpoch'],$nonce,$targetFingerprint,
            $fence['transportAttestationKey'],time());
        cp_recovery_cli_need(fwrite(STDOUT,$ready)===strlen($ready)&&fflush(STDOUT),'ready_output');
        $bytes=cp_recovery_cli_read_packet(STDIN);
        cp_scope_quiescent(true);
        cp_recovery_cli_need(hash_equals($retained['sha256'],cp_recovery_cli_fence()['sha256']),'fence_changed');
        $packet=cp_recovery_cli_packet($bytes);unset($bytes);
        $proof=$packet['permit']['proof'];
        cp_recovery_cli_need(is_array($proof)&&cp_recovery_cli_epoch($proof['expiresAt']??null)
            &&$proof['expiresAt']<=$fence['expiresAt'],'fence_expired');
        $trusted=['keyId'=>$fence['keyId'],'publicKeyPem'=>$fence['publicKeyPem'],'action'=>$action,
            'operationId'=>$packet['command']['operationId'],'requestFingerprint'=>$packet['requestFingerprint'],
            'commandHash'=>$packet['commandHash'],'targetFingerprint'=>$targetFingerprint,'fenceEpoch'=>$fence['fenceEpoch']];
        // Reject bad signatures/scope before including persisted config or
        // opening a DB session. The same permit is checked against native DB
        // time after bootstrap, and again under Publisher locks.
        $permit=ClawPilotNativeEmailRecoveryDispatchPermit::verify($packet['permit'],$trusted,time());
        cp_recovery_cli_pins($fence);$db=cp_recovery_cli_bootstrap($target);
        cp_recovery_cli_need(hash_equals($retained['sha256'],cp_recovery_cli_fence()['sha256']),'fence_changed');
        unset($trusted['keyId'],$trusted['publicKeyPem']);
        $permit->assertCurrent($trusted,cp_recovery_cli_db_identity($db,$target));
        $publisher=new ClawPilotNativeEmailPublisher($db,['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>$target['database']],
            $target['serviceUserId'],$target['oauthClientId'],null,$permit,$target['databasePrincipal'],$packet['nativePolicyFingerprint']);
        return match($action){'prepare'=>$publisher->prepare($packet['command']),'publish'=>$publisher->publish($packet['command']),
            'resolve'=>$publisher->resolveOrCancel($packet['command'])};
    }finally{flock($lock,LOCK_UN);fclose($lock);}
}

if(PHP_SAPI==='cli'&&realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    ini_set('display_errors','0');ini_set('log_errors','0');
    // Do not expose stock startup/error output, request content or credentials.
    ob_start(static fn(string $bytes):string=>'',4096);
    try {
        $result=cp_initial_cli_canonical(cp_recovery_cli_run(array_slice($argv,1)))."\n";
        cp_recovery_cli_need(strlen($result)<=CP_RECOVERY_CLI_REPLY_LIMIT,'reply_bound');
        ob_end_clean();fwrite(STDOUT,$result);
    }catch(Throwable $error){
        ob_end_clean();$code=$error instanceof ClawPilotNativeEmailTransactionRefused?$error->holdCode:$error->getMessage();
        if(preg_match('/^native_recovery_(?:cli|dispatch|dispatch_permit)_[a-z_]{1,64}$/D',$code)!==1){
            // Publisher hold codes are internally generated identifiers. Its
            // optional diagnostic and raw exception messages are never shown.
            $code=$error instanceof ClawPilotNativeEmailTransactionRefused&&preg_match('/^[a-z_]{1,64}$/D',$code)===1
                ?'native_recovery_cli_publisher_'.$code:'native_recovery_cli_held';
        }
        $origin=$error instanceof ClawPilotNativeEmailTransactionRefused&&str_starts_with($code,'native_recovery_dispatch_prepare_')
            &&is_string($error->diagnostic)&&preg_match('/^php-origin:[a-f0-9]{64}:[1-9][0-9]{0,5}(?:,[a-f0-9]{64}:[1-9][0-9]{0,5}){0,7}$/D',$error->diagnostic)===1
            ?' '.$error->diagnostic:'';
        fwrite(STDERR,'Native recovery CLI held: '.$code.$origin."\n");exit(1);
    }
}
