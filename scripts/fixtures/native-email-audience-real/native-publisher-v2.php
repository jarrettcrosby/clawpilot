<?php
declare(strict_types=1);
// Actual SuiteCRM + MariaDB only. No provider access or production enrollment.
if(PHP_SAPI!=='cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION')!=='1')throw new RuntimeException('Disposable native fixture required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/source/email-audience/NativeEmailPublisher.php';

function v2Rows(mysqli $db,string $sql,array $params=[]):array {
    $s=$db->prepare($sql);try{if($params)$s->bind_param(str_repeat('s',count($params)),...$params);$s->execute();return $s->get_result()->fetch_all(MYSQLI_ASSOC);}finally{$s->close();}
}
function v2Write(mysqli $db,string $sql,array $params=[]):void {
    $s=$db->prepare($sql);try{if($params)$s->bind_param(str_repeat('s',count($params)),...$params);must($s->execute(),'Synthetic bounded setup write failed');}finally{$s->close();}
}
function v2Snapshot(mysqli $db,array $profile,string $id):array {
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);try{return ClawPilotNativeEmailProjection::snapshot($db,$tx,$id);}finally{$tx->rollback();}
}
function v2Policy(mysqli $db,array $profile):string {
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);try{return $tx->immutablePolicyFingerprint();}finally{$tx->rollback();}
}
function v2FutureHash(array $policy):string {$future=$policy;unset($future['historical']);return ClawPilotNativeEmailPublisher::digest($future);}
function v2Denied(callable $call):void {
    try{$call();}catch(ClawPilotNativeEmailTransactionRefused $error){return;}
    throw new RuntimeException('Expected native v2 refusal');
}
function v2Surface(string $id,string $user):array {
    $prior=$GLOBALS['current_user'];$session=$_SESSION??[];
    try{$u=fresh('Users',$user);selectUser($u);$email=fresh('Emails',$id);$result=[];
        foreach(ClawPilotNativeEmailCapabilityContract::SURFACES as $surface)$result[$surface]=(bool)$email->ACLAccess($surface);return $result;
    }finally{$GLOBALS['current_user']=$prior;$_SESSION=$session;}
}

