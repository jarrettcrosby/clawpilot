<?php
declare(strict_types=1);
// Prepared native scoping correction. Exact-byte, opt-in offline installation;
// the managed write policy remains separately disabled by default.
/** Old authenticated sessions must not retain a former default-all Email role. */
function clawpilot_candidate_refresh_email_acl(bool $force = false): void
{
    $user = $GLOBALS['current_user'] ?? null;
    if (!$user instanceof User || !is_string($user->id) || $user->id === '') {
        throw new SuiteCRM\Exception\AccessDeniedException();
    }
    // PHP request lifetime only, never a persistent/session cache. Refresh all
    // actions through native code so group-role precedence stays native too.
    static $refreshed = [];
    if ($force || !isset($refreshed[$user->id])) {
        require_once 'modules/ACLActions/ACLAction.php';
        ACLAction::getUserActions($user->id, true);
        $refreshed[$user->id] = true;
    }
}

/** Raw metadata only, scoped to one read-only ACL pass inside the real native
 * policy fence. No bean, user, ownership/group decision or ACL result is cached.
 * Ordinary UI/API requests never enter this frame. A new capture is required
 * after the authority executor changes memberships or managed permissions. */
final class ClawPilotNativeEmailWriteReadFrame
{
    private static ?self $active=null;
    private array $matrices=[];
    private ?mysqli_stmt $groupStatement=null;
    private function __construct(private mysqli $connection,private array $records)
    {
        foreach($records as $id=>$row){
            try{$this->matrices[$id]=clawpilot_candidate_email_write_matrix($row);}
            catch(Throwable $error){$this->matrices[$id]=null;}
        }
    }
    public static function within(ClawPilotNativeEmailTransaction $fence,array $identities,callable $read):array
    {
        if(self::$active!==null || count($identities)>500)throw new SuiteCRM\Exception\AccessDeniedException();
        $manager=DBManagerFactory::getInstance();$db=$manager->database;$fence->assertConnection($db);
        $ids=[];
        foreach($identities as $identity){
            $id=$identity['email_id']??null;
            if(!is_string($id)||!preg_match('/^[a-z0-9][a-z0-9-]{0,35}$/iD',$id)||isset($ids[$id]))
                throw new SuiteCRM\Exception\AccessDeniedException();
            $ids[$id]=true;
        }
        $capture=static function()use($manager,$ids):array{
            $records=[];$bytes=0;
            if(!$ids)return $records;
            $where='e.id IN ('.implode(',',array_map(static fn($id)=>"'".$manager->quote($id)."'",array_keys($ids))).')';
            $result=$manager->query(clawpilot_candidate_email_write_query($where).' ORDER BY e.id LIMIT 501 FOR UPDATE',false);
            if(!$result)throw new SuiteCRM\Exception\AccessDeniedException();
            while($row=$manager->fetchByAssoc($result,false)){
                $id=$row['native_id'];$bytes+=strlen(json_encode($row,JSON_THROW_ON_ERROR));
                if(!isset($ids[$id])||isset($records[$id])||$bytes>8388608)throw new SuiteCRM\Exception\AccessDeniedException();
                $records[$id]=$row;
            }
            if(count($records)!==count($ids))throw new SuiteCRM\Exception\AccessDeniedException();
            return $records;
        };
        $records=$capture();
        self::$active=new self($db,$records);
        try{
            $result=$read();$fence->assertConnection($db);
            // Even a same-connection mutation must not turn a cached preimage
            // into effective ACL evidence. No result escapes on any drift.
            if($capture()!==$records)throw new SuiteCRM\Exception\AccessDeniedException();
            return $result;
        }
        finally{
            // Statement bytecode only: no result/decision survives a call,
            // principal or stage. Release it even when the frame is refused.
            try{if(self::$active?->groupStatement!==null)self::$active->groupStatement->close();}catch(Throwable $ignored){}
            self::$active=null;
        }
    }
    public static function record(mysqli $connection,string $id):?array
    {
        if(self::$active===null)return null;
        if(self::$active->connection!==$connection)throw new SuiteCRM\Exception\AccessDeniedException();
        return isset(self::$active->records[$id])?['row'=>self::$active->records[$id],'matrix'=>self::$active->matrices[$id]]:null;
    }
    /** The pinned native groupHasAccess method calls this only as an optional
     * execution path. Every invocation executes the SAME native non-strict
     * count query afresh, on the original fenced connection. Only its prepared
     * SQL plan is reused; neither rows nor owner/group/access decisions are.
     * Outside this frame, for another module/record, or under strict rights,
     * NULL preserves the complete stock method and its existing SQL path. */
    public static function groupAccess(mixed $connection,string $module,string $id,string $userId,string $action):?bool
    {
        $frame=self::$active;
        if($frame===null||$module!=='Emails'||!isset($frame->records[$id])
            ||!in_array($action,['view','list','export','edit','delete'],true))return null;
        if($frame->connection!==$connection)throw new SuiteCRM\Exception\AccessDeniedException();
        $config=$GLOBALS['sugar_config']??[];
        if(isset($config['securitysuite_strict_rights'])&&$config['securitysuite_strict_rights']==true)return null;
        if(!preg_match('/^[a-z0-9][a-z0-9-]{0,35}$/iD',$userId))throw new SuiteCRM\Exception\AccessDeniedException();
        if($frame->groupStatement===null){
            $statement=$frame->connection->prepare('select count(securitygroups.id) as results from securitygroups '
                .'inner join securitygroups_users on securitygroups.id = securitygroups_users.securitygroup_id'
                .' and securitygroups_users.deleted = 0 and securitygroups_users.user_id = ? '
                .'inner join securitygroups_records on securitygroups.id = securitygroups_records.securitygroup_id'
                .' and securitygroups_records.deleted = 0 and securitygroups_records.record_id = ? '
                .' and securitygroups_records.module = ? where securitygroups.deleted = 0');
            if(!$statement)throw new SuiteCRM\Exception\AccessDeniedException();
            $frame->groupStatement=$statement;
        }
        if(!$frame->groupStatement->execute([$userId,$id,$module]))throw new SuiteCRM\Exception\AccessDeniedException();
        $result=$frame->groupStatement->get_result();
        if(!$result)throw new SuiteCRM\Exception\AccessDeniedException();
        try{
            $row=$result->fetch_assoc();
            if($result->num_rows!==1||!is_array($row)||!isset($row['results'])
                ||!preg_match('/^[0-9]+$/D',(string)$row['results']))throw new SuiteCRM\Exception\AccessDeniedException();
            return $row['results']>0;
        }finally{$result->free();}
    }
}

