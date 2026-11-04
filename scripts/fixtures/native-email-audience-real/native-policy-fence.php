<?php
declare(strict_types=1);

// Disposable native-policy DML test, not a live installer or publisher. Child
// observers deliberately attempt native SQL writes but NEVER commit them.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1'
    || trim((string)file_get_contents('/app/VERSION')) !== '8.10.1') throw new RuntimeException('Pinned synthetic fixture required');
require '/source/email-audience/NativeEmailTransaction.php';

function fenceOutput(array $data): void { fwrite(STDOUT,json_encode($data,JSON_THROW_ON_ERROR)."\n"); fflush(STDOUT); }
function fenceConnection(): mysqli
{
    $db = new mysqli('db','fixture','Synthetic-native-db-password-only','suitecrm_native_test',3306);
    $db->set_charset('utf8mb4');
    $db->query("SET SESSION sql_mode=(SELECT REPLACE(@@sql_mode,'STRICT_TRANS_TABLES',''))");
    return $db;
}
function fenceChildInput(): array
{
    $line = fgets(STDIN);
    if (!is_string($line) || strlen($line) > 8192) throw new RuntimeException('Invalid observer command');
    $input = json_decode($line,true,16,JSON_THROW_ON_ERROR);
    if (!is_array($input)) throw new RuntimeException('Invalid observer command');
    return $input;
}

if (($argv[1] ?? '') === '--observer') {
    $observer = null;
    try {
        $observer = fenceConnection();
        $observer->query('SET SESSION innodb_lock_wait_timeout=1');
        $observer->query('SET SESSION max_statement_time=0');
        fenceOutput(['phase'=>'ready','connectionId'=>$observer->thread_id]);
        $command = fenceChildInput();
        if (($command['phase'] ?? '') === 'hold-user' && is_string($command['id'] ?? null)
            && preg_match('/^[a-z0-9-]{1,64}$/iD',$command['id'])) {
            $observer->begin_transaction();
            $held = $observer->query("SELECT id FROM users WHERE id='".$observer->real_escape_string($command['id'])."' FOR UPDATE");
            if (!$held instanceof mysqli_result || $held->num_rows !== 1) throw new RuntimeException('Exact held user required');
            $held->free(); fenceOutput(['phase'=>'holding-user']);
            if ((fenceChildInput()['phase'] ?? '') !== 'rollback') throw new RuntimeException('Holder never admits commit');
            $observer->rollback(); fenceOutput(['phase'=>'rolled-back']);
            $observer->close(); exit(0);
        }
        if (($command['phase'] ?? '') !== 'attempt' || !is_string($command['sql'] ?? null)) throw new RuntimeException('Invalid observer command');
        $observer->begin_transaction();
        $code = 0;
        try {
            if ($observer->query($command['sql']) === false) $code = $observer->errno;
        } catch (mysqli_sql_exception $error) { $code = $error->getCode(); }
        $observer->rollback();
        fenceOutput(['phase'=>'blocked','errorCode'=>$code]);
        if ($code !== 1205) throw new RuntimeException('Expected actual InnoDB lock timeout');
        if ((fenceChildInput()['phase'] ?? '') !== 'released') throw new RuntimeException('Invalid observer release');
        $observer->begin_transaction();
        if ($observer->query($command['sql']) !== true || $observer->affected_rows !== 1) throw new RuntimeException('Post-release mutation failed');
        fenceOutput(['phase'=>'applied-uncommitted','affected'=>1]);
        if ((fenceChildInput()['phase'] ?? '') !== 'rollback') throw new RuntimeException('Observer never admits commit');
        $observer->rollback();
        fenceOutput(['phase'=>'rolled-back']);
        $observer->close(); exit(0);
    } catch (Throwable $error) {
        if ($observer instanceof mysqli) { try { $observer->rollback(); $observer->close(); } catch (Throwable $ignored) {} }
        // Deliberately exclude SQL and mysqli exception messages.
        fenceOutput(['phase'=>'observer-failed']); exit(1);
    }
}

