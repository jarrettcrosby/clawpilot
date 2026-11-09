<?php
declare(strict_types=1);

require_once __DIR__.'/NativeEmailTransaction.php';

/**
 * Write-time duplicate guard for a reviewed create, not an authorization or
 * writer. Retain this transaction through the create and receipt commit.
 * No content or raw identity is selected. Deleted rows are never ignored.
 */
final class ClawPilotSharedBpoEmailNativeAbsence
{
    // [table, exact index, ordered index columns, compared column].
    private const CORE_INDEXED = [
        ['emails','PRIMARY',['id'],'id'],
        ['emails_text','PRIMARY',['email_id'],'email_id'],
        ['emails_beans','idx_emails_beans_email_bean',['email_id','bean_id','deleted'],'email_id'],
        ['emails_email_addr_rel','idx_eearl_email_id',['email_id','address_type'],'email_id'],
    ];
    private const EXTRA_INDEXED = [
        ['emails','idx_email_parent_id',['parent_id'],'parent_id'],
        ['emails_beans','idx_emails_beans_bean_id',['bean_id'],'bean_id'],
        ['email_addr_bean_rel','idx_bean_id',['bean_id','bean_module'],'bean_id'],
        ['notes','idx_notes_parent',['parent_id','parent_type'],'parent_id'],
        ['attachments_references','idx_attachments_ref_parent_id',['parent_id'],'parent_id'],
        ['attachments_references','idx_attachments_ref_source_record_id',['source_record_id'],'source_record_id'],
    ];
    private const TEMPLATE = ['emails_email_templates','emails_email_templates_ida1',['emails_email_templates_ida'],'emails_email_templates_ida'];
    // Complete PK ranges cover gaps and changes to non-leading/unindexed
    // identifiers. Bounds fail closed; they never become SQL LIMITs.
    private const SCANNED = [
        ['emails_cstm','id_c',['id_c','global_id_c'],5000],
        ['folders_rel','id',['polymorphic_id'],10000],
        ['securitygroups_records','id',['record_id'],10000],
    ];

    /** expectEmailTemplates is pinned by the independently reviewed schema
     * inventory. The operator must exclude concurrent schema changes (metadata
     * reads cannot lock a table that does not yet exist). */
    public static function assertAbsent(mysqli $db, ClawPilotNativeEmailTransaction $tx,
        string $nativeId, string $globalId, bool $expectEmailTemplates): void
    {
        self::lockRanges($db,$tx,$nativeId,$globalId,$expectEmailTemplates);
    }

    /** Complements exact core projection readback after create or on receipt
     * lookup. The caller still owns canonical Email/link/Global ID checks. */
    public static function assertNoExtraSidecars(mysqli $db, ClawPilotNativeEmailTransaction $tx,
        string $nativeId, bool $expectEmailTemplates): void
    {
        self::lockRanges($db,$tx,$nativeId,null,$expectEmailTemplates);
    }

    private static function lockRanges(mysqli $db, ClawPilotNativeEmailTransaction $tx,
        string $nativeId, ?string $globalId, bool $expectEmailTemplates): void
    {
        try {
            self::need(preg_match('/\A[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z/', $nativeId) === 1
                && ($globalId===null || preg_match('/\Agi(?:[0-9]{7}|[0-9a-v]{12})\z/', $globalId) === 1), 'identity');
            $tx->assertConnection($db);
            $indexed = [...($globalId===null?[]:self::CORE_INDEXED),...self::EXTRA_INDEXED];
            if ($expectEmailTemplates) $indexed[] = self::TEMPLATE;
            self::schema($db,$indexed,$expectEmailTemplates);
            foreach ($indexed as [$table,$index,,$column]) {
                // With a pinned leading key and repeatable read, the empty
                // equality range is gap-locked until the caller's commit.
                self::need(self::rows($db,'SELECT 1 AS matched FROM `'.$table.'` FORCE INDEX (`'.$index.'`)'.
                    ' WHERE `'.$column.'`=? LIMIT 1 FOR UPDATE',[$nativeId],1) === [],'identity_or_sidecar_present');
            }
            foreach (self::SCANNED as [$table,$pk,$columns,$cap]) {
                if ($table==='emails_cstm' && $globalId===null) continue;
                $count=self::rows($db,'SELECT COUNT(*) AS total FROM `'.$table.'`',[],1)[0]['total'] ?? null;
                self::need(is_int($count) && $count <= $cap,'row_bound');
                $test=implode(' OR ',array_map(static fn($column)=>'`'.$column.'`=?',$columns));
                $params=$table==='emails_cstm'?[$nativeId,$globalId]:[$nativeId];
                // Do not move the predicate into WHERE: the unfiltered scan
                // deliberately fences every gap even on an empty table.
                self::rows($db,'SELECT IF('.$test.',1,0) AS matched FROM `'.$table.
                    '` FORCE INDEX (PRIMARY) ORDER BY `'.$pk.'` FOR UPDATE',$params,$cap,true);
            }
            self::schema($db,$indexed,$expectEmailTemplates);
            $tx->assertConnection($db);
        } catch (ClawPilotNativeEmailTransactionRefused $error) {
            throw $error;
        } catch (Throwable) {
            self::refuse('unavailable');
        }
    }