/** Shared exact query for ordinary fresh reads and the fenced batch capture. */
function clawpilot_candidate_email_write_query(string $where):string
{
    return "SELECT p.email_id AS permission_email,p.pipeline_id,p.capabilities_json,p.source_kind,p.operation_id,p.command_hash,
        i.pipeline_id AS identity_pipeline,i.workspace_id,i.global_id,i.app_archived,i.capabilities_json AS identity_capabilities,
        b.pipeline_id AS binding_pipeline,b.workspace_id AS binding_workspace,b.owner_id,b.group_id,b.enabled,
        s.pipeline_id AS scoped_pipeline,e.id AS native_id,e.deleted,e.assigned_user_id,e.created_by,c.global_id_c,
        (SELECT count(*) FROM securitygroups_records r WHERE r.record_id=e.id AND r.module='Emails' AND r.deleted=0) AS group_count,
        (SELECT count(*) FROM securitygroups_records r WHERE r.record_id=e.id AND r.module='Emails' AND r.deleted=0
          AND r.securitygroup_id=b.group_id) AS expected_group_count
        FROM emails e
        LEFT JOIN clawpilot_email_identities i ON i.email_id=e.id
        LEFT JOIN clawpilot_email_write_permissions p ON p.email_id=e.id
        LEFT JOIN clawpilot_email_bindings b ON b.pipeline_id=COALESCE(p.pipeline_id,i.pipeline_id)
        LEFT JOIN clawpilot_email_write_scopes s ON s.pipeline_id=COALESCE(p.pipeline_id,i.pipeline_id)
        LEFT JOIN emails_cstm c ON c.id_c=e.id
        WHERE ".$where;
}

