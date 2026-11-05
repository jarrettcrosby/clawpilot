<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailAuthorityDelta.php';
require_once __DIR__.'/NativeEmailInitialPolicyDelta.php';

// Not autoloaded, installed, routed, or enabled by this file. This primitive
// fences the reviewed native *database* policy tables, not application-DB
// membership, files/hooks/config.php, existing session caches, or Email content
// and ownership rows. A future caller must attest those and lock its records.
// Policy is immutable by default. One pre-admitted, exact new Email group link
// may be allowed; this is not pipeline authorization or a publication endpoint.
final class ClawPilotNativeEmailTransactionRefused extends RuntimeException
{
    // Internal diagnostic is never serialized by a public route. Keep the
    // stable hold code/message separate from operator-only runtime evidence.
    public function __construct(public readonly string $holdCode, public readonly ?string $diagnostic = null)
    {
        parent::__construct('Native Email transaction refused: '.$holdCode);
    }
}

/** The publisher must first authenticate the exact pipeline/group binding and
 * reader set. This value object authorizes no audience by itself. It describes
 * only one new native row, never an update, delete, resurrection, or adoption. */
final class ClawPilotNativeEmailGroupRecordInsert
{
    public function __construct(
        public readonly string $linkId,
        public readonly string $emailId,
        public readonly string $globalId,
        public readonly string $groupId,
        public readonly string $dateModified,
        public readonly string $expectedAssignedUserId,
        public readonly string $expectedCreatedById,
    ) {
        foreach ([$linkId,$emailId,$groupId,$expectedAssignedUserId,$expectedCreatedById] as $id) {
            if (!preg_match('/^[a-z0-9][a-z0-9-]{0,35}$/iD',$id)) $this->invalid();
        }
        if (!preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iD',$linkId)
            || !preg_match('/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D',$globalId)
            || !preg_match('/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/D',$dateModified)) $this->invalid();
        $date = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s',$dateModified,new DateTimeZone('UTC'));
        if (!$date || $date->format('Y-m-d H:i:s') !== $dateModified) $this->invalid();
    }

    /** Exact stock eight-column readback. The native six-column INSERT leaves
     * both nullable audit fields NULL; those are pinned, never ignored. */
    public function nativeRow(): array
    {
        return ['id'=>$this->linkId,'securitygroup_id'=>$this->groupId,'record_id'=>$this->emailId,
            'module'=>'Emails','date_modified'=>$this->dateModified,
            'modified_user_id'=>null,'created_by'=>null,'deleted'=>'0'];
    }
    private function invalid(): never { throw new ClawPilotNativeEmailTransactionRefused('invalid_email_group_delta'); }
}

final class ClawPilotNativeEmailTransaction
{
    // Whole-index locking reads, including deleted rows and both boundary gaps.
    // Never add LIMIT, a deleted filter, or an equality predicate here: empty
    // ranges/new principals/defaults/role grants must be fenced as well.
    private const TABLES = [
        'acl_actions'=>5000, 'acl_roles'=>1000, 'acl_roles_actions'=>10000, 'acl_roles_users'=>10000,
        'aow_actions'=>1000, 'aow_conditions'=>1000, 'aow_workflow'=>1000, 'config'=>1000,
        'securitygroups'=>1000, 'securitygroups_acl_roles'=>10000, 'securitygroups_default'=>1000,
        'securitygroups_records'=>10000, 'securitygroups_users'=>10000, 'users'=>500,
    ];
    private const MAX_POLICY_BYTES = 8388608;
    private const MAX_ROW_BYTES = 65536;
    private const SESSION_TIMEOUT_SECONDS = 2;
    private const COMMIT_DEADLINE_SECONDS = 5;
    private const ISOLATIONS = ['READ-UNCOMMITTED','READ-COMMITTED','REPEATABLE-READ','SERIALIZABLE'];
    private bool $active = false;
    private bool $sessionChanged = false;
    private int $connectionId = 0;
    private array $original = [];
    private string $fingerprint = '';
    private string $immutableFingerprint = '';
    private ?ClawPilotNativeEmailGroupRecordInsert $emailGroupInsert = null;
    private ?ClawPilotNativeEmailAuthorityDelta $authorityMembershipDelta = null;
    private ?ClawPilotNativeEmailInitialPolicyDelta $initialPolicyDelta = null;
    private ?string $sentinel = null;
    private int $startedAt;
    private array $stageMilliseconds=[];

