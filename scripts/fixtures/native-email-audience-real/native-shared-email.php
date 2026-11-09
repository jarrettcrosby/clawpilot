<?php
declare(strict_types=1);

// Actual installed stock SuiteCRM, not the managed-role fixture or a mock.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_SHARED_EMAIL_ONLY') !== '1') {
    throw new RuntimeException('Isolated stock SuiteCRM shared Email fixture required');
}
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/source/email-audience/SharedBpoEmailCreatePermit.php';
require '/source/email-audience/SharedBpoEmailWorker.php';

function sharedFixturePolicy(mysqli $db,array $profile): string
{
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
    try {return ClawPilotNativeEmailProjection::sharedLoginPolicyState($db,$tx);}
    finally {$tx->rollback();}
}

function sharedFixturePermit(mysqli $db,OpenSSLAsymmetricKey $key,array $scope,array $command): ClawPilotSharedBpoEmailCreatePermit
{
    $epoch=(int)$db->query('SELECT UNIX_TIMESTAMP()')->fetch_row()[0];
    $proof=['version'=>1,'purpose'=>'clawpilot-shared-bpo-email-create-v1','scope'=>$scope,'issuedAt'=>$epoch,'expiresAt'=>$epoch+60];
    must(openssl_sign(ClawPilotNativeEmailAuthorityContract::canonical($proof),$signature,$key,OPENSSL_ALGO_SHA256),'Synthetic signing failed');
    return ClawPilotSharedBpoEmailCreatePermit::verify(['proof'=>$proof,'signature'=>base64_encode($signature)],$scope,$command,
        openssl_pkey_get_details($key)['key'],$epoch);
}

function sharedFixtureAccountHistory($account): array
{
    // The stock Accounts History subpanel calls this function with link=contacts.
    $previous=$GLOBALS['app']??null;
    try {
        $GLOBALS['app']=(object)['controller'=>(object)['bean'=>$account]];
        $query=get_emails_by_assign_or_link(['link'=>'contacts']);
        must(isset($query['select'],$query['from'],$query['join'],$query['where']),'Stock Account history must generate its Email query');
        return array_column(rows($query['select'].$query['from'].$query['join'].$query['where']),'id');
    } finally {
        if ($previous===null) unset($GLOBALS['app']);
        else $GLOBALS['app']=$previous;
    }
}

function sharedFixtureExpectHold(callable $run,string $expected): void
{
    try {$run();}
    catch (ClawPilotNativeEmailProjectionRefused|ClawPilotNativeEmailTransactionRefused $held) {
        must($held->holdCode===$expected,'Unexpected exact observation hold: '.$held->holdCode);
        return;
    }
    throw new RuntimeException('Exact observer did not hold: '.$expected);
}

