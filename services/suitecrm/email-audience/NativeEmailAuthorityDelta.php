<?php
declare(strict_types=1);

/** Exact membership-only delta. This is not authorization. The authority
 * executor must prove its approved command, all bindings and capabilities
 * before admitting this value to the existing native transaction fence. */
final class ClawPilotNativeEmailAuthorityDelta
{
    private const COLUMNS = ['id','date_modified','deleted','securitygroup_id','user_id','primary_group','noninheritable'];
    public function __construct(public readonly string $phase, public readonly array $changes)
    {
        self::need(in_array($phase,['revoke','grant'],true) && array_is_list($changes) && count($changes)<=500,'authority_delta_shape');
        $previous='';
        foreach($changes as $change) {
            self::keys($change,['before','after']);
            $before=$change['before']; $after=$change['after']; self::row($after,false);
            self::need(strcmp($after['id'],$previous)>0,'authority_delta_order'); $previous=$after['id'];
            if($before!==null) {
                self::row($before,true);
                foreach(['id','securitygroup_id','user_id','primary_group','noninheritable'] as $key)
                    self::need($before[$key]===$after[$key],'authority_delta_identity');
            }
            if($phase==='revoke') self::need($before!==null && $before['deleted']==='0' && $after['deleted']==='1','authority_delta_not_revoke');
            else self::need(($before===null || $before['deleted']==='1') && $after['deleted']==='0'
                && ($before!==null || $after['primary_group']==='0'),'authority_delta_not_grant');
        }
    }
    public function assertBefore(array $rows): void
    {
        $indexed=$this->index($rows);
        foreach($this->changes as $change) self::need(self::same($indexed[$change['after']['id']]??null,$change['before']),'authority_membership_preimage_changed');
    }
    /** Reconstruct precisely the old scan, preserving native SELECT * column
     * order. Only exact approved postimages are removed/replaced. The enclosing
     * full-policy digest still proves every other row/table byte-identical. */
    public function restoreBefore(array $rows): array
    {
        $indexed=$this->index($rows);
        foreach($this->changes as $change) {
            $id=$change['after']['id'];
            self::need(isset($indexed[$id]) && self::same($indexed[$id],$change['after']),'authority_membership_postimage_changed');
            if($change['before']===null) unset($indexed[$id]);
            else {
                $before=$change['before'];
                // Preserve the text/native protocol numeric representation in
                // the original full-policy scan; normalization is wire-only.
                foreach(['deleted','primary_group','noninheritable'] as $key)
                    if(is_int($indexed[$id][$key]) && $before[$key]!==null)$before[$key]=(int)$before[$key];
                $indexed[$id]=array_replace($indexed[$id],$before);
            }
        }
        ksort($indexed,SORT_STRING); return array_values($indexed);
    }
    /** Read-only projection for the authenticated planning endpoint. This
     * substitutes exact member-row postimages in memory; it neither admits a
     * transaction mutation nor writes any native policy row. Keep the real
     * SELECT * column order and native numeric representation for the existing
     * streaming policy fingerprint. */
    public function projectAfter(array $rows,array $columnOrder): array
    {
        $columns=$columnOrder;$expected=self::COLUMNS;sort($columns,SORT_STRING);sort($expected,SORT_STRING);
        self::need($columns===$expected,'authority_projection_columns');
        $this->assertBefore($rows);$indexed=$this->index($rows);
        foreach($this->changes as $change) {
            $id=$change['after']['id'];$before=$indexed[$id]??null;
            $row=$before??array_fill_keys($columnOrder,null);
            foreach($change['after'] as $key=>$value) {
                if(in_array($key,['deleted','primary_group','noninheritable'],true) && $value!==null
                    && is_int(($before??($rows[0]??[]))[$key]??null))$value=(int)$value;
                $row[$key]=$value;
            }
            $indexed[$id]=$row;
        }
        ksort($indexed,SORT_STRING);return array_values($indexed);
    }
    private function index(array $rows): array
    {
        $indexed=[];
        foreach($rows as $row) {
            self::need(is_array($row) && isset($row['id']) && !isset($indexed[$row['id']]),'authority_membership_duplicate');
            $indexed[$row['id']]=$row;
        }
        return $indexed;
    }
    private static function row(mixed $row,bool $before): void
    {
        self::keys($row,self::COLUMNS);
        foreach(['id','securitygroup_id','user_id'] as $key)
            self::need(is_string($row[$key]) && preg_match('/^[a-z0-9][a-z0-9-]{0,35}$/iD',$row[$key])===1,'authority_membership_identity');
        self::need(in_array($row['deleted'],['0','1'],true) && in_array($row['primary_group'],['0','1',null],true)
            && $row['noninheritable']==='1','authority_membership_flags');
        if($before && $row['date_modified']===null) return;
        self::need(is_string($row['date_modified']),'authority_membership_date');
        $date=DateTimeImmutable::createFromFormat('!Y-m-d H:i:s',$row['date_modified'],new DateTimeZone('UTC'));
        self::need($date!==false && $date->format('Y-m-d H:i:s')===$row['date_modified'],'authority_membership_date');
    }
    private static function keys(mixed $value,array $keys): void
    {
        self::need(is_array($value) && !array_is_list($value),'authority_delta_shape');
        $actual=array_keys($value);sort($actual,SORT_STRING);sort($keys,SORT_STRING);
        self::need($actual===$keys,'authority_delta_shape');
    }
    private static function same(mixed $a,mixed $b): bool
    {
        if(is_array($a))$a=self::nativeRow($a);if(is_array($b))$b=self::nativeRow($b);
        if(is_array($a))ksort($a,SORT_STRING);if(is_array($b))ksort($b,SORT_STRING);return $a===$b;
    }
    public static function nativeRow(array $row): array
    {
        self::keys($row,self::COLUMNS);
        foreach(['deleted','primary_group','noninheritable'] as $key) {
            self::need($row[$key]===null || is_int($row[$key]) || is_string($row[$key]),'authority_membership_flags');
            if($row[$key]!==null)$row[$key]=(string)$row[$key];
        }
        self::row($row,true);return $row;
    }
    private static function need(bool $condition,string $code): void
    {
        if(!$condition)throw new ClawPilotNativeEmailTransactionRefused($code);
    }
}
