<?php
declare(strict_types=1);

// Local native fixture only, after native-publisher and its authorization stage.
if(getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION')!=='1') throw new RuntimeException('Opt-in disposable fixture required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/source/email-audience/NativeEmailPublisher.php';

function publisherStorageSql(mysqli $db,string $sql): void { must($db->query($sql)===true,'Checked synthetic registry SQL required'); }
function publisherStorageState(mysqli $db): string
{
    $hash=hash_init('sha256');
    foreach(['clawpilot_email_operations'=>'operation_id','clawpilot_email_identities'=>'email_id',
        'clawpilot_email_bindings'=>'pipeline_id','emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c',
        'emails_beans'=>'id','emails_email_addr_rel'=>'id','securitygroups_records'=>'id'] as $table=>$key) {
        $result=$db->query('SELECT * FROM '.$table.' ORDER BY '.$key,MYSQLI_USE_RESULT);
        must($result instanceof mysqli_result,'Native storage snapshot must read');
        hash_update($hash,$table."\n");$count=0;$bytes=0;
        try { while($row=$result->fetch_assoc()) {
            $encoded=json_encode($row,JSON_THROW_ON_ERROR);$bytes+=strlen($encoded);
            must(++$count<=10000 && $bytes<=16777216,'Synthetic storage snapshot must stay bounded');
            hash_update($hash,strlen($encoded).':'.$encoded."\n");
        } } finally {$result->free();}
    }
    return hash_final($hash);
}
function publisherStorageDenied(ClawPilotNativeEmailPublisher $publisher,array $command,mysqli $db,string $code): void
{
    $before=publisherStorageState($db);
    foreach(['prepare','publish','resolveOrCancel'] as $method) {
        $held=false;
        try {$publisher->{$method}($command);}
        catch(ClawPilotNativeEmailTransactionRefused $error) {$held=$error->holdCode===$code;}
        must($held,'Unproven registry storage must refuse at the expected gate');
        must(hash_equals($before,publisherStorageState($db)),'Storage refusal must preserve native content access and receipts');
        $result=$db->query('SELECT @@in_transaction AS active');
        try {must((int)$result->fetch_assoc()['active']===0,'Storage refusal must close its transaction');}
        finally {$result->free();}
    }
}

(static function (): void {
try {
    $_REQUEST=[];
    $admin=fresh('Users',rows("SELECT id FROM users WHERE user_name='fixture-admin'")[0]['id']);selectUser($admin);
    $db=DBManagerFactory::getInstance()->database;
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
    must(count($bindings)===1 && count($identities)===1,'Exact unique synthetic binding and history required');
    $binding=$bindings[0];$identity=$identities[0];
    must((int)$binding['generation']===($source['generation']??null) && $binding['audience_fingerprint']===($source['audienceFingerprint']??null)
        && $binding['owner_id']===$admin->id,'Exact unique binding must match the protected publisher command');
    $publisher=new ClawPilotNativeEmailPublisher($db,$profile,(string)$admin->id);
    $command=['version'=>1,'operationId'=>hash('sha256','native-publisher-storage-control-v1'),
        'mode'=>'repair','workspaceId'=>$binding['workspace_id'],'pipelineId'=>$binding['pipeline_id'],
        'generation'=>(int)$binding['generation'],'audienceFingerprint'=>$binding['audience_fingerprint'],
        'suiteCrmId'=>$identity['email_id'],'globalId'=>$identity['global_id'],'localId'=>$identity['local_id'],
        'expectedRecordFingerprint'=>str_repeat('0',64),'projection'=>null];
    $initial=publisherStorageState($db);
    check('native publisher rejects a receipt trigger that would mutate historical Email after final readback',function () use ($db,$publisher,$command,$identity): void {
        must(rows("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='cp_fixture_receipt_tamper'")===[],'Synthetic trigger name must be unused');
        publisherStorageSql($db,"CREATE TRIGGER cp_fixture_receipt_tamper AFTER INSERT ON clawpilot_email_operations FOR EACH ROW UPDATE emails SET name='SYNTHETIC UNEXPECTED RECEIPT TRIGGER' WHERE id='".quote($identity['email_id'])."'");
        try {publisherStorageDenied($publisher,$command,$db,'native_runtime_profile_unproven');}
        finally {publisherStorageSql($db,'DROP TRIGGER cp_fixture_receipt_tamper');}
    });
    check('native publisher rejects a removed registry identity unique index before any writes',function () use ($db,$publisher,$command): void {
        publisherStorageSql($db,'ALTER TABLE clawpilot_email_identities DROP INDEX global_id');
        try {publisherStorageDenied($publisher,$command,$db,'publication_storage_unproven');}
        finally {publisherStorageSql($db,'ALTER TABLE clawpilot_email_identities ADD UNIQUE INDEX global_id(global_id)');}
    });
    check('restored exact native registry allows terminal receipt and both fault probes preserve all native rows',function () use ($db,$publisher,$command,$initial): void {
        must(hash_equals($initial,publisherStorageState($db)),'Both storage probes must preserve exact original rows');
        $receipt=$publisher->resolveOrCancel($command);
        must($receipt['state']==='cancelled' && $receipt['replayed']===false,'Restored storage must accept a real terminal receipt');
        publisherStorageSql($db,"DELETE FROM clawpilot_email_operations WHERE operation_id='".quote($command['operationId'])."'");
        must($db->affected_rows===1 && hash_equals($initial,publisherStorageState($db)),'Only this synthetic control receipt may be removed');
    });
    fwrite(STDOUT,'NATIVE_PUBLISHER_STORAGE_PASSED=checks='.$GLOBALS['checks'].'; exact registry indexes and receipt-trigger refusal; synthetic only.' ."\n");
} catch(Throwable $error) {fwrite(STDERR,"Native publisher storage fixture failed\n");exit(1);}
})();
