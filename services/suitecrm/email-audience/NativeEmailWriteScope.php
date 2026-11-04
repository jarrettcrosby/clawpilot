<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailAuthorityContract.php';

/** Prepared managed-record authorization, never a global native role grant.
 * A phase must prove its original native ACL matrix before calling authority().
 * These writes share that phase's fenced InnoDB transaction and roll back if
 * any subsequent real ACL or immutable readback check fails. */
final class ClawPilotNativeEmailWriteScope
{
    public static function enabled():bool
    {return ($GLOBALS['sugar_config']['clawpilot_managed_email_write_scope']??false)===true;}
    private static function rows(mysqli $db,string $sql,array $values=[]):array
    {
        $s=$db->prepare($sql);if(!$s)self::need(false,'write_scope_storage');
        try{if($values)$s->bind_param(str_repeat('s',count($values)),...$values);
            self::need($s->execute(),'write_scope_storage');$r=$s->get_result();return $r?$r->fetch_all(MYSQLI_ASSOC):[];
        }finally{$s->close();}
    }
    private static function need(bool $condition,string $code):void
    {ClawPilotNativeEmailAuthorityContract::need($condition,$code);}
    public static function storage(mysqli $db):void
    {
        foreach(['clawpilot_email_write_scopes'=>['pipeline_id','operation_id','command_hash'],
            'clawpilot_email_write_permissions'=>['email_id','pipeline_id','capabilities_json','source_kind','operation_id','command_hash']] as $table=>$columns){
            $meta=self::rows($db,'SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);
            self::need(count($meta)===1&&$meta[0]['ENGINE']==='InnoDB'&&$meta[0]['TABLE_TYPE']==='BASE TABLE','write_scope_storage');
            $actual=self::rows($db,'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[$table]);
            self::need(array_column($actual,'COLUMN_NAME')===$columns,'write_scope_columns');
        }
    }
    public static function authority(mysqli $db,array $command,array $identities):void
    {
        $roles=$command['roleChanges']??[];
        $links=$command['identityLinks']??[];
        // Every new v2 reader, including an already-linked root employee, must
        // enter the exact managed writer policy. A generic root registry grant
        // carries no identityLinks/roleChanges and must not retain broad native
        // module rights merely because those action-specific arrays are empty.
        $addedReadScopes=[];
        foreach($command['bindings'] as $pair){
            $before=json_decode($pair['before']['readers_json'],true,16,JSON_THROW_ON_ERROR);
            $after=json_decode($pair['after']['readers_json'],true,16,JSON_THROW_ON_ERROR);
            if(($pair['after']['capability_policy_json']??null)!==null&&array_diff($after,$before)!==[])
                $addedReadScopes[$pair['after']['pipeline_id']]=true;
        }
        self::need(self::enabled()||($roles===[]&&$links===[]&&$addedReadScopes===[]),'managed_write_scope_not_enabled');
        if(!self::enabled())return;
        self::storage($db);
        // The command is immutable for this call. Hash its complete contents
        // once, not once per historical Email (quadratic canonicalization).
        $commandHash=ClawPilotNativeEmailAuthorityContract::digest($command);
        $scopes=self::rows($db,'SELECT * FROM clawpilot_email_write_scopes ORDER BY pipeline_id LIMIT 101 FOR UPDATE');
        self::need(count($scopes)<=100,'write_scope_bound');
        $scopeMap=array_fill_keys(array_column($scopes,'pipeline_id'),true);
        $enroll=$addedReadScopes;foreach($roles as $role)$enroll[$role['pipelineId']]=true;
        // A first-linked existing account may already have broader native
        // module/owner rights. A newly granted reader must therefore enter the
        // same exact managed historical/future writer policy as role changes.
        // The executor has already verified the original real ACL matrix and
        // exact native account metadata under its transaction before this call.
        $linkedIds=array_column($links,'userId');
        foreach($command['bindings'] as $pair){
            $before=json_decode($pair['before']['readers_json'],true,16,JSON_THROW_ON_ERROR);
            $after=json_decode($pair['after']['readers_json'],true,16,JSON_THROW_ON_ERROR);
            if(array_intersect(array_diff($after,$before),$linkedIds)!==[])$enroll[$pair['after']['pipeline_id']]=true;
        }
        ksort($enroll,SORT_STRING);
        foreach(array_keys($enroll) as $pipeline){
            self::rows($db,'INSERT INTO clawpilot_email_write_scopes(pipeline_id,operation_id,command_hash) VALUES(?,?,?)
                ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id),command_hash=VALUES(command_hash)',
                [$pipeline,$command['operationId'],$commandHash]);
            $scopeMap[$pipeline]=true;
        }
        $permissionRows=self::rows($db,'SELECT * FROM clawpilot_email_write_permissions ORDER BY email_id LIMIT 501 FOR UPDATE');
        self::need(count($permissionRows)<=500,'write_scope_bound');$permissions=[];
        foreach($permissionRows as $row){self::need(!isset($permissions[$row['email_id']]),'write_scope_identity');$permissions[$row['email_id']]=$row;}
        $updates=[];
        foreach($identities as $index=>$identity){
            if(!isset($scopeMap[$identity['pipeline_id']]))continue;
            $entry=$command['capabilities'][$index];
            self::need($entry['emailId']===$identity['email_id']&&$entry['pipelineId']===$identity['pipeline_id'],'write_scope_identity');
            $before=$permissions[$identity['email_id']]??null;
            if($before!==null){
                self::need($before['pipeline_id']===$identity['pipeline_id']
                    &&ClawPilotNativeEmailAuthorityContract::digest(json_decode($before['capabilities_json'],true,16,JSON_THROW_ON_ERROR))
                    ===ClawPilotNativeEmailAuthorityContract::digest($entry['before']),'write_scope_preimage');
            }
            $updates[]=[$identity['email_id'],$identity['pipeline_id'],ClawPilotNativeEmailAuthorityContract::canonical($entry['after']),
                $command['operationId'],$commandHash];
            $permissions[$identity['email_id']]=['email_id'=>$identity['email_id'],'pipeline_id'=>$identity['pipeline_id'],
                'capabilities_json'=>ClawPilotNativeEmailAuthorityContract::canonical($entry['after']),
                'source_kind'=>'authority','operation_id'=>$command['operationId'],'command_hash'=>$commandHash];
        }
        // Every scoped identity was independently validated above. Batching
        // changes only SQL transport; all rows retain the complete signed
        // operation/hash and the executor still performs its full native ACL
        // and immutable-registry readback before the same transaction commits.
        foreach(array_chunk($updates,25) as $batch){
            $values=[];foreach($batch as $update)array_push($values,...$update);
            $permissionStatement=$db->prepare('INSERT INTO clawpilot_email_write_permissions(email_id,pipeline_id,capabilities_json,source_kind,operation_id,command_hash) VALUES '.
                implode(',',array_fill(0,count($batch),'(?,?,?,\'authority\',?,?)')).
                ' ON DUPLICATE KEY UPDATE capabilities_json=VALUES(capabilities_json),source_kind=VALUES(source_kind),
                operation_id=VALUES(operation_id),command_hash=VALUES(command_hash)');
            self::need($permissionStatement!==false,'write_scope_storage');
            try{$permissionStatement->bind_param(str_repeat('s',count($values)),...$values);
                self::need($permissionStatement->execute(),'write_scope_storage');
            }finally{$permissionStatement->close();}
        }
        ksort($permissions,SORT_STRING);
        $actual=self::rows($db,'SELECT * FROM clawpilot_email_write_permissions ORDER BY email_id LIMIT 501 FOR UPDATE');
        self::need(ClawPilotNativeEmailAuthorityContract::canonical($actual)
            ===ClawPilotNativeEmailAuthorityContract::canonical(array_values($permissions)),'write_scope_write_changed');
    }
    /** A deny-on-corruption ACL result is not valid evidence of an intentionally
     * empty writer matrix. Validate the independent registry before the native
     * publisher/authority verifier interprets any effective ACL readback. */
    public static function assertIdentity(mysqli $db,array $identity):void
    {
        if(!self::enabled())return;
        $scope=self::rows($db,'SELECT pipeline_id FROM clawpilot_email_write_scopes WHERE pipeline_id=?',[$identity['pipeline_id']]);
        $permissions=self::rows($db,'SELECT * FROM clawpilot_email_write_permissions WHERE email_id=?',[$identity['email_id']]);
        self::assertIdentityRows($identity,$scope,$permissions);
    }
    /** Complete native authority inventory only. The ordinary single-Email
     * publisher retains assertIdentity(); no subset is treated as a full scan. */
    public static function assertIdentities(mysqli $db,array $identities):void
    {
        if(!self::enabled())return;
        self::need(count($identities)<=500,'write_scope_bound');
        $scopes=self::rows($db,'SELECT pipeline_id FROM clawpilot_email_write_scopes ORDER BY pipeline_id LIMIT 101 FOR UPDATE');
        $permissions=self::rows($db,'SELECT * FROM clawpilot_email_write_permissions ORDER BY email_id LIMIT 501 FOR UPDATE');
        self::need(count($scopes)<=100&&count($permissions)<=500,'write_scope_bound');
        $byScope=[];$byEmail=[];$expected=[];
        foreach($scopes as $row){self::need(!isset($byScope[$row['pipeline_id']]),'write_scope_identity');$byScope[$row['pipeline_id']]=$row;}
        foreach($permissions as $row){self::need(!isset($byEmail[$row['email_id']]),'write_scope_identity');$byEmail[$row['email_id']]=$row;}
        foreach($identities as $identity){
            self::need(!isset($expected[$identity['email_id']]),'write_scope_identity');$expected[$identity['email_id']]=true;
            self::assertIdentityRows($identity,isset($byScope[$identity['pipeline_id']])?[$byScope[$identity['pipeline_id']]]:[],
                isset($byEmail[$identity['email_id']])?[$byEmail[$identity['email_id']]]:[]);
        }
        foreach($byEmail as $id=>$row)self::need(isset($expected[$id]),'write_scope_orphan_identity');
    }
    private static function assertIdentityRows(array $identity,array $scope,array $permissions):void
    {
        if(!$scope&&!$permissions)return;
        self::need(count($scope)===1&&count($permissions)===1,'write_scope_identity_missing');
        $p=$permissions[0];
        self::need($p['pipeline_id']===$identity['pipeline_id']&&is_string($identity['capabilities_json'])
            &&ClawPilotNativeEmailAuthorityContract::digest(json_decode($p['capabilities_json'],true,16,JSON_THROW_ON_ERROR))
            ===ClawPilotNativeEmailAuthorityContract::digest(json_decode($identity['capabilities_json'],true,16,JSON_THROW_ON_ERROR)),
            'write_scope_preimage');
    }
    /** New provider Email only. Never turn an unreviewed historical enrollment
     * into its own permission proof by copying a caller's expected matrix. */
    public static function newPublication(mysqli $db,array $command):void
    {
        if(!self::enabled()||$command['version']!==2)return;
        self::storage($db);
        $scope=self::rows($db,'SELECT * FROM clawpilot_email_write_scopes WHERE pipeline_id=? FOR UPDATE',[$command['pipelineId']]);
        if(!$scope)return;
        self::need(count($scope)===1,'write_scope_identity');
        self::rows($db,'INSERT INTO clawpilot_email_write_permissions(email_id,pipeline_id,capabilities_json,source_kind,operation_id,command_hash)
            VALUES(?,?,?,\'publication\',?,?)',[$command['suiteCrmId'],$command['pipelineId'],
            ClawPilotNativeEmailAuthorityContract::canonical($command['expectedCapabilities']),$command['operationId'],
            ClawPilotNativeEmailAuthorityContract::digest($command)]);
    }
}
