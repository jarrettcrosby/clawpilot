<?php
declare(strict_types=1);

// Run only through the disposable MariaDB harness. All inputs and rows are synthetic.
require_once __DIR__.'/../services/suitecrm/email-audience/SharedBpoEmailReceipt.php';

function receiptCheck(bool $ok, string $label): void {
    if (!$ok) throw new RuntimeException('Receipt fixture failed: '.$label);
}
function receiptHold(callable $fn, string $code): void {
    try { $fn(); }
    catch (ClawPilotNativeEmailTransactionRefused $error) {
        receiptCheck($error->holdCode === 'shared_bpo_email_receipt_'.$code, 'exact refusal '.$code);
        return;
    }
    throw new RuntimeException('Expected receipt refusal: '.$code);
}

receiptCheck(PHP_SAPI === 'cli' && getenv('CLAWPILOT_SYNTHETIC_RECEIPT_FIXTURE') === '1', 'isolated CLI invocation');
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$db = new mysqli('db','fixture','Synthetic-native-db-password-only','clawpilot_receipt_fixture');
$observer = new mysqli('db','fixture','Synthetic-native-db-password-only','clawpilot_receipt_fixture');
receiptCheck($db->query('SHOW TABLES')->num_rows === 0, 'fresh synthetic store');
$profile = ['database'=>'clawpilot_receipt_fixture','profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1'];
foreach (ClawPilotNativeEmailTransaction::policyTables() as $table) {
    $db->query($table === 'config'
        ? 'CREATE TABLE `config` (`category` varchar(12),`name` varchar(12),`value` varchar(12), KEY idx_config_cat (`category`)) ENGINE=InnoDB'
        : 'CREATE TABLE `'.$table.'` (`id` varchar(36) PRIMARY KEY) ENGINE=InnoDB');
}
// The production transaction refuses unexpectedly small/partially installed stores.
for ($i=0; $i<85; $i++) $db->query('CREATE TABLE synthetic_filler_'.$i.' (id INT PRIMARY KEY) ENGINE=InnoDB');
$db->query('CREATE TABLE synthetic_email (id VARCHAR(36) PRIMARY KEY) ENGINE=InnoDB');
$db->query('CREATE TABLE synthetic_link (id INT PRIMARY KEY) ENGINE=InnoDB');
$db->query(file_get_contents(__DIR__.'/../services/suitecrm/email-audience/shared-bpo-email-receipts.sql'));

