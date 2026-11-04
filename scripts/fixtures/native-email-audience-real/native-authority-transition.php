<?php
declare(strict_types=1);
// Actual pinned native database/service proof, synthetic identities only. This
// does not install a route, authorize a live transition, or exercise a PG bridge.
if(getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION')!=='1')throw new RuntimeException('Disposable opt-in required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/source/email-audience/NativeEmailAuthorityTransition.php';
function authorityRows(mysqli $db,string $sql,array $params=[]):array {
    $s=$db->prepare($sql);try{if($params)$s->bind_param(str_repeat('s',count($params)),...$params);$s->execute();return $s->get_result()->fetch_all(MYSQLI_ASSOC);}finally{$s->close();}
}
function authorityWrite(mysqli $db,string $sql,array $params=[]):void {
    $s=$db->prepare($sql);try{if($params)$s->bind_param(str_repeat('s',count($params)),...$params);must($s->execute(),'Synthetic native write required');}finally{$s->close();}
}
function authorityMatrix(mysqli $db):array {
    $ids=authorityRows($db,'SELECT email_id,global_id,pipeline_id FROM clawpilot_email_identities ORDER BY email_id');
    $users=authorityRows($db,'SELECT id FROM users WHERE deleted=0 ORDER BY id');$result=[];$saved=$GLOBALS['current_user'];$session=$_SESSION;
    foreach($ids as $id)$result[$id['email_id']]=['emailId'=>$id['email_id'],'globalId'=>$id['global_id'],'pipelineId'=>$id['pipeline_id'],
        'capabilities'=>array_fill_keys(ClawPilotNativeEmailAuthorityContract::SURFACES,[])];
    try{foreach($users as $u){selectUser(fresh('Users',$u['id']));foreach($ids as $id){$email=fresh('Emails',$id['email_id']);
        foreach(ClawPilotNativeEmailAuthorityContract::SURFACES as $surface)if($email->ACLAccess($surface))$result[$id['email_id']]['capabilities'][$surface][]=$u['id'];
    }}}finally{$GLOBALS['current_user']=$saved;$_SESSION=$session;}return array_values($result);
}
function authorityApplyRows(mysqli $db,array $changes):void {
    foreach($changes as $change){$a=$change['after'];
        if($change['before']===null)authorityWrite($db,'INSERT INTO securitygroups_users(id,date_modified,deleted,securitygroup_id,user_id,primary_group,noninheritable) VALUES(?,?,?,?,?,?,?)',array_values($a));
        else authorityWrite($db,'UPDATE securitygroups_users SET date_modified=?,deleted=? WHERE id=?',[$a['date_modified'],$a['deleted'],$a['id']]);
    }
}
function authorityCommand(mysqli $db,array $profile,string $phase,array $changes,string $transition,?array $pending=null):array {
    $beforeBindings=array_map([ClawPilotNativeEmailAuthorityContract::class,'nativeBinding'],
        authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id'));$before=authorityMatrix($db);
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
    try{
        $beforePolicy=$tx->immutablePolicyFingerprint();$delta=new ClawPilotNativeEmailAuthorityDelta($phase,$changes);$tx->admitAuthorityMembershipDelta($delta);
        authorityApplyRows($db,$changes);$afterPolicy=$tx->authorityPostPolicyFingerprint();$after=authorityMatrix($db);$afterBindings=$beforeBindings;
        foreach($afterBindings as &$b){$b['generation']=(string)((int)$b['generation']+1);$b['policy_fingerprint']=$afterPolicy;
            $members=array_column(authorityRows($db,'SELECT user_id FROM securitygroups_users WHERE securitygroup_id=? AND deleted=0 ORDER BY user_id',[$b['group_id']]),'user_id');
            $b['readers_json']=ClawPilotNativeEmailAuthorityContract::canonical($members);
            $b['audience_fingerprint']=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>$b['owner_id'],
                'allowedSuiteCrmUserIds'=>$members,'workspaceId'=>$b['workspace_id'],'pipelineId'=>$b['pipeline_id']],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
        }unset($b);
    }finally{$tx->rollback();}
    $pairs=[];foreach($beforeBindings as $n=>$b)$pairs[]=['before'=>$b,'after'=>$afterBindings[$n]];
    $caps=[];foreach($before as $n=>$b)$caps[]=['emailId'=>$b['emailId'],'globalId'=>$b['globalId'],'pipelineId'=>$b['pipelineId'],'before'=>$b['capabilities'],'after'=>$after[$n]['capabilities']];
    $generation=(int)$beforeBindings[0]['generation'];
    $c=['version'=>1,'operationId'=>hash('sha256',$transition.'-'.$phase.'-'.$generation),'transitionId'=>$transition,'phase'=>$phase,
        'generationFrom'=>$generation,'generationTo'=>$generation+1,'desiredAppChangeHash'=>hash('sha256','synthetic exact app change'),
        'beforePolicyFingerprint'=>$beforePolicy,'afterPolicyFingerprint'=>$afterPolicy,
        'beforeBindingsFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($beforeBindings),
        'afterBindingsFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($afterBindings),
        'runtimeFingerprint'=>$beforeBindings[0]['runtime_fingerprint'],'bindings'=>$pairs,'membershipChanges'=>$changes,'capabilities'=>$caps,'pendingPublicationCommand'=>$pending];
    ClawPilotNativeEmailAuthorityContract::validate($c);return $c;
}
function authoritySigningSetup():void {
    $key=openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>3072]);
    must($key!==false,'Synthetic RSA3072 signing fixture required');$details=openssl_pkey_get_details($key);
    must(is_array($details) && $details['bits']===3072,'Exact synthetic issuer key profile required');
    $GLOBALS['authorityFixtureSigningKey']=$key;
    putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID=synthetic-authority-issuer');
    putenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID=synthetic-native-instance');
    putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='.$details['key']);
}
function authoritySigned(mysqli $db,array $c,string $user,string $client):array {
    $plan=hash('sha256','synthetic exact plan '.$c['transitionId']);$revokeId=null;$revokeHash=null;$app=null;
    if($c['phase']==='grant') {
        $rows=authorityRows($db,"SELECT * FROM clawpilot_email_authority_operations WHERE transition_id=? AND phase='revoke' AND state='committed'",[$c['transitionId']]);
        must(count($rows)===1,'Synthetic grant requires actual committed native revoke');$r=$rows[0];
        $revokeId=$r['operation_id'];$revokeHash=$r['command_hash'];
        $receipt=['version'=>$c['version'],'operationId'=>$revokeId,'transitionId'=>$c['transitionId'],'phase'=>'revoke','commandHash'=>$revokeHash,
            'state'=>'committed','replayed'=>false,'result'=>json_decode($r['result_json'],true,64,JSON_THROW_ON_ERROR)];
        $app=['version'=>1,'transitionId'=>$c['transitionId'],'planHash'=>$plan,'desiredAppChangeHash'=>$c['desiredAppChangeHash'],
            'revokeReceiptHash'=>ClawPilotNativeEmailAuthorityContract::digest($receipt),
            'appAuthorityBeforeFingerprint'=>hash('sha256','synthetic PG authority before'),
            'appAuthorityAfterFingerprint'=>hash('sha256','synthetic PG authority after')];
    }
    $proof=['version'=>1,'purpose'=>'clawpilot-native-email-authority-approval','issuer'=>'clawpilot-pg-authority',
        'audience'=>'clawpilot-suitecrm-authority','keyId'=>(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID'),
        'nativeInstanceId'=>(string)getenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID'),'issuedAt'=>time(),'expiresAt'=>time()+300,
        'operationId'=>$c['operationId'],'transitionId'=>$c['transitionId'],'planHash'=>$plan,'commandHash'=>ClawPilotNativeEmailAuthorityContract::digest($c),
        'desiredAppChangeHash'=>$c['desiredAppChangeHash'],'phase'=>$c['phase'],'serviceUserId'=>$user,'oauthClientId'=>$client,
        'revokeOperationId'=>$revokeId,'revokeCommandHash'=>$revokeHash,'appCommit'=>$app];
    must(openssl_sign(ClawPilotNativeEmailAuthorityContract::canonical($proof),$signature,$GLOBALS['authorityFixtureSigningKey'],OPENSSL_ALGO_SHA256),
        'Synthetic fixture proof must sign');return ['proof'=>$proof,'signature'=>base64_encode($signature)];
}
function authorityApprove(mysqli $db,array $c,string $user,string $client):array {
    $authorization=authoritySigned($db,$c,$user,$client);
    $service=new ClawPilotNativeEmailAuthorityTransition($db,['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'],
        $user,$client,$GLOBALS['authorityFixtureTokenId'],'');
    $service->approve($c,$authorization);return $authorization;
}
function authorityContent(mysqli $db):string {
    $state=[];foreach(['emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c','emails_beans'=>'id','emails_email_addr_rel'=>'id',
        'securitygroups_records'=>'id','acl_actions'=>'id','acl_roles'=>'id','acl_roles_actions'=>'id','acl_roles_users'=>'id','users'=>'id'] as $table=>$key)
        $state[$table]=authorityRows($db,'SELECT * FROM '.$table.' ORDER BY '.$key);
    return ClawPilotNativeEmailAuthorityContract::digest($state);
}
function authorityRefused(callable $call,string $code):void {
    try{$call();}catch(ClawPilotNativeEmailTransactionRefused $e){must($e->holdCode===$code,'Expected authority gate '.$code.', got '.$e->holdCode);return;}
    throw new RuntimeException('Authority operation unexpectedly accepted');
}
if(defined('CLAWPILOT_AUTHORITY_HELPERS_ONLY') && CLAWPILOT_AUTHORITY_HELPERS_ONLY===true)return;
(static function():void {
try {
    $_REQUEST=[];$db=DBManagerFactory::getInstance()->database;$profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'];
    must(realpath('.')==='/app/public/legacy' && ($GLOBALS['sugar_config']['dbconfig']['db_name']??'')==='suitecrm_native_test','Exact disposable native runtime required');
    $admin=fresh('Users',rows("SELECT id FROM users WHERE user_name='fixture-admin'")[0]['id']);selectUser($admin);
    must($db->multi_query((string)file_get_contents('/source/email-audience/authority-transition-schema.sql')),'Authority schema fixture install required');
    do{if($r=$db->store_result())$r->free();}while($db->more_results()&&$db->next_result());must($db->errno===0,'Authority schema must finish');
    $first=authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id')[0];
    $viewer=rows("SELECT id FROM users WHERE user_name='fixture-publisher-viewer'")[0]['id'];
    // A separate legitimate editor scope must stay readable/editable/deletable;
    // do not weaken its preexisting role to satisfy a reader-only test fixture.
    $editor=rows("SELECT id FROM users WHERE user_name='fixture-installed-blank-status-unroled'")[0]['id'];
    $group=native('SecurityGroups');$group->name='Synthetic retained editor authority';$group->noninheritable=1;$group->save(false);
    linkBeans($group,'users',[(string)$admin->id,$editor]);authorityWrite($db,'UPDATE securitygroups_users SET noninheritable=1 WHERE securitygroup_id=?',[(string)$group->id]);
    $email=emailFixture('Synthetic retained legitimate editor','gi8900001',(string)$admin->id);$group->addGroupToRecord('Emails',(string)$email->id,(string)$group->id);
    $pipeline=create_guid();$workspace=create_guid();$members=[(string)$admin->id,$editor];sort($members,SORT_STRING);
    authorityWrite($db,'INSERT INTO clawpilot_email_identities(email_id,global_id,local_id,pipeline_id,workspace_id,app_archived) VALUES(?,?,?,?,?,0)',
        [(string)$email->id,'gi8900001',create_guid(),$pipeline,$workspace]);
    $fingerprint=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>(string)$admin->id,'allowedSuiteCrmUserIds'=>$members,
        'workspaceId'=>$workspace,'pipelineId'=>$pipeline],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);try{$policy=$tx->immutablePolicyFingerprint();}finally{$tx->rollback();}
    authorityWrite($db,'UPDATE clawpilot_email_bindings SET policy_fingerprint=?',[$policy]);
    authorityWrite($db,'INSERT INTO clawpilot_email_bindings(pipeline_id,workspace_id,group_id,generation,owner_id,readers_json,audience_fingerprint,policy_fingerprint,runtime_fingerprint,enabled)
        VALUES(?,?,?,1,?,?,?,?,?,1)',[$pipeline,$workspace,(string)$group->id,(string)$admin->id,json_encode($members),$fingerprint,$policy,$first['runtime_fingerprint']]);
    $client=native('OAuth2Clients');$client->name='Synthetic separate authority service';$client->allowed_grant_type='client_credentials';$client->is_confidential=1;$client->assigned_user_id=$admin->id;
    $_REQUEST=['new_secret'=>'synthetic-only-'.bin2hex(random_bytes(24)),'duration_amount'=>1,'duration_unit'=>'hour'];try{$client->save(false);}finally{$_REQUEST=[];}
    // Same-process native service test, not an HTTP/middleware proof. A real
    // persisted native OAuth token exercises original token/client binding.
    $token=native('OAuth2Tokens');$token->access_token=bin2hex(random_bytes(40));$token->access_token_expires=gmdate('Y-m-d H:i:s',time()+3600);
    $token->token_is_revoked=0;$token->client=$client->id;$token->assigned_user_id=$admin->id;$token->save(false);
    putenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='.$client->id);
    authoritySigningSetup();$GLOBALS['authorityFixtureTokenId']=(string)$token->access_token;
    $service=new ClawPilotNativeEmailAuthorityTransition($db,$profile,(string)$admin->id,(string)$client->id,(string)$token->access_token,'');
    $member=authorityRows($db,'SELECT * FROM securitygroups_users WHERE securitygroup_id=? AND user_id=? AND deleted=0',[$first['group_id'],$viewer]);
    must(count($member)===1,'Exact viewer membership required');$member[0]=ClawPilotNativeEmailAuthorityDelta::nativeRow($member[0]);
    $after=$member[0];$after['deleted']='1';$after['date_modified']=gmdate('Y-m-d H:i:s');
    $handoff=json_decode((string)file_get_contents('/tmp/native-publisher-race.json'),true,48,JSON_THROW_ON_ERROR);$pending=$handoff['command'];
    $pending['operationId']=hash('sha256','synthetic authority cancelled pending publication');
    $command=authorityCommand($db,$profile,'revoke',[['before'=>$member[0],'after'=>$after]],hash('sha256','synthetic authority transition'),$pending);
    $content=authorityContent($db);
    check('authority cancellation rejects a shortened durable operation identity before any write',function()use($service,$command,$db):void {
        authorityWrite($db,'ALTER TABLE clawpilot_email_authority_operations MODIFY operation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL');
        try{authorityRefused(fn()=>$service->resolveOrCancel($command),'authority_storage_key_unproven');}
        finally{authorityWrite($db,'ALTER TABLE clawpilot_email_authority_operations MODIFY operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL');}
        must(authorityRows($db,'SELECT operation_id FROM clawpilot_email_authority_operations')===[],'Rejected schema must not create any terminal receipt');
    });
    check('authority phase requires an independently provisioned exact approval and original OAuth token assignment',function()use($service,$command,$db,$admin,$client,$token,$content):void {
        authorityRefused(fn()=>$service->execute($command),'authority_approval_missing');
        $forged=authoritySigned($db,$command,(string)$admin->id,(string)$client->id);$forged['proof']['planHash']=hash('sha256','caller cannot approve arbitrary plan');
        authorityRefused(fn()=>$service->approve($command,$forged),'authority_proof_signature');
        authorityApprove($db,$command,(string)$admin->id,(string)$client->id);
        authorityWrite($db,'UPDATE oauth2tokens SET assigned_user_id=? WHERE id=?',['wrong-native-owner',(string)$token->id]);
        try{authorityRefused(fn()=>$service->execute($command),'authority_token_revoked');}finally{authorityWrite($db,'UPDATE oauth2tokens SET assigned_user_id=? WHERE id=?',[(string)$admin->id,(string)$token->id]);}
        must(authorityContent($db)===$content,'Denied transition must preserve content and unrelated permissions');
    });
    check('registered native-deleted Email holds the complete transition without pruning or recreating history',function()use($service,$command,$db,$content):void {
        $id=$command['capabilities'][0]['emailId'];authorityWrite($db,'UPDATE emails SET deleted=1 WHERE id=?',[$id]);
        try{authorityRefused(fn()=>$service->execute($command),'authority_deleted_identity_requires_review');}
        finally{authorityWrite($db,'UPDATE emails SET deleted=0 WHERE id=?',[$id]);}
        must(authorityContent($db)===$content,'Held historical identity must not be rewritten');
    });
    check('authority delta rejects unrelated policy mutation and rolls the entire transaction back',function()use($db,$profile,$command,$admin):void {
        $before=authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id');$tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
        $delta=new ClawPilotNativeEmailAuthorityDelta('revoke',$command['membershipChanges']);$tx->admitAuthorityMembershipDelta($delta);authorityApplyRows($db,$command['membershipChanges']);
        authorityWrite($db,'UPDATE users SET status=? WHERE id=?',['Inactive',(string)$admin->id]);
        authorityRefused(fn()=>$tx->commit(),'policy_changed_inside_fence');must(authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id')===$before,'Rollback must restore membership');
    });
    $receipt=null;
    check('native revoke commits exact historical capability changes all global pins and pending publication tombstone together',function()use($db,$service,$command,$content,$editor,$email,&$receipt):void {
        $receipt=$service->execute($command);must($receipt['state']==='committed' && !$receipt['replayed'],'Actual native phase must commit');
        must($receipt['result']['pendingPublicationTerminalReceipt']['state']==='cancelled','Absent exact publication must receive terminal cancellation');
        must(authorityContent($db)===$content,'Transition may not rewrite Email content ownership or any role');
        selectUser(fresh('Users',$editor));$bean=fresh('Emails',(string)$email->id);must($bean->ACLAccess('view')&&$bean->ACLAccess('edit')&&$bean->ACLAccess('delete'),'Legitimate editor must retain all scoped rights');
        selectUser(fresh('Users',$command['bindings'][0]['before']['owner_id']));
    });
    check('lost response resolves exact immutable receipt after original approval expires or is revoked',function()use($db,$service,$command,$receipt):void {
        authorityWrite($db,"UPDATE clawpilot_email_authority_approvals SET revoked=1,expires_at='2000-01-01 00:00:00' WHERE operation_id=?",[$command['operationId']]);
        $replay=$service->resolveOrCancel($command);$expected=$receipt;$expected['replayed']=true;
        // Receipt storage uses recursively sorted object keys. PHP array ===
        // also compares insertion order, unlike the JSON object wire contract.
        // Compare every value/type/key/list position after that same canonical
        // normalization; only the explicitly expected replay flag may change.
        must(ClawPilotNativeEmailAuthorityContract::canonical($replay)===ClawPilotNativeEmailAuthorityContract::canonical($expected),
            'Resolver must retain exact historical evidence');
        authorityRefused(fn()=>$service->execute($command),'authority_approval_expired');
    });
    $revoked=ClawPilotNativeEmailAuthorityDelta::nativeRow(authorityRows($db,'SELECT * FROM securitygroups_users WHERE id=?',[$member[0]['id']])[0]);
    $restored=$revoked;$restored['deleted']='0';$restored['date_modified']=gmdate('Y-m-d H:i:s');
    $grant=authorityCommand($db,$profile,'grant',[['before'=>$revoked,'after'=>$restored]],$command['transitionId']);
    check('native grant requires separate post-app-commit approval and restores reader access without upgrading writes',function()use($db,$service,$grant,$admin,$client,$content):void {
        authorityRefused(fn()=>$service->execute($grant),'authority_approval_missing');authorityApprove($db,$grant,(string)$admin->id,(string)$client->id);
        $result=$service->execute($grant);must($result['state']==='committed' && $result['result']['generationTo']===3,'Exact grant must advance final generation');
        must(authorityContent($db)===$content,'Grant must preserve all content and roles');
    });
    check('authority resolve of an absent approved phase creates an immutable cancellation without applying memberships',function()use($db,$profile,$service,$admin,$client):void {
        $command=authorityCommand($db,$profile,'revoke',[],hash('sha256','synthetic cancel-only authority'));
        authorityApprove($db,$command,(string)$admin->id,(string)$client->id);$before=authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id');
        $cancel=$service->resolveOrCancel($command);must($cancel['state']==='cancelled' && $cancel['result']===null,'Actual cancellation required');
        $replay=$service->execute($command);must($replay['state']==='cancelled' && $replay['replayed'],'Late phase cannot revive cancellation');
        must(authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id')===$before,'Cancellation must not re-pin bindings');
    });
    fwrite(STDOUT,'NATIVE_AUTHORITY_TRANSITION_PASSED=checks='.$GLOBALS['checks'].'; actual native transaction/capability/receipt tests; no HTTP authority route PG bridge or production proof.' ."\n");
}catch(Throwable $e){fwrite(STDERR,'Native authority fixture failed: '.get_class($e).': '.$e->getMessage()."\n");exit(1);}
})();
