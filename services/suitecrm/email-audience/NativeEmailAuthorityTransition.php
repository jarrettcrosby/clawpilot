<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailWriteScope.php';
require_once __DIR__.'/NativeEmailAuthorityContract.php';
require_once __DIR__.'/NativeEmailRuntime.php';
require_once __DIR__.'/NativeEmailAuthorityProof.php';

/** Prepared, NOT installed/activated. An exact native approval record
 * is provisioned only from the independently signed PG authority proof. Possessing
 * a command hash, ordinary publication token, or former requesting user's
 * authority is insufficient. This service cannot sign approvals or mint roles.
 *
 * Each phase mutates only bounded existing managed-group memberships, complete
 * binding pins and terminal ledgers in one existing native fenced transaction.
 * All native Email content/ownership and unrelated module permissions remain
 * untouched. Mixed editor/viewer matrices are verified, never narrowed to make
 * the old read-only publisher's stronger restriction pass. */
final class ClawPilotNativeEmailAuthorityTransition
{
    private const IDENTITY_LINK_HASH='79fcb1d94fa49d1cd9113234bbd3f8de73d8df73a738f95123375c0830f7e840';
    public function __construct(private mysqli $db,private array $profile,private string $callerId,
        private string $oauthClientId,private string $oauthAccessTokenId,private string $oauthSubject) {}
    public function execute(array $command): array {return $this->run($command,false);}
    public function resolveOrCancel(array $command): array {return $this->run($command,true);}
    /** Authenticated, rollback-only observation for the real application plan
     * builder. It never approves a transition, enrolls an identity, returns an
     * Email body or substitutes for the application's durable drain/authority
     * check. Every execution rechecks these provisional CAS preimages. */
    public function inspect(array $input): array
    {
        ClawPilotNativeEmailAuthorityContract::keys($input,['version']);
        self::need($input['version']===1,'authority_inspection_version');
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {
            $snapshot=$this->inspectLocked($tx);$tx->rollback();return $snapshot;
        }catch(Throwable $error){
            try{$tx->rollback();}catch(Throwable $ignored){}
            if($error instanceof ClawPilotNativeEmailTransactionRefused)throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('authority_inspection_failed');
        }
    }
    /** Offline enrolled-startup observation only. The unforgeable-by-wire
     * root-CLI capability replaces OAuth authentication for this one read-only
     * pass; ordinary inspect/execute/approval callers retain their own gates. */
    public function inspectStartupOrigin(ClawPilotNativeEmailStartupOriginAuthority $origin): array
    {
        $origin->assertFor($this->db,$this->profile,$this->callerId,$this->oauthClientId);
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try{
            $snapshot=$this->inspectLocked($tx,$origin);
            $origin->assertLocked($this->db,$this->profile,$this->callerId,$this->oauthClientId,$tx);
            $tx->rollback();return $snapshot;
        }catch(Throwable $error){
            try{$tx->rollback();}catch(Throwable $ignored){}
            if($error instanceof ClawPilotNativeEmailTransactionRefused)throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('startup_origin_inspection_failed');
        }
    }
    /** Forecast only exact managed membership changes without mutating any
     * native row, even temporarily. Sensitive user/config policy bytes remain
     * inside the native fence. Possessing these hashes grants no authority. */
    public function project(array $input): array
    {
        ClawPilotNativeEmailAuthorityContract::keys($input,['version','beforePolicyFingerprint','beforeBindingsFingerprint',
            'revokeMembershipChanges','grantMembershipChanges']);
        self::need($input['version']===1,'authority_inspection_version');
        foreach(['beforePolicyFingerprint','beforeBindingsFingerprint'] as $key)ClawPilotNativeEmailAuthorityContract::hash($input[$key]);
        $revoke=new ClawPilotNativeEmailAuthorityDelta('revoke',$input['revokeMembershipChanges']);
        $grant=new ClawPilotNativeEmailAuthorityDelta('grant',$input['grantMembershipChanges']);
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {
            $snapshot=$this->inspectLocked($tx);
            self::need(hash_equals($snapshot['nativePolicyFingerprint'],$input['beforePolicyFingerprint'])
                && hash_equals($snapshot['beforeBindingsFingerprint'],$input['beforeBindingsFingerprint']),
                'authority_inspection_preimage_changed');
            $groups=[];foreach($snapshot['bindings'] as $binding)$groups[$binding['group_id']]=$binding;
            foreach([$revoke,$grant] as $delta)foreach($delta->changes as $change) {
                $row=$change['after'];$binding=$groups[$row['securitygroup_id']]??null;
                self::need($binding!==null && $row['user_id']!==$binding['owner_id'],'authority_membership_outside_binding');
                self::need(in_array($row['user_id'],$snapshot['principalSuiteCrmUserIds'],true),'authority_capability_principal_changed');
                if($delta->phase==='grant') {
                    $user=$this->rows('SELECT id,status,deleted FROM users WHERE id=?',[$row['user_id']]);
                    self::need(count($user)===1 && $user[0]['status']==='Active' && (int)$user[0]['deleted']===0,'authority_new_reader_inactive');
                }
            }
            $projection=$tx->projectAuthorityMembershipPolicies($revoke,$grant);$tx->rollback();
            return ['version'=>1]+$projection;
        }catch(Throwable $error){
            try{$tx->rollback();}catch(Throwable $ignored){}
            if($error instanceof ClawPilotNativeEmailTransactionRefused)throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('authority_projection_failed');
        }
    }
    private function inspectLocked(ClawPilotNativeEmailTransaction $tx,?ClawPilotNativeEmailStartupOriginAuthority $origin=null): array
    {
        $this->storage($tx);
        if($origin===null)$this->caller();
        else $origin->assertLocked($this->db,$this->profile,$this->callerId,$this->oauthClientId,$tx);
        $this->capabilityStorage();
        $bindings=array_map(static fn($row)=>ClawPilotNativeEmailAuthorityContract::nativeBinding($row,2),
            $this->rows('SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id FOR UPDATE'));
        self::need(count($bindings)>0 && count($bindings)<=100,'authority_binding_bound');
        $generation=(int)$bindings[0]['generation'];$policy=$tx->immutablePolicyFingerprint();
        $runtime=ClawPilotNativeEmailRuntime::attest($this->db);
        $users=$this->rows('SELECT id FROM users WHERE deleted=0 ORDER BY id');
        $principals=array_column($users,'id');ClawPilotNativeEmailAuthorityContract::ids($principals);
        $pairs=[];$byPipeline=[];
        foreach($bindings as $binding) {
            self::need((int)$binding['generation']===$generation && hash_equals($binding['policy_fingerprint'],$policy)
                && hash_equals($binding['runtime_fingerprint'],$runtime),'authority_inspection_pins_changed');
            if($binding['capability_policy_json']!==null) {
                $capability=json_decode($binding['capability_policy_json'],true,32,JSON_THROW_ON_ERROR);
                self::need($capability['principalSuiteCrmUserIds']===$principals,'authority_capability_principal_changed');
            }
            $pairs[]=['before'=>$binding,'after'=>$binding];$byPipeline[$binding['pipeline_id']]=$binding;
        }
        // Native operation rows are terminal-only. The application must also
        // hold its PG control row and prove no unacknowledged publication; a
        // missing native row alone is never proof that an app writer drained.
        self::need($this->rows("SELECT operation_id FROM clawpilot_email_operations WHERE state NOT IN ('committed','cancelled') LIMIT 1 FOR UPDATE")===[],
            'authority_publication_not_terminal');
        $identities=$this->rows('SELECT * FROM clawpilot_email_identities ORDER BY email_id FOR UPDATE');
        self::need(count($identities)<=500,'authority_email_bound');
        $actual=$this->readCapabilities($identities,$users,$tx);$capabilities=[];$expected=[];
        foreach($identities as $identity) {
            $binding=$byPipeline[$identity['pipeline_id']]??null;
            self::need($binding!==null,'authority_email_inventory_changed');
            $matrix=$actual[$identity['email_id']];
            ClawPilotNativeEmailCapabilityContract::validateTarget($matrix,json_decode($binding['readers_json'],true),$principals);
            $row=['emailId'=>$identity['email_id'],'globalId'=>$identity['global_id'],'pipelineId'=>$identity['pipeline_id']];
            $capabilities[]=$row+['capabilities'=>$matrix];$expected[]=$row+['before'=>$matrix,'after'=>$matrix];
        }
        $command=['version'=>2,'phase'=>'revoke','bindings'=>$pairs,'capabilities'=>$expected,'membershipChanges'=>[]];
        $this->groups($command,'before');$this->identities($command);
        $memberships=array_map([ClawPilotNativeEmailAuthorityDelta::class,'nativeRow'],$this->rows(
            'SELECT m.* FROM securitygroups_users m JOIN clawpilot_email_bindings b ON b.group_id=m.securitygroup_id ORDER BY m.id FOR UPDATE'));
        self::need(count($memberships)<=10000,'authority_membership_bound');
        $snapshot=['version'=>1,'generation'=>$generation,'nativePolicyFingerprint'=>$policy,'runtimeFingerprint'=>$runtime,
            'beforeBindingsFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($bindings),'bindings'=>$bindings,
            'memberships'=>$memberships,'capabilities'=>$capabilities,'principalSuiteCrmUserIds'=>$principals];
        self::need(strlen(ClawPilotNativeEmailAuthorityContract::canonical($snapshot))<=800000,'authority_inspection_size');
        return $snapshot;
    }
    /** A never-provisioned expired approval cannot use ordinary resolution. This
     * terminal-only recovery retains the original signed evidence and settles
     * its exact operation atomically. It cannot grant/execute/renew/rewrite any
     * authority. An existing commit is reported truthfully, never cancelled. */
    public function cancelExpired(array $command,array $authorization): array
    {
        ClawPilotNativeEmailAuthorityContract::validate($command);
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {
            $this->storage($tx);$this->caller();
            $proof=ClawPilotNativeEmailAuthorityProof::verify($authorization,$command,$this->callerId,$this->oauthClientId,true);
            self::need($proof['expiresAt']<=time(),'authority_proof_not_expired');
            // Grant cancellation requires the same independently committed
            // revoke/app evidence and (for retries) retained predecessor chain
            // as execution. Expiry is not authority and never erases a commit.
            $this->grantEvidence($command,$proof);
            $hash=ClawPilotNativeEmailAuthorityContract::digest($command);
            $row=$this->approvalRow($command,$authorization,$proof);
            $prior=$this->rows('SELECT * FROM clawpilot_email_authority_approvals WHERE operation_id=? FOR UPDATE',[$command['operationId']]);
            if($prior) {
                self::need(count($prior)===1,'authority_approval_conflict');
                // Revocation or shortened operational expiry must not stop a
                // currently authorized service from obtaining a terminal fact.
                // All signed fields and their original bytes remain exact.
                $immutable=$prior[0];$immutable['revoked']=$row['revoked'];$immutable['expires_at']=$row['expires_at'];
                self::need(ClawPilotNativeEmailAuthorityContract::canonical($immutable)===ClawPilotNativeEmailAuthorityContract::canonical($row),
                    'authority_approval_conflict');
            }else $this->insertApproval($row);
            // Match the existing phase lock order, with no binding validation
            // against stale generation pins: this operation is terminal only.
            $bindings=$this->rows('SELECT pipeline_id FROM clawpilot_email_bindings ORDER BY pipeline_id FOR UPDATE');
            self::need(count($bindings)<=100,'authority_binding_bound');
            $operations=$this->rows('SELECT * FROM clawpilot_email_authority_operations WHERE operation_id=? FOR UPDATE',[$command['operationId']]);
            if($operations) {
                self::need(count($operations)===1 && $operations[0]['transition_id']===$command['transitionId']
                    && $operations[0]['command_hash']===$hash && $operations[0]['phase']===$command['phase']
                    && in_array($operations[0]['state'],['committed','cancelled'],true),'authority_operation_conflict');
                $op=$operations[0];$result=$op['result_json']===null?null:json_decode($op['result_json'],true,64,JSON_THROW_ON_ERROR);
                self::need(($op['state']==='committed')===is_array($result),'authority_receipt_state');
                $receipt=$this->receipt($command,$hash,$op['state'],$result,true);
            }else {
                $this->writeReceipt($command,$hash,'cancelled',null);
                $receipt=$this->receipt($command,$hash,'cancelled',null,false);
            }
            $tx->commit();return ['approval'=>$this->approvalReadback($command,$row,(bool)$prior),'receipt'=>$receipt];
        }catch(Throwable $error){
            try{$tx->rollback();}catch(Throwable $ignored){}
            if($error instanceof ClawPilotNativeEmailTransactionRefused)throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('authority_expired_resolution_failed');
        }
    }
    /** Requires both original OAuth authority and an independently signed PG
     * admission/commit proof. Never accepts an arbitrary appCommit fingerprint.
     * Exact repeated approval is read-only; renewal/overwrite is not supported. */
    public function approve(array $command,array $authorization): array
    {
        ClawPilotNativeEmailAuthorityContract::validate($command);
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {
            $this->storage($tx);$this->caller();
            // Expired exact evidence remains observable, but may never create
            // a fresh approval or renew a retained approval's signed expiry.
            $proof=ClawPilotNativeEmailAuthorityProof::verify($authorization,$command,$this->callerId,$this->oauthClientId,true);
            $this->grantEvidence($command,$proof);
            $row=$this->approvalRow($command,$authorization,$proof);
            $prior=$this->rows('SELECT * FROM clawpilot_email_authority_approvals WHERE operation_id=? FOR UPDATE',[$command['operationId']]);
            if($prior) {
                self::need(count($prior)===1 && ClawPilotNativeEmailAuthorityContract::canonical($prior[0])===ClawPilotNativeEmailAuthorityContract::canonical($row),
                    'authority_approval_conflict');
            } else {
                ClawPilotNativeEmailAuthorityProof::verify($authorization,$command,$this->callerId,$this->oauthClientId);
                $this->insertApproval($row);
            }
            $tx->commit();
            return $this->approvalReadback($command,$row,(bool)$prior);
        } catch(Throwable $error) {
            try{$tx->rollback();}catch(Throwable $ignored){}
            if($error instanceof ClawPilotNativeEmailTransactionRefused)throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('authority_approval_failed');
        }
    }
    private function approvalRow(array $c,array $authorization,array $proof): array
    {
        $json=ClawPilotNativeEmailAuthorityContract::canonical($proof);
        return ['operation_id'=>$c['operationId'],'transition_id'=>$c['transitionId'],'command_hash'=>ClawPilotNativeEmailAuthorityContract::digest($c),
            'desired_app_change_hash'=>$c['desiredAppChangeHash'],'phase'=>$c['phase'],'service_user_id'=>$this->callerId,
            'oauth_client_id'=>$this->oauthClientId,'app_commit_fingerprint'=>$proof['appCommit']===null?null:ClawPilotNativeEmailAuthorityContract::digest($proof['appCommit']),
            'proof_hash'=>hash('sha256',$json),'proof_json'=>$json,'proof_signature'=>$authorization['signature'],
            'expires_at'=>gmdate('Y-m-d H:i:s',$proof['expiresAt']).'.000000','revoked'=>0];
    }
    private function insertApproval(array $row): void
    {
        $this->write('INSERT INTO clawpilot_email_authority_approvals(operation_id,transition_id,command_hash,desired_app_change_hash,phase,
            service_user_id,oauth_client_id,app_commit_fingerprint,proof_hash,proof_json,proof_signature,expires_at,revoked)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',array_values($row));
        $saved=$this->rows('SELECT * FROM clawpilot_email_authority_approvals WHERE operation_id=? FOR UPDATE',[$row['operation_id']]);
        self::need(count($saved)===1 && ClawPilotNativeEmailAuthorityContract::canonical($saved[0])===ClawPilotNativeEmailAuthorityContract::canonical($row),
            'authority_approval_write_changed');
    }
    private function approvalReadback(array $c,array $row,bool $replayed): array
    {return ['version'=>1,'operationId'=>$c['operationId'],'transitionId'=>$c['transitionId'],'phase'=>$c['phase'],
        'commandHash'=>$row['command_hash'],'proofHash'=>$row['proof_hash'],'appCommitFingerprint'=>$row['app_commit_fingerprint'],'replayed'=>$replayed];}
    private function run(array $c,bool $resolve): array
    {
        ClawPilotNativeEmailAuthorityContract::validate($c);$hash=ClawPilotNativeEmailAuthorityContract::digest($c);
        self::need((($c['roleChanges']??[])===[]&&($c['identityLinks']??[])===[]) || ClawPilotNativeEmailWriteScope::enabled(),'managed_write_scope_not_enabled');
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->profile);
        try {
            $this->storage($tx);$this->caller();$this->approval($c,$hash,$resolve);
            $tx->markStage('approval');
            // Same order as the publisher: policy -> bindings -> operations ->
            // identity/content. The full binding set includes unaffected scopes.
            $bindings=$this->rows('SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id FOR UPDATE');
            self::need(count($bindings)<=100,'authority_binding_bound');
            $prior=$this->rows('SELECT * FROM clawpilot_email_authority_operations WHERE operation_id=? FOR UPDATE',[$c['operationId']]);
            if($prior) {
                self::need(count($prior)===1 && $prior[0]['transition_id']===$c['transitionId']
                    && $prior[0]['command_hash']===$hash && $prior[0]['phase']===$c['phase'],'authority_operation_conflict');
                $row=$prior[0];self::need(in_array($row['state'],['committed','cancelled'],true),'authority_operation_state');
                $result=$row['result_json']===null?null:json_decode($row['result_json'],true,64,JSON_THROW_ON_ERROR);
                self::need(($row['state']==='committed')===is_array($result),'authority_receipt_state');
                $tx->commit();return $this->receipt($c,$hash,$row['state'],$result,true);
            }
            if($resolve) {
                $this->writeReceipt($c,$hash,'cancelled',null);$tx->commit();
                return $this->receipt($c,$hash,'cancelled',null,false);
            }
            $identitySnapshot=null;
            if(isset($c['identityLinks'])){
                $identityFile=__DIR__.'/NativeEmailIdentityLink.php';
                self::need(is_file($identityFile)&&!is_link($identityFile)
                    &&hash_equals(self::IDENTITY_LINK_HASH,hash_file('sha256',$identityFile)),'identity_link_code_changed');
                require_once $identityFile;
                $identitySnapshot=ClawPilotNativeEmailIdentityLink::inspect($this->db,$tx,$c['identityLinks']);
            }
            if($c['version']===2)$this->capabilityStorage();
            $bindings=array_map(static fn($b)=>ClawPilotNativeEmailAuthorityContract::nativeBinding($b,$c['version']),$bindings);
            self::need(hash_equals($c['beforePolicyFingerprint'],$tx->immutablePolicyFingerprint())
                && hash_equals($c['runtimeFingerprint'],ClawPilotNativeEmailRuntime::attest($this->db)),'authority_before_policy_changed');
            self::need(ClawPilotNativeEmailAuthorityContract::digest($bindings)===$c['beforeBindingsFingerprint']
                && ClawPilotNativeEmailAuthorityContract::digest($bindings)===ClawPilotNativeEmailAuthorityContract::digest(array_column($c['bindings'],'before')),
                'authority_binding_preimage_changed');
            $tx->markStage('runtime_before');
            $this->groups($c,'before');
            $publication=$this->publicationTerminal($c);
            $identities=$this->identities($c);
            $tx->markStage('identities');
            $this->capabilities($c,$identities,'before',$tx);
            $tx->markStage('acl_before');
            $delta=new ClawPilotNativeEmailAuthorityDelta($c['phase'],$c['membershipChanges']);
            $tx->admitAuthorityMembershipDelta($delta);
            foreach($delta->changes as $change) {
                $a=$change['after'];
                if($change['before']===null) $this->write('INSERT INTO securitygroups_users
                    (id,date_modified,deleted,securitygroup_id,user_id,primary_group,noninheritable) VALUES (?,?,?,?,?,?,?)',
                    [$a['id'],$a['date_modified'],$a['deleted'],$a['securitygroup_id'],$a['user_id'],$a['primary_group'],$a['noninheritable']]);
                else $this->write('UPDATE securitygroups_users SET date_modified=?,deleted=? WHERE id=?',[$a['date_modified'],$a['deleted'],$a['id']]);
            }
            $this->groups($c,'after');
            $tx->markStage('memberships');
            if($c['version']===2 && ClawPilotNativeEmailWriteScope::enabled()){
                // Exact preimages and original native ACLs were proved above.
                // Stage scoped matrices in this transaction before checking the
                // real patched ACL path. Failure rolls every staged row back.
                $this->writeCapabilityIdentities($c,$identities);
                ClawPilotNativeEmailWriteScope::authority($this->db,$c,$identities);
            }
            $tx->markStage('permission_rows');
            $this->capabilities($c,$identities,'after',$tx);
            $tx->markStage('acl_after');
            self::need(hash_equals($c['afterPolicyFingerprint'],$tx->authorityPostPolicyFingerprint()),'authority_after_policy_changed');
            if($c['version']===2 && !ClawPilotNativeEmailWriteScope::enabled())$this->writeCapabilityIdentities($c,$identities);
            foreach($c['bindings'] as $pair) {
                $b=$pair['after'];
                if($c['version']===2)$this->write('UPDATE clawpilot_email_bindings SET generation=?,readers_json=?,audience_fingerprint=?,policy_fingerprint=?,capability_policy_json=?,capability_policy_fingerprint=? WHERE pipeline_id=?',
                    [$b['generation'],$b['readers_json'],$b['audience_fingerprint'],$b['policy_fingerprint'],$b['capability_policy_json'],$b['capability_policy_fingerprint'],$b['pipeline_id']]);
                else $this->write('UPDATE clawpilot_email_bindings SET generation=?,readers_json=?,audience_fingerprint=?,policy_fingerprint=? WHERE pipeline_id=?',
                    [$b['generation'],$b['readers_json'],$b['audience_fingerprint'],$b['policy_fingerprint'],$b['pipeline_id']]);
            }
            $after=array_map(static fn($b)=>ClawPilotNativeEmailAuthorityContract::nativeBinding($b,$c['version']),
                $this->rows('SELECT * FROM clawpilot_email_bindings ORDER BY pipeline_id FOR UPDATE'));
            self::need(ClawPilotNativeEmailAuthorityContract::digest($after)===$c['afterBindingsFingerprint']
                && hash_equals($c['runtimeFingerprint'],ClawPilotNativeEmailRuntime::attest($this->db)),'authority_after_binding_changed');
            $tx->markStage('runtime_after');
            $matrix=array_map(static fn($r)=>['emailId'=>$r['emailId'],'globalId'=>$r['globalId'],'pipelineId'=>$r['pipelineId'],'capabilities'=>$r['after']],$c['capabilities']);
            $result=['desiredAppChangeHash'=>$c['desiredAppChangeHash'],'generationFrom'=>$c['generationFrom'],'generationTo'=>$c['generationTo'],
                'beforePolicyFingerprint'=>$c['beforePolicyFingerprint'],'afterPolicyFingerprint'=>$c['afterPolicyFingerprint'],
                'beforeBindingsFingerprint'=>$c['beforeBindingsFingerprint'],'afterBindingsFingerprint'=>$c['afterBindingsFingerprint'],
                'capabilitiesFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($matrix),'pendingPublicationTerminalReceipt'=>$publication];
            if($identitySnapshot!==null)ClawPilotNativeEmailIdentityLink::assertUnchanged($this->db,$tx,$identitySnapshot);
            $this->writeReceipt($c,$hash,'committed',$result);$tx->markStage('receipt');$tx->commit();
            return $this->receipt($c,$hash,'committed',$result,false);
        } catch(Throwable $error) {
            try{$tx->rollback();}catch(Throwable $ignored){}
            if($error instanceof ClawPilotNativeEmailTransactionRefused)throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('authority_transition_failed');
        }
    }
    private function caller(): void
    {
        $expected=(string)getenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID');
        self::need($expected!=='' && hash_equals($expected,$this->oauthClientId)
            && preg_match('/^[a-f0-9]{80}$/D',$this->oauthAccessTokenId)===1,'authority_client_not_configured');
        $user=$GLOBALS['current_user']??null;
        self::need($user instanceof User && (string)$user->id===$this->callerId && $user->isAdmin() && $user->status==='Active'
            && DBManagerFactory::getInstance()->database===$this->db,'authority_actor_unproven');
        $u=$this->rows('SELECT id,status,is_admin,deleted FROM users WHERE id=? FOR UPDATE',[$this->callerId]);
        $clients=$this->rows('SELECT assigned_user_id,deleted,allowed_grant_type FROM oauth2clients WHERE id=? FOR UPDATE',[$this->oauthClientId]);
        $tokens=$this->rows('SELECT assigned_user_id,client,deleted,token_is_revoked,access_token_expires>UTC_TIMESTAMP() AS unexpired
            FROM oauth2tokens WHERE access_token=? ORDER BY id LIMIT 2 FOR UPDATE',[$this->oauthAccessTokenId]);
        self::need(count($u)===1 && $u[0]['status']==='Active' && (int)$u[0]['is_admin']===1 && (int)$u[0]['deleted']===0
            && count($clients)===1 && (int)$clients[0]['deleted']===0 && $clients[0]['assigned_user_id']===$this->callerId
            && count($tokens)===1 && (int)$tokens[0]['deleted']===0 && in_array($tokens[0]['token_is_revoked'],[0,'0'],true)
            && (int)$tokens[0]['unexpired']===1 && $tokens[0]['client']===$this->oauthClientId && $tokens[0]['assigned_user_id']===$this->callerId
            && ($this->oauthSubject==='' ? $clients[0]['allowed_grant_type']==='client_credentials' : $this->oauthSubject===$this->callerId),
            'authority_token_revoked');
    }
    private function approval(array $c,string $hash,bool $resolve): void
    {
        $rows=$this->rows('SELECT *,expires_at>UTC_TIMESTAMP() AS unexpired FROM clawpilot_email_authority_approvals WHERE operation_id=? FOR UPDATE',[$c['operationId']]);
        self::need(count($rows)===1,'authority_approval_missing');$a=$rows[0];
        self::need($a['transition_id']===$c['transitionId'] && $a['command_hash']===$hash && $a['desired_app_change_hash']===$c['desiredAppChangeHash']
            && $a['phase']===$c['phase'] && $a['service_user_id']===$this->callerId && $a['oauth_client_id']===$this->oauthClientId,
            'authority_approval_identity_changed');
        $proof=json_decode($a['proof_json'],true,16,JSON_THROW_ON_ERROR);
        self::need(ClawPilotNativeEmailAuthorityContract::canonical($proof)===$a['proof_json']
            && hash('sha256',$a['proof_json'])===$a['proof_hash'],'authority_stored_proof_changed');
        $proof=ClawPilotNativeEmailAuthorityProof::verify(['proof'=>$proof,'signature'=>$a['proof_signature']],$c,$this->callerId,$this->oauthClientId,$resolve);
        self::need($a['app_commit_fingerprint']===($proof['appCommit']===null?null:ClawPilotNativeEmailAuthorityContract::digest($proof['appCommit'])),
            'authority_stored_app_commit_changed');
        $this->grantEvidence($c,$proof);
        // A revoked/expired requester cannot authorize another mutation, but a
        // currently authenticated service resolver can reconcile the exact old
        // operation/cancellation. It does not borrow that requester's session.
        if(!$resolve)self::need((int)$a['revoked']===0 && (int)$a['unexpired']===1,'authority_approval_expired');
    }
    private function grantEvidence(array $c,array $proof): void
    {
        if($c['phase']!=='grant')return;
        $rows=$this->rows('SELECT * FROM clawpilot_email_authority_operations WHERE operation_id=? FOR UPDATE',[$proof['revokeOperationId']]);
        self::need(count($rows)===1 && $rows[0]['state']==='committed' && $rows[0]['phase']==='revoke'
            && $rows[0]['transition_id']===$c['transitionId'] && $rows[0]['command_hash']===$proof['revokeCommandHash'],'authority_revoke_receipt_missing');
        $r=$rows[0];$result=json_decode($r['result_json'],true,64,JSON_THROW_ON_ERROR);
        self::need(is_array($result) && $result['desiredAppChangeHash']===$c['desiredAppChangeHash']
            && $result['generationTo']===$c['generationFrom'] && $result['afterPolicyFingerprint']===$c['beforePolicyFingerprint']
            && $result['afterBindingsFingerprint']===$c['beforeBindingsFingerprint'],'authority_revoke_receipt_chain');
        $receipt=['version'=>$c['version'],'operationId'=>$r['operation_id'],'transitionId'=>$r['transition_id'],'phase'=>'revoke',
            'commandHash'=>$r['command_hash'],'state'=>'committed','replayed'=>false,'result'=>$result];
        self::need(ClawPilotNativeEmailAuthorityContract::digest($receipt)===$proof['appCommit']['revokeReceiptHash'],'authority_revoke_receipt_changed');
        $prior=$this->rows('SELECT proof_json,proof_hash FROM clawpilot_email_authority_approvals WHERE operation_id=? FOR UPDATE',[$proof['revokeOperationId']]);
        self::need(count($prior)===1 && hash('sha256',$prior[0]['proof_json'])===$prior[0]['proof_hash'],'authority_revoke_approval_missing');
        $p=json_decode($prior[0]['proof_json'],true,16,JSON_THROW_ON_ERROR);
        self::need(($p['planHash']??null)===$proof['planHash'] && ($p['commandHash']??null)===$proof['revokeCommandHash']
            && ($p['desiredAppChangeHash']??null)===$proof['desiredAppChangeHash'],'authority_revoke_plan_changed');
        if($proof['version']===2)$this->grantAttemptEvidence($c,$proof);
    }
    private function grantAttemptEvidence(array $c,array $proof): void
    {
        $attempt=$proof['grantAttempt'];
        $previous=$c;$previous['operationId']=$attempt['previousOperationId'];
        $prior=$this->retainedCancelledGrant($previous,$proof);
        self::need($prior['receiptHash']===$attempt['previousCancellationReceiptHash'],'authority_grant_attempt_receipt_changed');
        if($attempt['ordinal']===1) {
            self::need($prior['proof']['version']===1,'authority_grant_attempt_original');
        } else {
            $p=$prior['proof'];
            self::need($p['version']===2 && $p['grantAttempt']['ordinal']===$attempt['ordinal']-1
                && $p['grantAttempt']['originalOperationId']===$attempt['originalOperationId']
                && $p['grantAttempt']['originalCommandHash']===$attempt['originalCommandHash'],'authority_grant_attempt_predecessor');
            $original=$c;$original['operationId']=$attempt['originalOperationId'];
            $anchor=$this->retainedCancelledGrant($original,$proof);
            self::need($anchor['proof']['version']===1,'authority_grant_attempt_original');
        }
        // Constant-cost inductive lineage: the immutable predecessor approval
        // passed this same gate when admitted. Recheck its signature, exact
        // command and terminal cancellation plus the original v1 anchor. No
        // caller-supplied receipt, skipped ordinal or renewed old approval can
        // provide this evidence, and no unbounded ancestor walk is required.
    }
    private function retainedCancelledGrant(array $command,array $successor): array
    {
        $C=ClawPilotNativeEmailAuthorityContract::class;$hash=$C::digest($command);
        $approvals=$this->rows('SELECT * FROM clawpilot_email_authority_approvals WHERE operation_id=? FOR UPDATE',[$command['operationId']]);
        self::need(count($approvals)===1,'authority_grant_attempt_approval_missing');$row=$approvals[0];
        $proof=json_decode($row['proof_json'],true,16,JSON_THROW_ON_ERROR);
        self::need($C::canonical($proof)===$row['proof_json'] && hash('sha256',$row['proof_json'])===$row['proof_hash'],
            'authority_stored_proof_changed');
        $authorization=['proof'=>$proof,'signature'=>$row['proof_signature']];
        $proof=ClawPilotNativeEmailAuthorityProof::verify($authorization,$command,$this->callerId,$this->oauthClientId,true);
        $expected=$this->approvalRow($command,$authorization,$proof);
        // Operational expiry/revocation may change independently; it does not
        // rewrite original signed evidence or authorize the fresh successor.
        $expected['expires_at']=$row['expires_at'];$expected['revoked']=$row['revoked'];
        self::need($C::canonical($expected)===$C::canonical($row),'authority_grant_attempt_approval_changed');
        foreach(['purpose','issuer','audience','keyId','nativeInstanceId','transitionId','planHash','desiredAppChangeHash',
            'phase','serviceUserId','oauthClientId','revokeOperationId','revokeCommandHash','appCommit'] as $key)
            self::need($C::canonical($proof[$key])===$C::canonical($successor[$key]),'authority_grant_attempt_evidence_changed');
        $operations=$this->rows('SELECT * FROM clawpilot_email_authority_operations WHERE operation_id=? FOR UPDATE',[$command['operationId']]);
        self::need(count($operations)===1 && $operations[0]['transition_id']===$command['transitionId']
            && $operations[0]['command_hash']===$hash && $operations[0]['phase']==='grant'
            && $operations[0]['state']==='cancelled' && $operations[0]['result_json']===null,'authority_grant_attempt_not_cancelled');
        return ['proof'=>$proof,'receiptHash'=>$C::digest($this->receipt($command,$hash,'cancelled',null,false))];
    }
    private function groups(array $c,string $stage): void
    {
        // The dedicated authenticated administrator applies the exact signed
        // PG authority plan; the service identity is not the pipeline owner.
        // All owners must remain real/active under the same policy locks, and
        // binding/Email ownership stays immutable. This does not authorize
        // owner transfers or publication as another native user.
        $owners=array_values(array_unique(array_map(static fn($pair)=>$pair[$stage]['owner_id'],$c['bindings'])));
        sort($owners,SORT_STRING);
        self::need(count($owners)>0 && count($owners)<=100,'authority_binding_bound');
        $users=$this->rows('SELECT id,status,deleted FROM users WHERE id IN ('.implode(',',array_fill(0,count($owners),'?')).') ORDER BY id FOR UPDATE',$owners);
        self::need(array_column($users,'id')===$owners && array_filter($users,static fn($user)=>
            $user['status']!=='Active' || !in_array($user['deleted'],[0,'0'],true))===[],'authority_binding_owner_inactive');
        foreach($c['bindings'] as $pair) {
            $b=$pair[$stage];
            $g=$this->rows('SELECT id,deleted,noninheritable FROM securitygroups WHERE id=? FOR UPDATE',[$b['group_id']]);
            self::need(count($g)===1 && (int)$g[0]['deleted']===0 && (int)$g[0]['noninheritable']===1,'authority_managed_group_changed');
            self::need($this->rows('SELECT id FROM securitygroups_acl_roles WHERE securitygroup_id=? AND deleted=0',[$b['group_id']])===[],
                'authority_group_role_not_supported');
            $members=$this->rows('SELECT user_id,noninheritable FROM securitygroups_users WHERE securitygroup_id=? AND deleted=0 ORDER BY user_id',[$b['group_id']]);
            self::need(array_column($members,'user_id')===json_decode($b['readers_json'],true)
                && array_filter($members,static fn($r)=>(string)$r['noninheritable']!=='1')===[],'authority_group_members_changed');
            // Reader groups must not also scope another native module or any
            // unregistered historical Email; such effects require a wider plan.
            $foreign=$this->rows("SELECT r.id FROM securitygroups_records r LEFT JOIN clawpilot_email_identities i
                ON i.email_id=r.record_id AND i.pipeline_id=? WHERE r.securitygroup_id=? AND r.deleted=0
                AND (r.module<>'Emails' OR i.email_id IS NULL) LIMIT 1",[$b['pipeline_id'],$b['group_id']]);
            self::need($foreign===[],'authority_group_has_unmanaged_records');
        }
        if($c['phase']==='grant' && $stage==='before')foreach($c['membershipChanges'] as $change) {
            $u=$this->rows('SELECT id,status,deleted FROM users WHERE id=?',[$change['after']['user_id']]);
            self::need(count($u)===1 && $u[0]['status']==='Active' && (int)$u[0]['deleted']===0,'authority_new_reader_inactive');
        }
    }
    private function identities(array $c): array
    {
        $identities=$this->rows('SELECT * FROM clawpilot_email_identities ORDER BY email_id FOR UPDATE');
        self::need(count($identities)<=500 && count($identities)===count($c['capabilities']),'authority_email_inventory_incomplete');
        // Lock/read the same complete set in two bounded joins rather than two
        // round trips per Email. LEFT JOIN retains missing rows as failures;
        // duplicate native rows/links cannot disappear into an aggregate.
        $emails=$this->rows('SELECT i.email_id AS registered_email_id,e.id,e.assigned_user_id,e.created_by,e.deleted,c.global_id_c
            FROM clawpilot_email_identities i LEFT JOIN emails e ON e.id=i.email_id
            LEFT JOIN emails_cstm c ON c.id_c=e.id ORDER BY i.email_id LIMIT 501 FOR UPDATE');
        $links=$this->rows("SELECT i.email_id AS registered_email_id,r.securitygroup_id,r.deleted
            FROM clawpilot_email_identities i LEFT JOIN securitygroups_records r ON r.record_id=i.email_id AND r.module='Emails'
            ORDER BY i.email_id,r.id LIMIT 501 FOR UPDATE");
        self::need(count($emails)===count($identities),'authority_deleted_identity_requires_review');
        self::need(count($links)===count($identities),'authority_email_group_changed');
        $bindings=[];foreach($c['bindings'] as $b)$bindings[$b['before']['pipeline_id']]=$b['before'];
        ClawPilotNativeEmailWriteScope::assertIdentities($this->db,$identities);
        foreach($identities as $index=>$id) {
            $expected=$c['capabilities'][$index];$b=$bindings[$id['pipeline_id']]??null;
            self::need($b!==null && $id['email_id']===$expected['emailId'] && $id['global_id']===$expected['globalId']
                && $id['pipeline_id']===$expected['pipelineId'] && $id['workspace_id']===$b['workspace_id'],'authority_email_inventory_changed');
            if($c['version']===2) {
                if($b['capability_policy_json']===null)self::need($id['capabilities_json']===null,'authority_capability_identity_mode_changed');
                else {
                    self::need(is_string($id['capabilities_json']) && strlen($id['capabilities_json'])<=600000,'authority_capability_identity_unreviewed');
                    $stored=json_decode($id['capabilities_json'],true,16,JSON_THROW_ON_ERROR);
                    self::need(is_array($stored) && ClawPilotNativeEmailAuthorityContract::digest($stored)
                        ===ClawPilotNativeEmailAuthorityContract::digest($expected['before']),'authority_capability_identity_changed');
                }
            }
            $email=$emails[$index];$link=$links[$index];
            self::need($email['registered_email_id']===$id['email_id'] && $email['id']===$id['email_id']
                && $email['deleted']!==null && (int)$email['deleted']===0,'authority_deleted_identity_requires_review');
            self::need($email['global_id_c']===$id['global_id']
                && $email['assigned_user_id']===$b['owner_id'] && $email['created_by']===$b['owner_id'],'authority_email_owner_changed');
            self::need($link['registered_email_id']===$id['email_id'] && (string)$link['deleted']==='0'
                && $link['securitygroup_id']===$b['group_id'],'authority_email_group_changed');
        }
        return $identities;
    }
    private function capabilities(array $c,array $identities,string $stage,?ClawPilotNativeEmailTransaction $fence=null): void
    {
        $users=$this->rows('SELECT id FROM users WHERE deleted=0 ORDER BY id');self::need(count($users)<=500,'authority_principal_bound');
        if($c['version']===2)foreach($c['bindings'] as $pair) {
            if($pair[$stage]['capability_policy_json']===null)continue;
            $policy=json_decode($pair[$stage]['capability_policy_json'],true,32,JSON_THROW_ON_ERROR);
            self::need($policy['principalSuiteCrmUserIds']===array_column($users,'id'),'authority_capability_principal_changed');
        }
        $actual=$this->readCapabilities($identities,$users,$fence);
        // Contract validation already fixes the complete surface set and the
        // sorted exact principal lists. Compare those lists directly instead
        // of recursively canonicalizing and SHA-hashing both full matrices
        // again for every Email in both locked passes. No native ACL action
        // or principal is skipped, and associative key order is immaterial.
        foreach($c['capabilities'] as $entry)self::need(
            self::capabilityMatrixMatches($actual[$entry['emailId']],$entry[$stage]),
            'authority_effective_capability_changed');
    }
    private static function capabilityMatrixMatches(array $actual,array $expected): bool
    {
        $surfaces=ClawPilotNativeEmailAuthorityContract::SURFACES;
        if(count($actual)!==count($surfaces)||count($expected)!==count($surfaces))return false;
        foreach($surfaces as $surface)if(!array_key_exists($surface,$actual)||!array_key_exists($surface,$expected)
            ||$actual[$surface]!==$expected[$surface])return false;
        return true;
    }
    private function readCapabilities(array $identities,array $users,?ClawPilotNativeEmailTransaction $fence=null): array
    {
        if($fence!==null && ClawPilotNativeEmailWriteScope::enabled())return ClawPilotNativeEmailWriteReadFrame::within(
            $fence,$identities,fn()=>$this->readCapabilities($identities,$users));
        $previous=$GLOBALS['current_user'];$session=$_SESSION??[];
        self::need(count($identities)<=500 && count($users)<=500,'authority_capability_inventory_bound');
        $actual=[];foreach($identities as $id)$actual[$id['email_id']]=array_fill_keys(ClawPilotNativeEmailAuthorityContract::SURFACES,[]);
        try {
            // The attested Email/SugarBean ACL path consumes record identity
            // and ownership only; native group/role checks read their fenced
            // tables. The admitted hook inventory has no retrieve/ACL hooks.
            // Retain bounded ownership rows, never EmailText bodies or native
            // bean templates. Each principal still receives a fresh real Email
            // bean and every native action is evaluated; no ACL result is reused.
            $ownership=$this->capabilityOwnershipRows($identities);
            foreach($users as $row) {
                $u=BeanFactory::newBean('Users');self::need((bool)$u->retrieve($row['id'],false),'authority_principal_missing');
                $GLOBALS['current_user']=$u;$_SESSION=[];
                // Force a fresh native action load for this principal on
                // EVERY pass, and mark that load in the same request-local
                // refresh helper consumed by Email::ACLAccess. Otherwise the
                // first action repeats that identical forced load. This does
                // not share action results between stages or principals.
                clawpilot_candidate_refresh_email_acl(true);
                foreach($identities as $id) {
                    $email=$this->hydrateCapabilityEmail($ownership[$id['email_id']]);
                    foreach(ClawPilotNativeEmailAuthorityContract::SURFACES as $surface)
                        if($email->ACLAccess($surface))$actual[$id['email_id']][$surface][]=$row['id'];
                }
            }
        } finally {$GLOBALS['current_user']=$previous;$_SESSION=$session;}
        return $actual;
    }
    private function capabilityOwnershipRows(array $identities): array
    {
        $rows=$this->rows('SELECT i.email_id AS registered_email_id,e.id,e.assigned_user_id,e.created_by,e.deleted
            FROM clawpilot_email_identities i LEFT JOIN emails e ON e.id=i.email_id
            ORDER BY i.email_id LIMIT 501 FOR UPDATE');
        self::need(count($rows)===count($identities) && count($rows)<=500,'authority_email_inventory_incomplete');
        $result=[];
        foreach($rows as $index=>$row) {
            self::need($row['registered_email_id']===$identities[$index]['email_id'] && $row['id']===$row['registered_email_id']
                && in_array($row['deleted'],[0,'0'],true),'authority_deleted_identity_requires_review');
            unset($row['registered_email_id']);$this->capabilityOwnershipRow($row);
            // Existing enrolled-owner pins require both fields. Keep that
            // restriction explicit before ACL evaluation: native edit's
            // fallback retrieve() must not load bodies for a malformed owner.
            self::need(is_string($row['assigned_user_id']) && $row['assigned_user_id']!==''
                && is_string($row['created_by']) && $row['created_by']!=='','authority_email_owner_changed');
            self::need(!isset($result[$row['id']]),'authority_email_inventory_incomplete');
            $result[$row['id']]=$row;
        }
        return $result;
    }
    private function capabilityOwnershipRow(array $row): void
    {
        ClawPilotNativeEmailAuthorityContract::keys($row,['id','assigned_user_id','created_by','deleted']);
        ClawPilotNativeEmailAuthorityContract::id($row['id'],36);
        foreach(['assigned_user_id','created_by'] as $field) {
            self::need($row[$field]===null || is_string($row[$field]),'authority_email_acl_row_shape');
            if(is_string($row[$field]) && $row[$field]!=='')ClawPilotNativeEmailAuthorityContract::id($row[$field],36);
        }
        self::need(in_array($row['deleted'],[0,'0'],true),'authority_email_acl_row_shape');
    }
    private function hydrateCapabilityEmail(array $row): Email
    {
        $this->capabilityOwnershipRow($row);
        $email=BeanFactory::newBean('Emails');
        self::need($email instanceof Email && get_class($email)==='Email' && $email->module_dir==='Emails'
            && $email->module_name==='Emails' && $email->acltype==='module','authority_email_bean_changed');
        // Use the same pinned native conversion and population as retrieve().
        // Do not replace ACLAccess/isOwner, pass precomputed ownership/group
        // decisions, or suppress the native before_acl_check dispatch.
        $fetched=$email->convertRow($row);$this->capabilityOwnershipRow($fetched);
        self::need($fetched===$row,'authority_email_acl_row_conversion');
        $email->fetched_row=$fetched;$email->populateFromRow($fetched);
        self::need($email->id===$row['id'] && is_array($email->fetched_row)
            && $email->fetched_row===$fetched,'authority_email_acl_row_shape');
        return $email;
    }
    /** This is the only authorized mutation of an enrolled historical matrix.
     * The actual before ACL check has passed under the native
     * policy fence. With managed writes enabled the after check still must
     * pass before commit; any failure rolls this staging write back. Preserve
     * unaffected identity bytes and every other column. */
    private function writeCapabilityIdentities(array $c,array $identities): void
    {
        $bindings=[];foreach($c['bindings'] as $pair)$bindings[$pair['before']['pipeline_id']]=$pair['before'];
        $expectedRows=$identities;
        $updates=[];
        foreach($identities as $index=>$id) {
            if($bindings[$id['pipeline_id']]['capability_policy_json']===null)continue;
            $entry=$c['capabilities'][$index];
            if(ClawPilotNativeEmailAuthorityContract::digest($entry['before'])===ClawPilotNativeEmailAuthorityContract::digest($entry['after']))continue;
            $next=ClawPilotNativeEmailAuthorityContract::canonical($entry['after']);
            $updates[]=[$id['email_id'],$id['capabilities_json'],$next];
            $expectedRows[$index]['capabilities_json']=$next;
        }
        // Bound each SQL round trip, not the verified inventory. All original
        // CAS preimages remain in the join, and the changed-row count must
        // cover every selected identity. Any short batch aborts the enclosing
        // transaction; the complete independent readback below is unchanged.
        foreach(array_chunk($updates,25) as $batch){
            $selects=[];$values=[];
            foreach($batch as $index=>$update){
                $selects[]=$index===0?'SELECT ? AS email_id,? AS before_json,? AS after_json':'SELECT ?,?,?';
                array_push($values,...$update);
            }
            $statement=$this->db->prepare('UPDATE clawpilot_email_identities identity_row JOIN ('.implode(' UNION ALL ',$selects).
                ') patch ON BINARY patch.email_id=BINARY identity_row.email_id SET identity_row.capabilities_json=patch.after_json
                WHERE BINARY identity_row.capabilities_json=BINARY patch.before_json');
            self::need($statement!==false,'authority_write_not_confirmed');
            try{$statement->bind_param(str_repeat('s',count($values)),...$values);
                self::need($statement->execute()&&$statement->affected_rows===count($batch),'authority_write_not_confirmed');
            }finally{$statement->close();}
        }
        $actual=$this->rows('SELECT * FROM clawpilot_email_identities ORDER BY email_id FOR UPDATE');
        self::need(ClawPilotNativeEmailAuthorityContract::canonical($actual)===ClawPilotNativeEmailAuthorityContract::canonical($expectedRows),
            'authority_capability_identity_write_changed');
        foreach($actual as $index=>$id) {
            if($bindings[$id['pipeline_id']]['capability_policy_json']===null)self::need($id['capabilities_json']===null,'authority_capability_identity_mode_changed');
            else self::need(ClawPilotNativeEmailAuthorityContract::digest(json_decode($id['capabilities_json'],true,16,JSON_THROW_ON_ERROR))
                ===ClawPilotNativeEmailAuthorityContract::digest($c['capabilities'][$index]['after']),'authority_capability_identity_write_changed');
        }
    }
    private function capabilityStorage(): void
    {
        foreach(['clawpilot_email_bindings'=>['capability_policy_json'=>'mediumtext','capability_policy_fingerprint'=>'char'],
            'clawpilot_email_identities'=>['capabilities_json'=>'mediumtext']] as $table=>$expected) {
            $columns=$this->rows('SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME,IS_NULLABLE
                FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);$found=[];
            foreach($columns as $column)if(isset($expected[$column['COLUMN_NAME']])) {
                self::need($column['DATA_TYPE']===$expected[$column['COLUMN_NAME']] && $column['IS_NULLABLE']==='YES'
                    && ($column['COLUMN_NAME']!=='capability_policy_fingerprint' || ((int)$column['CHARACTER_MAXIMUM_LENGTH']===64
                        && $column['CHARACTER_SET_NAME']==='ascii' && $column['COLLATION_NAME']==='ascii_bin')),'authority_capability_storage_unproven');
                $found[]=$column['COLUMN_NAME'];
            }
            self::need(count($found)===count($expected),'authority_capability_storage_unproven');
        }
    }
    private function publicationTerminal(array $c): ?array
    {
        $p=$c['pendingPublicationCommand'];if($p===null)return null;
        $hash=ClawPilotNativeEmailAuthorityContract::digest($p);
        $prior=$this->rows('SELECT * FROM clawpilot_email_operations WHERE operation_id=? FOR UPDATE',[$p['operationId']]);
        if($prior) {
            self::need(count($prior)===1 && $prior[0]['command_hash']===$hash && $prior[0]['pipeline_id']===$p['pipelineId']
                && $prior[0]['email_id']===$p['suiteCrmId'] && in_array($prior[0]['state'],['committed','cancelled'],true),'authority_publication_conflict');
            $row=$prior[0];$result=$row['result_json']===null?null:json_decode($row['result_json'],true,64,JSON_THROW_ON_ERROR);
            self::need(($row['state']==='committed')===is_array($result),'authority_publication_receipt_invalid');
            return ['version'=>1,'operationId'=>$p['operationId'],'commandHash'=>$hash,'state'=>$row['state'],'replayed'=>true,'result'=>$result];
        }
        $this->write('INSERT INTO clawpilot_email_operations(operation_id,command_hash,pipeline_id,email_id,state,result_json) VALUES (?,?,?,?,?,NULL)',
            [$p['operationId'],$hash,$p['pipelineId'],$p['suiteCrmId'],'cancelled']);
        $saved=$this->rows('SELECT operation_id,command_hash,pipeline_id,email_id,state,result_json FROM clawpilot_email_operations WHERE operation_id=? FOR UPDATE',[$p['operationId']]);
        self::need($saved===[['operation_id'=>$p['operationId'],'command_hash'=>$hash,'pipeline_id'=>$p['pipelineId'],
            'email_id'=>$p['suiteCrmId'],'state'=>'cancelled','result_json'=>null]],'authority_publication_write_changed');
        return ['version'=>1,'operationId'=>$p['operationId'],'commandHash'=>$hash,'state'=>'cancelled','replayed'=>false,'result'=>null];
    }
    private function storage(ClawPilotNativeEmailTransaction $tx): void
    {
        foreach(['clawpilot_email_bindings','clawpilot_email_identities','clawpilot_email_operations',
            'clawpilot_email_authority_approvals','clawpilot_email_authority_operations','oauth2clients','oauth2tokens'] as $table) {
            $this->rows('SELECT * FROM '.$table.' LIMIT 0');
            $r=$this->rows('SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);
            self::need(count($r)===1 && $r[0]['ENGINE']==='InnoDB' && $r[0]['TABLE_TYPE']==='BASE TABLE','authority_storage_unproven');
        }
        $expected=[
            'clawpilot_email_bindings'=>['PRIMARY'=>[0,['pipeline_id']],'group_id'=>[0,['group_id']]],
            'clawpilot_email_identities'=>['PRIMARY'=>[0,['email_id']],'global_id'=>[0,['global_id']],
                'local_id'=>[0,['local_id']],'cp_email_pipeline'=>[1,['pipeline_id']]],
            'clawpilot_email_operations'=>['PRIMARY'=>[0,['operation_id']]],
            'clawpilot_email_authority_approvals'=>['PRIMARY'=>[0,['operation_id']]],
            'clawpilot_email_authority_operations'=>['PRIMARY'=>[0,['operation_id']]],
        ];
        $types=[
            'clawpilot_email_bindings'=>['pipeline_id'=>['varchar',64],'group_id'=>['char',36]],
            'clawpilot_email_identities'=>['email_id'=>['char',36],'global_id'=>['varchar',32],
                'local_id'=>['varchar',64],'pipeline_id'=>['varchar',64]],
            'clawpilot_email_operations'=>['operation_id'=>['char',64]],
            'clawpilot_email_authority_approvals'=>['operation_id'=>['char',64]],
            'clawpilot_email_authority_operations'=>['operation_id'=>['char',64]],
        ];
        foreach($expected as $table=>$indexes) {
            $actual=[];
            foreach($this->rows('SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',[$table]) as $row) {
                $name=$row['INDEX_NAME'];
                self::need($row['SUB_PART']===null && $row['INDEX_TYPE']==='BTREE' && isset($indexes[$name])
                    && (int)$row['NON_UNIQUE']===$indexes[$name][0],'authority_storage_key_unproven');
                $actual[$name]??=[(int)$row['NON_UNIQUE'],[]];
                self::need((int)$row['SEQ_IN_INDEX']===count($actual[$name][1])+1,'authority_storage_key_unproven');
                $actual[$name][1][]=$row['COLUMN_NAME'];
            }
            ksort($actual,SORT_STRING);ksort($indexes,SORT_STRING);self::need($actual===$indexes,'authority_storage_key_unproven');
            $checked=[];
            foreach($this->rows('SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME,IS_NULLABLE
                FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]) as $column) {
                if(!isset($types[$table][$column['COLUMN_NAME']]))continue;
                [$type,$length]=$types[$table][$column['COLUMN_NAME']];
                self::need($column['DATA_TYPE']===$type && (int)$column['CHARACTER_MAXIMUM_LENGTH']===$length
                    && $column['CHARACTER_SET_NAME']==='ascii' && $column['COLLATION_NAME']==='ascii_bin'
                    && $column['IS_NULLABLE']==='NO','authority_storage_key_unproven');
                $checked[]=$column['COLUMN_NAME'];
            }
            self::need(count($checked)===count($types[$table]),'authority_storage_key_unproven');
        }
        ClawPilotNativeEmailRuntime::assertDatabaseSideEffectProfile($this->db);$tx->assertConnection($this->db);
    }
    private function writeReceipt(array $c,string $hash,string $state,?array $result): void
    {
        $json=$result===null?null:ClawPilotNativeEmailAuthorityContract::canonical($result);
        self::need($json===null || strlen($json)<=800000,'authority_receipt_size');
        $this->write('INSERT INTO clawpilot_email_authority_operations(operation_id,transition_id,command_hash,phase,state,result_json) VALUES (?,?,?,?,?,?)',
            [$c['operationId'],$c['transitionId'],$hash,$c['phase'],$state,$json]);
        $saved=$this->rows('SELECT operation_id,transition_id,command_hash,phase,state,result_json FROM clawpilot_email_authority_operations WHERE operation_id=? FOR UPDATE',[$c['operationId']]);
        self::need($saved===[['operation_id'=>$c['operationId'],'transition_id'=>$c['transitionId'],'command_hash'=>$hash,
            'phase'=>$c['phase'],'state'=>$state,'result_json'=>$json]],'authority_receipt_write_changed');
    }
    private function receipt(array $c,string $hash,string $state,?array $result,bool $replayed): array
    {return ['version'=>$c['version'],'operationId'=>$c['operationId'],'transitionId'=>$c['transitionId'],'phase'=>$c['phase'],
        'commandHash'=>$hash,'state'=>$state,'replayed'=>$replayed,'result'=>$result];}
    private function rows(string $sql,array $params=[]): array
    {
        $s=$this->db->prepare($sql);try{if($params)$s->bind_param(str_repeat('s',count($params)),...$params);$s->execute();return $s->get_result()->fetch_all(MYSQLI_ASSOC);}
        finally{$s->close();}
    }
    private function write(string $sql,array $params): void
    {
        $s=$this->db->prepare($sql);try{$s->bind_param(str_repeat('s',count($params)),...$params);$s->execute();self::need($s->affected_rows===1,'authority_write_not_confirmed');}
        finally{$s->close();}
    }
    private static function need(bool $ok,string $code): void {ClawPilotNativeEmailAuthorityContract::need($ok,$code);}
}
