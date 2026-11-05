<?php
declare(strict_types=1);

/** V2 value verifier. Native publisher evidence comes from locked trusted rows.
 * Evidence must come from an independent locked native inventory and explicit
 * future-create approval. The proposed contract cannot supply its own proof. */
final class ClawPilotNativeEmailCapabilityContract
{
    public const SURFACES = ['view','list','export','edit','delete'];
    public static function prepare(array $c,array $e): array
    {
        self::keys($c,['version','pipelineId','workspaceId','ownerSuiteCrmId','audienceFingerprint','principalSuiteCrmUserIds','futureCreate','historical']);
        self::keys($e,['binding','livePrincipalSuiteCrmUserIds','approvedFutureCreate','liveHistorical']);
        $b=$e['binding'];self::keys($b,['pipelineId','workspaceId','ownerSuiteCrmId','audienceFingerprint','allowedReaderSuiteCrmUserIds']);
        self::need($c['version']===2 && self::matches($b['pipelineId'],'/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/D')
            && self::matches($b['workspaceId'],'/^[a-z0-9][a-z0-9-]{0,63}$/iD') && self::id($b['ownerSuiteCrmId'])
            && self::matches($b['audienceFingerprint'],'/^[a-f0-9]{64}$/D'),'capability_binding_identity');
        foreach(['pipelineId','workspaceId','ownerSuiteCrmId','audienceFingerprint'] as $key)
            self::need($c[$key]===$b[$key],'capability_binding_changed');
        $readers=$b['allowedReaderSuiteCrmUserIds'];self::ids($readers);self::ids($e['livePrincipalSuiteCrmUserIds']);self::ids($c['principalSuiteCrmUserIds']);
        self::need(count($readers)>0 && in_array($b['ownerSuiteCrmId'],$readers,true)
            && array_diff($readers,$e['livePrincipalSuiteCrmUserIds'])===[]
            && $c['principalSuiteCrmUserIds']===$e['livePrincipalSuiteCrmUserIds'],'capability_principal_inventory_changed');
        $audience=hash('sha256',json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>$b['ownerSuiteCrmId'],
            'allowedSuiteCrmUserIds'=>$readers,'workspaceId'=>$b['workspaceId'],'pipelineId'=>$b['pipelineId']],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
        self::need($audience===$b['audienceFingerprint'],'capability_audience_fingerprint');
        self::matrix($c['futureCreate'],$readers,$c['principalSuiteCrmUserIds']);
        self::matrix($e['approvedFutureCreate'],$readers,$e['livePrincipalSuiteCrmUserIds']);
        self::history($c['historical'],$readers,$c['principalSuiteCrmUserIds']);
        self::history($e['liveHistorical'],$readers,$e['livePrincipalSuiteCrmUserIds']);
        self::need(self::canonical($c['futureCreate'])===self::canonical($e['approvedFutureCreate']),'capability_future_not_approved');
        self::need(self::canonical($c['historical'])===self::canonical($e['liveHistorical']),'capability_history_changed');
        $canonical=self::canonical($c);self::need(strlen($canonical)<=600000,'capability_contract_size');
        $futurePolicy=$c;unset($futurePolicy['historical']);$historicalManifest=$c;unset($historicalManifest['futureCreate']);
        return ['contract'=>json_decode($canonical,true,32,JSON_THROW_ON_ERROR),'fingerprint'=>hash('sha256',$canonical),
            'futurePolicyFingerprint'=>hash('sha256',self::canonical($futurePolicy)),
            'historicalFingerprint'=>hash('sha256',self::canonical($historicalManifest))];
    }
    /** Future-policy pin: durable binding. Bundle/history pins: exact operation. */
    public static function verifyFingerprint(array $c,array $e,string $expected,string $scope='bundle'): void
    {
        $prepared=self::prepare($c,$e);
        self::need(in_array($scope,['bundle','future-policy','historical'],true),'capability_fingerprint_scope');
        $fingerprint=$scope==='future-policy'?$prepared['futurePolicyFingerprint']:($scope==='historical'?$prepared['historicalFingerprint']:$prepared['fingerprint']);
        self::need(self::matches($expected,'/^[a-f0-9]{64}$/D') && $fingerprint===$expected,'capability_fingerprint_changed');
    }
    public static function verifyReadback(array $c,array $e,array $selection,array $readback): void
    {
        self::prepare($c,$e);self::keys($readback,['principalSuiteCrmUserIds','capabilities']);self::ids($readback['principalSuiteCrmUserIds']);
        self::need($readback['principalSuiteCrmUserIds']===$c['principalSuiteCrmUserIds'],'capability_readback_inventory_changed');
        self::keys($selection,($selection['mode']??null)==='future-create'?['mode']:['mode','suiteCrmId','globalId']);
        self::need(in_array($selection['mode'],['future-create','historical'],true),'capability_selection');
        $expected=null;
        if($selection['mode']==='future-create')$expected=$c['futureCreate'];
        else foreach($c['historical'] as $entry) if($entry['suiteCrmId']===$selection['suiteCrmId'] && $entry['globalId']===$selection['globalId'])$expected=$entry['capabilities'];
        self::need($expected!==null,'capability_historical_record_missing');
        self::matrix($readback['capabilities'],$e['binding']['allowedReaderSuiteCrmUserIds'],$c['principalSuiteCrmUserIds']);
        self::need(self::canonical($readback['capabilities'])===self::canonical($expected),'capability_readback_changed');
    }
    /** Per-target verification. A publication never re-hashes growing history.
     * The caller must obtain expected rights from the trusted binding (create)
     * or immutable identity enrollment (existing), not request-supplied rights.
     * Repair may correct readers but must preserve every existing write right. */
    public static function validateTarget(array $expected,array $readers,array $principals): void
    {
        self::ids($readers);self::ids($principals);
        self::need(count($principals)>0 && array_diff($readers,$principals)===[],'capability_principal_inventory_changed');
        self::matrix($expected,$readers,$principals);
    }
    public static function verifyTargetReadback(array $expected,array $readers,array $principals,array $readback,bool $writesOnly=false): void
    {
        self::validateTarget($expected,$readers,$principals);
        self::keys($readback,['principalSuiteCrmUserIds','capabilities']);
        self::need($readback['principalSuiteCrmUserIds']===$principals,'capability_readback_inventory_changed');
        self::keys($readback['capabilities'],self::SURFACES);
        foreach(self::SURFACES as $surface) {
            self::ids($readback['capabilities'][$surface]);
            self::need(array_diff($readback['capabilities'][$surface],$principals)===[],'capability_unknown_principal');
            if(!$writesOnly || in_array($surface,['edit','delete'],true))
                self::need($readback['capabilities'][$surface]===$expected[$surface],'capability_readback_changed');
        }
    }
    private static function matrix(mixed $m,array $readers,array $principals): void
    {
        self::keys($m,self::SURFACES);
        foreach(self::SURFACES as $surface) {
            self::ids($m[$surface]);self::need(array_diff($m[$surface],$principals)===[],'capability_unknown_principal');
            if(in_array($surface,['edit','delete'],true))self::need(array_diff($m[$surface],$readers)===[],'capability_write_without_read');
            else self::need($m[$surface]===$readers,'capability_reader_binding');
        }
    }
    private static function history(mixed $history,array $readers,array $principals): void
    {
        self::need(is_array($history) && array_is_list($history) && count($history)<=500,'capability_history_bound');
        $previous='';$globals=[];
        foreach($history as $entry) {
            self::keys($entry,['suiteCrmId','globalId','capabilities']);
            self::need(self::id($entry['suiteCrmId']) && strcmp($entry['suiteCrmId'],$previous)>0
                && self::matches($entry['globalId'],'/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D') && !isset($globals[$entry['globalId']]),'capability_history_identity');
            $previous=$entry['suiteCrmId'];$globals[$entry['globalId']]=true;self::matrix($entry['capabilities'],$readers,$principals);
        }
    }
    private static function ids(mixed $ids): void
    {
        self::need(is_array($ids) && array_is_list($ids) && count($ids)<=500,'capability_principal_ids');$prior='';
        foreach($ids as $id){self::need(self::id($id) && strcmp($id,$prior)>0,'capability_principal_ids');$prior=$id;}
    }
    private static function id(mixed $id): bool {return self::matches($id,'/^[a-z0-9][a-z0-9-]{0,35}$/iD');}
    private static function matches(mixed $value,string $pattern): bool {return is_string($value) && preg_match($pattern,$value)===1;}
    private static function keys(mixed $value,array $keys): void
    {
        self::need(is_array($value) && !array_is_list($value),'capability_shape');$actual=array_keys($value);sort($actual,SORT_STRING);sort($keys,SORT_STRING);
        self::need($actual===$keys,'capability_shape');
    }
    private static function canonical(mixed $value): string
    {
        $sort=static function($v)use(&$sort){if(!is_array($v))return $v;if(!array_is_list($v))ksort($v,SORT_STRING);return array_map($sort,$v);};
        return json_encode($sort($value),JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
    }
    private static function need(bool $ok,string $code): void
    {if(!$ok)throw new RuntimeException('Native Email capability contract held: '.$code);}
}
