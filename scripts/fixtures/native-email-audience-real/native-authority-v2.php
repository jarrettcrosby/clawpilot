<?php
declare(strict_types=1);
// Actual native MariaDB/ACL phase proof, never a production permission change.
define('CLAWPILOT_AUTHORITY_HELPERS_ONLY',true);
require '/fixture/native-authority-transition.php';
require '/source/email-audience/NativeEmailPublisher.php';
require '/source/email-audience/NativeEmailIdentityLink.php';

function authorityV2Command(mysqli $db,array $profile,string $phase,array $changes,string $transition,array $approvedFutureAfter=[]):array {
    $beforeBindings=array_map(static fn($b)=>ClawPilotNativeEmailAuthorityContract::nativeBinding($b,2),
        authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id'));
    $before=authorityMatrix($db);$tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
    try {
        $beforePolicy=$tx->immutablePolicyFingerprint();$delta=new ClawPilotNativeEmailAuthorityDelta($phase,$changes);$tx->admitAuthorityMembershipDelta($delta);
        authorityApplyRows($db,$changes);$afterPolicy=$tx->authorityPostPolicyFingerprint();$after=authorityMatrix($db);$afterBindings=$beforeBindings;
        foreach($afterBindings as &$b) {
            $b['generation']=(string)((int)$b['generation']+1);$b['policy_fingerprint']=$afterPolicy;
            $members=array_column(authorityRows($db,'SELECT user_id FROM securitygroups_users WHERE securitygroup_id=? AND deleted=0 ORDER BY user_id',[$b['group_id']]),'user_id');
            $b['readers_json']=ClawPilotNativeEmailAuthorityContract::canonical($members);
            $b['audience_fingerprint']=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>$b['owner_id'],
                'allowedSuiteCrmUserIds'=>$members,'workspaceId'=>$b['workspace_id'],'pipelineId'=>$b['pipeline_id']],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
            if($b['capability_policy_json']!==null) {
                $policy=json_decode($b['capability_policy_json'],true,32,JSON_THROW_ON_ERROR);$policy['audienceFingerprint']=$b['audience_fingerprint'];
                if($phase==='revoke')foreach(ClawPilotNativeEmailAuthorityContract::SURFACES as $surface)
                    $policy['futureCreate'][$surface]=array_values(array_intersect($policy['futureCreate'][$surface],$members));
                elseif(isset($approvedFutureAfter[$b['pipeline_id']]))$policy['futureCreate']=$approvedFutureAfter[$b['pipeline_id']];
                // Future rights are separately explicit; never copy a historical
                // Email's rights into the future-create policy.
                $b['capability_policy_json']=ClawPilotNativeEmailAuthorityContract::canonical($policy);unset($policy['historical']);
                $b['capability_policy_fingerprint']=ClawPilotNativeEmailAuthorityContract::digest($policy);
            }
        }unset($b);
    }finally{$tx->rollback();}
    $pairs=[];foreach($beforeBindings as $n=>$b)$pairs[]=['before'=>$b,'after'=>$afterBindings[$n]];
    $caps=[];foreach($before as $n=>$b)$caps[]=['emailId'=>$b['emailId'],'globalId'=>$b['globalId'],'pipelineId'=>$b['pipelineId'],
        'before'=>$b['capabilities'],'after'=>$after[$n]['capabilities']];
    $generation=(int)$beforeBindings[0]['generation'];
    $c=['version'=>2,'operationId'=>hash('sha256',$transition.'-'.$phase.'-'.$generation),'transitionId'=>$transition,'phase'=>$phase,
        'generationFrom'=>$generation,'generationTo'=>$generation+1,'desiredAppChangeHash'=>hash('sha256','synthetic exact v2 membership change'),
        'beforePolicyFingerprint'=>$beforePolicy,'afterPolicyFingerprint'=>$afterPolicy,
        'beforeBindingsFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($beforeBindings),
        'afterBindingsFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($afterBindings),
        'runtimeFingerprint'=>$beforeBindings[0]['runtime_fingerprint'],'bindings'=>$pairs,'membershipChanges'=>$changes,'capabilities'=>$caps,'pendingPublicationCommand'=>null];
    ClawPilotNativeEmailAuthorityContract::validate($c);return $c;
}
function authorityV2State(mysqli $db):string {
    $state=['content'=>authorityContent($db)];
    foreach(['securitygroups_users'=>'id','clawpilot_email_bindings'=>'pipeline_id','clawpilot_email_identities'=>'email_id',
        'clawpilot_email_write_scopes'=>'pipeline_id','clawpilot_email_write_permissions'=>'email_id',
        'clawpilot_email_authority_approvals'=>'operation_id','clawpilot_email_authority_operations'=>'operation_id'] as $table=>$key)$state[$table]=authorityRows($db,'SELECT * FROM '.$table.' ORDER BY '.$key);
    return ClawPilotNativeEmailAuthorityContract::digest($state);
}
function authorityV2Rehash(array $c):array {
    $c['beforeBindingsFingerprint']=ClawPilotNativeEmailAuthorityContract::digest(array_column($c['bindings'],'before'));
    $c['afterBindingsFingerprint']=ClawPilotNativeEmailAuthorityContract::digest(array_column($c['bindings'],'after'));return $c;
}
function authorityV2Expired(array $envelope):array {
    $envelope['proof']['issuedAt']=time()-301;$envelope['proof']['expiresAt']=time()-1;
    must(openssl_sign(ClawPilotNativeEmailAuthorityContract::canonical($envelope['proof']),$signature,$GLOBALS['authorityFixtureSigningKey'],OPENSSL_ALGO_SHA256),'Synthetic expired original proof required');
    $envelope['signature']=base64_encode($signature);return $envelope;
}
function authorityV2Resign(array $envelope):array {
    must(openssl_sign(ClawPilotNativeEmailAuthorityContract::canonical($envelope['proof']),$signature,$GLOBALS['authorityFixtureSigningKey'],OPENSSL_ALGO_SHA256),
        'Synthetic retry proof must sign');$envelope['signature']=base64_encode($signature);return $envelope;
}
function authorityV2Retry(array $original,array $originalEnvelope,array $previous,array $receipt,int $ordinal):array {
    $C=ClawPilotNativeEmailAuthorityContract::class;$receipt['replayed']=false;
    $attempt=['ordinal'=>$ordinal,'originalOperationId'=>$original['operationId'],'originalCommandHash'=>$C::digest($original),
        'previousOperationId'=>$previous['operationId'],'previousCommandHash'=>$C::digest($previous),
        'previousCancellationReceiptHash'=>$C::digest($receipt)];
    $proof=$originalEnvelope['proof'];$proof['version']=2;$proof['issuedAt']=time();$proof['expiresAt']=time()+300;$proof['grantAttempt']=$attempt;
    $command=$original;
    $command['operationId']=$C::digest(['version'=>1,'purpose'=>'clawpilot-native-email-grant-attempt',
        'transitionId'=>$proof['transitionId'],'planHash'=>$proof['planHash'],
        'originalOperationId'=>$attempt['originalOperationId'],'originalCommandHash'=>$attempt['originalCommandHash'],
        'ordinal'=>$ordinal,'previousOperationId'=>$attempt['previousOperationId'],'previousCommandHash'=>$attempt['previousCommandHash'],
        'previousCancellationReceiptHash'=>$attempt['previousCancellationReceiptHash'],'appCommitFingerprint'=>$C::digest($proof['appCommit'])]);
    $proof['operationId']=$command['operationId'];$proof['commandHash']=$C::digest($command);
    return ['command'=>$command,'authorization'=>authorityV2Resign(['proof'=>$proof,'signature'=>''])];
}

