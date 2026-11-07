<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailWriteScope.php';

require_once __DIR__.'/NativeEmailTransaction.php';
require_once __DIR__.'/NativeEmailProjection.php';
require_once __DIR__.'/NativeEmailRuntime.php';
require_once __DIR__.'/NativeEmailCapabilityContract.php';

/** Prepared, not routed or enabled. Caller MUST authenticate the exact service
 * principal and retain a durable app admission until a terminal native receipt.
 * A trusted offline binding/identity inventory is required; request labels and
 * supplied reader lists cannot grant authority. No role/membership writes here.
 */
final class ClawPilotNativeEmailPublisher
{
    // The native transaction's complete commit deadline is five seconds. A
    // private permit must cover the subsequent locked policy recheck too.
    private const MAINTENANCE_COMMIT_MARGIN_SECONDS = 6;

    public function __construct(private mysqli $db, private array $profile, private string $callerId,
        private ?string $oauthClientId = null, private ?string $oauthAccessTokenId = null,
        private ?ClawPilotNativeEmailRecoveryDispatchPermit $maintenancePermit = null,
        private ?string $maintenanceDbPrincipal = null, private ?string $maintenancePolicyFingerprint = null) {}

    public function publish(array $command): array { return $this->execute($command, false); }

    /** Read-only CAS preparation. This does not grant an admission or reserve an
     * operation. A later publish revalidates everything under fresh locks.
     */
    public function prepare(array $c): array
    {
        self::validateCommand($c);
        $this->assertMaintenanceEntry($c);
        $hash = $this->maintenancePermit === null ? '' : self::digest($c);
        $tx = ClawPilotNativeEmailTransaction::begin($this->db, $this->profile);
        $stage='storage';
        try {
            $this->assertStorage($tx);
            $stage='caller';
            $this->assertCaller();
            $stage='policy';
            $this->assertMaintenancePolicy($tx);
            $this->assertMaintenanceAction('prepare',$c,$hash);
            $stage='binding';
            $bindings = $this->rows('SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=? FOR UPDATE', [$c['pipelineId']]);
            if (count($bindings) !== 1 || $bindings[0]['workspace_id'] !== $c['workspaceId'] || $bindings[0]['owner_id'] !== $this->callerId) self::refuse('binding_missing');
            $policy=$this->assertBinding($bindings[0], $c, $tx);
            $stage='preimage';
            $existing = $this->rows('SELECT id,deleted FROM emails WHERE id=? FOR UPDATE', [$c['suiteCrmId']]);
            $snapshot = ClawPilotNativeEmailProjection::snapshot($this->db, $tx, $c['suiteCrmId']);
            if ($existing) {
                if ($this->maintenancePermit!==null) self::refuse('native_recovery_dispatch_target_exists');
                $identity=$this->assertIdentity($c);
                $this->assertExistingEmail($c, $bindings[0]);
                if($policy!==null) {
                    $this->assertCapabilityExpected($c,$policy,$identity);
                    $this->assertCapabilities($c,$bindings[0],$c['mode']==='repair');
                }
            } else {
                if ($c['mode'] !== 'publish') self::refuse('missing_previously_managed_email');
                $this->assertCreatePreimage($tx,$c,$snapshot);
                if ($this->lockedIdentityRows($c)) self::refuse('missing_previously_managed_email');
                if($policy!==null)$this->assertCapabilityExpected($c,$policy,null);
            }
            $result = ['version'=>$c['version'],'suiteCrmId'=>$c['suiteCrmId'],'globalId'=>$c['globalId'],'pipelineId'=>$c['pipelineId'],
                'generation'=>$c['generation'],'audienceFingerprint'=>$c['audienceFingerprint'],
                'expectedRecordFingerprint'=>$existing ? $snapshot['fingerprint'] : null];
            $result+=self::capabilityPins($c);
            $this->assertMaintenanceAction('prepare',$c,$hash);
            $tx->rollback();
            return $result;
        } catch (Throwable $error) {
            try{$tx->rollback();}catch(Throwable $ignored){}
            if($error instanceof ClawPilotNativeEmailTransactionRefused)throw $error;
            if($this->maintenancePermit!==null){
                // Only fixed phases and known metadata error categories are
                // available to the private operator. Never include raw errors.
                $reason=$error instanceof mysqli_sql_exception
                    ?match($error->getCode()){1044,1045,1142,1143,1227=>'access_denied',1049,1054,1146=>'schema_changed',default=>'query_failed'}
                    :match($error->getMessage()){'database_metadata_visibility_unproven'=>'metadata_visibility',
                        'database_metadata_principal_unproven'=>'metadata_principal','unknown_database_trigger'=>'trigger_present',
                        'unknown_database_event'=>'event_present','profile_read_failed'=>'metadata_read_failed',
                        'pending_native_relationship_resave'=>'pending_relationship_resave',
                        'Unknown application hooks must hold'=>'application_hooks',
                        'External indexing must be disabled'=>'external_index',
                        default=>$error instanceof TypeError?'type_error':($error instanceof Error?'runtime_error':'held')};
                // Report only bounded hashed source coordinates; never names,
                // arguments, paths, or a raw exception message.
                $frames=[hash('sha256',basename($error->getFile())).':'.$error->getLine()];
                foreach(array_slice($error->getTrace(),0,7) as $frame){
                    if(isset($frame['file'],$frame['line'])&&is_string($frame['file'])&&is_int($frame['line']))
                        $frames[]=hash('sha256',basename($frame['file'])).':'.$frame['line'];
                }
                throw new ClawPilotNativeEmailTransactionRefused('native_recovery_dispatch_prepare_'.$stage.'_'.$reason,'php-origin:'.implode(',',$frames));
            }
            self::refuse('preparation_failed');
        }
    }