function sharedFixtureWorker(mysqli $db,array $profile,User $admin,bool $templates,array $projection): void
{
    selectUser($admin);
    $client=native('OAuth2Clients');$client->name='Disposable shared stock worker fixture';
    $client->allowed_grant_type='client_credentials';$client->is_confidential=1;$client->assigned_user_id=$admin->id;
    $_REQUEST=['new_secret'=>'synthetic-only-'.bin2hex(random_bytes(24)),'duration_amount'=>1,'duration_unit'=>'hour'];
    try {must(is_string($client->save(false))&&$client->id!=='','Synthetic shared OAuth client must save');}
    finally {$_REQUEST=[];}
    $token=native('OAuth2Tokens');$token->access_token=bin2hex(random_bytes(40));
    $token->access_token_expires=gmdate('Y-m-d H:i:s',time()+3600);$token->token_is_revoked=0;
    $token->client=$client->id;$token->assigned_user_id=$admin->id;
    must((bool)$token->save(false),'Synthetic shared OAuth token must save');
    putenv('SUITECRM_CLIENT_ID='.$client->id);
    putenv('CLAWPILOT_SHARED_BPO_EMAIL_ENABLED=1');
    putenv('CLAWPILOT_SHARED_BPO_EMAIL_TEMPLATES='.($templates?'1':'0'));
    $worker=new ClawPilotSharedBpoEmailWorker($db,$profile,(string)$admin->id,(string)$client->id,(string)$token->access_token,$templates);
    $projection['suiteCrmId']=create_guid();$projection['attributes']['global_id_c']='gi9800008';
    $projection['attributes']['name']='Synthetic ordinary BPO worker Email';
    $command=['version'=>1,'workspaceId'=>'c6c49765-9bf6-4223-9261-7553499f5d92',
        'pipelineId'=>'587c8746-ecf6-40ae-8c50-e456f99ad555','localId'=>create_guid(),
        'sourceRevision'=>hash('sha256','synthetic routine first revision'),'projection'=>$projection];
    $nativeId=$projection['suiteCrmId'];$idSql="'".quote($nativeId)."'";
    $policy=sharedFixturePolicy($db,$profile);
    $wrongWorkspace=$command;$wrongWorkspace['workspaceId']=create_guid();
    sharedFixtureExpectHold(static fn()=>$worker->publish($wrongWorkspace),'shared_worker_command_scope');
    putenv('CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED=1');
    try{sharedFixtureExpectHold(static fn()=>$worker->publish($command),'shared_worker_legacy_mode');}
    finally{putenv('CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED');}
    $wrongSubject=new ClawPilotSharedBpoEmailWorker($db,$profile,(string)$admin->id,(string)$client->id,(string)$token->access_token,$templates,create_guid());
    sharedFixtureExpectHold(static fn()=>$wrongSubject->publish($command),'shared_worker_unauthorized');
    $tokenSql="'".quote((string)$token->id)."'";
    $db->query("UPDATE oauth2tokens SET token_is_revoked=1 WHERE id=$tokenSql");
    try{sharedFixtureExpectHold(static fn()=>$worker->publish($command),'shared_worker_unauthorized');}
    finally{$db->query("UPDATE oauth2tokens SET token_is_revoked=0 WHERE id=$tokenSql");}
    must(rows("SELECT id FROM emails WHERE id=$idSql")===[],'Denied actor and scope must not create the Email');
    $caseAlias=$command;$caseAlias['projection']['suiteCrmId']=create_guid();$caseAlias['projection']['attributes']['global_id_c']='gi9800007';
    $caseAlias['projection']['contacts']=array_map('strtoupper',$projection['contacts']);
    $caseAlias['projection']['contactAccounts']=array_map(static fn(array $binding): array=>
        ['contactId'=>strtoupper($binding['contactId']),'accountId'=>$binding['accountId']],$projection['contactAccounts']);
    must($caseAlias['projection']['contacts']!==$projection['contacts'],'Synthetic casing alias is distinct');
    sharedFixtureExpectHold(static fn()=>$worker->publish($caseAlias),'related_record_unavailable');

    $first=$worker->publish($command);
    must($first['suiteCrmId']===$nativeId&&$first['globalId']==='gi9800008'&&$worker->publish($command)===$first,
        'Missing-response create retry must return the same fingerprint without another Email');
    $update=$command;$update['sourceRevision']=hash('sha256','synthetic routine second revision');
    $update['projection']['attributes']['description']='Synthetic exact compare-and-swap update';
    unset($update['projection']['attributes']['to_addrs_names']);
    $update['projection']['previousManaged']=['accounts'=>$projection['accounts'],'contacts'=>$projection['contacts']];
    $update['projection']['expectedBeforeFingerprint']=$first['snapshotFingerprint'];
    $update['projection']['contacts']=[$projection['contacts'][0]];
    $update['projection']['contactAccounts']=[$projection['contactAccounts'][0]];
    $second=$worker->publish($update);
    must($second['snapshotFingerprint']!==$first['snapshotFingerprint']&&$second['contacts']===$update['projection']['contacts']
        &&$worker->publish($update)===$second,'Missing-response update retry must recover the same exact projection');
    must(rows("SELECT to_addrs FROM emails_text WHERE email_id=$idSql")
        ===[['to_addrs'=>$projection['attributes']['to_addrs_names']]],'Omitted optional header does not clear prior evidence');
    sharedFixtureExpectHold(static fn()=>$worker->publish($command),'shared_existing_preimage_changed');
    $conflict=$update;$conflict['projection']['attributes']['description']='Synthetic delayed stale compare-and-swap';
    sharedFixtureExpectHold(static fn()=>$worker->publish($conflict),'shared_existing_preimage_changed');
    $globalAlias=$command;$globalAlias['projection']['suiteCrmId']=create_guid();
    try{$worker->publish($globalAlias);throw new RuntimeException('A second native ID must not claim the same Global ID');}
    catch(ClawPilotNativeEmailTransactionRefused $held){must(str_starts_with($held->holdCode,'shared_bpo_email_absence_'),'Duplicate alias hold expected');}
    must(rows("SELECT id FROM emails WHERE id=$idSql")===[['id'=>$nativeId]]
        &&rows("SELECT id_c FROM emails_cstm WHERE global_id_c='gi9800008'")===[['id_c'=>$nativeId]]
        &&sharedFixturePolicy($db,$profile)===$policy,'Worker retries preserve one identity and unchanged policy');
    fwrite(STDOUT,"PASS stock worker authenticates original token, confines workspace, performs exact CAS, and does not duplicate on retry\n");
}