    private static function schema(mysqli $db,array $indexed,bool $expectEmailTemplates): void
    {
        $indexes=[]; $columns=[];
        foreach ($indexed as [$table,$index,$keys,$column]) {
            $indexes[$table][$index]=$keys;
            $columns[$table][$column]=$table==='emails_email_templates'?'varchar(36)':'char(36)';
        }
        foreach (self::SCANNED as [$table,$pk,$targets]) {
            $indexes[$table]['PRIMARY']=[$pk];
            $columns[$table][$pk]='char(36)';
            foreach ($targets as $target) $columns[$table][$target]=$target==='global_id_c'?'global':'char(36)';
        }
        $tables=array_keys($indexes);
        $probe=$expectEmailTemplates?$tables:[...$tables,self::TEMPLATE[0]];
        $where=' WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('.implode(',',array_fill(0,count($probe),'?')).')';
        $actual=self::rows($db,'SELECT TABLE_NAME,ENGINE,TABLE_TYPE FROM information_schema.TABLES'.$where,$probe,count($probe));
        self::need(count($actual)===count($tables),'table_profile');
        foreach ($actual as $row) self::need(isset($indexes[$row['TABLE_NAME']])
            && $row['ENGINE']==='InnoDB' && $row['TABLE_TYPE']==='BASE TABLE','table_profile');
        foreach (self::rows($db,'SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,CHARACTER_SET_NAME,COLLATION_NAME,EXTRA'.
            ' FROM information_schema.COLUMNS'.$where,$probe,500) as $row) {
            $table=$row['TABLE_NAME']; $column=$row['COLUMN_NAME'];
            if (!isset($columns[$table][$column])) continue;
            $type=$columns[$table][$column];
            self::need(($type==='global' ? preg_match('/\Avarchar\(([0-9]{2,3})\)\z/',$row['COLUMN_TYPE'],$size)===1
                && (int)$size[1]>=14 && (int)$size[1]<=255 : $row['COLUMN_TYPE']===$type)
                && $row['CHARACTER_SET_NAME']==='utf8mb3' && $row['COLLATION_NAME']==='utf8mb3_general_ci'
                && $row['EXTRA']==='', 'identity_column_profile');
            unset($columns[$table][$column]);
        }
        foreach ($columns as $remaining) self::need($remaining===[],'identity_column_profile');
        $observed=[];
        foreach (self::rows($db,'SELECT TABLE_NAME,INDEX_NAME,COLUMN_NAME,NON_UNIQUE,SUB_PART,INDEX_TYPE,IGNORED'.
            ' FROM information_schema.STATISTICS'.$where.' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX',$probe,500) as $row) {
            $table=$row['TABLE_NAME']; $index=$row['INDEX_NAME'];
            if (!isset($indexes[$table][$index])) continue;
            self::need($row['INDEX_TYPE']==='BTREE' && $row['SUB_PART']===null && $row['IGNORED']==='NO'
                && (int)$row['NON_UNIQUE']===($index==='PRIMARY'?0:1),'index_profile');
            $observed[$table][$index][]=$row['COLUMN_NAME'];
        }
        foreach ($indexes as $table=>$spec) foreach ($spec as $index=>$keys)
            self::need(($observed[$table][$index] ?? null)===$keys,'index_profile');
    }

    private static function rows(mysqli $db,string $sql,array $params,int $cap,bool $scan=false): array
    {
        $statement=$db->prepare($sql);
        self::need($statement instanceof mysqli_stmt,'unavailable');
        try {
            self::need($statement->execute($params),'unavailable');
            if ($scan) {
                self::need($statement->bind_result($match),'unavailable');
                $count=0;
                while (($fetched=$statement->fetch())===true) {
                    self::need(++$count<=$cap,'row_bound');
                    self::need($match===0,'identity_or_sidecar_present');
                }
                self::need($fetched===null,'unavailable');
                return [];
            }
            $result=$statement->get_result();
            self::need($result instanceof mysqli_result,'unavailable');
            try { self::need($result->num_rows<=$cap,'row_bound'); return $result->fetch_all(MYSQLI_ASSOC); }
            finally { $result->free(); }
        } finally { $statement->close(); }
    }

    private static function need(bool $value,string $reason): void { if (!$value) self::refuse($reason); }
    private static function refuse(string $reason): never
    { throw new ClawPilotNativeEmailTransactionRefused('shared_bpo_email_absence_'.$reason); }
}
