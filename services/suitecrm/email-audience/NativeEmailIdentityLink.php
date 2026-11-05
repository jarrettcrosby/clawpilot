<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailAuthorityContract.php';

/** Read-only verification of an existing native account. Neither a successful
 * metadata comparison nor this helper creates a principal or authorizes access;
 * the complete signed authority/app-source transition is still mandatory. */
final class ClawPilotNativeEmailIdentityLink
{
    private static function need(bool $condition,string $code):void
    {ClawPilotNativeEmailAuthorityContract::need($condition,$code);}

    /** Pure bounded metadata comparison, not an authorization entry point. The
     * executor supplies both arrays from inspect() under its actual DB fence. */
    public static function validateRows(array $links,array $users,array $custom):void
    {
        self::need(array_is_list($links)&&count($links)>0&&count($links)<=100
            &&array_is_list($users)&&count($users)>=count($links)&&count($users)<=500
            &&array_is_list($custom)&&count($custom)<=500,'identity_link_inventory');
        $previous='';$claims=[];$customById=[];
        foreach($custom as $row){
            ClawPilotNativeEmailAuthorityContract::keys($row,['id_c','global_id_c']);
            ClawPilotNativeEmailAuthorityContract::id($row['id_c'],36);
            self::need(strcmp($row['id_c'],$previous)>0 && ($row['global_id_c']===null
                || is_string($row['global_id_c'])&&strlen($row['global_id_c'])<=1024),'identity_link_metadata');
            $previous=$row['id_c'];$customById[$row['id_c']]=$row;
            if($row['global_id_c']!==null&&$row['global_id_c']!=='')$claims[strtolower($row['global_id_c'])][]=$row['id_c'];
        }
        $previous='';$usersById=[];$usernames=[];
        foreach($users as $user){
            ClawPilotNativeEmailAuthorityContract::keys($user,['id','user_name','status','deleted']);
            ClawPilotNativeEmailAuthorityContract::id($user['id'],36);
            self::need(strcmp($user['id'],$previous)>0 && ($user['user_name']===null
                ||is_string($user['user_name'])&&strlen($user['user_name'])<=1024)
                &&($user['status']===null||is_string($user['status'])&&strlen($user['status'])<=64)
                &&in_array($user['deleted'],[0,'0',1,'1'],true),'identity_link_metadata');
            $previous=$user['id'];$usersById[$user['id']]=$user;
            if($user['user_name']!==null&&$user['user_name']!=='')$usernames[strtolower($user['user_name'])][]=$user['id'];
        }
        $previous='';$references=[];
        foreach($links as $index=>$link){
            ClawPilotNativeEmailAuthorityContract::keys($link,['userId','globalId','username']);
            ClawPilotNativeEmailAuthorityContract::id($link['userId'],36);
            self::need(strcmp($link['userId'],$previous)>0 && is_string($link['globalId'])
                &&preg_match('/^gu(?:[0-9]{7}|[0-9a-v]{12})$/D',$link['globalId'])===1
                &&$link['username']===$link['globalId']&&!isset($references[$link['globalId']]),'identity_link_metadata');
            $previous=$link['userId'];$references[$link['globalId']]=true;
            $user=$usersById[$link['userId']]??null;
            self::need($user!==null&&$user['user_name']===$link['username']
                &&$user['status']==='Active'&&in_array($user['deleted'],[0,'0'],true)
                &&($customById[$link['userId']]['global_id_c']??null)===$link['globalId']
                &&($claims[$link['globalId']]??[])===[$link['userId']]
                &&($usernames[$link['username']]??[])===[$link['userId']],'identity_link_identity_changed');
        }
    }

    /** Lock the complete custom-identity index, including boundary gaps and
     * retained/deleted identities. A filtered lookup cannot exclude a racing
     * duplicate Global ID. Native Users are already fenced by the transaction. */
    public static function inspect(mysqli $db,ClawPilotNativeEmailTransaction $fence,array $links):array
    {
        $fence->assertConnection($db);
        $meta=self::rows($db,"SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users_cstm'",[],2);
        self::need(count($meta)===1&&$meta[0]['ENGINE']==='InnoDB'&&$meta[0]['TABLE_TYPE']==='BASE TABLE','identity_link_storage');
        $index=self::rows($db,"SELECT COLUMN_NAME,NON_UNIQUE,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users_cstm' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX",[],2);
        self::need(count($index)===1&&$index[0]['COLUMN_NAME']==='id_c'&&(string)$index[0]['NON_UNIQUE']==='0'
            &&$index[0]['SUB_PART']===null&&$index[0]['INDEX_TYPE']==='BTREE','identity_link_storage');
        $custom=self::rows($db,'SELECT id_c,global_id_c FROM users_cstm FORCE INDEX(PRIMARY) ORDER BY id_c FOR UPDATE',[],500);
        $users=self::rows($db,'SELECT id,user_name,status,deleted FROM users FORCE INDEX(PRIMARY) ORDER BY id FOR UPDATE',[],500);
        self::validateRows($links,$users,$custom);$fence->assertConnection($db);
        return ['links'=>$links,'users'=>$users,'custom'=>$custom];
    }
    public static function assertUnchanged(mysqli $db,ClawPilotNativeEmailTransaction $fence,array $snapshot):void
    {
        ClawPilotNativeEmailAuthorityContract::keys($snapshot,['links','users','custom']);
        self::need(self::inspect($db,$fence,$snapshot['links'])===$snapshot,'identity_link_metadata_changed_inside_fence');
    }
    private static function rows(mysqli $db,string $sql,array $values,int $bound):array
    {
        $statement=$db->prepare($sql);self::need($statement!==false,'identity_link_storage');
        try{
            if($values)$statement->bind_param(str_repeat('s',count($values)),...$values);
            self::need($statement->execute(),'identity_link_storage');$result=$statement->get_result();
            self::need($result instanceof mysqli_result,'identity_link_storage');$rows=[];$bytes=0;
            while($row=$result->fetch_assoc()){
                $bytes+=strlen(json_encode($row,JSON_THROW_ON_ERROR));
                self::need(count($rows)<$bound&&$bytes<=8388608,'identity_link_inventory');$rows[]=$row;
            }
            return $rows;
        }finally{$statement->close();}
    }
}