$key = openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>3072]);
receiptCheck($key instanceof OpenSSLAsymmetricKey, 'synthetic fixture key');
$publicKey = openssl_pkey_get_details($key)['key'];
$permitFor = static function (string $nativeId, string $globalId, string $nonce, string $intent='one') use ($key,$publicKey): ClawPilotSharedBpoEmailCreatePermit {
    $projection = [
        'suiteCrmId'=>$nativeId,
        'attributes'=>['global_id_c'=>$globalId,'name'=>'Synthetic fixture','date_sent_received'=>'2026-01-01T00:00:00Z',
            'type'=>'archived','status'=>'read','parent_type'=>'','parent_id'=>'','assigned_user_id'=>'fixture-author',
            'description'=>'Synthetic text','description_html'=>'','from_addr_name'=>'author@example.invalid'],
        'accounts'=>[],'contacts'=>[],'contactAccounts'=>[],'previousManaged'=>['accounts'=>[],'contacts'=>[]],
        'expectedBeforeFingerprint'=>null,
    ];
    $scope = ['action'=>'create-missing','keyId'=>'receipt-test','workspaceId'=>'c6c49765-9bf6-4223-9261-7553499f5d92',
        'pipelineId'=>'587c8746-ecf6-40ae-8c50-e456f99ad555','lane'=>'failed','nativeId'=>$nativeId,'globalId'=>$globalId,
        'localId'=>'20000000-0000-4000-8000-000000000001','nonce'=>hash('sha256',$nonce),
        'projectionFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($projection)];
    foreach (['releaseFingerprint','appDeploymentFingerprint','nativeDeploymentFingerprint','appOriginFingerprint',
        'nativeOriginFingerprint','inventoryFingerprint','slotFingerprint','policyStateFingerprint'] as $field) {
        $scope[$field] = hash('sha256',$field.($field==='slotFingerprint'?$intent:''));
    }
    $now = time();
    $proof = ['version'=>1,'purpose'=>'clawpilot-shared-bpo-email-create-v1','scope'=>$scope,'issuedAt'=>$now,'expiresAt'=>$now+60];
    receiptCheck(openssl_sign(ClawPilotNativeEmailAuthorityContract::canonical($proof),$signature,$key,OPENSSL_ALGO_SHA256),'signed permit');
    return ClawPilotSharedBpoEmailCreatePermit::verify(['proof'=>$proof,'signature'=>base64_encode($signature)],$scope,$projection,$publicKey,$now);
};
$id = '10000000-0000-4000-8000-000000000001';
$otherId = '10000000-0000-4000-8000-000000000002';
$global = 'gi123456789abc';
$first = $permitFor($id,$global,'first');
$renewed = $permitFor($id,$global,'renewed');
$globalAlias = $permitFor($otherId,$global,'third');
$nonceAlias = $permitFor($otherId,'gi123456789abd','first');
$changed = $permitFor($id,$global,'first','changed');
$snapshot = hash('sha256','fixture snapshot');
$counts = static fn() => array_map(static fn($table)=>(int)$observer->query('SELECT COUNT(*) FROM '.$table)->fetch_row()[0],
    ['clawpilot_shared_bpo_email_receipts','synthetic_email','synthetic_link']);
$writeFixtureEmail = static function () use ($db,$id): void {
    $db->execute_query('INSERT INTO synthetic_email (id) VALUES (?)',[$id]);
    $db->query('INSERT INTO synthetic_link (id) VALUES (1),(2)');
};

$tx = ClawPilotNativeEmailTransaction::begin($db,$profile);
receiptCheck(ClawPilotSharedBpoEmailReceipt::lock($db,$tx,$first) === null,'initial absence');
$writeFixtureEmail();
$row = ClawPilotSharedBpoEmailReceipt::record($db,$tx,$first,$snapshot);
receiptCheck($row['projection_fingerprint'] === $first->projectionFingerprint() && $row['snapshot_fingerprint'] === $snapshot,
    'receipt binds reviewed projection and native snapshot');
receiptCheck($counts() === [0,0,0], 'uncommitted record and links invisible externally');
$tx->rollback();
receiptCheck($counts() === [0,0,0], 'rollback leaves no receipt, record or links');

$tx = ClawPilotNativeEmailTransaction::begin($db,$profile);
receiptCheck(ClawPilotSharedBpoEmailReceipt::lock($db,$tx,$first) === null,'retry after proven rollback');
$writeFixtureEmail();
receiptCheck(ClawPilotSharedBpoEmailReceipt::record($db,$tx,$first,$snapshot) === $row,'exact committed receipt');
$tx->commit();
receiptCheck($counts() === [1,1,2], 'receipt committed with exactly one record and two links');

$tx = ClawPilotNativeEmailTransaction::begin($db,$profile);
receiptCheck(ClawPilotSharedBpoEmailReceipt::lock($db,$tx,$renewed) === $row,'renewed permit reads original receipt');
receiptHold(fn()=>ClawPilotSharedBpoEmailReceipt::record($db,$tx,$first,$snapshot),'already_committed');
receiptHold(fn()=>ClawPilotSharedBpoEmailReceipt::lock($db,$tx,$globalAlias),'alias');
receiptHold(fn()=>ClawPilotSharedBpoEmailReceipt::lock($db,$tx,$nonceAlias),'alias');
receiptHold(fn()=>ClawPilotSharedBpoEmailReceipt::lock($db,$tx,$changed),'intent_changed');
$tx->rollback();
receiptCheck($counts() === [1,1,2], 'refused alias and retry make no writes');

// Unknown journal schema must refuse rather than treating a missing alias as absence.
$db->query('ALTER TABLE clawpilot_shared_bpo_email_receipts ADD COLUMN unreviewed INT NULL');
$tx = ClawPilotNativeEmailTransaction::begin($db,$profile);
receiptHold(fn()=>ClawPilotSharedBpoEmailReceipt::lock($db,$tx,$first),'schema');
$tx->rollback();

fwrite(STDOUT,"PASS synthetic MariaDB shared BPO Email receipt: exact DDL, atomic visibility, rollback, one commit, retry, nonce/Global ID aliases, drift hold\n");
