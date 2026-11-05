<?php
declare(strict_types=1);

// Run after native-publisher.php in the opted-in disposable native fixture.
// These are same-process native entry-point checks, not OAuth/HTTP proof.
if (getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1') throw new RuntimeException('Opt-in disposable fixture required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY', true);
require '/fixture/acceptance.php';
require '/source/email-audience/NativeEmailPublisher.php';

function publisherAuthWrite(mysqli $db, string $sql, array $values): void
{
    $stmt=$db->prepare($sql);
    try {
        $stmt->bind_param(str_repeat('s',count($values)),...$values);
        must($stmt->execute() && $stmt->affected_rows===1,'Exactly one synthetic authorization row must change');
    } finally { $stmt->close(); }
}
function publisherAuthContent(mysqli $db): string
{
    $hash=hash_init('sha256');
    foreach (['clawpilot_email_operations'=>'operation_id','clawpilot_email_identities'=>'email_id',
        'emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c','emails_beans'=>'id',
        'emails_email_addr_rel'=>'id','securitygroups_records'=>'id'] as $table=>$key) {
        $result=$db->query('SELECT * FROM '.$table.' ORDER BY '.$key,MYSQLI_USE_RESULT);
        must($result instanceof mysqli_result,'Native authorization snapshot must read');
        hash_update($hash,$table."\n"); $count=0; $bytes=0;
        try {
            while($row=$result->fetch_assoc()) {
                $encoded=json_encode($row,JSON_THROW_ON_ERROR); $bytes+=strlen($encoded);
                must(++$count<=10000 && $bytes<=16777216,'Synthetic authorization snapshot must remain bounded');
                hash_update($hash,strlen($encoded).':'.$encoded."\n");
            }
        } finally { $result->free(); }
    }
    return hash_final($hash);
}
function publisherAuthDenied(ClawPilotNativeEmailPublisher $publisher, array $command, string $code, mysqli $db): void
{
    $absent=$command; $absent['operationId']=hash('sha256','authorization-absent-'.$command['operationId']);
    foreach ([$command,$absent] as $attempt) foreach (['prepare','publish','resolveOrCancel'] as $method) {
        $before=publisherAuthContent($db); $held=false;
        try { $publisher->{$method}($attempt); }
        catch(ClawPilotNativeEmailTransactionRefused $error) { $held=$error->holdCode===$code; }
        must($held,'Stale authority must refuse at the exact authorization gate');
        must(hash_equals($before,publisherAuthContent($db)),'Denied authority may not touch content grants identities or receipts');
        $state=$db->query('SELECT @@in_transaction AS active')->fetch_assoc();
        must((int)$state['active']===0,'Denied authority must close its native transaction');
    }
}

(static function (): void {
try {
    $_REQUEST=[];
    $admin=fresh('Users',rows("SELECT id FROM users WHERE user_name='fixture-admin'")[0]['id']);
    selectUser($admin);
    $db=DBManagerFactory::getInstance()->database;
    must($db instanceof mysqli,'Native mysqli connection required');
    $profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'];
    $path='/tmp/native-publisher-race.json';
    must(is_file($path) && !is_link($path) && (fileperms($path)&0777)===0600 && filesize($path)<=650000,'Private bounded publisher handoff required');
    $handoff=json_decode((string)file_get_contents($path),true,48,JSON_THROW_ON_ERROR);
    must(is_array($handoff) && ($handoff['profile']??null)===$profile && ($handoff['callerId']??null)===$admin->id
        && is_array($handoff['command']??null) && ($handoff['command']['globalId']??null)==='gi8800005','Exact preceding synthetic publisher handoff required');
    $source=$handoff['command'];
    must(is_string($source['pipelineId']??null) && is_string($source['workspaceId']??null),'Publisher handoff identities required');
    $scope="pipeline_id='".quote($source['pipelineId'])."' AND workspace_id='".quote($source['workspaceId'])."'";
    $bindings=rows('SELECT * FROM clawpilot_email_bindings WHERE '.$scope);
    $identities=rows("SELECT * FROM clawpilot_email_identities WHERE global_id='gi8800001' AND ".$scope);
    must(count($bindings)===1 && count($identities)===1,'Earlier synthetic publisher fixtures required');
    $binding=$bindings[0]; $identity=$identities[0];
    must((int)$binding['generation']===($source['generation']??null) && $binding['audience_fingerprint']===($source['audienceFingerprint']??null),
        'Exact unique binding must match the protected publisher command');
    $other=rows("SELECT id FROM users WHERE user_name='fixture-installed-blank-status-unroled'")[0]['id'];
    $originalUser=rows("SELECT status,is_admin,deleted FROM users WHERE id='".quote((string)$admin->id)."'")[0];
    must($admin->isAdmin() && $admin->status==='Active' && $binding['owner_id']===$admin->id,'Synthetic authorized service principal required');
    $client=native('OAuth2Clients');
    $client->name='Disposable native publisher authorization fixture';
    $client->allowed_grant_type='client_credentials'; $client->is_confidential=1;
    $client->assigned_user_id=$admin->id;
    $_REQUEST=['new_secret'=>'synthetic-only-'.bin2hex(random_bytes(24)),'duration_amount'=>1,'duration_unit'=>'hour'];
    try { must(is_string($client->save(false)) && $client->id!=='','Synthetic OAuth client must save'); }
    finally { $_REQUEST=[]; }
    $clientId=(string)$client->id;
    $token=native('OAuth2Tokens');$token->access_token=bin2hex(random_bytes(40));
    $token->access_token_expires=gmdate('Y-m-d H:i:s',time()+3600);$token->token_is_revoked=0;
    $token->client=$clientId;$token->assigned_user_id=$admin->id;
    must((bool)$token->save(false),'Synthetic persisted OAuth token must save');
    $tokenId=(string)$token->access_token;$tokenRowId=(string)$token->id;
    $originalToken=rows("SELECT assigned_user_id,client,deleted,token_is_revoked,access_token_expires FROM oauth2tokens WHERE id='".quote($tokenRowId)."'")[0];
    $publisher=new ClawPilotNativeEmailPublisher($db,$profile,(string)$admin->id,$clientId,$tokenId);
    $command=['version'=>1,'operationId'=>hash('sha256','native-publisher-authorization-control-v1'),
        'mode'=>'repair','workspaceId'=>$binding['workspace_id'],'pipelineId'=>$binding['pipeline_id'],
        'generation'=>(int)$binding['generation'],'audienceFingerprint'=>$binding['audience_fingerprint'],
        'suiteCrmId'=>$identity['email_id'],'globalId'=>$identity['global_id'],'localId'=>$identity['local_id'],
        'expectedRecordFingerprint'=>str_repeat('0',64),'projection'=>null];
    $controlRecorded=false;
    try {
        check('native publisher authorizes exact live client for a terminal cancellation control',function () use ($publisher,$command,&$controlRecorded): void {
            $receipt=$publisher->resolveOrCancel($command);
            must($receipt['state']==='cancelled' && $receipt['replayed']===false,'Authorized cancellation must produce a new terminal receipt');
            $controlRecorded=true;
            must($publisher->resolveOrCancel($command)['replayed']===true,'Authorized historical resolution must replay');
        });
        check('native publisher refuses stale admin beans after status admin or deleted revocation on every entry point',function () use ($publisher,$command,$db,$admin,$originalUser): void {
            foreach (['status'=>'Inactive','is_admin'=>'0','deleted'=>'1'] as $column=>$revoked) {
                publisherAuthWrite($db,'UPDATE users SET '.$column.'=? WHERE id=?',[$revoked,(string)$admin->id]);
                try {
                    // Deliberately keep the pre-revocation object. Route-side
                    // hydration and even isAdmin() still report old authority.
                    must($admin->isAdmin() && $admin->status==='Active','Fixture must retain a genuinely stale native User');
                    publisherAuthDenied($publisher,$command,'unauthorized_native_writer',$db);
                } finally { publisherAuthWrite($db,'UPDATE users SET '.$column.'=? WHERE id=?',[(string)$originalUser[$column],(string)$admin->id]); }
            }
        });
        check('native publisher refuses deleted reassigned and missing OAuth clients including historical receipt resolution',function () use ($publisher,$command,$db,$admin,$clientId,$other,$profile,$tokenId): void {
            foreach ([['deleted','1','0'],['assigned_user_id',$other,(string)$admin->id]] as [$column,$revoked,$original]) {
                publisherAuthWrite($db,'UPDATE oauth2clients SET '.$column.'=? WHERE id=?',[$revoked,$clientId]);
                try { publisherAuthDenied($publisher,$command,'native_client_revoked',$db); }
                finally { publisherAuthWrite($db,'UPDATE oauth2clients SET '.$column.'=? WHERE id=?',[$original,$clientId]); }
            }
            $missing=new ClawPilotNativeEmailPublisher($db,$profile,(string)$admin->id,create_guid(),$tokenId);
            publisherAuthDenied($missing,$command,'native_client_revoked',$db);
        });
        check('native publisher rechecks revoked deleted expired reassigned and wrong-client persisted tokens inside every transaction',function () use ($publisher,$command,$db,$originalToken,$tokenRowId,$other,$profile,$admin,$clientId): void {
            foreach(['token_is_revoked'=>'1','deleted'=>'1','access_token_expires'=>'2000-01-01 00:00:00',
                'assigned_user_id'=>$other,'client'=>create_guid()] as $column=>$revoked) {
                publisherAuthWrite($db,'UPDATE oauth2tokens SET '.$column.'=? WHERE id=?',[$revoked,$tokenRowId]);
                try {publisherAuthDenied($publisher,$command,'native_token_revoked',$db);}
                finally {publisherAuthWrite($db,'UPDATE oauth2tokens SET '.$column.'=? WHERE id=?',[(string)$originalToken[$column],$tokenRowId]);}
            }
            foreach(['invalid-token-id',str_repeat('0',80)] as $missingId)
                publisherAuthDenied(new ClawPilotNativeEmailPublisher($db,$profile,(string)$admin->id,$clientId,$missingId),$command,'native_token_revoked',$db);
            must(rows("SELECT assigned_user_id,client,deleted,token_is_revoked,access_token_expires FROM oauth2tokens WHERE id='".quote($tokenRowId)."'")===[ $originalToken ],
                'Token probes must restore the exact original synthetic authorization row');
        });
        check('native publisher cannot resolve another binding owner and restores exact synthetic authority rows',function () use ($publisher,$command,$db,$binding,$admin,$other,$originalUser,$clientId): void {
            publisherAuthWrite($db,'UPDATE clawpilot_email_bindings SET owner_id=? WHERE pipeline_id=?',[$other,$binding['pipeline_id']]);
            try { publisherAuthDenied($publisher,$command,'binding_missing',$db); }
            finally { publisherAuthWrite($db,'UPDATE clawpilot_email_bindings SET owner_id=? WHERE pipeline_id=?',[$binding['owner_id'],$binding['pipeline_id']]); }
            $restored=rows("SELECT status,is_admin,deleted FROM users WHERE id='".quote((string)$admin->id)."'");
            must($restored===[$originalUser],'Stale-user probes must restore the exact native authority fields');
            $clientRows=rows("SELECT assigned_user_id,deleted FROM oauth2clients WHERE id='".quote($clientId)."'");
            must(count($clientRows)===1 && $clientRows[0]['assigned_user_id']===$admin->id && (int)$clientRows[0]['deleted']===0,'Client probes must restore exact assignment and active row');
            must($publisher->resolveOrCancel($command)['state']==='cancelled','Restored authority must resolve its original receipt');
        });
    } finally {
        // These exact rows were created by this file; no existing receipts,
        // users, bindings or client records are deleted by cleanup.
        if($controlRecorded) publisherAuthWrite($db,'DELETE FROM clawpilot_email_operations WHERE operation_id=?',[$command['operationId']]);
        publisherAuthWrite($db,'DELETE FROM oauth2tokens WHERE id=?',[$tokenRowId]);
        publisherAuthWrite($db,'DELETE FROM oauth2clients WHERE id=?',[$clientId]);
    }
    fwrite(STDOUT,'NATIVE_PUBLISHER_AUTHORIZATION_PASSED=checks='.$GLOBALS['checks'].'; stale principal and revoked client native-entry checks; synthetic only; no HTTP or concurrent-process proof.' ."\n");
} catch(Throwable $error) {
    // Never expose OAuth material, command bodies, SQL, or exception chains.
    fwrite(STDERR,"Native publisher authorization fixture failed\n"); exit(1);
}
})();
