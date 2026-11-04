<?php
declare(strict_types=1);
// Disposable joint-fixture setup/client only. Authentication and lifecycle
// results always come from the stock OAuth middleware and installed V8 route.
const CP_JOINT_LIFECYCLE_APP='/var/lib/suitecrm/app';
const CP_JOINT_LIFECYCLE_CONTROL='/var/lib/suitecrm/initial-joint-lifecycle.json';
function cp_joint_lifecycle_need(bool $ok,string $label): void
{if(!$ok)throw new RuntimeException('joint_lifecycle_'.$label);}
function cp_joint_lifecycle_control(): array
{
    $path=CP_JOINT_LIFECYCLE_CONTROL;clearstatcache(true,$path);$m=lstat($path);
    cp_joint_lifecycle_need(is_array($m)&&!is_link($path)&&is_file($path)&&$m['uid']===0&&($m['mode']&0777)===0600
        &&$m['nlink']===1&&$m['size']<32768,'protected_control');
    return json_decode((string)file_get_contents($path),true,16,JSON_THROW_ON_ERROR);
}
function cp_joint_lifecycle_save(array $value,bool $exclusive=false): void
{
    $path=CP_JOINT_LIFECYCLE_CONTROL;$bytes=json_encode($value,JSON_THROW_ON_ERROR);$h=fopen($path,$exclusive?'x':'wb');
    cp_joint_lifecycle_need(is_resource($h),'control_open');
    try{cp_joint_lifecycle_need(chmod($path,0600)&&fwrite($h,$bytes)===strlen($bytes)&&fflush($h)&&fsync($h),'control_write');}
    finally{fclose($h);}
}
function cp_joint_lifecycle_request(string $origin,string $prefix,string $path,?string $token,string $body,string $method='POST',
    string $type='application/vnd.api+json'): array
{
    static $requests=0;
    cp_joint_lifecycle_need(++$requests<=8&&in_array($origin,['http://127.0.0.1:8080','http://127.0.0.1:8099'],true)
        &&in_array($prefix,['/legacy',''],true)&&str_starts_with($path,'/Api/'),'bounded_local_request');
    $curl=curl_init($origin.$prefix.$path);$headers=['Content-Type: '.$type,'Accept: application/json'];
    if($token!==null)$headers[]='Authorization: Bearer '.$token;
    curl_setopt_array($curl,[CURLOPT_CUSTOMREQUEST=>$method,CURLOPT_POSTFIELDS=>$body,CURLOPT_HTTPHEADER=>$headers,
        CURLOPT_RETURNTRANSFER=>true,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_PROXY=>'',CURLOPT_CONNECTTIMEOUT=>2,CURLOPT_TIMEOUT=>6,
        CURLOPT_PROTOCOLS=>CURLPROTO_HTTP]);
    $result=curl_exec($curl);$status=(int)curl_getinfo($curl,CURLINFO_RESPONSE_CODE);$error=curl_errno($curl);curl_close($curl);
    cp_joint_lifecycle_need($error===0&&is_string($result)&&strlen($result)<131072,'bounded_http_response');
    $document=json_decode($result,true,24,JSON_THROW_ON_ERROR);
    cp_joint_lifecycle_need(is_array($document),'http_document');
    return ['status'=>$status,'document'=>$document,'bodySha256'=>hash('sha256',$result)];
}
function cp_joint_lifecycle_inspect(string $origin,string $prefix,array $records,?string $token): array
{return cp_joint_lifecycle_request($origin,$prefix,'/Api/V8/custom/clawpilot-record-lifecycle/inspect',$token,
    json_encode(['version'=>1,'records'=>$records],JSON_THROW_ON_ERROR));}
/** A short-lived stock PHP API router, no authentication adapter. The child is
 * stopped and reaped before any return, including HTTP/assertion failures. */
