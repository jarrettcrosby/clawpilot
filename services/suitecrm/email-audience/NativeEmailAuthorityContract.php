<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailTransaction.php';
require_once __DIR__.'/NativeEmailCapabilityContract.php';

/** Prepared wire contract. Hashes identify exact evidence; they NEVER supply
 * authority. Execution additionally requires the native preauthorization row. */
final class ClawPilotNativeEmailAuthorityContract
{
    public const SURFACES=['view','list','export','edit','delete'];
    public const BINDING_KEYS=['pipeline_id','workspace_id','group_id','generation','owner_id','readers_json',
        'audience_fingerprint','policy_fingerprint','runtime_fingerprint','enabled'];
    public const CAPABILITY_BINDING_KEYS=['capability_policy_json','capability_policy_fingerprint'];
    /** mysqli prepared reads expose integer columns as ints, text-protocol
     * reads may expose strings. The wire format has exactly these ten columns
     * and decimal strings for the two numeric fields; no unknown column drops. */
    public static function nativeBinding(array $row,int $version=1): array
    {
        self::need(in_array($version,[1,2],true),'authority_command_version');
        if($version===1 && array_key_exists('capability_policy_json',$row) && array_key_exists('capability_policy_fingerprint',$row)) {
            self::need($row['capability_policy_json']===null && $row['capability_policy_fingerprint']===null,
                'authority_capability_transition_unsupported');
            unset($row['capability_policy_json'],$row['capability_policy_fingerprint']);
        }
        self::keys($row,$version===2?array_merge(self::BINDING_KEYS,self::CAPABILITY_BINDING_KEYS):self::BINDING_KEYS);
        foreach(['generation','enabled'] as $key) {
            self::need(is_int($row[$key]) || is_string($row[$key]),'authority_binding_shape');
            $row[$key]=(string)$row[$key];
        }
        self::binding($row,$version);return $row;
    }
    public static function validate(array $c): void
    {
        self::keys($c,array_merge(['version','operationId','transitionId','phase','generationFrom','generationTo','desiredAppChangeHash',
            'beforePolicyFingerprint','afterPolicyFingerprint','beforeBindingsFingerprint','afterBindingsFingerprint',
            'runtimeFingerprint','bindings','membershipChanges','capabilities','pendingPublicationCommand'],
            array_key_exists('roleChanges',$c)?['roleChanges']:[],array_key_exists('identityLinks',$c)?['identityLinks']:[]));
        self::need(in_array($c['version'],[1,2],true) && in_array($c['phase'],['revoke','grant'],true),'authority_command_version');
        $roles=$c['roleChanges']??[];
        if(array_key_exists('roleChanges',$c)) {
            self::need($c['version']===2 && is_array($roles) && array_is_list($roles) && count($roles)>0 && count($roles)<=100,'authority_role_change_bound');
            $previousRole='';
            foreach($roles as $role) {
                self::keys($role,['pipelineId','userId','beforeRole','afterRole']);self::id($role['pipelineId']);self::id($role['userId'],36);
                $key=$role['pipelineId']."\0".$role['userId'];
                self::need(strcmp($key,$previousRole)>0 && in_array($role['beforeRole'],['viewer','editor'],true)
                    && in_array($role['afterRole'],['viewer','editor'],true) && $role['beforeRole']!==$role['afterRole'],'authority_role_change_invalid');
                $previousRole=$key;
            }
        }
        if(array_key_exists('identityLinks',$c)) {
            self::need($c['version']===2 && !array_key_exists('roleChanges',$c) && is_array($c['identityLinks'])
                && array_is_list($c['identityLinks']) && count($c['identityLinks'])>0 && count($c['identityLinks'])<=100,'authority_identity_link_bound');
            $previousIdentity='';$references=[];
            foreach($c['identityLinks'] as $link) {
                self::keys($link,['userId','globalId','username']);self::id($link['userId'],36);
                self::need(strcmp($link['userId'],$previousIdentity)>0 && is_string($link['globalId'])
                    && preg_match('/^gu(?:[0-9]{7}|[0-9a-v]{12})$/D',$link['globalId'])===1
                    && $link['username']===$link['globalId'] && !isset($references[$link['globalId']]),'authority_identity_link_invalid');
                $previousIdentity=$link['userId'];$references[$link['globalId']]=true;
            }
        }
        foreach(['operationId','transitionId','desiredAppChangeHash','beforePolicyFingerprint','afterPolicyFingerprint',
            'beforeBindingsFingerprint','afterBindingsFingerprint','runtimeFingerprint'] as $key)self::hash($c[$key]);
        self::need(is_int($c['generationFrom']) && $c['generationFrom']>0 && is_int($c['generationTo'])
            && $c['generationTo']===$c['generationFrom']+1 && $c['generationTo']<=9007199254740991,'authority_generation');
        self::need(array_is_list($c['bindings']) && count($c['bindings'])>0 && count($c['bindings'])<=100,'authority_binding_bound');
        $pipelines=[];$groups=[];$previous='';$beforeBindings=[];$afterBindings=[];$inventory=null;
        foreach($c['bindings'] as $pair) {
            self::keys($pair,['before','after']);$before=$pair['before'];$after=$pair['after'];
            $beforeCapability=self::binding($before,$c['version']);$afterCapability=self::binding($after,$c['version']);
            if($c['version']===2) {
                self::need(($beforeCapability===null)===($afterCapability===null),'authority_capability_mode_changed');
                if($beforeCapability!==null) {
                    $inventory??=$beforeCapability['principalSuiteCrmUserIds'];
                    self::need($beforeCapability['principalSuiteCrmUserIds']===$inventory && $afterCapability['principalSuiteCrmUserIds']===$inventory,
                        'authority_capability_principal_changed');
                    $beforeReaders=json_decode($before['readers_json'],true);$afterReaders=json_decode($after['readers_json'],true);
                    foreach(self::SURFACES as $surface) {
                        $old=$beforeCapability['futureCreate'][$surface];$next=$afterCapability['futureCreate'][$surface];
                        self::monotonic($old,$next,$c['phase']);
                        self::memberCapabilityDelta($old,$next,$beforeReaders,$afterReaders,$c['phase'],
                            in_array($surface,['edit','delete'],true)?array_values(array_filter($roles,static fn($r)=>$r['pipelineId']===$before['pipeline_id'])):[]);
                    }
                }
            }
            self::need(strcmp($before['pipeline_id'],$previous)>0 && !isset($groups[$before['group_id']]),'authority_binding_order');
            $previous=$before['pipeline_id'];$pipelines[$previous]=$pair;$groups[$before['group_id']]=$pair;
            foreach(['pipeline_id','workspace_id','group_id','owner_id','runtime_fingerprint','enabled'] as $key)
                self::need($before[$key]===$after[$key],'authority_binding_identity');
            self::need($before['generation']===(string)$c['generationFrom'] && $after['generation']===(string)$c['generationTo']
                && $before['policy_fingerprint']===$c['beforePolicyFingerprint'] && $after['policy_fingerprint']===$c['afterPolicyFingerprint']
                && $before['runtime_fingerprint']===$c['runtimeFingerprint'],'authority_binding_pins');
            self::monotonic(json_decode($before['readers_json'],true),json_decode($after['readers_json'],true),$c['phase']);
            $beforeBindings[]=$before;$afterBindings[]=$after;
        }
        self::need(self::digest($beforeBindings)===$c['beforeBindingsFingerprint']
            && self::digest($afterBindings)===$c['afterBindingsFingerprint'],'authority_bindings_fingerprint');
        foreach($roles as $role) {
            $pair=$pipelines[$role['pipelineId']]??null;
            self::need($pair!==null && $role['userId']!==$pair['before']['owner_id']
                && ($pair['before']['capability_policy_json']??null)!==null
                && in_array($role['userId'],json_decode($pair['before']['readers_json'],true),true)
                && in_array($role['userId'],json_decode($pair['after']['readers_json'],true),true),'authority_role_change_scope');
        }
        foreach($c['identityLinks']??[] as $link)self::need($inventory!==null && in_array($link['userId'],$inventory,true),'authority_identity_link_principal');
        $delta=new ClawPilotNativeEmailAuthorityDelta($c['phase'],$c['membershipChanges']);
        foreach($delta->changes as $change) {
            $row=$change['after'];$pair=$groups[$row['securitygroup_id']]??null;
            self::need($pair!==null && $row['user_id']!==$pair['before']['owner_id'],'authority_membership_outside_binding');
            foreach($roles as $role)self::need($role['pipelineId']!==$pair['before']['pipeline_id'] || $role['userId']!==$row['user_id'],'authority_role_membership_churn');
        }
        self::need(array_is_list($c['capabilities']) && count($c['capabilities'])<=500,'authority_email_bound');
        $previous='';$globalIds=[];
        foreach($c['capabilities'] as $entry) {
            self::keys($entry,['emailId','globalId','pipelineId','before','after']);self::id($entry['emailId'],36);self::id($entry['pipelineId']);
            self::need(is_string($entry['globalId']) && preg_match('/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D',$entry['globalId'])===1
                && !isset($globalIds[$entry['globalId']]) && strcmp($entry['emailId'],$previous)>0
                && isset($pipelines[$entry['pipelineId']]),'authority_email_identity');
            $previous=$entry['emailId'];$globalIds[$entry['globalId']]=true;
            foreach(['before','after'] as $stage) {
                self::keys($entry[$stage],self::SURFACES);
                foreach(self::SURFACES as $surface)self::ids($entry[$stage][$surface]);
                $readers=json_decode($pipelines[$entry['pipelineId']][$stage]['readers_json'],true);
                foreach(['view','list','export'] as $surface)self::need($entry[$stage][$surface]===$readers,'authority_read_matrix_binding');
                foreach(['edit','delete'] as $surface)self::need(array_diff($entry[$stage][$surface],$readers)===[],'authority_write_requires_read');
            }
            foreach(self::SURFACES as $surface) {
                self::monotonic($entry['before'][$surface],$entry['after'][$surface],$c['phase']);
                if($c['version']===2) {
                    $oldReaders=json_decode($pipelines[$entry['pipelineId']]['before']['readers_json'],true);
                    $nextReaders=json_decode($pipelines[$entry['pipelineId']]['after']['readers_json'],true);
                    self::memberCapabilityDelta($entry['before'][$surface],$entry['after'][$surface],$oldReaders,$nextReaders,$c['phase'],
                        in_array($surface,['edit','delete'],true)?array_values(array_filter($roles,static fn($r)=>$r['pipelineId']===$entry['pipelineId'])):[]);
                }
            }
            // A reader-only grant must not silently upgrade an existing member's
            // write authority. Every write addition is explicit in this matrix.
        }
        if($c['pendingPublicationCommand']!==null) {
            self::need($c['version']===1,'authority_v2_pending_publication_unsupported');
            $p=$c['pendingPublicationCommand'];
            self::need($c['phase']==='revoke' && is_array($p) && !array_is_list($p),'authority_pending_publication');
            self::keys($p,['version','operationId','mode','workspaceId','pipelineId','generation','audienceFingerprint',
                'suiteCrmId','globalId','localId','expectedRecordFingerprint','projection']);
            self::need($p['version']===1 && in_array($p['mode'],['publish','repair'],true)
                && isset($pipelines[$p['pipelineId']]) && $p['generation']===$c['generationFrom'],'authority_pending_publication');
            $b=$pipelines[$p['pipelineId']]['before'];
            self::need($p['workspaceId']===$b['workspace_id'] && $p['audienceFingerprint']===$b['audience_fingerprint'],'authority_pending_publication');
            self::hash($p['operationId']);self::id($p['suiteCrmId'],36);self::id($p['localId']);
            self::need(is_string($p['globalId']) && preg_match('/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D',$p['globalId'])===1,'authority_pending_publication');
            if($p['expectedRecordFingerprint']!==null)self::hash($p['expectedRecordFingerprint']);
            self::need($p['mode']==='repair' ? $p['projection']===null : is_array($p['projection']),'authority_pending_publication');
        }
        self::need(strlen(self::canonical($c))<=800000,'authority_command_size');
    }
    private static function binding(mixed $b,int $version=1): ?array
    {
        self::keys($b,$version===2?array_merge(self::BINDING_KEYS,self::CAPABILITY_BINDING_KEYS):self::BINDING_KEYS);
        foreach(['pipeline_id','workspace_id'] as $key)self::id($b[$key]);
        foreach(['group_id','owner_id'] as $key)self::id($b[$key],36);
        foreach(['audience_fingerprint','policy_fingerprint','runtime_fingerprint'] as $key)self::hash($b[$key]);
        self::need(is_string($b['generation']) && preg_match('/^[1-9][0-9]{0,15}$/D',$b['generation'])===1
            && (float)$b['generation']<=9007199254740991 && $b['enabled']==='1' && is_string($b['readers_json']),'authority_binding_shape');
        $readers=json_decode($b['readers_json'],true,16,JSON_THROW_ON_ERROR);self::ids($readers);
        self::need(in_array($b['owner_id'],$readers,true) && self::canonical($readers)===$b['readers_json'],'authority_readers_canonical');
        // Existing publisher hashes these keys in this defined order rather
        // than the command's recursively sorted canonical representation.
        self::need(hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>$b['owner_id'],
            'allowedSuiteCrmUserIds'=>$readers,'workspaceId'=>$b['workspace_id'],'pipelineId'=>$b['pipeline_id']],
            JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR))===$b['audience_fingerprint'],'authority_audience_fingerprint');
        if($version===1)return null;
        if($b['capability_policy_json']===null) {
            self::need($b['capability_policy_fingerprint']===null,'authority_capability_policy_shape');return null;
        }
        self::need(is_string($b['capability_policy_json']) && strlen($b['capability_policy_json'])<=600000,'authority_capability_policy_shape');
        self::hash($b['capability_policy_fingerprint']);
        try {
            $policy=json_decode($b['capability_policy_json'],true,32,JSON_THROW_ON_ERROR);
            self::need(is_array($policy) && ($policy['historical']??null)===[],'authority_capability_policy_shape');
            $prepared=ClawPilotNativeEmailCapabilityContract::prepare($policy,[
                'binding'=>['pipelineId'=>$b['pipeline_id'],'workspaceId'=>$b['workspace_id'],'ownerSuiteCrmId'=>$b['owner_id'],
                    'audienceFingerprint'=>$b['audience_fingerprint'],'allowedReaderSuiteCrmUserIds'=>$readers],
                'livePrincipalSuiteCrmUserIds'=>$policy['principalSuiteCrmUserIds']??null,
                'approvedFutureCreate'=>$policy['futureCreate']??null,'liveHistorical'=>[],
            ]);
            self::need(hash_equals($b['capability_policy_fingerprint'],$prepared['futurePolicyFingerprint']),'authority_capability_policy_fingerprint');
            // Preserve the original JSON string bytes in the binding preimage.
            // Native execution independently rechecks the complete inventory.
            return $prepared['contract'];
        }catch(ClawPilotNativeEmailTransactionRefused $error){throw $error;}
        catch(Throwable $error){self::need(false,'authority_capability_policy_invalid');}
    }
    private static function memberCapabilityDelta(array $before,array $after,array $beforeReaders,array $afterReaders,string $phase,array $roles): void
    {
        $demoted=array_column(array_filter($roles,static fn($r)=>$r['afterRole']==='viewer'),'userId');
        $promoted=array_column(array_filter($roles,static fn($r)=>$r['afterRole']==='editor'),'userId');
        $expected=$phase==='revoke'?array_values(array_diff(array_intersect($before,$afterReaders),$demoted))
            :array_values(array_unique(array_merge($before,$promoted)));
        sort($expected,SORT_STRING);
        self::need($expected===($phase==='revoke'?$after:array_values(array_intersect($after,$beforeReaders))),
            'authority_capability_retained_rights_changed');
    }
    private static function monotonic(array $before,array $after,string $phase): void
    { self::need($phase==='revoke' ? array_diff($after,$before)===[] : array_diff($before,$after)===[],'authority_phase_not_monotonic'); }
    public static function ids(mixed $ids): void
    {
        self::need(is_array($ids) && array_is_list($ids) && count($ids)<=500,'authority_ids');$prior='';
        foreach($ids as $id){self::id($id,36);self::need(strcmp($id,$prior)>0,'authority_ids_order');$prior=$id;}
    }
    public static function id(mixed $id,int $limit=64): void
    { self::need(is_string($id) && strlen($id)<=$limit && preg_match('/^[a-z0-9][a-z0-9-]*$/iD',$id)===1,'authority_id'); }
    public static function hash(mixed $hash): void
    { self::need(is_string($hash) && preg_match('/^[a-f0-9]{64}$/D',$hash)===1,'authority_hash'); }
    public static function keys(mixed $value,array $keys): void
    {
        self::need(is_array($value) && !array_is_list($value),'authority_shape');$actual=array_keys($value);sort($actual,SORT_STRING);sort($keys,SORT_STRING);
        self::need($actual===$keys,'authority_keys');
    }
    public static function canonical(mixed $value): string
    {
        $sort=static function($v)use(&$sort){if(!is_array($v))return $v;if(!array_is_list($v))ksort($v,SORT_STRING);return array_map($sort,$v);};
        return json_encode($sort($value),JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
    }
    public static function digest(mixed $value): string {return hash('sha256',self::canonical($value));}
    public static function need(bool $condition,string $code): void
    {if(!$condition)throw new ClawPilotNativeEmailTransactionRefused($code);}
}
