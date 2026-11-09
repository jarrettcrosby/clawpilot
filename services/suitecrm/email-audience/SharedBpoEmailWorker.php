<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailProjection.php';

/** The standard SuiteCRM OAuth client is a service identity, not a reader
 * grant. Only BPO's explicitly selected workspace/pipeline can publish here;
 * this code never inserts or edits a role, group, ACL or user. */
final class ClawPilotSharedBpoEmailWorker
{
    private const WORKSPACE='c6c49765-9bf6-4223-9261-7553499f5d92';
    private const PIPELINE='587c8746-ecf6-40ae-8c50-e456f99ad555';
    private const UUID='/\A[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z/';

    public function __construct(private mysqli $db,private array $databaseProfile,private string $callerId,
        private string $clientId,private string $tokenId,private bool $expectEmailTemplates,private string $oauthSubject='') {}

    public function publish(array $command): array
    {
        $this->assertEnabled();
        $keys=array_keys($command);sort($keys,SORT_STRING);
        self::need($keys===['localId','pipelineId','projection','sourceRevision','version','workspaceId']
            &&$command['version']===1&&$command['workspaceId']===self::WORKSPACE&&$command['pipelineId']===self::PIPELINE
            &&is_string($command['localId'])&&preg_match(self::UUID,$command['localId'])===1
            &&is_string($command['sourceRevision'])&&preg_match('/\A[a-f0-9]{64}\z/',$command['sourceRevision'])===1
            &&is_array($command['projection']),'command_scope');
        $projection=ClawPilotNativeEmailProjection::validate($command['projection']);
        self::need(preg_match(self::UUID,$projection['suiteCrmId'])===1,'native_identity');
        self::need(is_string($projection['attributes']['from_addr_name']??null)
            &&$projection['attributes']['from_addr_name']!=='','sender_evidence');
        $tx=ClawPilotNativeEmailTransaction::begin($this->db,$this->databaseProfile);
        try {
            $this->assertCaller($tx);
            $result=ClawPilotNativeEmailProjection::publishSharedLocked($this->db,$tx,$projection,$this->expectEmailTemplates);
            $this->assertEnabled();
            $this->assertCaller($tx);
            if($result['wrote'])$tx->commit();
            else $tx->rollback();
            return ['version'=>1,'suiteCrmId'=>$projection['suiteCrmId'],'globalId'=>$projection['attributes']['global_id_c'],
                'snapshotFingerprint'=>$result['snapshotFingerprint'],'accounts'=>$projection['accounts'],
                'contacts'=>$projection['contacts'],'contactAccounts'=>$projection['contactAccounts']];
        }catch(Throwable $error){
            try{$tx->rollback();}catch(Throwable $ignored){}
            if($error instanceof ClawPilotNativeEmailTransactionRefused||$error instanceof ClawPilotNativeEmailProjectionRefused)throw $error;
            throw new ClawPilotNativeEmailTransactionRefused('shared_worker_database');
        }
    }

    private function assertEnabled(): void
    {
        self::need(getenv('CLAWPILOT_SHARED_BPO_EMAIL_ENABLED')==='1','disabled');
        foreach(['CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED','CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED'] as $flag)
            self::need(in_array(getenv($flag),[false,'','0'],true),'legacy_mode');
        self::need(getenv('CLAWPILOT_SHARED_BPO_EMAIL_TEMPLATES')===($this->expectEmailTemplates?'1':'0'),'templates_pin');
    }

    private function assertCaller(ClawPilotNativeEmailTransaction $tx): void
    {
        $tx->assertConnection($this->db);
        $expected=getenv('SUITECRM_CLIENT_ID');
        $user=$GLOBALS['current_user']??null;
        self::need(is_string($expected)&&preg_match(self::UUID,$this->clientId)===1&&hash_equals($expected,$this->clientId)
            &&preg_match('/\A[a-z0-9][a-z0-9-]{0,35}\z/i',$this->callerId)===1
            &&preg_match('/\A[a-f0-9]{80}\z/',$this->tokenId)===1
            &&($this->oauthSubject===''||$this->oauthSubject===$this->callerId)
            &&$user instanceof User&&(string)$user->id===$this->callerId&&$user->isAdmin()&&$user->status==='Active', 'unauthorized');
        // Middleware may have hydrated objects before waiting for policy
        // locks. The row locks here prove the original token did not become
        // revoked, expired, reassigned, or shared with a different client.
        $users=$this->rows('SELECT id,status,is_admin,deleted FROM users WHERE id=? FOR UPDATE',[$this->callerId]);
        $clients=$this->rows('SELECT id,assigned_user_id,deleted,allowed_grant_type,is_confidential FROM oauth2clients WHERE id=? FOR UPDATE',[$this->clientId]);
        $tokens=$this->rows('SELECT access_token,assigned_user_id,client,deleted,token_is_revoked,
            access_token_expires>TIMESTAMPADD(SECOND,5,UTC_TIMESTAMP()) AS unexpired
            FROM oauth2tokens WHERE access_token=? ORDER BY id LIMIT 2 FOR UPDATE',[$this->tokenId]);
        self::need(count($users)===1&&$users[0]['id']===$this->callerId&&$users[0]['status']==='Active'
            &&(int)$users[0]['is_admin']===1&&(int)$users[0]['deleted']===0
            &&count($clients)===1&&$clients[0]['id']===$this->clientId&&$clients[0]['assigned_user_id']===$this->callerId
            &&(int)$clients[0]['deleted']===0&&$clients[0]['allowed_grant_type']==='client_credentials'&&(int)$clients[0]['is_confidential']===1
            &&count($tokens)===1&&hash_equals($this->tokenId,(string)$tokens[0]['access_token'])
            &&$tokens[0]['client']===$this->clientId&&$tokens[0]['assigned_user_id']===$this->callerId
            &&(int)$tokens[0]['deleted']===0&&in_array($tokens[0]['token_is_revoked'],[0,'0'],true)&&(int)$tokens[0]['unexpired']===1,'unauthorized');
        foreach(['oauth2clients','oauth2tokens'] as $table){
            // The locking reads above already hold the table metadata locks.
            $storage=$this->rows('SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);
            self::need($storage===[['ENGINE'=>'InnoDB','TABLE_TYPE'=>'BASE TABLE']],'auth_storage');
        }
        $tx->assertConnection($this->db);
    }

    private function rows(string $sql,array $parameters): array
    {
        $statement=$this->db->prepare($sql);
        self::need($statement instanceof mysqli_stmt,'database');
        try{
            self::need($statement->bind_param(str_repeat('s',count($parameters)),...$parameters)&&$statement->execute(),'database');
            $result=$statement->get_result();
            self::need($result instanceof mysqli_result,'database');
            try{return $result->fetch_all(MYSQLI_ASSOC);}
            finally{$result->free();}
        }finally{$statement->close();}
    }

    private static function need(bool $condition,string $code): void
    {
        if(!$condition)throw new ClawPilotNativeEmailTransactionRefused('shared_worker_'.$code);
    }
}
