<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailTransaction.php';
require_once __DIR__.'/NativeEmailRuntime.php';
require_once __DIR__.'/NativeEmailAuthorityContract.php';
require_once __DIR__.'/NativeEmailCapabilityContract.php';
require_once __DIR__.'/NativeEmailProjection.php';
require_once __DIR__.'/NativeEmailWriteScope.php';
require_once __DIR__.'/NativeEmailInitialInstallationLineage.php';

/** Offline initial enrollment, not a public route or startup action. Source
 * capture, file/config/schema journal and PG admission are separate stages.
 * The caller must maintain maintenance and validate that exact journal; this
 * class independently checks its actual installed runtime and every DB row.
 * A prediction is never a receipt. Only signed execute() can commit; unknown
 * outcomes stay held until resolve() finds the same retained terminal row. */
final class ClawPilotNativeEmailInitialEnrollment
{
    private const SURFACES=['view','list','export','edit','delete'];
    private const PROOF_KEYS=['version','purpose','issuer','audience','keyId','nativeInstanceId','serviceUserId','oauthClientId',
        'issuedAt','expiresAt','operationId','planHash','appGeneration','appSourceFingerprint','preparedAt','deltaFingerprint',
        'sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'];
    public function __construct(private mysqli $db,private array $profile,private string $serviceUserId,private string $oauthClientId) {}

