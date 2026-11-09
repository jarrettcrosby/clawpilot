<?php
declare(strict_types=1);

// Actual installed stock SuiteCRM, not the managed-role fixture or a mock.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_SHARED_EMAIL_ONLY') !== '1') {
    throw new RuntimeException('Isolated stock SuiteCRM shared Email fixture required');
}
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/source/email-audience/SharedBpoEmailCreatePermit.php';

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
    fwrite(STDOUT,"PASS stock non-admin view and both company and contact Email histories show the same ID\nNATIVE_SHARED_EMAIL_ACCEPTANCE_PASSED=1\n");
} catch (Throwable $failure) {
    // A failure is not a receipt. Diagnostics are confined to synthetic data.
    $detail=isset($failure->diagnostic)?' '.$failure->diagnostic:'';
    fwrite(STDERR,'STOCK_SHARED_EMAIL_FIXTURE_FAILED='.$failure::class.' '.$failure->getMessage().$detail."\n");
    throw $failure;
}
})();
