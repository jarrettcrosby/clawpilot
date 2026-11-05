<?php
declare(strict_types=1);

/** Initial enrollment's exact policy-row transport, NOT authorization. The
 * independently approved executor derives these rows from the complete plan,
 * proves every native identity/ACL and admits this delta before any write.
 * Ordinary publication/membership transactions may not combine with it. */
final class ClawPilotNativeEmailInitialPolicyDelta
{
    private const COLUMNS = [
        'acl_actions'=>['id','date_entered','date_modified','modified_user_id','created_by','name','category','acltype','aclaccess','deleted'],
        'securitygroups'=>['id','name','date_entered','date_modified','modified_user_id','created_by','description','deleted','assigned_user_id','noninheritable'],
        'securitygroups_users'=>['id','date_modified','deleted','securitygroup_id','user_id','primary_group','noninheritable'],
        'securitygroups_records'=>['id','securitygroup_id','record_id','module','date_modified','modified_user_id','created_by','deleted'],
    ];
    private const NUMBERS = ['acl_actions'=>['aclaccess','deleted'],'securitygroups'=>['deleted','noninheritable'],
        'securitygroups_users'=>['deleted','primary_group','noninheritable'],'securitygroups_records'=>['deleted']];
    private const LIMITS = ['acl_actions'=>5,'securitygroups'=>100,'securitygroups_users'=>10000,'securitygroups_records'=>500];
    public readonly array $changes;

    public function __construct(array $changes)
    {
        self::keys($changes,array_keys(self::COLUMNS));$normalized=[];$actions=[];$groups=[];$members=[];$emails=[];
        foreach(self::COLUMNS as $table=>$columns) {
            $deltas=$changes[$table];self::need(is_array($deltas)&&array_is_list($deltas)
                &&count($deltas)>0&&count($deltas)<=self::LIMITS[$table],'initial_delta_bound');
            if($table==='acl_actions')self::need(count($deltas)===5,'initial_delta_defaults');
            $previous='';$normalized[$table]=[];
            foreach($deltas as $delta) {
                self::keys($delta,['before','after']);$after=self::nativeRow($table,$delta['after']);
                $before=$delta['before']===null?null:self::nativeRow($table,$delta['before']);
                self::need(self::id($after['id'])&&strcmp($after['id'],$previous)>0,'initial_delta_order');$previous=$after['id'];
                if($table==='acl_actions') {
                    self::need($before!==null&&$before['category']==='Emails'&&$before['acltype']==='module'
                        &&$before['deleted']==='0'&&$before['aclaccess']==='90'
                        &&in_array($before['name'],['delete','edit','export','list','view'],true)
                        &&!isset($actions[$before['name']]),'initial_delta_defaults');
                    $actions[$before['name']]=true;$expected=$before;
                    $expected['aclaccess']=in_array($before['name'],['delete','edit'],true)?'75':'80';
                    self::need(self::same($table,$expected,$after),'initial_delta_default_identity');
                } else {
                    self::need($before===null&&self::uuid($after['id'])&&$after['deleted']==='0','initial_delta_create_only');
                    if($table==='securitygroups') {
                        self::need($after['noninheritable']==='1'&&self::id($after['assigned_user_id'])
                            &&self::id($after['created_by'])&&self::id($after['modified_user_id'])
                            &&is_string($after['name'])&&strlen($after['name'])>0&&strlen($after['name'])<=255
                            &&trim($after['name'])===$after['name']&&!str_contains($after['name'],"\0")
                            &&($after['description']===null||is_string($after['description'])&&strlen($after['description'])<=4096),
                            'initial_delta_group');
                        self::date($after['date_entered']);self::date($after['date_modified']);$groups[$after['id']]=true;
                    } elseif($table==='securitygroups_users') {
                        self::need(isset($groups[$after['securitygroup_id']])&&self::id($after['user_id'])
                            &&$after['primary_group']==='0'&&$after['noninheritable']==='1','initial_delta_membership');
                        $pair=$after['securitygroup_id'].':'.$after['user_id'];
                        self::need(!isset($members[$pair]),'initial_delta_membership_duplicate');$members[$pair]=true;
                        self::date($after['date_modified']);
                    } else {
                        self::need(isset($groups[$after['securitygroup_id']])&&self::id($after['record_id'])
                            &&$after['module']==='Emails'&&$after['modified_user_id']===null&&$after['created_by']===null,
                            'initial_delta_email_link');
                        self::need(!isset($emails[$after['record_id']]),'initial_delta_email_duplicate');$emails[$after['record_id']]=true;
                        self::date($after['date_modified']);
                    }
                }
                $normalized[$table][]=['before'=>$before,'after'=>$after];
            }
        }
        $this->changes=$normalized;
    }

    public function tables(): array { $tables=array_keys(self::COLUMNS);sort($tables,SORT_STRING);return $tables; }
    public function fingerprint(): string { return hash('sha256',self::canonical($this->changes)); }

