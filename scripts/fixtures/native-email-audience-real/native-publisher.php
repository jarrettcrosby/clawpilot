<?php
declare(strict_types=1);
if (getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1') throw new RuntimeException('Opt-in disposable fixture required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY', true);
require '/fixture/acceptance.php';
require '/source/email-audience/NativeEmailPublisher.php';

function publisherQ(string $s): string { return "'".quote($s)."'"; }
function publisherSql(string $sql): void { must(DBManagerFactory::getInstance()->database->query($sql) === true, 'Checked fixture SQL required'); }
function publisherSnapshot(mysqli $db, array $profile, string $id): array
{
    $tx = ClawPilotNativeEmailTransaction::begin($db, $profile);
    try { return ClawPilotNativeEmailProjection::snapshot($db, $tx, $id); }
    finally { $tx->rollback(); }
}
function publisherCommand(string $operation, string $mode, array $identity, array $binding, ?array $projection, ?string $fingerprint): array
{
    return ['version'=>1,'operationId'=>hash('sha256',$operation),'mode'=>$mode,'workspaceId'=>$binding['workspace'],
        'pipelineId'=>$binding['pipeline'],'generation'=>1,'audienceFingerprint'=>$binding['audience'],
        'suiteCrmId'=>$identity['id'],'globalId'=>$identity['global'],'localId'=>$identity['local'],
        'expectedRecordFingerprint'=>$fingerprint,'projection'=>$projection];
}

// SuiteCRM owns the global $db (a DBManager). Keep our raw mysqli handle
// function-local: native User.save()/CacheManager and other stock hooks still
// require that original global manager, even though we use its connection.
(static function (): void {
try {
    $_REQUEST = [];
    $admin = fresh('Users', rows("SELECT id FROM users WHERE user_name='fixture-admin'")[0]['id']);
    selectUser($admin);
    $db = DBManagerFactory::getInstance()->database;
    $profile = ['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'];
    // Schema/defaults/bindings are installed ONLY in this disposable synthetic
    // database. Production setup remains a separate explicit approval.
    must($db->multi_query((string)file_get_contents('/source/email-audience/publication-schema.sql')), 'Prepared schema must install');
    do { if ($r = $db->store_result()) $r->free(); } while ($db->more_results() && $db->next_result());
    must($db->errno === 0, 'Prepared schema must finish');
    publisherSql("UPDATE acl_actions SET aclaccess=CASE WHEN name IN ('view','list','export') THEN 80 ELSE 75 END WHERE category='Emails' AND acltype='module' AND deleted=0 AND name IN ('view','list','export','edit','delete')");
    // The existing scoped principal intentionally retains GROUP edit/delete
    // on its legitimate historical workspace. Do not silently narrow that role
    // to make a read-only publisher fixture pass. Use a new unroled viewer for
    // this separately scoped pipeline; mixed editor/read-only bindings remain
    // unsupported by this candidate's exact write-access contract.
    $target = userFixture('publisher-viewer');
    $group = native('SecurityGroups'); $group->name = 'Synthetic publisher exact pipeline'; $group->noninheritable=1; $group->save(false);
    $readers = [(string)$admin->id,(string)$target->id]; sort($readers, SORT_STRING);
    linkBeans($group, 'users', $readers);
    publisherSql('UPDATE securitygroups_users SET noninheritable=1 WHERE securitygroup_id='.publisherQ((string)$group->id));
    $historyBean = emailFixture('Existing historical publisher fixture', 'gi8800001', (string)$admin->id);
    $identities = [
        'history'=>['id'=>(string)$historyBean->id,'global'=>'gi8800001','local'=>create_guid()],
        'future'=>['id'=>create_guid(),'global'=>'gi8800002','local'=>create_guid()],
        'cancelled'=>['id'=>create_guid(),'global'=>'gi8800003','local'=>create_guid()],
        'failure'=>['id'=>create_guid(),'global'=>'gi8800004','local'=>create_guid()],
    ];
    $binding = ['workspace'=>create_guid(),'pipeline'=>create_guid()];
    $binding['audience'] = hash('sha256', json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>(string)$admin->id,
        'allowedSuiteCrmUserIds'=>$readers,'workspaceId'=>$binding['workspace'],'pipelineId'=>$binding['pipeline']], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    foreach (['history'=>$identities['history']] as $key=>$identity) publisherSql('INSERT INTO clawpilot_email_identities(email_id,global_id,local_id,pipeline_id,workspace_id,app_archived) VALUES ('.
        implode(',',array_map('publisherQ',[$identity['id'],$identity['global'],$identity['local'],$binding['pipeline'],$binding['workspace']])).','.($key==='history'?'1':'0').')');
    $tx = ClawPilotNativeEmailTransaction::begin($db,$profile);
    $policy = $tx->immutablePolicyFingerprint(); $tx->rollback();
    $runtime = ClawPilotNativeEmailRuntime::attest($db);
    publisherSql('INSERT INTO clawpilot_email_bindings(pipeline_id,workspace_id,group_id,generation,owner_id,readers_json,audience_fingerprint,policy_fingerprint,runtime_fingerprint,enabled) VALUES ('.
        implode(',',array_map('publisherQ',[$binding['pipeline'],$binding['workspace'],(string)$group->id])).',1,'.
        implode(',',array_map('publisherQ',[(string)$admin->id,json_encode($readers),$binding['audience'],$policy,$runtime])).',1)');
    $publisher = new ClawPilotNativeEmailPublisher($db,$profile,(string)$admin->id);
    $historyBefore = publisherSnapshot($db,$profile,$identities['history']['id']);
    $repair = publisherCommand('historical-access-v1','repair',$identities['history'],$binding,null,$historyBefore['fingerprint']);
    check('prepared publisher repairs archived historical access without saving content or changing archive state',function () use ($publisher,$repair,$db,$profile,$historyBefore): void {
        $result = $publisher->publish($repair);
        must($result['state']==='committed' && $result['replayed']===false,'Historical native commit receipt required');
        must(publisherSnapshot($db,$profile,$repair['suiteCrmId'])===$historyBefore,'Historical raw snapshot must be byte-identical');
        must((int)rows('SELECT app_archived FROM clawpilot_email_identities WHERE email_id='.publisherQ($repair['suiteCrmId']))[0]['app_archived']===1,'App archive must remain set');
    });
    $projection = static fn(array $i): array => ['attributes'=>[
        'global_id_c'=>$i['global'],'name'=>'Native publisher future & evidence','date_sent_received'=>'2026-10-30 13:00:00',
        'type'=>'archived','status'=>'read','parent_type'=>'','parent_id'=>'','assigned_user_id'=>(string)$admin->id,
        'description'=>"Exact plain body &amp; <literal>\nSecond line é \u{2028}/",'description_html'=>'',
        'from_addr_name'=>'Sender <sender@fixture.example.test>','to_addrs_names'=>'Recipient <recipient@fixture.example.test>',
        'cc_addrs_names'=>'','bcc_addrs_names'=>'','reply_to_addrs_names'=>'reply@fixture.example.test',
    ],'accounts'=>[],'contacts'=>[],'contactAccounts'=>[],'previousManaged'=>['accounts'=>[],'contacts'=>[]]];
    $future = publisherCommand('future-publish-v1','publish',$identities['future'],$binding,$projection($identities['future']),null);
    $wireReceipt=null;
    check('prepared publisher commits native content exact pipeline access and receipt together',function () use ($publisher,$future,$readers,&$wireReceipt): void {
        must($publisher->prepare($future)['expectedRecordFingerprint']===null,'Read-only create preparation must not invent a historical preimage');
        $result = $wireReceipt = $publisher->publish($future);
        must($result['state']==='committed' && $result['result']['readerSuiteCrmUserIds']===$readers,'Exact native audience readback required');
        must(count(rows('SELECT * FROM clawpilot_email_operations WHERE operation_id='.publisherQ($future['operationId'])))===1,'Durable same-transaction receipt required');
        must(rows('SELECT description FROM emails_text WHERE email_id='.publisherQ($future['suiteCrmId']))[0]['description']===$future['projection']['attributes']['description'],'Exact raw plain body required');
    });
    check('historical and future retries do not create duplicates or change native timestamps',function () use ($publisher,$repair,$future,$db,$profile): void {
        foreach ([$repair,$future] as $command) {
            $before = publisherSnapshot($db,$profile,$command['suiteCrmId']);
            $result = $publisher->publish($command);
            must($result['state']==='committed' && $result['replayed']===true,'Exact retry must replay');
            must(publisherSnapshot($db,$profile,$command['suiteCrmId'])===$before,'Retry must not touch content/timestamps');
        }
    });
    $cancelled = publisherCommand('delayed-future-v1','publish',$identities['cancelled'],$binding,$projection($identities['cancelled']),null);
    check('terminal native cancellation prevents a late publish and is itself idempotent',function () use ($publisher,$cancelled): void {
        must($publisher->resolveOrCancel($cancelled)['state']==='cancelled','Absent operation must persist cancellation');
        must($publisher->publish($cancelled)['state']==='cancelled','Late publication must not revive cancellation');
        must($publisher->resolveOrCancel($cancelled)['state']==='cancelled','Resolution must be repeatable');
        must(rows('SELECT id FROM emails WHERE id='.publisherQ($cancelled['suiteCrmId']))===[],'Cancelled email must not be created');
    });
    check('lost response reconciliation returns the committed outcome instead of cancelling or duplicating it',function () use ($publisher,$future,$db,$profile): void {
        $before=publisherSnapshot($db,$profile,$future['suiteCrmId']);
        $r=$publisher->resolveOrCancel($future);
        must($r['state']==='committed' && $r['replayed']===true && $r['commandHash']===ClawPilotNativeEmailPublisher::digest($future),'Committed outcome must be recoverable');
        must(publisherSnapshot($db,$profile,$future['suiteCrmId'])===$before,'Resolve may not re-execute content');
    });
    check('stale generation unknown identities conflicting retries and changed history refuse',function () use ($publisher,$repair,$future,$db,$profile): void {
        $cases=[];
        $changed=$future; $changed['projection']['attributes']['name']='changed'; $cases[]=$changed;
        $changed=$repair; $changed['operationId']=hash('sha256','stale-generation'); $changed['generation']=2; $cases[]=$changed;
        $changed=$repair; $changed['operationId']=hash('sha256','unknown-identity'); $changed['localId']='different'; $cases[]=$changed;
        $changed=$repair; $changed['operationId']=hash('sha256','overlong-native-identity'); $changed['suiteCrmId']=str_repeat('a',37); $cases[]=$changed;
        $changed=$repair; $changed['operationId']=hash('sha256','history-drift'); $changed['expectedRecordFingerprint']=str_repeat('0',64); $cases[]=$changed;
        foreach($cases as $case) {
            // An invalid identifier is rejected before native lookup; snapshot
            // the valid historical control instead of asking the snapshot API
            // to accept the very malformed identifier this probe must reject.
            $probeId=strlen($case['suiteCrmId'])>36?$repair['suiteCrmId']:$case['suiteCrmId'];
            $before=publisherSnapshot($db,$profile,$probeId); $denied=false;
            try{$publisher->publish($case);}catch(ClawPilotNativeEmailTransactionRefused $e){$denied=true;}
            must($denied && publisherSnapshot($db,$profile,$probeId)===$before,'Refusal must preserve raw native data');
            if($probeId!==$case['suiteCrmId'])must(rows('SELECT id FROM emails WHERE id='.publisherQ($case['suiteCrmId']))===[]
                && rows('SELECT operation_id FROM clawpilot_email_operations WHERE operation_id='.publisherQ($case['operationId']))===[],
                'Invalid identifier must create neither a native Email nor a receipt');
        }
    });
    check('post-save reader failure rolls back email body access and operation receipt',function () use ($publisher,$binding,$identities,$projection,$db,$profile): void {
        // Deliberately reviewed synthetic policy with an explicit ALL override:
        // the runtime/defaults and pipeline group still validate, but the final
        // native-reader enumeration MUST reject after actual content/group writes.
        $unexpected=userFixture('publisher-unexpected-reader');
        $role=native('ACLRoles'); $role->name='Synthetic publisher explicit all'; $role->save(false);
        foreach(rows("SELECT id,name FROM acl_actions WHERE category='Emails' AND acltype='module' AND deleted=0") as $action)
            $role->setAction($role->id,$action['id'],$action['name']==='access'?ACL_ALLOW_ENABLED:ACL_ALLOW_ALL);
        linkBeans($role,'users',[(string)$unexpected->id]);
        $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);$policy=$tx->immutablePolicyFingerprint();$tx->rollback();
        publisherSql('UPDATE clawpilot_email_bindings SET policy_fingerprint='.publisherQ($policy).' WHERE pipeline_id='.publisherQ($binding['pipeline']));
        $command=publisherCommand('failed-projection-v1','publish',$identities['failure'],$binding,$projection($identities['failure']),null);
        $denied=false;try{$publisher->publish($command);}catch(ClawPilotNativeEmailTransactionRefused $e){$denied=$e->holdCode==='unexpected_native_readers'||$e->holdCode==='unexpected_native_write_access';}
        must($denied,'Actual post-save native reader/write enumeration must refuse');
        foreach(['emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c'] as $table=>$column) must(rows('SELECT * FROM '.$table.' WHERE '.$column.'='.publisherQ($command['suiteCrmId']))===[],'Refused publication leaked native rows');
        must(rows('SELECT email_id FROM clawpilot_email_identities WHERE email_id='.publisherQ($command['suiteCrmId']))===[],'Failed future enrollment must roll back');
        must(rows('SELECT operation_id FROM clawpilot_email_operations WHERE operation_id='.publisherQ($command['operationId']))===[],'Failed attempt must not claim commit');
        // Restore the synthetic reader grant for subsequent overlap tests. The
        // fixture-only user remains unroled and cannot read this pipeline.
        publisherSql('DELETE FROM acl_roles_users WHERE role_id='.publisherQ((string)$role->id).' AND user_id='.publisherQ((string)$unexpected->id));
        $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);$policy=$tx->immutablePolicyFingerprint();$tx->rollback();
        publisherSql('UPDATE clawpilot_email_bindings SET policy_fingerprint='.publisherQ($policy).' WHERE pipeline_id='.publisherQ($binding['pipeline']));
    });
    $raceIdentity=['id'=>create_guid(),'global'=>'gi8800005','local'=>create_guid()];
    $race=['command'=>publisherCommand('overlapping-publish-cancel-v1','publish',$raceIdentity,$binding,$projection($raceIdentity),null),
        'profile'=>$profile,'callerId'=>(string)$admin->id,'readers'=>$readers];
    $raceBytes=json_encode($race,JSON_THROW_ON_ERROR);
    must(file_put_contents('/tmp/native-publisher-race.json',$raceBytes,LOCK_EX)===strlen($raceBytes) && chmod('/tmp/native-publisher-race.json',0600),'Synthetic race handoff must be private');
    fwrite(STDOUT,'CLAWPILOT_NATIVE_PUBLISHER_WIRE='.json_encode(['input'=>['command'=>$future,'nativePolicyFingerprint'=>$policy,'allowedReaderSuiteCrmUserIds'=>$readers],'receipt'=>$wireReceipt],JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)."\n");
    fwrite(STDOUT,'NATIVE_TRANSACTIONAL_PUBLISHER_PASSED='.$GLOBALS['checks']."\n");
} catch(Throwable $error){fwrite(STDERR,get_class($error).': '.$error->getMessage()."\n".$error->getTraceAsString()."\n");exit(1);}
})();