/** Decode and structurally validate policy data only; no user/action decision. */
function clawpilot_candidate_email_write_matrix(array $r):?array
{
    $matrix=json_decode($r['capabilities_json'],true,16,JSON_THROW_ON_ERROR);
    $identity=json_decode($r['identity_capabilities'],true,16,JSON_THROW_ON_ERROR);
    if (!is_array($matrix) || !is_array($identity)) return null;
    $keys=array_keys($matrix);sort($keys,SORT_STRING);
    $identityKeys=array_keys($identity);sort($identityKeys,SORT_STRING);
    if ($keys!==['delete','edit','export','list','view'] || $identityKeys!==$keys) return null;
    foreach($matrix as $name=>$ids){
        if (!is_array($ids)||!array_is_list($ids)||count($ids)>500||($identity[$name]??null)!==$ids) return null;
        $previous='';foreach($ids as $id){
            if (!is_string($id)||!preg_match('/^[a-z0-9][a-z0-9-]{0,35}$/iD',$id)||strcmp($id,$previous)<=0) return null;
            $previous=$id;
        }
    }
    return $matrix;
}

/** Explicit, per-record managed write policy. Unmanaged Emails retain native
 * behavior. Native module/action denial, disabled users and unreadable records
 * always win. Neither browser fields nor the historical enrollment matrix by
 * itself enroll a record: only the authenticated authority/new-publication
 * transaction writes the independent write-permissions registry. */
