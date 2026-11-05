<?php
declare(strict_types=1);
// Private, root-only artifact transport for the fixed initial-enrollment CLI.
// No application includes, database connection, keys, ACL changes or execution.
require_once __DIR__.'/native-email-initial-cli.php';

function cp_initial_artifact_options(array $args): array
{
    $out=['action'=>null,'operation'=>null,'sha256'=>null,'previous'=>null,'quiescent'=>false];
    foreach($args as $arg){
        if(in_array($arg,['bootstrap','source-status','origin-status','read-origin','stage-input','retain-source','read-source','publish-origin'],true)){$key='action';$value=$arg;}
        elseif($arg==='--quiescent'){$key='quiescent';$value=true;}
        elseif(preg_match('/^--(operation|sha256)=([a-f0-9]{64})$/D',$arg,$m)===1){$key=$m[1];$value=$m[2];}
        elseif(preg_match('/^--previous=(none|[a-f0-9]{64})$/D',$arg,$m)===1){$key='previous';$value=$m[1];}
        else throw new RuntimeException('initial_artifact_argument');
        cp_initial_cli_need($out[$key]===null||$key==='quiescent'&&$out[$key]===false,'duplicate_argument');$out[$key]=$value;
    }
    cp_initial_cli_need($out['action']!==null&&$out['quiescent'],'artifact_action');cp_initial_cli_hash($out['operation']);
    cp_initial_cli_need(in_array($out['action'],['bootstrap','source-status','origin-status'],true)?$out['sha256']===null:$out['sha256']!==null,'artifact_digest');
    cp_initial_cli_need($out['action']==='stage-input'?$out['previous']!==null:$out['previous']===null,'artifact_previous');return $out;
}
function cp_initial_artifact_bytes(string $expected,int $limit=4194304): string
{
    $bytes=stream_get_contents(STDIN,$limit+1);cp_initial_cli_need(is_string($bytes)&&strlen($bytes)<=$limit
        &&hash_equals($expected,hash('sha256',$bytes)),'artifact_stdin');return $bytes;
}
function cp_initial_artifact_publish_once(string $path,string $bytes): void
{
    if(file_exists($path)){
        $old=cp_initial_cli_protected_file($path,4194304);
        cp_initial_cli_need(hash_equals(hash('sha256',$bytes),$old['stat']['sha256'])&&$old['bytes']===$bytes,'immutable_artifact_changed');return;
    }
    cp_scope_write($path,$bytes);cp_scope_sync_directory(dirname($path));
}
/** Root-private retained-file metadata only, not native/SQL readiness. No
 * current stock capture, persisted application include, or source replacement.
 * Callers must compare this tuple with their independently authorized SQL
 * reservation and separately supplied source digest before recovering bytes. */
function cp_initial_artifact_source_status(string $dir,string $operation): array
{
    cp_scope_protected_directory($dir,false);cp_initial_cli_hash($operation);
    $input=cp_initial_cli_protected_file($dir.'/input.json',4194304);
    $a=json_decode($input['bytes'],true,64,JSON_THROW_ON_ERROR);
    cp_initial_cli_artifact_shape($a);
    cp_initial_cli_need($a['operationId']===$operation&&$input['bytes']===cp_initial_cli_canonical($a)."\n"
        &&is_int($a['appGeneration'])&&$a['appGeneration']>0&&$a['appGeneration']<=9007199254740991,'retained_source_identity');
    cp_initial_cli_id($a['nativeInstanceId']);cp_initial_cli_hash($a['appSourceFingerprint']);
    $read=cp_initial_cli_protected_file($dir.'/native-source.json',1800000);
    $source=json_decode($read['bytes'],true,64,JSON_THROW_ON_ERROR);
    cp_initial_cli_source_shape($source,$a);
    cp_initial_cli_need($read['bytes']===cp_initial_cli_canonical($source)."\n"
        &&($a['sourceArtifactDigest']===null||$a['sourceArtifactDigest']===$read['stat']['sha256']),'retained_source_changed');
    return ['version'=>1,'purpose'=>'clawpilot-native-email-initial-retained-source-status','operationId'=>$operation,
        'nativeInstanceId'=>$a['nativeInstanceId'],'appGeneration'=>$a['appGeneration'],'appSourceFingerprint'=>$a['appSourceFingerprint'],
        'sourceArtifactDigest'=>$read['stat']['sha256'],'activeArtifactHash'=>$input['stat']['sha256']];
}
/** A fixed protected activation certificate, not caller-selected JSON/path.
 * Full signature/domain/operation verification precedes exposing even a hash.
 * Absence permits a first publication; any foreign/corrupt existing origin is
 * held, never replaced or treated as absent. */