    /** Rollback-only current source observation. Installer must retain this
     * actual stock/ALL/managed-false fingerprint in its protected journal. */
    public function inspectSource(array $mappings): array
    {
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {
            $this->caller();$runtime=ClawPilotNativeEmailRuntime::attestInitialSource($this->db);
            $emails=$this->capture($mappings,$tx);$principals=$this->principals();$capabilities=$this->capabilities($emails,$principals,$tx);
            $result=['version'=>1,'purpose'=>'clawpilot-native-email-initial-source','nativePolicyFingerprint'=>$tx->immutablePolicyFingerprint(),
                'nativeRuntimeFingerprint'=>$runtime,'principalSuiteCrmUserIds'=>$principals,
                'emails'=>array_map(static function($row)use($capabilities){$row['capabilities']=$capabilities[$row['nativeId']];return $row;},$emails),
                'defaults'=>$this->defaultProjection()];
            $tx->rollback();return $result;
        }catch(Throwable $error){$this->rollback($tx);throw $error;}
    }
    /** Actual retained tombstones, never an ancestor before-matrix replay.
     * The optional exact committed plan+authorization is only a history-row
     * exception for startup; it does not attest current bindings/capabilities. */
    public function inspectCancelledHistory(string $expectedNativeInstanceId,?array $allowCommittedCurrent=null): array
    {
        self::id($expectedNativeInstanceId);$tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try{$this->caller();$this->storage();
            if($allowCommittedCurrent===null)$this->emptyDataRegistry();
            else{self::keys($allowCommittedCurrent,['plan','authorization']);self::validatePlan($allowCommittedCurrent['plan']);
                self::need($allowCommittedCurrent['plan']['nativeInstanceId']===$expectedNativeInstanceId,'initial_history_instance');}
            $history=$this->cancelledHistory($expectedNativeInstanceId,$allowCommittedCurrent);
            if($allowCommittedCurrent!==null&&$allowCommittedCurrent['plan']['kind']==='initial_enrollment_replan_v1')
                $this->verifyHistoryContext(ClawPilotNativeEmailInitialInstallationLineage::contextFromLineage(
                    $allowCommittedCurrent['plan']['installationLineage'],$allowCommittedCurrent['plan']['operationId']),
                    $allowCommittedCurrent['plan']['operationId'],$history);
            $result=$this->historyResult($history);$tx->rollback();return $result;
        }catch(Throwable $error){$this->rollback($tx);throw $error;}
    }
    /** Fresh installed-but-unenrolled source after a cancelled ancestor. Root
     * source bytes/journals are verified separately by the immutable installer
     * helper; this reader independently fences actual history/runtime/content. */
    public function inspectInstalledSource(array $mappings,array $context,string $currentOperationId): array
    {
        $context=ClawPilotNativeEmailInitialInstallationLineage::prepareContext($context,$currentOperationId);
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try{$this->caller();$this->storage();$history=$this->emptyRegistry();
            $this->verifyHistoryContext($context,$currentOperationId,$history);
            $runtime=ClawPilotNativeEmailRuntime::attestInitialInstalled($this->db);
            $emails=$this->capture($mappings,$tx);$principals=$this->principals();$capabilities=$this->capabilities($emails,$principals,$tx);
            $result=['version'=>2,'purpose'=>'clawpilot-native-email-initial-installed-source','installationContext'=>$context,
                'nativePolicyFingerprint'=>$tx->immutablePolicyFingerprint(),'nativeRuntimeFingerprint'=>$runtime,'principalSuiteCrmUserIds'=>$principals,
                'emails'=>array_map(static function($row)use($capabilities){$row['capabilities']=$capabilities[$row['nativeId']];return $row;},$emails),
                'defaults'=>$this->defaultProjection()];
            $tx->rollback();return $result;
        }catch(Throwable $error){$this->rollback($tx);throw $error;}
    }
    /** Provisional read-only forecast allows a planner to fill predicted after
     * pins. It is not an approval and cannot execute its own returned delta. */
    public function project(array $plan,string $preparedAt,array $installation): array
    {return $this->readPreparation($plan,$preparedAt,$installation,false);}
    public function prepare(array $plan,string $preparedAt,array $installation): array
    {return $this->readPreparation($plan,$preparedAt,$installation,true);}
    private function readPreparation(array $plan,string $preparedAt,array $installation,bool $strict): array
    {
        self::validatePlan($plan);$tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {$this->caller();$this->storage();$history=$this->emptyRegistry();
            $forecast=$this->forecast($plan,$preparedAt,$installation,$tx,$strict,$history);$tx->rollback();return $forecast;
        }catch(Throwable $error){$this->rollback($tx);throw $error;}
    }
    public function execute(array $plan,array $authorization,array $installation): array
    {
        self::validatePlan($plan);self::need(getenv('CLAWPILOT_NATIVE_INITIAL_MAINTENANCE')==='1','initial_maintenance_required');
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {
            $this->caller();$this->storage();$saved=$this->terminal($plan['operationId']);
            if($saved!==null){$receipt=$this->savedReceipt($plan,$authorization,$saved);
                if($receipt['state']==='cancelled'){$this->verifyCancelledBefore($plan,$authorization,$saved,$tx);self::need(false,'initial_operation_cancelled');}
                $this->verifyCommittedHistory($plan,$authorization);
                $this->verifyAfter($plan,$receipt['result'],$saved['delta_fingerprint'],$tx);$tx->rollback();return $receipt;}
            $history=$this->emptyRegistry();self::keys($authorization,['proof','signature']);
            $preparedAt=$authorization['proof']['preparedAt']??'';self::need(is_string($preparedAt),'initial_approval_date');
            $forecast=$this->forecast($plan,$preparedAt,$installation,$tx,true,$history);
            $this->verifyApproval($plan,$forecast,$authorization,$installation);
            $delta=new ClawPilotNativeEmailInitialPolicyDelta($forecast['nativeDelta']['changes']);
            $tx->admitInitialPolicyDelta($delta);
            foreach($delta->changes as $table=>$changes){
                if($table==='acl_actions')foreach($changes as $change){
                    $this->write('UPDATE acl_actions SET aclaccess=? WHERE id=? AND deleted=0 AND category=\'Emails\' AND acltype=\'module\' AND aclaccess=90',
                        [$change['after']['aclaccess'],$change['after']['id']],1);
                }else $this->insertRows($table,array_column($changes,'after'));
            }
            $this->insertRows('clawpilot_email_bindings',$this->bindings($plan,$forecast['result']['afterPolicyFingerprint'],$forecast['result']['runtimeFingerprint']));
            $identities=[];$permissions=[];$scopes=[];
            foreach($plan['pipelines'] as $pipeline)$scopes[]=['pipeline_id'=>$pipeline['policy']['pipelineId'],
                'operation_id'=>$plan['operationId'],'command_hash'=>$forecast['deltaFingerprint']];
            foreach($plan['emails'] as $pair){$row=$pair['after'];$caps=self::canonical($row['capabilities']);
                $identities[]=['email_id'=>$row['nativeId'],'global_id'=>$row['globalId'],'local_id'=>$row['localId'],
                    'pipeline_id'=>$row['pipelineId'],'workspace_id'=>$row['workspaceId'],'app_archived'=>$row['archived']?'1':'0','capabilities_json'=>$caps];
                $permissions[]=['email_id'=>$row['nativeId'],'pipeline_id'=>$row['pipelineId'],'capabilities_json'=>$caps,
                    'source_kind'=>'authority','operation_id'=>$plan['operationId'],'command_hash'=>$forecast['deltaFingerprint']];
            }
            $this->insertRows('clawpilot_email_identities',$identities);$this->insertRows('clawpilot_email_write_scopes',$scopes);
            $this->insertRows('clawpilot_email_write_permissions',$permissions);
            self::need(hash_equals($forecast['result']['afterPolicyFingerprint'],$tx->initialPostPolicyFingerprint()),'initial_policy_after_changed');
            $this->verifyAfter($plan,$forecast['result'],$forecast['deltaFingerprint'],$tx);
            $receipt=['version'=>1,'purpose'=>'clawpilot-native-email-initial-enrollment-receipt','operationId'=>$plan['operationId'],
                'planHash'=>self::digest($plan),'approvalHash'=>self::digest($authorization),'state'=>'committed','result'=>$forecast['result']];
            $this->insertRows('clawpilot_email_initial_enrollments',[['operation_id'=>$plan['operationId'],'plan_hash'=>$receipt['planHash'],
                'delta_fingerprint'=>$forecast['deltaFingerprint'],'approval_hash'=>$receipt['approvalHash'],
                'approval_json'=>self::canonical($authorization),'receipt_json'=>self::canonical($receipt),'state'=>'committed']]);
            $tx->commit();return $receipt;
        }catch(Throwable $error){$this->rollback($tx);throw $error;}
    }
    /** A missing row is NOT cancellation/non-execution proof. No retry,
     * synthetic receipt, expiry-based unlock or activation is provided here. */
    public function resolve(array $plan,array $authorization): array
    {
        self::validatePlan($plan);$tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {$this->caller();$this->storage();$saved=$this->terminal($plan['operationId']);
            self::need($saved!==null,'initial_outcome_unknown');$receipt=$this->savedReceipt($plan,$authorization,$saved);
            if($receipt['state']==='cancelled')$this->verifyCancelledBefore($plan,$authorization,$saved,$tx);
            else{$this->verifyCommittedHistory($plan,$authorization);$this->verifyAfter($plan,$receipt['result'],$saved['delta_fingerprint'],$tx);}
            $tx->rollback();return $receipt;
        }catch(Throwable $error){$this->rollback($tx);throw $error;}
    }
    /** Explicit expiry settlement, never an automatic timeout unlock. A late
     * execute must serialize behind this same policy fence and then observe
     * the durable tombstone. Existing commits are resolved, never undone. */
    public function cancelExpired(array $plan,array $authorization,array $installation): array
    {
        self::validatePlan($plan);self::need(getenv('CLAWPILOT_NATIVE_INITIAL_MAINTENANCE')==='1','initial_maintenance_required');
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {
            $this->caller();$this->storage();$saved=$this->terminal($plan['operationId']);
            if($saved!==null){$receipt=$this->savedReceipt($plan,$authorization,$saved);
                if($receipt['state']==='cancelled')$this->verifyCancelledBefore($plan,$authorization,$saved,$tx);
                else{$this->verifyCommittedHistory($plan,$authorization);$this->verifyAfter($plan,$receipt['result'],$saved['delta_fingerprint'],$tx);}
                $tx->rollback();return $receipt;}
            $history=$this->emptyRegistry();self::keys($authorization,['proof','signature']);$proof=$authorization['proof'];self::keys($proof,self::PROOF_KEYS);
            self::need(is_int($proof['expiresAt'])&&time()>=$proof['expiresAt'],'initial_approval_not_expired');
            $forecast=$this->forecast($plan,$proof['preparedAt'],$installation,$tx,true,$history);
            $this->verifyApproval($plan,$forecast,$authorization,$installation,true);
            $receipt=['version'=>1,'purpose'=>'clawpilot-native-email-initial-enrollment-receipt','operationId'=>$plan['operationId'],
                'planHash'=>self::digest($plan),'approvalHash'=>self::digest($authorization),'state'=>'cancelled','result'=>null];
            $this->insertRows('clawpilot_email_initial_enrollments',[['operation_id'=>$plan['operationId'],'plan_hash'=>$receipt['planHash'],
                'delta_fingerprint'=>$forecast['deltaFingerprint'],'approval_hash'=>$receipt['approvalHash'],'approval_json'=>self::canonical($authorization),
                'receipt_json'=>self::canonical($receipt),'state'=>'cancelled']]);
            $tx->commit();return $receipt;
        }catch(Throwable $error){$this->rollback($tx);throw $error;}
    }
    private function verifyCancelledBefore(array $plan,array $authorization,array $saved,ClawPilotNativeEmailTransaction $tx): void
    {
        // Retain the old private method name for compatibility, but never
        // reconstruct a cancelled ancestor's obsolete before permissions.
        // savedReceipt already bound this exact plan/authorization; this is
        // an independently signed expired tombstone, not current authority.
        $historical=$this->historicalTerminal($saved,$plan['nativeInstanceId']);
        self::need($historical['state']==='cancelled'&&$historical['entry']['operationId']===$plan['operationId']
            &&$historical['entry']['planHash']===self::digest($plan)&&$historical['entry']['approvalHash']===self::digest($authorization),
            'initial_cancelled_history_changed');
        $tx->immutablePolicyFingerprint(); // Require the actual active fence.
    }
    private function forecast(array $plan,string $preparedAt,array $installation,ClawPilotNativeEmailTransaction $tx,bool $strict,array $history): array
    {
        self::utc($preparedAt);self::keys($installation,['sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint']);
        foreach($installation as $hash)self::hash($hash);
        if($plan['kind']==='initial_enrollment_plan_v1')self::need($history['history']===[],'initial_replan_required');
        self::need(hash_equals($plan['nativeRuntimeBeforeFingerprint'],$installation['sourceRuntimeFingerprint']),'initial_source_journal_changed');
        $installed=ClawPilotNativeEmailRuntime::attestInitialInstalled($this->db);
        self::need(hash_equals($installed,$installation['installedRuntimeFingerprint']),'initial_installed_runtime_changed');
        if($plan['kind']==='initial_enrollment_replan_v1'){
            $lineage=$plan['installationLineage'];$context=ClawPilotNativeEmailInitialInstallationLineage::contextFromLineage($lineage,$plan['operationId']);
            $this->verifyHistoryContext($context,$plan['operationId'],$history);
            self::need(hash_equals($installed,$lineage['freshInstalledRuntimeFingerprint'])
                &&hash_equals($installation['installationJournalFingerprint'],ClawPilotNativeEmailInitialInstallationLineage::effectiveInstallationJournalFingerprint($lineage,$plan['operationId'])),
                'initial_replan_installation_changed');
        }
        self::need(hash_equals($plan['nativePolicyBeforeFingerprint'],$tx->immutablePolicyFingerprint()),'initial_policy_before_changed');
        $principals=$this->principals();self::need($principals===$plan['principalSuiteCrmUserIds'],'initial_principal_changed');
        $emails=$this->capture(array_column($plan['emails'],'before'),$tx);
        $caps=$this->capabilities($emails,$principals,$tx);
        $owners=[];foreach($plan['pipelines'] as $pipeline)$owners[$pipeline['policy']['pipelineId']]=$pipeline['policy']['ownerSuiteCrmId'];
        $ownership=$this->rows('SELECT id,assigned_user_id,created_by FROM emails WHERE id IN ('.implode(',',array_fill(0,count($emails),'?')).') ORDER BY id FOR UPDATE',array_column($emails,'nativeId'),500);
        foreach($plan['emails'] as $index=>$pair){$actual=$emails[$index];$actual['capabilities']=$caps[$actual['nativeId']];
            self::need(self::canonical($actual)===self::canonical($pair['before']),'initial_before_matrix_or_content_changed');
            self::need(($ownership[$index]['id']??null)===$actual['nativeId']&&$ownership[$index]['assigned_user_id']===$owners[$actual['pipelineId']]
                &&$ownership[$index]['created_by']===$owners[$actual['pipelineId']],'initial_bound_owner_changed');}
        $delta=$this->delta($plan,$preparedAt);$projected=$tx->projectInitialPolicyDelta($delta);
        $runtime=ClawPilotNativeEmailRuntime::projectInitialAfter($this->db);
        if($strict)self::need(hash_equals($projected['immutable'],$plan['nativePolicyAfterFingerprint'])
            &&hash_equals($runtime,$plan['nativeRuntimeAfterFingerprint']),'initial_forecast_changed');
        $bindings=$this->bindings($plan,$projected['immutable'],$runtime);$policies=[];
        foreach($plan['pipelines'] as $pipeline){$p=$pipeline['policy'];$future=$p;unset($future['historical']);
            $policies[]=['pipelineId'=>$p['pipelineId'],'generation'=>$plan['appGeneration'],'policy'=>$p,'fingerprint'=>self::digest($future)];}
        $result=['generation'=>$plan['appGeneration'],'appSourceFingerprint'=>$plan['appSourceFingerprint'],
            'beforePolicyFingerprint'=>$plan['nativePolicyBeforeFingerprint'],'afterPolicyFingerprint'=>$projected['immutable'],
            'sourceRuntimeFingerprint'=>$installation['sourceRuntimeFingerprint'],'installedRuntimeFingerprint'=>$installed,'runtimeFingerprint'=>$runtime,
            'identityFingerprint'=>self::digest(array_map(static fn($pair)=>self::identity($pair['after']),$plan['emails'])),
            'capabilitiesFingerprint'=>self::digest(array_map(static fn($pair)=>['emailId'=>$pair['after']['nativeId'],
                'globalId'=>$pair['after']['globalId'],'pipelineId'=>$pair['after']['pipelineId'],'capabilities'=>$pair['after']['capabilities']],$plan['emails'])),
            'bindingsFingerprint'=>self::digest($bindings),'defaultsFingerprint'=>self::digest(array_column($plan['defaults'],'after')),
            'emailCount'=>count($plan['emails']),'principalCount'=>count($principals)];
        $nativeDelta=['version'=>1,'purpose'=>'clawpilot-native-email-initial-policy-delta','operationId'=>$plan['operationId'],
            'planHash'=>self::digest($plan),'preparedAt'=>$preparedAt,'changes'=>$delta->changes,'result'=>$result,'policies'=>$policies];
        return ['version'=>1,'purpose'=>'clawpilot-native-email-initial-enrollment-forecast','operationId'=>$plan['operationId'],
            'planHash'=>self::digest($plan),'preparedAt'=>$preparedAt,'deltaFingerprint'=>self::digest($nativeDelta),
            'nativeDelta'=>$nativeDelta,'result'=>$result,'policies'=>$policies];
    }
    private function delta(array $plan,string $stamp): ClawPilotNativeEmailInitialPolicyDelta
    {
        $changes=['acl_actions'=>[],'securitygroups'=>[],'securitygroups_users'=>[],'securitygroups_records'=>[]];
        $rows=$this->rows("SELECT * FROM acl_actions WHERE category='Emails' AND acltype='module' AND deleted=0 AND name IN ('view','list','export','edit','delete') ORDER BY name FOR UPDATE");
        self::need(count($rows)===5,'initial_default_inventory');
        foreach($plan['defaults'] as $index=>$pair){$row=$rows[$index];
            self::need($row['id']===$pair['before']['id']&&$row['name']===$pair['before']['action']&&(int)$row['aclaccess']===$pair['before']['aclAccess'],'initial_default_changed');
            $after=$row;$after['aclaccess']=(string)$pair['after']['aclAccess'];$changes['acl_actions'][]=['before'=>$row,'after'=>$after];}
        $groups=[];
        foreach($plan['pipelines'] as $pipeline){$p=$pipeline['policy'];$group=$pipeline['groupId'];$groups[$p['pipelineId']]=$group;
            $changes['securitygroups'][]=['before'=>null,'after'=>['id'=>$group,'name'=>'ClawPilot Emails '.$p['pipelineId'],
                'date_entered'=>$stamp,'date_modified'=>$stamp,'modified_user_id'=>$this->serviceUserId,'created_by'=>$this->serviceUserId,
                'description'=>'ClawPilot initial enrollment '.$plan['operationId'],'deleted'=>'0','assigned_user_id'=>$p['ownerSuiteCrmId'],'noninheritable'=>'1']];
            foreach($p['futureCreate']['view'] as $user)$changes['securitygroups_users'][]=['before'=>null,'after'=>[
                'id'=>self::stableId($plan['operationId'],'membership:'.$group.':'.$user),'date_modified'=>$stamp,'deleted'=>'0',
                'securitygroup_id'=>$group,'user_id'=>$user,'primary_group'=>'0','noninheritable'=>'1']];
        }
        foreach($plan['emails'] as $pair){$e=$pair['before'];$changes['securitygroups_records'][]=['before'=>null,'after'=>[
            'id'=>self::stableId($plan['operationId'],'record:'.$e['nativeId']),'securitygroup_id'=>$groups[$e['pipelineId']],
            'record_id'=>$e['nativeId'],'module'=>'Emails','date_modified'=>$stamp,'modified_user_id'=>null,'created_by'=>null,'deleted'=>'0']];}
        foreach($changes as &$deltas)usort($deltas,static fn($a,$b)=>strcmp($a['after']['id'],$b['after']['id']));unset($deltas);
        return new ClawPilotNativeEmailInitialPolicyDelta($changes);
    }
    private function bindings(array $plan,string $policyFingerprint,string $runtimeFingerprint): array
    {
        $rows=[];foreach($plan['pipelines'] as $pipeline){$p=$pipeline['policy'];$future=$p;unset($future['historical']);
            $rows[]=['pipeline_id'=>$p['pipelineId'],'workspace_id'=>$p['workspaceId'],'group_id'=>$pipeline['groupId'],
                'generation'=>(string)$plan['appGeneration'],'owner_id'=>$p['ownerSuiteCrmId'],'readers_json'=>self::canonical($p['futureCreate']['view']),
                'audience_fingerprint'=>$p['audienceFingerprint'],'policy_fingerprint'=>$policyFingerprint,'runtime_fingerprint'=>$runtimeFingerprint,
                'capability_policy_json'=>self::canonical($p),'capability_policy_fingerprint'=>self::digest($future),'enabled'=>'1'];}
        return $rows;
    }
    private function verifyAfter(array $plan,array $result,string $deltaFingerprint,ClawPilotNativeEmailTransaction $tx): void
    {
        self::keys($result,['generation','appSourceFingerprint','beforePolicyFingerprint','afterPolicyFingerprint','sourceRuntimeFingerprint',
            'installedRuntimeFingerprint','runtimeFingerprint','identityFingerprint','capabilitiesFingerprint','bindingsFingerprint','defaultsFingerprint','emailCount','principalCount']);
        self::need($result['generation']===$plan['appGeneration']&&$result['appSourceFingerprint']===$plan['appSourceFingerprint']
            &&$result['beforePolicyFingerprint']===$plan['nativePolicyBeforeFingerprint']&&$result['afterPolicyFingerprint']===$plan['nativePolicyAfterFingerprint']
            &&$result['sourceRuntimeFingerprint']===$plan['nativeRuntimeBeforeFingerprint']&&$result['runtimeFingerprint']===$plan['nativeRuntimeAfterFingerprint']
            &&$result['emailCount']===count($plan['emails'])&&$result['principalCount']===count($plan['principalSuiteCrmUserIds']),'initial_result_identity');
        self::need($this->principals()===$plan['principalSuiteCrmUserIds'],'initial_principal_changed');
        $runtime=ClawPilotNativeEmailRuntime::attest($this->db);
        self::need(ClawPilotNativeEmailWriteScope::enabled()&&hash_equals($runtime,$result['runtimeFingerprint']),'initial_runtime_after_changed');
        self::need(hash_equals($tx->immutablePolicyFingerprint(),$result['afterPolicyFingerprint'])
            ||hash_equals($tx->initialPostPolicyFingerprint(),$result['afterPolicyFingerprint']),'initial_policy_after_changed');
        $bindings=$this->rows('SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id FOR UPDATE');
        $bindings=array_map(static fn($row)=>ClawPilotNativeEmailAuthorityContract::nativeBinding($row,2),$bindings);
        self::need(self::digest($bindings)===$result['bindingsFingerprint'],'initial_binding_readback');
        $identities=$this->rows('SELECT * FROM clawpilot_email_identities ORDER BY email_id FOR UPDATE');
        self::need(count($identities)===count($plan['emails']),'initial_registry_inventory');
        foreach($plan['emails'] as $index=>$pair){$row=$identities[$index];$after=$pair['after'];
            self::need($row['email_id']===$after['nativeId']&&$row['global_id']===$after['globalId']&&$row['local_id']===$after['localId']
                &&$row['pipeline_id']===$after['pipelineId']&&$row['workspace_id']===$after['workspaceId']
                &&(int)$row['app_archived']===($after['archived']?1:0)&&$row['capabilities_json']===self::canonical($after['capabilities']),'initial_registry_identity');}
        ClawPilotNativeEmailWriteScope::assertIdentities($this->db,$identities);
        $expectedScopes=[];$expectedPermissions=[];
        foreach($plan['pipelines'] as $pipeline)$expectedScopes[]=['pipeline_id'=>$pipeline['policy']['pipelineId'],
            'operation_id'=>$plan['operationId'],'command_hash'=>$deltaFingerprint];
        foreach($plan['emails'] as $pair){$row=$pair['after'];$expectedPermissions[]=['email_id'=>$row['nativeId'],'pipeline_id'=>$row['pipelineId'],
            'capabilities_json'=>self::canonical($row['capabilities']),'source_kind'=>'authority','operation_id'=>$plan['operationId'],'command_hash'=>$deltaFingerprint];}
        self::need(self::canonical($this->rows('SELECT * FROM clawpilot_email_write_scopes ORDER BY pipeline_id FOR UPDATE'))===self::canonical($expectedScopes)
            &&self::canonical($this->rows('SELECT * FROM clawpilot_email_write_permissions ORDER BY email_id FOR UPDATE'))===self::canonical($expectedPermissions),'initial_writer_provenance');
        $emails=$this->capture(array_column($plan['emails'],'after'),$tx);$caps=$this->capabilities($emails,$plan['principalSuiteCrmUserIds'],$tx);
        foreach($plan['emails'] as $index=>$pair){$actual=$emails[$index];$actual['capabilities']=$caps[$actual['nativeId']];
            self::need(self::canonical($actual)===self::canonical($pair['after']),'initial_after_matrix_or_content_changed');}
        self::need(self::digest(array_map(static fn($pair)=>self::identity($pair['after']),$plan['emails']))===$result['identityFingerprint']
            &&self::digest(array_map(static fn($pair)=>['emailId'=>$pair['after']['nativeId'],'globalId'=>$pair['after']['globalId'],
                'pipelineId'=>$pair['after']['pipelineId'],'capabilities'=>$pair['after']['capabilities']],$plan['emails']))===$result['capabilitiesFingerprint'],'initial_result_inventory');
        self::need(self::digest($this->defaultProjection())===$result['defaultsFingerprint'],'initial_defaults_readback');
    }
    private function verifyApproval(array $plan,array $forecast,array $authorization,array $installation,bool $allowExpired=false): void
    {
        $p=$this->approvalProof($authorization,$plan['nativeInstanceId'],$allowExpired);
        foreach(['nativeInstanceId','operationId','appGeneration','appSourceFingerprint'] as $key)self::need($p[$key]===$plan[$key],'initial_proof_identity');
        self::need($p['planHash']===$forecast['planHash']&&$p['preparedAt']===$forecast['preparedAt']&&$p['deltaFingerprint']===$forecast['deltaFingerprint']
            &&$p['serviceUserId']===$this->serviceUserId&&$p['oauthClientId']===$this->oauthClientId,'initial_proof_identity');
        foreach(['sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'] as $key)
            self::need($p[$key]===$installation[$key],'initial_proof_journal');
    }
    /** Historical signature verification has no permission forecast or expiry
     * renewal. Its signed pins are facts, not today's before-state evidence. */
    private function approvalProof(array $authorization,string $expectedInstance,bool $allowExpired): array
    {
        self::keys($authorization,['proof','signature']);$p=$authorization['proof'];self::keys($p,self::PROOF_KEYS);
        self::need($p['version']===1&&$p['purpose']==='clawpilot-native-email-initial-enrollment-approval'
            &&$p['issuer']==='clawpilot-pg-initial-enrollment'&&$p['audience']==='clawpilot-suitecrm-initial-enrollment','initial_proof_domain');
        foreach(['operationId','planHash','appSourceFingerprint','deltaFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'] as $key)self::hash($p[$key]);
        foreach(['nativeInstanceId','serviceUserId','oauthClientId'] as $key)self::id($p[$key]);
        ClawPilotNativeEmailAuthorityContract::id($p['keyId'],64);self::utc($p['preparedAt']);
        self::need($p['nativeInstanceId']===$expectedInstance&&$p['serviceUserId']===$this->serviceUserId&&$p['oauthClientId']===$this->oauthClientId
            &&is_int($p['appGeneration'])&&$p['appGeneration']>0&&$p['appGeneration']<=9007199254740991,'initial_proof_identity');
        $now=time();self::need(is_int($p['issuedAt'])&&is_int($p['expiresAt'])&&$p['issuedAt']>0&&$p['issuedAt']<=$now+30
            &&($allowExpired||$p['expiresAt']>$now)&&$p['expiresAt']>$p['issuedAt']&&$p['expiresAt']-$p['issuedAt']<=300,'initial_proof_expired');
        $keyId=(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID');$instance=(string)getenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID');
        $pem=(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY');
        self::need($keyId!==''&&$instance!==''&&$p['keyId']===$keyId&&$p['nativeInstanceId']===$instance
            &&strlen($pem)>=100&&strlen($pem)<=8192&&str_starts_with($pem,'-----BEGIN PUBLIC KEY-----'),'initial_issuer_unconfigured');
        $key=openssl_pkey_get_public($pem);$details=$key===false?false:openssl_pkey_get_details($key);
        self::need(is_array($details)&&$details['type']===OPENSSL_KEYTYPE_RSA&&$details['bits']===3072,'initial_issuer_key_profile');
        $signature=$authorization['signature'];$raw=is_string($signature)?base64_decode($signature,true):false;
        self::need(is_string($signature)&&strlen($signature)===512&&is_string($raw)&&strlen($raw)===384
            &&base64_encode($raw)===$signature&&openssl_verify(self::canonical($p),$raw,$key,OPENSSL_ALGO_SHA256)===1,'initial_proof_signature');
        return $p;
    }
    private function terminal(string $operation): ?array
    {$rows=$this->rows('SELECT * FROM clawpilot_email_initial_enrollments WHERE operation_id=? FOR UPDATE',[$operation]);self::need(count($rows)<=1,'initial_terminal_ambiguous');return $rows[0]??null;}
    private function savedReceipt(array $plan,array $authorization,array $saved): array
    {
        $this->historicalTerminal($saved,$plan['nativeInstanceId']);
        self::need(in_array($saved['state'],['committed','cancelled'],true)&&$saved['plan_hash']===self::digest($plan)
            &&$saved['approval_hash']===self::digest($authorization)&&$saved['approval_json']===self::canonical($authorization),'initial_terminal_conflict');
        $receipt=json_decode($saved['receipt_json'],true,64,JSON_THROW_ON_ERROR);
        self::keys($receipt,['version','purpose','operationId','planHash','approvalHash','state','result']);
        self::need($receipt['version']===1&&$receipt['purpose']==='clawpilot-native-email-initial-enrollment-receipt'
            &&$receipt['operationId']===$plan['operationId']&&$receipt['planHash']===$saved['plan_hash']
            &&$receipt['approvalHash']===$saved['approval_hash']&&$receipt['state']===$saved['state']
            &&($receipt['state']==='cancelled'?$receipt['result']===null:is_array($receipt['result'])),'initial_terminal_conflict');
        self::keys($authorization,['proof','signature']);$p=$authorization['proof'];self::keys($p,self::PROOF_KEYS);
        $this->verifyApproval($plan,['planHash'=>$saved['plan_hash'],'preparedAt'=>$p['preparedAt'],'deltaFingerprint'=>$saved['delta_fingerprint']],$authorization,
            ['sourceRuntimeFingerprint'=>$p['sourceRuntimeFingerprint'],'installedRuntimeFingerprint'=>$p['installedRuntimeFingerprint'],
                'installationJournalFingerprint'=>$p['installationJournalFingerprint']],true);
        if($receipt['state']==='committed')self::need($receipt['result']['installedRuntimeFingerprint']===$p['installedRuntimeFingerprint'],'initial_terminal_runtime');
        return $receipt;
    }
    private function caller(): void
    {
        $expectedClient=(string)getenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID');
        self::need($expectedClient!==''&&hash_equals($expectedClient,$this->oauthClientId),'initial_dedicated_client_required');
        $users=$this->rows("SELECT id,is_admin,status,deleted FROM users WHERE id=? FOR UPDATE",[$this->serviceUserId]);
        $clients=$this->rows('SELECT id,assigned_user_id,deleted,allowed_grant_type FROM oauth2clients WHERE id=? FOR UPDATE',[$this->oauthClientId]);
        self::need(count($users)===1&&(int)$users[0]['is_admin']===1&&$users[0]['status']==='Active'&&(int)$users[0]['deleted']===0
            &&count($clients)===1&&(int)$clients[0]['deleted']===0&&$clients[0]['assigned_user_id']===$this->serviceUserId
            &&$clients[0]['allowed_grant_type']==='client_credentials','initial_service_identity');
    }
    private function principals(): array
    {$rows=$this->rows('SELECT id FROM users WHERE deleted=0 ORDER BY id FOR UPDATE',[],500);$ids=array_column($rows,'id');ClawPilotNativeEmailAuthorityContract::ids($ids);return $ids;}
    private function defaultProjection(): array
    {return array_map(static fn($row)=>['id'=>$row['id'],'action'=>$row['name'],'aclAccess'=>(int)$row['aclaccess']],$this->rows("SELECT id,name,aclaccess FROM acl_actions WHERE category='Emails' AND acltype='module' AND deleted=0 AND name IN ('delete','edit','export','list','view') ORDER BY name FOR UPDATE"));}
    private function emptyDataRegistry(): void
    {foreach(['clawpilot_email_bindings','clawpilot_email_identities','clawpilot_email_operations','clawpilot_email_authority_approvals',
        'clawpilot_email_authority_operations','clawpilot_email_write_scopes','clawpilot_email_write_permissions'] as $table)
        self::need($this->rows('SELECT * FROM '.$table.' LIMIT 1 FOR UPDATE')===[],'initial_registry_not_empty');}
    private function emptyRegistry(): array
    {
        $this->emptyDataRegistry();return $this->cancelledHistory((string)getenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID'));
    }
    /** Actual locked ledger rows. Keep only compact five-field history and
     * signed approval scalar pins, never all ancestor full plans in memory. */
    private function cancelledHistory(string $expectedInstance,?array $allowCommittedCurrent=null): array
    {
        self::id($expectedInstance);$currentFound=$allowCommittedCurrent===null;$history=[];$proofs=[];
        $maximum=$allowCommittedCurrent===null?500:501;
        $rows=$this->rows('SELECT * FROM clawpilot_email_initial_enrollments ORDER BY operation_id LIMIT '.($maximum+1).' FOR UPDATE',[],$maximum+1);
        self::need(count($rows)<=$maximum,'initial_history_bound');
        foreach($rows as $row){$retained=$this->historicalTerminal($row,$expectedInstance);
            if($retained['state']==='committed'){
                self::need($allowCommittedCurrent!==null&&!$currentFound
                    &&$row['operation_id']===$allowCommittedCurrent['plan']['operationId'],'initial_registry_not_empty');
                $receipt=$this->savedReceipt($allowCommittedCurrent['plan'],$allowCommittedCurrent['authorization'],$row);
                self::need($receipt['state']==='committed','initial_history_current_changed');$currentFound=true;continue;
            }
            $history[]=$retained['entry'];$proofs[$row['operation_id']]=$retained['proof'];
        }
        self::need($currentFound,'initial_history_current_missing');
        return ['history'=>$history,'proofs'=>$proofs,'fingerprint'=>ClawPilotNativeEmailInitialInstallationLineage::historyFingerprint($history)];
    }
    private function historyResult(array $history): array
    {return ['version'=>1,'purpose'=>'clawpilot-native-email-initial-cancelled-history','history'=>$history['history'],'fingerprint'=>$history['fingerprint']];}
    private function verifyCommittedHistory(array $plan,array $authorization): void
    {
        if($plan['kind']!=='initial_enrollment_replan_v1')return;
        $history=$this->cancelledHistory($plan['nativeInstanceId'],['plan'=>$plan,'authorization'=>$authorization]);
        $this->verifyHistoryContext(ClawPilotNativeEmailInitialInstallationLineage::contextFromLineage($plan['installationLineage'],$plan['operationId']),
            $plan['operationId'],$history);
    }
    private function verifyHistoryContext(array $context,string $currentOperationId,array $history): void
    {
        $context=ClawPilotNativeEmailInitialInstallationLineage::prepareContext($context,$currentOperationId);
        self::need(count($history['history'])===$context['depth']&&hash_equals($history['fingerprint'],$context['cancelledHistoryFingerprint']),
            'initial_replan_history_changed');
        $byId=[];foreach($history['history'] as $row)$byId[$row['operationId']]=$row;
        $root=$byId[$context['rootOperationId']]??null;$predecessor=$byId[$context['predecessorOperationId']]??null;
        self::need($root!==null&&$predecessor!==null&&!isset($byId[$currentOperationId]),'initial_replan_ancestor_missing');
        self::need($predecessor['planHash']===$context['predecessorPlanHash']&&$predecessor['approvalHash']===$context['predecessorApprovalHash']
            &&$predecessor['cancellationReceiptHash']===$context['predecessorCancellationReceiptHash'],'initial_replan_predecessor_changed');
        $rootProof=$history['proofs'][$context['rootOperationId']];
        self::need($rootProof['installationJournalFingerprint']===$context['rootInstallationJournalFingerprint']
            &&$rootProof['sourceRuntimeFingerprint']===$context['rootStockRuntimeFingerprint'],'initial_replan_root_changed');
        // Root source artifact bytes/journal CAS are checked by the immutable
        // root installer helper; previousLineageHash is checked against stored
        // signed predecessor plans by PG. Native verifies signed row anchors,
        // the complete current history and the final signed plan binding.
    }
    private function historicalTerminal(array $row,string $expectedInstance): array
    {
        self::keys($row,['operation_id','plan_hash','delta_fingerprint','approval_hash','approval_json','receipt_json','state','created_at']);
        foreach(['operation_id','plan_hash','delta_fingerprint','approval_hash'] as $key)self::hash($row[$key]);
        self::need(in_array($row['state'],['committed','cancelled'],true),'initial_history_state');
        foreach(['approval_json','receipt_json'] as $key)self::need(is_string($row[$key])&&strlen($row[$key])<=16384,'initial_history_size');
        $approval=json_decode($row['approval_json'],true,32,JSON_THROW_ON_ERROR);$receipt=json_decode($row['receipt_json'],true,32,JSON_THROW_ON_ERROR);
        self::need(is_array($approval)&&self::canonical($approval)===$row['approval_json']&&self::digest($approval)===$row['approval_hash']
            &&is_array($receipt)&&self::canonical($receipt)===$row['receipt_json'],'initial_cancelled_history_changed');
        $p=$this->approvalProof($approval,$expectedInstance,true);
        self::keys($receipt,['version','purpose','operationId','planHash','approvalHash','state','result']);
        self::need($p['operationId']===$row['operation_id']&&$p['planHash']===$row['plan_hash']&&$p['deltaFingerprint']===$row['delta_fingerprint']
            &&$receipt['version']===1&&$receipt['purpose']==='clawpilot-native-email-initial-enrollment-receipt'
            &&$receipt['operationId']===$row['operation_id']&&$receipt['planHash']===$row['plan_hash']&&$receipt['approvalHash']===$row['approval_hash']
            &&$receipt['state']===$row['state'],'initial_cancelled_history_changed');
        if($row['state']==='cancelled')self::need($receipt['result']===null&&time()>=$p['expiresAt'],'initial_approval_not_expired');
        else{
            $r=$receipt['result'];self::keys($r,['generation','appSourceFingerprint','beforePolicyFingerprint','afterPolicyFingerprint','sourceRuntimeFingerprint',
                'installedRuntimeFingerprint','runtimeFingerprint','identityFingerprint','capabilitiesFingerprint','bindingsFingerprint','defaultsFingerprint','emailCount','principalCount']);
            foreach(['appSourceFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint'] as $key)self::need($r[$key]===$p[$key],'initial_terminal_runtime');
            foreach(['beforePolicyFingerprint','afterPolicyFingerprint','runtimeFingerprint','identityFingerprint','capabilitiesFingerprint','bindingsFingerprint','defaultsFingerprint'] as $key)self::hash($r[$key]);
            self::need($r['generation']===$p['appGeneration']&&is_int($r['emailCount'])&&$r['emailCount']>0&&$r['emailCount']<=500
                &&is_int($r['principalCount'])&&$r['principalCount']>0&&$r['principalCount']<=500,'initial_terminal_inventory');
        }
        return ['state'=>$row['state'],'proof'=>$p,'entry'=>['operationId'=>$row['operation_id'],'planHash'=>$row['plan_hash'],
            'deltaFingerprint'=>$row['delta_fingerprint'],'approvalHash'=>$row['approval_hash'],'cancellationReceiptHash'=>self::digest($receipt)]];
    }
    private function storage(): void
    {
        $tables=['clawpilot_email_initial_enrollments'=>['operation_id','plan_hash','delta_fingerprint','approval_hash','approval_json','receipt_json','state','created_at'],
            'clawpilot_email_bindings'=>['pipeline_id','workspace_id','group_id','generation','owner_id','readers_json','audience_fingerprint','policy_fingerprint','runtime_fingerprint','capability_policy_json','capability_policy_fingerprint','enabled'],
            'clawpilot_email_identities'=>['email_id','global_id','local_id','pipeline_id','workspace_id','app_archived','capabilities_json']];
        foreach($tables as $table=>$columns){$meta=$this->rows('SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);
            self::need(count($meta)===1&&$meta[0]['ENGINE']==='InnoDB'&&$meta[0]['TABLE_TYPE']==='BASE TABLE','initial_storage');
            self::need(array_column($this->rows('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[$table]),'COLUMN_NAME')===$columns,'initial_storage_columns');}
        ClawPilotNativeEmailWriteScope::storage($this->db);
        $indexes=['clawpilot_email_initial_enrollments'=>['PRIMARY'=>[0,['operation_id']]],
            'clawpilot_email_bindings'=>['PRIMARY'=>[0,['pipeline_id']],'group_id'=>[0,['group_id']]],
            'clawpilot_email_identities'=>['PRIMARY'=>[0,['email_id']],'global_id'=>[0,['global_id']],'local_id'=>[0,['local_id']],'cp_email_pipeline'=>[1,['pipeline_id']]],
            'clawpilot_email_write_scopes'=>['PRIMARY'=>[0,['pipeline_id']]],
            'clawpilot_email_write_permissions'=>['PRIMARY'=>[0,['email_id']],'cp_email_write_pipeline'=>[1,['pipeline_id']]]];
        foreach($indexes as $table=>$expected){$actual=[];
            foreach($this->rows('SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',[$table]) as $row){
                self::need($row['SUB_PART']===null&&$row['INDEX_TYPE']==='BTREE','initial_storage_index');$name=$row['INDEX_NAME'];
                if(!isset($actual[$name]))$actual[$name]=[(int)$row['NON_UNIQUE'],[]];$actual[$name][1][]=$row['COLUMN_NAME'];}
            self::need(self::canonical($actual)===self::canonical($expected),'initial_storage_index');}
    }
    /** Complete batched raw snapshots, not samples. Preserve the projection's
     * prepared-protocol scalar types, row ordering and raw key order. Its first
     * actual snapshot independently checks shared schema and digest parity. */
    private function capture(array $mappings,ClawPilotNativeEmailTransaction $tx): array
    {
        self::need(array_is_list($mappings)&&count($mappings)>0&&count($mappings)<=500,'initial_mapping_bound');
        foreach($mappings as $mapping){$identity=self::identity($mapping);
            self::keys($identity,['localId','nativeId','globalId','pipelineId','workspaceId','archived','recordFingerprint']);
            foreach(['localId','pipelineId','workspaceId'] as $key)self::uuid($identity[$key]);self::id($identity['nativeId']);
            self::need(is_bool($identity['archived'])&&is_string($identity['globalId'])&&preg_match('/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D',$identity['globalId'])===1,'initial_mapping_identity');}
        $ids=array_column($this->rows('SELECT id FROM emails FORCE INDEX (PRIMARY) WHERE deleted=0 ORDER BY id FOR UPDATE',[],500),'id');
        self::need($ids===array_column($mappings,'nativeId'),'initial_full_email_inventory');$result=[];
        $first=ClawPilotNativeEmailProjection::snapshot($this->db,$tx,$ids[0]);$marks=implode(',',array_fill(0,count($ids),'?'));
        $tables=[
            'emails'=>['id','PRIMARY','id',500],
            'emails_text'=>['email_id','PRIMARY','email_id',500],
            'emails_cstm'=>['id_c','PRIMARY','id_c',500],
            'emails_beans'=>['email_id','idx_emails_beans_email_bean','email_id,bean_id,deleted,id',100000],
            'emails_email_addr_rel'=>['email_id','idx_eearl_email_id','email_id,address_type,id',100000],
        ];
        $buckets=[];$contactIds=[];
        foreach($tables as $table=>[$key,$index,$order,$cap]){
            $buckets[$table]=array_fill_keys($ids,[]);
            foreach($this->rows('SELECT * FROM '.$table.' FORCE INDEX ('.$index.') WHERE '.$key.' IN ('.$marks.') ORDER BY '.$order.' FOR UPDATE',$ids,$cap) as $row){
                self::need(isset($buckets[$table][$row[$key]]),'initial_content_identity');$buckets[$table][$row[$key]][]=$row;
                if($table==='emails_beans'&&$row['bean_module']==='Contacts')$contactIds[$row['bean_id']]=true;
            }
        }
        $contactRows=[];$contacts=array_keys($contactIds);sort($contacts,SORT_STRING);
        if($contacts){$contactsMarks=implode(',',array_fill(0,count($contacts),'?'));
            $contactRows=array_fill_keys($contacts,[]);
            foreach($this->rows('SELECT * FROM accounts_contacts FORCE INDEX (idx_contid_del_accid) WHERE contact_id IN ('.$contactsMarks.') ORDER BY contact_id,deleted,account_id,id FOR UPDATE',$contacts,50000) as $row)
                $contactRows[$row['contact_id']][]=$row;
        }
        // Use the native column collation as well as exact row identity. A
        // differently cased/trailing-space deleted custom row cannot hide a
        // duplicate by being a different PHP string.
        $globalCounts=[];foreach($this->rows('SELECT global_id_c,COUNT(*) AS matches_count FROM emails_cstm FORCE INDEX (PRIMARY) WHERE global_id_c IN ('.$marks.') GROUP BY global_id_c ORDER BY global_id_c FOR UPDATE',array_column($mappings,'globalId'),500) as $row)
            $globalCounts[$row['global_id_c']]=(int)$row['matches_count'];
        foreach($mappings as $mapping){$id=$mapping['nativeId'];$raw=[];foreach($tables as $table=>$ignored)$raw[$table]=$buckets[$table][$id];
            self::need(count($raw['emails'])===1&&count($raw['emails_cstm'])===1&&count($raw['emails_text'])===1
                &&$raw['emails_cstm'][0]['global_id_c']===$mapping['globalId']&&($globalCounts[$mapping['globalId']]??0)===1,'initial_native_identity');
            $selected=[];foreach($raw['emails_beans'] as $link)if($link['bean_module']==='Contacts')$selected[$link['bean_id']]=true;
            $selected=array_keys($selected);sort($selected,SORT_STRING);$raw['contactAccounts']=[];
            foreach($selected as $contactId)$raw['contactAccounts'][$contactId]=$contactRows[$contactId];
            $fingerprint=hash('sha256',json_encode($raw,JSON_THROW_ON_ERROR));
            if($id===$ids[0])self::need(hash_equals($first['fingerprint'],$fingerprint),'initial_projection_digest_parity');
            $row=self::identity($mapping);$row['recordFingerprint']=$fingerprint;$result[]=$row;
        }
        return $result;
    }
    private function capabilities(array $emails,array $principals,ClawPilotNativeEmailTransaction $tx): array
    {
        $identities=array_map(static fn($row)=>['email_id'=>$row['nativeId']],$emails);
        $read=function()use($emails,$principals){$before=$GLOBALS['current_user']??null;$session=$_SESSION??[];$actual=[];
            $ids=array_column($emails,'nativeId');$ownership=[];
            foreach($this->rows('SELECT id,assigned_user_id,created_by,deleted FROM emails WHERE id IN ('.implode(',',array_fill(0,count($ids),'?')).') ORDER BY id FOR UPDATE',$ids,500) as $row){
                foreach(['id','assigned_user_id','created_by'] as $key)self::id($row[$key]);
                self::need(in_array($row['deleted'],[0,'0'],true),'initial_owner_identity');$ownership[$row['id']]=$row;}
            self::need(array_keys($ownership)===$ids,'initial_owner_inventory');
            foreach($emails as $email)$actual[$email['nativeId']]=array_fill_keys(self::SURFACES,[]);
            try{foreach($principals as $id){$user=BeanFactory::newBean('Users');self::need((bool)$user->retrieve($id,false),'initial_user_missing');
                $GLOBALS['current_user']=$user;$_SESSION=[];
                if(function_exists('clawpilot_candidate_refresh_email_acl'))clawpilot_candidate_refresh_email_acl(true);else ACLAction::getUserActions($id,true);
                foreach($emails as $row){$email=BeanFactory::newBean('Emails');$owner=$ownership[$row['nativeId']];
                    self::need($email instanceof Email&&get_class($email)==='Email'&&$email->module_dir==='Emails'
                        &&$email->module_name==='Emails'&&$email->acltype==='module','initial_email_bean');
                    $fetched=$email->convertRow($owner);self::need($fetched===$owner,'initial_owner_conversion');
                    $email->fetched_row=$fetched;$email->populateFromRow($fetched);
                    self::need($email->id===$owner['id']&&$email->fetched_row===$fetched,'initial_owner_hydration');
                    foreach(self::SURFACES as $surface)if($email->ACLAccess($surface))$actual[$row['nativeId']][$surface][]=$id;}}
            }finally{$GLOBALS['current_user']=$before;$_SESSION=$session;}return $actual;};
        return ClawPilotNativeEmailWriteScope::enabled()?ClawPilotNativeEmailWriteReadFrame::within($tx,$identities,$read):$read();
    }
    public static function validatePlan(array $plan): void
    {
        self::keys($plan,['version','kind','operationId','nativeInstanceId','appGeneration','appSourceFingerprint','nativePolicyBeforeFingerprint',
            'nativeRuntimeBeforeFingerprint','nativePolicyAfterFingerprint','nativeRuntimeAfterFingerprint','principalSuiteCrmUserIds','defaults','emails','pipelines','reviewedRevocations','rootEmployeeGrants',
            ...(($plan['kind']??null)==='initial_enrollment_replan_v1'?['installationLineage']:[])]);
        self::need($plan['version']===1&&in_array($plan['kind'],['initial_enrollment_plan_v1','initial_enrollment_replan_v1'],true)&&is_int($plan['appGeneration'])
            &&$plan['appGeneration']>0&&$plan['appGeneration']<=9007199254740991&&$plan['rootEmployeeGrants']===[],'initial_plan_shape');
        self::id($plan['nativeInstanceId']);foreach(['operationId','appSourceFingerprint','nativePolicyBeforeFingerprint','nativeRuntimeBeforeFingerprint',
            'nativePolicyAfterFingerprint','nativeRuntimeAfterFingerprint'] as $key)self::hash($plan[$key]);
        if($plan['kind']==='initial_enrollment_replan_v1'){
            $lineage=ClawPilotNativeEmailInitialInstallationLineage::prepare($plan['installationLineage'],$plan['operationId']);
            self::need($lineage['freshInstalledRuntimeFingerprint']===$plan['nativeRuntimeBeforeFingerprint'],'initial_replan_runtime_mismatch');
        }
        $principals=$plan['principalSuiteCrmUserIds'];ClawPilotNativeEmailAuthorityContract::ids($principals);self::need(count($principals)>0,'initial_principals');
        self::need(is_array($plan['defaults'])&&array_is_list($plan['defaults'])&&count($plan['defaults'])===5,'initial_defaults');$previous='';$ids=[];
        foreach($plan['defaults'] as $pair){self::keys($pair,['before','after']);foreach(['before','after'] as $stage)self::keys($pair[$stage],['id','action','aclAccess']);
            $b=$pair['before'];$a=$pair['after'];self::id($b['id']);self::need(in_array($b['action'],self::SURFACES,true)&&strcmp($b['action'],$previous)>0
                &&!isset($ids[$b['id']])&&$b['aclAccess']===90&&self::canonical($a)===self::canonical(array_replace($b,['aclAccess'=>in_array($b['action'],['edit','delete'],true)?75:80])),'initial_defaults');
            $previous=$b['action'];$ids[$b['id']]=true;}
        self::need(is_array($plan['pipelines'])&&array_is_list($plan['pipelines'])&&count($plan['pipelines'])>0&&count($plan['pipelines'])<=100,'initial_pipelines');
        $pipelines=[];$groups=[];$previous='';foreach($plan['pipelines'] as $pipeline){self::keys($pipeline,['groupId','policy']);self::uuid($pipeline['groupId']);$p=$pipeline['policy'];
            self::need(is_array($p)&&($p['historical']??null)===[]&&strcmp($p['pipelineId'],$previous)>0&&!isset($groups[$pipeline['groupId']]),'initial_pipeline_identity');
            ClawPilotNativeEmailCapabilityContract::prepare($p,['binding'=>['pipelineId'=>$p['pipelineId'],'workspaceId'=>$p['workspaceId'],
                'ownerSuiteCrmId'=>$p['ownerSuiteCrmId'],'audienceFingerprint'=>$p['audienceFingerprint'],'allowedReaderSuiteCrmUserIds'=>$p['futureCreate']['view']],
                'livePrincipalSuiteCrmUserIds'=>$principals,'approvedFutureCreate'=>$p['futureCreate'],'liveHistorical'=>[]]);
            self::uuid($p['workspaceId']);$groups[$pipeline['groupId']]=true;$previous=$p['pipelineId'];$pipelines[$p['pipelineId']]=$p;}
        self::need(is_array($plan['emails'])&&array_is_list($plan['emails'])&&count($plan['emails'])>0&&count($plan['emails'])<=500,'initial_email_bound');
        $native=[];$local=[];$global=[];$revocations=[];$previous='';
        foreach($plan['emails'] as $pair){self::keys($pair,['before','after']);foreach(['before','after'] as $stage){$row=$pair[$stage];
                self::keys($row,['localId','nativeId','globalId','pipelineId','workspaceId','archived','recordFingerprint','capabilities']);
                foreach(['localId','pipelineId','workspaceId'] as $key)self::uuid($row[$key]);self::id($row['nativeId']);self::hash($row['recordFingerprint']);
                self::need(is_string($row['globalId'])&&preg_match('/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D',$row['globalId'])===1&&is_bool($row['archived']),'initial_email_identity');self::matrix($row['capabilities'],$principals);}
            $b=$pair['before'];$a=$pair['after'];$p=$pipelines[$b['pipelineId']]??null;
            self::need(strcmp($b['nativeId'],$previous)>0&&!isset($native[$b['nativeId']])&&!isset($local[$b['localId']])&&!isset($global[$b['globalId']])
                &&self::canonical(self::identity($b))===self::canonical(self::identity($a))&&$p!==null&&$p['workspaceId']===$b['workspaceId'],'initial_email_identity');
            $previous=$b['nativeId'];$native[$b['nativeId']]=true;$local[$b['localId']]=true;$global[$b['globalId']]=true;
            ClawPilotNativeEmailCapabilityContract::validateTarget($a['capabilities'],$p['futureCreate']['view'],$principals);
            foreach(self::SURFACES as $surface){self::need(array_diff($a['capabilities'][$surface],$b['capabilities'][$surface])===[],'initial_historical_grant_forbidden');
                foreach(array_diff($b['capabilities'][$surface],$a['capabilities'][$surface]) as $principalId)$revocations[]=['nativeId'=>$b['nativeId'],'surface'=>$surface,'principalId'=>$principalId];}}
        usort($revocations,static fn($a,$b)=>strcmp($a['nativeId'].':'.$a['surface'].':'.$a['principalId'],$b['nativeId'].':'.$b['surface'].':'.$b['principalId']));
        self::need(self::canonical($revocations)===self::canonical($plan['reviewedRevocations']),'initial_unreviewed_revocation');
        self::need(strlen(self::canonical($plan))<=1800000,'initial_plan_size');
    }
    private static function matrix(array $matrix,array $principals): void
    {self::keys($matrix,self::SURFACES);foreach(self::SURFACES as $surface){ClawPilotNativeEmailAuthorityContract::ids($matrix[$surface]);self::need(array_diff($matrix[$surface],$principals)===[],'initial_unknown_principal');}
        foreach(['edit','delete'] as $surface)self::need(array_diff($matrix[$surface],$matrix['view'])===[],'initial_write_without_read');}
    private static function identity(array $row): array {$result=$row;unset($result['capabilities']);return $result;}
    private static function stableId(string $operation,string $identity): string
    {$h=hash('sha256','clawpilot-native-email-initial-id:'.$operation.':'.$identity);return substr($h,0,8).'-'.substr($h,8,4).'-4'.substr($h,13,3).'-8'.substr($h,17,3).'-'.substr($h,20,12);}
    private function insertRows(string $table,array $rows): void
    {foreach(array_chunk($rows,25) as $batch){if(!$batch)continue;$columns=array_keys($batch[0]);$values=[];foreach($batch as $row){self::need(array_keys($row)===$columns,'initial_insert_shape');array_push($values,...array_values($row));}
        $this->write('INSERT INTO '.$table.'('.implode(',',$columns).') VALUES '.implode(',',array_fill(0,count($batch),'('.implode(',',array_fill(0,count($columns),'?')).')')),$values,count($batch));}}
    private function write(string $sql,array $values,int $expected): void
    {$s=$this->db->prepare($sql);self::need($s instanceof mysqli_stmt,'initial_write');try{if($values)$s->bind_param(str_repeat('s',count($values)),...$values);self::need($s->execute()&&$s->affected_rows===$expected,'initial_write_cas');}finally{$s->close();}}
    private function rows(string $sql,array $values=[],int $cap=10000): array
    {$s=$this->db->prepare($sql);self::need($s instanceof mysqli_stmt,'initial_read');try{if($values)$s->bind_param(str_repeat('s',count($values)),...$values);self::need($s->execute(),'initial_read');
        $r=$s->get_result();self::need($r instanceof mysqli_result,'initial_read');$rows=[];$bytes=0;while($row=$r->fetch_assoc()){$bytes+=strlen(json_encode($row,JSON_THROW_ON_ERROR));self::need(count($rows)<$cap&&$bytes<=8388608,'initial_read_bound');$rows[]=$row;}return $rows;}finally{$s->close();}}
    private function rollback(ClawPilotNativeEmailTransaction $tx): void {try{$tx->rollback();}catch(Throwable $ignored){}}
    private static function utc(string $value): void {$d=DateTimeImmutable::createFromFormat('!Y-m-d H:i:s',$value,new DateTimeZone('UTC'));self::need($d!==false&&$d->format('Y-m-d H:i:s')===$value,'initial_timestamp');}
    private static function uuid(mixed $value): void {self::need(is_string($value)&&preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/D',$value)===1,'initial_uuid');}
    private static function id(mixed $value): void {ClawPilotNativeEmailAuthorityContract::id($value,36);}
    private static function hash(mixed $value): void {ClawPilotNativeEmailAuthorityContract::hash($value);}
    private static function keys(mixed $value,array $keys): void {ClawPilotNativeEmailAuthorityContract::keys($value,$keys);}
    private static function canonical(mixed $value): string {return ClawPilotNativeEmailAuthorityContract::canonical($value);}
    private static function digest(mixed $value): string {return ClawPilotNativeEmailAuthorityContract::digest($value);}
    private static function need(bool $value,string $code): void {if(!$value)throw new ClawPilotNativeEmailTransactionRefused($code);}
}