    /** Same command and operation ID. Serializes with publish and commits an
     * absent-operation cancellation tombstone. Never interpret a 404 or timeout
     * as cancellation. Existing committed results are not re-executed.
     */
    public function resolveOrCancel(array $command): array { return $this->execute($command, true); }

    private function execute(array $c, bool $cancel): array
    {
        self::validateCommand($c);
        $this->assertMaintenanceEntry($c);
        $action = $cancel ? 'resolve' : 'publish';
        $hash = self::digest($c);
        $tx = ClawPilotNativeEmailTransaction::begin($this->db, $this->profile);
        try {
            $this->assertStorage($tx);
            $this->assertCaller();
            $this->assertMaintenancePolicy($tx);
            $this->assertMaintenanceAction($action,$c,$hash);
            // Policy locks are always first, followed by binding and operation.
            $binding = $this->rows('SELECT * FROM clawpilot_email_bindings WHERE pipeline_id=? FOR UPDATE', [$c['pipelineId']]);
            if (count($binding) !== 1 || $binding[0]['workspace_id'] !== $c['workspaceId'] || $binding[0]['owner_id'] !== $this->callerId) self::refuse('binding_missing');
            $b = $binding[0];
            $previous = $this->rows('SELECT * FROM clawpilot_email_operations WHERE operation_id=? FOR UPDATE', [$c['operationId']]);
            if ($previous) {
                $r = $previous[0];
                if (!hash_equals($r['command_hash'], $hash) || $r['pipeline_id'] !== $c['pipelineId'] || $r['email_id'] !== $c['suiteCrmId']) self::refuse('operation_conflict');
                if (!in_array($r['state'], ['committed','cancelled'], true)) self::refuse('operation_state_invalid');
                if (!$cancel && $this->maintenancePermit!==null) self::refuse('native_recovery_dispatch_resolution_required');
                $result = $r['result_json'] === null ? null : json_decode($r['result_json'], true, 64, JSON_THROW_ON_ERROR);
                // Resolution answers a historical outcome, not current readability
                // or sync completion. Ordinary retries additionally revalidate.
                if (!$cancel && $r['state'] === 'committed') {
                    $policy=$this->assertBinding($b, $c, $tx);
                    $identity=$this->assertIdentity($c);
                    if($policy!==null)$this->assertCapabilityExpected($c,$policy,$identity);
                    $snapshot = ClawPilotNativeEmailProjection::snapshot($this->db, $tx, $c['suiteCrmId']);
                    if (!is_array($result) || ($result['recordFingerprint'] ?? '') !== $snapshot['fingerprint']) self::refuse('retry_record_changed');
                    $this->assertGroup($c['suiteCrmId'], $b['group_id']);
                    if($policy!==null)$this->assertCapabilities($c,$b);
                    else $this->assertReaders($c['suiteCrmId'], $b);
                }
                $this->assertMaintenanceAction($action,$c,$hash,self::MAINTENANCE_COMMIT_MARGIN_SECONDS);
                $tx->commit();
                return ['version'=>$c['version'],'operationId'=>$c['operationId'],'commandHash'=>$hash,'state'=>$r['state'],'replayed'=>true,'result'=>$result];
            }
            if ($cancel) {
                $this->assertMaintenanceAction($action,$c,$hash);
                $this->writeOperation($c, $hash, 'cancelled', null);
                $this->assertMaintenanceAction($action,$c,$hash,self::MAINTENANCE_COMMIT_MARGIN_SECONDS);
                $tx->commit();
                return ['version'=>$c['version'],'operationId'=>$c['operationId'],'commandHash'=>$hash,'state'=>'cancelled','replayed'=>false,'result'=>null];
            }
            $policy=$this->assertBinding($b, $c, $tx);
            $before = ClawPilotNativeEmailProjection::snapshot($this->db, $tx, $c['suiteCrmId']);
            // New capability enrollment is legal only for a genuinely absent
            // native Email. Existing rows require separately reviewed pins.
            $creating = $c['mode'] === 'publish' && $c['expectedRecordFingerprint'] === null;
            if ($creating) $this->assertCreatePreimage($tx,$c,$before);
            if($policy!==null && !$before['exists'])$this->assertCapabilityExpected($c,$policy,null);
            $this->assertMaintenanceAction($action,$c,$hash);
            $identity = $this->assertIdentity($c,$creating);
            if($creating) {
                $this->assertMaintenanceAction($action,$c,$hash);
                ClawPilotNativeEmailWriteScope::newPublication($this->db,$c);
            }
            if($policy!==null) {
                $this->assertCapabilityExpected($c,$policy,$identity);
                if($before['exists']) {
                    $this->assertExistingEmail($c,$b);
                    $this->assertCapabilities($c,$b,$c['mode']==='repair');
                }
            }
            $existingGroups = $this->rows("SELECT * FROM securitygroups_records WHERE module='Emails' AND record_id=? ORDER BY id FOR UPDATE", [$c['suiteCrmId']]);
            if ($existingGroups && (count($existingGroups) !== 1 || $existingGroups[0]['securitygroup_id'] !== $b['group_id'] || (int)$existingGroups[0]['deleted'] !== 0)) self::refuse('unmanaged_email_group');
            if ($c['mode'] === 'repair') {
                if ($c['expectedRecordFingerprint'] === null || !hash_equals($c['expectedRecordFingerprint'], $before['fingerprint'])) self::refuse('historical_record_changed');
                $this->assertExistingEmail($c, $b);
                $projection = null; // Never Email.save(), recreate, or unarchive.
            } else {
                if ((int)$identity['app_archived'] !== 0) self::refuse('archived_publication');
                $this->assertMaintenanceAction($action,$c,$hash);
                $projection = ClawPilotNativeEmailProjection::upsert($this->db, $tx, [
                    'suiteCrmId'=>$c['suiteCrmId'], 'attributes'=>$c['projection']['attributes'],
                    'accounts'=>$c['projection']['accounts'], 'contacts'=>$c['projection']['contacts'],
                    'contactAccounts'=>$c['projection']['contactAccounts'], 'previousManaged'=>$c['projection']['previousManaged'],
                    'expectedBeforeFingerprint'=>$c['expectedRecordFingerprint'],
                ]);
                $this->assertExistingEmail($c, $b);
            }
            if (!$existingGroups) {
                $linkId = create_guid(); $date = gmdate('Y-m-d H:i:s');
                $delta = new ClawPilotNativeEmailGroupRecordInsert($linkId, $c['suiteCrmId'], $c['globalId'], $b['group_id'], $date, $b['owner_id'], $this->callerId);
                $tx->admitEmailGroupRecordInsert($delta);
                $this->assertMaintenanceAction($action,$c,$hash);
                $this->write('INSERT INTO securitygroups_records(id,securitygroup_id,record_id,module,date_modified,deleted) VALUES (?,?,?,?,?,0)',
                    [$linkId,$b['group_id'],$c['suiteCrmId'],'Emails',$date]);
            }
            $this->assertGroup($c['suiteCrmId'], $b['group_id']);
            $readers = $policy!==null ? $this->assertCapabilities($c,$b) : $this->assertReaders($c['suiteCrmId'], $b);
            $after = ClawPilotNativeEmailProjection::snapshot($this->db, $tx, $c['suiteCrmId']);
            if ($c['mode'] === 'repair' && $before !== $after) self::refuse('historical_content_modified');
            if (!hash_equals($b['runtime_fingerprint'], ClawPilotNativeEmailRuntime::attest($this->db))) self::refuse('native_runtime_changed');
            $result = ['version'=>$c['version'],'mode'=>$c['mode'],'suiteCrmId'=>$c['suiteCrmId'],'globalId'=>$c['globalId'],
                'pipelineId'=>$c['pipelineId'],'generation'=>$c['generation'],'audienceFingerprint'=>$c['audienceFingerprint'],
                'recordFingerprint'=>$after['fingerprint'],'readerSuiteCrmUserIds'=>$readers,'projection'=>$projection];
            $result+=self::capabilityPins($c);
            $this->assertMaintenanceAction($action,$c,$hash);
            $this->writeOperation($c, $hash, 'committed', $result);
            $this->assertMaintenanceAction($action,$c,$hash,self::MAINTENANCE_COMMIT_MARGIN_SECONDS);
            $tx->commit();
            return ['version'=>$c['version'],'operationId'=>$c['operationId'],'commandHash'=>$hash,'state'=>'committed','replayed'=>false,'result'=>$result];
        } catch (Throwable $error) {
            try { $tx->rollback(); } catch (Throwable $ignored) {}
            if ($error instanceof ClawPilotNativeEmailTransactionRefused) throw $error;
            self::refuse('publication_failed');
        }
    }