    public function assertBefore(string $table,array $rows): void
    {
        $indexed=$this->index($table,$rows);
        foreach($this->changes[$table] as $delta)self::need(self::same($table,$indexed[$delta['after']['id']]??null,$delta['before']),
            'initial_delta_preimage_changed');
        // A different-ID, deleted or foreign-module legacy link is not new.
        // The complete policy scan, not a live-row-only lookup, is required.
        if($table==='securitygroups_records') {
            $ids=array_fill_keys(array_column(array_column($this->changes[$table],'after'),'record_id'),true);
            foreach($rows as $row)self::need(!isset($ids[$row['record_id']]),'initial_delta_email_link_not_new');
        } elseif($table==='securitygroups_users') {
            $groups=array_fill_keys(array_column(array_column($this->changes['securitygroups'],'after'),'id'),true);
            foreach($rows as $row)self::need(!isset($groups[$row['securitygroup_id']]),'initial_delta_membership_not_new');
        }
    }

    /** Remove/reconstruct only exact postimages. The outer policy fingerprint
     * still proves every unrelated row, NULL, native scalar type and table. */
    public function restoreBefore(string $table,array $rows): array
    {
        $indexed=$this->index($table,$rows);
        foreach($this->changes[$table] as $delta) {
            $id=$delta['after']['id'];self::need(isset($indexed[$id])&&self::same($table,$indexed[$id],$delta['after']),
                'initial_delta_postimage_changed');
            if($delta['before']===null)unset($indexed[$id]);
            else $indexed[$id]=$this->transport($table,$delta['before'],$indexed[$id],array_keys($indexed[$id]));
        }
        ksort($indexed,SORT_STRING);return array_values($indexed);
    }

    /** Read-only projection. Its result is not an execution receipt. */
    public function projectAfter(string $table,array $rows,array $columnOrder): array
    {
        self::table($table);$actual=$columnOrder;$expected=self::COLUMNS[$table];sort($actual,SORT_STRING);sort($expected,SORT_STRING);
        self::need($actual===$expected,'initial_delta_projection_columns');$this->assertBefore($table,$rows);$indexed=$this->index($table,$rows);
        foreach($this->changes[$table] as $delta) {
            $id=$delta['after']['id'];$sample=$indexed[$id]??($rows[0]??[]);
            $indexed[$id]=$this->transport($table,$delta['after'],$sample,$columnOrder);
        }
        ksort($indexed,SORT_STRING);return array_values($indexed);
    }

    private function transport(string $table,array $source,array $sample,array $columnOrder): array
    {
        $result=[];
        foreach($columnOrder as $column) {
            $value=$source[$column];
            if($value!==null&&in_array($column,self::NUMBERS[$table],true)&&is_int($sample[$column]??null))$value=(int)$value;
            $result[$column]=$value;
        }
        return $result;
    }
    private function index(string $table,array $rows): array
    {
        self::table($table);self::need(array_is_list($rows),'initial_delta_rows');$indexed=[];
        foreach($rows as $row){self::nativeRow($table,$row);self::need(self::id($row['id'])&&!isset($indexed[$row['id']]),'initial_delta_row_duplicate');$indexed[$row['id']]=$row;}
        return $indexed;
    }
    public static function nativeRow(string $table,mixed $row): array
    {
        self::table($table);self::keys($row,self::COLUMNS[$table]);
        foreach($row as $key=>$value) {
            if(in_array($key,self::NUMBERS[$table],true)) {
                self::need($value===null||is_int($value)||is_string($value)&&preg_match('/^-?(?:0|[1-9][0-9]*)$/D',$value)===1,
                    'initial_delta_native_number');
                if($value!==null)$row[$key]=(string)$value;
            } else self::need($value===null||is_string($value),'initial_delta_native_scalar');
        }
        self::need(strlen(self::canonical($row))<=65536,'initial_delta_row_bytes');return $row;
    }
    private static function same(string $table,mixed $left,mixed $right): bool
    {return self::canonical($left===null?null:self::nativeRow($table,$left))===self::canonical($right===null?null:self::nativeRow($table,$right));}
    private static function canonical(mixed $value): string
    {
        if(is_array($value)) {
            if(!array_is_list($value))ksort($value,SORT_STRING);
            foreach($value as $key=>$entry)$value[$key]=json_decode(self::canonical($entry),true,32,JSON_THROW_ON_ERROR);
        }
        return json_encode($value,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
    }
    private static function table(string $table): void { self::need(isset(self::COLUMNS[$table]),'initial_delta_table'); }
    private static function keys(mixed $value,array $keys): void
    {self::need(is_array($value)&&!array_is_list($value),'initial_delta_shape');$actual=array_keys($value);sort($actual,SORT_STRING);sort($keys,SORT_STRING);self::need($actual===$keys,'initial_delta_shape');}
    private static function id(mixed $value): bool { return is_string($value)&&preg_match('/^[a-z0-9][a-z0-9-]{0,35}$/iD',$value)===1; }
    private static function uuid(mixed $value): bool { return is_string($value)&&preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iD',$value)===1; }
    private static function date(mixed $value): void
    {$date=is_string($value)?DateTimeImmutable::createFromFormat('!Y-m-d H:i:s',$value,new DateTimeZone('UTC')):false;
        self::need($date!==false&&$date->format('Y-m-d H:i:s')===$value,'initial_delta_date');}
    private static function need(bool $condition,string $code): void
    {if(!$condition)throw new ClawPilotNativeEmailTransactionRefused($code);}
}
