<?php
declare(strict_types=1);
// ClawPilot managed native record lifecycle inspection v1. Read-only; no Email or user writes.

final class ClawPilotRecordLifecycleRefused extends RuntimeException {}

final class ClawPilotRecordLifecycle
{
    private static function need(bool $condition): void
    {
        if (!$condition) throw new ClawPilotRecordLifecycleRefused('record_lifecycle_unavailable');
    }

    private static function keys(mixed $value, array $keys): bool
    {
        if (!is_array($value) || array_is_list($value)) return false;
        $actual = array_keys($value); sort($actual); sort($keys);
        return $actual === $keys;
    }

    private static function rows(mysqli $db, string $sql, array $values, int $bound): array
    {
        $statement = $db->prepare($sql);
        self::need($statement !== false);
        try {
            if ($values) self::need($statement->bind_param(str_repeat('s', count($values)), ...$values));
            self::need($statement->execute());
            $result = $statement->get_result();
            self::need($result !== false);
            $rows = [];
            while ($row = $result->fetch_assoc()) {
                $rows[] = $row;
                self::need(count($rows) <= $bound);
            }
            $result->free();
            return $rows;
        } finally { $statement->close(); }
    }

    public static function command(mixed $command): array
    {
        self::need(self::keys($command, ['version', 'records']) && $command['version'] === 1
            && is_array($command['records']) && array_is_list($command['records'])
            && count($command['records']) > 0 && count($command['records']) <= 100);
        $nativeIds = []; $globalIds = [];
        foreach ($command['records'] as $record) {
            self::need(self::keys($record, ['module', 'nativeId', 'globalId'])
                && in_array($record['module'], ['Accounts', 'Contacts'], true)
                && is_string($record['nativeId']) && preg_match('/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/D', $record['nativeId']) === 1
                && is_string($record['globalId']));
            $prefix = $record['module'] === 'Accounts' ? 'ga' : 'gc';
            self::need(preg_match('/^'.$prefix.'(?:[0-9]{7}|[0-9a-v]{12})$/D', $record['globalId']) === 1);
            $nativeKey = $record['module'].':'.strtolower($record['nativeId']);
            self::need(!isset($nativeIds[$nativeKey]) && !isset($globalIds[$record['globalId']]));
            $nativeIds[$nativeKey] = true; $globalIds[$record['globalId']] = true;
        }
        return $command['records'];
    }

    /** Runs only inside OAuth ResourceServerMiddleware. The native token row,
     * not a caller-supplied user or mutable client owner, supplies the subject.
     * All authority and exact-ID reads share one read-only snapshot. */
    public static function inspect(mysqli $db, mixed $command, string $clientId, string $subject, string $tokenId): array
    {
        self::need(getenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED') === '1');
        $records = self::command($command);
        $expected = (string) getenv('SUITECRM_CLIENT_ID');
        self::need($expected !== '' && hash_equals($expected, $clientId)
            && preg_match('/^[a-f0-9]{80}$/D', $tokenId) === 1);
        $state = self::rows($db, 'SELECT @@in_transaction AS active_transaction', [], 1);
        self::need(count($state) === 1 && (int)$state[0]['active_transaction'] === 0);
        $begun = false;
        try {
            // Existing provider transactions must never be committed/rolled back here.
            self::need($db->query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') === true);
            self::need($db->begin_transaction(MYSQLI_TRANS_START_READ_ONLY | MYSQLI_TRANS_START_WITH_CONSISTENT_SNAPSHOT));
            $begun = true;
            $engines = self::rows($db, "SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN
                ('accounts','accounts_cstm','contacts','contacts_cstm','oauth2tokens','oauth2clients','users')", [], 7);
            self::need(count($engines) === 7);
            foreach ($engines as $engine) self::need(strtolower((string)$engine['ENGINE']) === 'innodb');
            $tokens = self::rows($db, 'SELECT t.assigned_user_id,t.client,t.deleted,t.token_is_revoked,
                t.access_token_expires>UTC_TIMESTAMP() AS unexpired,c.assigned_user_id AS client_user_id,
                c.allowed_grant_type,c.deleted AS client_deleted,u.deleted AS user_deleted,u.status,u.is_admin
                FROM oauth2tokens t JOIN oauth2clients c ON c.id=t.client
                JOIN users u ON u.id=t.assigned_user_id WHERE t.access_token=? ORDER BY t.id LIMIT 2', [$tokenId], 2);
            self::need(count($tokens) === 1);
            $token = $tokens[0];
            self::need($token['client'] === $clientId && in_array($token['deleted'], [0,'0'], true)
                && in_array($token['client_deleted'], [0,'0'], true) && in_array($token['user_deleted'], [0,'0'], true)
                && in_array($token['token_is_revoked'], [0,'0'], true) && (int)$token['unexpired'] === 1
                && $token['assigned_user_id'] === $token['client_user_id']
                && is_string($token['assigned_user_id']) && preg_match('/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/D', $token['assigned_user_id']) === 1
                && ($subject === '' ? $token['allowed_grant_type'] === 'client_credentials' : $subject === $token['assigned_user_id'])
                && $token['status'] === 'Active' && in_array($token['is_admin'], [1,'1'], true));
            $snapshots = [];
            foreach ($records as $record) {
                $table = $record['module'] === 'Accounts' ? 'accounts' : 'contacts';
                // Whitelisted table names and exact primary-key lookups only.
                // No names, addresses, bodies, relations, provider scans or writes.
                $rows = self::rows($db, "SELECT b.id,b.deleted,b.date_modified,c.global_id_c
                    FROM {$table} b LEFT JOIN {$table}_cstm c ON c.id_c=b.id
                    WHERE b.id=? LIMIT 2", [$record['nativeId']], 2);
                self::need(count($rows) <= 1);
                if (!$rows) {
                    $snapshots[] = $record + ['state'=>'missing','dateModified'=>null];
                    continue;
                }
                $row = $rows[0];
                self::need($row['id'] === $record['nativeId'] && $row['global_id_c'] === $record['globalId']
                    && in_array($row['deleted'], [0,'0',1,'1'], true) && is_string($row['date_modified']));
                $date = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $row['date_modified'], new DateTimeZone('UTC'));
                self::need($date !== false && $date->format('Y-m-d H:i:s') === $row['date_modified']);
                $snapshots[] = $record + ['state'=>(int)$row['deleted'] === 1 ? 'deleted' : 'active',
                    'dateModified'=>$row['date_modified']];
            }
            return ['version'=>1,'records'=>$snapshots];
        } finally {
            if ($begun) self::need($db->rollback());
        }
    }
}
