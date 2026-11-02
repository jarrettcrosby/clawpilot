<?php
declare(strict_types=1);
// Actual mysqli/read-only-transaction tests against seven SYNTHETIC tables.
// Not a SuiteCRM installation, OAuth HTTP, deployed route, or production proof.
// Run only in an owner-checked disposable MariaDB container with no host ports.
// Fixed DB credentials below are synthetic and intentionally not configurable.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_RECORD_LIFECYCLE_DISPOSABLE_TEST') !== '1') {
    throw new RuntimeException('An explicitly admitted disposable lifecycle fixture is required');
}
require_once __DIR__.'/../../services/suitecrm/record-lifecycle/RecordLifecycle.php';
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$db = new mysqli('db','fixture','Synthetic-record-lifecycle-db-password-only','clawpilot_record_lifecycle_test',3306);
$db->set_charset('utf8mb4');
$tableCount = $db->query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')->fetch_assoc();
if ((int)$tableCount['n'] !== 0) throw new RuntimeException('The exact isolated fixture database must be empty');
$tables = ['accounts','accounts_cstm','contacts','contacts_cstm','oauth2tokens','oauth2clients','users'];
foreach (['accounts','contacts'] as $table) {
    $db->query("CREATE TABLE {$table} (id VARCHAR(64) PRIMARY KEY,deleted TINYINT NOT NULL,date_modified DATETIME NOT NULL) ENGINE=InnoDB");
    $db->query("CREATE TABLE {$table}_cstm (id_c VARCHAR(64) PRIMARY KEY,global_id_c VARCHAR(32) NULL) ENGINE=InnoDB");
}
$db->query('CREATE TABLE users (id VARCHAR(64) PRIMARY KEY,deleted TINYINT NOT NULL,status VARCHAR(32) NOT NULL,is_admin TINYINT NOT NULL) ENGINE=InnoDB');
$db->query('CREATE TABLE oauth2clients (id VARCHAR(64) PRIMARY KEY,assigned_user_id VARCHAR(64) NOT NULL,allowed_grant_type VARCHAR(64) NOT NULL,deleted TINYINT NOT NULL) ENGINE=InnoDB');
$db->query('CREATE TABLE oauth2tokens (id VARCHAR(64) PRIMARY KEY,assigned_user_id VARCHAR(64) NOT NULL,client VARCHAR(64) NOT NULL,
    deleted TINYINT NOT NULL,token_is_revoked TINYINT NOT NULL,access_token_expires DATETIME NOT NULL,access_token CHAR(80) NOT NULL,KEY token_index(access_token)) ENGINE=InnoDB');
$token = str_repeat('a',80); $client = 'fixture-client';
$db->query("INSERT INTO users VALUES ('service-admin',0,'Active',1),('other-admin',0,'Active',1),('regular-user',0,'Active',0)");
$db->query("INSERT INTO oauth2clients VALUES ('fixture-client','service-admin','client_credentials',0),('other-client','other-admin','client_credentials',0)");
$db->query("INSERT INTO oauth2tokens VALUES ('fixture-token','service-admin','fixture-client',0,0,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR),'{$token}')");
$db->query("INSERT INTO accounts VALUES ('native-suburbia',1,'2026-10-30 12:34:56'),('native-bpo',0,'2026-10-30 12:35:56')");
$db->query("INSERT INTO accounts_cstm VALUES ('native-suburbia','ga6i0qmt2qudss'),('native-bpo','gagmco24va588e')");
$db->query("INSERT INTO contacts VALUES ('native-contact',0,'2026-10-30 12:36:56')");
$db->query("INSERT INTO contacts_cstm VALUES ('native-contact','gc1234567')");
putenv('SUITECRM_CLIENT_ID=fixture-client');
putenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=1');
$records = [
    ['module'=>'Accounts','nativeId'=>'native-suburbia','globalId'=>'ga6i0qmt2qudss'],
    ['module'=>'Accounts','nativeId'=>'native-bpo','globalId'=>'gagmco24va588e'],
    ['module'=>'Contacts','nativeId'=>'native-contact','globalId'=>'gc1234567'],
    ['module'=>'Contacts','nativeId'=>'missing-contact','globalId'=>'gc7654321'],
];
$command = ['version'=>1,'records'=>$records];
$checks = 0;
function lifecycle_mariadb_need(bool $condition, string $label): void
{
    if (!$condition) throw new RuntimeException($label);
}
function lifecycle_mariadb_check(string $label, callable $run): void
{
    $run(); $GLOBALS['checks']++;
    fwrite(STDOUT,'PASS '.$label."\n");
}
function lifecycle_mariadb_digest(mysqli $db): string
{
    $rows = [];
    foreach ($GLOBALS['tables'] as $table) {
        $key = str_ends_with($table,'_cstm') ? 'id_c' : 'id';
        $rows[$table] = $db->query("SELECT * FROM {$table} ORDER BY {$key}")->fetch_all(MYSQLI_ASSOC);
    }
    return hash('sha256',json_encode($rows,JSON_THROW_ON_ERROR));
}
function lifecycle_mariadb_refuses(callable $run): void
{
    $db = $GLOBALS['db']; $before = lifecycle_mariadb_digest($db); $refused = false;
    try { $run(); } catch (Throwable $error) { $refused = true; }
    lifecycle_mariadb_need($refused,'Expected exact lifecycle refusal');
    lifecycle_mariadb_need(lifecycle_mariadb_digest($db) === $before,'Read-only refusal changed persisted rows');
    lifecycle_mariadb_need((int)$db->query('SELECT @@in_transaction AS active_transaction')->fetch_assoc()['active_transaction'] === 0,
        'Refused inspection leaked a provider transaction');
}
function lifecycle_mariadb_inspect(?array $command = null, string $subject = '', ?string $client = null, ?string $token = null): array
{
    return ClawPilotRecordLifecycle::inspect($GLOBALS['db'],$command ?? $GLOBALS['command'],$client ?? $GLOBALS['client'],
        $subject,$token ?? $GLOBALS['token']);
}
function lifecycle_mariadb_authority_reset(): void
{
    $db = $GLOBALS['db'];
    $db->query("UPDATE users SET deleted=0,status='Active',is_admin=1 WHERE id='service-admin'");
    $db->query("UPDATE oauth2clients SET assigned_user_id='service-admin',allowed_grant_type='client_credentials',deleted=0 WHERE id='fixture-client'");
    $db->query("UPDATE oauth2tokens SET assigned_user_id='service-admin',client='fixture-client',deleted=0,token_is_revoked=0,
        access_token_expires=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR) WHERE id='fixture-token'");
}

