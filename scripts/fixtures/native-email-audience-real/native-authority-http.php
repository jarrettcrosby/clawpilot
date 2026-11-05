<?php
declare(strict_types=1);
// Actual V8 OAuth + native approval/phase routes. All issuer keys, credentials,
// plans and app-commit evidence here are explicitly disposable synthetic data.
if(PHP_SAPI!=='cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION')!=='1')throw new RuntimeException('Disposable authority HTTP fixture required');
define('CLAWPILOT_AUTHORITY_HELPERS_ONLY',true);
require '/fixture/native-authority-transition.php';
const AUTHORITY_HTTP_CONTROL='/tmp/native-authority-http-control.json';
const AUTHORITY_HTTP_ROUTE='/Api/V8/custom/clawpilot-email-authority/';
function authorityHttp(string $path,?string $token,string $body,string $type='application/vnd.api+json'):array {
    must(str_starts_with($path,'/') && !str_starts_with($path,'//'),'Exact fixture local path required');
    $curl=curl_init();$output='';$headers=[];$request=['Content-Type: '.$type,'Accept: application/vnd.api+json'];
    if($token!==null)$request[]='Authorization: Bearer '.$token;
    curl_setopt_array($curl,[CURLOPT_URL=>'http://127.0.0.1:8099'.$path,CURLOPT_PROXY=>'',CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$body,
        CURLOPT_HTTPHEADER=>$request,CURLOPT_CONNECTTIMEOUT=>3,CURLOPT_TIMEOUT=>20,CURLOPT_FOLLOWLOCATION=>false,
        CURLOPT_PROTOCOLS=>CURLPROTO_HTTP,CURLOPT_REDIR_PROTOCOLS=>CURLPROTO_HTTP,
        CURLOPT_WRITEFUNCTION=>static function($curl,string $chunk)use(&$output):int{if(strlen($output)+strlen($chunk)>1048576)return 0;$output.=$chunk;return strlen($chunk);},
        CURLOPT_HEADERFUNCTION=>static function($curl,string $line)use(&$headers):int{$parts=explode(':',$line,2);if(count($parts)===2)$headers[strtolower(trim($parts[0]))]=trim($parts[1]);return strlen($line);}]);
    try{must(curl_exec($curl)!==false,'Bounded actual native HTTP request required');$status=(int)curl_getinfo($curl,CURLINFO_RESPONSE_CODE);
        $GLOBALS['authorityHttpStatus']=$status;$GLOBALS['authorityHttpPath']=$path;
        $GLOBALS['authorityHttpResponseKind']=$output===''?'empty':(is_array(json_decode($output,true))?'json':
            (str_starts_with(ltrim($output),'<')?'html':'other'));
        must(!isset($headers['location']),'Authority request may not redirect');
        return ['status'=>$status,'body'=>$output,'headers'=>$headers];}finally{curl_close($curl);}
}
function authorityHttpJson(array $r,int $status=200):array {
    must($r['status']===$status,'Authority HTTP status mismatch');$doc=json_decode($r['body'],true,64,JSON_THROW_ON_ERROR);
    must(is_array($doc)&&!array_is_list($doc),'Native HTTP object required');return $doc;
}
function authorityHttpDenied(array $r,string $code,int $status=409):void {
    must(authorityHttpJson($r,$status)===['ok'=>false,'code'=>$code] && ($r['headers']['cache-control']??'')==='private, no-store',
        'Exact generic noncacheable authority denial required');
}
function authorityHttpControl(bool $enabled,string $client):void {
    $data=['enabled'=>$enabled,'clientId'=>$client,'keyId'=>(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID'),
        'instanceId'=>(string)getenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID'),'publicKey'=>(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY')];
    must(!is_link(AUTHORITY_HTTP_CONTROL),'Private test configuration may not be symlinked');
    $json=json_encode($data,JSON_THROW_ON_ERROR);must(file_put_contents(AUTHORITY_HTTP_CONTROL,$json,LOCK_EX)===strlen($json)
        && chmod(AUTHORITY_HTTP_CONTROL,0600),'Synthetic authority configuration required');
}
function authorityHttpToken(string $client,string $secret):array {
    $r=authorityHttpJson(authorityHttp('/Api/access_token',null,http_build_query(['grant_type'=>'client_credentials',
        'client_id'=>$client,'client_secret'=>$secret]),'application/x-www-form-urlencoded'));
    $token=$r['access_token']??null;must(is_string($token),'Real native service token required');$parts=explode('.',$token);must(count($parts)===3,'Real native JWT required');
    $encoded=strtr($parts[1],'-_','+/');$claims=json_decode((string)base64_decode($encoded.str_repeat('=',(4-strlen($encoded)%4)%4),true),true,16,JSON_THROW_ON_ERROR);
    must(($claims['sub']??null)==='' && in_array($client,(array)($claims['aud']??[]),true)
        && preg_match('/^[a-f0-9]{80}$/D',(string)($claims['jti']??''))===1,'Actual empty-subject native client credentials required');
    return ['token'=>$token,'tokenId'=>$claims['jti']];
}
function authorityHttpWire(array $command,?array $authorization=null):string {
    return ClawPilotNativeEmailAuthorityContract::canonical($authorization===null?$command:['command'=>$command,'authorization'=>$authorization]);
}
function authorityHttpResign(array $e):array {
    must(openssl_sign(ClawPilotNativeEmailAuthorityContract::canonical($e['proof']),$signature,$GLOBALS['authorityFixtureSigningKey'],OPENSSL_ALGO_SHA256),'Synthetic signing required');
    $e['signature']=base64_encode($signature);return $e;
}
function authorityHttpState(mysqli $db):string {
    $state=['content'=>authorityContent($db)];foreach(['clawpilot_email_bindings'=>'pipeline_id','clawpilot_email_authority_approvals'=>'operation_id',
        'clawpilot_email_authority_operations'=>'operation_id','securitygroups_users'=>'id'] as $table=>$key)$state[$table]=authorityRows($db,'SELECT * FROM '.$table.' ORDER BY '.$key);
    return ClawPilotNativeEmailAuthorityContract::digest($state);
}
(static function():void{
    $staged=[];$phase='setup';$failed=false;
    try {
        umask(0077);$_REQUEST=[];$db=DBManagerFactory::getInstance()->database;
        must(realpath('.')==='/app/public/legacy' && ($GLOBALS['sugar_config']['dbconfig']['db_name']??'')==='suitecrm_native_test'
            && ($GLOBALS['sugar_config']['site_url']??'')==='http://127.0.0.1:8099','Exact synthetic native HTTP runtime required');
        $admin=fresh('Users',rows("SELECT id FROM users WHERE user_name='fixture-admin'")[0]['id']);selectUser($admin);authoritySigningSetup();
        $copies=[];foreach(['NativeEmailAuthorityDelta.php','NativeEmailInitialPolicyDelta.php','NativeEmailTransaction.php','NativeEmailRuntime.php','NativeEmailCapabilityContract.php','NativeEmailAuthorityContract.php',
            'NativeEmailAuthorityProof.php','NativeEmailWriteScope.php','NativeEmailIdentityLink.php','NativeEmailAuthorityTransition.php'] as $file)$copies['/source/email-audience/'.$file]='/app/public/legacy/custom/include/ClawPilot/'.$file;
        $copies['/source/native-email-scope/Patch.php']='/app/public/legacy/custom/include/native-email-scope/Patch.php';
        $copies['/source/email-audience/authority-routes.php']='/app/public/legacy/custom/application/Ext/Api/V8/Config/routes.php';
        foreach($copies as $source=>$target){must(is_file($source)&&!is_link($source)&&!file_exists($target)&&!is_link($target),'Fresh exact native authority route target required');
            for($parent=dirname($target);$parent!=='/app';$parent=dirname($parent))must(!is_link($parent),'No linked route directory');
            if(!is_dir(dirname($target)))must(mkdir(dirname($target),0755,true),'Private fixture route directory required');
            must(copy($source,$target)&&chmod($target,0644)&&hash_file('sha256',$source)===hash_file('sha256',$target),'Actual route bytes required');$staged[$target]=hash_file('sha256',$target);}
        $clients=[];$secrets=[];foreach(['allowed','wrong'] as $label){$client=native('OAuth2Clients');$client->name='Synthetic authority HTTP '.$label;
            $client->allowed_grant_type='client_credentials';$client->is_confidential=1;$client->assigned_user_id=$admin->id;
            $secrets[$label]='Synthetic-only-'.bin2hex(random_bytes(24));$_REQUEST=['new_secret'=>$secrets[$label],'duration_amount'=>1,'duration_unit'=>'hour'];
            try{must((bool)$client->save(false),'Synthetic authority OAuth client required');}finally{$_REQUEST=[];}$clients[$label]=(string)$client->id;}
        putenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='.$clients['allowed']);authorityHttpControl(false,$clients['allowed']);
        $allowed=authorityHttpToken($clients['allowed'],$secrets['allowed']);$wrong=authorityHttpToken($clients['wrong'],$secrets['wrong']);unset($secrets);
        $viewer=rows("SELECT id FROM users WHERE user_name='fixture-publisher-viewer'")[0]['id'];
        $member=authorityRows($db,'SELECT u.* FROM securitygroups_users u JOIN clawpilot_email_bindings b ON b.group_id=u.securitygroup_id WHERE u.user_id=? AND u.deleted=0',[$viewer]);
        must(count($member)===1,'Exact synthetic reader membership required');$before=ClawPilotNativeEmailAuthorityDelta::nativeRow($member[0]);$after=$before;$after['deleted']='1';$after['date_modified']=gmdate('Y-m-d H:i:s');
        $profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'];
        $c=authorityCommand($db,$profile,'revoke',[['before'=>$before,'after'=>$after]],hash('sha256','synthetic actual HTTP authority transition'));
        $e=authoritySigned($db,$c,(string)$admin->id,$clients['allowed']);$wire=authorityHttpWire($c,$e);$initial=authorityHttpState($db);
        $phase='disabled-and-unauthenticated';
        check('authority HTTP defaults disabled and real OAuth denies absent or invalid tokens',function()use($allowed,$wire,$c,$db,$initial):void{
            must(unlink(AUTHORITY_HTTP_CONTROL),'Default-off control removal required');
            foreach(['inspect','project','approve','execute','resolve','cancel-expired'] as $operation){$body=in_array($operation,['approve','cancel-expired'],true)?$wire:authorityHttpWire($c);
                authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.$operation,$allowed['token'],$body),'NATIVE_EMAIL_AUTHORITY_DISABLED');
                foreach([null,'invalid-synthetic-token'] as $token){$d=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.$operation,$token,$body),401);
                    must(isset($d['error'])&&!isset($d['state']),'Native middleware must reject token');}}
            must(authorityHttpState($db)===$initial,'Denied request may not change native state');
        });authorityHttpControl(true,$clients['allowed']);$phase='read-only-inspection';
        check('actual OAuth inspection and forecast return only bounded policy metadata and never create approvals',function()use($allowed,$wrong,$c,$db,$initial):void {
            $body=ClawPilotNativeEmailAuthorityContract::canonical(['version'=>1]);
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'inspect',$wrong['token'],$body),'NATIVE_EMAIL_AUTHORITY_UNAUTHORIZED',403);
            $response=authorityHttp(AUTHORITY_HTTP_ROUTE.'inspect',$allowed['token'],$body);$snapshot=authorityHttpJson($response);
            ClawPilotNativeEmailAuthorityContract::keys($snapshot,['version','generation','nativePolicyFingerprint','runtimeFingerprint',
                'beforeBindingsFingerprint','bindings','memberships','capabilities','principalSuiteCrmUserIds']);
            must(($response['headers']['cache-control']??'')==='private, no-store'
                && $snapshot['nativePolicyFingerprint']===$c['beforePolicyFingerprint'],'Inspection must be noncacheable and independently match the actual policy');
            foreach($snapshot['capabilities'] as $entry)ClawPilotNativeEmailAuthorityContract::keys($entry,['emailId','globalId','pipelineId','capabilities']);
            $project=['version'=>1,'beforePolicyFingerprint'=>$snapshot['nativePolicyFingerprint'],
                'beforeBindingsFingerprint'=>$snapshot['beforeBindingsFingerprint'],'revokeMembershipChanges'=>[],'grantMembershipChanges'=>[]];
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'project',$wrong['token'],ClawPilotNativeEmailAuthorityContract::canonical($project)),
                'NATIVE_EMAIL_AUTHORITY_UNAUTHORIZED',403);
            $forecast=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'project',$allowed['token'],ClawPilotNativeEmailAuthorityContract::canonical($project)));
            must($forecast===['version'=>1,'beforePolicyFingerprint'=>$snapshot['nativePolicyFingerprint'],
                'revokePolicyFingerprint'=>$snapshot['nativePolicyFingerprint'],'grantPolicyFingerprint'=>$snapshot['nativePolicyFingerprint']],
                'No-op forecast must preserve all original policy pins');
            must(authorityHttpState($db)===$initial,'Inspection must not create an approval, receipt, group, membership or content change');
        });$phase='signature-and-token';
        check('authority HTTP requires exact client and independent signature not a caller supplied commit hash',function()use($allowed,$wrong,$wire,$c,$e,$db,$initial):void{
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$wrong['token'],$wire),'NATIVE_EMAIL_AUTHORITY_UNAUTHORIZED',403);
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$wrong['token'],$wire),'NATIVE_EMAIL_AUTHORITY_UNAUTHORIZED',403);
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$allowed['token'],$wire),'NATIVE_EMAIL_AUTHORITY_HELD');
            $bad=$e;$bad['proof']['planHash']=hash('sha256','forged plan');
            $instance=$e;$instance['proof']['nativeInstanceId']='different-instance';$instance=authorityHttpResign($instance);
            $expired=$e;$expired['proof']['issuedAt']=time()-301;$expired['proof']['expiresAt']=time()-1;$expired=authorityHttpResign($expired);
            foreach([$bad,$instance,$expired,['proof'=>$e['proof'],'signature'=>str_repeat('A',512)]] as $denied)
                authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],authorityHttpWire($c,$denied)),'NATIVE_EMAIL_AUTHORITY_HELD');
            foreach([['[]','application/vnd.api+json'],[$wire,'application/json'],[str_repeat('x',820001),'application/vnd.api+json']] as [$body,$type])
                authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],$body,$type),'NATIVE_EMAIL_AUTHORITY_HELD');
            must(authorityHttpState($db)===$initial,'Signature/client/payload denial must preserve all native rows');
        });$phase='approve-execute-replay';
        check('actual HTTP signed approval readback is immutable and exact native revoke resolves lost response',function()use($allowed,$c,$e,$wire,$db,$admin):void{
            $ack=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],$wire));
            must($ack['proofHash']===ClawPilotNativeEmailAuthorityContract::digest($e['proof'])&&$ack['appCommitFingerprint']===null&&!$ack['replayed'],'Verified native approval readback required');
            $again=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],$wire));$ack['replayed']=true;
            must($again===$ack,'Exact approval replay required');
            $token=authorityRows($db,'SELECT id,assigned_user_id FROM oauth2tokens WHERE access_token=?',[$allowed['tokenId']])[0];
            authorityWrite($db,'UPDATE oauth2tokens SET assigned_user_id=? WHERE id=?',['wrong-owner',$token['id']]);
            try{authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'execute',$allowed['token'],authorityHttpWire($c)),'NATIVE_EMAIL_AUTHORITY_UNAUTHORIZED',403);}
            finally{authorityWrite($db,'UPDATE oauth2tokens SET assigned_user_id=? WHERE id=?',[(string)$admin->id,$token['id']]);}
            $receipt=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'execute',$allowed['token'],authorityHttpWire($c)));
            must($receipt['state']==='committed'&&!$receipt['replayed'],'Actual HTTP revoke commit required');
            $replay=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'resolve',$allowed['token'],authorityHttpWire($c)));$receipt['replayed']=true;
            must(ClawPilotNativeEmailAuthorityContract::canonical($receipt)===ClawPilotNativeEmailAuthorityContract::canonical($replay),'Exact lost response evidence required');
        });$phase='grant';
        $revoked=ClawPilotNativeEmailAuthorityDelta::nativeRow(authorityRows($db,'SELECT * FROM securitygroups_users WHERE id=?',[$before['id']])[0]);
        $restored=$revoked;$restored['deleted']='0';$restored['date_modified']=gmdate('Y-m-d H:i:s');
        $grant=authorityCommand($db,$profile,'grant',[['before'=>$revoked,'after'=>$restored]],$c['transitionId']);
        $ge=authoritySigned($db,$grant,(string)$admin->id,$clients['allowed']);
        check('native grant expiry and append-only retry independently tie signed app commit to retained native receipts',function()use($allowed,$grant,$ge,$db):void{
            $before=authorityHttpState($db);$bad=$ge;$bad['proof']['appCommit']['revokeReceiptHash']=hash('sha256','not actual native revoke');$bad=authorityHttpResign($bad);
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$allowed['token'],authorityHttpWire($grant,$ge)),'NATIVE_EMAIL_AUTHORITY_HELD');
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],authorityHttpWire($grant,$bad)),'NATIVE_EMAIL_AUTHORITY_HELD');
            must(authorityHttpState($db)===$before,'Invalid signed commit chain may not approve');
            $C=ClawPilotNativeEmailAuthorityContract::class;$expired=$ge;
            $expired['proof']['issuedAt']=time()-301;$expired['proof']['expiresAt']=time()-1;$expired=authorityHttpResign($expired);
            $terminal=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$allowed['token'],authorityHttpWire($grant,$expired)));
            must($terminal['approval']['appCommitFingerprint']===$C::digest($ge['proof']['appCommit'])
                && $terminal['receipt']['state']==='cancelled','Expired original grant must retain exact app commit and cancellation');
            $cancel=$terminal['receipt'];$cancel['replayed']=false;
            $attempt=['ordinal'=>1,'originalOperationId'=>$grant['operationId'],'originalCommandHash'=>$C::digest($grant),
                'previousOperationId'=>$grant['operationId'],'previousCommandHash'=>$C::digest($grant),
                'previousCancellationReceiptHash'=>$C::digest($cancel)];
            $retry=$grant;$envelope=$ge;$envelope['proof']['version']=2;$envelope['proof']['grantAttempt']=$attempt;
            $retry['operationId']=$C::digest(['version'=>1,'purpose'=>'clawpilot-native-email-grant-attempt',
                'transitionId'=>$grant['transitionId'],'planHash'=>$ge['proof']['planHash'],
                'originalOperationId'=>$attempt['originalOperationId'],'originalCommandHash'=>$attempt['originalCommandHash'],
                'ordinal'=>1,'previousOperationId'=>$attempt['previousOperationId'],'previousCommandHash'=>$attempt['previousCommandHash'],
                'previousCancellationReceiptHash'=>$attempt['previousCancellationReceiptHash'],'appCommitFingerprint'=>$C::digest($ge['proof']['appCommit'])]);
            $envelope['proof']['operationId']=$retry['operationId'];$envelope['proof']['commandHash']=$C::digest($retry);$envelope=authorityHttpResign($envelope);
            $ack=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],authorityHttpWire($retry,$envelope)));
            must($ack['appCommitFingerprint']===$C::digest($ge['proof']['appCommit']),'Retry must retain exact original app commit');
            $receipt=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'execute',$allowed['token'],authorityHttpWire($retry)));
            must($receipt['state']==='committed','Actual HTTP retry grant required');
            $late=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'resolve',$allowed['token'],authorityHttpWire($grant)));
            must($late['state']==='cancelled' && $late['replayed'],'Original cancelled HTTP grant remains immutable after successor commit');
        });$phase='expired-retained-proof';
        check('expired retained proof is observable but cannot be renewed or executed and resolves to cancellation',function()use($db,$profile,$allowed,$admin,$clients):void{
            $c=authorityCommand($db,$profile,'revoke',[],hash('sha256','synthetic expiring HTTP authority'));
            $e=authoritySigned($db,$c,(string)$admin->id,$clients['allowed']);$e['proof']['issuedAt']=time()-297;$e['proof']['expiresAt']=time()+3;$e=authorityHttpResign($e);
            $wire=authorityHttpWire($c,$e);$ack=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],$wire));sleep(4);
            $again=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],$wire));$ack['replayed']=true;must($again===$ack,'Expired exact evidence must remain retained');
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'execute',$allowed['token'],authorityHttpWire($c)),'NATIVE_EMAIL_AUTHORITY_HELD');
            $renewed=$e;$renewed['proof']['issuedAt']=time();$renewed['proof']['expiresAt']=time()+120;$renewed=authorityHttpResign($renewed);
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],authorityHttpWire($c,$renewed)),'NATIVE_EMAIL_AUTHORITY_HELD');
            $terminal=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$allowed['token'],$wire));
            $cancel=$terminal['receipt'];must($terminal['approval']===$ack && $cancel['state']==='cancelled','Exact retained expired phase may be cancelled');
            $again=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'resolve',$allowed['token'],authorityHttpWire($c)));$cancel['replayed']=true;must($again===$cancel,'Cancellation immutable replay required');
        });
        $phase='expired-never-provisioned';
        check('expired never-provisioned revoke atomically retains original proof and tombstone with no authority change',function()use($db,$profile,$allowed,$admin,$clients):void{
            $c=authorityCommand($db,$profile,'revoke',[],hash('sha256','synthetic expired before first approval'));
            $e=authoritySigned($db,$c,(string)$admin->id,$clients['allowed']);$e['proof']['issuedAt']=time()-301;$e['proof']['expiresAt']=time()-1;$e=authorityHttpResign($e);
            $wire=authorityHttpWire($c,$e);$before=authorityHttpState($db);
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],$wire),'NATIVE_EMAIL_AUTHORITY_HELD');
            $bad=$e;$bad['proof']['planHash']=hash('sha256','not the signed original');
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$allowed['token'],authorityHttpWire($c,$bad)),'NATIVE_EMAIL_AUTHORITY_HELD');
            must(authorityHttpState($db)===$before,'Denied expiry recovery must not retain a forged approval');
            // An operation conflict after the new approval insert must roll
            // that insert back in the same transaction, not leave partial proof.
            authorityWrite($db,"INSERT INTO clawpilot_email_authority_operations(operation_id,transition_id,command_hash,phase,state,result_json) VALUES(?,?,?,'revoke','cancelled',NULL)",
                [$c['operationId'],$c['transitionId'],hash('sha256','conflicting native command')]);$conflict=authorityHttpState($db);
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$allowed['token'],$wire),'NATIVE_EMAIL_AUTHORITY_HELD');
            must(authorityHttpState($db)===$conflict,'Conflict must roll back newly retained expired proof');
            authorityWrite($db,'DELETE FROM clawpilot_email_authority_operations WHERE operation_id=?',[$c['operationId']]);
            $content=authorityContent($db);$bindings=authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id');
            $members=authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id');
            $terminal=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$allowed['token'],$wire));
            must($terminal['approval']['proofHash']===ClawPilotNativeEmailAuthorityContract::digest($e['proof'])
                && !$terminal['approval']['replayed'] && $terminal['receipt']['state']==='cancelled' && !$terminal['receipt']['replayed'],
                'Exact original proof and cancellation must commit together');
            must(authorityContent($db)===$content && authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id')===$bindings
                && authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id')===$members,'Expiry recovery may not mutate content bindings or memberships');
            $again=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$allowed['token'],$wire));
            $terminal['approval']['replayed']=true;$terminal['receipt']['replayed']=true;must($again===$terminal,'Expired cancellation must replay exact original evidence');
            authorityHttpDenied(authorityHttp(AUTHORITY_HTTP_ROUTE.'execute',$allowed['token'],authorityHttpWire($c)),'NATIVE_EMAIL_AUTHORITY_HELD');
        });
        $phase='expired-existing-commit';
        check('expired revoke recovery returns an existing actual commit and never mislabels it cancellation',function()use($db,$profile,$allowed,$admin,$clients):void{
            $c=authorityCommand($db,$profile,'revoke',[],hash('sha256','synthetic expired after native commit'));
            $e=authoritySigned($db,$c,(string)$admin->id,$clients['allowed']);$e['proof']['issuedAt']=time()-297;$e['proof']['expiresAt']=time()+3;$e=authorityHttpResign($e);
            $wire=authorityHttpWire($c,$e);authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'approve',$allowed['token'],$wire));
            $committed=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'execute',$allowed['token'],authorityHttpWire($c)));
            must($committed['state']==='committed','Actual native commit required before expiry');sleep(4);$before=authorityHttpState($db);
            $terminal=authorityHttpJson(authorityHttp(AUTHORITY_HTTP_ROUTE.'cancel-expired',$allowed['token'],$wire));$committed['replayed']=true;
            must($terminal['approval']['replayed'] && ClawPilotNativeEmailAuthorityContract::canonical($terminal['receipt'])===ClawPilotNativeEmailAuthorityContract::canonical($committed)
                && authorityHttpState($db)===$before,'Existing commit must remain exact and must not change native state');
        });
    }catch(Throwable $e){$code=$e instanceof ClawPilotNativeEmailTransactionRefused?$e->holdCode:get_class($e);
        fwrite(STDERR,'Native authority HTTP failed at '.$phase.': '.$code.'; status='.(int)($GLOBALS['authorityHttpStatus']??0)
            .'; path='.($GLOBALS['authorityHttpPath']??'none').'; responseKind='.($GLOBALS['authorityHttpResponseKind']??'none')."\n");$failed=true;}
    finally{try{if(is_file(AUTHORITY_HTTP_CONTROL)&&!is_link(AUTHORITY_HTTP_CONTROL))must(unlink(AUTHORITY_HTTP_CONTROL),'Only private fixture control cleanup');
        foreach($staged as $path=>$hash)must(is_file($path)&&!is_link($path)&&hash_file('sha256',$path)===$hash&&unlink($path),'Only exact fixture source cleanup');
    }catch(Throwable $e){fwrite(STDERR,"Native authority HTTP cleanup failed\n");$failed=true;}}
    if($failed)exit(1);fwrite(STDOUT,'NATIVE_AUTHORITY_HTTP_PASSED=checks='.$GLOBALS['checks'].'; actual OAuth signatures native approvals revoke grant resolve; synthetic app commit only no PG bridge or production proof.' ."\n");
})();
