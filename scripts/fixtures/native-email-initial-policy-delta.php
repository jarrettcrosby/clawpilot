<?php
declare(strict_types=1);
// Pure row transport fixture: no database, SuiteCRM bootstrap or authorization.
if(!class_exists('ClawPilotNativeEmailTransactionRefused',false)) {
    class ClawPilotNativeEmailTransactionRefused extends RuntimeException {
        public function __construct(public readonly string $holdCode){parent::__construct($holdCode);}
    }
}
require_once __DIR__.'/../../services/suitecrm/email-audience/NativeEmailInitialPolicyDelta.php';
function initialDeltaNeed(bool $value,string $label):void {if(!$value)throw new RuntimeException($label);}
function initialDeltaRefused(callable $run,string $code):void {
    try{$run();}catch(ClawPilotNativeEmailTransactionRefused $error){initialDeltaNeed($error->holdCode===$code,'Unexpected refusal: '.$error->holdCode);return;}
    throw new RuntimeException('Expected refusal '.$code);
}
function initialDeltaFixture():array {
    $stamp='2026-11-03 12:00:00';$acl=[];
    foreach(['delete','edit','export','list','view'] as $name) {
        $before=['id'=>'action-'.$name,'date_entered'=>$stamp,'date_modified'=>$stamp,'modified_user_id'=>null,
            'created_by'=>null,'name'=>$name,'category'=>'Emails','acltype'=>'module','aclaccess'=>'90','deleted'=>'0'];
        $after=$before;$after['aclaccess']=in_array($name,['delete','edit'],true)?'75':'80';$acl[]=['before'=>$before,'after'=>$after];
    }
    $group='00000000-0000-4000-8000-000000000001';
    return ['acl_actions'=>$acl,'securitygroups'=>[['before'=>null,'after'=>['id'=>$group,'name'=>'ClawPilot native Email pipeline',
        'date_entered'=>$stamp,'date_modified'=>$stamp,'modified_user_id'=>'1','created_by'=>'1','description'=>'Exact synthetic scope',
        'deleted'=>'0','assigned_user_id'=>'1','noninheritable'=>'1']]],
        'securitygroups_users'=>[['before'=>null,'after'=>['id'=>'00000000-0000-4000-8000-000000000002','date_modified'=>$stamp,
            'deleted'=>'0','securitygroup_id'=>$group,'user_id'=>'1','primary_group'=>'0','noninheritable'=>'1']]],
        'securitygroups_records'=>[['before'=>null,'after'=>['id'=>'00000000-0000-4000-8000-000000000003','securitygroup_id'=>$group,
            'record_id'=>'native-email','module'=>'Emails','date_modified'=>$stamp,'modified_user_id'=>null,'created_by'=>null,'deleted'=>'0']]]];
}
$fixture=initialDeltaFixture();$delta=new ClawPilotNativeEmailInitialPolicyDelta($fixture);
$groups=0;$check=static function(string $label,callable $run)use(&$groups):void{$run();$groups++;fwrite(STDOUT,'PASS '.$label."\n");};
$check('exact complete-row projections restore original scans and preserve NULLs, column order and native numeric types',static function()use($fixture,$delta):void{
    foreach($delta->tables() as $table) {
        $rows=[];foreach($fixture[$table] as $change)if($change['before']!==null)$rows[]=$change['before'];
        if($table==='acl_actions')foreach($rows as &$row){$row['aclaccess']=90;$row['deleted']=0;}unset($row);
        $columns=array_reverse(array_keys($fixture[$table][0]['after']));
        foreach($rows as &$row)$row=array_replace(array_fill_keys($columns,null),$row);unset($row);
        $delta->assertBefore($table,$rows);$projected=$delta->projectAfter($table,$rows,$columns);
        initialDeltaNeed(array_keys($projected[0])===$columns,'Column order changed');
        initialDeltaNeed($delta->restoreBefore($table,$projected)===$rows,'Exact before scan not restored');
    }
});
$check('fingerprint is canonical and independent of associative column/table order',static function()use($fixture,$delta):void{
    $other=array_reverse($fixture,true);foreach($other as &$changes)foreach($changes as &$change)foreach(['before','after'] as $key)
        if($change[$key]!==null)$change[$key]=array_reverse($change[$key],true);unset($changes,$change);
    initialDeltaNeed((new ClawPilotNativeEmailInitialPolicyDelta($other))->fingerprint()===$delta->fingerprint(),'Noncanonical fingerprint');
    initialDeltaNeed(preg_match('/^[a-f0-9]{64}$/D',$delta->fingerprint())===1,'Fingerprint format');
});
$check('unknown tables, incomplete default coverage and any extra default-field mutation fail',static function()use($fixture):void{
    $f=$fixture;$f['users']=[];initialDeltaRefused(static fn()=>new ClawPilotNativeEmailInitialPolicyDelta($f),'initial_delta_shape');
    $f=$fixture;array_pop($f['acl_actions']);initialDeltaRefused(static fn()=>new ClawPilotNativeEmailInitialPolicyDelta($f),'initial_delta_defaults');
    foreach(['date_modified','category','created_by'] as $key){$f=$fixture;$f['acl_actions'][0]['after'][$key]='changed';
        initialDeltaRefused(static fn()=>new ClawPilotNativeEmailInitialPolicyDelta($f),'initial_delta_default_identity');}
    $f=$fixture;$f['acl_actions'][0]['after']['aclaccess']='90';initialDeltaRefused(static fn()=>new ClawPilotNativeEmailInitialPolicyDelta($f),'initial_delta_default_identity');
});
$check('new groups/members/Email links require exact flags and cannot adopt rows or duplicate natural identities',static function()use($fixture):void{
    foreach(['securitygroups','securitygroups_users','securitygroups_records'] as $table){$f=$fixture;$f[$table][0]['before']=$f[$table][0]['after'];
        initialDeltaRefused(static fn()=>new ClawPilotNativeEmailInitialPolicyDelta($f),'initial_delta_create_only');}
    foreach(['primary_group'=>'1','noninheritable'=>'0'] as $key=>$value){$f=$fixture;$f['securitygroups_users'][0]['after'][$key]=$value;
        initialDeltaRefused(static fn()=>new ClawPilotNativeEmailInitialPolicyDelta($f),'initial_delta_membership');}
    $f=$fixture;$f['securitygroups_records'][0]['after']['module']='Accounts';initialDeltaRefused(static fn()=>new ClawPilotNativeEmailInitialPolicyDelta($f),'initial_delta_email_link');
    foreach(['securitygroups_users'=>'initial_delta_membership_duplicate','securitygroups_records'=>'initial_delta_email_duplicate'] as $table=>$code){
        $f=$fixture;$row=$f[$table][0];$row['after']['id']='00000000-0000-4000-8000-000000000009';$f[$table][]=$row;
        initialDeltaRefused(static fn()=>new ClawPilotNativeEmailInitialPolicyDelta($f),$code);}
});
$check('changed preimages, stale deleted/foreign-module links and corrupted postimages refuse reconstruction',static function()use($fixture,$delta):void{
    $rows=array_column($fixture['acl_actions'],'before');$rows[0]['aclaccess']='80';
    initialDeltaRefused(static fn()=>$delta->assertBefore('acl_actions',$rows),'initial_delta_preimage_changed');
    $row=$fixture['securitygroups_records'][0]['after'];$row['id']='00000000-0000-4000-8000-000000000099';$row['module']='Accounts';$row['deleted']='1';
    initialDeltaRefused(static fn()=>$delta->assertBefore('securitygroups_records',[$row]),'initial_delta_email_link_not_new');
    $rows=$delta->projectAfter('securitygroups',[],array_keys($fixture['securitygroups'][0]['after']));$rows[0]['noninheritable']='0';
    initialDeltaRefused(static fn()=>$delta->restoreBefore('securitygroups',$rows),'initial_delta_postimage_changed');
});
$check('unrelated rows remain byte-identical; missing/extra native columns and malformed dates are not normalized away',static function()use($fixture,$delta):void{
    $rows=array_column($fixture['acl_actions'],'before');$other=$rows[0];$other['id']='foreign-action';$other['category']='Accounts';$other['aclaccess']='-99';$rows[]=$other;
    $projected=$delta->projectAfter('acl_actions',$rows,array_keys($rows[0]));
    initialDeltaNeed($projected[count($projected)-1]===$other,'Unrelated policy row changed');
    initialDeltaNeed($delta->restoreBefore('acl_actions',$projected)===$rows,'Unrelated row not preserved');
    initialDeltaRefused(static fn()=>$delta->projectAfter('securitygroups',[],['id']),'initial_delta_projection_columns');
    $f=$fixture;$f['securitygroups'][0]['after']['date_entered']='2026-02-30 12:00:00';
    initialDeltaRefused(static fn()=>new ClawPilotNativeEmailInitialPolicyDelta($f),'initial_delta_date');
});
fwrite(STDOUT,'NATIVE_INITIAL_POLICY_DELTA_PASSED='.$groups."\n");