function cp_initial_artifact_origin(string $stateRoot,string $operation): ?array
{
    cp_scope_protected_directory($stateRoot,false);cp_initial_cli_hash($operation);
    $path=$stateRoot.'/activation-origin.json';
    if(!file_exists($path)&&!is_link($path))return null;
    $read=cp_initial_cli_protected_file($path,262144);
    $value=json_decode($read['bytes'],true,64,JSON_THROW_ON_ERROR);
    cp_initial_cli_keys($value,['proof','signature']);
    cp_initial_cli_need(($value['proof']['operationId']??null)===$operation
        &&($value['proof']['purpose']??null)==='clawpilot-native-email-initial-activation-origin'
        &&$read['bytes']===cp_initial_cli_canonical($value),'origin_domain');
    require_once __DIR__.'/email-audience/NativeEmailStartupOrigin.php';
    ClawPilotNativeEmailStartupOrigin::verifyEnvelope($value,time());return $read;
}
function cp_initial_artifacts_run(array $args): array|string
{
    cp_initial_cli_need(PHP_SAPI==='cli'&&PHP_OS_FAMILY==='Linux'&&PHP_VERSION_ID===80336
        &&function_exists('posix_geteuid')&&posix_geteuid()===0,'runtime_profile');
    $o=cp_initial_artifact_options($args);cp_scope_quiescent(true);
    cp_initial_cli_need(getenv('CLAWPILOT_NATIVE_INITIAL_MAINTENANCE')==='1','maintenance_required');
    $readOnly=in_array($o['action'],['source-status','origin-status','read-origin','read-source'],true);
    cp_scope_path(CP_INITIAL_CLI_APP);cp_scope_protected_directory(CP_INITIAL_CLI_STATE,!$readOnly);
    cp_scope_protected_directory(CP_INITIAL_CLI_STATE.'/operations',!$readOnly);
    $lockPath=CP_INITIAL_CLI_STATE.'/cli.lock';
    if(!$readOnly&&!file_exists($lockPath))cp_scope_write($lockPath,'');cp_initial_cli_protected_file($lockPath,0);
    $lock=fopen($lockPath,'rb');cp_initial_cli_need(is_resource($lock)&&flock($lock,LOCK_EX|LOCK_NB),'operator_busy');
    try{
        $dir=CP_INITIAL_CLI_STATE.'/operations/'.$o['operation'];cp_scope_protected_directory($dir,!$readOnly);
        cp_initial_cli_need(stat(CP_INITIAL_CLI_STATE)['dev']===stat(CP_INITIAL_CLI_APP)['dev'],'state_filesystem');
        if($o['action']==='bootstrap'){
            $pins=[];foreach(CP_INITIAL_CLI_BOOTSTRAP_LEAVES as $relative){$meta=cp_runtime_snapshot(CP_INITIAL_CLI_APP,$relative);$pins[$relative]=$meta['sha256']??null;}
            // No persisted PHP is evaluated here. Native CLI independently
            // checks these hashes, official entryPoint and installer journal.
            return ['version'=>1,'purpose'=>'clawpilot-native-email-initial-bootstrap-pins','operationId'=>$o['operation'],
                'cliSourceHash'=>hash_file('sha256',__DIR__.'/native-email-initial-cli.php'),
                'imagePackageHash'=>cp_runtime_context(CP_INITIAL_CLI_APP,CP_INITIAL_CLI_RUNTIME,__DIR__)['packageHash'],
                'bootstrapPins'=>$pins,'activeArtifactHash'=>file_exists($dir.'/input.json')
                    ?cp_initial_cli_protected_file($dir.'/input.json',4194304)['stat']['sha256']:null];
        }
        if($o['action']==='source-status')return cp_initial_artifact_source_status($dir,$o['operation']);
        if(in_array($o['action'],['origin-status','read-origin'],true)){
            $origin=cp_initial_artifact_origin(CP_INITIAL_CLI_STATE,$o['operation']);
            if($o['action']==='origin-status')return ['version'=>1,'purpose'=>'clawpilot-native-email-initial-retained-origin-status',
                'operationId'=>$o['operation'],'originSha256'=>$origin['stat']['sha256']??null];
            cp_initial_cli_need($origin!==null&&hash_equals($o['sha256'],$origin['stat']['sha256']),'retained_origin_changed');return $origin['bytes'];
        }
        $sha=$o['sha256'];
        if($o['action']==='read-source'){
            $read=cp_initial_cli_protected_file($dir.'/native-source.json',1800000);
            cp_initial_cli_need(hash_equals($sha,$read['stat']['sha256']),'retained_source_changed');return $read['bytes'];
        }
        $bytes=cp_initial_artifact_bytes($sha);$value=json_decode($bytes,true,64,JSON_THROW_ON_ERROR);
        cp_initial_cli_need(is_array($value)&&!array_is_list($value),'artifact_object');
        if($o['action']==='stage-input'){
            cp_initial_cli_artifact_shape($value);
            cp_initial_cli_need($value['operationId']===$o['operation']&&$bytes===cp_initial_cli_canonical($value)."\n",'input_domain');
            cp_initial_cli_identity($value);cp_initial_cli_pins($value);
            $active=$dir.'/input.json';$previous=file_exists($active)?cp_initial_cli_protected_file($active,4194304):null;
            if($previous!==null&&hash_equals($sha,$previous['stat']['sha256']))return ['operationId'=>$o['operation'],'sha256'=>$sha,'replayed'=>true];
            cp_initial_cli_need($o['previous']==='none'?$previous===null:$previous!==null&&hash_equals($o['previous'],$previous['stat']['sha256']),'input_compare_and_swap');
            if($previous!==null){$old=json_decode($previous['bytes'],true,64,JSON_THROW_ON_ERROR);
                cp_initial_cli_artifact_shape($old);
                foreach(['version','purpose','operationId','nativeInstanceId','appGeneration','appSourceFingerprint','database','serviceUserId','oauthClientId','cliSourceHash','imagePackageHash'] as $key)
                    cp_initial_cli_need(($old[$key]??null)===$value[$key],'operation_identity_changed');
                cp_initial_cli_need(cp_initial_cli_canonical($old['installationContext']??null)===cp_initial_cli_canonical($value['installationContext']??null),'operation_context_changed');}
            cp_initial_artifact_publish_once($dir.'/input-'.$sha.'.json',$bytes);
            $next=$dir.'/input-next-'.bin2hex(random_bytes(8)).'.json';cp_scope_write($next,$bytes);
            cp_initial_cli_need(rename($next,$active),'artifact_publish');cp_scope_sync_directory($dir);
            cp_initial_cli_need(cp_initial_cli_protected_file($active,4194304)['stat']['sha256']===$sha,'artifact_publish_readback');
            return ['operationId'=>$o['operation'],'sha256'=>$sha,'replayed'=>false];
        }
        if($o['action']==='retain-source'){
            $active=json_decode(cp_initial_cli_protected_file($dir.'/input.json',4194304)['bytes'],true,64,JSON_THROW_ON_ERROR);
            cp_initial_cli_source_shape($value,$active);
            cp_initial_cli_need($bytes===cp_initial_cli_canonical($value)."\n",'source_domain');
            cp_initial_cli_need(($active['operationId']??null)===$o['operation']&&($active['plan']??null)===null,'source_input_required');
            cp_initial_artifact_publish_once($dir.'/native-source.json',$bytes);
            return ['operationId'=>$o['operation'],'sourceArtifactDigest'=>$sha];
        }
        // Installation of a signed historical fact is not startup readiness.
        // The startup wrapper verifies signature, actual native ledger, journals
        // and full CURRENT invariants before Apache can be launched.
        cp_initial_cli_keys($value,['proof','signature']);
        cp_initial_cli_need(($value['proof']['operationId']??null)===$o['operation']
            &&($value['proof']['purpose']??null)==='clawpilot-native-email-initial-activation-origin'
            &&$bytes===cp_initial_cli_canonical($value),'origin_domain');
        require_once __DIR__.'/email-audience/NativeEmailStartupOrigin.php';
        ClawPilotNativeEmailStartupOrigin::verifyEnvelope($value,time());
        cp_initial_artifact_publish_once($dir.'/startup-origin.json',$bytes);
        cp_initial_artifact_publish_once(CP_INITIAL_CLI_STATE.'/activation-origin.json',$bytes);
        return ['operationId'=>$o['operation'],'originSha256'=>$sha];
    }finally{flock($lock,LOCK_UN);fclose($lock);}
}
if(PHP_SAPI==='cli'&&realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    try{ini_set('display_errors','0');$out=cp_initial_artifacts_run(array_slice($argv,1));
        fwrite(STDOUT,is_string($out)?$out:cp_initial_cli_canonical($out)."\n");}
    catch(Throwable $e){$code=$e->getMessage();if(preg_match('/^initial_(?:cli_|artifact_)[A-Za-z0-9_:.-]{1,100}$/D',$code)!==1)$code='initial_artifact_held';
        fwrite(STDERR,'Native initial artifact transport held: '.$code."\n");exit(1);}
}
