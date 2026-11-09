<?php
declare(strict_types=1);

require_once __DIR__.'/SharedBpoEmailCreatePermit.php';

/** Internal ledger for one create. It neither opens nor commits a transaction.
 * A readback is evidence only after the native snapshot has been verified. */
final class ClawPilotSharedBpoEmailReceipt
{
    private const TABLE = 'clawpilot_shared_bpo_email_receipts';
    private const COLUMNS = ['operation_id','intent_fingerprint','proof_fingerprint','nonce','native_id','global_id',
        'projection_fingerprint','snapshot_fingerprint'];
    private const INDEXES = ['PRIMARY'=>'operation_id','cp_shared_email_global'=>'global_id',
        'cp_shared_email_native'=>'native_id','cp_shared_email_nonce'=>'nonce'];

    /** Takes row/gap locks for all four keys; aliases never count as a receipt. */
    public static function lock(mysqli $db, ClawPilotNativeEmailTransaction $tx, ClawPilotSharedBpoEmailCreatePermit $permit): ?array
    {
        $tx->assertConnection($db);
        $binding = $permit->journalBinding();
        // The first locking read pins table metadata until commit. Validate it
        // before using it as evidence, even if the primary-key row was absent.
        $found = self::lookup($db, 'PRIMARY', $binding['operationId']);
        self::schema($db);
        foreach (['cp_shared_email_global'=>'globalId','cp_shared_email_native'=>'nativeId','cp_shared_email_nonce'=>'nonce'] as $index=>$key) {
            $alias = self::lookup($db, $index, $binding[$key]);
            // A renewed permit may read an existing exact operation. A nonce
            // belonging to another operation may never be used to dispatch.
            self::need($alias === null ? ($key === 'nonce' || $found === null) : $alias === $found, 'alias');
        }
        if ($found !== null) self::need($found['native_id'] === $binding['nativeId'] && $found['global_id'] === $binding['globalId']
            && hash_equals($found['intent_fingerprint'], $binding['intentFingerprint'])
            && hash_equals($found['projection_fingerprint'], $permit->projectionFingerprint()), 'intent_changed');
        $tx->assertConnection($db);
        return $found;
    }

    /** Locked observer for an already dispatched operation. It never needs a
     * renewed create permit, never inserts, and rejects any journal aliases. */
    public static function observe(mysqli $db, ClawPilotNativeEmailTransaction $tx, string $nativeOriginFingerprint,
        string $nativeId, string $globalId, string $projectionFingerprint, string $snapshotFingerprint): ?array
    {
        self::need(self::isHash($nativeOriginFingerprint)&&self::isHash($projectionFingerprint)&&self::isHash($snapshotFingerprint)
            &&preg_match('/\A[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z/',$nativeId)===1
            &&preg_match('/\Agi(?:[0-9]{7}|[0-9a-v]{12})\z/',$globalId)===1,'shape');
        $tx->assertConnection($db);
        $op=ClawPilotNativeEmailAuthorityContract::digest(['clawpilot-shared-bpo-email-create-v1',$nativeOriginFingerprint,$nativeId]);
        $found=self::lookup($db,'PRIMARY',$op);
        self::schema($db);
        self::need(self::lookup($db,'cp_shared_email_native',$nativeId)===$found
            &&self::lookup($db,'cp_shared_email_global',$globalId)===$found,'alias');
        if($found!==null)self::need($found['native_id']===$nativeId&&$found['global_id']===$globalId
            &&hash_equals($found['projection_fingerprint'],$projectionFingerprint)
            &&hash_equals($found['snapshot_fingerprint'],$snapshotFingerprint),'observed_projection_changed');
        $tx->assertConnection($db);
        return $found;
    }