    private function assertMaintenanceEntry(array $c): void
    {
        if ($this->maintenancePermit===null && $this->maintenanceDbPrincipal===null && $this->maintenancePolicyFingerprint===null) return;
        // A verified object is not authority to bypass the public bearer
        // route. Only the immutable root entrypoint may supply private scope.
        $script=$_SERVER['SCRIPT_FILENAME']??null;
        if ($this->maintenancePermit===null || PHP_SAPI!=='cli' || PHP_OS_FAMILY!=='Linux'
            || !function_exists('posix_geteuid') || posix_geteuid()!==0
            || !is_string($script) || realpath($script)!=='/opt/clawpilot/native-email-recovery-cli.php'
            || getenv('CLAWPILOT_NATIVE_INITIAL_MAINTENANCE')!=='1'
            || $this->oauthClientId===null || preg_match('/\A[a-z0-9][a-z0-9-]{0,35}\z/i',$this->oauthClientId)!==1
            || $this->oauthAccessTokenId!==null
            || $this->maintenanceDbPrincipal===null || preg_match('/\A[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@[A-Za-z0-9_.:%-]{1,255}\z/',$this->maintenanceDbPrincipal)!==1
            || $this->maintenancePolicyFingerprint===null || preg_match('/\A[a-f0-9]{64}\z/',$this->maintenancePolicyFingerprint)!==1
            || $c['version']!==2 || $c['mode']!=='publish' || $c['expectedRecordFingerprint']!==null) self::refuse('native_recovery_dispatch_entry_refused');
    }

    private function assertMaintenancePolicy(ClawPilotNativeEmailTransaction $tx): void
    {
        if ($this->maintenancePermit!==null && !hash_equals($this->maintenancePolicyFingerprint??'',$tx->immutablePolicyFingerprint()))
            self::refuse('native_recovery_dispatch_policy_changed');
    }

