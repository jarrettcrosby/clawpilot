<?php
declare(strict_types=1);

// Real OAuth middleware + real publication routes, only inside the disposable
// native container. No production installation, token/cookie/body output, mail,
// authentication attributes, mocked receipt, or runtime-attestation bypass.
if (PHP_SAPI!=='cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION')!=='1'
    || trim((string)file_get_contents('/app/VERSION'))!=='8.10.1') throw new RuntimeException('Disposable native HTTP fixture required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/source/email-audience/NativeEmailPublisher.php';
const PUBLISHER_HTTP_ORIGIN='http://127.0.0.1:8099';
const PUBLISHER_HTTP_CONTROL='/tmp/native-publisher-http-control.json';
const PUBLISHER_HTTP_ROUTE='/Api/V8/custom/clawpilot-email-publication/';

function publisherHttpWrite(mysqli $db,string $sql,array $values): void
{
    $statement=$db->prepare($sql);
    try { $statement->bind_param(str_repeat('s',count($values)),...$values); must($statement->execute() && $statement->affected_rows<=1,'Bounded synthetic setup write required'); }
    finally {$statement->close();}
}
function publisherHttpControl(bool $enabled,string $client): void
{
    $bytes=json_encode(['enabled'=>$enabled,'clientId'=>$client],JSON_THROW_ON_ERROR);
    $temporary=PUBLISHER_HTTP_CONTROL.'.tmp';
    must(!is_link($temporary) && !is_link(PUBLISHER_HTTP_CONTROL),'Private configuration must not be a link');
    must(file_put_contents($temporary,$bytes,LOCK_EX)===strlen($bytes) && chmod($temporary,0600)
        && rename($temporary,PUBLISHER_HTTP_CONTROL),'Private publication configuration must stage atomically');
}
function publisherHttpRequest(string $path,?string $token=null,?string $body=null,string $contentType='application/vnd.api+json',string $method='POST'): array
{
    must(str_starts_with($path,'/') && !str_starts_with($path,'//'),'Only local native fixture paths admitted');
    $handle=curl_init(); must($handle instanceof CurlHandle,'Native curl required');
    $received=''; $headers=[];
    $requestHeaders=['Accept: application/vnd.api+json','Content-Type: '.$contentType];
    if($token!==null)$requestHeaders[]='Authorization: Bearer '.$token;
    curl_setopt_array($handle,[CURLOPT_URL=>PUBLISHER_HTTP_ORIGIN.$path,CURLOPT_PROXY=>'',CURLOPT_CONNECTTIMEOUT=>3,
        CURLOPT_TIMEOUT=>20,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_PROTOCOLS=>CURLPROTO_HTTP,CURLOPT_REDIR_PROTOCOLS=>CURLPROTO_HTTP,
        CURLOPT_HTTPHEADER=>$requestHeaders,CURLOPT_CUSTOMREQUEST=>$method,CURLOPT_POSTFIELDS=>$body,
        CURLOPT_WRITEFUNCTION=>static function($curl,string $chunk)use(&$received):int {
            if(strlen($received)+strlen($chunk)>1048576)return 0;$received.=$chunk;return strlen($chunk);
        },CURLOPT_HEADERFUNCTION=>static function($curl,string $line)use(&$headers):int {
            $parts=explode(':',$line,2);if(count($parts)===2)$headers[strtolower(trim($parts[0]))]=trim($parts[1]);return strlen($line);
        }]);
    try {
        must(curl_exec($handle)!==false,'Bounded local publication HTTP request failed');
        $status=(int)curl_getinfo($handle,CURLINFO_RESPONSE_CODE);
        $GLOBALS['publisherHttpLastStatus']=$status;
        must(!isset($headers['location']),'Publication HTTP requests may not redirect');
        return ['status'=>$status,'body'=>$received,'headers'=>$headers];
    } finally {curl_close($handle);}
}
function publisherHttpJson(array $response,int $status=200): array
{
    must($response['status']===$status,'Native publication HTTP status mismatch: '.$response['status']);
    $document=json_decode($response['body'],true,48,JSON_THROW_ON_ERROR);
    must(is_array($document) && !array_is_list($document),'Native HTTP object required');
    return $document;
}
function publisherHttpDenied(array $response,int $status,string $code,array $markers): void
{
    $document=publisherHttpJson($response,$status);
    must($document===['ok'=>false,'code'=>$code],'Exact generic publication refusal required');
    must(($response['headers']['cache-control']??'')==='private, no-store','Publication refusals must prohibit caching');
    foreach($markers as $marker)must(!str_contains($response['body'],$marker),'Refusal disclosed synthetic command/body evidence');
}
function publisherHttpToken(string $client,string $secret,string $username,string $password): string
{
    $response=publisherHttpRequest('/Api/access_token',null,http_build_query([
        'grant_type'=>'password','client_id'=>$client,'client_secret'=>$secret,'username'=>$username,'password'=>$password,
    ]),'application/x-www-form-urlencoded');
    $document=publisherHttpJson($response);
    must(is_string($document['access_token']??null) && $document['access_token']!=='','Actual native OAuth grant required');
    return $document['access_token'];
}
function publisherHttpServiceToken(string $client,string $secret): array
{
    $document=publisherHttpJson(publisherHttpRequest('/Api/access_token',null,http_build_query([
        'grant_type'=>'client_credentials','client_id'=>$client,'client_secret'=>$secret,
    ]),'application/x-www-form-urlencoded'));
    must(is_string($document['access_token']??null),'Actual client-credentials token required');
    $parts=explode('.',$document['access_token']);must(count($parts)===3,'Native JWT shape required');
    $encoded=strtr($parts[1],'-_','+/');$encoded.=str_repeat('=',(4-strlen($encoded)%4)%4);
    $bytes=base64_decode($encoded,true);must(is_string($bytes),'Synthetic JWT claims must decode');
    $claims=json_decode($bytes,true,16,JSON_THROW_ON_ERROR);
    // This observes the real signed token; it never bypasses middleware or
    // forges request attributes. Subsequent HTTP calls validate it natively.
    must(($claims['sub']??null)==='' && in_array($client,(array)($claims['aud']??[]),true)
        && is_string($claims['jti']??null) && preg_match('/^[a-f0-9]{80}$/D',$claims['jti'])===1,
        'Pinned native service token must exercise its actual empty-subject path');
    return ['token'=>$document['access_token'],'tokenId'=>$claims['jti']];
}
function publisherHttpState(): string
{
    $hash=hash_init('sha256');$db=DBManagerFactory::getInstance()->database;
    foreach(['clawpilot_email_bindings'=>'pipeline_id','clawpilot_email_identities'=>'email_id','clawpilot_email_operations'=>'operation_id',
        'emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c','emails_beans'=>'id','emails_email_addr_rel'=>'id',
        'email_addresses'=>'id','email_addr_bean_rel'=>'id','securitygroups_records'=>'id','accounts'=>'id','contacts'=>'id','accounts_contacts'=>'id'] as $table=>$key) {
        $result=$db->query('SELECT * FROM '.$table.' ORDER BY '.$key,MYSQLI_USE_RESULT);
        must($result instanceof mysqli_result,'Raw native HTTP proof read required');$count=0;$bytes=0;hash_update($hash,$table."\n");
        try {while($row=$result->fetch_assoc()) {$encoded=json_encode($row,JSON_THROW_ON_ERROR);$bytes+=strlen($encoded);
            must(++$count<=10000 && $bytes<=16777216,'Synthetic HTTP proof must stay bounded');hash_update($hash,strlen($encoded).':'.$encoded."\n");
        }} finally {$result->free();}
    }
    return hash_final($hash);
}

(static function () use ($sugar_config): void {
$staged=[];$passwordRows=[];$bindingBefore=null;$failed=false;$phase='setup';
try {
    $_REQUEST=[];umask(0077);
    must(realpath('.')==='/app/public/legacy' && ($sugar_config['dbconfig']['db_name']??'')==='suitecrm_native_test'
        && ($sugar_config['dbconfig']['db_host_name']??'')==='db' && ($sugar_config['site_url']??'')===PUBLISHER_HTTP_ORIGIN,
        'Only the previously configured synthetic HTTP runtime admitted');
    must(!file_exists(PUBLISHER_HTTP_CONTROL) && !is_link(PUBLISHER_HTTP_CONTROL),'HTTP publication stage must be fresh');
    $handoff='/tmp/native-publisher-race.json';
    must(is_file($handoff) && !is_link($handoff) && (fileperms($handoff)&0777)===0600 && filesize($handoff)<=650000,'Earlier private publisher handoff required');
    $input=json_decode((string)file_get_contents($handoff),true,48,JSON_THROW_ON_ERROR);
    must(is_array($input) && ($input['profile']??null)===['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test']
        && is_array($input['command']??null) && ($input['command']['globalId']??'')==='gi8800005','Exact synthetic publisher handoff required');
    $db=DBManagerFactory::getInstance()->database;must($db instanceof mysqli,'Native mysqli required');
    $bindingRows=rows("SELECT * FROM clawpilot_email_bindings WHERE pipeline_id='".quote($input['command']['pipelineId'])."'");
    must(count($bindingRows)===1 && $bindingRows[0]['owner_id']===$input['callerId'],'Synthetic publisher binding required');
    $bindingBefore=$bindingRows[0];$admin=fresh('Users',$input['callerId']);selectUser($admin);
    must($admin->isAdmin() && $admin->status==='Active','Synthetic native administrator required');

    // Stage the exact service bytes at the real include layout; dependencies
    // retain their own relative require paths. No auth/receipt proxy is used.
    $copies=[];
    foreach(['NativeEmailAuthorityDelta.php','NativeEmailInitialPolicyDelta.php','NativeEmailTransaction.php','NativeEmailRuntime.php','NativeEmailProjection.php','NativeEmailCapabilityContract.php','NativeEmailAuthorityContract.php','NativeEmailWriteScope.php','NativeEmailPublisher.php'] as $file)
        $copies['/source/email-audience/'.$file]='/app/public/legacy/custom/include/ClawPilot/'.$file;
    $copies['/source/native-email-scope/Patch.php']='/app/public/legacy/custom/include/native-email-scope/Patch.php';
    $copies['/source/email-audience/publication-routes.php']='/app/public/legacy/custom/application/Ext/Api/V8/Config/routes.php';
    foreach($copies as $source=>$target) {
        must(is_file($source) && !is_link($source) && !file_exists($target) && !is_link($target),'Only fresh exact fixture route targets admitted');
        for($parent=dirname($target);$parent!=='/app';$parent=dirname($parent))must(!is_link($parent),'No symlinked native route directory admitted');
        if(!is_dir(dirname($target)))must(mkdir(dirname($target),0755,true),'Synthetic route directory must stage');
        must(copy($source,$target) && chmod($target,0644) && hash_file('sha256',$source)===hash_file('sha256',$target),'Actual native route bytes must match source');
        $staged[$target]=hash_file('sha256',$target);
    }
    $users=[];$passwords=[];
    foreach(['admin'=>'fixture-admin','target'=>'fixture-publisher-viewer','denied'=>'fixture-installed-service-one'] as $label=>$username) {
        $found=rows("SELECT id,user_hash FROM users WHERE user_name='".quote($username)."' AND deleted=0");
        must(count($found)===1,'Exact synthetic OAuth principal required');$users[$label]=['id'=>$found[0]['id'],'username'=>$username];$passwordRows[]=$found[0];
        $passwords[$label]='Synthetic-http-only-'.bin2hex(random_bytes(20));
        publisherHttpWrite($db,'UPDATE users SET user_hash=? WHERE id=?',[User::getPasswordHash($passwords[$label]),$found[0]['id']]);
    }
    $clients=[];$secrets=[];
    foreach(['allowed','wrong','readers'] as $label) {
        $client=native('OAuth2Clients');$client->name='Disposable publication HTTP '.$label;
        $client->allowed_grant_type=$label==='readers'?'password':'client_credentials';$client->is_confidential=1;$client->assigned_user_id=$admin->id;
        $secrets[$label]='Synthetic-client-only-'.bin2hex(random_bytes(24));$_REQUEST=['new_secret'=>$secrets[$label],'duration_amount'=>1,'duration_unit'=>'hour'];
        try {must((bool)$client->save(false),'Actual synthetic OAuth client must save');} finally {$_REQUEST=[];}
        $clients[$label]=(string)$client->id;
    }
    publisherHttpControl(false,$clients['allowed']);
    $service=publisherHttpServiceToken($clients['allowed'],$secrets['allowed']);
    $tokens=['admin'=>$service['token']];$serviceTokenId=$service['tokenId'];unset($service);
    foreach(['target','denied'] as $label)$tokens[$label]=publisherHttpToken($clients['readers'],$secrets['readers'],$users[$label]['username'],$passwords[$label]);
    $wrong=publisherHttpServiceToken($clients['wrong'],$secrets['wrong'])['token'];
    unset($passwords,$secrets);
    // Credentials changed synthetic policy rows, so bind their exact current
    // state before the HTTP proof. Restore the original binding/hash afterward.
    $tx=ClawPilotNativeEmailTransaction::begin($db,$input['profile']);
    try {$policy=$tx->immutablePolicyFingerprint();} finally {$tx->rollback();}
    must(ClawPilotNativeEmailRuntime::attest($db)===$bindingBefore['runtime_fingerprint'],'HTTP fixture may not waive runtime drift');
    publisherHttpWrite($db,'UPDATE clawpilot_email_bindings SET policy_fingerprint=? WHERE pipeline_id=?',[$policy,$bindingBefore['pipeline_id']]);
    $command=$input['command'];$command['suiteCrmId']=create_guid();$command['globalId']='gi8800010';$command['localId']=create_guid();
    $command['operationId']=hash('sha256','native-publication-http-v1');$command['projection']['attributes']['global_id_c']=$command['globalId'];
    $marker='SYNTHETIC-HTTP-PUBLICATION-'.bin2hex(random_bytes(12));
    $command['projection']['attributes']['name']=$marker.' subject';
    $command['projection']['attributes']['description']=$marker." plain &amp; <literal>\nSecond line";
    $command['projection']['attributes']['from_addr_name']='HTTP Sender <sender-http@fixture.example.test>';
    $wire=json_encode($command,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
    $markers=[$marker,$command['suiteCrmId'],$command['globalId'],$command['operationId'],'sender-http@fixture.example.test'];
    $initial=publisherHttpState();
    // With no control file the router unsets both test environment settings:
    // this first probe covers the genuinely absent/default enable flag.
    must(unlink(PUBLISHER_HTTP_CONTROL),'Default-disabled probe must remove only its private test configuration');

    $phase='disabled-authentication';
    check('publication HTTP routes are disabled by default and real OAuth rejects missing or invalid bearer tokens before route execution',function()use($tokens,$wire,$markers,$initial):void {
        foreach(['prepare','publish','resolve'] as $operation) {
            publisherHttpDenied(publisherHttpRequest(PUBLISHER_HTTP_ROUTE.$operation,$tokens['admin'],$wire),409,'NATIVE_EMAIL_PUBLICATION_DISABLED',$markers);
            foreach([null,'synthetic-invalid-token'] as $token) {
                $response=publisherHttpRequest(PUBLISHER_HTTP_ROUTE.$operation,$token,$wire);$document=publisherHttpJson($response,401);
                must(isset($document['error']) && !isset($document['state']),'Actual native OAuth rejection required');
                foreach($markers as $marker)must(!str_contains($response['body'],$marker),'Native OAuth failure leaked request content');
            }
        }
        must(publisherHttpState()===$initial,'Disabled or unauthenticated routes must not mutate native rows');
    });
    publisherHttpControl(true,$clients['allowed']);
    $phase='client-authority';
    check('publication HTTP rejects a real token from the wrong client or nonassigned native principal without disclosing content',function()use($wrong,$tokens,$wire,$markers,$initial):void {
        foreach(['prepare','publish','resolve'] as $operation)foreach([$wrong,$tokens['target'],$tokens['denied']] as $token)
            publisherHttpDenied(publisherHttpRequest(PUBLISHER_HTTP_ROUTE.$operation,$token,$wire),403,'NATIVE_EMAIL_PUBLICATION_UNAUTHORIZED',$markers);
        must(publisherHttpState()===$initial,'Wrong client/principal may not mutate native content or receipts');
    });
    check('a password-token principal cannot borrow its configured client owner for service publication',function()use($clients,$tokens,$wire,$markers,$initial):void {
        publisherHttpControl(true,$clients['readers']);
        try {foreach(['prepare','publish','resolve'] as $operation)foreach(['target','denied'] as $reader)
            publisherHttpDenied(publisherHttpRequest(PUBLISHER_HTTP_ROUTE.$operation,$tokens[$reader],$wire),403,'NATIVE_EMAIL_PUBLICATION_UNAUTHORIZED',$markers);
        } finally {publisherHttpControl(true,$clients['allowed']);}
        must(publisherHttpState()===$initial,'Nonassigned subject may not gain the configured client owner authority');
    });
    $phase='persisted-token-authority';
    check('real HTTP service tokens cannot be revoked expired deleted reassigned or moved to another client and still publish',function()use($db,$serviceTokenId,$tokens,$clients,$users,$wire,$markers,$initial):void {
        $original=rows("SELECT id,assigned_user_id,client,deleted,token_is_revoked,access_token_expires FROM oauth2tokens WHERE access_token='".quote($serviceTokenId)."'");
        must(count($original)===1,'Exactly one actual service token record required');$saved=$original[0];
        foreach(['token_is_revoked'=>['1',401],'deleted'=>['1',401],'access_token_expires'=>['2000-01-01 00:00:00',401],
            'assigned_user_id'=>[$users['target']['id'],403],'client'=>[$clients['wrong'],403]] as $column=>[$changed,$status]) {
            publisherHttpWrite($db,'UPDATE oauth2tokens SET '.$column.'=? WHERE id=?',[$changed,$saved['id']]);
            try {foreach(['prepare','publish','resolve'] as $operation) {
                $response=publisherHttpRequest(PUBLISHER_HTTP_ROUTE.$operation,$tokens['admin'],$wire);
                if($status===403)publisherHttpDenied($response,403,'NATIVE_EMAIL_PUBLICATION_UNAUTHORIZED',$markers);
                else {
                    $denied=publisherHttpJson($response,401);must(isset($denied['error']) && !isset($denied['state']),'Real OAuth revocation refusal required');
                    foreach($markers as $marker)must(!str_contains($response['body'],$marker),'OAuth refusal leaked synthetic body evidence');
                }
                must(publisherHttpState()===$initial,'Rejected token may not publish content access or receipts');
            }} finally {publisherHttpWrite($db,'UPDATE oauth2tokens SET '.$column.'=? WHERE id=?',[(string)$saved[$column],$saved['id']]);}
        }
        must(rows("SELECT id,assigned_user_id,client,deleted,token_is_revoked,access_token_expires FROM oauth2tokens WHERE id='".quote($saved['id'])."'")===$original,
            'Actual synthetic service token authority must be restored exactly');
    });
    $phase='bounded-command';
    check('authorized publication HTTP refuses malformed oversized or wrong-content-type commands without body echo or cancellation claims',function()use($tokens,$wire,$markers,$initial,$marker):void {
        foreach([[$wire,'application/json'],['{"invalid":"'.$marker.'"','application/vnd.api+json'],
            ['[]','application/vnd.api+json'],[$marker.str_repeat('x',600001),'application/vnd.api+json']] as [$body,$type]) {
            publisherHttpDenied(publisherHttpRequest(PUBLISHER_HTTP_ROUTE.'publish',$tokens['admin'],$body,$type),409,'NATIVE_EMAIL_PUBLICATION_HELD',$markers);
        }
        must(publisherHttpState()===$initial,'Invalid HTTP command may not mutate native rows or record cancellation');
    });
    $phase='prepare';
    check('actual empty-subject client-credentials HTTP preparation returns an absent preimage without native writes',function()use($tokens,$wire,$command,$initial):void {
        $response=publisherHttpRequest(PUBLISHER_HTTP_ROUTE.'prepare',$tokens['admin'],$wire);$result=publisherHttpJson($response);
        must($result===['version'=>1,'suiteCrmId'=>$command['suiteCrmId'],'globalId'=>$command['globalId'],'pipelineId'=>$command['pipelineId'],
            'generation'=>$command['generation'],'audienceFingerprint'=>$command['audienceFingerprint'],'expectedRecordFingerprint'=>null],'Actual native HTTP preparation receipt required');
        must(($response['headers']['cache-control']??'')==='private, no-store' && publisherHttpState()===$initial,'Preparation must remain read-only and uncacheable');
    });
    $committed=null;$afterCommit=null;$phase='publish';
    check('actual authenticated HTTP publication commits one native Email exact readers and a matching durable native receipt',function()use($tokens,$wire,$command,$input,&$committed,&$afterCommit):void {
        $response=publisherHttpRequest(PUBLISHER_HTTP_ROUTE.'publish',$tokens['admin'],$wire);$committed=publisherHttpJson($response);
        must(($committed['state']??'')==='committed' && ($committed['replayed']??null)===false && ($committed['version']??null)===1
            && $committed['operationId']===$command['operationId'] && $committed['commandHash']===ClawPilotNativeEmailPublisher::digest($command),'Actual HTTP native terminal receipt required');
        $result=$committed['result'];$projection=$result['projection'];
        must($result['readerSuiteCrmUserIds']===$input['readers'] && $projection['version']===2
            && $projection['sourceAttributes']===$command['projection']['attributes'] && $projection['attributes']['description']===$command['projection']['attributes']['description'],
            'Actual raw projection and audience receipt required');
        $raw=rows("SELECT e.id,e.name,e.deleted,t.description,c.global_id_c FROM emails e JOIN emails_text t ON t.email_id=e.id JOIN emails_cstm c ON c.id_c=e.id WHERE e.id='".quote($command['suiteCrmId'])."'");
        must(count($raw)===1 && $raw[0]['description']===$command['projection']['attributes']['description'] && $raw[0]['global_id_c']===$command['globalId'] && (int)$raw[0]['deleted']===0,'Independent native raw HTTP write readback required');
        $operation=rows("SELECT state,command_hash,result_json FROM clawpilot_email_operations WHERE operation_id='".quote($command['operationId'])."'");
        must(count($operation)===1 && $operation[0]['state']==='committed' && $operation[0]['command_hash']===$committed['commandHash']
            && json_decode($operation[0]['result_json'],true,48,JSON_THROW_ON_ERROR)===$result,'HTTP receipt must equal committed MariaDB evidence');
        must(($response['headers']['cache-control']??'')==='private, no-store','Committed evidence must prohibit caching');$afterCommit=publisherHttpState();
    });
    $phase='replay-resolve';
    check('authenticated HTTP retry and resolve recover one committed result without duplicate content timestamp or grant writes',function()use($tokens,$wire,$committed,$afterCommit):void {
        foreach(['publish','resolve'] as $operation) {
            $result=publisherHttpJson(publisherHttpRequest(PUBLISHER_HTTP_ROUTE.$operation,$tokens['admin'],$wire));
            $expected=$committed;$expected['replayed']=true;must($result===$expected,'HTTP replay must return the exact committed native result');
            must(publisherHttpState()===$afterCommit,'HTTP retry/resolve must not rewrite content grants or receipts');
        }
    });
    $phase='committed-receipt-confidentiality';
    check('wrong-client and nonowner tokens cannot disclose or change an already committed native publication receipt',function()use($wrong,$tokens,$wire,$markers,$afterCommit):void {
        foreach(['prepare','publish','resolve'] as $operation)foreach([$wrong,$tokens['target']] as $token)
            publisherHttpDenied(publisherHttpRequest(PUBLISHER_HTTP_ROUTE.$operation,$token,$wire),403,'NATIVE_EMAIL_PUBLICATION_UNAUTHORIZED',$markers);
        must(publisherHttpState()===$afterCommit,'Denied historical receipt requests must preserve all committed native rows');
    });
    $phase='native-reader';
    check('fresh real native OAuth readers see the newly published body while an unrelated service is denied',function()use($tokens,$command,$marker,$afterCommit):void {
        $path='/Api/V8/module/Emails/'.rawurlencode($command['suiteCrmId']).'?fields[Emails]=name,description,global_id_c';
        $visible=publisherHttpJson(publisherHttpRequest($path,$tokens['target'],null,'application/vnd.api+json','GET'));
        must(($visible['data']['id']??'')===$command['suiteCrmId'] && ($visible['data']['attributes']['description']??null)===$command['projection']['attributes']['description'],'Actual newly granted native Email reader must receive exact plain body');
        $response=publisherHttpRequest($path,$tokens['denied'],null,'application/vnd.api+json','GET');$denied=publisherHttpJson($response,400);
        must(str_contains((string)($denied['errors']['detail']??''),'[AccessDeniedException]') && !str_contains($response['body'],$marker),'Unrelated service must get actual native Email denial');
        must(publisherHttpState()===$afterCommit,'Native HTTP reads may not rewrite the published projection');
    });
    $phase='cancel';
    check('authenticated HTTP resolve records terminal cancellation and rejects a delayed publication without creating its Email',function()use($tokens,$command):void {
        $cancel=$command;$cancel['operationId']=hash('sha256','native-publication-http-cancel-v1');$cancel['suiteCrmId']=create_guid();$cancel['localId']=create_guid();
        $cancel['globalId']='gi8800011';$cancel['projection']['attributes']['global_id_c']=$cancel['globalId'];$body=json_encode($cancel,JSON_THROW_ON_ERROR);
        $result=publisherHttpJson(publisherHttpRequest(PUBLISHER_HTTP_ROUTE.'resolve',$tokens['admin'],$body));
        must(($result['state']??'')==='cancelled' && $result['replayed']===false && $result['result']===null,'Actual HTTP cancellation receipt required');
        $before=publisherHttpState();$late=publisherHttpJson(publisherHttpRequest(PUBLISHER_HTTP_ROUTE.'publish',$tokens['admin'],$body));
        $result['replayed']=true;must($late===$result && publisherHttpState()===$before,'Delayed HTTP publication may not revive a cancelled identity');
        must(rows("SELECT id FROM emails WHERE id='".quote($cancel['suiteCrmId'])."'")===[],'Cancelled HTTP publication must never create an Email');
    });
} catch(Throwable $error) {
    // Fixed phase plus bounded class/hold code only: never bodies, OAuth
    // material, command data, SQL, stack traces or native metadata.
    $code=$error instanceof ClawPilotNativeEmailTransactionRefused || $error instanceof ClawPilotNativeEmailProjectionRefused?$error->holdCode:get_class($error);
    fwrite(STDERR,'Native publisher HTTP fixture failed at '.$phase.': '.$code.'; last HTTP status='.(int)($GLOBALS['publisherHttpLastStatus']??0)."\n");$failed=true;
} finally {
    try {
        if(is_file(PUBLISHER_HTTP_CONTROL) && !is_link(PUBLISHER_HTTP_CONTROL))must(unlink(PUBLISHER_HTTP_CONTROL),'Synthetic HTTP configuration cleanup required');
        foreach($staged as $path=>$hash)must(is_file($path) && !is_link($path) && hash_file('sha256',$path)===$hash && unlink($path),'Only exact staged fixture service files may be removed');
        if(isset($db) && $db instanceof mysqli) {
            foreach($passwordRows as $row)publisherHttpWrite($db,'UPDATE users SET user_hash=? WHERE id=?',[$row['user_hash'],$row['id']]);
            if(is_array($bindingBefore))publisherHttpWrite($db,'UPDATE clawpilot_email_bindings SET policy_fingerprint=? WHERE pipeline_id=?',[$bindingBefore['policy_fingerprint'],$bindingBefore['pipeline_id']]);
        }
    } catch(Throwable $cleanupError) {fwrite(STDERR,"Native publisher HTTP fixture cleanup failed\n");$failed=true;}
}
if($failed)exit(1);
fwrite(STDOUT,'NATIVE_PUBLISHER_HTTP_PASSED=checks='.$GLOBALS['checks'].'; actual OAuth middleware/routes/native receipts/readers; synthetic only; no production deployment, browser layout or mail delivery proof.' ."\n");
})();
