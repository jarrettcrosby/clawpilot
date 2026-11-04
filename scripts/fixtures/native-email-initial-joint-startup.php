<?php
declare(strict_types=1);
// Actual native-current startup COMPONENT acceptance. This file is not shipped
// as a production entrypoint and deliberately does NOT claim Apache, the full
// enrolled-startup wrapper, the service image, or current PG synchronization.
if(PHP_SAPI!=='cli'||PHP_OS_FAMILY!=='Linux'||PHP_VERSION_ID!==80336
    ||!function_exists('posix_geteuid')||posix_geteuid()!==0||!in_array(count($argv),[1,2],true)
    ||getenv('CLAWPILOT_NATIVE_INITIAL_FIXTURE')!=='1')throw new RuntimeException('Isolated root native component fixture required');
ini_set('display_errors','0');
function cp_joint_apache_identity(int $pid,string $name,array $args,array $uids,int $parentPid): array
{
    if($pid<1||$name!=='apache2')throw new RuntimeException('Actual Apache process required');
    $direct=in_array($args,[['apache2','-DFOREGROUND'],['/usr/sbin/apache2','-DFOREGROUND']],true);
    // Exact r465b observation of this linux/amd64 service image on Apple
    // Silicon. Only www-data children may have this tuple; it does not exempt
    // arbitrary emulators, PHP, other executable prefixes or background jobs.
    $rosettaChild=$args===['/run/rosetta/rosetta','/usr/sbin/apache2','apache2','-DFOREGROUND'];
    if($pid===1){
        if(!$direct||$parentPid!==0||$uids!==[0,0,0,0])throw new RuntimeException('Root Apache PID1 required');
    }elseif($parentPid!==1||$uids!==[33,33,33,33]||(!$direct&&!$rosettaChild))throw new RuntimeException('Exact www-data Apache child required');
    return ['pid'=>$pid,'parentPid'=>$parentPid,'uid'=>$uids[0],'name'=>$name,'argv'=>$args,
        'argvProfile'=>$rosettaChild?'observed-rosetta-amd64-child':'direct-foreground'];
}
// Harness-only observations do not include SuiteCRM, open a database, write a
// cache or return a fake native-readiness result. They audit the actual image
// entrypoint before and after its separately launched real Apache processes.
if(count($argv)===2){
    if($argv[1]==='--service-process-profile-self-test'){
        $root=[1,'apache2',['apache2','-DFOREGROUND'],[0,0,0,0],0];
        $child=[35,'apache2',['/run/rosetta/rosetta','/usr/sbin/apache2','apache2','-DFOREGROUND'],[33,33,33,33],1];
        $valid=[$root,$child,[36,'apache2',['/usr/sbin/apache2','-DFOREGROUND'],[33,33,33,33],1]];
        foreach($valid as $case)cp_joint_apache_identity(...$case);
        $invalid=[];
        foreach(array_keys($child[2]) as $index){$case=$child;$case[2][$index].='-altered';$invalid[]=$case;}
        $case=$child;array_unshift($case[2],'/wrong/prefix');$invalid[]=$case;
        $case=$child;$case[2][]='extra-argument';$invalid[]=$case;
        $case=$child;$case[4]=2;$invalid[]=$case;
        foreach(range(0,3) as $index){$case=$child;$case[3][$index]=0;$invalid[]=$case;}
        $case=$root;$case[2]=$child[2];$invalid[]=$case;
        $case=$root;$case[4]=1;$invalid[]=$case;
        $case=$root;$case[3]=[33,33,33,33];$invalid[]=$case;
        $case=$child;$case[1]='php';$invalid[]=$case;
        $case=$child;$case[0]=0;$invalid[]=$case;
        $rejected=0;foreach($invalid as $case){try{cp_joint_apache_identity(...$case);}catch(RuntimeException $error){$rejected++;}}
        if($rejected!==count($invalid))throw new RuntimeException('Altered Apache observation accepted');
        fwrite(STDOUT,json_encode(['kind'=>'pure-apache-observation-profile-test','passed'=>true,'accepted'=>count($valid),
            'rejected'=>$rejected,'databaseCreated'=>false,'nativeStartupExecuted'=>false],JSON_THROW_ON_ERROR)."\n");return;
    }
    if($argv[1]==='--service-files'){
        $root='/var/lib/suitecrm';$files=[];$count=0;
        foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::SELF_FIRST) as $file){
            $path=$file->getPathname();clearstatcache(true,$path);$m=lstat($path);
            if(!is_array($m)||is_link($path)||++$count>60000||(!$file->isFile()&&!$file->isDir()))throw new RuntimeException('Exact native fixture files required');
            $row=['mode'=>$m['mode']&0777,'uid'=>$m['uid'],'gid'=>$m['gid'],'ino'=>$m['ino'],'nlink'=>$m['nlink'],'mtime'=>$m['mtime'],'ctime'=>$m['ctime']];
            if($file->isDir())$row['directory']=true;else{$row['size']=$m['size'];$row['sha256']=hash_file('sha256',$path);}
            $files[substr($path,strlen($root)+1)]=$row;
        }
        ksort($files,SORT_STRING);fwrite(STDOUT,json_encode($files,JSON_THROW_ON_ERROR)."\n");return;
    }
    if($argv[1]==='--service-processes'){
        $apache=[];$forbidden=[];
        foreach(glob('/proc/[0-9]*') as $path){
            $pid=(int)basename($path);if($pid===getmypid())continue;
            $comm=@file_get_contents($path.'/comm');$cmd=@file_get_contents($path.'/cmdline');$status=@file_get_contents($path.'/status');
            if(!is_dir($path))continue;
            if(!is_string($comm)||!is_string($cmd)||!is_string($status))throw new RuntimeException('Complete fixture process observation required');
            $name=trim($comm);$args=array_values(array_filter(explode("\0",$cmd)));$names=array_merge([$name],array_map('basename',$args));
            foreach($names as $candidate)if(preg_match('/^(?:php(?:[0-9.]*)?|php-fpm.*|supervisord|scheduler-loop\.sh|messenger-loop\.sh|cron|crond)$/iD',$candidate))$forbidden[$pid]=$name;
            if($name==='apache2'){
                if(!preg_match('/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m',$status,$uid)
                    ||!preg_match('/^PPid:\s+(\d+)$/m',$status,$parent))throw new RuntimeException('Exact Apache process identity required');
                $apache[]=cp_joint_apache_identity($pid,$name,$args,array_map('intval',array_slice($uid,1)),(int)$parent[1]);
            }
        }
        usort($apache,static fn(array $a,array $b):int=>$a['pid']<=>$b['pid']);
        fwrite(STDOUT,json_encode(['apache'=>$apache,'forbidden'=>$forbidden],JSON_THROW_ON_ERROR)."\n");return;
    }
    throw new RuntimeException('Named fixture-only observation required');
}
require '/opt/clawpilot/native-email-enrolled-startup.php';