define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';

function fenceRows(mysqli $db,string $sql): array
{
    $result = $db->query($sql);
    must($result instanceof mysqli_result,'Native fixture result required');
    try { return $result->fetch_all(MYSQLI_ASSOC); } finally { $result->free(); }
}
function fenceQ(mysqli $db,string $value): string { return "'".$db->real_escape_string($value)."'"; }
function fenceSnapshot(mysqli $db): string
{
    $hash = hash_init('sha256');
    foreach (ClawPilotNativeEmailTransaction::policyTables() as $table) {
        $order = $table === 'config' ? 'category,name,value' : 'id';
        hash_update($hash,$table.json_encode(fenceRows($db,'SELECT * FROM '.$table.' ORDER BY '.$order),JSON_THROW_ON_ERROR));
    }
    return hash_final($hash);
}
function fenceSettings(mysqli $db): array
{
    return fenceRows($db,'SELECT @@in_transaction AS active,@@autocommit AS autocommit,@@session.tx_isolation AS isolation_level,'.
        '@@session.innodb_lock_wait_timeout AS lock_timeout,@@session.max_statement_time AS statement_timeout')[0];
}
function fenceRead($pipe): array
{
    $read = [$pipe]; $write = null; $except = null;
    must(stream_select($read,$write,$except,8) === 1,'Bounded observer response required');
    $line = fgets($pipe);
    must(is_string($line) && strlen($line) < 4096,'Bounded observer response required');
    $data = json_decode($line,true,16,JSON_THROW_ON_ERROR);
    must(is_array($data),'Observer response required');
    return $data;
}
function fenceSend($pipe,array $data): void { must(fwrite($pipe,json_encode($data,JSON_THROW_ON_ERROR)."\n") !== false,'Observer command failed'); fflush($pipe); }
function fenceReaders(string $emailId): array
{
    $savedUser = $GLOBALS['current_user']; $savedSession = $_SESSION;
    $result = [];
    try {
        foreach (rows('SELECT id FROM users WHERE deleted=0 ORDER BY id') as $row) {
            selectUser(fresh('Users',$row['id'])); $email = fresh('Emails',$emailId);
            foreach (['view','list','export'] as $surface) if ($email->ACLAccess($surface)) $result[$surface][] = $row['id'];
        }
    } finally { $GLOBALS['current_user']=$savedUser; $_SESSION=$savedSession; }
    return $result;
}