function sharedFixtureHttpRequest(string $path,string $body,string $contentType,?string $token=null): array
{
    $handle=curl_init('http://127.0.0.1:8099'.$path);must($handle instanceof CurlHandle,'Synthetic HTTP client required');
    $headers=['Accept: application/vnd.api+json','Content-Type: '.$contentType];
    if($token!==null)$headers[]='Authorization: Bearer '.$token;
    $response='';$cache='';
    curl_setopt_array($handle,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$body,CURLOPT_HTTPHEADER=>$headers,
        CURLOPT_PROXY=>'',CURLOPT_CONNECTTIMEOUT=>2,CURLOPT_TIMEOUT=>12,CURLOPT_PROTOCOLS=>CURLPROTO_HTTP,CURLOPT_FOLLOWLOCATION=>false,
        CURLOPT_WRITEFUNCTION=>static function($curl,string $chunk)use(&$response):int {
            if(strlen($response)+strlen($chunk)>262144)return 0;$response.=$chunk;return strlen($chunk);
        },CURLOPT_HEADERFUNCTION=>static function($curl,string $line)use(&$cache):int {
            if(str_starts_with(strtolower($line),'cache-control:'))$cache=trim(substr($line,strlen('cache-control:')));
            return strlen($line);
        }]);
    try{
        must(curl_exec($handle)!==false,'Synthetic loopback OAuth/worker request failed');
        return [(int)curl_getinfo($handle,CURLINFO_RESPONSE_CODE),json_decode($response,true),$cache];
    }finally{curl_close($handle);}
}