    private function __construct(private mysqli $db, private string $database) { $this->startedAt = hrtime(true); }

    /** Exact, explicitly selected profile only; no autodetection/fallback. */
    public static function begin(mysqli $db, array $profile): self
    {
        $keys = array_keys($profile); sort($keys, SORT_STRING);
        if ($keys !== ['database','profile'] || ($profile['profile'] ?? '') !== 'suitecrm-8.10.1-mariadb-11.4.13-v1'
            || !is_string($profile['database'] ?? null) || !preg_match('/^[a-zA-Z0-9_]{1,64}$/D', $profile['database'])) {
            throw new ClawPilotNativeEmailTransactionRefused('unknown_profile');
        }
        $fence = new self($db, $profile['database']);
        try {
            $state = $fence->state();
            if ((int)$state['active'] !== 0 || (int)$state['autocommit'] !== 1) $fence->refuse('nested_or_manual_transaction');
            if ($state['database_name'] !== $fence->database || !preg_match('/^11\.4\.13-MariaDB(?:-|$)/D', $state['server_version'])
                || !in_array($state['isolation_level'], self::ISOLATIONS, true)) $fence->refuse('unknown_database_profile');
            $fence->connectionId = (int)$state['connection_id'];
            $fence->original = $state;
            $fence->sessionChanged = true;
            $fence->execute('SET SESSION innodb_lock_wait_timeout='.self::SESSION_TIMEOUT_SECONDS);
            $fence->execute('SET SESSION max_statement_time='.self::SESSION_TIMEOUT_SECONDS);
            $fence->execute('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            $fence->validateSchema();
            // Bounded preflight before the full locking scans. The streaming
            // scan repeats bounds, so insertions racing this count fail closed.
            foreach (self::TABLES as $table => $cap) {
                $row = $fence->one('SELECT COUNT(*) AS row_count FROM `'.$table.'`');
                if ((int)$row['row_count'] > $cap) $fence->refuse('policy_row_limit');
            }
            $fence->execute('START TRANSACTION');
            $fence->active = true;
            $fence->installSentinel();
            $fence->assertActive();
            $digests = $fence->lockAndHashPolicy();
            $fence->fingerprint = $digests['full'];
            $fence->immutableFingerprint = $digests['immutable'];
            // The locking reads now retain metadata locks on policy tables;
            // check the engines/indexes again, without assuming the preflight
            // fenced an intervening DDL change. Filesystem DDL remains excluded.
            $fence->validateSchema();
            $fence->assertActive();
            $fence->markStage('policy_fence');
            return $fence;
        } catch (Throwable $error) {
            $fence->abortAfterFailure();
            if ($error instanceof ClawPilotNativeEmailTransactionRefused) throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('database_operation_failed');
        }
    }

    /** Captured only after the whole reviewed policy set is locked; no raw data. */
    public function policyFingerprint(): string { $this->assertActive(); return $this->fingerprint; }
    /** Binding pin: all admitted policy tables EXCEPT securitygroups_records.
     * Does not authorize arbitrary record grants; exact links and effective
     * readers must also be checked on each publication. Never auto-evolve it. */
    public function immutablePolicyFingerprint(): string { $this->assertActive(); return $this->immutableFingerprint; }
    public static function policyTables(): array { return array_keys(self::TABLES); }
    /** Bounded internal timings only: no IDs, records, policy bytes or secrets.
     * This never changes the deadline, lock coverage or admission decisions. */
    public function markStage(string $stage): void
    {
        if(!in_array($stage,['policy_fence','approval','runtime_before','identities','acl_before',
            'memberships','permission_rows','acl_after','runtime_after','receipt','commit_recheck'],true))
            $this->refuse('unknown_timing_stage');
        $this->stageMilliseconds[$stage]=round((hrtime(true)-$this->startedAt)/1_000_000,3);
    }
    public function assertConnection(mysqli $db): void
    {
        if ($db !== $this->db) {
            $this->abortAfterFailure();
            $this->refuse('transaction_connection_mismatch');
        }
        $this->assertActive();
    }

    /** Call after saving/locking the exact Email but BEFORE any link write.
     * No policy mutation can be retrospectively admitted, even a correct link.
     * The method performs only reads/locks; the caller owns the exact INSERT. */
    public function admitEmailGroupRecordInsert(ClawPilotNativeEmailGroupRecordInsert $delta): void
    {
        try {
            $this->assertActive();
            if ($this->emailGroupInsert !== null || $this->authorityMembershipDelta !== null || $this->initialPolicyDelta !== null) $this->refuse('email_group_delta_already_admitted');
            if (!hash_equals($this->fingerprint,$this->lockAndHashPolicy()['full'])) $this->refuse('policy_changed_before_delta_admission');
            $this->assertDeltaIdentity($delta);
            if ($this->rows('SELECT id FROM securitygroups_records WHERE id='.$this->quoted($delta->linkId).' FOR UPDATE')
                || $this->rows('SELECT id FROM securitygroups_records WHERE record_id='.$this->quoted($delta->emailId).' FOR UPDATE')) {
                $this->refuse('email_group_link_not_new');
            }
            $count = $this->one('SELECT COUNT(*) AS row_count FROM securitygroups_records');
            if ((int)$count['row_count'] >= self::TABLES['securitygroups_records']) $this->refuse('policy_row_limit');
            $this->emailGroupInsert = $delta;
            $this->assertActive();
        } catch (Throwable $error) { $this->deltaFailure($error); }
    }

    /** Optional early readback; commit always repeats this check independently. */
    public function assertEmailGroupRecordInsert(): void
    {
        try {
            $this->assertActive();
            $delta = $this->emailGroupInsert;
            if ($delta === null) $this->refuse('email_group_delta_not_admitted');
            $this->assertDeltaIdentity($delta);
            // Include deleted rows and every module. No duplicate, foreign,
            // wrongly typed, or historical soft-deleted link may be adopted.
            $links = $this->rows('SELECT * FROM securitygroups_records WHERE record_id='.$this->quoted($delta->emailId).' ORDER BY id FOR UPDATE');
            if (count($links) !== 1) $this->refuse('email_group_link_readback_mismatch');
            $this->assertExactDeltaRow($links[0],$delta);
        } catch (Throwable $error) { $this->deltaFailure($error); }
    }

    /** Narrow authority-transition integration; never an arbitrary policy-write
     * bypass. The separately authenticated executor prevalidates every binding
     * and capability. Commit substitutes ONLY these exact membership postimages
     * back to their old values and requires the original full-policy digest. */
    public function admitAuthorityMembershipDelta(ClawPilotNativeEmailAuthorityDelta $delta): void
    {
        try {
            $this->assertActive();
            if($this->emailGroupInsert!==null || $this->authorityMembershipDelta!==null || $this->initialPolicyDelta!==null) $this->refuse('authority_delta_already_admitted');
            if(!hash_equals($this->fingerprint,$this->lockAndHashPolicy()['full'])) $this->refuse('policy_changed_before_delta_admission');
            $delta->assertBefore($this->rows('SELECT * FROM securitygroups_users FORCE INDEX (PRIMARY) ORDER BY id FOR UPDATE'));
            $this->authorityMembershipDelta=$delta;
        } catch(Throwable $error) { $this->deltaFailure($error); }
    }

    public function authorityPostPolicyFingerprint(): string
    {
        $this->assertActive();
        if($this->authorityMembershipDelta===null) $this->refuse('authority_delta_not_admitted');
        if(!hash_equals($this->fingerprint,$this->lockAndHashPolicy(null,$this->authorityMembershipDelta)['full']))
            $this->refuse('policy_changed_inside_fence');
        return $this->lockAndHashPolicy()['immutable'];
    }

    /** Initial enrollment only. The separately signed, offline executor must
     * derive and authenticate every typed row before admission. No ordinary
     * publisher/authority path can mix this with its own policy exception. */
    public function admitInitialPolicyDelta(ClawPilotNativeEmailInitialPolicyDelta $delta): void
    {
        try {
            $this->assertActive();
            if($this->emailGroupInsert!==null || $this->authorityMembershipDelta!==null || $this->initialPolicyDelta!==null)
                $this->refuse('initial_delta_already_admitted');
            if(!hash_equals($this->fingerprint,$this->lockAndHashPolicy()['full']))$this->refuse('policy_changed_before_delta_admission');
            // Pure full-scan projection proves every absent/existing preimage.
            $this->lockAndHashPolicy(null,null,[],null,$delta);
            $this->initialPolicyDelta=$delta;
        }catch(Throwable $error){$this->deltaFailure($error);}
    }
    public function projectInitialPolicyDelta(ClawPilotNativeEmailInitialPolicyDelta $delta): array
    {
        $this->assertActive();
        if($this->emailGroupInsert!==null || $this->authorityMembershipDelta!==null || $this->initialPolicyDelta!==null)
            $this->refuse('initial_projection_state');
        if(!hash_equals($this->fingerprint,$this->lockAndHashPolicy()['full']))$this->refuse('policy_changed_before_projection');
        $projected=$this->lockAndHashPolicy(null,null,[],null,$delta);
        if(!hash_equals($this->fingerprint,$this->lockAndHashPolicy()['full']))$this->refuse('policy_changed_during_projection');
        return $projected;
    }
    public function initialPostPolicyFingerprint(): string
    {
        $this->assertActive();
        if($this->initialPolicyDelta===null)$this->refuse('initial_delta_not_admitted');
        if(!hash_equals($this->fingerprint,$this->lockAndHashPolicy(null,null,[],$this->initialPolicyDelta)['full']))
            $this->refuse('policy_changed_inside_fence');
        return $this->lockAndHashPolicy()['immutable'];
    }

    /** Provisional fingerprints for a server-built two-phase membership plan.
     * Raw policy rows never leave this process. No native writes or admitted
     * deltas occur: both stages are pure substitutions in the bounded scan.
     * Execution still requires independent approval and exact live preimages. */
    public function projectAuthorityMembershipPolicies(ClawPilotNativeEmailAuthorityDelta $revoke,
        ClawPilotNativeEmailAuthorityDelta $grant): array
    {
        $this->assertActive();
            if($this->emailGroupInsert!==null || $this->authorityMembershipDelta!==null || $this->initialPolicyDelta!==null
            || $revoke->phase!=='revoke' || $grant->phase!=='grant')$this->refuse('authority_projection_state');
        if(!hash_equals($this->fingerprint,$this->lockAndHashPolicy()['full']))$this->refuse('policy_changed_before_projection');
        $revoked=$this->lockAndHashPolicy(null,null,[$revoke]);
        $granted=$this->lockAndHashPolicy(null,null,[$revoke,$grant]);
        if(!hash_equals($this->fingerprint,$this->lockAndHashPolicy()['full']))$this->refuse('policy_changed_during_projection');
        return ['beforePolicyFingerprint'=>$this->immutableFingerprint,
            'revokePolicyFingerprint'=>$revoked['immutable'],'grantPolicyFingerprint'=>$granted['immutable']];
    }

    private function assertDeltaIdentity(ClawPilotNativeEmailGroupRecordInsert $delta): void
    {
        $groups = $this->rows('SELECT id,deleted,noninheritable FROM securitygroups WHERE id='.$this->quoted($delta->groupId).' FOR UPDATE');
        if (count($groups) !== 1 || $groups[0]['id'] !== $delta->groupId || (string)$groups[0]['deleted'] !== '0'
            || (string)$groups[0]['noninheritable'] !== '1') $this->refuse('email_group_binding_mismatch');
        $emails = $this->rows('SELECT id,assigned_user_id,created_by,deleted FROM emails WHERE id='.$this->quoted($delta->emailId).' FOR UPDATE');
        $identities = $this->rows('SELECT id_c,global_id_c FROM emails_cstm WHERE global_id_c='.$this->quoted($delta->globalId).' ORDER BY id_c LIMIT 2 FOR UPDATE');
        $engines = $this->rows("SELECT TABLE_NAME,ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=".$this->quoted($this->database).
            " AND TABLE_NAME IN ('emails','emails_cstm') ORDER BY TABLE_NAME");
        if (count($engines) !== 2) $this->refuse('email_identity_schema_mismatch');
        foreach ($engines as $table) if ($table['ENGINE'] !== 'InnoDB' || $table['TABLE_TYPE'] !== 'BASE TABLE') $this->refuse('email_identity_schema_mismatch');
        if (count($emails) !== 1 || $emails[0]['id'] !== $delta->emailId || (string)$emails[0]['deleted'] !== '0'
            || $emails[0]['assigned_user_id'] !== $delta->expectedAssignedUserId || $emails[0]['created_by'] !== $delta->expectedCreatedById
            || count($identities) !== 1 || $identities[0]['id_c'] !== $delta->emailId || $identities[0]['global_id_c'] !== $delta->globalId) {
            $this->refuse('email_identity_mismatch');
        }
    }
    private function assertExactDeltaRow(array $row,ClawPilotNativeEmailGroupRecordInsert $delta): void
    {
        $expected = $delta->nativeRow();
        if (count($row) !== count($expected) || array_diff_key($row,$expected)) $this->refuse('email_group_link_readback_mismatch');
        foreach ($expected as $key => $value) {
            if ($value === null) {
                if ($row[$key] !== null) $this->refuse('email_group_link_readback_mismatch');
            } elseif (!is_scalar($row[$key]) || (string)$row[$key] !== $value) $this->refuse('email_group_link_readback_mismatch');
        }
    }
    private function deltaFailure(Throwable $error): never
    {
        $this->abortAfterFailure();
        if ($error instanceof ClawPilotNativeEmailTransactionRefused) throw $error;
        throw new ClawPilotNativeEmailTransactionRefused('email_group_delta_unproven');
    }
    private function quoted(string $value): string { return "'".$this->db->real_escape_string($value)."'"; }

    public function assertActive(): void
    {
        try {
            if (!$this->active) $this->refuse('transaction_not_active');
            $state = $this->state();
            if ((int)$state['connection_id'] !== $this->connectionId || $state['database_name'] !== $this->database
                || (int)$state['active'] !== 1 || (int)$state['autocommit'] !== 1
                || $state['isolation_level'] !== 'REPEATABLE-READ'
                || (int)$state['lock_timeout'] !== self::SESSION_TIMEOUT_SECONDS
                || (float)$state['statement_timeout'] !== (float)self::SESSION_TIMEOUT_SECONDS) {
                $this->refuse('transaction_or_session_changed');
            }
            // COMMIT then START on the same connection still has active=1.
            // A private savepoint cannot survive that transaction replacement.
            // RELEASE (never ROLLBACK TO) tests existence without undoing writes.
            if ($this->sentinel === null) $this->refuse('transaction_sentinel_lost');
            try { $this->execute('RELEASE SAVEPOINT `'.$this->sentinel.'`'); }
            catch (Throwable $error) { $this->refuse('transaction_sentinel_lost'); }
            $this->installSentinel();
        } catch (Throwable $error) {
            $this->abortAfterFailure();
            if ($error instanceof ClawPilotNativeEmailTransactionRefused) throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('transaction_state_unproven');
        }
    }

    private function installSentinel(): void
    {
        $this->sentinel = 'cp_email_policy_'.bin2hex(random_bytes(12));
        $this->execute('SAVEPOINT `'.$this->sentinel.'`');
    }

    public function commit(): void { $this->finish(true); }
    public function rollback(): void { $this->finish(false); }

    private function finish(bool $commit): void
    {
        try {
            $this->assertActive();
            if ($commit && $this->emailGroupInsert !== null) $this->assertEmailGroupRecordInsert();
            if ($commit && !hash_equals($this->fingerprint, $this->lockAndHashPolicy($this->emailGroupInsert,$this->authorityMembershipDelta,[],$this->initialPolicyDelta)['full'])) $this->refuse('policy_changed_inside_fence');
            $this->assertActive();
            // This rejects an overdue commit; it is not a promise that PHP can
            // preempt arbitrary caller code and release locks at this instant.
            if ($commit && hrtime(true) - $this->startedAt > self::COMMIT_DEADLINE_SECONDS * 1_000_000_000) {
                $this->markStage('commit_recheck');
                error_log('CLAWPILOT_NATIVE_DEADLINE_PROFILE='.json_encode($this->stageMilliseconds,JSON_THROW_ON_ERROR));
                $this->refuse('commit_deadline_exceeded');
            }
            $this->execute($commit ? 'COMMIT' : 'ROLLBACK');
            $this->active = false;
            $this->sentinel = null;
            $state = $this->state();
            if ((int)$state['active'] !== 0 || (int)$state['connection_id'] !== $this->connectionId) $this->refuse('transaction_end_unproven');
            $this->restoreSession();
        } catch (Throwable $error) {
            // A lost COMMIT response is an unknown outcome, never a success or
            // a guaranteed rollback. Future callers need durable receipts.
            $this->abortAfterFailure();
            if ($error instanceof ClawPilotNativeEmailTransactionRefused) throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('transaction_end_unproven');
        }
    }

    private function validateSchema(): void
    {
        $name = "'".$this->db->real_escape_string($this->database)."'";
        $tables = $this->rows('SELECT TABLE_NAME,ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA='.$name.' ORDER BY TABLE_NAME');
        $found = [];
        foreach ($tables as $table) {
            if ($table['TABLE_TYPE'] !== 'BASE TABLE' || $table['ENGINE'] !== 'InnoDB') $this->refuse('nontransactional_or_unknown_schema');
            $found[$table['TABLE_NAME']] = true;
        }
        if (count($tables) < 100 || count($tables) > 500) $this->refuse('unknown_schema_size');
        foreach (self::TABLES as $table => $_) {
            if (!isset($found[$table])) $this->refuse('missing_policy_table');
            $index = $table === 'config' ? 'idx_config_cat' : 'PRIMARY';
            $expectedColumn = $table === 'config' ? 'category' : 'id';
            $columns = $this->rows('SELECT COLUMN_NAME,NON_UNIQUE,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='.$name.
                " AND TABLE_NAME='".$table."' AND INDEX_NAME='".$index."' ORDER BY SEQ_IN_INDEX");
            if (count($columns) !== 1 || $columns[0]['COLUMN_NAME'] !== $expectedColumn
                || (int)$columns[0]['NON_UNIQUE'] !== ($table === 'config' ? 1 : 0)
                || $columns[0]['SUB_PART'] !== null || $columns[0]['INDEX_TYPE'] !== 'BTREE') $this->refuse('unknown_policy_index');
        }
    }

    private function lockAndHashPolicy(?ClawPilotNativeEmailGroupRecordInsert $excludedInsert = null,
        ?ClawPilotNativeEmailAuthorityDelta $authorityDelta = null,array $forwardDeltas=[],
        ?ClawPilotNativeEmailInitialPolicyDelta $initialDelta=null,?ClawPilotNativeEmailInitialPolicyDelta $forwardInitial=null): array
    {
        $hash = hash_init('sha256'); $immutable = hash_init('sha256'); $totalBytes = 0;
        foreach (self::TABLES as $table => $cap) {
            // config has no PK in the pinned schema. Its complete nonunique
            // category-index range also covers NULLs and insertion gaps.
            $index = $table === 'config' ? 'idx_config_cat' : 'PRIMARY';
            $order = $table === 'config' ? '`category`,`name`,`value`' : '`id`';
            $result = $this->query('SELECT * FROM `'.$table.'` FORCE INDEX (`'.$index.'`) ORDER BY '.$order.' FOR UPDATE', MYSQLI_USE_RESULT);
            if (!$result instanceof mysqli_result) $this->refuse('policy_result_missing');
            hash_update($hash, $table."\n"); $count = 0; $hashedCount = 0;
            if ($table !== 'securitygroups_records') hash_update($immutable,$table."\n");
            try {
                // Only the membership table needs bounded buffering for an
                // exact old-scan reconstruction. The ordinary publisher path
                // remains byte-for-byte on the existing streaming algorithm.
                if(($table==='securitygroups_users' && ($authorityDelta!==null || $forwardDeltas!==[]))
                    || ($initialDelta!==null && in_array($table,$initialDelta->tables(),true))
                    || ($forwardInitial!==null && in_array($table,$forwardInitial->tables(),true))) {
                    $rows=[];$membershipBytes=0;$columns=array_map(static fn($field)=>$field->name,$result->fetch_fields());
                    while($row=$result->fetch_assoc()) {
                        if(++$count>$cap) $this->refuse('policy_row_limit');
                        $size=strlen(json_encode($row,JSON_THROW_ON_ERROR));$totalBytes+=$size;$membershipBytes+=$size;
                        if($size>self::MAX_ROW_BYTES || $totalBytes>self::MAX_POLICY_BYTES)$this->refuse('policy_byte_limit');
                        $rows[]=$row;
                    }
                    if($this->db->errno!==0)$this->refuse('policy_scan_failed');
                    if($initialDelta!==null)$rows=$initialDelta->restoreBefore($table,$rows);
                    elseif($forwardInitial!==null)$rows=$forwardInitial->projectAfter($table,$rows,$columns);
                    elseif($authorityDelta!==null)$rows=$authorityDelta->restoreBefore($rows);
                    else foreach($forwardDeltas as $delta)$rows=$delta->projectAfter($rows,$columns);
                    $count=count($rows);if($count>$cap)$this->refuse('policy_row_limit');
                    $totalBytes-=$membershipBytes;
                    foreach($rows as $row) {
                        $encoded=json_encode($row,JSON_THROW_ON_ERROR);$size=strlen($encoded);$hashedCount++;
                        $totalBytes+=$size;
                        if($size>self::MAX_ROW_BYTES || $totalBytes>self::MAX_POLICY_BYTES)$this->refuse('policy_byte_limit');
                        hash_update($hash,$size.':'.$encoded."\n");
                        if($table!=='securitygroups_records')hash_update($immutable,$size.':'.$encoded."\n");
                    }
                } else {
                while ($row = $result->fetch_assoc()) {
                    if (++$count > $cap) $this->refuse('policy_row_limit');
                    // Raw user/config values exist only in this local variable;
                    // never expose them, SQL, exception chains, or per-row hashes.
                    $encoded = json_encode($row, JSON_THROW_ON_ERROR);
                    $size = strlen($encoded); $totalBytes += $size;
                    if ($size > self::MAX_ROW_BYTES || $totalBytes > self::MAX_POLICY_BYTES) $this->refuse('policy_byte_limit');
                    if ($table === 'securitygroups_records' && $excludedInsert !== null && ($row['id'] ?? null) === $excludedInsert->linkId) {
                        $this->assertExactDeltaRow($row,$excludedInsert);
                        continue;
                    }
                    $hashedCount++;
                    hash_update($hash, $size.':'.$encoded."\n");
                    if ($table !== 'securitygroups_records') hash_update($immutable,$size.':'.$encoded."\n");
                }
                if ($this->db->errno !== 0) $this->refuse('policy_scan_failed');
                }
            } finally { $result->free(); }
            hash_update($hash, 'rows:'.$hashedCount."\n");
            if ($table !== 'securitygroups_records') hash_update($immutable,'rows:'.$count."\n");
        }
        return ['full'=>hash_final($hash),'immutable'=>hash_final($immutable)];
    }

    private function state(): array
    {
        return $this->one('SELECT CONNECTION_ID() AS connection_id,DATABASE() AS database_name,VERSION() AS server_version,' .
            '@@in_transaction AS active,@@autocommit AS autocommit,@@session.tx_isolation AS isolation_level,' .
            '@@session.innodb_lock_wait_timeout AS lock_timeout,@@session.max_statement_time AS statement_timeout');
    }
    private function restoreSession(): void
    {
        if (!$this->sessionChanged) return;
        $this->execute('SET SESSION TRANSACTION ISOLATION LEVEL '.str_replace('-', ' ', $this->original['isolation_level']));
        $this->execute('SET SESSION innodb_lock_wait_timeout='.(int)$this->original['lock_timeout']);
        $timeout = (float)$this->original['statement_timeout'];
        if (!is_finite($timeout) || $timeout < 0) $this->refuse('session_restore_failed');
        $this->execute('SET SESSION max_statement_time='.sprintf('%.6F', $timeout));
        $this->sessionChanged = false;
    }
    private function abortAfterFailure(): void
    {
        try {
            if ($this->active) {
                $this->execute('ROLLBACK');
                $this->active = false;
                $this->sentinel = null;
            }
            $this->restoreSession();
        } catch (Throwable $ignored) {
            // Do not leave an uncertain native connection reusable by callers.
            try { $this->db->close(); } catch (Throwable $ignoredAgain) {}
            $this->active = false; $this->sessionChanged = false; $this->sentinel = null;
        }
    }
    private function query(string $sql, int $mode = MYSQLI_STORE_RESULT)
    {
        try { $result = $this->db->query($sql, $mode); }
        catch (Throwable $error) { throw new ClawPilotNativeEmailTransactionRefused('database_operation_failed'); }
        if ($result === false) $this->refuse('database_operation_failed');
        return $result;
    }
    private function execute(string $sql): void
    {
        if ($this->query($sql) !== true) $this->refuse('statement_result_unexpected');
    }
    private function rows(string $sql): array
    {
        $result = $this->query($sql);
        if (!$result instanceof mysqli_result) $this->refuse('result_missing');
        try { return $result->fetch_all(MYSQLI_ASSOC); }
        finally { $result->free(); }
    }
    private function one(string $sql): array
    {
        $rows = $this->rows($sql);
        if (count($rows) !== 1) $this->refuse('single_row_required');
        return $rows[0];
    }
    private function refuse(string $code): never { throw new ClawPilotNativeEmailTransactionRefused($code); }
    public function __destruct() { if ($this->active || $this->sessionChanged) $this->abortAfterFailure(); }
}