function cp_joint_lifecycle_local_server(callable $run): array
{
    $state=cp_joint_lifecycle_control();$priorClient=getenv('SUITECRM_CLIENT_ID');$priorFlag=getenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED');
    putenv('SUITECRM_CLIENT_ID='.$state['clientId']);putenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=0');
    $child=proc_open(['php','-d','memory_limit=384M','-d','display_errors=0','-S','127.0.0.1:8099',
        '-t',CP_JOINT_LIFECYCLE_APP.'/public/legacy',__FILE__],
        [0=>['file','/dev/null','r'],1=>['file','/tmp/joint-lifecycle-http.log','a'],2=>['file','/tmp/joint-lifecycle-http.log','a']],$pipes,'/');
    cp_joint_lifecycle_need(is_resource($child),'temporary_server_start');$status=proc_get_status($child);$pid=$status['pid'];
    try{
        $until=microtime(true)+3;
        do{$socket=@fsockopen('127.0.0.1',8099,$errno,$error,0.05);if(is_resource($socket)){fclose($socket);break;}
            cp_joint_lifecycle_need(proc_get_status($child)['running']&&microtime(true)<$until,'temporary_server_ready');usleep(50000);}while(true);
        $result=$run($state);
    }finally{
        if(proc_get_status($child)['running'])proc_terminate($child);
        $until=microtime(true)+1;
        while(proc_get_status($child)['running']&&microtime(true)<$until)usleep(10000);
        if(proc_get_status($child)['running'])proc_terminate($child,9);
        proc_close($child);clearstatcache(true,'/proc/'.$pid);
        cp_joint_lifecycle_need(!is_dir('/proc/'.$pid),'temporary_server_stopped');
        putenv($priorClient===false?'SUITECRM_CLIENT_ID':'SUITECRM_CLIENT_ID='.$priorClient);
        putenv($priorFlag===false?'CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED':'CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED='.$priorFlag);
    }
    return $result+['temporaryRouterPid'=>$pid,'temporaryRouterStopped'=>true,'stockOAuthMiddleware'=>true];
}
/** Called only from the original source fixture BEFORE its first inspection. */
function cp_joint_lifecycle_seed(string $adminId,string $clientId,string $clientSecret,array $related): array
{
    cp_joint_lifecycle_need(PHP_SAPI==='cli'&&getenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED')==='1'
        &&!file_exists(CP_JOINT_LIFECYCLE_CONTROL)&&count($related)===2,'fresh_source_seed');
    $meetingRoundtrip=getenv('CLAWPILOT_NATIVE_JOINT_MEETING_ROUNDTRIP')==='1';
    foreach(['Accounts'=>'Account','Contacts'=>'Contact',...($meetingRoundtrip?['Meetings'=>'Meeting']:[])] as $module=>$object){
        $bean=BeanFactory::newBean($module);$dynamic=new DynamicField($module);$dynamic->setup($bean);
        cp_joint_lifecycle_need(!$dynamic->getFieldWidget($module,'global_id_c'),'fresh_global_field');
        $field=get_widget('varchar');$field->name='global_id';$field->label='LBL_GLOBAL_ID';$field->vname='LBL_GLOBAL_ID';
        $field->label_value='Joint fixture Global ID';$field->len='32';$field->required=false;$field->audited=false;$field->reportable=true;$field->save($dynamic);
        VardefManager::clearVardef($module,$object);unset($GLOBALS['dictionary'][$object]);VardefManager::refreshVardefs($module,$object);
    }
    $records=[];
    foreach([['Accounts',$related[0]['account'],'ga1234567'],['Contacts',$related[0]['contact'],'gc1234567']] as [$module,$nativeId,$globalId]){
        $GLOBALS['reload_vardefs']=true;$bean=BeanFactory::newBean($module);unset($GLOBALS['reload_vardefs']);
        cp_joint_lifecycle_need((bool)$bean->retrieve($nativeId,false),'related_retrieve');
        cp_joint_lifecycle_need($bean instanceof SugarBean&&$bean->id===$nativeId&&isset($bean->field_defs['global_id_c']),'exact_related_bean');
        $bean->global_id_c=$globalId;
        if($meetingRoundtrip&&$module==='Contacts')$bean->email1='joint-meeting-contact@example.invalid';
        cp_joint_lifecycle_need((bool)$bean->save(false),'related_global_save');
        $records[]=['module'=>$module,'nativeId'=>$nativeId,'globalId'=>$globalId];
    }
    $state=['version'=>1,'fixtureOnly'=>true,'clientId'=>$clientId,'clientSecret'=>$clientSecret,'adminId'=>$adminId,'records'=>$records,
        'missing'=>['module'=>'Accounts','nativeId'=>'joint-lifecycle-never-created','globalId'=>'ga1111111'],
        ...($meetingRoundtrip?['meetingRoundtrip'=>true,'contactEmail'=>'joint-meeting-contact@example.invalid']:[])];
    if($meetingRoundtrip){
        // Pinned stock Meeting::save invokes this derived free/busy cache.
        // Run the actual implementation once as explicit synthetic setup,
        // before RootA, to warm Calendar/vCal metadata and retain its row ID.
        require_once 'modules/vCals/vCal.php';$admin=BeanFactory::getBean('Users',$adminId);
        cp_joint_lifecycle_need($admin instanceof User&&$admin->id===$adminId&&$admin->is_admin==1,'freebusy_actual_fixture_admin');
        vCal::cache_sugar_vcal($admin);
        $manager=DBManagerFactory::getInstance();$result=$manager->query("SELECT id,user_id,type,source,deleted,date_entered,content FROM vcals WHERE user_id='"
            .$manager->quote($adminId)."' AND type='vfb' AND source='sugar' AND deleted=0",true);$freebusy=[];
        while($row=$manager->fetchByAssoc($result,false))$freebusy[]=$row;
        cp_joint_lifecycle_need(count($freebusy)===1&&is_string($freebusy[0]['content'])&&strlen($freebusy[0]['content'])<=65536,'exact_freebusy_cache_setup');
        $state['stockFreeBusyWarmup']=['fixtureOnly'=>true,'beforeRootSource'=>true,'actualStockCacheMethod'=>'vCal::cache_sugar_vcal',
            'table'=>'vcals','nativeUserId'=>$adminId,'nativeRowId'=>$freebusy[0]['id'],'type'=>'vfb','source'=>'sugar','activeRows'=>1,
            'dateEntered'=>$freebusy[0]['date_entered'],'contentBytes'=>strlen($freebusy[0]['content']),
            'contentSha256'=>hash('sha256',$freebusy[0]['content']),'metadataDependenciesWarmed'=>true];
    }
    cp_joint_lifecycle_save($state,true);
    $warmup=cp_joint_lifecycle_local_server(static function(array $state): array{
        $r=cp_joint_lifecycle_request('http://127.0.0.1:8099','','/Api/access_token',null,http_build_query([
            'grant_type'=>'client_credentials','client_id'=>$state['clientId'],'client_secret'=>$state['clientSecret']]),'POST','application/x-www-form-urlencoded');
        cp_joint_lifecycle_need($r['status']===200&&is_string($r['document']['access_token']??null),'real_oauth_grant');
        $state['accessToken']=$r['document']['access_token'];
        if(($state['meetingRoundtrip']??false)!==true)unset($state['clientSecret']);$requests=[];
        foreach($state['records'] as $record){$result=cp_joint_lifecycle_request('http://127.0.0.1:8099','',
            '/Api/V8/module/'.$record['module'].'/'.$record['nativeId'],$state['accessToken'],'','GET');
            cp_joint_lifecycle_need($result['status']===200,'stock_api_warmup');$requests[]=['module'=>$record['module'],'status'=>$result['status'],'bodySha256'=>$result['bodySha256']];}
        if(($state['meetingRoundtrip']??false)===true){
            $GLOBALS['reload_vardefs']=true;$meeting=BeanFactory::newBean('Meetings');unset($GLOBALS['reload_vardefs']);
            cp_joint_lifecycle_need(isset($meeting->field_defs['global_id_c']),'meeting_global_field_warmed');
            $result=cp_joint_lifecycle_request('http://127.0.0.1:8099','','/Api/V8/module/Meetings/joint-meeting-never-created',
                $state['accessToken'],'','GET');
            // The existing production client documents stock V8's400 for a
            // valid module/id lookup with no matching bean;404 is also valid.
            cp_joint_lifecycle_need(in_array($result['status'],[400,404],true),'stock_meeting_api_warmup');
            $requests[]=['module'=>'Meetings','status'=>$result['status'],'bodySha256'=>$result['bodySha256'],'nonexistentFixtureOnly'=>true];
        }
        cp_joint_lifecycle_save($state);return ['actualTokenIssuedBeforeRootSource'=>true,'stockRecordWarmup'=>$requests,
            ...(isset($state['stockFreeBusyWarmup'])?['stockFreeBusyWarmup'=>$state['stockFreeBusyWarmup']]:[])];
    });
    $state=cp_joint_lifecycle_control();$state['warmup']=$warmup;cp_joint_lifecycle_save($state);return $warmup;
}
if(defined('CP_JOINT_LIFECYCLE_INCLUDE_ONLY'))return;
$mode=$argv[1]??'';
if(PHP_SAPI==='cli-server'){
    cp_joint_lifecycle_need(getenv('CLAWPILOT_NATIVE_INITIAL_FIXTURE')==='1'
        &&($_SERVER['REMOTE_ADDR']??'')==='127.0.0.1'&&($_SERVER['HTTP_HOST']??'')==='127.0.0.1:8099','router_scope');
    $path=parse_url($_SERVER['REQUEST_URI']??'',PHP_URL_PATH);
    if(!is_string($path)||!str_starts_with($path,'/Api/')){http_response_code(404);return;}
    chdir(CP_JOINT_LIFECYCLE_APP.'/public/legacy');$_SERVER['SCRIPT_NAME']='/Api/index.php';$_SERVER['PHP_SELF']='/Api/index.php';
    $_SERVER['SCRIPT_FILENAME']=CP_JOINT_LIFECYCLE_APP.'/public/legacy/Api/index.php';require 'Api/Core/app.php';$app->run();return;
}
cp_joint_lifecycle_need(PHP_SAPI==='cli'&&getenv('CLAWPILOT_NATIVE_INITIAL_FIXTURE')==='1'&&count($argv)===2
    &&trim((string)file_get_contents(CP_JOINT_LIFECYCLE_APP.'/VERSION'))==='8.10.1','isolated_mode');