(static function():void {
try {
    $_REQUEST=[];$db=DBManagerFactory::getInstance()->database;
    $profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'];
    must(realpath('.')==='/app/public/legacy' && ($GLOBALS['sugar_config']['dbconfig']['db_name']??'')==='suitecrm_native_test','Exact synthetic database required');
    $admin=fresh('Users',rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0")[0]['id']);selectUser($admin);
    $editor=rows("SELECT id FROM users WHERE user_name='fixture-installed-blank-status-unroled' AND deleted=0")[0]['id'];
    $viewer=rows("SELECT id FROM users WHERE user_name='fixture-publisher-viewer' AND deleted=0")[0]['id'];
    $outsider=rows("SELECT id FROM users WHERE user_name='fixture-installed-service-one' AND deleted=0")[0]['id'];
    $roleBefore=v2Rows($db,'SELECT * FROM acl_roles_actions ORDER BY id');
    $readers=[(string)$admin->id,$editor,$viewer];sort($readers,SORT_STRING);
    $writers=[(string)$admin->id,$editor];sort($writers,SORT_STRING);
    $matrix=['view'=>$readers,'list'=>$readers,'export'=>$readers,'edit'=>$writers,'delete'=>$writers];
    $group=native('SecurityGroups');$group->name='Synthetic v2 explicitly preserved editor';$group->noninheritable=1;$group->save(false);
    linkBeans($group,'users',$readers);v2Write($db,'UPDATE securitygroups_users SET noninheritable=1 WHERE securitygroup_id=?',[(string)$group->id]);
    $history=emailFixture('Synthetic v2 reviewed history','gi8950001',(string)$admin->id);
    $group->addGroupToRecord('Emails',(string)$history->id,(string)$group->id);
    $pipeline=create_guid();$workspace=create_guid();$localHistory=create_guid();
    $audience=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>(string)$admin->id,
        'allowedSuiteCrmUserIds'=>$readers,'workspaceId'=>$workspace,'pipelineId'=>$pipeline],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
    $principals=array_column(v2Rows($db,'SELECT id FROM users WHERE deleted=0 ORDER BY id'),'id');
    $capabilityPolicy=['version'=>2,'pipelineId'=>$pipeline,'workspaceId'=>$workspace,'ownerSuiteCrmId'=>(string)$admin->id,
        'audienceFingerprint'=>$audience,'principalSuiteCrmUserIds'=>$principals,'futureCreate'=>$matrix,'historical'=>[]];
    $futureHash=v2FutureHash($capabilityPolicy);$policy=v2Policy($db,$profile);$runtime=ClawPilotNativeEmailRuntime::attest($db);
    v2Write($db,'INSERT INTO clawpilot_email_bindings(pipeline_id,workspace_id,group_id,generation,owner_id,readers_json,audience_fingerprint,policy_fingerprint,runtime_fingerprint,enabled,capability_policy_json,capability_policy_fingerprint)
        VALUES(?,?,?,1,?,?,?,?,?,1,?,?)',[$pipeline,$workspace,(string)$group->id,(string)$admin->id,json_encode($readers),$audience,$policy,$runtime,json_encode($capabilityPolicy),$futureHash]);
    // Explicit reviewed historical enrollment, not rights inferred by publisher.
    v2Write($db,'INSERT INTO clawpilot_email_identities(email_id,global_id,local_id,pipeline_id,workspace_id,app_archived,capabilities_json) VALUES(?,?,?,?,?,1,?)',
        [(string)$history->id,'gi8950001',$localHistory,$pipeline,$workspace,json_encode($matrix)]);
    $handoff=json_decode((string)file_get_contents('/tmp/native-publisher-race.json'),true,48,JSON_THROW_ON_ERROR);
    $projection=$handoff['command']['projection'];$projection['attributes']['assigned_user_id']=(string)$admin->id;
    $make=static function(string $tag,string $global,?string $id=null,?string $local=null)use($workspace,$pipeline,$audience,$futureHash,$principals,$matrix,$projection):array {
        $p=$projection;$p['attributes']['global_id_c']=$global;$p['attributes']['name']='Synthetic v2 '.$tag;
        return ['version'=>2,'operationId'=>hash('sha256','v2-'.$tag),'mode'=>'publish','workspaceId'=>$workspace,'pipelineId'=>$pipeline,
            'generation'=>1,'audienceFingerprint'=>$audience,'suiteCrmId'=>$id??create_guid(),'globalId'=>$global,'localId'=>$local??create_guid(),
            'expectedRecordFingerprint'=>null,'projection'=>$p,'capabilityPolicyFingerprint'=>$futureHash,'principalSuiteCrmUserIds'=>$principals,'expectedCapabilities'=>$matrix];
    };
    $publisher=new ClawPilotNativeEmailPublisher($db,$profile,(string)$admin->id);$wire=[];
    $record=static function(array $command,array $receipt,?array $preparation=null)use(&$wire,$policy,$readers):void {
        $entry=['input'=>['command'=>$command,'nativePolicyFingerprint'=>$policy,'allowedReaderSuiteCrmUserIds'=>$readers],'receipt'=>$receipt];
        if($preparation!==null)$entry['preparation']=$preparation;$wire[]=$entry;
    };
    $repair=$make('historical-repair','gi8950001',(string)$history->id,$localHistory);$repair['mode']='repair';$repair['projection']=null;
    $repair['expectedRecordFingerprint']=v2Snapshot($db,$profile,(string)$history->id)['fingerprint'];
    check('v2 historical repair preserves every existing editor right and archived content',function()use($publisher,$repair,$db,$profile,$record,$editor,$viewer,$outsider):void {
        $before=v2Snapshot($db,$profile,$repair['suiteCrmId']);$preparation=$publisher->prepare($repair);$receipt=$publisher->publish($repair);
        must($receipt['version']===2 && $receipt['state']==='committed' && $receipt['result']['expectedCapabilities']===$repair['expectedCapabilities'],'Actual v2 repair receipt required');
        must(v2Snapshot($db,$profile,$repair['suiteCrmId'])===$before,'Repair must preserve native content byte-for-byte');
        must((int)v2Rows($db,'SELECT app_archived FROM clawpilot_email_identities WHERE email_id=?',[$repair['suiteCrmId']])[0]['app_archived']===1,'Repair must preserve archived state');
        must(v2Surface($repair['suiteCrmId'],$editor)===array_fill_keys(ClawPilotNativeEmailCapabilityContract::SURFACES,true),'Existing GROUP editor must retain all five surfaces');
        must(v2Surface($repair['suiteCrmId'],$viewer)===['view'=>true,'list'=>true,'export'=>true,'edit'=>false,'delete'=>false],'Viewer must not become writer');
        must(v2Surface($repair['suiteCrmId'],$outsider)===array_fill_keys(ClawPilotNativeEmailCapabilityContract::SURFACES,false),'Outsider must remain denied');
        $record($repair,$receipt,$preparation);
    });
    $create=$make('future-create','gi8950002');
    check('v2 create atomically enrolls explicit future rights and emits exact preparation and native readback',function()use($publisher,$create,$db,$record):void {
        $preparation=$publisher->prepare($create);must($preparation['version']===2 && $preparation['expectedRecordFingerprint']===null,'Actual create preparation required');
        foreach(['capabilityPolicyFingerprint','principalSuiteCrmUserIds','expectedCapabilities'] as $key)must($preparation[$key]===$create[$key],'Preparation must retain every v2 authority pin');
        $receipt=$publisher->publish($create);must($receipt['state']==='committed' && $receipt['result']['version']===2,'Actual v2 create commit required');
        $identity=v2Rows($db,'SELECT capabilities_json FROM clawpilot_email_identities WHERE email_id=?',[$create['suiteCrmId']]);
        must(count($identity)===1 && json_decode($identity[0]['capabilities_json'],true)===$create['expectedCapabilities'],'Future identity must persist exact explicit capabilities');
        $record($create,$receipt,$preparation);
    });
    $update=$create;$update['operationId']=hash('sha256','v2-future-update');$update['expectedRecordFingerprint']=v2Snapshot($db,$profile,$create['suiteCrmId'])['fingerprint'];
    $update['projection']['attributes']['name']='Synthetic v2 updated subject';$update['projection']['attributes']['description']='Exact updated plain content';
    check('v2 existing publication verifies before and after rights without narrowing the legitimate editor',function()use($publisher,$update,$record,$db,$editor,$viewer):void {
        $before=v2Rows($db,'SELECT capabilities_json FROM clawpilot_email_identities WHERE email_id=?',[$update['suiteCrmId']]);
        $preparation=$publisher->prepare($update);$receipt=$publisher->publish($update);
        must($receipt['state']==='committed' && v2Rows($db,'SELECT description FROM emails_text WHERE email_id=?',[$update['suiteCrmId']])[0]['description']===$update['projection']['attributes']['description'],'Actual content update required');
        must(v2Rows($db,'SELECT capabilities_json FROM clawpilot_email_identities WHERE email_id=?',[$update['suiteCrmId']])===$before,'Existing immutable capability pin must not be rewritten');
        must(v2Surface($update['suiteCrmId'],$editor)['edit'] && !v2Surface($update['suiteCrmId'],$viewer)['edit'],'Explicit mixed rights must survive update');
        $record($update,$receipt,$preparation);
    });
    check('v2 committed replay and historical resolution retain exact result and do not resave',function()use($publisher,$update,$db,$profile,$record):void {
        $before=v2Snapshot($db,$profile,$update['suiteCrmId']);$replay=$publisher->publish($update);$resolved=$publisher->resolveOrCancel($update);
        must($replay['replayed'] && $resolved['state']==='committed' && $resolved['result']===$replay['result'],'Exact committed result required');
        must(v2Snapshot($db,$profile,$update['suiteCrmId'])===$before,'Replay may not alter timestamps');$record($update,$resolved);
    });
    $cancel=$make('cancelled-before-create','gi8950003');
    check('v2 cancellation and late publication retain versioned durable tombstone',function()use($publisher,$cancel,$record,$db):void {
        $receipt=$publisher->resolveOrCancel($cancel);$late=$publisher->publish($cancel);
        must($receipt['version']===2 && $receipt['state']==='cancelled' && $late['replayed'] && $late['state']==='cancelled','V2 terminal tombstone required');
        must(v2Rows($db,'SELECT id FROM emails WHERE id=?',[$cancel['suiteCrmId']])===[] && v2Rows($db,'SELECT email_id FROM clawpilot_email_identities WHERE email_id=?',[$cancel['suiteCrmId']])===[],'Cancellation may not enroll or create');
        $record($cancel,$receipt);$record($cancel,$late);
    });
    check('v2 rejects changed policy principal inventory rights and fresh v1 downgrade before any native write',function()use($publisher,$make,$db,$profile,$editor):void {
        $base=$make('invalid-pins','gi8950004');$cases=[];
        $bad=$base;$bad['capabilityPolicyFingerprint']=str_repeat('0',64);$cases[]=$bad;
        $bad=$base;$bad['principalSuiteCrmUserIds']=array_values(array_filter($bad['principalSuiteCrmUserIds'],static fn($id)=>$id!==$editor));$cases[]=$bad;
        $bad=$base;$bad['expectedCapabilities']['edit']=array_values(array_filter($bad['expectedCapabilities']['edit'],static fn($id)=>$id!==$editor));$cases[]=$bad;
        $bad=$base;$bad['expectedCapabilities']['list']=[];$cases[]=$bad;
        $bad=$base;$bad['version']=1;unset($bad['capabilityPolicyFingerprint'],$bad['principalSuiteCrmUserIds'],$bad['expectedCapabilities']);$cases[]=$bad;
        foreach($cases as $index=>$bad) {
            $bad['operationId']=hash('sha256','v2-invalid-'.$index);$before=v2Snapshot($db,$profile,$bad['suiteCrmId']);
            v2Denied(fn()=>$publisher->prepare($bad));v2Denied(fn()=>$publisher->publish($bad));
            must(v2Snapshot($db,$profile,$bad['suiteCrmId'])===$before && v2Rows($db,'SELECT operation_id FROM clawpilot_email_operations WHERE operation_id=?',[$bad['operationId']])===[],'Invalid pins must not mutate');
        }
    });
    check('v2 missing and unexpected effective rights roll back native create identity and receipt',function()use($publisher,$make,$db,$pipeline,$capabilityPolicy,$futureHash,$viewer,$editor):void {
        foreach(['missing','unexpected'] as $kind) {
            $policy=$capabilityPolicy;
            if($kind==='missing'){$policy['futureCreate']['edit'][]=$viewer;sort($policy['futureCreate']['edit'],SORT_STRING);}
            else $policy['futureCreate']['edit']=array_values(array_filter($policy['futureCreate']['edit'],static fn($id)=>$id!==$editor));
            $command=$make('readback-'.$kind,$kind==='missing'?'gi8950005':'gi8950006');$command['expectedCapabilities']=$policy['futureCreate'];$command['capabilityPolicyFingerprint']=v2FutureHash($policy);
            v2Write($db,'UPDATE clawpilot_email_bindings SET capability_policy_json=?,capability_policy_fingerprint=? WHERE pipeline_id=?',[json_encode($policy),$command['capabilityPolicyFingerprint'],$pipeline]);
            try{v2Denied(fn()=>$publisher->publish($command));}finally{v2Write($db,'UPDATE clawpilot_email_bindings SET capability_policy_json=?,capability_policy_fingerprint=? WHERE pipeline_id=?',[json_encode($capabilityPolicy),$futureHash,$pipeline]);}
            foreach(['emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c','clawpilot_email_identities'=>'email_id'] as $table=>$column)
                must(v2Rows($db,'SELECT * FROM '.$table.' WHERE '.$column.'=?',[$command['suiteCrmId']])===[],'Failed effective capability check must roll back all native rows');
            must(v2Rows($db,'SELECT operation_id FROM clawpilot_email_operations WHERE operation_id=?',[$command['operationId']])===[],'Failed readback may not claim commit');
        }
    });
    check('v2 historical repair refuses write-right downgrade even when malformed enrollment requests it',function()use($publisher,$repair,$db,$profile,$editor):void {
        $bad=$repair;$bad['operationId']=hash('sha256','v2-repair-cannot-downgrade');
        $bad['expectedCapabilities']['edit']=array_values(array_filter($bad['expectedCapabilities']['edit'],static fn($id)=>$id!==$editor));
        $original=v2Rows($db,'SELECT capabilities_json FROM clawpilot_email_identities WHERE email_id=?',[$bad['suiteCrmId']])[0]['capabilities_json'];
        $before=v2Snapshot($db,$profile,$bad['suiteCrmId']);
        v2Write($db,'UPDATE clawpilot_email_identities SET capabilities_json=? WHERE email_id=?',[json_encode($bad['expectedCapabilities']),$bad['suiteCrmId']]);
        try{v2Denied(fn()=>$publisher->publish($bad));}finally{v2Write($db,'UPDATE clawpilot_email_identities SET capabilities_json=? WHERE email_id=?',[$original,$bad['suiteCrmId']]);}
        must(v2Snapshot($db,$profile,$bad['suiteCrmId'])===$before && v2Rows($db,'SELECT operation_id FROM clawpilot_email_operations WHERE operation_id=?',[$bad['operationId']])===[],'Write-right mismatch must not alter history or claim success');
    });
    check('v2 requires reviewed historical capabilities and detects stored policy drift',function()use($publisher,$repair,$db,$pipeline,$capabilityPolicy,$futureHash):void {
        $bad=$repair;$bad['operationId']=hash('sha256','v2-no-historical-enrollment');
        $original=v2Rows($db,'SELECT capabilities_json FROM clawpilot_email_identities WHERE email_id=?',[$bad['suiteCrmId']])[0]['capabilities_json'];
        v2Write($db,'UPDATE clawpilot_email_identities SET capabilities_json=NULL WHERE email_id=?',[$bad['suiteCrmId']]);
        try{v2Denied(fn()=>$publisher->prepare($bad));v2Denied(fn()=>$publisher->publish($bad));}finally{v2Write($db,'UPDATE clawpilot_email_identities SET capabilities_json=? WHERE email_id=?',[$original,$bad['suiteCrmId']]);}
        v2Write($db,'UPDATE clawpilot_email_bindings SET capability_policy_fingerprint=? WHERE pipeline_id=?',[str_repeat('f',64),$pipeline]);
        try{v2Denied(fn()=>$publisher->prepare($bad));v2Denied(fn()=>$publisher->publish($bad));}finally{v2Write($db,'UPDATE clawpilot_email_bindings SET capability_policy_fingerprint=? WHERE pipeline_id=?',[$futureHash,$pipeline]);}
    });
    check('v2 historical resolver answers committed truth after current capability policy drift',function()use($publisher,$update,$db,$pipeline,$futureHash,$record):void {
        v2Write($db,'UPDATE clawpilot_email_bindings SET capability_policy_fingerprint=? WHERE pipeline_id=?',[str_repeat('f',64),$pipeline]);
        try{v2Denied(fn()=>$publisher->publish($update));$receipt=$publisher->resolveOrCancel($update);must($receipt['state']==='committed' && $receipt['replayed'],'Historical outcome must remain resolvable');$record($update,$receipt);}
        finally{v2Write($db,'UPDATE clawpilot_email_bindings SET capability_policy_fingerprint=? WHERE pipeline_id=?',[$futureHash,$pipeline]);}
    });
    check('v1 historical receipt remains resolvable after a binding gains explicit v2 policy',function()use($publisher,$db,$capabilityPolicy):void {
        $old=v2Rows($db,"SELECT o.*,b.capability_policy_json,b.capability_policy_fingerprint FROM clawpilot_email_operations o JOIN clawpilot_email_bindings b ON b.pipeline_id=o.pipeline_id WHERE o.state='committed' AND b.capability_policy_json IS NULL ORDER BY o.operation_id LIMIT 1");
        must(count($old)===1,'Prior genuine v1 receipt required');
        // Use the saved original v1 command, which has a real terminal race outcome.
        $h=json_decode((string)file_get_contents('/tmp/native-publisher-race.json'),true,48,JSON_THROW_ON_ERROR);$command=$h['command'];
        $prior=v2Rows($db,'SELECT state FROM clawpilot_email_operations WHERE operation_id=?',[$command['operationId']]);must(count($prior)===1,'Prior original operation required');
        v2Write($db,'UPDATE clawpilot_email_bindings SET capability_policy_json=?,capability_policy_fingerprint=? WHERE pipeline_id=?',[json_encode($capabilityPolicy),str_repeat('e',64),$command['pipelineId']]);
        try{$receipt=$publisher->resolveOrCancel($command);must($receipt['version']===1 && $receipt['state']===$prior[0]['state'] && $receipt['replayed'],'Old exact terminal receipt must resolve without relabeling');}
        finally{v2Write($db,'UPDATE clawpilot_email_bindings SET capability_policy_json=NULL,capability_policy_fingerprint=NULL WHERE pipeline_id=?',[$command['pipelineId']]);}
    });
    must(v2Rows($db,'SELECT * FROM acl_roles_actions ORDER BY id')===$roleBefore,'Publication fixture must preserve all actual role assignments/actions');
    fwrite(STDOUT,'CLAWPILOT_NATIVE_PUBLICATION_V2_RECEIPTS='.json_encode($wire,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)."\n");
    fwrite(STDOUT,'NATIVE_PUBLICATION_V2_PASSED='.$GLOBALS['checks']."\n");
}catch(Throwable $error){fwrite(STDERR,get_class($error).': '.$error->getMessage()."\n".$error->getTraceAsString()."\n");exit(1);}
})();