function clawpilot_candidate_email_write_access(SugarBean $bean, string $surface, bool $nativeAllowed): bool
{
    // Match the pinned SugarBean ACL aliases; V8 updateRecord checks `save`.
    $surface=strtolower($surface);
    if(in_array($surface,['save','popupeditview','editview'],true))$surface='edit';
    if (($GLOBALS['sugar_config']['clawpilot_managed_email_write_scope'] ?? false) !== true
        || !in_array($surface, ['edit','delete'], true) || empty($bean->id)) return $nativeAllowed;
    $user=$GLOBALS['current_user']??null;
    if (!$user instanceof User || !$user->isEnabled() || !is_string($bean->id)
        || !preg_match('/^[a-z0-9][a-z0-9-]{0,35}$/iD',$bean->id)) return false;
    $db=DBManagerFactory::getInstance();
    try {
        $captured=ClawPilotNativeEmailWriteReadFrame::record($db->database,$bean->id);
        $rows=$captured===null?null:[$captured['row']];
        if($rows===null){
            $result=$db->query(clawpilot_candidate_email_write_query("e.id='".$db->quote($bean->id)."'").' LIMIT 2',false);
            if (!$result) return false;
            $rows=[];while($row=$db->fetchByAssoc($result,false))$rows[]=$row;
        }
        if ($rows===[]) return $nativeAllowed;
        if (count($rows)!==1) return false;
        $r=$rows[0];
        // Unmanaged records retain native behavior; an enrolled scope with a
        // missing per-record permission must not silently fall back to it.
        if ($r['permission_email']===null && $r['scoped_pipeline']===null) return $nativeAllowed;
        if ($r['permission_email']===null) return false;
        if ($r['native_id']!==$bean->id || (string)$r['deleted']!=='0'
            || (string)$r['enabled']!=='1' || $r['pipeline_id']!==$r['identity_pipeline']
            || $r['pipeline_id']!==$r['binding_pipeline'] || $r['pipeline_id']!==$r['scoped_pipeline']
            || $r['workspace_id']!==$r['binding_workspace'] || $r['global_id']!==$r['global_id_c']
            || $r['assigned_user_id']!==$r['owner_id'] || $r['created_by']!==$r['owner_id']
            || (int)$r['group_count']!==1 || (int)$r['expected_group_count']!==1
            || !in_array($r['source_kind'],['authority','publication'],true)
            || !preg_match('/^[a-f0-9]{64}$/D',$r['operation_id']) || !preg_match('/^[a-f0-9]{64}$/D',$r['command_hash'])) return false;
        $matrix=$captured===null?clawpilot_candidate_email_write_matrix($r):$captured['matrix'];
        if($matrix===null)return false;
        if (!in_array((string)$user->id,$matrix[$surface],true)
            || ACLAction::getUserAccessLevel((string)$user->id,'Emails','access')<=0
            || ACLAction::getUserAccessLevel((string)$user->id,'Emails',$surface)<=0) return false;
        // These are unchanged native read checks, not a caller's owner/group
        // hint. Managed write policy cannot expose another organization's mail.
        $nativeRow=['id'=>$r['native_id'],'assigned_user_id'=>$r['assigned_user_id'],'created_by'=>$r['created_by'],'deleted'=>$r['deleted']];
        // Only the fenced authority scan supplies a fresh per-principal native
        // Email with this exact minimal database preimage. Re-enter its native
        // read actions instead of constructing another identical Email for each
        // edit/delete check. No action result, owner/group decision or bean is
        // shared between principals or stages. Ordinary UI/API beans still use
        // independent database-backed hydration below.
        if($captured!==null && $bean instanceof Email && get_class($bean)==='Email'
            && $bean->module_dir==='Emails' && $bean->module_name==='Emails' && $bean->acltype==='module'
            && $bean->fetched_row===$nativeRow && $bean->assigned_user_id===$r['assigned_user_id']
            && $bean->created_by===$r['created_by'] && (string)$bean->deleted==='0')$read=$bean;
        else{
            $read=BeanFactory::newBean('Emails');
            $read->fetched_row=$nativeRow;$read->populateFromRow($nativeRow);
        }
        return $read->ACLAccess('view') && $read->ACLAccess('list');
    } catch (Throwable $error) {return false;}
}

function clawpilot_candidate_email_where(SugarBean $bean, string $where): string
{
    if ($bean->module_name !== 'Emails') return $where;
    if (!$bean->ACLAccess('view') || !$bean->ACLAccess('list')) {
        throw new SuiteCRM\Exception\AccessDeniedException();
    }
    $conditions = $where === '' ? [] : ['('.$where.')'];
    foreach (['view', 'list'] as $surface) {
        $scope = trim((string) $bean->buildAccessWhere($surface));
        if ($scope !== '') $conditions[] = '('.$scope.')';
    }
    return implode(' AND ', array_unique($conditions));
}

/** Suffix for pinned native SQL that already has a WHERE and an emails table. */
function clawpilot_candidate_email_sql_and(): string
{
    $scope = clawpilot_candidate_email_where(BeanFactory::newBean('Emails'), '');
    return $scope === '' ? '' : ' AND ('.$scope.') ';
}

/** Authorize the complete native batch before any part can be serialized. */
function clawpilot_candidate_require_email_reads(array $ids): void
{
    clawpilot_candidate_require_email_access($ids, false);
}

/** Edit additionally requires readable native records; preflight the entire batch. */
function clawpilot_candidate_require_email_edits(array $ids): void
{
    clawpilot_candidate_require_email_access($ids, true);
}