if($mode==='prepare-directory'){
    cp_joint_lifecycle_need(posix_geteuid()===0&&!file_exists(CP_JOINT_LIFECYCLE_CONTROL),'pre_source_root');
    $path=CP_JOINT_LIFECYCLE_APP.'/public/legacy/config_override.php';$bytes=(string)file_get_contents($path);
    cp_joint_lifecycle_need(!str_contains($bytes,'JOINT_LIFECYCLE_FIXTURE'),'fresh_config');$bytes=preg_replace('/\\?>\\s*$/','',$bytes);
    $bytes.="\n// JOINT_LIFECYCLE_FIXTURE: synthetic local OAuth setup before RootA.\n"
        .'$sugar_config[\'site_url\']=\'http://127.0.0.1:8080/legacy\';'."\n"
        .'$sugar_config[\'trusted_hosts\']=[\'^127\\\\.0\\\\.0\\\\.1$\'];'."\n"
        .'$sugar_config[\'oauth2_encryption_key\']='.var_export(bin2hex(random_bytes(32)),true).";\n"
        .'$sugar_config[\'session_dir\']=\'/tmp\';'."\n".'$sugar_config[\'log_dir\']=\'/tmp\';'."\n"
        .'$sugar_config[\'logger\'][\'file\'][\'name\']=\'joint-lifecycle-suitecrm\';'."\n";
    token_get_all($bytes,TOKEN_PARSE);cp_joint_lifecycle_need(file_put_contents($path,$bytes)===strlen($bytes),'config_write');
    $directory=CP_JOINT_LIFECYCLE_APP.'/public/legacy/Api/V8/OAuth2';
    foreach(['private.key','public.key'] as $file)cp_joint_lifecycle_need(!file_exists($directory.'/'.$file),'fresh_oauth_keys');
    cp_joint_lifecycle_need(chmod($directory,01777),'temporary_key_creation_directory');
    echo json_encode(['fixtureOnly'=>true,'preparedBeforeRootSource'=>true,'configSha256'=>hash('sha256',$bytes)])."\n";return;
}
if($mode==='prepare-keys'){
    cp_joint_lifecycle_need(posix_geteuid()===33&&posix_getegid()===0,'www_data_key_owner');$directory=CP_JOINT_LIFECYCLE_APP.'/public/legacy/Api/V8/OAuth2';
    $key=openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>2048]);
    cp_joint_lifecycle_need($key!==false&&openssl_pkey_export($key,$private),'synthetic_keypair');
    foreach(['private.key'=>$private,'public.key'=>openssl_pkey_get_details($key)['key']] as $file=>$bytes){$h=fopen($directory.'/'.$file,'x');
        cp_joint_lifecycle_need(is_resource($h),'exclusive_key');try{cp_joint_lifecycle_need(chmod($directory.'/'.$file,0640)
            &&fwrite($h,$bytes)===strlen($bytes)&&fflush($h)&&fsync($h),'complete_key');}finally{fclose($h);}}
    echo "{\"fixtureOnly\":true,\"syntheticOAuthKeysCreated\":true,\"uid\":33,\"gid\":0,\"mode\":416}\n";return;
}
if($mode==='finalize-keys'){
    cp_joint_lifecycle_need(posix_geteuid()===0,'root_finalize');$directory=CP_JOINT_LIFECYCLE_APP.'/public/legacy/Api/V8/OAuth2';
    cp_joint_lifecycle_need(chmod($directory,0755),'restore_directory');$keys=[];
    foreach(['private.key','public.key'] as $file){$m=lstat($directory.'/'.$file);
        cp_joint_lifecycle_need(is_array($m)&&!is_link($directory.'/'.$file)&&$m['uid']===33&&$m['gid']===0&&($m['mode']&0777)===0640,'exact_key_owner_mode');
        $keys[$file]=['sha256'=>hash_file('sha256',$directory.'/'.$file),'uid'=>$m['uid'],'gid'=>$m['gid'],'mode'=>$m['mode']&0777];}
    echo json_encode(['fixtureOnly'=>true,'keys'=>$keys,'directoryMode'=>0755],JSON_THROW_ON_ERROR)."\n";return;
}
$state=cp_joint_lifecycle_control();
if($mode==='metadata'){
    echo json_encode(['version'=>1,'purpose'=>'joint-record-lifecycle-fixture-metadata','records'=>$state['records'],'missing'=>$state['missing'],
        'clientId'=>$state['clientId'],'adminId'=>$state['adminId'],'accessTokenSha256'=>hash('sha256',$state['accessToken']),
        'warmup'=>$state['warmup'],'credentialsRetainedInPrivateFixtureOnly'=>true],JSON_THROW_ON_ERROR)."\n";return;
}
if($mode==='disabled'){
    $result=cp_joint_lifecycle_local_server(static function(array $state): array{
        $r=cp_joint_lifecycle_inspect('http://127.0.0.1:8099','',$state['records'],$state['accessToken']);
        cp_joint_lifecycle_need($r['status']===409&&$r['document']===['ok'=>false,'code'=>'NATIVE_RECORD_LIFECYCLE_DISABLED'],'disabled_exact_response');
        return ['status'=>$r['status'],'code'=>$r['document']['code'],'bodySha256'=>$r['bodySha256'],'flag'=>'0'];
    });
    echo json_encode(['version'=>1,'purpose'=>'joint-record-lifecycle-disabled-probe']+$result,JSON_THROW_ON_ERROR)."\n";return;
}
cp_joint_lifecycle_need($mode==='http-active'&&getenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED')==='1','active_mode');
$none=cp_joint_lifecycle_inspect('http://127.0.0.1:8080','/legacy',$state['records'],null);
cp_joint_lifecycle_need($none['status']===401,'actual_oauth_unauthenticated_refusal');
$records=[...$state['records'],$state['missing']];$r=cp_joint_lifecycle_inspect('http://127.0.0.1:8080','/legacy',$records,$state['accessToken']);
cp_joint_lifecycle_need($r['status']===200&&($r['document']['version']??null)===1
    &&count($r['document']['records']??[])===3,'actual_lifecycle_document');
foreach($records as $index=>$record){$actual=$r['document']['records'][$index];$date=$actual['dateModified']??null;
    cp_joint_lifecycle_need($actual===$record+['state'=>$index===2?'missing':'active','dateModified'=>$date]
        &&($index===2?$date===null:is_string($date)&&preg_match('/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/D',$date)===1),'exact_record_state');}
$bad=$state['records'][0];$bad['globalId']='ga9999999';$mismatch=cp_joint_lifecycle_inspect('http://127.0.0.1:8080','/legacy',[$state['records'][1],$bad],$state['accessToken']);
cp_joint_lifecycle_need($mismatch['status']===409&&!isset($mismatch['document']['records']),'mismatch_no_partial_evidence');
echo json_encode(['version'=>1,'purpose'=>'joint-real-apache-authenticated-record-lifecycle','flag'=>'1','httpPort'=>8080,
    'oauthTokenIssuedBeforeRootSource'=>true,'unauthenticatedStatus'=>$none['status'],'status'=>$r['status'],'records'=>$r['document']['records'],
    'mismatchStatus'=>$mismatch['status'],'bodySha256'=>$r['bodySha256'],'noFixtureAuthenticationAdapter'=>true],JSON_THROW_ON_ERROR)."\n";
