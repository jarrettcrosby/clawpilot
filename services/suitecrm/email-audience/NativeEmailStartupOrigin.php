<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailAuthorityContract.php';
require_once __DIR__.'/NativeEmailInitialInstallationLineage.php';

/** Historical origin verification only. These pure value checks never mint a
 * startup capability, attest current PG readiness, or authorize a native write. */
final class ClawPilotNativeEmailStartupOrigin
{
    public const PROOF_KEYS=['version','purpose','issuer','audience','keyId','nativeInstanceId','serviceUserId','oauthClientId',
        'issuedAt','operationId','planHash','approvalHash','deltaFingerprint','initialReceiptHash','originGeneration',
        'appSourceFingerprint','installationJournalFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint',
        'runtimeFingerprint','identities','pipelines'];
    public const REPLAN_PROOF_KEYS=['installationRootOperationId','installationLineageHash'];
    private const APPROVAL_KEYS=['version','purpose','issuer','audience','keyId','nativeInstanceId','serviceUserId','oauthClientId',
        'issuedAt','expiresAt','operationId','planHash','appGeneration','appSourceFingerprint','preparedAt','deltaFingerprint',
        'sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'];
    public static function need(bool $condition,string $code): void
    {ClawPilotNativeEmailAuthorityContract::need($condition,'startup_origin_'.$code);}
    public static function canonical(mixed $value): string
    {return ClawPilotNativeEmailAuthorityContract::canonical($value);}
    public static function digest(mixed $value): string {return hash('sha256',self::canonical($value));}
    private static function uuid(mixed $value): void
    {self::need(is_string($value)&&preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/D',$value)===1,'uuid');}
    private static function signature(array $envelope,int $limit): void
    {
        $C=ClawPilotNativeEmailAuthorityContract::class;$C::keys($envelope,['proof','signature']);$p=$envelope['proof'];
        $keyId=(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID');
        $instance=(string)getenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID');
        $client=(string)getenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID');
        $user=(string)getenv('SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID');
        $pem=(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY');
        self::need($keyId!==''&&$instance!==''&&$client!==''&&$user!==''&&$p['keyId']===$keyId
            &&$p['nativeInstanceId']===$instance&&$p['oauthClientId']===$client&&$p['serviceUserId']===$user
            &&strlen($pem)>=100&&strlen($pem)<=8192&&str_starts_with($pem,'-----BEGIN PUBLIC KEY-----'),'issuer_identity');
        $key=openssl_pkey_get_public($pem);$details=$key===false?false:openssl_pkey_get_details($key);
        self::need(is_array($details)&&$details['type']===OPENSSL_KEYTYPE_RSA&&$details['bits']===3072,'key_profile');
        $signature=$envelope['signature'];$raw=is_string($signature)?base64_decode($signature,true):false;
        $bytes=self::canonical($p);
        self::need(is_string($signature)&&strlen($signature)===512&&is_string($raw)&&strlen($raw)===384
            &&base64_encode($raw)===$signature&&strlen($bytes)<=$limit&&preg_match('/^[\x20-\x7e]+$/D',$bytes)===1
            &&openssl_verify($bytes,$raw,$key,OPENSSL_ALGO_SHA256)===1,'signature');
    }
    public static function verifyEnvelope(array $envelope,int $now): array
    {
        $C=ClawPilotNativeEmailAuthorityContract::class;$C::keys($envelope,['proof','signature']);$p=$envelope['proof'];
        $replan=($p['version']??null)===2;$C::keys($p,array_merge(self::PROOF_KEYS,$replan?self::REPLAN_PROOF_KEYS:[]));
        self::need(in_array($p['version'],[1,2],true)&&$p['purpose']==='clawpilot-native-email-initial-activation-origin'
            &&$p['issuer']==='clawpilot-pg-initial-enrollment'&&$p['audience']==='clawpilot-suitecrm-startup','domain');
        foreach(['keyId','nativeInstanceId'] as $key)$C::id($p[$key],$key==='keyId'?64:36);
        foreach(['serviceUserId','oauthClientId'] as $key)$C::id($p[$key],36);
        foreach(['operationId','planHash','approvalHash','deltaFingerprint','initialReceiptHash','appSourceFingerprint',
            'installationJournalFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint','runtimeFingerprint'] as $key)$C::hash($p[$key]);
        if($replan){foreach(self::REPLAN_PROOF_KEYS as $key)$C::hash($p[$key]);
            self::need($p['installationRootOperationId']!==$p['operationId'],'installation_root_self');}
        self::need(is_int($now)&&$now>0&&is_int($p['issuedAt'])&&$p['issuedAt']>0&&$p['issuedAt']<=$now+30
            &&is_int($p['originGeneration'])&&$p['originGeneration']>0&&$p['originGeneration']<=9007199254740991,'time_generation');
        self::need(is_array($p['pipelines'])&&array_is_list($p['pipelines'])&&count($p['pipelines'])>0&&count($p['pipelines'])<=100,'pipeline_bound');
        $pipelines=[];$groups=[];$previous='';
        foreach($p['pipelines'] as $row){$C::keys($row,['pipelineId','workspaceId','groupId']);
            foreach($row as $value)self::uuid($value);
            self::need(strcmp($row['pipelineId'],$previous)>0&&!isset($groups[$row['groupId']]),'pipeline_identity');
            $previous=$row['pipelineId'];$groups[$row['groupId']]=true;$pipelines[$row['pipelineId']]=$row;}
        self::need(is_array($p['identities'])&&array_is_list($p['identities'])&&count($p['identities'])>0&&count($p['identities'])<=500,'identity_bound');
        $previous='';$locals=[];$globals=[];
        foreach($p['identities'] as $row){$C::keys($row,['nativeId','globalId','localId','pipelineId','workspaceId']);$C::id($row['nativeId'],36);
            foreach(['localId','pipelineId','workspaceId'] as $key)self::uuid($row[$key]);
            self::need(is_string($row['globalId'])&&preg_match('/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D',$row['globalId'])===1
                &&strcmp($row['nativeId'],$previous)>0&&!isset($locals[$row['localId']])&&!isset($globals[$row['globalId']])
                &&isset($pipelines[$row['pipelineId']])&&$pipelines[$row['pipelineId']]['workspaceId']===$row['workspaceId'],'identity');
            $previous=$row['nativeId'];$locals[$row['localId']]=true;$globals[$row['globalId']]=true;}
        self::signature($envelope,262144);return $p;
    }
    /** Pure retained-artifact binding. This is not file/journal/history proof:
     * root fixed-path helpers and the actual fenced Native history reader must
     * independently verify those before a typed startup capability is issued. */
    public static function verifyArtifact(array $p,array $a,array $binding): void
    {
        $C=ClawPilotNativeEmailAuthorityContract::class;$L=ClawPilotNativeEmailInitialInstallationLineage::class;
        self::need(in_array($p['version']??null,[1,2],true),'artifact_version');$replan=$p['version']===2;
        foreach(['operationId','nativeInstanceId','appSourceFingerprint','serviceUserId','oauthClientId'] as $key)
            self::need(($a[$key]??null)===$p[$key],'artifact_identity');
        self::need(($a['appGeneration']??null)===$p['originGeneration']&&is_array($a['plan']??null)&&is_array($a['authorization']??null)
            &&self::digest($a['plan'])===$p['planHash']&&self::digest($a['authorization'])===$p['approvalHash'],'artifact_identity');
        $C::keys($binding,['operationId','nativeInstanceId','appGeneration','appSourceFingerprint','sourceArtifactDigest']);
        self::need($binding['nativeInstanceId']===$p['nativeInstanceId'],'installation_binding');
        if(!$replan){
            self::need(($a['version']??null)===1&&($a['purpose']??null)==='clawpilot-native-email-initial-cli-artifact'
                &&!array_key_exists('installationContext',$a)&&($a['plan']['kind']??null)==='initial_enrollment_plan_v1'
                &&!array_key_exists('installationLineage',$a['plan']),'artifact_domain');
            foreach(['operationId','nativeInstanceId','appSourceFingerprint','sourceArtifactDigest'] as $key)
                self::need($a[$key]===$binding[$key],'installation_binding');
            self::need($a['appGeneration']===$binding['appGeneration'],'installation_binding');return;
        }
        self::need(($a['version']??null)===2&&($a['purpose']??null)==='clawpilot-native-email-initial-replan-cli-artifact'
            &&($a['plan']['kind']??null)==='initial_enrollment_replan_v1','artifact_domain');
        $lineage=$L::prepare($a['plan']['installationLineage']??null,$p['operationId']);
        $context=$L::prepareContext($a['installationContext']??null,$p['operationId']);
        self::need(self::canonical($context)===self::canonical($L::contextFromLineage($lineage,$p['operationId']))
            &&$a['sourceArtifactDigest']===$lineage['freshSourceArtifactDigest'],'artifact_lineage_context');
        self::need($p['installationRootOperationId']===$lineage['rootOperationId']&&$p['installationLineageHash']===self::digest($lineage)
            &&$binding['operationId']===$lineage['rootOperationId']&&$binding['sourceArtifactDigest']===$lineage['rootSourceArtifactDigest'],
            'artifact_lineage_root');
        self::need($a['plan']['operationId']===$p['operationId']&&$a['plan']['nativeRuntimeBeforeFingerprint']===$lineage['freshInstalledRuntimeFingerprint']
            &&$p['sourceRuntimeFingerprint']===$lineage['freshInstalledRuntimeFingerprint']&&$p['installedRuntimeFingerprint']===$lineage['freshInstalledRuntimeFingerprint']
            &&$p['installationJournalFingerprint']===$L::effectiveInstallationJournalFingerprint($lineage,$p['operationId']),
            'artifact_effective_installation');
    }
    /** Match immutable origin values, not today's capabilities/content/policy.
     * The original short-lived approval is verified as historical evidence. */
    public static function verifyLedger(array $p,array $row,int $now): void
    {
        $C=ClawPilotNativeEmailAuthorityContract::class;
        self::need(($row['state']??null)==='committed'&&($row['operation_id']??null)===$p['operationId']
            &&($row['plan_hash']??null)===$p['planHash']&&($row['approval_hash']??null)===$p['approvalHash']
            &&($row['delta_fingerprint']??null)===$p['deltaFingerprint'],'ledger_binding');
        foreach(['approval_json','receipt_json'] as $key)self::need(is_string($row[$key]??null)&&strlen($row[$key])<=16384,'ledger_size');
        $approval=json_decode($row['approval_json'],true,32,JSON_THROW_ON_ERROR);$receipt=json_decode($row['receipt_json'],true,32,JSON_THROW_ON_ERROR);
        self::need(is_array($approval)&&self::canonical($approval)===$row['approval_json']&&self::digest($approval)===$p['approvalHash']
            &&is_array($receipt)&&self::canonical($receipt)===$row['receipt_json']&&self::digest($receipt)===$p['initialReceiptHash'],'ledger_hash');
        $C::keys($approval,['proof','signature']);$a=$approval['proof'];$C::keys($a,self::APPROVAL_KEYS);
        self::need($a['version']===1&&$a['purpose']==='clawpilot-native-email-initial-enrollment-approval'
            &&$a['issuer']==='clawpilot-pg-initial-enrollment'&&$a['audience']==='clawpilot-suitecrm-initial-enrollment','approval_domain');
        foreach(['keyId','nativeInstanceId','serviceUserId','oauthClientId','operationId','planHash','deltaFingerprint',
            'appSourceFingerprint','installationJournalFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint'] as $key)
            self::need($a[$key]===$p[$key],'approval_binding');
        self::need($a['appGeneration']===$p['originGeneration']&&is_int($a['issuedAt'])&&is_int($a['expiresAt'])
            &&$a['issuedAt']>0&&$a['issuedAt']<=$now+30&&$a['expiresAt']>$a['issuedAt']&&$a['expiresAt']-$a['issuedAt']<=300
            &&is_string($a['preparedAt'])&&preg_match('/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/D',$a['preparedAt'])===1,'approval_time');
        self::signature($approval,4096);
        $C::keys($receipt,['version','purpose','operationId','planHash','approvalHash','state','result']);
        self::need($receipt['version']===1&&$receipt['purpose']==='clawpilot-native-email-initial-enrollment-receipt'
            &&$receipt['state']==='committed'&&$receipt['operationId']===$p['operationId']&&$receipt['planHash']===$p['planHash']
            &&$receipt['approvalHash']===$p['approvalHash'],'receipt_binding');
        $r=$receipt['result'];$C::keys($r,['generation','appSourceFingerprint','beforePolicyFingerprint','afterPolicyFingerprint',
            'sourceRuntimeFingerprint','installedRuntimeFingerprint','runtimeFingerprint','identityFingerprint','capabilitiesFingerprint',
            'bindingsFingerprint','defaultsFingerprint','emailCount','principalCount']);
        foreach(['appSourceFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint','runtimeFingerprint'] as $key)
            self::need($r[$key]===$p[$key],'receipt_origin');
        self::need($r['generation']===$p['originGeneration']&&$r['emailCount']===count($p['identities'])
            &&is_int($r['principalCount'])&&$r['principalCount']>0&&$r['principalCount']<=500,'receipt_inventory');
        foreach(['beforePolicyFingerprint','afterPolicyFingerprint','identityFingerprint','capabilitiesFingerprint','bindingsFingerprint','defaultsFingerprint'] as $key)$C::hash($r[$key]);
    }
    /** Compact immutable anchors survive legitimate later generations, Email
     * edits and capability changes; erased original provenance never becomes
     * an "unmanaged" fallback. Current complete ACL validation is separate. */
    public static function verifyAnchors(array $p,array $bindings,array $identities,array $scopes,array $permissions): void
    {
        $C=ClawPilotNativeEmailAuthorityContract::class;$byBinding=[];$byIdentity=[];$byScope=[];$byPermission=[];
        foreach([[$bindings,100],[$identities,500],[$scopes,100],[$permissions,500]] as [$rows,$cap])self::need(count($rows)>0&&count($rows)<=$cap,'current_bound');
        foreach($bindings as $row){$id=$row['pipeline_id'];self::need(!isset($byBinding[$id])&&(string)$row['enabled']==='1'
            &&ctype_digit((string)$row['generation'])&&(int)$row['generation']>=$p['originGeneration'],'current_binding');$byBinding[$id]=$row;}
        foreach($identities as $row){$id=$row['email_id'];self::need(!isset($byIdentity[$id])&&isset($byBinding[$row['pipeline_id']]),'current_identity');$byIdentity[$id]=$row;}
        foreach($scopes as $row){$id=$row['pipeline_id'];self::need(!isset($byScope[$id])&&isset($byBinding[$id]),'current_scope');
            $C::hash($row['operation_id']);$C::hash($row['command_hash']);$byScope[$id]=$row;}
        foreach($permissions as $row){$id=$row['email_id'];self::need(!isset($byPermission[$id])&&isset($byIdentity[$id])
            &&$row['pipeline_id']===$byIdentity[$id]['pipeline_id']&&isset($byScope[$row['pipeline_id']])
            &&in_array($row['source_kind'],['authority','publication'],true),'current_permission');
            $C::hash($row['operation_id']);$C::hash($row['command_hash']);$byPermission[$id]=$row;}
        self::need(count($byBinding)===count($byScope)&&count($byIdentity)===count($byPermission),'current_complete');
        foreach($p['pipelines'] as $anchor){$row=$byBinding[$anchor['pipelineId']]??null;
            self::need($row!==null&&$row['workspace_id']===$anchor['workspaceId']&&$row['group_id']===$anchor['groupId'],'pipeline_anchor');}
        foreach($p['identities'] as $anchor){$row=$byIdentity[$anchor['nativeId']]??null;
            self::need($row!==null&&$row['global_id']===$anchor['globalId']&&$row['local_id']===$anchor['localId']
                &&$row['pipeline_id']===$anchor['pipelineId']&&$row['workspace_id']===$anchor['workspaceId'],'identity_anchor');}
    }
}

/** Root-CLI capability, NOT a wire DTO. Only actual protected-file, native DB,
 * installation and ordinary-runtime checks can construct it. It authorizes one
 * rollback-only current inspection, never an execute/approval/public endpoint. */
final class ClawPilotNativeEmailStartupOriginAuthority
{
    private function __construct(private mysqli $connection,private int $connectionId,private array $profile,
        private string $certificatePath,private string $certificateHash,private array $proof,private array $context,
        private ?array $artifact=null,private ?string $artifactHash=null) {}
    private function __clone() {}
    public function __serialize(): array {throw new RuntimeException('Startup origin capabilities cannot be serialized');}
    public function __unserialize(array $data): void {throw new RuntimeException('Startup origin capabilities cannot be deserialized');}
    private static function root(): void
    {ClawPilotNativeEmailStartupOrigin::need(PHP_SAPI==='cli'&&PHP_OS_FAMILY==='Linux'&&PHP_VERSION_ID===80336
        &&function_exists('posix_geteuid')&&posix_geteuid()===0,'root_cli_required');}
    public static function fromProtectedFile(mysqli $db,array $profile,string $certificatePath,string $appRoot,string $initialState,string $sourceRoot): self
    {
        self::root();$O=ClawPilotNativeEmailStartupOrigin::class;$C=ClawPilotNativeEmailAuthorityContract::class;
        $C::keys($profile,['profile','database']);$O::need($profile['profile']==='suitecrm-8.10.1-mariadb-11.4.13-v1'
            &&is_string($profile['database'])&&preg_match('/^[A-Za-z0-9_]{1,64}$/D',$profile['database'])===1,'profile');
        $O::need(realpath($sourceRoot)===realpath(dirname(__DIR__)),'canonical_source_required');
        require_once $sourceRoot.'/install-native-email-initial-state.php';
        cp_scope_path($certificatePath);cp_scope_protected_directory(dirname($certificatePath),false);
        $bytes=cp_initial_private($certificatePath,262144);$envelope=json_decode($bytes,true,64,JSON_THROW_ON_ERROR);
        $O::need(is_array($envelope)&&$O::canonical($envelope)===$bytes,'certificate_canonical');
        $proof=$O::verifyEnvelope($envelope,time());$context=cp_initial_installation_context($appRoot,$initialState,$sourceRoot);
        $artifact=null;$artifactHash=null;
        if($proof['version']===2){
            require_once $sourceRoot.'/native-email-initial-cli.php';
            $O::need($appRoot===CP_INITIAL_CLI_APP&&$initialState===CP_INITIAL_CLI_STATE
                &&$certificatePath===CP_INITIAL_CLI_STATE.'/activation-origin.json','canonical_replan_paths');
            $dir=CP_INITIAL_CLI_STATE.'/operations/'.$proof['operationId'];cp_scope_protected_directory($dir,false);
            $input=cp_initial_private($dir.'/input.json');$artifactHash=hash('sha256',$input);
            $options=cp_initial_cli_options(['resolve','--operation='.$proof['operationId'],'--artifact-sha256='.$artifactHash,
                '--plan-sha256='.$proof['planHash'],'--quiescent']);
            $artifact=cp_initial_cli_artifact($options);cp_initial_cli_identity($artifact);cp_initial_cli_pins($artifact);
            $root=cp_initial_cli_installation_files($artifact);$context=$root['context'];$O::verifyArtifact($proof,$artifact,$root['binding']);
        }
        $self=new self($db,$db->thread_id,$profile,$certificatePath,hash('sha256',$bytes),$proof,$context,$artifact,$artifactHash);
        $self->assertFor($db,$profile,$proof['serviceUserId'],$proof['oauthClientId']);return $self;
    }
    private function binding(mysqli $db,array $profile,string $userId,string $clientId): void
    {
        self::root();$O=ClawPilotNativeEmailStartupOrigin::class;
        $O::need($db===$this->connection&&$db->thread_id===$this->connectionId&&$O::canonical($profile)===$O::canonical($this->profile)
            &&$userId===$this->proof['serviceUserId']&&$clientId===$this->proof['oauthClientId'],'capability_binding');
        $bytes=cp_initial_private($this->certificatePath,262144);
        $O::need(hash('sha256',$bytes)===$this->certificateHash,'certificate_changed');
        $proof=$O::verifyEnvelope(json_decode($bytes,true,64,JSON_THROW_ON_ERROR),time());
        $O::need($proof===$this->proof,'certificate_changed');
        if($this->artifact!==null){
            $input=cp_initial_private(CP_INITIAL_CLI_STATE.'/operations/'.$this->proof['operationId'].'/input.json');
            $O::need(hash('sha256',$input)===$this->artifactHash&&$O::canonical(json_decode($input,true,64,JSON_THROW_ON_ERROR))===$O::canonical($this->artifact),
                'retained_artifact_changed');
        }
        $O::need(($GLOBALS['sugar_config']['clawpilot_managed_email_write_scope']??null)===true,'managed_scope_required');
    }
    /** Before BEGIN: the installer environment verifier deliberately requires
     * an idle autocommit connection. Its entire DDL/config/journal proof runs. */
    public function assertFor(mysqli $db,array $profile,string $userId,string $clientId): void
    {
        $this->binding($db,$profile,$userId,$clientId);$O=ClawPilotNativeEmailStartupOrigin::class;
        if($this->artifact!==null){
            $root=cp_initial_cli_installation_files($this->artifact);$O::verifyArtifact($this->proof,$this->artifact,$root['binding']);
            $pins=cp_initial_cli_installation($this->artifact,$db,'resolve');
            foreach(['installationJournalFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint'] as $key)
                $O::need($pins[$key]===$this->proof[$key],'installation_changed');
            require_once __DIR__.'/NativeEmailInitialEnrollment.php';
            $history=new ClawPilotNativeEmailInitialEnrollment($db,$profile,$userId,$clientId);
            // A separate actual read-only transaction verifies all signed
            // cancelled ancestors plus exact committed B. Root quiescence and
            // the retained global CLI lock span this and the following full
            // CURRENT inspection; no cross-PG/restore/admin tamper guarantee
            // is claimed by this local startup capability.
            $history->inspectCancelledHistory($this->proof['nativeInstanceId'],[
                'plan'=>$this->artifact['plan'],'authorization'=>$this->artifact['authorization']]);
        }else{
            $m=cp_initial_install_load($this->context);$O::need($m!==null,'installation_missing');
            $binding=$m['plan']['binding'];$O::need($binding['operationId']===$this->proof['operationId']
                &&$binding['nativeInstanceId']===$this->proof['nativeInstanceId']&&$binding['appGeneration']===$this->proof['originGeneration']
                &&$binding['appSourceFingerprint']===$this->proof['appSourceFingerprint'],'installation_binding');
            $pins=cp_initial_installation_verify($this->context,$db,$binding);
            $O::need($pins['installationJournalFingerprint']===$this->proof['installationJournalFingerprint']
                &&$pins['sourceRuntimeFingerprint']===$this->proof['sourceRuntimeFingerprint']
                &&$m['plan']['database']['identity']['databaseName']===$profile['database'],'installation_changed');
        }
        $O::need(hash_equals($this->proof['runtimeFingerprint'],ClawPilotNativeEmailRuntime::attest($db)),'runtime_changed');
        $this->originAndAnchors($db);
    }
    /** Under the actual policy fence: retain metadata locks for all eight
     * registry tables and repeat actual origin/anchor checks. No bool bypass. */
    public function assertLocked(mysqli $db,array $profile,string $userId,string $clientId,ClawPilotNativeEmailTransaction $fence): void
    {
        $this->binding($db,$profile,$userId,$clientId);$fence->assertConnection($db);
        foreach(CP_INITIAL_TABLES as $table){$this->rows($db,'SELECT * FROM '.$table.' LIMIT 0',[],1);
            ClawPilotNativeEmailStartupOrigin::need(cp_initial_exact_schema($this->context,$db,$table),'schema_changed');}
        $this->originAndAnchors($db);$fence->assertConnection($db);
    }
    private function originAndAnchors(mysqli $db): void
    {
        $O=ClawPilotNativeEmailStartupOrigin::class;
        $identity=$this->rows($db,'SELECT DATABASE() AS databaseName,CURRENT_USER() AS databaseUser',[],1);
        $m=cp_initial_install_load($this->context);
        $O::need($m!==null&&count($identity)===1&&$identity[0]===$m['plan']['database']['identity'],'database_identity');
        $users=$this->rows($db,'SELECT id,is_admin,status,deleted FROM users WHERE id=? FOR UPDATE',[$this->proof['serviceUserId']],2);
        $clients=$this->rows($db,'SELECT id,assigned_user_id,deleted,allowed_grant_type FROM oauth2clients WHERE id=? FOR UPDATE',[$this->proof['oauthClientId']],2);
        $O::need(count($users)===1&&(int)$users[0]['is_admin']===1&&$users[0]['status']==='Active'&&(int)$users[0]['deleted']===0
            &&count($clients)===1&&(int)$clients[0]['deleted']===0&&$clients[0]['assigned_user_id']===$this->proof['serviceUserId']
            &&$clients[0]['allowed_grant_type']==='client_credentials','service_identity');
        $rows=$this->rows($db,'SELECT * FROM clawpilot_email_initial_enrollments WHERE operation_id=? FOR UPDATE',[$this->proof['operationId']],2);
        $O::need(count($rows)===1,'origin_missing');$O::verifyLedger($this->proof,$rows[0],time());
        $O::verifyAnchors($this->proof,$this->rows($db,'SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id FOR UPDATE',[],100),
            $this->rows($db,'SELECT * FROM clawpilot_email_identities ORDER BY email_id FOR UPDATE',[],500),
            $this->rows($db,'SELECT * FROM clawpilot_email_write_scopes ORDER BY pipeline_id FOR UPDATE',[],100),
            $this->rows($db,'SELECT * FROM clawpilot_email_write_permissions ORDER BY email_id FOR UPDATE',[],500));
    }
    private function rows(mysqli $db,string $sql,array $values,int $cap): array
    {
        $s=$db->prepare($sql);ClawPilotNativeEmailStartupOrigin::need($s instanceof mysqli_stmt,'storage');
        try{if($values)$s->bind_param(str_repeat('s',count($values)),...$values);
            ClawPilotNativeEmailStartupOrigin::need($s->execute(),'storage');$r=$s->get_result();
            ClawPilotNativeEmailStartupOrigin::need($r instanceof mysqli_result,'storage');$rows=[];$bytes=0;
            while($row=$r->fetch_assoc()){$bytes+=strlen(json_encode($row,JSON_THROW_ON_ERROR));
                ClawPilotNativeEmailStartupOrigin::need(count($rows)<$cap&&$bytes<=8388608,'storage_bound');$rows[]=$row;}return $rows;
        }finally{$s->close();}
    }
}
