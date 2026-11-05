<?php
declare(strict_types=1);
// Disposable bridge setup/readback only. Never copied into a production image.
if(PHP_SAPI!=='cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_APP_PG')!=='1'
    || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION')!=='1')throw new RuntimeException('Explicit combined fixture required');
define('CLAWPILOT_AUTHORITY_HELPERS_ONLY',true);
require '/fixture/native-authority-transition.php';
(static function()use($argv):void {
$_REQUEST=[];$db=DBManagerFactory::getInstance()->database;
must(realpath('.')==='/app/public/legacy' && ($GLOBALS['sugar_config']['dbconfig']['db_name']??'')==='suitecrm_native_test',
    'Exact disposable native database required');
$admin=fresh('Users',rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0")[0]['id']);selectUser($admin);
$mode=$argv[1]??'';
if($mode==='prepare'){
    $public=trim((string)stream_get_contents(STDIN));
    $key=openssl_pkey_get_public($public);must($key!==false,'Synthetic public issuer key required');
    $details=openssl_pkey_get_details($key);must(is_array($details)&&$details['bits']===3072,'RSA3072 fixture key required');
    // The role acceptance stage enabled this in its CLI process. Persist the
    // exact same disposable setting for fresh HTTP/CLI workers; do not alter
    // the production attester or re-pin a mismatched runtime to make it pass.
    $override='/app/public/legacy/config_override.php';
    must(is_file($override)&&!is_link($override),'Fixture override required');
    $current=(string)file_get_contents($override);
    must(str_starts_with($current,'<?php')&&!str_contains($current,'?>'),'Exact open PHP fixture override required');
    $setting="\n\$sugar_config['clawpilot_managed_email_write_scope']=true;\n";
    must(file_put_contents($override,$setting,FILE_APPEND|LOCK_EX)===strlen($setting),'Persist exact fixture runtime setting');
    $GLOBALS['sugar_config']['clawpilot_managed_email_write_scope']=true;
    $runtime=ClawPilotNativeEmailRuntime::attest($db);
    $bindings=authorityRows($db,'SELECT runtime_fingerprint FROM clawpilot_email_bindings');
    must(count($bindings)>0,'Enrolled native fixture required');
    foreach($bindings as $binding)must(hash_equals($binding['runtime_fingerprint'],$runtime),'Existing native runtime pin must match; never rewrite it here');
    $copies=['NativeEmailAuthorityDelta.php','NativeEmailInitialPolicyDelta.php','NativeEmailTransaction.php','NativeEmailRuntime.php','NativeEmailCapabilityContract.php',
        'NativeEmailAuthorityContract.php','NativeEmailAuthorityProof.php','NativeEmailWriteScope.php','NativeEmailIdentityLink.php','NativeEmailAuthorityTransition.php'];
    foreach($copies as $file){$source='/source/email-audience/'.$file;$target='/app/public/legacy/custom/include/ClawPilot/'.$file;
        must(!is_link($source)&&!is_link($target),'Exact fixture files required');
        must(copy($source,$target)&&chmod($target,0644)&&hash_file('sha256',$source)===hash_file('sha256',$target),'Exact production helper bytes required');}
    $patch='/app/public/legacy/custom/include/native-email-scope/Patch.php';
    if(!is_dir(dirname($patch)))must(mkdir(dirname($patch),0755,true),'Fixture patch directory required');
    must(copy('/source/native-email-scope/Patch.php',$patch)&&chmod($patch,0644),'Exact runtime patch attester required');
    $route='/app/public/legacy/custom/application/Ext/Api/V8/Config/routes.php';
    must(!is_link($route)&&copy('/source/email-audience/authority-routes.php',$route)&&chmod($route,0644),'Exact authority routes required');
    $secret='Synthetic-combined-only-'.bin2hex(random_bytes(24));$client=native('OAuth2Clients');
    $client->name='Synthetic app PostgreSQL native bridge';$client->allowed_grant_type='client_credentials';
    $client->is_confidential=1;$client->assigned_user_id=$admin->id;
    $_REQUEST=['new_secret'=>$secret,'duration_amount'=>1,'duration_unit'=>'hour'];
    try{must((bool)$client->save(false),'Combined fixture OAuth client required');}finally{$_REQUEST=[];}
    $control=['enabled'=>true,'clientId'=>(string)$client->id,'keyId'=>'combined-fixture-key',
        'instanceId'=>'combined-fixture-instance','publicKey'=>$public];
    $path='/tmp/native-authority-http-control.json';$bytes=json_encode($control,JSON_THROW_ON_ERROR);
    must(file_put_contents($path,$bytes,LOCK_EX)===strlen($bytes)&&chmod($path,0600),'Private public-key control required');
    $ids=authorityRows($db,'SELECT email_id,global_id,local_id,pipeline_id,workspace_id FROM clawpilot_email_identities ORDER BY email_id');
    must(count($ids)>0&&count($ids)<=500,'Bounded native identity metadata required');
    $existing=authorityRows($db,"SELECT u.id,c.global_id_c FROM users u JOIN users_cstm c ON c.id_c=u.id
        WHERE u.user_name='gu7654321' AND c.global_id_c='gu7654321' AND u.status='Active' AND u.deleted=0");
    must(count($existing)===1,'Exact pre-existing canonical account required for combined first link');
    $config=['clientId'=>(string)$client->id,'clientSecret'=>$secret,'serviceUserId'=>(string)$admin->id,
        'keyId'=>$control['keyId'],'nativeInstanceId'=>$control['instanceId'],'identities'=>$ids,
        'existingIdentityLink'=>['userId'=>$existing[0]['id'],'globalId'=>'gu7654321','username'=>'gu7654321']];
    $bytes=json_encode($config,JSON_THROW_ON_ERROR);$path='/tmp/native-app-pg-config.json';
    must(file_put_contents($path,$bytes,LOCK_EX)===strlen($bytes)&&chmod($path,0600),'Private synthetic credential handoff required');
    fwrite(STDOUT,"NATIVE_APP_PG_PREPARED=1\n");
}elseif($mode==='content'){
    // No mail text is emitted. Digest includes native ownership/content and
    // unrelated native roles, but excludes intentional managed scope matrices.
    fwrite(STDOUT,json_encode(['contentDigest'=>authorityContent($db)],JSON_THROW_ON_ERROR)."\n");
}elseif($mode==='profile'){
    $runtime=ClawPilotNativeEmailRuntime::attest($db);
    foreach(authorityRows($db,'SELECT runtime_fingerprint FROM clawpilot_email_bindings') as $binding)
        must(hash_equals($binding['runtime_fingerprint'],$runtime),'Fresh worker runtime does not match retained native pin');
    fwrite(STDOUT,"NATIVE_APP_PG_FRESH_RUNTIME_PASSED=1\n");
}elseif($mode==='profile-acl'){
    // Numeric, rollback-only diagnosis of the unchanged production scan. This
    // is NOT an authority operation and cannot approve/grant/commit anything.
    // Native ACL evaluation and fresh native hydration are measured separately
    // so the next optimization is evidence-led rather than a deadline waiver.
    $profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'];
    $contentBefore=authorityContent($db);$previous=$GLOBALS['current_user'];$session=$_SESSION??[];
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
    try{
        ClawPilotNativeEmailRuntime::attest($db);
        $identities=authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id LIMIT 501 FOR UPDATE');
        $users=authorityRows($db,'SELECT id FROM users WHERE deleted=0 ORDER BY id LIMIT 501');
        must(count($identities)>0&&count($identities)<=500&&count($users)>0&&count($users)<=500,'Exact bounded profile required');
        $service=new ClawPilotNativeEmailAuthorityTransition($db,$profile,(string)$admin->id,'fixture-profile','fixture-profile','');
        $read=new ReflectionMethod($service,'readCapabilities');
        $ownership=new ReflectionMethod($service,'capabilityOwnershipRows');
        $hydrate=new ReflectionMethod($service,'hydrateCapabilityEmail');
        $measure=static function(callable $run):array{
            $stats=function_exists('mysqli_get_client_stats')?mysqli_get_client_stats():[];
            $gc=gc_status();$start=hrtime(true);$run();$milliseconds=(hrtime(true)-$start)/1000000;
            $after=function_exists('mysqli_get_client_stats')?mysqli_get_client_stats():[];$nextGc=gc_status();
            return ['milliseconds'=>round($milliseconds,3),
                'queries'=>isset($stats['result_set_queries'],$after['result_set_queries'])
                  ?(int)$after['result_set_queries']-(int)$stats['result_set_queries']:null,
                'preparedExecutions'=>isset($stats['com_stmt_execute'],$after['com_stmt_execute'])
                  ?(int)$after['com_stmt_execute']-(int)$stats['com_stmt_execute']:null,
                'gcRuns'=>(int)$nextGc['runs']-(int)$gc['runs'],
                'gcCollected'=>(int)$nextGc['collected']-(int)$gc['collected'],
                'peakBytes'=>memory_get_peak_usage(true)];
        };
        $full=$measure(static function()use($read,$service,$identities,$users,$tx):void{
            $matrix=$read->invoke($service,$identities,$users,$tx);
            must(count($matrix)===count($identities),'Profile must cover every real Email');
            foreach($matrix as $surfaces)must(count($surfaces)===5,'Profile must retain all native actions');
        });
        $rows=$ownership->invoke($service,$identities);
        $hydration=$measure(static function()use($users,$identities,$rows,$hydrate,$service):void{
            foreach($users as $row){
                $GLOBALS['current_user']=fresh('Users',$row['id']);$_SESSION=[];
                clawpilot_candidate_refresh_email_acl(true);
                foreach($identities as $identity)$email=$hydrate->invoke($service,$rows[$identity['email_id']]);
            }
        });
        $iterations=1000;
        $factory=$measure(static function()use($iterations):void{
            for($i=0;$i<$iterations;$i++){$email=BeanFactory::newBean('Emails');must(get_class($email)==='Email','Exact native class required');}
        });
        $constructor=$measure(static function()use($iterations):void{
            for($i=0;$i<$iterations;$i++){$email=new Email();must(get_class($email)==='Email','Exact native class required');}
        });
        must(authorityContent($db)===$contentBefore,'Profiling cannot alter native content/ownership/roles');
        ClawPilotNativeEmailRuntime::attest($db);
        $result=['version'=>2,'emailCount'=>count($identities),'principalCount'=>count($users),
            'constructorIterations'=>$iterations,'fullScan'=>$full,'usersAndHydration'=>$hydration,
            'factoryConstructor'=>$factory,'directConstructor'=>$constructor];
    }finally{$tx->rollback();$GLOBALS['current_user']=$previous;$_SESSION=$session;}
    fwrite(STDOUT,json_encode($result,JSON_THROW_ON_ERROR)."\n");
}elseif($mode==='diagnose'){
    $token=trim((string)stream_get_contents(STDIN));must(preg_match('/^[a-f0-9]{80}$/D',$token)===1,'Exact fixture token required');
    $config=json_decode((string)file_get_contents('/tmp/native-app-pg-config.json'),true,16,JSON_THROW_ON_ERROR);
    putenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='.$config['clientId']);
    $service=new ClawPilotNativeEmailAuthorityTransition($db,['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'],
        (string)$admin->id,$config['clientId'],$token,'');
    try{$service->inspect(['version'=>1]);$result=['cliInspection'=>'passed'];}
    catch(ClawPilotNativeEmailTransactionRefused $error){$result=['cliInspection'=>'held','code'=>$error->holdCode,'diagnostic'=>$error->diagnostic];}
    fwrite(STDOUT,json_encode($result,JSON_THROW_ON_ERROR)."\n");
}else throw new RuntimeException('Exact combined fixture operation required');
})();
