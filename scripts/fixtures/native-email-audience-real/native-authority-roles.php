<?php
declare(strict_types=1);
// Invoked inside the isolated real native fixture before its separate scale
// measurement. Actual native ACLs/phase execution; PG admission is synthetic.
function nativeRoleCommand(mysqli $db,array $profile,string $pipeline,string $user,string $beforeRole,string $afterRole,string $phase,string $transition):array
{
    $C=ClawPilotNativeEmailAuthorityContract::class;
    $bindings=array_map(static fn($b)=>$C::nativeBinding($b,2),authorityRows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id'));
    $actual=authorityMatrix($db);$tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
    try{$policy=$tx->immutablePolicyFingerprint();}finally{$tx->rollback();}
    $changeWrites=($phase==='revoke'&&$afterRole==='viewer')||($phase==='grant'&&$afterRole==='editor');
    $nextWrites=static function(array $matrix)use($changeWrites,$afterRole,$user):array{
        if($changeWrites)foreach(['edit','delete'] as $surface){
            $matrix[$surface]=$afterRole==='viewer'?array_values(array_diff($matrix[$surface],[$user]))
                :array_values(array_unique(array_merge($matrix[$surface],[$user])));
            sort($matrix[$surface],SORT_STRING);
        }
        return $matrix;
    };
    $pairs=[];
    foreach($bindings as $b){
        $after=$b;$after['generation']=(string)((int)$b['generation']+1);
        if($b['pipeline_id']===$pipeline){
            $p=json_decode($b['capability_policy_json'],true,32,JSON_THROW_ON_ERROR);$p['futureCreate']=$nextWrites($p['futureCreate']);
            $after['capability_policy_json']=$C::canonical($p);unset($p['historical']);$after['capability_policy_fingerprint']=$C::digest($p);
        }
        $pairs[]=['before'=>$b,'after'=>$after];
    }
    $caps=[];foreach($actual as $row)$caps[]=['emailId'=>$row['emailId'],'globalId'=>$row['globalId'],'pipelineId'=>$row['pipelineId'],
        'before'=>$row['capabilities'],'after'=>$row['pipelineId']===$pipeline?$nextWrites($row['capabilities']):$row['capabilities']];
    $generation=(int)$bindings[0]['generation'];
    $c=['version'=>2,'operationId'=>hash('sha256',$transition.'-'.$phase),'transitionId'=>$transition,'phase'=>$phase,
        'generationFrom'=>$generation,'generationTo'=>$generation+1,'desiredAppChangeHash'=>hash('sha256',$pipeline.$user.$beforeRole.$afterRole),
        'beforePolicyFingerprint'=>$policy,'afterPolicyFingerprint'=>$policy,'beforeBindingsFingerprint'=>$C::digest($bindings),
        'afterBindingsFingerprint'=>$C::digest(array_column($pairs,'after')),'runtimeFingerprint'=>$bindings[0]['runtime_fingerprint'],
        'bindings'=>$pairs,'membershipChanges'=>[],'capabilities'=>$caps,'pendingPublicationCommand'=>null,
        'roleChanges'=>[['pipelineId'=>$pipeline,'userId'=>$user,'beforeRole'=>$beforeRole,'afterRole'=>$afterRole]]];
    $C::validate($c);return $c;
}
function nativeRoleSurfaces(string $email,string $user):array
{
    selectUser(fresh('Users',$user));$bean=fresh('Emails',$email);$result=[];
    foreach(ClawPilotNativeEmailAuthorityContract::SURFACES as $surface)$result[$surface]=$bean->ACLAccess($surface);
    return $result;
}
function nativeRoleV8Save(string $id,string $user,string $name):void
{
    selectUser(fresh('Users',$user));[$service,$manager,$validator]=v8Service();
    $params=new Api\V8\Param\UpdateModuleParams($validator,$manager);
    $params->configure(['data'=>['type'=>'Emails','id'=>$id,'attributes'=>['name'=>$name]]]);
    $request=Slim\Http\Request::createFromEnvironment(Slim\Http\Environment::mock([
        'REQUEST_METHOD'=>'PATCH','REQUEST_URI'=>'/Api/V8/module']));
    $service->updateRecord($params,$request);
}
function runNativeRoleAcceptance(mysqli $db,array $profile,$service,$admin,$client,string $pipeline,string $viewer):void
{
    $C=ClawPilotNativeEmailAuthorityContract::class;
    $GLOBALS['sugar_config']['clawpilot_managed_email_write_scope']=true;
    selectUser($admin);$_REQUEST=[];
    $runtime=ClawPilotNativeEmailRuntime::attest($db);
    // Explicit fixture setup, not a production runtime-waiver or role grant.
    authorityWrite($db,'UPDATE clawpilot_email_bindings SET runtime_fingerprint=?',[$runtime]);
    $content=authorityContent($db);$members=authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id');
    $history=authorityRows($db,'SELECT email_id FROM clawpilot_email_identities WHERE pipeline_id=? ORDER BY email_id LIMIT 1',[$pipeline])[0]['email_id'];
    must(!nativeRoleSurfaces($history,$viewer)['edit'],'Initial viewer must have no native write rights');
    selectUser($admin);$_REQUEST=[];
    $publish=static function(string $tag,string $global)use($db,$profile,$admin,$pipeline):string{
        selectUser($admin);$_REQUEST=[];$b=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=?',[$pipeline])[0];
        $p=json_decode($b['capability_policy_json'],true,32,JSON_THROW_ON_ERROR);
        $handoff=json_decode((string)file_get_contents('/tmp/native-publisher-race.json'),true,48,JSON_THROW_ON_ERROR);
        $projection=$handoff['command']['projection'];$projection['attributes']['global_id_c']=$global;
        $projection['attributes']['name']='Synthetic managed native role '.$tag;$projection['attributes']['assigned_user_id']=(string)$admin->id;
        $command=['version'=>2,'operationId'=>hash('sha256','managed-role-'.$tag),'mode'=>'publish','workspaceId'=>$b['workspace_id'],
            'pipelineId'=>$pipeline,'generation'=>(int)$b['generation'],'audienceFingerprint'=>$b['audience_fingerprint'],
            'suiteCrmId'=>create_guid(),'globalId'=>$global,'localId'=>create_guid(),'expectedRecordFingerprint'=>null,'projection'=>$projection,
            'capabilityPolicyFingerprint'=>$b['capability_policy_fingerprint'],'principalSuiteCrmUserIds'=>$p['principalSuiteCrmUserIds'],
            'expectedCapabilities'=>$p['futureCreate']];
        $publisher=new ClawPilotNativeEmailPublisher($db,$profile,(string)$admin->id);$result=$publisher->publish($command);
        must($result['state']==='committed','Actual future publication must commit');return $command['suiteCrmId'];
    };
    $transition=hash('sha256','synthetic-native-retained-promotion');
    $revoke=nativeRoleCommand($db,$profile,$pipeline,$viewer,'viewer','editor','revoke',$transition);
    check('native retained-role command without approval cannot enroll managed write scope',function()use($db,$service,$revoke):void{
        authorityRefused(fn()=>$service->execute($revoke),'authority_approval_missing');
        must(authorityRows($db,'SELECT * FROM clawpilot_email_write_scopes')===[],'No unapproved scope enrollment');
    });
    if(getenv('CLAWPILOT_NATIVE_FIXTURE_APP_PG')==='1'){
        check('first existing-account native grant enrolls a fresh managed scope and keeps historical and future writes denied',function()use($db,$profile,$service,$admin,$client,$pipeline,$history,$publish):void{
            $C=ClawPilotNativeEmailAuthorityContract::class;
            $existing=authorityRows($db,"SELECT u.id,c.global_id_c FROM users u JOIN users_cstm c ON c.id_c=u.id
                WHERE u.user_name='gu7654321' AND c.global_id_c='gu7654321' AND u.status='Active' AND u.deleted=0");
            must(count($existing)===1,'Previously prepared existing native account required');$target=$existing[0]['id'];
            $content=authorityContent($db);$transition=hash('sha256','synthetic-first-existing-account-fresh-scope');
            $links=[['userId'=>$target,'globalId'=>'gu7654321','username'=>'gu7654321']];
            selectUser($admin);$_REQUEST=[];
            $revoke=authorityV2Command($db,$profile,'revoke',[],$transition);$revoke['identityLinks']=$links;$C::validate($revoke);
            authorityApprove($db,$revoke,(string)$admin->id,(string)$client->id);$service->execute($revoke);
            $b=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=?',[$pipeline])[0];
            $future=json_decode($b['capability_policy_json'],true,32,JSON_THROW_ON_ERROR)['futureCreate'];
            foreach(['view','list','export'] as $surface){$future[$surface][]=$target;sort($future[$surface],SORT_STRING);}
            $member=['id'=>create_guid(),'date_modified'=>'2026-11-03 15:00:00','deleted'=>'0',
                'securitygroup_id'=>$b['group_id'],'user_id'=>$target,'primary_group'=>'0','noninheritable'=>'1'];
            $grant=authorityV2Command($db,$profile,'grant',[['before'=>null,'after'=>$member]],$transition,[$pipeline=>$future]);
            $grant['identityLinks']=$links;$C::validate($grant);
            authorityApprove($db,$grant,(string)$admin->id,(string)$client->id);$service->execute($grant);
            must(count(authorityRows($db,'SELECT * FROM clawpilot_email_write_scopes WHERE pipeline_id=?',[$pipeline]))===1,'First account grant must enroll its exact scope');
            foreach(authorityRows($db,'SELECT email_id FROM clawpilot_email_identities WHERE pipeline_id=? ORDER BY email_id',[$pipeline]) as $row){
                $rights=nativeRoleSurfaces($row['email_id'],$target);
                must($rights['view']&&$rights['list']&&$rights['export']&&!$rights['edit']&&!$rights['delete'],'First linked account stays a native historical viewer');
            }
            must(authorityContent($db)===$content,'First link must not create rename or edit native Users/content/roles');
            $futureEmail=$publish('first-existing-account','gi8940091');$rights=nativeRoleSurfaces($futureEmail,$target);
            must($rights['view']&&$rights['list']&&$rights['export']&&!$rights['edit']&&!$rights['delete'],'First linked account stays a native future viewer');
            // Supported native revoke/grant restores the prior reader audience
            // for the later independent role cases. No native User is removed.
            selectUser($admin);$_REQUEST=[];$cleanup=hash('sha256','synthetic-first-existing-account-cleanup');
            $deleted=$member;$deleted['deleted']='1';
            $loss=authorityV2Command($db,$profile,'revoke',[['before'=>$member,'after'=>$deleted]],$cleanup);
            authorityApprove($db,$loss,(string)$admin->id,(string)$client->id);$service->execute($loss);
            $finish=authorityV2Command($db,$profile,'grant',[],$cleanup);
            authorityApprove($db,$finish,(string)$admin->id,(string)$client->id);$service->execute($finish);
            must(!nativeRoleSurfaces($history,$target)['view']&&!nativeRoleSurfaces($futureEmail,$target)['view'],'Exact native revocation must also cover the newly created Email');
            fwrite(STDOUT,"NATIVE_FIRST_IDENTITY_MANAGED_SCOPE_PASSED=1\n");
        });
        // This independent role phase starts from the restored, now-managed
        // baseline, including its retained membership tombstone/new Email.
        selectUser($admin);$_REQUEST=[];$content=authorityContent($db);$members=authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id');
        $revoke=nativeRoleCommand($db,$profile,$pipeline,$viewer,'viewer','editor','revoke',$transition);
    }
    authorityApprove($db,$revoke,(string)$admin->id,(string)$client->id);$service->execute($revoke);
    must(!nativeRoleSurfaces($history,$viewer)['edit'],'Promotion revoke must not grant native writes before app commit');
    selectUser($admin);$_REQUEST=[];
    $grant=nativeRoleCommand($db,$profile,$pipeline,$viewer,'viewer','editor','grant',$transition);
    authorityApprove($db,$grant,(string)$admin->id,(string)$client->id);$service->execute($grant);
    check('actual native retained viewer promotion changes historical edit/delete only after authenticated grant',function()use($history,$viewer):void{
        must(nativeRoleSurfaces($history,$viewer)===array_fill_keys(ClawPilotNativeEmailAuthorityContract::SURFACES,true),'Native viewer must become exact scoped editor');
    });
    check('managed registry retains the exact full signed command hash on every historical row',function()use($db,$grant,$pipeline):void{
        $hash=ClawPilotNativeEmailAuthorityContract::digest($grant);
        $rows=authorityRows($db,'SELECT operation_id,command_hash FROM clawpilot_email_write_permissions WHERE pipeline_id=?',[$pipeline]);
        must(count($rows)>0,'Managed historical registry must be populated');
        foreach($rows as $row)must($row['operation_id']===$grant['operationId']&&$row['command_hash']===$hash,'Every row must retain the same full approved command hash');
    });
    check('prepared native group queries read current rows on every call and preserve ordinary and strict-rights paths',function()use($db,$profile,$history,$viewer):void{
        $identities=authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id');
        selectUser(fresh('Users',$viewer));
        must(ClawPilotNativeEmailWriteReadFrame::groupAccess($db,'Emails',$history,$viewer,'view')===null,
            'Ordinary native requests must retain the original SQL path');
        $present=array_key_exists('securitysuite_strict_rights',$GLOBALS['sugar_config']);
        $original=$GLOBALS['sugar_config']['securitysuite_strict_rights']??null;
        $GLOBALS['sugar_config']['securitysuite_strict_rights']=true;$strict=[];
        foreach(ClawPilotNativeEmailAuthorityContract::SURFACES as $surface)$strict[$surface]=SecurityGroup::groupHasAccess('Emails',$history,$surface);
        $GLOBALS['sugar_config']['securitysuite_strict_rights']=false;
        $membership=authorityRows($db,"SELECT m.id FROM securitygroups_users m JOIN securitygroups_records r
            ON r.securitygroup_id=m.securitygroup_id AND r.record_id=? AND r.module='Emails' AND r.deleted=0
            WHERE m.user_id=? AND m.deleted=0",[$history,$viewer]);
        must(count($membership)===1,'One exact existing native group membership required');
        $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
        try{
            ClawPilotNativeEmailWriteReadFrame::within($tx,$identities,function()use($db,$history,$viewer,$membership,$strict):array{
                must(SecurityGroup::groupHasAccess('Emails',$history,'view'),'Fresh prepared read must see the real membership');
                $active=(new ReflectionProperty(ClawPilotNativeEmailWriteReadFrame::class,'active'))->getValue();
                must((new ReflectionProperty($active,'groupStatement'))->getValue($active) instanceof mysqli_stmt,
                    'This probe must actually exercise the prepared statement, not the stock fallback');
                authorityWrite($db,'UPDATE securitygroups_users SET deleted=1 WHERE id=?',[$membership[0]['id']]);
                must(!SecurityGroup::groupHasAccess('Emails',$history,'view'),'No group decision/result may be cached across calls');
                authorityWrite($db,'UPDATE securitygroups_users SET deleted=0 WHERE id=?',[$membership[0]['id']]);
                must(SecurityGroup::groupHasAccess('Emails',$history,'view'),'Fresh execution must see same-connection restoration');
                must(ClawPilotNativeEmailWriteReadFrame::groupAccess($db,'Accounts',$history,$viewer,'view')===null,
                    'Another module must never use the Email-only prepared path');
                $GLOBALS['sugar_config']['securitysuite_strict_rights']=true;
                foreach(ClawPilotNativeEmailAuthorityContract::SURFACES as $surface){
                    must(ClawPilotNativeEmailWriteReadFrame::groupAccess($db,'Emails',$history,$viewer,$surface)===null,
                        'Strict rights must delegate to unchanged native SQL');
                    must(SecurityGroup::groupHasAccess('Emails',$history,$surface)===$strict[$surface],
                        'Every strict native action must match its independent unframed result');
                }
                $GLOBALS['sugar_config']['securitysuite_strict_rights']=false;return [];
            });
            must(ClawPilotNativeEmailWriteReadFrame::groupAccess($db,'Emails',$history,$viewer,'view')===null,
                'The prepared path must not escape its completed frame');
        }finally{
            $tx->rollback();
            if($present)$GLOBALS['sugar_config']['securitysuite_strict_rights']=$original;
            else unset($GLOBALS['sugar_config']['securitysuite_strict_rights']);
        }
    });
    check('fenced metadata capture matches fresh native ACLs and rejects in-pass mutations without leaking its frame',function()use($db,$profile,$service,$history,$viewer):void{
        $identities=authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id');
        $users=authorityRows($db,'SELECT id FROM users WHERE deleted=0 ORDER BY id');
        $expected=[];foreach(authorityMatrix($db) as $entry)$expected[$entry['emailId']]=$entry['capabilities'];
        $read=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'readCapabilities');
        $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
        try{
            $actual=$read->invoke($service,$identities,$users,$tx);
            must(ClawPilotNativeEmailAuthorityContract::canonical($actual)===ClawPilotNativeEmailAuthorityContract::canonical($expected),
                'Fenced raw-metadata capture must reproduce every fresh native principal and action');
            $denied=false;
            try{ClawPilotNativeEmailWriteReadFrame::within($tx,$identities,function()use($db,$history,$viewer):array{
                authorityWrite($db,'UPDATE clawpilot_email_write_permissions SET capabilities_json=? WHERE email_id=?',['{}',$history]);
                return nativeRoleSurfaces($history,$viewer);
            });}catch(SuiteCRM\Exception\AccessDeniedException $error){$denied=true;}
            must($denied,'Same-connection metadata drift must discard the whole captured ACL result');
            must(!nativeRoleSurfaces($history,$viewer)['edit'],'Exception cleanup must restore fresh reads rather than retaining a privileged frame');
        }finally{$tx->rollback();}
        must(nativeRoleSurfaces($history,$viewer)['edit'],'Rollback and frame cleanup must recover the exact approved editor policy');
    });
    check('corrupt managed write metadata denies access and cannot masquerade as an intentionally empty native writer matrix',function()use($db,$history,$viewer):void{
        $permission=authorityRows($db,'SELECT * FROM clawpilot_email_write_permissions WHERE email_id=?',[$history])[0];
        $identity=authorityRows($db,'SELECT * FROM clawpilot_email_identities WHERE email_id=?',[$history])[0];
        authorityWrite($db,'UPDATE clawpilot_email_write_permissions SET capabilities_json=? WHERE email_id=?',['{}',$history]);
        try {
            must(!nativeRoleSurfaces($history,$viewer)['edit'],'Malformed registry may not allow writes');
            authorityRefused(fn()=>ClawPilotNativeEmailWriteScope::assertIdentity($db,$identity),'write_scope_preimage');
            authorityRefused(fn()=>ClawPilotNativeEmailWriteScope::assertIdentities($db,authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id')),'write_scope_preimage');
        }finally{authorityWrite($db,'UPDATE clawpilot_email_write_permissions SET capabilities_json=? WHERE email_id=?',[$permission['capabilities_json'],$history]);}
    });
    check('an explicit native module denial wins even over matching managed permission rows',function()use($db,$history):void{
        $denied=authorityRows($db,"SELECT id FROM users WHERE user_name='fixture-installed-service-one' AND deleted=0")[0]['id'];
        $permission=authorityRows($db,'SELECT * FROM clawpilot_email_write_permissions WHERE email_id=?',[$history])[0];
        $identity=authorityRows($db,'SELECT * FROM clawpilot_email_identities WHERE email_id=?',[$history])[0];
        $forged=json_decode($permission['capabilities_json'],true,16,JSON_THROW_ON_ERROR);
        foreach($forged as &$ids){$ids[]=$denied;$ids=array_values(array_unique($ids));sort($ids,SORT_STRING);}unset($ids);
        $json=ClawPilotNativeEmailAuthorityContract::canonical($forged);
        authorityWrite($db,'UPDATE clawpilot_email_write_permissions SET capabilities_json=? WHERE email_id=?',[$json,$history]);
        authorityWrite($db,'UPDATE clawpilot_email_identities SET capabilities_json=? WHERE email_id=?',[$json,$history]);
        try{must(!nativeRoleSurfaces($history,$denied)['edit'],'Managed metadata cannot bypass explicit native denial');}
        finally{
            authorityWrite($db,'UPDATE clawpilot_email_write_permissions SET capabilities_json=? WHERE email_id=?',[$permission['capabilities_json'],$history]);
            authorityWrite($db,'UPDATE clawpilot_email_identities SET capabilities_json=? WHERE email_id=?',[$identity['capabilities_json'],$history]);
        }
    });
    check('missing managed permission rows fail closed rather than falling back to native owner rights',function()use($db,$history,$admin):void{
        $permission=authorityRows($db,'SELECT * FROM clawpilot_email_write_permissions WHERE email_id=?',[$history])[0];
        $identity=authorityRows($db,'SELECT * FROM clawpilot_email_identities WHERE email_id=?',[$history])[0];
        authorityWrite($db,'DELETE FROM clawpilot_email_write_permissions WHERE email_id=?',[$history]);
        try{
            must(!nativeRoleSurfaces($history,(string)$admin->id)['edit'],'Missing managed permission may not fall back to otherwise valid owner writes');
            authorityRefused(fn()=>ClawPilotNativeEmailWriteScope::assertIdentity($db,$identity),'write_scope_identity_missing');
            authorityRefused(fn()=>ClawPilotNativeEmailWriteScope::assertIdentities($db,authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id')),'write_scope_identity_missing');
        }finally{
            authorityWrite($db,'INSERT INTO clawpilot_email_write_permissions(email_id,pipeline_id,capabilities_json,source_kind,operation_id,command_hash) VALUES(?,?,?,?,?,?)',
                [$permission['email_id'],$permission['pipeline_id'],$permission['capabilities_json'],$permission['source_kind'],$permission['operation_id'],$permission['command_hash']]);
        }
    });
    check('complete managed inventory refuses orphan permission rows rather than silently pruning them',function()use($db,$history):void{
        $permission=authorityRows($db,'SELECT * FROM clawpilot_email_write_permissions WHERE email_id=?',[$history])[0];
        $orphan=create_guid();
        authorityWrite($db,'INSERT INTO clawpilot_email_write_permissions(email_id,pipeline_id,capabilities_json,source_kind,operation_id,command_hash) VALUES(?,?,?,?,?,?)',
            [$orphan,$permission['pipeline_id'],$permission['capabilities_json'],$permission['source_kind'],$permission['operation_id'],$permission['command_hash']]);
        try{authorityRefused(fn()=>ClawPilotNativeEmailWriteScope::assertIdentities($db,
            authorityRows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id')),'write_scope_orphan_identity');}
        finally{authorityWrite($db,'DELETE FROM clawpilot_email_write_permissions WHERE email_id=?',[$orphan]);}
    });
    selectUser($admin);$_REQUEST=[];must(authorityContent($db)===$content,'Role promotion must preserve every native content, ownership and role row');
    $newWhileEditor=$publish('promoted','gi8971001');
    check('future native publication inherits the explicitly granted editor policy',function()use($newWhileEditor,$viewer):void{
        must(nativeRoleSurfaces($newWhileEditor,$viewer)['edit'],'New Email must honor approved editor policy');
        nativeRoleV8Save($newWhileEditor,$viewer,'Synthetic promoted editor native V8 save');
        must(fresh('Emails',$newWhileEditor)->name==='Synthetic promoted editor native V8 save','Actual V8 save alias must honor the approved editor');
    });
    selectUser($admin);$_REQUEST=[];$transition=hash('sha256','synthetic-native-retained-demotion');
    $revoke=nativeRoleCommand($db,$profile,$pipeline,$viewer,'editor','viewer','revoke',$transition);
    authorityApprove($db,$revoke,(string)$admin->id,(string)$client->id);$service->execute($revoke);
    check('actual native demotion revokes historical and newly created writes before app role change while preserving reads',function()use($history,$newWhileEditor,$viewer):void{
        foreach([$history,$newWhileEditor] as $email)must(nativeRoleSurfaces($email,$viewer)===['view'=>true,'list'=>true,'export'=>true,'edit'=>false,'delete'=>false],
            'Demotion must preserve reads and immediately remove both native write surfaces');
        $bean=fresh('Emails',$newWhileEditor);
        foreach(['save','editview','popupeditview','SAVE'] as $alias)must(!$bean->ACLAccess($alias,true,true),'No write alias or owner hint may bypass demotion');
        $denied=false;try{nativeRoleV8Save($newWhileEditor,$viewer,'Denied role save must not change content');}
        catch(SuiteCRM\Exception\AccessDeniedException $error){$denied=true;}
        must($denied && fresh('Emails',$newWhileEditor)->name==='Synthetic promoted editor native V8 save','Actual native V8 update must deny without changing the Email');
    });
    selectUser($admin);$_REQUEST=[];$grant=nativeRoleCommand($db,$profile,$pipeline,$viewer,'editor','viewer','grant',$transition);
    authorityApprove($db,$grant,(string)$admin->id,(string)$client->id);$service->execute($grant);
    $newWhileViewer=$publish('demoted','gi8971002');
    check('future native publication after demotion cannot restore write rights',function()use($newWhileViewer,$viewer):void{
        must(nativeRoleSurfaces($newWhileViewer,$viewer)===['view'=>true,'list'=>true,'export'=>true,'edit'=>false,'delete'=>false],'Future policy must remain viewer-only');
    });
    selectUser($admin);$_REQUEST=[];
    must(authorityRows($db,'SELECT * FROM securitygroups_users ORDER BY id')===$members,'Retained role transition must never remove/re-add native members');
    fwrite(STDOUT,'NATIVE_MANAGED_ROLE_EXECUTION_PASSED=1' . "\n");

    // Separate membership/access cycle: the wire emitted for an initial app
    // CRM grant must provide reads without inventing historical/future writes.
    // App admission and commit proofs here remain synthetic; native ACLs,
    // group changes, approvals, receipts, publication and V8 denial are real.
    $b=authorityRows($db,'SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=?',[$pipeline])[0];
    $future=json_decode($b['capability_policy_json'],true,32,JSON_THROW_ON_ERROR)['futureCreate'];
    $membership=authorityRows($db,'SELECT * FROM securitygroups_users WHERE securitygroup_id=? AND user_id=? AND deleted=0',[$b['group_id'],$viewer]);
    must(count($membership)===1,'Read grant fixture requires one exact current membership');
    $before=ClawPilotNativeEmailAuthorityDelta::nativeRow($membership[0]);$deleted=$before;$deleted['deleted']='1';$deleted['date_modified']='2026-10-30 15:00:00';
    $accessTransition=hash('sha256','synthetic-native-read-access-grant');
    $accessRevoke=authorityV2Command($db,$profile,'revoke',[['before'=>$before,'after'=>$deleted]],$accessTransition);
    authorityApprove($db,$accessRevoke,(string)$admin->id,(string)$client->id);$service->execute($accessRevoke);
    check('native read-access grant retains complete denial before the app commit proof',function()use($history,$viewer):void{
        must(nativeRoleSurfaces($history,$viewer)===['view'=>false,'list'=>false,'export'=>false,'edit'=>false,'delete'=>false],
            'Revoked reader must have no native access while app commit is unconfirmed');
    });
    selectUser($admin);$_REQUEST=[];$restored=$deleted;$restored['deleted']='0';$restored['date_modified']='2026-10-30 15:00:01';
    $accessGrant=authorityV2Command($db,$profile,'grant',[['before'=>$deleted,'after'=>$restored]],$accessTransition,[$pipeline=>$future]);
    authorityApprove($db,$accessGrant,(string)$admin->id,(string)$client->id);$service->execute($accessGrant);
    $newAfterAccess=$publish('read-access-grant','gi8971003');
    check('actual native read-access grant restores reads but not historical or future writes',function()use($history,$newWhileEditor,$newWhileViewer,$newAfterAccess,$viewer):void{
        foreach([$history,$newWhileEditor,$newWhileViewer,$newAfterAccess] as $email){
            must(nativeRoleSurfaces($email,$viewer)===['view'=>true,'list'=>true,'export'=>true,'edit'=>false,'delete'=>false],
                'Explicit read grant cannot invent edit/delete rights on any historical or future Email');
            $denied=false;try{nativeRoleV8Save($email,$viewer,'Read grant must not allow native writes');}
            catch(SuiteCRM\Exception\AccessDeniedException $error){$denied=true;}
            must($denied,'Actual native V8 update must remain forbidden after a read-only access grant');
        }
    });
    selectUser($admin);$_REQUEST=[];
    fwrite(STDOUT,'NATIVE_MANAGED_READ_ACCESS_GRANT_PASSED=1' . "\n");
}