function sharedFixtureHttpWorker(mysqli $db,User $admin,bool $templates,array $projection): void
{
    selectUser($admin);$clients=[];
    foreach(['authorized','wrong'] as $label){
        $client=native('OAuth2Clients');$client->name='Disposable stock route '.$label;
        $client->allowed_grant_type='client_credentials';$client->is_confidential=1;$client->assigned_user_id=$admin->id;
        $secret='synthetic-only-'.bin2hex(random_bytes(24));
        $_REQUEST=['new_secret'=>$secret,'duration_amount'=>1,'duration_unit'=>'hour'];
        try{must((bool)$client->save(false),'Synthetic stock HTTP client required');}finally{$_REQUEST=[];}
        $clients[$label]=[(string)$client->id,$secret];
    }
    $key=openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>2048]);
    must($key instanceof OpenSSLAsymmetricKey&&openssl_pkey_export($key,$private),'Disposable native HTTP keys required');
    foreach(['private.key'=>$private,'public.key'=>openssl_pkey_get_details($key)['key']] as $file=>$bytes){
        $path='/app/public/legacy/Api/V8/OAuth2/'.$file;
        must(file_put_contents($path,$bytes,LOCK_EX)===strlen($bytes)&&chmod($path,0600),'Stage isolated signing material');
    }
    unset($private,$key,$bytes);
    $override='/app/public/legacy/config_override.php';$base=is_file($override)?file_get_contents($override):"<?php\n";
    must(is_string($base)&&str_starts_with(ltrim($base),'<?php'),'Synthetic config source required');
    $config=preg_replace('/\?>\s*$/','',$base)."\n\$sugar_config['site_url'] = 'http://127.0.0.1:8099';\n"
        .'$sugar_config[\'trusted_hosts\'] = [\'^127\\\\.0\\\\.0\\\\.1$\'];'."\n"
        .'$sugar_config[\'oauth2_encryption_key\'] = '.var_export(bin2hex(random_bytes(32)),true).";\n";
    must(file_put_contents($override,$config,LOCK_EX)===strlen($config),'Stage isolated HTTP origin');
    $router='/app/public/legacy/custom/application/Ext/Api/V8/Config/routes.php';$directory=dirname($router);
    must((is_dir($directory)||mkdir($directory,0755,true))&&!file_exists($router),'Fresh synthetic custom route only');
    $route="<?php\nrequire '/opt/clawpilot/email-audience/shared-worker-routes.php';\n";
    must(file_put_contents($router,$route,LOCK_EX)===strlen($route),'Mount exact worker route under stock V8');
    putenv('SUITECRM_CLIENT_ID='.$clients['authorized'][0]);
    putenv('CLAWPILOT_SHARED_BPO_EMAIL_ENABLED=1');
    putenv('CLAWPILOT_SHARED_BPO_EMAIL_TEMPLATES='.($templates?'1':'0'));
    $process=proc_open([PHP_BINARY,'-d','display_errors=0','-S','127.0.0.1:8099','-t','/app/public/legacy','/fixture/native-shared-email-router.php'],
        [0=>['file','/dev/null','r'],1=>['file','/tmp/native-shared-email-http.log','a'],2=>['file','/tmp/native-shared-email-http.log','a']],$pipes);
    must(is_resource($process),'Start isolated stock HTTP listener');
    try{
        $ready=false;
        for($i=0;$i<40;$i++){
            $socket=@fsockopen('127.0.0.1',8099,$errno,$error,0.1);
            if(is_resource($socket)){fclose($socket);$ready=true;break;}usleep(50000);
        }
        must($ready,'Isolated stock HTTP listener ready');
        $tokens=[];
        foreach($clients as $label=>[$client,$secret]){
            [$status,$result]=sharedFixtureHttpRequest('/Api/access_token',http_build_query([
                'grant_type'=>'client_credentials','client_id'=>$client,'client_secret'=>$secret]),'application/x-www-form-urlencoded');
            must($status===200&&is_string($result['access_token']??null),'Stock OAuth client credentials token required, HTTP '.$status);
            $tokens[$label]=$result['access_token'];
        }
        $projection['suiteCrmId']=create_guid();$projection['attributes']['global_id_c']='gi9800006';
        $projection['attributes']['name']='Synthetic stock OAuth shared worker Email';
        $wire=json_encode(['version'=>1,'workspaceId'=>'c6c49765-9bf6-4223-9261-7553499f5d92',
            'pipelineId'=>'587c8746-ecf6-40ae-8c50-e456f99ad555','localId'=>create_guid(),
            'sourceRevision'=>hash('sha256','synthetic authenticated HTTP projection'),'projection'=>$projection],JSON_THROW_ON_ERROR);
        $path='/Api/V8/custom/clawpilot-email-shared';$media='application/vnd.api+json';
        [$anonymous]=sharedFixtureHttpRequest($path,$wire,$media);
        [$wrong,$refusal,$noStore]=sharedFixtureHttpRequest($path,$wire,$media,$tokens['wrong']);
        must($anonymous===401&&$wrong===403&&$refusal===['ok'=>false,'code'=>'SHARED_EMAIL_UNAUTHORIZED']
            &&$noStore==='private, no-store','Stock middleware denies anonymous and wrong-client publication');
        [$success,$first,$cache]=sharedFixtureHttpRequest($path,$wire,$media,$tokens['authorized']);
        [$replay,$second]=sharedFixtureHttpRequest($path,$wire,$media,$tokens['authorized']);
        must($success===200&&$replay===200&&$first===$second&&$first['suiteCrmId']===$projection['suiteCrmId']
            &&$first['globalId']==='gi9800006'&&$cache==='private, no-store','OAuth route writes and reuses the same Email: HTTP '.$success.'/'.$replay);
        must(rows("SELECT id_c FROM emails_cstm WHERE global_id_c='gi9800006'")===[['id_c'=>$projection['suiteCrmId']]],
            'Exactly one authenticated stock route Email');
    }finally{proc_terminate($process);proc_close($process);}
    fwrite(STDOUT,"PASS real stock OAuth rejects anonymous and wrong-client requests, allows one shared projection, and reuses the original on HTTP retry\n");
}