(static function():void {
try {
    $_REQUEST=[];$db=DBManagerFactory::getInstance()->database;$profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'];
    must(realpath('.')==='/app/public/legacy' && ($GLOBALS['sugar_config']['dbconfig']['db_name']??'')==='suitecrm_native_test','Exact native fixture required');
    $admin=fresh('Users',rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0")[0]['id']);selectUser($admin);
    $viewer=rows("SELECT id FROM users WHERE user_name='fixture-publisher-viewer' AND deleted=0")[0]['id'];
    $editor=rows("SELECT id FROM users WHERE user_name='fixture-installed-blank-status-unroled' AND deleted=0")[0]['id'];
    $foreignReader=rows("SELECT id FROM users WHERE user_name='fixture-a-only' AND status='Active' AND deleted=0")[0]['id'];
    $foreignOwner=$viewer;
    $foreignOwnerRows=authorityRows($db,'SELECT status,deleted FROM users WHERE id=?',[$foreignOwner]);
    must(count($foreignOwnerRows)===1 && $foreignOwnerRows[0]['status']==='Active' && in_array($foreignOwnerRows[0]['deleted'],[0,'0'],true),
        'Mixed-owner baseline requires a genuinely active native owner; the blank-status editor remains a covered principal');
    $v2=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE capability_policy_json IS NOT NULL');
    must(count($v2)===1,'Prior actual v2 publication fixture required');$binding=$v2[0];$pipeline=$binding['pipeline_id'];
    $originalPolicy=json_decode($binding['capability_policy_json'],true,32,JSON_THROW_ON_ERROR);
    // Establish an independent, legitimate other-owner baseline only in this
    // disposable fixture. Authority execution must not perform these ownership
    // changes: its command and enrolled identity keep ownership immutable.
    $foreignIdentity=authorityRows($db,"SELECT * FROM clawpilot_email_identities WHERE global_id='gi8900001'");
    must(count($foreignIdentity)===1,'Independent retained-editor Email fixture required');$foreignIdentity=$foreignIdentity[0];
    $foreignBinding=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=?',[$foreignIdentity['pipeline_id']])[0];
    must($foreignBinding['pipeline_id']!==$pipeline && $foreignBinding['capability_policy_json']===null
        && $foreignBinding['owner_id']===(string)$admin->id && $foreignOwner!==(string)$admin->id,'Separate legacy ownership baseline required');
    $foreignGroup=fresh('SecurityGroups',$foreignBinding['group_id']);linkBeans($foreignGroup,'users',[$viewer,$foreignReader]);
    authorityWrite($db,'UPDATE securitygroups_users SET noninheritable=1 WHERE securitygroup_id=?',[$foreignBinding['group_id']]);
    $foreignReaders=array_column(authorityRows($db,'SELECT user_id FROM securitygroups_users WHERE securitygroup_id=? AND deleted=0 ORDER BY user_id',[$foreignBinding['group_id']]),'user_id');
    $foreignAudience=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>$foreignOwner,'allowedSuiteCrmUserIds'=>$foreignReaders,
        'workspaceId'=>$foreignBinding['workspace_id'],'pipelineId'=>$foreignBinding['pipeline_id']],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
    authorityWrite($db,'UPDATE emails SET assigned_user_id=?,created_by=? WHERE id=?',[$foreignOwner,$foreignOwner,$foreignIdentity['email_id']]);
    authorityWrite($db,'UPDATE clawpilot_email_bindings SET owner_id=?,readers_json=?,audience_fingerprint=? WHERE pipeline_id=?',
        [$foreignOwner,ClawPilotNativeEmailAuthorityContract::canonical($foreignReaders),$foreignAudience,$foreignBinding['pipeline_id']]);
    $client=native('OAuth2Clients');$client->name='Synthetic v2 authority service';$client->allowed_grant_type='client_credentials';$client->is_confidential=1;$client->assigned_user_id=$admin->id;
    $_REQUEST=['new_secret'=>'synthetic-only-'.bin2hex(random_bytes(24)),'duration_amount'=>1,'duration_unit'=>'hour'];try{$client->save(false);}finally{$_REQUEST=[];}
    $token=native('OAuth2Tokens');$token->access_token=bin2hex(random_bytes(40));$token->access_token_expires=gmdate('Y-m-d H:i:s',time()+3600);
    $token->token_is_revoked=0;$token->client=$client->id;$token->assigned_user_id=$admin->id;$token->save(false);
    putenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='.$client->id);authoritySigningSetup();$GLOBALS['authorityFixtureTokenId']=(string)$token->access_token;
    $service=new ClawPilotNativeEmailAuthorityTransition($db,$profile,(string)$admin->id,(string)$client->id,(string)$token->access_token,'');
    // The earlier independent fixture added a new scope at generation1 after
    // exercising older scopes. Align this disposable baseline explicitly; no
    // executor waiver permits mixed generations in a real transition.
    // Prepare an already-existing canonical account in this disposable test
    // BEFORE the baseline policy epoch. Linking later must not rename/create
    // a native account or change these retained Users/Users_cstm bytes.
    $user=native('Users');$dynamic=new DynamicField('Users');$dynamic->setup($user);
    if(!$dynamic->getFieldWidget('Users','global_id_c')){
        $field=get_widget('varchar');$field->name='global_id';$field->label='LBL_GLOBAL_ID';$field->vname='LBL_GLOBAL_ID';
        $field->label_value='Fixture employee Global ID';$field->len='32';$field->required=false;$field->audited=false;
        $field->reportable=true;$field->save($dynamic);
    }
    VardefManager::clearVardef('Users','User');unset($GLOBALS['dictionary']['User']);VardefManager::refreshVardefs('Users','User');
    if(getenv('CLAWPILOT_NATIVE_FIXTURE_APP_PG')==='1'){
        $existing=authorityRows($db,"SELECT id FROM users WHERE user_name='fixture-neither' AND status='Active' AND deleted=0");
        must(count($existing)===1,'Existing unbound native account required before first-link baseline');
        authorityWrite($db,'UPDATE users SET user_name=? WHERE id=?',['gu7654321',$existing[0]['id']]);
        authorityWrite($db,'INSERT INTO users_cstm(id_c,global_id_c) VALUES(?,?) ON DUPLICATE KEY UPDATE global_id_c=VALUES(global_id_c)',[$existing[0]['id'],'gu7654321']);
    }
    $generation=(int)authorityRows($db,'SELECT MAX(generation) AS maximum FROM clawpilot_email_bindings')[0]['maximum']+1;
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);try{$policy=$tx->immutablePolicyFingerprint();}finally{$tx->rollback();}
    authorityWrite($db,'UPDATE clawpilot_email_bindings SET generation=?,policy_fingerprint=?',[(string)$generation,$policy]);
    $member=authorityRows($db,'SELECT * FROM securitygroups_users WHERE securitygroup_id=? AND user_id=? AND deleted=0',[$binding['group_id'],$viewer]);
    must(count($member)===1,'Exact v2 viewer membership required');$before=ClawPilotNativeEmailAuthorityDelta::nativeRow($member[0]);
    $deleted=$before;$deleted['deleted']='1';$deleted['date_modified']=gmdate('Y-m-d H:i:s');
    $transition=hash('sha256','native v2 full membership lifecycle');
    $revoke=authorityV2Command($db,$profile,'revoke',[['before'=>$before,'after'=>$deleted]],$transition);
    $content=authorityContent($db);$identitiesBefore=authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id');
    $wire=[];$timings=[];
    check('existing native identity proof locks the complete custom index rejects duplicate claims and detects in-pass drift',function()use($db,$profile,$viewer):void {
        // Use native DynamicField installation, not a permissive replacement
        // table. This temporary fixture's stock schema did not require Users
        // custom fields before account linking was added.
        $beforeUsers=authorityRows($db,'SELECT * FROM users ORDER BY id');
        $beforeCustom=authorityRows($db,'SELECT * FROM users_cstm ORDER BY id_c');
        $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);$other=null;
        try{
            $gu='gu9876543';$links=[['userId'=>$viewer,'globalId'=>$gu,'username'=>$gu]];
            // Deliberate metadata setup/corruption inside an owned rollback-only
            // transaction. This does not claim that a native rename or account
            // link was authorized by the authority executor.
            authorityWrite($db,'UPDATE users SET user_name=? WHERE id=?',[$gu,$viewer]);
            authorityWrite($db,'INSERT INTO users_cstm(id_c,global_id_c) VALUES(?,?) ON DUPLICATE KEY UPDATE global_id_c=VALUES(global_id_c)',[$viewer,$gu]);
            $snapshot=ClawPilotNativeEmailIdentityLink::inspect($db,$tx,$links);
            ClawPilotNativeEmailIdentityLink::assertUnchanged($db,$tx,$snapshot);
            $config=$GLOBALS['sugar_config']['dbconfig'];
            $other=new mysqli($config['db_host_name'],$config['db_user_name'],$config['db_password'],$config['db_name'],(int)($config['db_port']??3306));
            $other->query('SET SESSION innodb_lock_wait_timeout=1');
            try{
                authorityWrite($other,'INSERT INTO users_cstm(id_c,global_id_c) VALUES(?,?)',[create_guid(),$gu]);
                throw new RuntimeException('A racing duplicate identity must not enter the locked index');
            }catch(mysqli_sql_exception $error){must($error->getCode()===1205,'Full index/gap locks must block the independent duplicate writer');}
            authorityWrite($db,'UPDATE users_cstm SET global_id_c=? WHERE id_c=?',['gu9876544',$viewer]);
            authorityRefused(fn()=>ClawPilotNativeEmailIdentityLink::assertUnchanged($db,$tx,$snapshot),'identity_link_identity_changed');
            authorityWrite($db,'UPDATE users_cstm SET global_id_c=? WHERE id_c=?',[$gu,$viewer]);
            $foreign=authorityRows($db,'SELECT id FROM users WHERE id<>? ORDER BY id LIMIT 1',[$viewer])[0]['id'];
            authorityWrite($db,'INSERT INTO users_cstm(id_c,global_id_c) VALUES(?,?) ON DUPLICATE KEY UPDATE global_id_c=VALUES(global_id_c)',[$foreign,strtoupper($gu)]);
            authorityRefused(fn()=>ClawPilotNativeEmailIdentityLink::inspect($db,$tx,$links),'identity_link_identity_changed');
        }finally{if($other!==null)$other->close();$tx->rollback();}
        must(authorityRows($db,'SELECT * FROM users ORDER BY id')===$beforeUsers
            &&authorityRows($db,'SELECT * FROM users_cstm ORDER BY id_c')===$beforeCustom,'Identity metadata proof must retain every native user/custom row');
    });
    fwrite(STDOUT,"NATIVE_IDENTITY_LINK_METADATA_PASSED=1\n");
    $plannedRestore=$deleted;$plannedRestore['deleted']='0';
    $inspection=null;$projection=null;
    check('authenticated native inspection and two-phase forecast are exact bounded rollback-only observations',function()use($db,$service,$revoke,$before,$deleted,$plannedRestore,&$inspection,&$projection):void {
        $state=authorityV2State($db);
        $inspection=$service->inspect(['version'=>1]);
        ClawPilotNativeEmailAuthorityContract::keys($inspection,['version','generation','nativePolicyFingerprint','runtimeFingerprint',
            'beforeBindingsFingerprint','bindings','memberships','capabilities','principalSuiteCrmUserIds']);
        must($inspection['version']===1 && $inspection['generation']===$revoke['generationFrom']
            && $inspection['nativePolicyFingerprint']===$revoke['beforePolicyFingerprint']
            && $inspection['beforeBindingsFingerprint']===$revoke['beforeBindingsFingerprint']
            && $inspection['runtimeFingerprint']===$revoke['runtimeFingerprint']
            && ClawPilotNativeEmailAuthorityContract::canonical($inspection['bindings'])===ClawPilotNativeEmailAuthorityContract::canonical(array_column($revoke['bindings'],'before')),
            'Native inspection must reproduce exact original binding bytes and policy pins');
        must(ClawPilotNativeEmailAuthorityContract::canonical($inspection['capabilities'])===ClawPilotNativeEmailAuthorityContract::canonical(authorityMatrix($db)),
            'Native inspection must match the complete independent fresh-per-principal reference matrix');
        foreach($inspection['capabilities'] as $capability)ClawPilotNativeEmailAuthorityContract::keys($capability,['emailId','globalId','pipelineId','capabilities']);
        $input=['version'=>1,'beforePolicyFingerprint'=>$inspection['nativePolicyFingerprint'],'beforeBindingsFingerprint'=>$inspection['beforeBindingsFingerprint'],
            'revokeMembershipChanges'=>[['before'=>$before,'after'=>$deleted]],'grantMembershipChanges'=>[['before'=>$deleted,'after'=>$plannedRestore]]];
        $projection=$service->project($input);
        ClawPilotNativeEmailAuthorityContract::keys($projection,['version','beforePolicyFingerprint','revokePolicyFingerprint','grantPolicyFingerprint']);
        must($projection['version']===1 && $projection['beforePolicyFingerprint']===$revoke['beforePolicyFingerprint']
            && $projection['revokePolicyFingerprint']===$revoke['afterPolicyFingerprint'],'In-memory revoke forecast must equal independent native mutation/rollback evidence');
        $stale=$input;$stale['beforeBindingsFingerprint']=hash('sha256','stale-native-bindings');
        authorityRefused(fn()=>$service->project($stale),'authority_inspection_preimage_changed');
        $outside=$input;$outside['revokeMembershipChanges'][0]['before']['securitygroup_id']='unknown-managed-group';
        $outside['revokeMembershipChanges'][0]['after']['securitygroup_id']='unknown-managed-group';
        authorityRefused(fn()=>$service->project($outside),'authority_membership_outside_binding');
        $wrong=$input;$wrong['grantMembershipChanges'][0]['before']['date_modified']='2000-01-01 00:00:00';
        authorityRefused(fn()=>$service->project($wrong),'authority_membership_preimage_changed');
        authorityRefused(fn()=>$service->inspect(['version'=>1,'unexpected'=>true]),'authority_keys');
        must(authorityV2State($db)===$state,'Inspection and accepted or refused forecasts may not mutate any native row');
    });
    check('unchanged foreign-owned pipeline remains in full native scope without borrowing its owner identity',function()use($db,$revoke,$inspection,$foreignIdentity,$foreignOwner,$admin):void {
        must(count(array_unique(array_column($inspection['bindings'],'owner_id')))===2,'Actual mixed-owner inspection required');
        $pairs=array_values(array_filter($revoke['bindings'],static fn($pair)=>$pair['before']['pipeline_id']===$foreignIdentity['pipeline_id']));
        must(count($pairs)===1 && $pairs[0]['before']['owner_id']===$foreignOwner,'Other owner must remain the actual native owner');
        $before=$pairs[0]['before'];$after=$pairs[0]['after'];
        foreach(['generation','policy_fingerprint'] as $key){unset($before[$key]);unset($after[$key]);}
        must($before===$after,'Unchanged foreign binding may advance only the global generation and native policy pins');
        foreach($revoke['capabilities'] as $entry)if($entry['pipelineId']===$foreignIdentity['pipeline_id'])
            must($entry['before']===$entry['after'] && in_array((string)$admin->id,$entry['before']['view'],true),
                'Every foreign principal/action, including native administrator visibility, must remain independently represented');
        $email=authorityRows($db,'SELECT assigned_user_id,created_by FROM emails WHERE id=?',[$foreignIdentity['email_id']])[0];
        must($email['assigned_user_id']===$foreignOwner && $email['created_by']===$foreignOwner,'Fixture must not impersonate service caller ownership');
    });
    check('locked owner validation rejects inactive deleted and missing owners without dropping unrelated scopes',function()use($db,$profile,$service,$revoke,$foreignIdentity,$foreignOwner):void {
        $method=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'groups');$state=authorityV2State($db);
        foreach(['inactive','deleted','missing'] as $probe) {
            $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
            try {
                $command=$revoke;
                if($probe==='inactive')authorityWrite($db,"UPDATE users SET status='Inactive' WHERE id=?",[$foreignOwner]);
                elseif($probe==='deleted')authorityWrite($db,'UPDATE users SET deleted=1 WHERE id=?',[$foreignOwner]);
                else foreach($command['bindings'] as &$pair)if($pair['before']['pipeline_id']===$foreignIdentity['pipeline_id'])
                    $pair['before']['owner_id']='missing-owner-fixture';
                unset($pair);
                authorityRefused(fn()=>$method->invoke($service,$command,'before'),'authority_binding_owner_inactive');
            }finally{$tx->rollback();}
        }
        must(authorityV2State($db)===$state,'Rejected owner probes must restore every native user and authority row');
    });
    check('foreign-owner forecast is exact while unsigned forged and owner-removal requests remain refused',function()use($db,$profile,$service,$inspection,$foreignIdentity,$foreignReader,$admin,$client):void {
        $b=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=?',[$foreignIdentity['pipeline_id']])[0];
        $before=ClawPilotNativeEmailAuthorityDelta::nativeRow(authorityRows($db,'SELECT * FROM securitygroups_users WHERE securitygroup_id=? AND user_id=? AND deleted=0',[$b['group_id'],$foreignReader])[0]);
        $after=$before;$after['deleted']='1';$after['date_modified']=gmdate('Y-m-d H:i:s');$changes=[['before'=>$before,'after'=>$after]];
        $input=['version'=>1,'beforePolicyFingerprint'=>$inspection['nativePolicyFingerprint'],'beforeBindingsFingerprint'=>$inspection['beforeBindingsFingerprint'],
            'revokeMembershipChanges'=>$changes,'grantMembershipChanges'=>[]];
        $state=authorityV2State($db);$projected=$service->project($input);
        $command=authorityV2Command($db,$profile,'revoke',$changes,hash('sha256','synthetic unsigned foreign membership'));
        must($projected['revokePolicyFingerprint']===$command['afterPolicyFingerprint'],'Forecast must match independent actual foreign-group mutation and rollback');
        authorityRefused(fn()=>$service->execute($command),'authority_approval_missing');
        $forged=authoritySigned($db,$command,(string)$admin->id,(string)$client->id);$forged['proof']['planHash']=hash('sha256','forged foreign plan');
        authorityRefused(fn()=>$service->approve($command,$forged),'authority_proof_signature');
        $owner=ClawPilotNativeEmailAuthorityDelta::nativeRow(authorityRows($db,'SELECT * FROM securitygroups_users WHERE securitygroup_id=? AND user_id=? AND deleted=0',[$b['group_id'],$b['owner_id']])[0]);
        $removedOwner=$owner;$removedOwner['deleted']='1';$ownerInput=$input;$ownerInput['revokeMembershipChanges']=[['before'=>$owner,'after'=>$removedOwner]];
        authorityRefused(fn()=>$service->project($ownerInput),'authority_membership_outside_binding');
        must(authorityV2State($db)===$state,'Forecasts and untrusted/owner-removal requests must not mutate any native authority');
    });
    check('mixed-owner binding and Email provenance drift remain exact refusals with full native visibility checks',function()use($db,$profile,$service,$revoke,$foreignIdentity,$foreignOwner,$admin,$client,$identitiesBefore):void {
        $command=$revoke;$command['operationId']=hash('sha256','synthetic mixed-owner stale preimage');
        authorityApprove($db,$command,(string)$admin->id,(string)$client->id);
        $b=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=?',[$foreignIdentity['pipeline_id']])[0];
        $changedAudience=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>(string)$admin->id,
            'allowedSuiteCrmUserIds'=>json_decode($b['readers_json'],true),'workspaceId'=>$b['workspace_id'],'pipelineId'=>$b['pipeline_id']],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
        authorityWrite($db,'UPDATE clawpilot_email_bindings SET owner_id=?,audience_fingerprint=? WHERE pipeline_id=?',[(string)$admin->id,$changedAudience,$b['pipeline_id']]);
        try {
            $state=authorityV2State($db);authorityRefused(fn()=>$service->execute($command),'authority_binding_preimage_changed');
            must(authorityV2State($db)===$state,'Binding drift must not be repaired from a stale command');
        }finally{authorityWrite($db,'UPDATE clawpilot_email_bindings SET owner_id=?,audience_fingerprint=? WHERE pipeline_id=?',[$b['owner_id'],$b['audience_fingerprint'],$b['pipeline_id']]);}
        foreach(['assigned_user_id','created_by'] as $field) {
            authorityWrite($db,'UPDATE emails SET '.$field.'=? WHERE id=?',[(string)$admin->id,$foreignIdentity['email_id']]);
            try {
                $state=authorityV2State($db);authorityRefused(fn()=>$service->execute($command),'authority_email_owner_changed');
                must(authorityV2State($db)===$state,'Foreign Email owner/provenance drift must not authorize any transition write');
            }finally{authorityWrite($db,'UPDATE emails SET '.$field.'=? WHERE id=?',[$foreignOwner,$foreignIdentity['email_id']]);}
        }
        $method=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'capabilities');$tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
        try {
            $bad=$revoke;foreach($bad['capabilities'] as &$entry)if($entry['pipelineId']===$foreignIdentity['pipeline_id'])
                $entry['before']['view']=array_values(array_diff($entry['before']['view'],[(string)$admin->id]));
            unset($entry);
            authorityRefused(fn()=>$method->invoke($service,$bad,$identitiesBefore,'before'),'authority_effective_capability_changed');
        }finally{$tx->rollback();}
    });
    check('native ACL stages match complete fresh-per-user reference despite hostile caller session state',function()use($db,$profile,$service,$revoke,$identitiesBefore):void {
        // authorityV2Command uses the unchanged authorityMatrix reference:
        // fresh native Email retrieval for every user and record. The executor
        // must match that exact complete matrix, not a sampled subset.
        $method=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'capabilities');
        $priorUser=$GLOBALS['current_user'];$priorSession=$_SESSION??[];
        $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
        try {
            $_SESSION=['fixture-stale-marker'=>'must-not-authorize'];
            foreach(authorityRows($db,'SELECT id FROM users WHERE deleted=0 ORDER BY id') as $row)
                foreach(array_merge(['access'],ClawPilotNativeEmailAuthorityContract::SURFACES) as $surface)
                    $_SESSION['ACL'][$row['id']]['Emails']['module'][$surface]=['aclaccess'=>ACL_ALLOW_ALL];
            $seeded=$_SESSION;$method->invoke($service,$revoke,$identitiesBefore,'before');
            must($_SESSION===$seeded && $GLOBALS['current_user']===$priorUser,'Complete native readback must restore caller session and principal');
            // Repeat in the same PHP process after every principal was visited;
            // request-static refresh flags must not replace a fresh stage scan.
            $method->invoke($service,$revoke,$identitiesBefore,'before');
            must($_SESSION===$seeded && $GLOBALS['current_user']===$priorUser,'Repeated stage may not leak another user context');
            // Exercise the real framed executor path against that same full
            // independent fresh-per-user/reference matrix, not an ACL cache.
            $method->invoke($service,$revoke,$identitiesBefore,'before',$tx);
            must($_SESSION===$seeded && $GLOBALS['current_user']===$priorUser,'Fenced stage must restore caller and evaluate every native action');
        }finally{$tx->rollback();$GLOBALS['current_user']=$priorUser;$_SESSION=$priorSession;}
    });
    check('phase-local native Email hydration remains independent of caller and matches every reference principal and action',function()use($db,$profile,$service,$revoke,$identitiesBefore):void {
        $method=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'capabilities');
        $priorUser=$GLOBALS['current_user'];$priorSession=$_SESSION??[];
        $other=authorityRows($db,'SELECT id FROM users WHERE deleted=0 AND is_admin=0 ORDER BY id LIMIT 1');
        must(count($other)===1,'Independent non-administrator hydration context required');
        $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
        try {
            // The approved matrix was obtained by the unchanged reference,
            // which retrieves every Email separately for every native user.
            // Even a different hydration caller must yield that exact matrix.
            $GLOBALS['current_user']=fresh('Users',$other[0]['id']);$_SESSION=['fixture-hydration-context'=>'non-admin'];
            $hydrationUser=$GLOBALS['current_user'];$hydrationSession=$_SESSION;
            $method->invoke($service,$revoke,$identitiesBefore,'before');
            must($GLOBALS['current_user']===$hydrationUser && $_SESSION===$hydrationSession,
                'Phase-local hydration must restore the original non-administrator caller and session');
        }finally{$tx->rollback();$GLOBALS['current_user']=$priorUser;$_SESSION=$priorSession;}
    });
    check('bounded ownership hydration matches independent full retrieval with large bodies and archived identities',function()use($db,$profile,$service,$identitiesBefore):void {
        $read=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'readCapabilities');
        $ownership=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'capabilityOwnershipRows');
        $hydrate=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'hydrateCapabilityEmail');
        $archived=array_values(array_filter($identitiesBefore,static fn($row)=>(int)$row['app_archived']===1));
        $active=array_values(array_filter($identitiesBefore,static fn($row)=>(int)$row['app_archived']===0));
        must(count($archived)>0 && count($active)>0,'Both archived and active native Email identities are required');
        $state=authorityV2State($db);$tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
        try {
            ClawPilotNativeEmailRuntime::attest($db);
            $body=str_repeat('synthetic-body-',80000);
            foreach([$archived[0],$active[0]] as $identity) {
                $id=$identity['email_id'];
                must(count(authorityRows($db,'SELECT email_id FROM emails_text WHERE email_id=?',[$id]))===1,'Real native EmailText fixture required');
                authorityWrite($db,'UPDATE emails_text SET description=?,description_html=?,raw_source=? WHERE email_id=?',[$body,$body,$body,$id]);
                $full=fresh('Emails',$id);
                must(strlen((string)$full->description)===strlen($body),'Independent retrieve must actually hydrate the large body');
                unset($full);
            }
            unset($body);
            $rows=$ownership->invoke($service,$identitiesBefore);
            must(count($rows)===count($identitiesBefore),'No archived or active identity may be dropped from hydration');
            foreach($rows as $row) {
                ClawPilotNativeEmailAuthorityContract::keys($row,['id','assigned_user_id','created_by','deleted']);
                $email=$hydrate->invoke($service,$row);
                must($email->fetched_row===$row && empty($email->description) && empty($email->description_html)
                    && empty($email->raw_source),'Fresh ACL hydration must retain ownership only, not native body fields');
            }
            $expected=[];foreach(authorityMatrix($db) as $entry)$expected[$entry['emailId']]=$entry['capabilities'];
            $actual=$read->invoke($service,$identitiesBefore,authorityRows($db,'SELECT id FROM users WHERE deleted=0 ORDER BY id'));
            must(ClawPilotNativeEmailAuthorityContract::canonical($actual)===ClawPilotNativeEmailAuthorityContract::canonical($expected),
                'Every action/principal must match unchanged independent native full retrieval, including archived large-body records');
        }finally{$tx->rollback();}
        must(authorityV2State($db)===$state,'Large-body hydration proof must preserve every native content and authority row');
    });
    check('fresh native hydration preserves assigned-owner precedence and created-owner fallback and rejects malformed rows',function()use($db,$profile,$service,$identitiesBefore,$viewer,$editor):void {
        $hydrate=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'hydrateCapabilityEmail');
        $ownership=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'capabilityOwnershipRows');
        $id=$identitiesBefore[0]['email_id'];$state=authorityV2State($db);
        $priorUser=$GLOBALS['current_user'];$priorSession=$_SESSION??[];
        $users=authorityRows($db,'SELECT id FROM users WHERE deleted=0 ORDER BY id');
        $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
        try {
            ClawPilotNativeEmailRuntime::attest($db);
            foreach([[$viewer,$editor],['',$editor],[null,$editor],[$viewer,'']] as [$assigned,$created]) {
                authorityWrite($db,'UPDATE emails SET assigned_user_id=?,created_by=? WHERE id=?',[$assigned,$created,$id]);
                $row=authorityRows($db,'SELECT id,assigned_user_id,created_by,deleted FROM emails WHERE id=?',[$id])[0];
                foreach($users as $user) {
                    selectUser(fresh('Users',$user['id']));$reference=fresh('Emails',$id);$email=$hydrate->invoke($service,$row);
                    $owner=$assigned===null || $assigned===''?$created:$assigned;
                    must($email->isOwner($user['id'])===$reference->isOwner($user['id'])
                        && $email->isOwner($user['id'])===($owner===$user['id']),'Native assigned/created ownership precedence must stay exact');
                    foreach(ClawPilotNativeEmailAuthorityContract::SURFACES as $surface)
                        must($email->ACLAccess($surface)===$reference->ACLAccess($surface),'All native actions must preserve owner/fallback parity');
                }
                // The helper preserves native fallback semantics, but actual
                // enrolled production scans retain their nonempty owner pins
                // and cannot trigger fallback full-body retrieval.
                if($assigned===null || $assigned==='' || $created==='')
                    authorityRefused(fn()=>$ownership->invoke($service,$identitiesBefore),'authority_email_owner_changed');
            }
            $row=['id'=>$id,'assigned_user_id'=>$viewer,'created_by'=>$editor,'deleted'=>0];
            foreach([['assigned_user_id',[]],['created_by',false],['deleted',null],['deleted',false],['deleted','00']] as [$key,$value]) {
                $bad=$row;$bad[$key]=$value;
                authorityRefused(fn()=>$hydrate->invoke($service,$bad),'authority_email_acl_row_shape');
            }
            $bad=$row;$bad['description']='not-an-ACL-input';
            authorityRefused(fn()=>$hydrate->invoke($service,$bad),'authority_keys');
        }finally{$tx->rollback();$GLOBALS['current_user']=$priorUser;$_SESSION=$priorSession;}
        must(authorityV2State($db)===$state,'Owner/fallback probes must not change production-supported ownership or any native state');
    });
    check('batched identity and group locking retains missing deleted and duplicate rows as exact refusals',function()use($db,$profile,$service,$revoke,$identitiesBefore):void {
        $method=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'identities');$id=$identitiesBefore[0]['email_id'];
        $link=authorityRows($db,"SELECT * FROM securitygroups_records WHERE record_id=? AND module='Emails'",[$id])[0];
        foreach(['deleted-email','deleted-link','duplicate-link'] as $probe) {
            $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
            try {
                if($probe==='deleted-email')authorityWrite($db,'UPDATE emails SET deleted=1 WHERE id=?',[$id]);
                elseif($probe==='deleted-link')authorityWrite($db,'UPDATE securitygroups_records SET deleted=1 WHERE id=?',[$link['id']]);
                else authorityWrite($db,'INSERT INTO securitygroups_records(id,securitygroup_id,record_id,module,date_modified,deleted) VALUES(?,?,?,?,?,0)',
                    [create_guid(),$link['securitygroup_id'],$id,'Emails',gmdate('Y-m-d H:i:s')]);
                authorityRefused(fn()=>$method->invoke($service,$revoke),$probe==='deleted-email'?'authority_deleted_identity_requires_review':'authority_email_group_changed');
            }finally{$tx->rollback();}
        }
    });
    check('v1 authority execution cannot touch a v2 binding even with an exact signed approval',function()use($db,$service,$revoke,$admin,$client):void {
        $legacy=$revoke;$legacy['version']=1;$legacy['operationId']=hash('sha256','native-v1-cannot-mutate-v2');
        foreach($legacy['bindings'] as &$pair)foreach(['before','after'] as $stage)unset($pair[$stage]['capability_policy_json'],$pair[$stage]['capability_policy_fingerprint']);unset($pair);
        $legacy=authorityV2Rehash($legacy);authorityApprove($db,$legacy,(string)$admin->id,(string)$client->id);$state=authorityV2State($db);
        authorityRefused(fn()=>$service->execute($legacy),'authority_capability_transition_unsupported');
        must(authorityV2State($db)===$state,'V1 downgrade must leave all v2 authority untouched');
    });
    authorityApprove($db,$revoke,(string)$admin->id,(string)$client->id);
    check('v2 transition requires exact independently enrolled historical capabilities',function()use($db,$service,$revoke,$pipeline):void {
        $id=authorityRows($db,'SELECT * FROM clawpilot_email_identities WHERE pipeline_id=? ORDER BY email_id LIMIT 1',[$pipeline])[0];
        authorityWrite($db,'UPDATE clawpilot_email_identities SET capabilities_json=NULL WHERE email_id=?',[$id['email_id']]);$state=authorityV2State($db);
        try{authorityRefused(fn()=>$service->execute($revoke),'authority_capability_identity_unreviewed');must(authorityV2State($db)===$state,'Unreviewed identity must prevent every phase mutation');}
        finally{authorityWrite($db,'UPDATE clawpilot_email_identities SET capabilities_json=? WHERE email_id=?',[$id['capabilities_json'],$id['email_id']]);}
    });
    check('v2 revoke atomically removes reader access updates exact pins and preserves existing editor rights',function()use($db,$service,$revoke,$content,$pipeline,$viewer,$editor,$identitiesBefore,&$wire,&$timings):void {
        $started=hrtime(true);$receipt=$service->execute($revoke);$timings['revokeMs']=(hrtime(true)-$started)/1_000_000;
        must($receipt['version']===2 && $receipt['state']==='committed' && !$receipt['replayed'],'Actual v2 revoke commit required');
        must(authorityContent($db)===$content,'Authority phase may not alter Email content owner or roles');
        $after=authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id');
        foreach($after as $n=>$id) {
            if($id['pipeline_id']!==$pipeline)must($id===$identitiesBefore[$n],'Unaffected identity bytes must stay exact');
            else {$caps=json_decode($id['capabilities_json'],true);must(!in_array($viewer,$caps['view'],true) && in_array($editor,$caps['edit'],true)
                && in_array($editor,$caps['delete'],true),'Revocation must preserve legitimate editors and exclude revoked reader');}
        }
        $wire[]=['command'=>$revoke,'receipt'=>$receipt];
    });
    $restored=$plannedRestore;
    $grant=authorityV2Command($db,$profile,'grant',[['before'=>$deleted,'after'=>$restored]],$transition,[$pipeline=>$originalPolicy['futureCreate']]);
    must($projection['grantPolicyFingerprint']===$grant['afterPolicyFingerprint'],'In-memory chained grant forecast must equal independent native mutation/rollback evidence');
    check('v2 grant rejects fabricated new editor expectations and rolls membership plus trusted pins back',function()use($db,$service,$grant,$pipeline,$viewer,$admin,$client):void {
        $bad=$grant;$bad['operationId']=hash('sha256','native-v2-fabricated-future-editor');
        foreach($bad['bindings'] as &$pair)if($pair['before']['pipeline_id']===$pipeline) {
            $p=json_decode($pair['after']['capability_policy_json'],true);$p['futureCreate']['edit'][]=$viewer;sort($p['futureCreate']['edit'],SORT_STRING);
            $pair['after']['capability_policy_json']=ClawPilotNativeEmailAuthorityContract::canonical($p);unset($p['historical']);
            $pair['after']['capability_policy_fingerprint']=ClawPilotNativeEmailAuthorityContract::digest($p);
        }unset($pair);
        foreach($bad['capabilities'] as &$entry)if($entry['pipelineId']===$pipeline){$entry['after']['edit'][]=$viewer;sort($entry['after']['edit'],SORT_STRING);}unset($entry);
        $bad=authorityV2Rehash($bad);authorityApprove($db,$bad,(string)$admin->id,(string)$client->id);$state=authorityV2State($db);
        authorityRefused(fn()=>$service->execute($bad),'authority_effective_capability_changed');
        must(authorityV2State($db)===$state,'Failed actual post-membership ACL must roll back every membership pin and receipt');
    });
    authorityApprove($db,$grant,(string)$admin->id,(string)$client->id);
    check('v2 grant requires actual revoke receipt chain and restores reviewed read-only membership',function()use($db,$service,$grant,$content,$pipeline,$viewer,$editor,&$wire,&$timings):void {
        $started=hrtime(true);$receipt=$service->execute($grant);$timings['grantMs']=(hrtime(true)-$started)/1_000_000;
        must($receipt['version']===2 && $receipt['state']==='committed','Actual v2 grant commit required');
        must(authorityContent($db)===$content,'Grant must not mutate native content or roles');
        foreach(authorityRows($db,'SELECT capabilities_json FROM clawpilot_email_identities WHERE pipeline_id=?',[$pipeline]) as $row) {
            $caps=json_decode($row['capabilities_json'],true);must(in_array($viewer,$caps['view'],true) && !in_array($viewer,$caps['edit'],true)
                && in_array($editor,$caps['edit'],true),'Restored viewer must remain a viewer and existing editor retained');
        }
        $wire[]=['command'=>$grant,'receipt'=>$receipt];
    });
    check('v2 historical phase replay and resolution retain terminal evidence without repeating membership writes',function()use($db,$service,$revoke,$grant,&$wire):void {
        $state=authorityV2State($db);
        foreach([$revoke,$grant] as $command) {$receipt=$service->resolveOrCancel($command);must($receipt['version']===2 && $receipt['state']==='committed' && $receipt['replayed'],'Exact v2 terminal history required');$wire[]=['command'=>$command,'receipt'=>$receipt];}
        must(authorityV2State($db)===$state,'Historical resolution must be read-only');
    });
    check('independently signed foreign-owner reader revoke and restore preserve all ownership and unrelated rights',function()use($db,$profile,$service,$foreignIdentity,$foreignReader,$admin,$client,&$wire):void {
        $bindings=authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id');
        $b=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=?',[$foreignIdentity['pipeline_id']])[0];
        must($b['owner_id']!==(string)$admin->id && $foreignReader!==$b['owner_id'],'Service must not impersonate the foreign owner');
        $content=authorityContent($db);$matrix=authorityMatrix($db);
        $members=authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id');
        $before=ClawPilotNativeEmailAuthorityDelta::nativeRow(authorityRows($db,'SELECT * FROM securitygroups_users WHERE securitygroup_id=? AND user_id=? AND deleted=0',[$b['group_id'],$foreignReader])[0]);
        $deleted=$before;$deleted['deleted']='1';$deleted['date_modified']=gmdate('Y-m-d H:i:s');
        $transition=hash('sha256','native signed foreign-owner exact lifecycle');
        $revoke=authorityV2Command($db,$profile,'revoke',[['before'=>$before,'after'=>$deleted]],$transition);
        authorityApprove($db,$revoke,(string)$admin->id,(string)$client->id);$revoked=$service->execute($revoke);
        must($revoked['state']==='committed' && !$revoked['replayed'],'Signed foreign-owner revoke must actually commit');
        foreach(authorityMatrix($db) as $entry) {
            $expected=array_values(array_filter($revoke['capabilities'],static fn($value)=>$value['emailId']===$entry['emailId']))[0];
            must(ClawPilotNativeEmailAuthorityContract::canonical($entry['capabilities'])===ClawPilotNativeEmailAuthorityContract::canonical($expected['after']),
                'Every native principal/action must match independently retrieved foreign-revoke evidence');
            if($entry['pipelineId']===$b['pipeline_id'])must(!in_array($foreignReader,$entry['capabilities']['view'],true),'Exact foreign reader must lose native read access');
        }
        foreach($members as $member)if($member['id']!==$before['id'])
            must(authorityRows($db,'SELECT * FROM securitygroups_users WHERE id=?',[$member['id']])===[$member],'Unrelated native memberships must remain byte-identical');
        $restore=$deleted;$restore['deleted']='0';$restore['date_modified']=gmdate('Y-m-d H:i:s');
        $grant=authorityV2Command($db,$profile,'grant',[['before'=>$deleted,'after'=>$restore]],$transition);
        authorityApprove($db,$grant,(string)$admin->id,(string)$client->id);$restored=$service->execute($grant);
        must($restored['state']==='committed' && !$restored['replayed'],'Reviewed restore must actually commit with its original revoke and app-commit proof');
        must(authorityContent($db)===$content && ClawPilotNativeEmailAuthorityContract::canonical(authorityMatrix($db))===ClawPilotNativeEmailAuthorityContract::canonical($matrix),
            'Restoration must recover exactly the original full matrices without changing content users roles or Email ownership');
        foreach(authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id') as $index=>$binding) {
            $original=$bindings[$index];
            must((int)$binding['generation']===(int)$original['generation']+2,'Both foreign-owner phases must advance all generation pins');
            foreach(['generation','policy_fingerprint'] as $key){unset($binding[$key]);unset($original[$key]);}
            must($binding===$original,'Every binding identity owner and restored capability/audience must stay exact');
        }
        // Authority maintenance is not a publication impersonation path.
        $publication=json_decode((string)file_get_contents('/tmp/native-publisher-race.json'),true,48,JSON_THROW_ON_ERROR)['command'];
        $publication['operationId']=hash('sha256','foreign-owner publication remains forbidden');
        $publication['workspaceId']=$b['workspace_id'];$publication['pipelineId']=$b['pipeline_id'];
        $publisher=new ClawPilotNativeEmailPublisher($db,$profile,(string)$admin->id);
        authorityRefused(fn()=>$publisher->prepare($publication),'binding_missing');
        $wire[]=['command'=>$revoke,'receipt'=>$revoked];$wire[]=['command'=>$grant,'receipt'=>$restored];
    });
    $nextDeleted=$restored;$nextDeleted['deleted']='1';$nextDeleted['date_modified']=gmdate('Y-m-d H:i:s');
    $cancel=authorityV2Command($db,$profile,'revoke',[['before'=>$restored,'after'=>$nextDeleted]],hash('sha256','native-v2-expired-original'));
    check('v2 expired never-provisioned revoke can only cancel atomically using its original signed evidence',function()use($db,$service,$cancel,$admin,$client,&$wire):void {
        $envelope=authorityV2Expired(authoritySigned($db,$cancel,(string)$admin->id,(string)$client->id));
        $before=['content'=>authorityContent($db),'bindings'=>authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id'),
            'identities'=>authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id'),'members'=>authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id')];
        $result=$service->cancelExpired($cancel,$envelope);must($result['approval']['version']===1 && $result['receipt']['version']===2 && $result['receipt']['state']==='cancelled','Independent approval protocol and v2 terminal versions required');
        $again=$service->resolveOrCancel($cancel);must($again['state']==='cancelled' && $again['replayed'],'Original operation must retain terminal tombstone');
        must($before===['content'=>authorityContent($db),'bindings'=>authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id'),
            'identities'=>authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id'),'members'=>authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id')],'Expired cancellation must not change any authority');
        $wire[]=['command'=>$cancel,'receipt'=>$result['receipt']];$wire[]=['command'=>$cancel,'receipt'=>$again];
    });
    check('v2 publication remains usable after real revoke and grant with reviewed editor rights preserved',function()use($db,$profile,$pipeline,$admin,$editor):void {
        $b=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=?',[$pipeline])[0];$p=json_decode($b['capability_policy_json'],true);
        $h=json_decode((string)file_get_contents('/tmp/native-publisher-race.json'),true,48,JSON_THROW_ON_ERROR);$projection=$h['command']['projection'];
        $projection['attributes']['global_id_c']='gi8950007';$projection['attributes']['assigned_user_id']=(string)$admin->id;$projection['attributes']['name']='Synthetic post-transition publication';
        $command=['version'=>2,'operationId'=>hash('sha256','native-v2-post-authority-publication'),'mode'=>'publish','workspaceId'=>$b['workspace_id'],'pipelineId'=>$pipeline,
            'generation'=>(int)$b['generation'],'audienceFingerprint'=>$b['audience_fingerprint'],'suiteCrmId'=>create_guid(),'globalId'=>'gi8950007','localId'=>create_guid(),
            'expectedRecordFingerprint'=>null,'projection'=>$projection,'capabilityPolicyFingerprint'=>$b['capability_policy_fingerprint'],
            'principalSuiteCrmUserIds'=>$p['principalSuiteCrmUserIds'],'expectedCapabilities'=>$p['futureCreate']];
        $publisher=new ClawPilotNativeEmailPublisher($db,$profile,(string)$admin->id);$receipt=$publisher->publish($command);
        must($receipt['state']==='committed' && in_array($editor,$receipt['result']['expectedCapabilities']['edit'],true),'Real new publication must retain editor capability after authority lifecycle');
    });
    $recoveryId=hash('sha256','native-v2-append-only-grant-recovery');
    $recoveryRevoke=authorityV2Command($db,$profile,'revoke',[],$recoveryId);
    authorityApprove($db,$recoveryRevoke,(string)$admin->id,(string)$client->id);
    $recoveryRevokeReceipt=$service->execute($recoveryRevoke);$wire[]=['command'=>$recoveryRevoke,'receipt'=>$recoveryRevokeReceipt];
    $recoveryGrant=authorityV2Command($db,$profile,'grant',[],$recoveryId);
    $recoveryEnvelope=authorityV2Expired(authoritySigned($db,$recoveryGrant,(string)$admin->id,(string)$client->id));
    $originalCancellation=null;$retryOne=null;$retryOneCancellation=null;$retryTwo=null;$retryTwoCancellation=null;
    check('expired never-provisioned grant retains original proof and cancellation without changing restrictive native authority',function()use($db,$service,$recoveryGrant,$recoveryEnvelope,&$originalCancellation,&$wire):void {
        $content=authorityContent($db);$bindings=authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id');
        $members=authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id');
        authorityRefused(fn()=>$service->approve($recoveryGrant,$recoveryEnvelope),'authority_proof_expired');
        $result=$service->cancelExpired($recoveryGrant,$recoveryEnvelope);$originalCancellation=$result['receipt'];
        must($originalCancellation['state']==='cancelled' && !$originalCancellation['replayed']
            && $result['approval']['proofHash']===ClawPilotNativeEmailAuthorityContract::digest($recoveryEnvelope['proof']),
            'Original expired grant proof and cancellation must commit together');
        $again=$service->cancelExpired($recoveryGrant,$recoveryEnvelope);
        must($again['receipt']['state']==='cancelled' && $again['receipt']['replayed'],'Expired original grant cancellation must replay');
        authorityRefused(fn()=>$service->execute($recoveryGrant),'authority_proof_expired');
        must(authorityContent($db)===$content && authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id')===$bindings
            && authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id')===$members,'Cancellation may not grant or clear restrictive state');
        $wire[]=['command'=>$recoveryGrant,'receipt'=>$originalCancellation];$wire[]=['command'=>$recoveryGrant,'receipt'=>$again['receipt']];
    });
    $retryOne=authorityV2Retry($recoveryGrant,$recoveryEnvelope,$recoveryGrant,$originalCancellation,1);
    check('retry proof rejects changed command scope cancellation app commit and unsafe ordinals without native mutation',function()use($db,$service,$retryOne,$recoveryGrant,$recoveryEnvelope,$originalCancellation):void {
        $state=authorityV2State($db);$C=ClawPilotNativeEmailAuthorityContract::class;
        // Approval validates the native command before proof. Change an exact
        // but semantically unrelated global ID instead, retaining wire shape.
        $bad=$retryOne;$bad['command']['capabilities'][0]['globalId']='gi8999999';
        $bad['authorization']['proof']['commandHash']=$C::digest($bad['command']);$bad['authorization']=authorityV2Resign($bad['authorization']);
        authorityRefused(fn()=>$service->approve($bad['command'],$bad['authorization']),'authority_grant_attempt_command_changed');
        $fake=$originalCancellation;$fake['commandHash']=hash('sha256','not the retained cancellation');
        $bad=authorityV2Retry($recoveryGrant,$recoveryEnvelope,$recoveryGrant,$fake,1);
        authorityRefused(fn()=>$service->approve($bad['command'],$bad['authorization']),'authority_grant_attempt_receipt_changed');
        $changed=$recoveryEnvelope;$changed['proof']['appCommit']['appAuthorityAfterFingerprint']=hash('sha256','different app authority');
        $bad=authorityV2Retry($recoveryGrant,$changed,$recoveryGrant,$originalCancellation,1);
        authorityRefused(fn()=>$service->approve($bad['command'],$bad['authorization']),'authority_grant_attempt_evidence_changed');
        $missing=$recoveryGrant;$missing['operationId']=hash('sha256','never-provisioned predecessor');
        $bad=authorityV2Retry($recoveryGrant,$recoveryEnvelope,$missing,$originalCancellation,2);
        authorityRefused(fn()=>$service->approve($bad['command'],$bad['authorization']),'authority_grant_attempt_approval_missing');
        foreach([0,9007199254740992] as $ordinal) {
            $bad=$retryOne;$bad['authorization']['proof']['grantAttempt']['ordinal']=$ordinal;$bad['authorization']=authorityV2Resign($bad['authorization']);
            authorityRefused(fn()=>$service->approve($bad['command'],$bad['authorization']),'authority_grant_attempt_ordinal');
        }
        $bad=$retryOne;$bad['authorization']['proof']['operationId']=hash('sha256','arbitrary replacement operation');
        $bad['command']['operationId']=$bad['authorization']['proof']['operationId'];$bad['authorization']['proof']['commandHash']=$C::digest($bad['command']);
        $bad['authorization']=authorityV2Resign($bad['authorization']);
        authorityRefused(fn()=>$service->approve($bad['command'],$bad['authorization']),'authority_grant_attempt_operation_id');
        must(authorityV2State($db)===$state,'Rejected signed retry evidence must not mutate native authority');
    });
    check('append-only grant attempts survive repeated expiry and cancellation while keeping each predecessor immutable',function()use($db,$service,$recoveryGrant,$recoveryEnvelope,$originalCancellation,&$retryOne,&$retryOneCancellation,&$retryTwo,&$retryTwoCancellation,&$wire):void {
        $original=authorityRows($db,'SELECT * FROM clawpilot_email_authority_approvals WHERE operation_id=?',[$recoveryGrant['operationId']]);
        $retryOne['authorization']=authorityV2Expired($retryOne['authorization']);
        $result=$service->cancelExpired($retryOne['command'],$retryOne['authorization']);$retryOneCancellation=$result['receipt'];
        must($retryOneCancellation['state']==='cancelled','Expired never-provisioned retry must retain its own cancellation');
        $retryTwo=authorityV2Retry($recoveryGrant,$recoveryEnvelope,$retryOne['command'],$retryOneCancellation,2);
        $service->approve($retryTwo['command'],$retryTwo['authorization']);
        $retryTwoCancellation=$service->resolveOrCancel($retryTwo['command']);
        must($retryTwoCancellation['state']==='cancelled','Explicit exact resolution may cancel only this unexecuted retry');
        $late=$service->execute($retryTwo['command']);
        must($late['state']==='cancelled' && $late['replayed'],'Late execution must preserve the live-proof predecessor tombstone');
        $skip=authorityV2Retry($recoveryGrant,$recoveryEnvelope,$retryOne['command'],$retryOneCancellation,3);
        authorityRefused(fn()=>$service->approve($skip['command'],$skip['authorization']),'authority_grant_attempt_predecessor');
        must(authorityRows($db,'SELECT * FROM clawpilot_email_authority_approvals WHERE operation_id=?',[$recoveryGrant['operationId']])===$original
            && $service->resolveOrCancel($recoveryGrant)['state']==='cancelled','Original approval and cancellation may never be replaced by retries');
        foreach([[$retryOne['command'],$retryOneCancellation],[$retryTwo['command'],$retryTwoCancellation],[$retryTwo['command'],$late]] as [$command,$receipt])
            $wire[]=['command'=>$command,'receipt'=>$receipt];
    });
    $retryThree=authorityV2Retry($recoveryGrant,$recoveryEnvelope,$retryTwo['command'],$retryTwoCancellation,3);
    check('fresh append-only grant commits exact original target and expiry recovery reports actual lost-response commit',function()use($db,$service,$recoveryGrant,$retryThree,&$wire):void {
        $attempt=$retryThree;$attempt['authorization']['proof']['issuedAt']=time()-297;$attempt['authorization']['proof']['expiresAt']=time()+3;
        $attempt['authorization']=authorityV2Resign($attempt['authorization']);
        $content=authorityContent($db);$oldOperations=authorityRows($db,'SELECT * FROM clawpilot_email_authority_operations ORDER BY operation_id');
        $service->approve($attempt['command'],$attempt['authorization']);$committed=$service->execute($attempt['command']);
        must($committed['state']==='committed' && !$committed['replayed'],'Fresh reviewed retry must commit');
        must(authorityContent($db)===$content,'Grant retry may not change native Email content or ownership');
        foreach($oldOperations as $old)must(authorityRows($db,'SELECT * FROM clawpilot_email_authority_operations WHERE operation_id=?',[$old['operation_id']])[0]===$old,
            'Existing terminal evidence must stay byte-identical');
        sleep(4);$state=authorityV2State($db);$result=$service->cancelExpired($attempt['command'],$attempt['authorization']);
        $expected=$committed;$expected['replayed']=true;
        // Persisted result_json is canonically key-sorted; the immediate
        // execute response uses construction order. JSON object order is not
        // evidence of a different receipt, but types and every value are.
        must(ClawPilotNativeEmailAuthorityContract::canonical($result['receipt'])===ClawPilotNativeEmailAuthorityContract::canonical($expected),
            'Expired grant recovery must return the exact retained commit with replay=true');
        must(authorityV2State($db)===$state,'Expired committed-grant resolution must be read-only');
        $forbidden=authorityV2Retry($recoveryGrant,$attempt['authorization'],$attempt['command'],$committed,4);
        authorityRefused(fn()=>$service->approve($forbidden['command'],$forbidden['authorization']),'authority_grant_attempt_not_cancelled');
        $wire[]=['command'=>$attempt['command'],'receipt'=>$committed];$wire[]=['command'=>$attempt['command'],'receipt'=>$result['receipt']];
    });
    fwrite(STDOUT,'CLAWPILOT_NATIVE_AUTHORITY_V2_RECEIPTS='.json_encode($wire,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)."\n");
    fwrite(STDOUT,'CLAWPILOT_NATIVE_AUTHORITY_V2_PLANNING='.json_encode(['snapshot'=>$inspection,'projection'=>$projection,
        'revokeMembershipChanges'=>$revoke['membershipChanges'],'grantMembershipChanges'=>$grant['membershipChanges']],
        JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)."\n");
    fwrite(STDOUT,'NATIVE_AUTHORITY_V2_TIMING='.json_encode(['emailCount'=>count($revoke['capabilities']),
        'principalCount'=>count($originalPolicy['principalSuiteCrmUserIds']),'milliseconds'=>$timings,'commitDeadlineSeconds'=>5],JSON_THROW_ON_ERROR)."\n");
    require '/fixture/native-authority-roles.php';
    runNativeRoleAcceptance($db,$profile,$service,$admin,$client,$pipeline,$viewer);
    // Separate explicit scale evidence, not an enlarged deadline or a claim
    // about production. Keep every existing fixture principal and control scope.
    // 334 is the read-only 329-row snapshot plus exactly five reviewed missing
    // emails. It is a named synthetic profile, not future/max/live capacity.
    $scaleChoice=getenv('CLAWPILOT_NATIVE_FIXTURE_SCALE_EMAIL_COUNT');
    must($scaleChoice===false || $scaleChoice==='318' || $scaleChoice==='334','Unknown synthetic history profile');
    $scaleEmailCount=$scaleChoice===false?318:(int)$scaleChoice;
    $count=(int)authorityRows($db,'SELECT COUNT(*) AS count FROM clawpilot_email_identities')[0]['count'];
    must($count<=$scaleEmailCount,'Bounded synthetic scale fixture would exceed requested coverage');
    $scaleBinding=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=?',[$pipeline])[0];
    $scalePolicy=json_decode($scaleBinding['capability_policy_json'],true,32,JSON_THROW_ON_ERROR);
    $scaleGroup=fresh('SecurityGroups',$scaleBinding['group_id']);
    for($index=$count;$index<$scaleEmailCount;$index++) {
        $global='gi'.(8960000+$index);$email=emailFixture('Synthetic bounded authority scale '.$index,$global,(string)$admin->id);
        $scaleGroup->addGroupToRecord('Emails',(string)$email->id,(string)$scaleGroup->id);
        authorityWrite($db,'INSERT INTO clawpilot_email_identities(email_id,global_id,local_id,pipeline_id,workspace_id,app_archived,capabilities_json) VALUES(?,?,?,?,?,?,?)',
            [(string)$email->id,$global,create_guid(),$pipeline,$scaleBinding['workspace_id'],(string)($index%2),
                ClawPilotNativeEmailAuthorityContract::canonical($scalePolicy['futureCreate'])]);
        // Synthetic scale setup must seed the independent permission registry
        // too: this scope was explicitly enrolled by the real role test above.
        // Do not weaken the production missing-registry refusal or count this
        // fixture seeding as evidence of historical enrollment/publication.
        authorityWrite($db,'INSERT INTO clawpilot_email_write_permissions(email_id,pipeline_id,capabilities_json,source_kind,operation_id,command_hash) VALUES(?,?,?,?,?,?)',
            [(string)$email->id,$pipeline,ClawPilotNativeEmailAuthorityContract::canonical($scalePolicy['futureCreate']),
                'authority',hash('sha256','synthetic-scale-setup'),hash('sha256','synthetic-scale-setup-'.$global)]);
    }
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);try{$scaleNativePolicy=$tx->immutablePolicyFingerprint();}finally{$tx->rollback();}
    authorityWrite($db,'UPDATE clawpilot_email_bindings SET policy_fingerprint=?',[$scaleNativePolicy]);
    $scaleBefore=authorityRows($db,'SELECT * FROM securitygroups_users WHERE id=?',[$restored['id']])[0];
    $scaleBefore=ClawPilotNativeEmailAuthorityDelta::nativeRow($scaleBefore);$scaleAfter=$scaleBefore;$scaleAfter['deleted']='1';$scaleAfter['date_modified']=gmdate('Y-m-d H:i:s');
    $scale=authorityV2Command($db,$profile,'revoke',[['before'=>$scaleBefore,'after'=>$scaleAfter]],hash('sha256','native-v2-bounded-'.$scaleEmailCount.'-scale'));
    must(count($scale['capabilities'])===$scaleEmailCount,'Every synthetic historical identity must participate in scale proof');
    authorityApprove($db,$scale,(string)$admin->id,(string)$client->id);$scaleState=authorityV2State($db);$started=hrtime(true);
    $scaleStatus='committed';
    try{$receipt=$service->execute($scale);$scaleDuration=(hrtime(true)-$started)/1_000_000;
        must($receipt['state']==='committed' && $receipt['version']===2,'Actual scale commit receipt required');}
    catch(ClawPilotNativeEmailTransactionRefused $error) {
        $scaleDuration=(hrtime(true)-$started)/1_000_000;
        if($error->holdCode!=='commit_deadline_exceeded')throw $error;
        $scaleStatus='deadline_held';must(authorityV2State($db)===$scaleState,'Deadline hold must roll back every membership capability binding and receipt');
    }
    fwrite(STDOUT,'NATIVE_AUTHORITY_V2_SCALE='.json_encode(['status'=>$scaleStatus,'emailCount'=>$scaleEmailCount,
        'principalCount'=>count($scalePolicy['principalSuiteCrmUserIds']),'durationMs'=>$scaleDuration,
        'commitDeadlineSeconds'=>5,'productionScaleProven'=>false],JSON_THROW_ON_ERROR)."\n");
    if($scaleStatus==='committed') {
        $grantBefore=ClawPilotNativeEmailAuthorityDelta::nativeRow(authorityRows($db,'SELECT * FROM securitygroups_users WHERE id=?',[$restored['id']])[0]);
        $grantAfter=$grantBefore;$grantAfter['deleted']='0';$grantAfter['date_modified']=gmdate('Y-m-d H:i:s');
        $scaleGrant=authorityV2Command($db,$profile,'grant',[['before'=>$grantBefore,'after'=>$grantAfter]],$scale['transitionId'],
            [$pipeline=>$scalePolicy['futureCreate']]);
        must(count($scaleGrant['capabilities'])===$scaleEmailCount,'Full large-history grant inventory required');
        authorityApprove($db,$scaleGrant,(string)$admin->id,(string)$client->id);
        $grantState=authorityV2State($db);$started=hrtime(true);$grantStatus='committed';
        try{$grantReceipt=$service->execute($scaleGrant);$grantDuration=(hrtime(true)-$started)/1_000_000;
            must($grantReceipt['state']==='committed','Actual scale grant commit required');}
        catch(ClawPilotNativeEmailTransactionRefused $error){
            $grantDuration=(hrtime(true)-$started)/1_000_000;
            if($error->holdCode!=='commit_deadline_exceeded')throw $error;
            $grantStatus='deadline_held';must(authorityV2State($db)===$grantState,'Large grant hold must retain the complete restrictive state');
        }
        fwrite(STDOUT,'NATIVE_AUTHORITY_V2_SCALE_GRANT='.json_encode(['status'=>$grantStatus,'emailCount'=>$scaleEmailCount,
            'principalCount'=>count($scalePolicy['principalSuiteCrmUserIds']),'durationMs'=>$grantDuration,
            'commitDeadlineSeconds'=>5,'productionScaleProven'=>false],JSON_THROW_ON_ERROR)."\n");
        if($grantStatus==='committed'){
            $replayState=authorityV2State($db);$again=$service->execute($scaleGrant);
            must($again['state']==='committed'&&$again['replayed']&&authorityV2State($db)===$replayState,'Large-history grant replay must remain read-only');
            fwrite(STDOUT,'NATIVE_AUTHORITY_V2_SCALE_BOTH_PASSED=1'."\n");
        }
    }
    if($scaleStatus==='deadline_held') {
        // Rollback-only diagnosis, never a replacement for the timed execution
        // above. Keep every principal and Email, and compare the entire result
        // to the original native before matrix rather than timing a subset.
        $read=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'readCapabilities');
        $identities=authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id');
        $users=authorityRows($db,'SELECT id,is_admin,status FROM users WHERE deleted=0 ORDER BY id');
        $costs=[];$combined=[];foreach($identities as $identity)$combined[$identity['email_id']]=array_fill_keys(ClawPilotNativeEmailAuthorityContract::SURFACES,[]);
        $profileState=authorityV2State($db);$profileTx=ClawPilotNativeEmailTransaction::begin($db,$profile);
        try {
            foreach($users as $index=>$user) {
                $queries=(int)$db->query("SHOW SESSION STATUS LIKE 'Questions'")->fetch_assoc()['Value'];$started=hrtime(true);
                $matrix=$read->invoke($service,$identities,[['id'=>$user['id']]],$profileTx);
                $costs[]=['principalOrdinal'=>$index,'administrator'=>(int)$user['is_admin']===1,'status'=>$user['status'],
                    'durationMs'=>(hrtime(true)-$started)/1_000_000,
                    'sessionStatementsIncludingMeasurement'=>(int)$db->query("SHOW SESSION STATUS LIKE 'Questions'")->fetch_assoc()['Value']-$queries];
                foreach($matrix as $id=>$surfaces)foreach($surfaces as $surface=>$ids)$combined[$id][$surface]=array_merge($combined[$id][$surface],$ids);
            }
            foreach($scale['capabilities'] as $entry)must(ClawPilotNativeEmailAuthorityContract::canonical($combined[$entry['emailId']])
                ===ClawPilotNativeEmailAuthorityContract::canonical($entry['before']),'Performance diagnosis must reproduce all principals and all actions');
        }finally{$profileTx->rollback();}
        must(authorityV2State($db)===$profileState,'Performance diagnosis may not retain any native registry or content changes');
        fwrite(STDOUT,'NATIVE_AUTHORITY_V2_PROFILE='.json_encode(['emailCount'=>$scaleEmailCount,'principalCount'=>count($users),'principals'=>$costs,
            'rollbackOnly'=>true,'fullMatrixMatched'=>true],JSON_THROW_ON_ERROR)."\n");
    }
    fwrite(STDOUT,'NATIVE_AUTHORITY_V2_PASSED='.$GLOBALS['checks']."\n");
}catch(Throwable $error){fwrite(STDERR,get_class($error).': '.$error->getMessage()."\n".$error->getTraceAsString()."\n");exit(1);}
})();