try{
    // Match production wrapper/CLI function scope. A top-level $db mysqli
    // assignment would overwrite SuiteCRM's $GLOBALS['db'] DBManager and
    // correctly fail NativeRuntime's native_global_manager_changed guard.
    (static function(): void {
    cp_native_startup_need(getenv('CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED')==='1'
        &&getenv('CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED')==='1','activation_environment_required');
    cp_scope_quiescent(true);
    cp_scope_protected_directory(CP_INITIAL_CLI_STATE,false);
    cp_scope_protected_directory(CP_INITIAL_CLI_STATE.'/operations',false);
    $path=CP_INITIAL_CLI_STATE.'/'.CP_NATIVE_STARTUP_CERTIFICATE;
    $certificate=cp_initial_private($path,262144);$envelope=json_decode($certificate,true,64,JSON_THROW_ON_ERROR);
    cp_native_startup_need(is_array($envelope)&&ClawPilotNativeEmailStartupOrigin::canonical($envelope)===$certificate,'certificate_canonical');
    $proof=ClawPilotNativeEmailStartupOrigin::verifyEnvelope($envelope,time());
    $dir=CP_INITIAL_CLI_STATE.'/operations/'.$proof['operationId'];cp_scope_protected_directory($dir,false);
    $inputPath=$dir.'/input.json';$input=cp_initial_private($inputPath);$inputHash=hash('sha256',$input);
    // Reuse the production retained-artifact validator and exact pre-include
    // checks, rather than a fixture completeness/authority boolean.
    $artifact=json_decode($input,true,64,JSON_THROW_ON_ERROR);$root=cp_native_startup_files($artifact,$proof);$context=$root['context'];
    $lock=cp_initial_installer_lock($context);
    try{
        cp_native_startup_need(hash('sha256',cp_initial_private($path,262144))===hash('sha256',$certificate)
            &&hash('sha256',cp_initial_private($inputPath))===$inputHash,'protected_input_changed');
        cp_native_startup_files($artifact,$proof);
        cp_initial_cli_identity($artifact);cp_initial_cli_pins($artifact);
        $db=cp_initial_cli_cold_bootstrap($artifact);
        require_once '/opt/clawpilot/email-audience/NativeEmailAuthorityTransition.php';
        $profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>$artifact['database']];
        $origin=ClawPilotNativeEmailStartupOriginAuthority::fromProtectedFile($db,$profile,$path,CP_INITIAL_CLI_APP,CP_INITIAL_CLI_STATE,'/opt/clawpilot');
        $service=new ClawPilotNativeEmailAuthorityTransition($db,$profile,$proof['serviceUserId'],$proof['oauthClientId'],'','');
        // This ACTUAL call must complete and roll back. Merely constructing
        // the typed origin capability cannot produce a passing result.
        $snapshot=$service->inspectStartupOrigin($origin);
        cp_native_startup_need(($snapshot['version']??null)===1&&is_int($snapshot['generation']??null)
            &&$snapshot['generation']>=$proof['originGeneration']&&count($snapshot['bindings'])===3
            &&count($snapshot['capabilities'])===329&&count($snapshot['principalSuiteCrmUserIds'])===4,'complete_current_inspection_required');
        $state=$db->query('SELECT @@in_transaction AS activeTransaction')->fetch_assoc();
        cp_native_startup_need((string)$state['activeTransaction']==='0','rollback_required');
        fwrite(STDOUT,ClawPilotNativeEmailAuthorityContract::canonical(['version'=>1,'kind'=>'native-current-startup-component',
            'passed'=>true,'freshProcess'=>true,'actualCurrentNativeInspectionCompleted'=>true,'nativeTransactionRolledBack'=>true,
            'generation'=>$snapshot['generation'],'originVersion'=>$proof['version'],'emailCount'=>count($snapshot['capabilities']),'pipelineCount'=>count($snapshot['bindings']),
            'principalCount'=>count($snapshot['principalSuiteCrmUserIds']),'snapshotFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($snapshot),
            'apacheWrapperProven'=>false,'fullImageProven'=>false])."\n");
    }finally{flock($lock,LOCK_UN);fclose($lock);}
    })();
}catch(Throwable $error){
    $code=$error instanceof ClawPilotNativeEmailTransactionRefused?$error->holdCode:$error->getMessage();
    if(!is_string($code)||preg_match('/^(?:native_startup_|startup_origin_|runtime_|authority_|managed_|native_)[A-Za-z0-9_:.-]{1,160}$/D',$code)!==1)
        $code='native_startup_component_held';
    fwrite(STDERR,json_encode(['held'=>true,'code'=>$code],JSON_THROW_ON_ERROR)."\n");exit(1);
}
