<?php
declare(strict_types=1);
// Real native save + raw readback. All data is synthetic and container-local.
// This does not certify browser rendering, delivery or a live runtime profile.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1'
    || trim((string)file_get_contents('/app/VERSION')) !== '8.10.1') throw new RuntimeException('Pinned disposable projection fixture required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/source/email-audience/NativeEmailProjection.php';

function projectionRows(mysqli $db,string $sql): array
{
    $result=$db->query($sql); must($result instanceof mysqli_result,'Projection fixture read failed');
    try { return $result->fetch_all(MYSQLI_ASSOC); } finally { $result->free(); }
}
function projectionState(mysqli $db): string
{
    $data=[];
    foreach (['emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c','emails_beans'=>'id','emails_email_addr_rel'=>'id',
        'email_addresses'=>'id','email_addr_bean_rel'=>'id','securitygroups_records'=>'id','accounts'=>'id','contacts'=>'id','accounts_contacts'=>'id'] as $table=>$key) {
        $data[$table]=projectionRows($db,'SELECT * FROM '.$table.' ORDER BY '.$key);
    }
    return hash('sha256',json_encode($data,JSON_THROW_ON_ERROR));
}
function projectionFence(mysqli $db): ClawPilotNativeEmailTransaction
{
    return ClawPilotNativeEmailTransaction::begin($db,['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test']);
}
function projectionRefusal(mysqli $db,mysqli $observer,array $command,string $prefix): void
{
    $before=projectionState($observer); $tx=projectionFence($db); $refused=false;
    try { ClawPilotNativeEmailProjection::upsert($db,$tx,$command); }
    catch (ClawPilotNativeEmailProjectionRefused $error) { $refused=str_starts_with($error->holdCode,$prefix); }
    finally { try { $tx->rollback(); } catch (Throwable $ignored) {} }
    must($refused,'Expected bounded native projection refusal: '.$prefix);
    must(projectionState($observer)===$before,'Refused native projection changed committed rows');
}
function projectionFingerprint(mysqli $db,string $id): string
{
    $tx=projectionFence($db);
    try { return ClawPilotNativeEmailProjection::snapshot($db,$tx,$id)['fingerprint']; }
    finally { $tx->rollback(); }
}

(static function () use (&$checks, $sugar_config): void {
$defaults=[]; $tx=null; $failed=false;
try {
    must(realpath('.') === '/app/public/legacy' && ($sugar_config['dbconfig']['db_name'] ?? '') === 'suitecrm_native_test'
        && ($sugar_config['dbconfig']['db_host_name'] ?? '') === 'db','Only synthetic native projection DB admitted');
    $_REQUEST=[]; $db=DBManagerFactory::getInstance()->database; must($db instanceof mysqli,'Native mysqli required');
    $observer=new mysqli('db','fixture','Synthetic-native-db-password-only','suitecrm_native_test',3306);
    $observer->set_charset('utf8mb4'); $observer->query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    must($observer->thread_id !== $db->thread_id,'Independent observer connection required');
    $adminId=rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0")[0]['id'];
    $targetId=rows("SELECT id FROM users WHERE user_name='fixture-installed-blank-status-unroled' AND deleted=0")[0]['id'];
    selectUser(fresh('Users',$adminId));
    check('native privilege schema matching admits only exact escaped literals and never unrelated or wildcard schema grants',function():void {
        $matcher=new ReflectionMethod(ClawPilotNativeEmailRuntime::class,'exactSchemaGrant');
        must($matcher->invoke(null,'suitecrm\\_native\\_test','suitecrm_native_test')===true,'Confirmed MariaDB escaped exact schema must match');
        foreach(['other\\_native\\_test','suitecrm_native_test','suitecrm\\_native\\_%','%','suitecrm\\_native\\_test_suffix',
            'prefix_suitecrm\\_native\\_test','suitecrm\\_native\\_tes_'] as $other)
            must($matcher->invoke(null,$other,'suitecrm_native_test')===false,'Unrelated or wildcard schema privileges may not prove visibility');
        must($matcher->invoke(null,'literal','literal')===true && $matcher->invoke(null,'literal\\%\\_\\\\name','literal%_\\name')===true,
            'Literal percent underscore and backslash escaping must be exact');
        must($matcher->invoke(null,'literal%_\\name','literal%_\\name')===false && $matcher->invoke(null,'','')===false,
            'Unescaped patterns and an empty database may not prove visibility');
    });
    $defaults=rows("SELECT id,name,aclaccess FROM acl_actions WHERE category='Emails' AND acltype='module' AND deleted=0 AND name IN ('view','list','export','edit','delete') ORDER BY id");
    must(count($defaults)===5,'Exact synthetic default rows required');
    foreach ($defaults as $row) $db->query('UPDATE acl_actions SET aclaccess='.(in_array($row['name'],['view','list','export'],true)?80:75)." WHERE id='".quote($row['id'])."'");
    // Native setup is outside the projection transactions and never sends mail.
    $accounts=[];
    foreach (['one','two','three','unmanaged'] as $label) {
        $account=native('Accounts'); $account->name='Synthetic projection company '.$label; $account->assigned_user_id=$adminId; $account->save(false); $accounts[$label]=(string)$account->id;
    }
    $contacts=[];
    foreach (['one','two'] as $label) {
        $contact=native('Contacts'); $contact->last_name='Synthetic projection contact '.$label; $contact->assigned_user_id=$adminId;
        $contact->account_id=$accounts[$label]; $contact->save(false); $contacts[$label]=(string)$contact->id;
    }
    $relatedBefore=projectionRows($observer,'SELECT * FROM accounts_contacts ORDER BY id');
    $contactBefore=projectionRows($observer,'SELECT * FROM contacts ORDER BY id');
    $accountBefore=projectionRows($observer,'SELECT * FROM accounts ORDER BY id');
    $id=create_guid();
    $plain="First plain line &amp; literal entity\nLiteral <b>tag</b>, O'Neil and \"quoted text\"\n<script>alert('synthetic')</script>\nUnicode Élodie and last line";
    $command=['suiteCrmId'=>$id,'attributes'=>[
        'global_id_c'=>'gi9800001','name'=>'Synthetic exact raw projection','date_sent_received'=>'2026-10-30T08:15:30-04:00',
        'type'=>'archived','status'=>'read','parent_type'=>'Accounts','parent_id'=>$accounts['one'],'assigned_user_id'=>$adminId,
        'description'=>$plain,'description_html'=>'','from_addr_name'=>'Fixture Sender <Sender+alias@example.test>',
        'to_addrs_names'=>'"Quoted Recipient" <to@example.test>, Second Recipient <second@example.test>',
        'cc_addrs_names'=>'Élodie Example <cc@example.test>','bcc_addrs_names'=>'Hidden Recipient <hidden@example.test>',
        'reply_to_addrs_names'=>'Reply Desk <reply+alias@example.test>',
    ],'accounts'=>[$accounts['one'],$accounts['two']],'contacts'=>[$contacts['one'],$contacts['two']],
        'contactAccounts'=>[['contactId'=>$contacts['one'],'accountId'=>$accounts['one']],['contactId'=>$contacts['two'],'accountId'=>$accounts['two']]],
        'previousManaged'=>['accounts'=>[],'contacts'=>[]],'expectedBeforeFingerprint'=>null];
    check('queued native Contact saves hold before projection without draining the queue or invoking Contact portal hooks',function()use($db,$observer,$command,$contacts):void {
        $queue=new ReflectionProperty(SugarRelationship::class,'beansToResave');$before=$queue->getValue();
        must($before===[],'Synthetic deferred-save queue must initially be empty');
        $state=projectionState($observer);$held=false;$tx=null;
        SugarRelationship::addToResaveList(fresh('Contacts',$contacts['one']));$injected=$queue->getValue();
        try {
            $tx=projectionFence($db);
            try {ClawPilotNativeEmailProjection::upsert($db,$tx,$command);}
            catch(ClawPilotNativeEmailTransactionRefused $error) {
                $held=$error->holdCode==='native_runtime_profile_unproven' && $error->diagnostic==='pending_native_relationship_resave';
            }
            must($held && $queue->getValue()===$injected,'Runtime must refuse the exact queue without draining or clearing it');
            must(projectionState($observer)===$state,'Queued-contact refusal must not create Email or change related native rows');
        } finally {
            if($tx instanceof ClawPilotNativeEmailTransaction)try{$tx->rollback();}catch(Throwable $ignored){}
            // Restore only this fixture-injected queue, never execute its beans.
            $queue->setValue(null,$before);
        }
    });
    $receipt=null;
    check('native projection preserves exact plain bytes and typed display headers while proving sanitized HTML and UTC storage',function () use ($db,$observer,$command,$id,$plain,&$receipt,$relatedBefore,$contactBefore,$accountBefore): void {
        $tx=projectionFence($db);
        try {
            $receipt=ClawPilotNativeEmailProjection::upsert($db,$tx,$command);
            must($receipt['version']===2 && $receipt['suiteCrmId']===$id,'Actual projection receipt identity required');
            $raw=projectionRows($db,"SELECT * FROM emails_text WHERE email_id='".quote($id)."'")[0];
            must($raw['description']===$plain && $receipt['attributes']['description']===$plain,'Raw plain body must preserve entities, literal tags, quotes and apostrophes exactly');
            must($raw['description_html']===$receipt['attributes']['description_html'] && $raw['description_html']!==''
                && !str_contains(strtolower($raw['description_html']),'<script'),'HTML must be the actual native sanitized representation');
            $headers=['from_addr'=>'Fixture Sender <sender+alias@example.test>','to_addrs'=>'Quoted Recipient <to@example.test>, Second Recipient <second@example.test>',
                'cc_addrs'=>'Élodie Example <cc@example.test>','bcc_addrs'=>'Hidden Recipient <hidden@example.test>','reply_to_addr'=>'Reply Desk <reply+alias@example.test>'];
            foreach($headers as $field=>$expected) must($raw[$field]===$expected,'Typed header/display name raw readback mismatch');
            must($receipt['attributes']['date_sent_received']==='2026-10-30 12:15:30' && $receipt['dateSentReceivedUtc']==='2026-10-30T12:15:30Z','UTC normalization must be proven from native storage');
            must($receipt['sourceAttributes']===$command['attributes'],'Source attributes may be returned only with successful actual raw proof');
            must(projectionRows($observer,"SELECT id FROM emails WHERE id='".quote($id)."'")===[]
                && projectionRows($observer,"SELECT email_id FROM emails_text WHERE email_id='".quote($id)."'")===[]
                && projectionRows($observer,"SELECT id FROM emails_beans WHERE email_id='".quote($id)."'")===[],'Independent connection must not see any uncommitted projection rows');
            $tx->commit();
        } catch(Throwable $error) { try{$tx->rollback();}catch(Throwable $ignored){} throw $error; }
        must(projectionRows($observer,'SELECT * FROM accounts_contacts ORDER BY id')===$relatedBefore
            && projectionRows($observer,'SELECT * FROM contacts ORDER BY id')===$contactBefore
            && projectionRows($observer,'SELECT * FROM accounts ORDER BY id')===$accountBefore,'Native projection must not reparent or rewrite related people/companies');
    });
    $updated=$command; $updated['attributes']['description'].="\nReviewed update"; $updated['attributes']['status']='sent';
    $updated['attributes']['parent_id']=$accounts['two']; $updated['accounts']=[$accounts['two'],$accounts['three']];
    $updated['contacts']=[$contacts['two']]; $updated['contactAccounts']=[['contactId'=>$contacts['two'],'accountId'=>$accounts['two']]];
    $updated['previousManaged']=['accounts'=>$command['accounts'],'contacts'=>$command['contacts']]; $updated['expectedBeforeFingerprint']=$receipt['snapshotFingerprint'];
    unset($updated['attributes']['bcc_addrs_names'],$updated['attributes']['reply_to_addrs_names']);
    check('native update reconciles reviewed links and preserves omitted headers, NULL metadata and contact-account bindings',function () use ($db,$observer,$updated,$id,$relatedBefore,$contactBefore,$accountBefore,&$receipt): void {
        $created=projectionRows($db,"SELECT created_by,date_entered,assigned_user_id FROM emails WHERE id='".quote($id)."'")[0];
        $untouched=projectionRows($db,"SELECT orphaned,flagged,reply_to_status,mailbox_id,outbound_email_id FROM emails WHERE id='".quote($id)."'")[0];
        must(count(array_filter($untouched,static fn($value)=>$value===null))===5,'Fixture must exercise stock NULL fields that ordinary native update normalizes');
        $tx=projectionFence($db);
        try { $receipt=ClawPilotNativeEmailProjection::upsert($db,$tx,$updated); $tx->commit(); }
        catch(Throwable $error) { try{$tx->rollback();}catch(Throwable $ignored){} throw $error; }
        must($receipt['attributes']['bcc_addrs_names']==='Hidden Recipient <hidden@example.test>' && $receipt['attributes']['reply_to_addrs_names']==='Reply Desk <reply+alias@example.test>','Unavailable headers must not clear existing native evidence');
        must(projectionRows($db,"SELECT created_by,date_entered,assigned_user_id FROM emails WHERE id='".quote($id)."'")[0]===$created,'Update must preserve creation and ownership');
        must(projectionRows($db,"SELECT orphaned,flagged,reply_to_status,mailbox_id,outbound_email_id FROM emails WHERE id='".quote($id)."'")[0]===$untouched,'Native column whitelist must preserve every untouched NULL exactly');
        must(projectionRows($observer,'SELECT * FROM accounts_contacts ORDER BY id')===$relatedBefore
            && projectionRows($observer,'SELECT * FROM contacts ORDER BY id')===$contactBefore
            && projectionRows($observer,'SELECT * FROM accounts ORDER BY id')===$accountBefore,'Removed Email links must not reparent Contacts or rewrite Accounts');
    });
    check('projection rollback removes real native body, custom identity and relationship writes',function () use ($db,$observer,$command): void {
        $copy=$command; $copy['suiteCrmId']=create_guid(); $copy['attributes']['global_id_c']='gi9800002'; $before=projectionState($observer); $tx=projectionFence($db);
        try {
            ClawPilotNativeEmailProjection::upsert($db,$tx,$copy);
            must(count(projectionRows($db,"SELECT id FROM emails WHERE id='".quote($copy['suiteCrmId'])."'"))===1,'Rollback must follow actual native save');
            must(projectionState($observer)===$before,'Uncommitted native save leaked'); $tx->rollback();
        } catch(Throwable $error) { try{$tx->rollback();}catch(Throwable $ignored){} throw $error; }
        must(projectionState($observer)===$before,'Real projection rollback must restore every tracked native row');
    });
    check('lossy quoted-comma and apostrophe display names, header injection and unsupported fields hold without writes',function () use ($db,$observer,$command): void {
        foreach (['"Last, First" <name@example.test>',"O'Neil <name@example.test>","Sender <name@example.test>\r\nBcc: attacker@example.test"] as $header) {
            $copy=$command; $copy['suiteCrmId']=create_guid(); $copy['attributes']['global_id_c']='gi9800003'; $copy['attributes']['from_addr_name']=$header;
            projectionRefusal($db,$observer,$copy,'unsupported_header');
        }
        $copy=$command; $copy['attributes']['send_email']='1'; projectionRefusal($db,$observer,$copy,'unsupported_attribute');
    });
    check('stale preimages, missing existing rows, duplicate Global IDs, ownership changes and contact reparenting are refused',function () use ($db,$observer,$command,$updated,$receipt,$accounts,$targetId): void {
        $stale=$updated; $stale['expectedBeforeFingerprint']=str_repeat('0',64); projectionRefusal($db,$observer,$stale,'existing_preimage_changed');
        $missing=$command; $missing['suiteCrmId']=create_guid(); $missing['expectedBeforeFingerprint']=str_repeat('a',64); projectionRefusal($db,$observer,$missing,'existing_preimage_changed');
        $duplicate=$command; $duplicate['suiteCrmId']=create_guid(); projectionRefusal($db,$observer,$duplicate,'duplicate_or_changed_global_id');
        $owner=$updated; $owner['expectedBeforeFingerprint']=$receipt['snapshotFingerprint']; $owner['attributes']['assigned_user_id']=$targetId;
        projectionRefusal($db,$observer,$owner,'existing_lifecycle_or_ownership_changed');
        $reparent=$updated; $reparent['expectedBeforeFingerprint']=$receipt['snapshotFingerprint']; $reparent['contactAccounts'][0]['accountId']=$accounts['three'];
        projectionRefusal($db,$observer,$reparent,'contact_account_changed');
    });
    check('unknown Email relationships and soft-deleted native history are never silently adopted or recreated',function () use ($db,$observer,$updated,$accounts,$id): void {
        linkBeans(fresh('Emails',$id),'accounts',[$accounts['unmanaged']]);
        $unknown=$updated; $unknown['expectedBeforeFingerprint']=projectionFingerprint($db,$id);
        projectionRefusal($db,$observer,$unknown,'unmanaged_relationship');
        $db->query("UPDATE emails SET deleted=1 WHERE id='".quote($id)."'");
        $deleted=$updated; $deleted['expectedBeforeFingerprint']=projectionFingerprint($db,$id);
        projectionRefusal($db,$observer,$deleted,'existing_lifecycle_or_ownership_changed');
        must(projectionRows($db,"SELECT deleted FROM emails WHERE id='".quote($id)."'")[0]['deleted']==='1','Soft-deleted native Email must stay deleted');
    });
    check('locking historical snapshot alone does not save or rewrite any Email',function () use ($db,$observer,$id): void {
        $before=projectionState($observer); $tx=projectionFence($db);
        try { $snapshot=ClawPilotNativeEmailProjection::snapshot($db,$tx,$id); must($snapshot['exists'] && strlen($snapshot['fingerprint'])===64,'Locked history fingerprint required'); $tx->rollback(); }
        catch(Throwable $error) { try{$tx->rollback();}catch(Throwable $ignored){} throw $error; }
        must(projectionState($observer)===$before,'Historical snapshot changed native data');
    });
    $observer->close();
} catch(Throwable $error) {
    if ($tx instanceof ClawPilotNativeEmailTransaction) { try{$tx->rollback();}catch(Throwable $ignored){} }
    fwrite(STDERR,'Native Email projection failed: '.($error instanceof ClawPilotNativeEmailProjectionRefused || $error instanceof ClawPilotNativeEmailTransactionRefused ? $error->holdCode : get_class($error))."\n");
    if($error instanceof ClawPilotNativeEmailProjectionRefused && is_string($error->diagnostic)
        && strlen($error->diagnostic)<=1500 && preg_match('/^[A-Za-z0-9_:,> -]+$/D',$error->diagnostic)===1)
        fwrite(STDERR,'Native projection assertion: '.$error->diagnostic."\n");
    // Internal pinned-profile assertion only, never exception chains, bodies,
    // native rows, user values or credentials; HTTP routes remain generic.
    if($error instanceof ClawPilotNativeEmailTransactionRefused && is_string($error->diagnostic)) {
        $diagnostic=substr($error->diagnostic,0,220);
        if(preg_match('/^[A-Za-z0-9 _.:,\/\\\\-]+$/D',$diagnostic)===1)
            fwrite(STDERR,'Native runtime assertion: '.$diagnostic."\n");
        if($error->diagnostic==='unknown_module_hooks:Contacts') {
            // The fixture is CLI-only and synthetic. Capture only the actual
            // module hook metadata on this exact failure, never native rows,
            // request/session data, credentials, tokens or exception chains.
            try {
                $hookMap=LogicHook::initialize()->getHooks('Contacts',true);
                $hookJson=json_encode($hookMap,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
                if(strlen($hookJson)<=6000)fwrite(STDERR,'Native Contacts hook map: '.$hookJson."\n");
                else fwrite(STDERR,"Native Contacts hook map exceeded diagnostic bound\n");
            } catch(Throwable $diagnosticError) {fwrite(STDERR,"Native Contacts hook map unavailable\n");}
        }
    }
    $failed=true;
} finally {
    // Restore only the exact five synthetic default values; no user/role edits.
    if (isset($db) && $db instanceof mysqli) foreach($defaults as $row) $db->query('UPDATE acl_actions SET aclaccess='.(int)$row['aclaccess']." WHERE id='".quote($row['id'])."'");
}
if ($failed) exit(1);
fwrite(STDOUT,"NATIVE_EMAIL_PROJECTION_PASSED=checks={$checks}; actual native save/raw readback/rollback; strict supported headers; no browser-rendering, delivery or production proof.\n");
})();
