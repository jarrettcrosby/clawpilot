<?php
declare(strict_types=1);

// Not autoloaded, installed, routed, or enabled by this file. This primitive
// fences the reviewed native *database* policy tables, not application-DB
// membership, files/hooks/config.php, existing session caches, or Email content
// and ownership rows. A future caller must attest those and lock its records.
// This version makes policy IMMUTABLE through commit, including group-record
// links. It is not yet the publication API that permits a reviewed link delta.
final class ClawPilotNativeEmailTransactionRefused extends RuntimeException
{
    public function __construct(public readonly string $holdCode)
    {
        parent::__construct('Native Email transaction refused: '.$holdCode);
    }
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
    private ?string $sentinel = null;
    private int $startedAt;

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
            $fence->fingerprint = $fence->lockAndHashPolicy();
            // The locking reads now retain metadata locks on policy tables;
            // check the engines/indexes again, without assuming the preflight
            // fenced an intervening DDL change. Filesystem DDL remains excluded.
            $fence->validateSchema();
            $fence->assertActive();
            return $fence;
        } catch (Throwable $error) {
            $fence->abortAfterFailure();
            if ($error instanceof ClawPilotNativeEmailTransactionRefused) throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('database_operation_failed');
        }
    }

    /** Captured only after the whole reviewed policy set is locked; no raw data. */
    public function policyFingerprint(): string { $this->assertActive(); return $this->fingerprint; }
    public static function policyTables(): array { return array_keys(self::TABLES); }

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
            if ($commit && !hash_equals($this->fingerprint, $this->lockAndHashPolicy())) $this->refuse('policy_changed_inside_fence');
            $this->assertActive();
            // This rejects an overdue commit; it is not a promise that PHP can
            // preempt arbitrary caller code and release locks at this instant.
            if ($commit && hrtime(true) - $this->startedAt > self::COMMIT_DEADLINE_SECONDS * 1_000_000_000) $this->refuse('commit_deadline_exceeded');
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

    private function lockAndHashPolicy(): string
    {
        $hash = hash_init('sha256'); $totalBytes = 0;
        foreach (self::TABLES as $table => $cap) {
            // config has no PK in the pinned schema. Its complete nonunique
            // category-index range also covers NULLs and insertion gaps.
            $index = $table === 'config' ? 'idx_config_cat' : 'PRIMARY';
            $order = $table === 'config' ? '`category`,`name`,`value`' : '`id`';
            $result = $this->query('SELECT * FROM `'.$table.'` FORCE INDEX (`'.$index.'`) ORDER BY '.$order.' FOR UPDATE', MYSQLI_USE_RESULT);
            if (!$result instanceof mysqli_result) $this->refuse('policy_result_missing');
            hash_update($hash, $table."\n"); $count = 0;
            try {
                while ($row = $result->fetch_assoc()) {
                    if (++$count > $cap) $this->refuse('policy_row_limit');
                    // Raw user/config values exist only in this local variable;
                    // never expose them, SQL, exception chains, or per-row hashes.
                    $encoded = json_encode($row, JSON_THROW_ON_ERROR);
                    $size = strlen($encoded); $totalBytes += $size;
                    if ($size > self::MAX_ROW_BYTES || $totalBytes > self::MAX_POLICY_BYTES) $this->refuse('policy_byte_limit');
                    hash_update($hash, $size.':'.$encoded."\n");
                }
                if ($this->db->errno !== 0) $this->refuse('policy_scan_failed');
            } finally { $result->free(); }
            hash_update($hash, 'rows:'.$count."\n");
        }
        return hash_final($hash);
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