lifecycle_mariadb_check('actual mysqli returns exact active/deleted/missing states without content or writes', function () use ($db,$records) {
    $before = lifecycle_mariadb_digest($db); $result = lifecycle_mariadb_inspect();
    lifecycle_mariadb_need(array_keys($result) === ['version','records'] && $result['version'] === 1,'Unexpected response envelope');
    lifecycle_mariadb_need(array_column($result['records'],'state') === ['deleted','active','active','missing'],'Incorrect lifecycle states');
    foreach ($result['records'] as $index => $record) {
        lifecycle_mariadb_need(array_keys($record) === ['module','nativeId','globalId','state','dateModified'],'Provider fields escaped the projection');
        lifecycle_mariadb_need(array_intersect_key($record,$records[$index]) === $records[$index],'Exact native/global identity changed');
    }
    lifecycle_mariadb_need($result['records'][0]['dateModified'] === '2026-10-30 12:34:56'
        && $result['records'][3]['dateModified'] === null,'Wrong positive or missing evidence date');
    lifecycle_mariadb_need(lifecycle_mariadb_digest($db) === $before,'Inspection changed rows');
    lifecycle_mariadb_need((int)$db->query('SELECT @@in_transaction AS n')->fetch_assoc()['n'] === 0,'Inspection left a transaction open');
    lifecycle_mariadb_need(lifecycle_mariadb_inspect(null,'service-admin') === $result,'Exact OAuth subject was refused');
});
lifecycle_mariadb_check('disabled capability wrong client wrong subject and malformed token refuse', function () {
    putenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=0');
    lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect());
    putenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=1');
    lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect(null,'other-admin'));
    lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect(null,'','other-client'));
    lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect(null,'',null,str_repeat('b',80)));
    lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect(null,'',null,"bad\n"));
});
lifecycle_mariadb_check('persisted token expiration revocation ownership deletion and administrator state all fence reads', function () use ($db) {
    foreach ([
        "UPDATE oauth2tokens SET token_is_revoked=1 WHERE id='fixture-token'",
        "UPDATE oauth2tokens SET access_token_expires=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE id='fixture-token'",
        "UPDATE oauth2tokens SET deleted=1 WHERE id='fixture-token'",
        "UPDATE oauth2tokens SET assigned_user_id='other-admin' WHERE id='fixture-token'",
        "UPDATE oauth2tokens SET client='other-client' WHERE id='fixture-token'",
        "UPDATE oauth2clients SET assigned_user_id='other-admin' WHERE id='fixture-client'",
        "UPDATE oauth2clients SET deleted=1 WHERE id='fixture-client'",
        "UPDATE oauth2clients SET allowed_grant_type='password' WHERE id='fixture-client'",
        "UPDATE users SET is_admin=0 WHERE id='service-admin'",
        "UPDATE users SET status='Inactive' WHERE id='service-admin'",
        "UPDATE users SET deleted=1 WHERE id='service-admin'",
    ] as $change) {
        $db->query($change);
        try { lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect()); }
        finally { lifecycle_mariadb_authority_reset(); }
    }
    $db->query("INSERT INTO oauth2tokens SELECT 'duplicate-token',assigned_user_id,client,deleted,token_is_revoked,access_token_expires,access_token FROM oauth2tokens WHERE id='fixture-token'");
    try { lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect()); }
    finally { $db->query("DELETE FROM oauth2tokens WHERE id='duplicate-token'"); }
});
lifecycle_mariadb_check('global identity mismatch case mismatch and missing custom identity refuse the whole batch', function () use ($db,$command) {
    $bad = $command; $bad['records'][1]['globalId'] = 'ga1234567';
    lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect($bad));
    $bad = $command; $bad['records'][0]['nativeId'] = 'NATIVE-SUBURBIA';
    lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect($bad));
    $db->query("UPDATE contacts_cstm SET global_id_c=NULL WHERE id_c='native-contact'");
    try { lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect()); }
    finally { $db->query("UPDATE contacts_cstm SET global_id_c='gc1234567' WHERE id_c='native-contact'"); }
    $db->query("UPDATE accounts SET deleted=2 WHERE id='native-bpo'");
    try { lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect()); }
    finally { $db->query("UPDATE accounts SET deleted=0 WHERE id='native-bpo'"); }
});
lifecycle_mariadb_check('actual hundred-record bound is complete and rejects a larger batch', function () use ($db) {
    $records = [];
    for ($index=0; $index<100; $index++) {
        $id = 'bound-'.$index; $global = 'ga'.str_pad((string)$index,7,'0',STR_PAD_LEFT);
        $db->query("INSERT INTO accounts VALUES ('{$id}',0,'2026-10-30 13:00:00')");
        $db->query("INSERT INTO accounts_cstm VALUES ('{$id}','{$global}')");
        $records[] = ['module'=>'Accounts','nativeId'=>$id,'globalId'=>$global];
    }
    $before = lifecycle_mariadb_digest($db);
    $result = lifecycle_mariadb_inspect(['version'=>1,'records'=>$records]);
    lifecycle_mariadb_need(count($result['records']) === 100 && array_unique(array_column($result['records'],'state')) === ['active'], 'Bounded inspection lost rows');
    lifecycle_mariadb_need(lifecycle_mariadb_digest($db) === $before,'Hundred-row inspection wrote data');
    $records[] = $GLOBALS['records'][0];
    lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect(['version'=>1,'records'=>$records]));
});
lifecycle_mariadb_check('nontransactional or missing provider table refuses with no partial evidence', function () use ($db) {
    $db->query('ALTER TABLE contacts_cstm ENGINE=MyISAM');
    try { lifecycle_mariadb_refuses(static fn() => lifecycle_mariadb_inspect()); }
    finally { $db->query('ALTER TABLE contacts_cstm ENGINE=InnoDB'); }
    $db->query('RENAME TABLE contacts_cstm TO lifecycle_missing_contacts_cstm');
    $refused = false;
    try { lifecycle_mariadb_inspect(); } catch (Throwable $error) { $refused = true; }
    finally { $db->query('RENAME TABLE lifecycle_missing_contacts_cstm TO contacts_cstm'); }
    lifecycle_mariadb_need($refused,'Missing provider table was not held');
    lifecycle_mariadb_need((int)$db->query('SELECT @@in_transaction AS n')->fetch_assoc()['n'] === 0,'Schema refusal left a transaction open');
});
lifecycle_mariadb_check('incoming transaction is neither committed nor rolled back by refused inspection', function () use ($db) {
    $observer = new mysqli('db','fixture','Synthetic-record-lifecycle-db-password-only','clawpilot_record_lifecycle_test',3306);
    $db->begin_transaction();
    try {
        $db->query("UPDATE accounts SET date_modified='2026-10-30 23:00:00' WHERE id='native-bpo'");
        $refused = false;
        try { lifecycle_mariadb_inspect(); } catch (Throwable $error) { $refused = true; }
        lifecycle_mariadb_need($refused && (int)$db->query('SELECT @@in_transaction AS n')->fetch_assoc()['n'] === 1,'Caller transaction was closed');
        lifecycle_mariadb_need($db->query("SELECT date_modified FROM accounts WHERE id='native-bpo'")->fetch_assoc()['date_modified'] === '2026-10-30 23:00:00','Caller update was rolled back');
        lifecycle_mariadb_need($observer->query("SELECT date_modified FROM accounts WHERE id='native-bpo'")->fetch_assoc()['date_modified'] === '2026-10-30 12:35:56','Caller update was committed');
    } finally { $db->rollback(); $observer->close(); }
});
fwrite(STDOUT,json_encode(['version'=>1,'checks'=>$checks,'actualMysqli'=>true,'syntheticTables'=>7,
    'nativeSuiteCrmOrHttpProven'=>false,'productionProven'=>false],JSON_THROW_ON_ERROR)."\n");
$db->close();