    /** Call after verifying the Email and all links, in the same transaction.
     * On a duplicate or unknown write outcome, roll back and reconcile only. */
    public static function record(mysqli $db, ClawPilotNativeEmailTransaction $tx, ClawPilotSharedBpoEmailCreatePermit $permit,
        string $snapshotFingerprint): array
    {
        self::need(self::isHash($snapshotFingerprint), 'shape');
        self::need(self::lock($db, $tx, $permit) === null, 'already_committed');
        $b = $permit->journalBinding();
        $values = [$b['operationId'],$b['intentFingerprint'],$b['proofFingerprint'],$b['nonce'],$b['nativeId'],$b['globalId'],
            $permit->projectionFingerprint(),$snapshotFingerprint];
        $statement = $db->prepare('INSERT INTO '.self::TABLE.' ('.implode(',',self::COLUMNS).') VALUES (?,?,?,?,?,?,?,?)');
        self::need($statement instanceof mysqli_stmt, 'unavailable');
        try {
            self::need($statement->bind_param('ssssssss', ...$values) && $statement->execute()
                && $statement->affected_rows === 1, 'unavailable');
        } finally { $statement->close(); }
        $stored = self::lock($db, $tx, $permit);
        self::need($stored === array_combine(self::COLUMNS, $values), 'readback');
        return $stored;
    }

    private static function lookup(mysqli $db, string $index, string $value): ?array
    {
        $statement = $db->prepare('SELECT '.implode(',',self::COLUMNS).' FROM '.self::TABLE.' FORCE INDEX (`'.$index.'`) WHERE '
            .self::INDEXES[$index].'=? FOR UPDATE');
        self::need($statement instanceof mysqli_stmt, 'unavailable');
        try {
            self::need($statement->bind_param('s',$value) && $statement->execute(), 'unavailable');
            $result = $statement->get_result();
            self::need($result instanceof mysqli_result, 'unavailable');
            try {
                self::need($result->num_rows <= 1, 'alias');
                $row = $result->fetch_assoc();
                if ($row !== null) foreach (['operation_id','intent_fingerprint','proof_fingerprint','nonce',
                    'projection_fingerprint','snapshot_fingerprint'] as $key) self::need(self::isHash($row[$key]), 'shape');
                return $row;
            } finally { $result->free(); }
        } finally { $statement->close(); }
    }

    private static function schema(mysqli $db): void
    {
        $where = " WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='".self::TABLE."'";
        $table = self::rows($db, 'SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES'.$where);
        self::need($table === [['ENGINE'=>'InnoDB','TABLE_TYPE'=>'BASE TABLE']], 'schema');
        $columns = self::rows($db, 'SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLLATION_NAME,EXTRA FROM information_schema.COLUMNS'.$where.' ORDER BY ORDINAL_POSITION');
        $types = ['native_id'=>'char(36)','global_id'=>'varchar(14)'];
        self::need(count($columns) === count(self::COLUMNS), 'schema');
        foreach (self::COLUMNS as $i=>$name) self::need($columns[$i] === ['COLUMN_NAME'=>$name,'COLUMN_TYPE'=>$types[$name]??'char(64)',
            'IS_NULLABLE'=>'NO','COLUMN_DEFAULT'=>null,'COLLATION_NAME'=>'ascii_bin','EXTRA'=>''], 'schema');
        $indexes = self::rows($db, 'SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE,SEQ_IN_INDEX,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS'.$where.' ORDER BY INDEX_NAME,SEQ_IN_INDEX');
        self::need(count($indexes) === count(self::INDEXES), 'schema');
        foreach ($indexes as $index) self::need((self::INDEXES[$index['INDEX_NAME']]??null) === $index['COLUMN_NAME']
            && (string)$index['NON_UNIQUE'] === '0' && (string)$index['SEQ_IN_INDEX'] === '1'
            && $index['SUB_PART'] === null && $index['INDEX_TYPE'] === 'BTREE', 'schema');
        self::need(self::rows($db, 'SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS'.$where
            ." AND CONSTRAINT_TYPE NOT IN ('PRIMARY KEY','UNIQUE')") === [], 'schema');
    }

    private static function rows(mysqli $db, string $sql): array
    {
        $result = $db->query($sql);
        self::need($result instanceof mysqli_result, 'unavailable');
        try { return $result->fetch_all(MYSQLI_ASSOC); }
        finally { $result->free(); }
    }

    private static function isHash(mixed $value): bool
    { return is_string($value) && preg_match('/\A[a-f0-9]{64}\z/', $value) === 1; }

    private static function need(bool $ok, string $code): void
    { if (!$ok) throw new ClawPilotNativeEmailTransactionRefused('shared_bpo_email_receipt_'.$code); }
}