function clawpilot_candidate_require_email_access(array $ids, bool $requireEdit): void
{
    if ($ids === []) throw new SuiteCRM\Exception\AccessDeniedException();
    foreach ($ids as $id) {
        if (!is_string($id) || $id === '') throw new SuiteCRM\Exception\AccessDeniedException();
        // Use a fresh bean rather than a caller-populated or cached owner shape.
        $bean = BeanFactory::newBean('Emails');
        if (!$bean instanceof SugarBean || !$bean->retrieve($id, false)
            || (string) $bean->id !== $id || !$bean->ACLAccess('view') || !$bean->ACLAccess('list')
            || ($requireEdit && !$bean->ACLAccess('edit'))) {
            throw new SuiteCRM\Exception\AccessDeniedException();
        }
    }
}

/** Check the selected relationship endpoint, never an arbitrary first sibling. */
function clawpilot_candidate_require_email_unlink(SugarBean $source, SugarBean $related): void
{
    if ($source->module_name !== 'Emails' && $related->module_name !== 'Emails') return;
    if (!$source->ACLAccess('view') || !$source->ACLAccess('list') || !$source->ACLAccess('edit')
        || !$related->ACLAccess('view') || !$related->ACLAccess('list')
        || ($related->module_name === 'Emails' && !$related->ACLAccess('edit'))) {
        throw new SuiteCRM\Exception\AccessDeniedException();
    }
}

/** Authorize native Email edits before the legacy action creates or saves beans. */
function clawpilot_candidate_email_ajax_edit(array $request): void
{
    $action = $request['emailUIAction'] ?? '';
    if ($action === 'saveQuickCreate' && ($request['sugarEmail'] ?? null) == 'true') {
        // Stock saveQuickCreate creates the related bean before retrieving uid.
        // This guard runs before its switch, so a denied/malformed native ID
        // cannot create the target, change the Email, or add any relationships.
        clawpilot_candidate_require_email_edits([$request['uid'] ?? null]);
        return;
    }
    if ($action !== 'relateEmails'
        || empty($request['uid']) || empty($request['parent_id']) || empty($request['parent_type'])) return;
    $delimiter = $GLOBALS['app_strings']['LBL_EMAIL_DELIMITER'] ?? null;
    if (!is_string($request['uid']) || !is_string($delimiter) || $delimiter === '') {
        throw new SuiteCRM\Exception\AccessDeniedException();
    }
    clawpilot_candidate_require_email_edits(explode($delimiter, $request['uid']));
}

/** Only the pinned EmailUIAjax commands that read imported native Email IDs. */
function clawpilot_candidate_email_ajax_read(array $request): void
{
    $action = $request['emailUIAction'] ?? '';
    $uid = $request['uid'] ?? null;
    $ids = null;
    switch ($action) {
        case 'composeEmail':
            // Match the native branch; the other branch uses an IMAP/POP UID.
            if (($request['sugarEmail'] ?? null) == 'true') $ids = [$uid];
            break;
        case 'getQuickCreateForm':
            if (!empty($request['sugarEmail'])) $ids = [$uid];
            break;
        case 'getEmail2DetailView':
        case 'getSingleMessageFromSugar':
            $ids = [$uid];
            break;
        case 'getMultipleMessagesFromSugar':
            if (!is_string($uid)) throw new SuiteCRM\Exception\AccessDeniedException();
            $ids = explode(',', $uid);
            break;
        case 'getRelateForm':
            if (!is_string($uid)) throw new SuiteCRM\Exception\AccessDeniedException();
            $ids = json_decode(from_html($uid), true);
            if (!is_array($ids) || !array_is_list($ids)) throw new SuiteCRM\Exception\AccessDeniedException();
            break;
        case 'searchAdvanced':
        case 'getMessageListSugarFolders':
            // Match the row-query module gate before the legacy action begins.
            // The pinned query builders separately apply the scope before counts.
            clawpilot_candidate_email_where(BeanFactory::newBean('Emails'), '');
            break;
    }
    if ($ids !== null) clawpilot_candidate_require_email_reads($ids);
}