    private function assertMaintenanceAction(string $action,array $c,string $hash,int $margin=0): void
    {
        if ($this->maintenancePermit===null) return;
        // The same MariaDB connection whose policy/identity locks we hold
        // supplies both the effective account and timezone-independent time.
        $rows=$this->rows('SELECT CURRENT_USER() AS principal, CAST(UNIX_TIMESTAMP() AS UNSIGNED) AS epoch');
        $epoch=$rows[0]['epoch']??null;
        if (count($rows)!==1 || ($rows[0]['principal']??null)!==$this->maintenanceDbPrincipal
            || !(is_int($epoch) || (is_string($epoch)&&ctype_digit($epoch)))
            || (int)$epoch<=0 || (int)$epoch>9007199254740991-$margin) self::refuse('native_recovery_dispatch_connection_changed');
        $now=(int)$epoch;
        $this->maintenancePermit->assertActionCurrent($action,$c['operationId'],$hash,$now);
        if ($margin!==0) $this->maintenancePermit->assertActionCurrent($action,$c['operationId'],$hash,$now+$margin);
    }

    private function assertStorage(ClawPilotNativeEmailTransaction $tx): void
    {
        $tx->assertConnection($this->db);
        $expected=[
            'clawpilot_email_bindings'=>[
                'PRIMARY'=>[0,['pipeline_id']], 'group_id'=>[0,['group_id']],
            ],
            'clawpilot_email_identities'=>[
                'PRIMARY'=>[0,['email_id']], 'global_id'=>[0,['global_id']],
                'local_id'=>[0,['local_id']], 'cp_email_pipeline'=>[1,['pipeline_id']],
            ],
            'clawpilot_email_operations'=>['PRIMARY'=>[0,['operation_id']]],
        ];
        $indexedTypes=[
            'clawpilot_email_bindings'=>['pipeline_id'=>['varchar',64],'group_id'=>['char',36]],
            'clawpilot_email_identities'=>['email_id'=>['char',36],'global_id'=>['varchar',32],
                'local_id'=>['varchar',64],'pipeline_id'=>['varchar',64]],
            'clawpilot_email_operations'=>['operation_id'=>['char',64]],
        ];
        // Opening each real table retains its metadata lock until this same
        // transaction ends. LIMIT 0 reads no receipt/body values; it is not a
        // row/range lock and is never represented as one. DDL cannot swap a
        // checked registry engine/index or install a receipt trigger afterward.
        foreach($expected as $table=>$_) $this->rows('SELECT * FROM '.$table.' LIMIT 0');
        foreach($expected as $table=>$indexes) {
            $engine=$this->rows('SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);
            if(count($engine)!==1 || $engine[0]['ENGINE']!=='InnoDB' || $engine[0]['TABLE_TYPE']!=='BASE TABLE') self::refuse('publication_storage_unproven');
            $actual=[];
            foreach($this->rows('SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',[$table]) as $row) {
                $name=$row['INDEX_NAME'];
                if($row['SUB_PART']!==null || $row['INDEX_TYPE']!=='BTREE' || !isset($indexes[$name])
                    || (int)$row['NON_UNIQUE']!==$indexes[$name][0]) self::refuse('publication_storage_unproven');
                $actual[$name] ??= [(int)$row['NON_UNIQUE'],[]];
                if((int)$row['SEQ_IN_INDEX']!==count($actual[$name][1])+1) self::refuse('publication_storage_unproven');
                $actual[$name][1][]=$row['COLUMN_NAME'];
            }
            ksort($actual,SORT_STRING); ksort($indexes,SORT_STRING);
            if($actual!==$indexes) self::refuse('publication_storage_unproven');
            $columns=$this->rows('SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);
            $checked=[];
            foreach($columns as $column) if(isset($indexedTypes[$table][$column['COLUMN_NAME']])) {
                [$type,$length]=$indexedTypes[$table][$column['COLUMN_NAME']];
                if($column['DATA_TYPE']!==$type || (int)$column['CHARACTER_MAXIMUM_LENGTH']!==$length
                    || $column['CHARACTER_SET_NAME']!=='ascii' || $column['COLLATION_NAME']!=='ascii_bin'
                    || $column['IS_NULLABLE']!=='NO') self::refuse('publication_storage_unproven');
                $checked[]=$column['COLUMN_NAME'];
            }
            if(count($checked)!==count($indexedTypes[$table])) self::refuse('publication_storage_unproven');
        }
        // This shared check also proves sufficient metadata visibility. Merely
        // observing zero visible triggers is not evidence when privileges hide
        // them. It does not require current audience/runtime pins for resolution.
        ClawPilotNativeEmailRuntime::assertDatabaseSideEffectProfile($this->db);
        $tx->assertConnection($this->db);
    }

    private function assertCaller(): void
    {
        $u = $GLOBALS['current_user'] ?? null;
        if (!$u instanceof User || (string)$u->id !== $this->callerId || !$u->isAdmin() || $u->status !== 'Active'
            || DBManagerFactory::getInstance()->database !== $this->db) self::refuse('unauthorized_native_writer');
        // OAuth middleware/native beans may have been hydrated before waiting
        // for policy locks. Revalidate the principal and exact client assignment
        // inside this transaction, including historical outcome resolution.
        $users=$this->rows('SELECT id,status,is_admin,deleted FROM users WHERE id=? FOR UPDATE',[$this->callerId]);
        if(count($users)!==1 || $users[0]['status']!=='Active' || (int)$users[0]['is_admin']!==1 || (int)$users[0]['deleted']!==0) self::refuse('unauthorized_native_writer');
        if($this->oauthClientId===null) {
            if(PHP_SAPI!=='cli') self::refuse('native_client_required');
        } else {
            $clients=$this->rows('SELECT assigned_user_id,deleted FROM oauth2clients WHERE id=? FOR UPDATE',[$this->oauthClientId]);
            if(count($clients)!==1 || (int)$clients[0]['deleted']!==0 || $clients[0]['assigned_user_id']!==$this->callerId) self::refuse('native_client_revoked');
        }
        if($this->oauthAccessTokenId===null) {
            if ($this->maintenancePermit!==null) {
                // Entry and principal proof are separate from the existing
                // active user/client assignment and retained client row lock.
                $this->assertOAuthStorage(['oauth2clients']);
                return;
            }
            // Only the existing explicitly opted-in disposable CLI fixtures
            // exercise the service directly without an authenticated bearer.
            if(PHP_SAPI!=='cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION')!=='1'
                || ($this->profile['database']??null)!=='suitecrm_native_test') self::refuse('native_token_required');
        } else {
            if($this->oauthClientId===null || preg_match('/^[a-f0-9]{80}$/D',$this->oauthAccessTokenId)!==1)
                self::refuse('native_token_revoked');
            // Client-credentials JWTs have an empty subject in the pinned
            // upstream runtime. The persisted token identifies its original
            // principal; never let an old token follow a reassigned client.
            // The same native transaction retains these row/range and metadata
            // locks through content/readback/receipt commit or rollback.
            $tokens=$this->rows('SELECT assigned_user_id,client,deleted,token_is_revoked,access_token_expires>UTC_TIMESTAMP() AS unexpired
                FROM oauth2tokens WHERE access_token=? ORDER BY id LIMIT 2 FOR UPDATE',[$this->oauthAccessTokenId]);
            if(count($tokens)!==1 || (int)$tokens[0]['deleted']!==0 || !in_array($tokens[0]['token_is_revoked'],[0,'0'],true)
                || (int)$tokens[0]['unexpired']!==1 || $tokens[0]['client']!==$this->oauthClientId
                || $tokens[0]['assigned_user_id']!==$this->callerId) self::refuse('native_token_revoked');
            $this->assertOAuthStorage(['oauth2clients','oauth2tokens']);
        }
    }

    private function assertOAuthStorage(array $tables): void
    {
        foreach ($tables as $table) {
            $storage=$this->rows('SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);
            if (count($storage)!==1 || $storage[0]['ENGINE']!=='InnoDB' || $storage[0]['TABLE_TYPE']!=='BASE TABLE')
                self::refuse('native_auth_storage_unproven');
        }
    }

    private function assertBinding(array $b, array $c, ClawPilotNativeEmailTransaction $tx): ?array
    {
        if ((int)$b['enabled'] !== 1 || (int)$b['generation'] !== $c['generation'] || $b['owner_id'] !== $this->callerId
            || !hash_equals($b['audience_fingerprint'], $c['audienceFingerprint'])
            || !hash_equals($b['policy_fingerprint'], $tx->immutablePolicyFingerprint())) self::refuse('binding_or_policy_changed');
        // Stock Administration hydrates the system mailer while loading
        // Maps settings, and attempts to create it if absent. An offline
        // recovery must never create or configure an outbound mailer.
        if($this->maintenancePermit!==null&&count($this->rows("SELECT id FROM outbound_email WHERE type='system' AND deleted=0 ORDER BY id LIMIT 2 FOR UPDATE"))!==1)
            self::refuse('native_recovery_dispatch_system_mailer_unproven');
        // The deployment supplies a reviewed runtime attestor, not a caller
        // boolean. It must cover native source/hook/config files before writes.
        if (!class_exists('ClawPilotNativeEmailRuntime') || !hash_equals($b['runtime_fingerprint'], ClawPilotNativeEmailRuntime::attest($this->db))) self::refuse('native_runtime_changed');
        $members = self::readerIds($b['readers_json']);
        $fingerprint = hash('sha256', json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>$b['owner_id'],
            'allowedSuiteCrmUserIds'=>$members,'workspaceId'=>$b['workspace_id'],'pipelineId'=>$b['pipeline_id']], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
        if (!hash_equals($fingerprint, $b['audience_fingerprint']) || !in_array($b['owner_id'], $members, true)) self::refuse('invalid_native_binding');
        $group = $this->rows('SELECT id,deleted,noninheritable FROM securitygroups WHERE id=?', [$b['group_id']]);
        $actual = $this->rows('SELECT user_id,noninheritable FROM securitygroups_users WHERE securitygroup_id=? AND deleted=0 ORDER BY user_id', [$b['group_id']]);
        if (count($group) !== 1 || (int)$group[0]['deleted'] !== 0 || (int)$group[0]['noninheritable'] !== 1
            || array_column($actual, 'user_id') !== $members || array_filter($actual, static fn($r)=>(int)$r['noninheritable'] !== 1)
            || $this->rows('SELECT id FROM securitygroups_acl_roles WHERE securitygroup_id=? AND deleted=0', [$b['group_id']])) self::refuse('native_group_changed');
        if ($c['mode'] === 'publish' && (($c['projection']['attributes']['assigned_user_id'] ?? '') !== $b['owner_id']
            || ($c['projection']['attributes']['global_id_c'] ?? '') !== $c['globalId'])) self::refuse('publication_identity_changed');
        if($c['version']===1) {
            if(($b['capability_policy_json']??null)!==null || ($b['capability_policy_fingerprint']??null)!==null)
                self::refuse('capability_version_required');
            return null;
        }
        if(!is_string($b['capability_policy_json']??null) || strlen($b['capability_policy_json'])>600000
            || !is_string($b['capability_policy_fingerprint']??null))self::refuse('capability_policy_missing');
        foreach(['clawpilot_email_bindings'=>['capability_policy_json'=>'mediumtext','capability_policy_fingerprint'=>'char'],
            'clawpilot_email_identities'=>['capabilities_json'=>'mediumtext']] as $table=>$expectedColumns) {
            $columns=$this->rows('SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME,IS_NULLABLE
                FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);$found=[];
            foreach($columns as $column)if(isset($expectedColumns[$column['COLUMN_NAME']])) {
                if($column['DATA_TYPE']!==$expectedColumns[$column['COLUMN_NAME']] || $column['IS_NULLABLE']!=='YES'
                    || ($column['COLUMN_NAME']==='capability_policy_fingerprint' && ((int)$column['CHARACTER_MAXIMUM_LENGTH']!==64
                        || $column['CHARACTER_SET_NAME']!=='ascii' || $column['COLLATION_NAME']!=='ascii_bin')))
                    self::refuse('capability_storage_unproven');
                $found[]=$column['COLUMN_NAME'];
            }
            if(count($found)!==count($expectedColumns))self::refuse('capability_storage_unproven');
        }
        $policy=json_decode($b['capability_policy_json'],true,32,JSON_THROW_ON_ERROR);
        if(!is_array($policy) || ($policy['historical']??null)!==[])self::refuse('capability_policy_invalid');
        $principals=array_column($this->rows('SELECT id FROM users WHERE deleted=0 ORDER BY id'),'id');
        $prepared=ClawPilotNativeEmailCapabilityContract::prepare($policy,[
            'binding'=>['pipelineId'=>$b['pipeline_id'],'workspaceId'=>$b['workspace_id'],'ownerSuiteCrmId'=>$b['owner_id'],
                'audienceFingerprint'=>$b['audience_fingerprint'],'allowedReaderSuiteCrmUserIds'=>$members],
            'livePrincipalSuiteCrmUserIds'=>$principals,
            // This approval comes from the locked offline-provisioned binding,
            // never from the publication request. History is target-local.
            'approvedFutureCreate'=>$policy['futureCreate']??null,'liveHistorical'=>[],
        ]);
        if(!hash_equals($prepared['futurePolicyFingerprint'],$b['capability_policy_fingerprint'])
            || !hash_equals($prepared['futurePolicyFingerprint'],$c['capabilityPolicyFingerprint'])
            || $c['principalSuiteCrmUserIds']!==$principals)self::refuse('capability_policy_changed');
        ClawPilotNativeEmailCapabilityContract::validateTarget($c['expectedCapabilities'],$members,$principals);
        return $prepared['contract'];
    }

    private function assertCapabilityExpected(array $c,array $policy,?array $identity): void
    {
        $expected=$policy['futureCreate'];
        if($identity!==null) {
            if(!is_string($identity['capabilities_json']??null) || strlen($identity['capabilities_json'])>600000)
                self::refuse('capability_identity_unreviewed');
            $expected=json_decode($identity['capabilities_json'],true,16,JSON_THROW_ON_ERROR);
            if(!is_array($expected))self::refuse('capability_identity_unreviewed');
        }
        ClawPilotNativeEmailCapabilityContract::validateTarget($expected,$c['expectedCapabilities']['view'],$policy['principalSuiteCrmUserIds']);
        if(!hash_equals(self::digest($expected),self::digest($c['expectedCapabilities'])))self::refuse('capability_expectation_changed');
    }

    private function assertCapabilities(array $c,array $b,bool $writesOnly=false): array
    {
        $principals=array_column($this->rows('SELECT id FROM users WHERE deleted=0 ORDER BY id'),'id');
        if($principals!==$c['principalSuiteCrmUserIds'])self::refuse('capability_principal_inventory_changed');
        $previousUser=$GLOBALS['current_user'];$session=$_SESSION??[];
        $actual=array_fill_keys(ClawPilotNativeEmailCapabilityContract::SURFACES,[]);
        try {
            foreach($principals as $id) {
                $u=BeanFactory::newBean('Users');if(!$u->retrieve($id,false))self::refuse('native_user_missing');
                $GLOBALS['current_user']=$u;$_SESSION=[];ACLAction::getUserActions($id,true);
                $email=BeanFactory::newBean('Emails');if(!$email->retrieve($c['suiteCrmId'],false))self::refuse('native_email_missing');
                foreach(ClawPilotNativeEmailCapabilityContract::SURFACES as $surface)
                    if($email->ACLAccess($surface))$actual[$surface][]=$id;
            }
        } finally {$GLOBALS['current_user']=$previousUser;$_SESSION=$session;}
        ClawPilotNativeEmailCapabilityContract::verifyTargetReadback($c['expectedCapabilities'],self::readerIds($b['readers_json']),$principals,
            ['principalSuiteCrmUserIds'=>$principals,'capabilities'=>$actual],$writesOnly);
        return $actual['view'];
    }

    private static function capabilityPins(array $c): array
    {
        if($c['version']===1)return [];
        return ['capabilityPolicyFingerprint'=>$c['capabilityPolicyFingerprint'],'principalSuiteCrmUserIds'=>$c['principalSuiteCrmUserIds'],
            'expectedCapabilities'=>$c['expectedCapabilities']];
    }

    private function assertIdentity(array $c, bool $allowNew = false): array
    {
        // Historical identity comes from the approved complete inventory. Only
        // a new publication from the authenticated app's durable admission may
        // enroll a new identity; native create-only validation occurs in the same
        // transaction. Existing, archived, and conflicting identities never move.
        $rows = $this->lockedIdentityRows($c);
        if ($allowNew) {
            if ($rows) self::refuse('missing_previously_managed_email');
            $capabilities=$c['version']===2 ? json_encode($c['expectedCapabilities'],JSON_THROW_ON_ERROR) : null;
            if($c['version']===2)$this->write('INSERT INTO clawpilot_email_identities(email_id,global_id,local_id,pipeline_id,workspace_id,app_archived,capabilities_json) VALUES (?,?,?,?,?,0,?)',
                [$c['suiteCrmId'],$c['globalId'],$c['localId'],$c['pipelineId'],$c['workspaceId'],$capabilities]);
            else $this->write('INSERT INTO clawpilot_email_identities(email_id,global_id,local_id,pipeline_id,workspace_id,app_archived) VALUES (?,?,?,?,?,0)',
                [$c['suiteCrmId'],$c['globalId'],$c['localId'],$c['pipelineId'],$c['workspaceId']]);
            return ['email_id'=>$c['suiteCrmId'],'global_id'=>$c['globalId'],'local_id'=>$c['localId'],'pipeline_id'=>$c['pipelineId'],'workspace_id'=>$c['workspaceId'],'app_archived'=>0,'capabilities_json'=>$capabilities];
        }
        if (count($rows) !== 1) self::refuse('identity_missing_or_ambiguous');
        $r = $rows[0];
        if ($r['email_id'] !== $c['suiteCrmId'] || $r['global_id'] !== $c['globalId'] || $r['local_id'] !== $c['localId']
            || $r['pipeline_id'] !== $c['pipelineId'] || $r['workspace_id'] !== $c['workspaceId']) self::refuse('identity_changed');
        ClawPilotNativeEmailWriteScope::assertIdentity($this->db,$r);
        return $r;
    }

    private function assertCreatePreimage(ClawPilotNativeEmailTransaction $tx,array $c,array $snapshot): void
    {
        if (($c['projection']['attributes']['global_id_c'] ?? null) !== $c['globalId']) self::refuse('identity_changed');
        try {
            ClawPilotNativeEmailProjection::assertCreatePreimage($this->db,$tx,$snapshot,$c['suiteCrmId'],$c['globalId'],$c['projection']['previousManaged'] ?? null);
        } catch (ClawPilotNativeEmailProjectionRefused $error) {
            self::refuse($error->holdCode);
        }
        // The policy lock already covers all group records and insertion gaps.
        // A stale link is a collision even if it is deleted, in another module,
        // or happens to name the group this command would otherwise grant.
        if ($this->rows('SELECT id FROM securitygroups_records WHERE record_id=? LIMIT 1 FOR UPDATE',[$c['suiteCrmId']])) self::refuse('orphaned_native_group_record');
    }

    private function lockedIdentityRows(array $c): array
    {
        return $this->rows('SELECT * FROM clawpilot_email_identities WHERE email_id=? OR global_id=? OR local_id=? ORDER BY email_id FOR UPDATE',
            [$c['suiteCrmId'],$c['globalId'],$c['localId']]);
    }

    private function assertExistingEmail(array $c, array $b): void
    {
        $rows = $this->rows('SELECT e.id,e.deleted,e.assigned_user_id,e.created_by,c.global_id_c FROM emails e JOIN emails_cstm c ON c.id_c=e.id WHERE e.id=? FOR UPDATE', [$c['suiteCrmId']]);
        if (count($rows) !== 1 || (int)$rows[0]['deleted'] !== 0 || $rows[0]['assigned_user_id'] !== $b['owner_id']
            || $rows[0]['created_by'] !== $this->callerId || $rows[0]['global_id_c'] !== $c['globalId']) self::refuse('native_identity_or_owner_changed');
        $globals = $this->rows('SELECT id_c FROM emails_cstm WHERE global_id_c=? ORDER BY id_c FOR UPDATE', [$c['globalId']]);
        if (array_column($globals, 'id_c') !== [$c['suiteCrmId']]) self::refuse('duplicate_native_identity');
    }

    private function assertGroup(string $id, string $group): void
    {
        $rows = $this->rows("SELECT securitygroup_id,deleted FROM securitygroups_records WHERE module='Emails' AND record_id=? ORDER BY id", [$id]);
        if (count($rows) !== 1 || $rows[0]['securitygroup_id'] !== $group || (int)$rows[0]['deleted'] !== 0) self::refuse('email_group_changed');
    }

    private function assertReaders(string $id, array $b): array
    {
        $expected = self::readerIds($b['readers_json']);
        $users = $this->rows('SELECT id FROM users WHERE deleted=0 ORDER BY id');
        $previousUser = $GLOBALS['current_user']; $session = $_SESSION ?? [];
        $actual = ['view'=>[],'list'=>[],'export'=>[]];
        try {
            foreach ($users as $row) {
                $u = BeanFactory::newBean('Users');
                if (!$u->retrieve($row['id'], false)) self::refuse('native_user_missing');
                $GLOBALS['current_user'] = $u; $_SESSION = [];
                ACLAction::getUserActions($row['id'], true);
                $email = BeanFactory::newBean('Emails');
                if (!$email->retrieve($id, false)) self::refuse('native_email_missing');
                foreach (array_keys($actual) as $surface) if ($email->ACLAccess($surface)) $actual[$surface][] = $row['id'];
                if (!$u->isAdmin() && $row['id'] !== $b['owner_id'] && ($email->ACLAccess('edit') || $email->ACLAccess('delete'))) self::refuse('unexpected_native_write_access');
            }
            foreach ($actual as $readers) if ($readers !== $expected) self::refuse('unexpected_native_readers');
        } finally { $GLOBALS['current_user'] = $previousUser; $_SESSION = $session; }
        return $expected;
    }

    private function writeOperation(array $c, string $hash, string $state, ?array $result): void
    {
        $json = $result === null ? null : json_encode($result, JSON_THROW_ON_ERROR);
        if ($json !== null && strlen($json) > 800000) self::refuse('receipt_too_large');
        $this->write('INSERT INTO clawpilot_email_operations(operation_id,command_hash,pipeline_id,email_id,state,result_json) VALUES (?,?,?,?,?,?)',
            [$c['operationId'],$hash,$c['pipelineId'],$c['suiteCrmId'],$state,$json]);
    }
    private function rows(string $sql, array $params = []): array
    {
        $s = $this->db->prepare($sql);
        try { if ($params) $s->bind_param(str_repeat('s', count($params)), ...$params); $s->execute(); return $s->get_result()->fetch_all(MYSQLI_ASSOC); }
        finally { $s->close(); }
    }
    private function write(string $sql, array $params): void
    {
        $s = $this->db->prepare($sql);
        try { $s->bind_param(str_repeat('s', count($params)), ...$params); $s->execute(); if ($s->affected_rows !== 1) self::refuse('native_write_not_confirmed'); }
        finally { $s->close(); }
    }
    private static function readerIds(string $json): array
    {
        $ids = json_decode($json, true, 16, JSON_THROW_ON_ERROR);
        if (!is_array($ids) || !array_is_list($ids) || count($ids) > 500 || count($ids) !== count(array_unique($ids))) self::refuse('invalid_readers');
        foreach ($ids as $id) self::id($id);
        $sorted = $ids; sort($sorted, SORT_STRING); if ($sorted !== $ids) self::refuse('unsorted_readers');
        return $ids;
    }
    private static function id($id): void { if (!is_string($id) || !preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/iD', $id)) self::refuse('invalid_identity'); }
    private static function validateCommand(array $c): void
    {
        $keys = array_keys($c); sort($keys);
        $expected = ['version','operationId','mode','workspaceId','pipelineId','generation','audienceFingerprint','suiteCrmId','globalId','localId','expectedRecordFingerprint','projection'];
        if(($c['version']??null)===2)$expected=array_merge($expected,['capabilityPolicyFingerprint','principalSuiteCrmUserIds','expectedCapabilities']);sort($expected);
        if ($keys !== $expected || !in_array($c['version'],[1,2],true) || !in_array($c['mode'], ['publish','repair'], true)
            || !is_int($c['generation']) || $c['generation'] < 1 || $c['generation'] > 9007199254740991) self::refuse('invalid_command');
        foreach (['operationId','audienceFingerprint'] as $key) if (!is_string($c[$key]) || !preg_match('/^[a-f0-9]{64}$/D', $c[$key])) self::refuse('invalid_digest');
        foreach (['workspaceId','pipelineId','suiteCrmId','localId'] as $key) self::id($c[$key]);
        // Native Email and receipt identities are CHAR(36). An overlong key
        // must not reach storage, including the cancellation tombstone path.
        if (strlen($c['suiteCrmId']) > 36) self::refuse('invalid_identity');
        if (!is_string($c['globalId']) || !preg_match('/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D', $c['globalId'])
            || ($c['expectedRecordFingerprint'] !== null && (!is_string($c['expectedRecordFingerprint']) || !preg_match('/^[a-f0-9]{64}$/D', $c['expectedRecordFingerprint'])))
            || ($c['mode'] === 'repair' ? $c['projection'] !== null : !is_array($c['projection']))
            || strlen(json_encode($c, JSON_THROW_ON_ERROR)) > 600000) self::refuse('invalid_payload');
        if($c['version']===2) {
            if(!is_string($c['capabilityPolicyFingerprint']) || preg_match('/^[a-f0-9]{64}$/D',$c['capabilityPolicyFingerprint'])!==1
                || !is_array($c['principalSuiteCrmUserIds']) || !is_array($c['expectedCapabilities'])
                || !is_array($c['expectedCapabilities']['view']??null))self::refuse('invalid_capability_command');
            try {ClawPilotNativeEmailCapabilityContract::validateTarget($c['expectedCapabilities'],$c['expectedCapabilities']['view'],$c['principalSuiteCrmUserIds']);}
            catch(Throwable $error){self::refuse('invalid_capability_command');}
        }
    }
    public static function digest(array $c): string
    {
        $sort = static function ($value) use (&$sort) { if (!is_array($value)) return $value; if (!array_is_list($value)) ksort($value, SORT_STRING); return array_map($sort, $value); };
        return hash('sha256', json_encode($sort($c), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
    }
    private static function refuse(string $code): never { throw new ClawPilotNativeEmailTransactionRefused($code); }
}