try {
    must(realpath('.') === '/app/public/legacy' && ($GLOBALS['sugar_config']['dbconfig']['db_name'] ?? '') === 'suitecrm_native_test'
        && ($GLOBALS['sugar_config']['dbconfig']['db_host_name'] ?? '') === 'db','Only disposable fixture database admitted');
    $native = DBManagerFactory::getInstance();
    must($native instanceof MysqliManager && $native->database instanceof mysqli,'Actual native mysqli manager required');
    $db = $native->database; $reader = fenceConnection();
    $profile = ['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'];
    $adminId = rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0")[0]['id'];
    $targetId = rows("SELECT id FROM users WHERE user_name='fixture-installed-blank-status-unroled' AND deleted=0")[0]['id'];
    selectUser(fresh('Users',$adminId));
    $emailId = rows("SELECT id FROM emails WHERE name='Synthetic lifecycle history bpo' AND deleted=0")[0]['id'];
    $member = rows('SELECT id,securitygroup_id,user_id FROM securitygroups_users WHERE deleted=0 ORDER BY id LIMIT 1')[0];
    // The stock alternate key includes even soft-deleted role/user links; pick
    // a genuinely absent pair so post-release success proves gap protection.
    $role = rows("SELECT role.id FROM acl_roles role WHERE role.deleted=0 AND NOT EXISTS (SELECT 1 FROM acl_roles_users linked WHERE linked.role_id=role.id AND linked.user_id='".quote($targetId)."') ORDER BY role.id LIMIT 1")[0]['id'];
    $roleLink = rows('SELECT id,role_id,user_id FROM acl_roles_users WHERE deleted=0 ORDER BY id LIMIT 1')[0];
    $action = rows("SELECT id FROM acl_actions WHERE category='Emails' AND name='view' AND acltype='module' AND deleted=0")[0]['id'];
    $config = fenceRows($db,'SELECT category,name FROM config ORDER BY category,name LIMIT 1')[0];
    $baseline = fenceSnapshot($reader); $readers = fenceReaders($emailId); $settings = fenceSettings($db);
    $q = static fn(string $value): string => fenceQ($db,$value);
    $jobs = [
        'new-user-before-first'=>"INSERT INTO users(id,user_name,status,is_admin,deleted) VALUES ('00000000-0000-0000-0000-000000000000','fixture-fence-before','Active',0,0)",
        'new-user-after-last'=>"INSERT INTO users(id,user_name,status,is_admin,deleted) VALUES ('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz','fixture-fence-after','Active',0,0)",
        'user-admin-expansion'=>'UPDATE users SET is_admin=1 WHERE id='.$q($targetId),
        'new-group-membership'=>'INSERT INTO securitygroups_users(id,securitygroup_id,user_id,deleted) VALUES ('.$q(create_guid()).','.$q($member['securitygroup_id']).','.$q($targetId).',0)',
        'group-membership-delete'=>'DELETE FROM securitygroups_users WHERE id='.$q($member['id']),
        'new-role'=>'INSERT INTO acl_roles(id,name,deleted) VALUES ('.$q(create_guid()).",".$q('Synthetic fence uncommitted role').',0)',
        'new-role-assignment'=>'INSERT INTO acl_roles_users(id,role_id,user_id,deleted) VALUES ('.$q(create_guid()).','.$q($role).','.$q($targetId).',0)',
        'role-assignment-delete'=>'DELETE FROM acl_roles_users WHERE id='.$q($roleLink['id']),
        'email-default-update'=>'UPDATE acl_actions SET aclaccess=75 WHERE id='.$q($action),
        'new-record-group'=>'INSERT INTO securitygroups_records(id,securitygroup_id,record_id,module,deleted) VALUES ('.$q(create_guid()).','.$q($member['securitygroup_id']).','.$q($emailId).",'Emails',0)",
        'empty-defaults-range'=>'INSERT INTO securitygroups_default(id,securitygroup_id,module,deleted) VALUES ('.$q(create_guid()).','.$q($member['securitygroup_id']).",'Emails',0)",
        'new-config-category'=>"INSERT INTO config(category,name,value) VALUES ('zz_fixture_fence','synthetic','uncommitted')",
        'config-delete'=>'DELETE FROM config WHERE category='.$q($config['category']).' AND name='.$q($config['name']).' LIMIT 1',
    ];
    must(rows('SELECT id FROM securitygroups_default') === [],'The empty native default-table gap must be exercised');
    check('native policy fence rejects unknown profiles and nesting without taking over caller transaction',function () use ($db,$profile,$settings): void {
        foreach ([['profile'=>'unknown','database'=>'suitecrm_native_test'],['profile'=>$profile['profile'],'database'=>'wrong_database']] as $bad) {
            $refused = false;
            try { ClawPilotNativeEmailTransaction::begin($db,$bad); } catch (ClawPilotNativeEmailTransactionRefused $error) { $refused = true; }
            must($refused && fenceSettings($db) === $settings,'Unknown profile must not change session or start a transaction');
        }
        must($db->query('START TRANSACTION') === true,'Caller transaction must start');
        try {
            $refused = false;
            try { ClawPilotNativeEmailTransaction::begin($db,$profile); } catch (ClawPilotNativeEmailTransactionRefused $error) { $refused = $error->holdCode === 'nested_or_manual_transaction'; }
            must($refused && (int)fenceSettings($db)['active'] === 1,'Nested refusal must leave caller transaction active');
        } finally { $db->query('ROLLBACK'); }
    });
    foreach (['commit','rollback'] as $release) {
        check('native policy row and insertion-gap edits block until '.$release.' with no committed grant leak',function () use ($release,$jobs,$db,$reader,$profile,$settings,$baseline,$readers,$emailId): void {
            foreach ($jobs as $label => $sql) {
                $pipes = []; $process = proc_open([PHP_BINARY,__FILE__,'--observer'],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);
                must(is_resource($process),'Independent PHP observer process required');
                $fence = null;
                try {
                    $ready = fenceRead($pipes[1]);
                    must(($ready['phase'] ?? '') === 'ready' && $ready['connectionId'] !== $db->thread_id,'Observer must use another server connection');
                    $fence = ClawPilotNativeEmailTransaction::begin($db,$profile);
                    must(preg_match('/^[a-f0-9]{64}$/D',$fence->policyFingerprint()) === 1,'Only bounded policy digest may be returned');
                    fenceSend($pipes[0],['phase'=>'attempt','sql'=>$sql]);
                    must(fenceRead($pipes[1]) === ['phase'=>'blocked','errorCode'=>1205],'Actual native lock timeout required for '.$label);
                    $fence->assertActive();
                    must(fenceSnapshot($reader) === $baseline && fenceReaders($emailId) === $readers,'Held native policy must retain exact committed rows/readers');
                    $fence->{$release}(); $fence = null;
                    must(fenceSettings($db) === $settings,'Session settings must be restored after '.$release);
                    fenceSend($pipes[0],['phase'=>'released']);
                    must(fenceRead($pipes[1]) === ['phase'=>'applied-uncommitted','affected'=>1],'Same native edit must succeed only after release: '.$label);
                    must(fenceSnapshot($reader) === $baseline && fenceReaders($emailId) === $readers,'Uncommitted observer mutation must not leak a grant');
                    fenceSend($pipes[0],['phase'=>'rollback']);
                    must(fenceRead($pipes[1]) === ['phase'=>'rolled-back'],'Observer must roll back every attempted mutation');
                } finally {
                    if ($fence !== null) { try { $fence->rollback(); } catch (Throwable $ignored) {} }
                    foreach ($pipes as $pipe) if (is_resource($pipe)) fclose($pipe);
                    $state = proc_get_status($process);
                    if ($state['running']) proc_terminate($process);
                    proc_close($process);
                }
                must(fenceSnapshot($reader) === $baseline,'Native policy rows must remain identical after '.$label);
            }
        });
    }
    check('policy fence detects an implicit transaction end and restores session state',function () use ($db,$profile,$settings): void {
        $fence = ClawPilotNativeEmailTransaction::begin($db,$profile);
        must($db->query('COMMIT') === true,'Synthetic unexpected transaction end required');
        $refused = false;
        try { $fence->commit(); } catch (ClawPilotNativeEmailTransactionRefused $error) { $refused = $error->holdCode === 'transaction_or_session_changed'; }
        must($refused && fenceSettings($db) === $settings,'Unexpected transaction end must not be certified');
    });
    check('private transaction sentinel detects commit followed by restart on the same connection',function () use ($db,$profile,$settings): void {
        $fence = ClawPilotNativeEmailTransaction::begin($db,$profile);
        must($db->query('COMMIT') === true && $db->query('START TRANSACTION') === true,'Synthetic transaction replacement required');
        $refused = false;
        try { $fence->commit(); } catch (ClawPilotNativeEmailTransactionRefused $error) { $refused = $error->holdCode === 'transaction_sentinel_lost'; }
        must($refused && fenceSettings($db) === $settings,'Replacement transaction must be rolled back, not certified');
    });
    check('same-connection policy mutation cannot pass an immutable fence commit',function () use ($db,$reader,$profile,$settings,$baseline,$action,$q): void {
        $fence = ClawPilotNativeEmailTransaction::begin($db,$profile);
        must($db->query('UPDATE acl_actions SET aclaccess=75 WHERE id='.$q($action)) === true && $db->affected_rows === 1,'Synthetic own-connection mutation required');
        $refused = false;
        try { $fence->commit(); } catch (ClawPilotNativeEmailTransactionRefused $error) { $refused = $error->holdCode === 'policy_changed_inside_fence'; }
        must($refused && fenceSettings($db) === $settings && fenceSnapshot($reader) === $baseline,'Policy mutation must roll back without grant leakage');
    });
    check('failed lock acquisition rolls back partial policy locks and restores session settings',function () use ($db,$reader,$profile,$settings,$targetId,$action,$q,$baseline): void {
        $pipes = []; $process = proc_open([PHP_BINARY,__FILE__,'--observer'],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);
        must(is_resource($process),'Independent lock-holder process required');
        try {
            must((fenceRead($pipes[1])['phase'] ?? '') === 'ready','Lock-holder must be ready');
            fenceSend($pipes[0],['phase'=>'hold-user','id'=>$targetId]);
            must(fenceRead($pipes[1]) === ['phase'=>'holding-user'],'Exact late-ordered native policy row must be held');
            $refused = false;
            try { ClawPilotNativeEmailTransaction::begin($db,$profile); }
            catch (ClawPilotNativeEmailTransactionRefused $error) { $refused = true; }
            must($refused && fenceSettings($db) === $settings,'Acquisition failure must end its transaction and restore settings');
            $reader->query('SET SESSION innodb_lock_wait_timeout=1');
            $reader->begin_transaction();
            try {
                must($reader->query('UPDATE acl_actions SET aclaccess=75 WHERE id='.$q($action)) === true && $reader->affected_rows === 1,
                    'Earlier policy table locks must have been released after failed acquisition');
            } finally { $reader->rollback(); }
            fenceSend($pipes[0],['phase'=>'rollback']);
            must(fenceRead($pipes[1]) === ['phase'=>'rolled-back'],'Lock-holder must release without mutations');
        } finally {
            foreach ($pipes as $pipe) if (is_resource($pipe)) fclose($pipe);
            $state = proc_get_status($process); if ($state['running']) proc_terminate($process); proc_close($process);
        }
        must(fenceSnapshot($reader) === $baseline,'Failure-path observer mutation must roll back');
    });
    check('overdue native transaction cannot commit and releases the fence',function () use ($db,$profile,$settings): void {
        $fence = ClawPilotNativeEmailTransaction::begin($db,$profile);
        usleep(5_100_000);
        $refused = false;
        try { $fence->commit(); } catch (ClawPilotNativeEmailTransactionRefused $error) { $refused = $error->holdCode === 'commit_deadline_exceeded'; }
        must($refused && fenceSettings($db) === $settings,'Expired commit must roll back and restore the connection');
    });
    must(fenceSnapshot($reader) === $baseline && fenceReaders($emailId) === $readers,'All native policy and readers must finish unchanged');
    $reader->close();
    fwrite(STDOUT,'CLAWPILOT_NATIVE_POLICY_FENCE='.json_encode(['syntheticOnly'=>true,'productionApplied'=>false,'checks'=>$checks,
        'nativeDmlOnly'=>true,'independentObserverProcess'=>true,'mutationsPerRelease'=>count($jobs),'releaseModes'=>['commit','rollback'],
        'allAttemptedMutationsRolledBack'=>true,'excluded'=>['Email ownership/content record locks','application database','filesystem/runtime policy','cross-database atomicity']],JSON_THROW_ON_ERROR)."\n");
    fwrite(STDOUT,"NATIVE_POLICY_FENCE_PASSED=checks={$checks}; full native policy row/gap DML fence only, no application DB or filesystem guarantee.\n");
} catch (Throwable $error) {
    // Do not expose raw native SQL/errors or policy values.
    fwrite(STDERR,'Native policy fence failed: '.($error instanceof ClawPilotNativeEmailTransactionRefused ? $error->holdCode : get_class($error))."\n");
    exit(1);
}