(static function () use ($sugar_config): void {
try {
    $profile=['database'=>'suitecrm_native_test','profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1'];
    must(realpath('.')==='/app/public/legacy' && ($sugar_config['dbconfig']['db_name']??null)===$profile['database']
        && ($sugar_config['dbconfig']['db_host_name']??null)==='db','Fresh synthetic database only');
    $_REQUEST=[];
    $db=DBManagerFactory::getInstance()->database;
    must($db instanceof mysqli,'Native mysqli required');
    $db->set_charset('utf8mb4');
    $admins=rows("SELECT id FROM users WHERE user_name='fixture-admin' AND status='Active' AND deleted=0");
    must(count($admins)===1,'Fixture administrator required');
    $admin=fresh('Users',(string)$admins[0]['id']);
    must($admin->isAdmin(),'Fixture writer must be stock administrator');
    selectUser($admin);
    ensureGlobalId();
    $reader=userFixture('shared-stock-reader');
    must(!$reader->isAdmin(),'Use a stock non-admin reader');
    selectUser($admin);
    $accounts=[];$contacts=[];$bindings=[];
    foreach (['one','two'] as $label) {
        $account=native('Accounts');$account->name='Synthetic shared company '.$label;$account->assigned_user_id=$admin->id;
        $account->save(false);
        $contact=native('Contacts');$contact->last_name='Synthetic shared contact '.$label;
        $contact->account_id=$account->id;$contact->assigned_user_id=$admin->id;$contact->save(false);
        $accounts[$label]=(string)$account->id;$contacts[$label]=(string)$contact->id;
        $bindings[]=['contactId'=>$contacts[$label],'accountId'=>$accounts[$label]];
    }
    // Only this fresh disposable install receives the prepared schema. No role,
    // group, user, ACL or stock source change is part of creating the Email.
    must($db->query(file_get_contents('/source/email-audience/shared-bpo-email-receipts.sql'))===true,'Fixture receipt schema required');
    $templates=rows("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='emails_email_templates'")!==[];
    $relatedBefore=[rows('SELECT * FROM accounts ORDER BY id'),rows('SELECT * FROM contacts ORDER BY id'),rows('SELECT * FROM accounts_contacts ORDER BY id')];
    $policy=sharedFixturePolicy($db,$profile);
    fwrite(STDOUT,"PASS stock login runtime and policy fingerprint admitted\n");
    $id=create_guid();$global='gi9800009';
    $command=ClawPilotNativeEmailProjection::validate(['suiteCrmId'=>$id,'attributes'=>[
        'global_id_c'=>$global,'name'=>'Synthetic one email shared in two histories','date_sent_received'=>'2026-11-09T13:00:00Z',
        'type'=>'archived','status'=>'read','parent_type'=>'Accounts','parent_id'=>$accounts['one'],'assigned_user_id'=>$admin->id,
        'description'=>"Synthetic first line.\nSynthetic second line.",'description_html'=>'',
        'from_addr_name'=>'Fixture Sender <sender@example.test>','to_addrs_names'=>'Recipient <recipient@example.test>',
    ],'accounts'=>array_values($accounts),'contacts'=>array_values($contacts),'contactAccounts'=>$bindings,
        'previousManaged'=>['accounts'=>[],'contacts'=>[]],'expectedBeforeFingerprint'=>null]);
    $scope=['action'=>'create-missing','keyId'=>'stock-shared-email-fixture','workspaceId'=>'c6c49765-9bf6-4223-9261-7553499f5d92',
        'pipelineId'=>'587c8746-ecf6-40ae-8c50-e456f99ad555','lane'=>'historical','localId'=>create_guid(),'nativeId'=>$id,'globalId'=>$global,
        'projectionFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($command),'policyStateFingerprint'=>$policy];
    foreach (['releaseFingerprint','appDeploymentFingerprint','nativeDeploymentFingerprint','appOriginFingerprint',
        'nativeOriginFingerprint','inventoryFingerprint','slotFingerprint','nonce'] as $field) $scope[$field]=hash('sha256','synthetic shared Email '.$field);
    $key=openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>3072]);
    must($key instanceof OpenSSLAsymmetricKey,'Synthetic fixture key required');
    $permit=sharedFixturePermit($db,$key,$scope,$command);
    $observe=static fn (array $expected): array=>ClawPilotNativeEmailProjection::observeSharedExact($db,$profile,$expected,$policy,$templates,$scope['nativeOriginFingerprint']);
    sharedFixtureExpectHold(static fn ()=>$observe($command),'shared_existing_identity');
    $receipt=ClawPilotNativeEmailProjection::createShared($db,$profile,$command,$permit,$scope,$templates);
    must($receipt['native_id']===$id && $receipt['global_id']===$global,'Exact durable receipt identity');
    $renewed=$scope;$renewed['nonce']=hash('sha256','synthetic shared Email renewed nonce');
    must(ClawPilotNativeEmailProjection::createShared($db,$profile,$command,sharedFixturePermit($db,$key,$renewed,$command),$renewed,$templates)===$receipt,
        'Newly signed retry returns the same committed receipt');
    $idSql="'".quote($id)."'";$globalSql="'".quote($global)."'";
    $epoch=static fn (): int=>(int)$db->query('SELECT UNIX_TIMESTAMP()')->fetch_row()[0];
    $observedNotBefore=$epoch();
    $observation=$observe($command);
    $observedEpoch=strtotime($observation['observedAt']);
    must($observation['nativeId']===$id && $observation['globalId']===$global
        && $observation['snapshotFingerprint']===$receipt['snapshot_fingerprint']
        && $observation['kind']==='created' && $observation['projectionFingerprint']===$scope['projectionFingerprint']
        && $observation['receiptFingerprint']===ClawPilotNativeEmailAuthorityContract::digest($receipt)
        && preg_match('/\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\z/',$observation['observedAt'])===1
        && $observedEpoch!==false && $observedEpoch>=$observedNotBefore && $observedEpoch<=$epoch(),
        'Exact observer must prove the committed snapshot at a fresh native database timestamp');
    sharedFixtureExpectHold(static fn ()=>ClawPilotNativeEmailProjection::observeSharedExact($db,$profile,$command,$policy,$templates,
        hash('sha256','synthetic wrong native origin')),'shared_bpo_email_receipt_alias');
    $wrongContent=$command;$wrongContent['attributes']['description'].="\nSynthetic different content.";
    sharedFixtureExpectHold(static fn ()=>$observe($wrongContent),'shared_existing_content_changed');
    $wrongLinks=$command;$wrongLinks['contacts']=[$contacts['one']];$wrongLinks['contactAccounts']=[$bindings[0]];
    sharedFixtureExpectHold(static fn ()=>$observe($wrongLinks),'shared_existing_links_changed');
    $aliasSql="'".quote(create_guid())."'";$aliasGlobalSql="'".quote(strtoupper($global))."'";
    $db->query("INSERT INTO emails_cstm (id_c,global_id_c) VALUES ($aliasSql,$aliasGlobalSql)");
    try {sharedFixtureExpectHold(static fn ()=>$observe($command),'shared_existing_identity');}
    finally {$db->query("DELETE FROM emails_cstm WHERE id_c=$aliasSql");}
    fwrite(STDOUT,"PASS read-only observer proves the original receipt and refuses absence, changed content, stale links, wrong origin and collated alias\n");
    must(rows("SELECT id FROM emails WHERE id=$idSql") === [['id'=>$id]]
        && rows("SELECT id_c FROM emails_cstm WHERE global_id_c=$globalSql") === [['id_c'=>$id]]
        && rows("SELECT email_id FROM emails_text WHERE email_id=$idSql") === [['email_id'=>$id]]
        && count(rows('SELECT native_id FROM clawpilot_shared_bpo_email_receipts'))===1,'Exactly one native Email and receipt including on retry');
    must([rows('SELECT * FROM accounts ORDER BY id'),rows('SELECT * FROM contacts ORDER BY id'),rows('SELECT * FROM accounts_contacts ORDER BY id')]===$relatedBefore,
        'Email publication must not rewrite or reparent accounts and contacts');
    must(sharedFixturePolicy($db,$profile)===$policy,'Stock role, group and access policy must remain unchanged');
    fwrite(STDOUT,"PASS one native Email and receipt after retry; role and relationship owner records unchanged\n");

    selectUser(fresh('Users',(string)$reader->id));
    $email=fresh('Emails',$id);
    must($email->ACLAccess('view') && (actualV8Record($id)['data']['id']??null)===$id
        && actualV8List($id)===[$id] && actualUiList($id)===[$id], 'Stock non-admin can read the single Email');
    must($email->parent_type==='Accounts' && $email->parent_id===$accounts['one'],'Primary account stays primary');
    foreach (['Accounts'=>$accounts,'Contacts'=>$contacts] as $module=>$ids) foreach ($ids as $relatedId) {
        $related=fresh($module,$relatedId);
        $history=$module==='Accounts'?sharedFixtureAccountHistory($related):linkedIds($related,'emails');
        must($related->ACLAccess('view') && $history===[$id], 'Stock related Email history must show the same ID: '.$module);
    }
    fwrite(STDOUT,"PASS stock non-admin view and both company and contact Email histories show the same ID\n");
    sharedFixtureWorker($db,$profile,$admin,$templates,$command);
    sharedFixtureHttpWorker($db,$admin,$templates,$command);
    fwrite(STDOUT,"NATIVE_SHARED_EMAIL_ACCEPTANCE_PASSED=1\n");
} catch (Throwable $failure) {
    // A failure is not a receipt. Diagnostics are confined to synthetic data.
    $detail=isset($failure->diagnostic)?' '.$failure->diagnostic:'';
    fwrite(STDERR,'STOCK_SHARED_EMAIL_FIXTURE_FAILED='.$failure::class.' '.$failure->getMessage().$detail."\n");
    throw $failure;
}
})();
