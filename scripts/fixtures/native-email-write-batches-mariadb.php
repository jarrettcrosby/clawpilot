<?php
declare(strict_types=1);
// Actual SQL transport/CAS tests only. No SuiteCRM ACL, native approval,
// authentication, policy fence, provider, browser or production proof.
if(PHP_SAPI!=='cli'||getenv('CLAWPILOT_NATIVE_BATCH_DISPOSABLE_TEST')!=='1')throw new RuntimeException('Disposable batch test required');
require '/repo/services/suitecrm/email-audience/NativeEmailAuthorityTransition.php';
mysqli_report(MYSQLI_REPORT_ERROR|MYSQLI_REPORT_STRICT);
$db=new mysqli('db','fixture','Synthetic-batch-only-password','suitecrm_native_batch_test');$db->set_charset('utf8mb4');
if($db->query('SELECT DATABASE()')->fetch_row()[0]!=='suitecrm_native_batch_test')throw new RuntimeException('Wrong database');
foreach(['publication-schema.sql','authority-transition-schema.sql'] as $file){
    $db->multi_query((string)file_get_contents('/repo/services/suitecrm/email-audience/'.$file));
    do{if($result=$db->store_result())$result->free();}while($db->more_results()&&$db->next_result());
}
$GLOBALS['sugar_config']['clawpilot_managed_email_write_scope']=true;
$service=new ClawPilotNativeEmailAuthorityTransition($db,[],'','','','');
$write=new ReflectionMethod($service,'writeCapabilityIdentities');$checks=0;
function batchNeed(bool $ok,string $message):void{if(!$ok)throw new RuntimeException($message);}
function batchRows(mysqli $db,string $table,string $key):array{
    $statement=$db->prepare('SELECT * FROM '.$table.' ORDER BY '.$key);
    try{$statement->execute();$result=$statement->get_result();return $result->fetch_all(MYSQLI_ASSOC);}
    finally{$statement->close();}
}
function batchState(mysqli $db):string{return ClawPilotNativeEmailAuthorityContract::canonical([
    batchRows($db,'clawpilot_email_identities','email_id'),batchRows($db,'clawpilot_email_write_permissions','email_id'),
    batchRows($db,'clawpilot_email_write_scopes','pipeline_id')]);}
function batchRun(mysqli $db,callable $run):void{
    $before=batchState($db);$db->begin_transaction();
    try{$run();}finally{$db->rollback();}
    batchNeed(batchState($db)===$before,'Every test must restore all identity/permission/scope bytes');
}
foreach([0,1,24,25,26,51,318,500] as $count){
    foreach(['clawpilot_email_write_permissions','clawpilot_email_identities','clawpilot_email_write_scopes'] as $table)$db->query('DELETE FROM '.$table);
    $db->query("INSERT INTO clawpilot_email_write_scopes VALUES('managed','".str_repeat('a',64)."','".str_repeat('b',64)."')");
    $matrix=['view'=>['Admin','reader'],'list'=>['Admin','reader'],'export'=>['Admin','reader'],'edit'=>['Admin'],'delete'=>['Admin']];
    $after=$matrix;$after['edit']=[];$after['delete']=[];
    $identities=[];$entries=[];
    $insert=$db->prepare('INSERT INTO clawpilot_email_identities VALUES(?,?,?,?,?,?,?)');
    for($i=0;$i<$count;$i++){
        $id=sprintf('00000000-0000-4000-8000-%012d',$i);$legacy=$count>1&&$i===$count-1;
        $pipeline=$legacy?'legacy':'managed';$json=$legacy?null:json_encode($matrix,JSON_PRETTY_PRINT|JSON_THROW_ON_ERROR);
        $values=[$id,'gi'.(1234567+$i),'local-'.$i,$pipeline,'workspace',(string)($i%2),$json];
        $insert->bind_param('sssssss',...$values);$insert->execute();
        $entries[]=['emailId'=>$id,'pipelineId'=>$pipeline,'before'=>$matrix,'after'=>$after];
        if(!$legacy&&$i%2===0){$statement=$db->prepare('INSERT INTO clawpilot_email_write_permissions VALUES(?,?,?,?,?,?)');
            $values=[$id,$pipeline,$json,'publication',str_repeat('c',64),str_repeat('d',64)];
            $statement->bind_param('ssssss',...$values);$statement->execute();$statement->close();}
    }$insert->close();
    $identities=batchRows($db,'clawpilot_email_identities','email_id');
    $bindings=[];foreach(['managed','legacy'] as $pipeline)$bindings[]=['before'=>['pipeline_id'=>$pipeline,
        'capability_policy_json'=>$pipeline==='managed'?'{}':null,'readers_json'=>'[]'],
        'after'=>['pipeline_id'=>$pipeline,'readers_json'=>'[]']];
    $command=['operationId'=>str_repeat('f',64),'bindings'=>$bindings,'capabilities'=>$entries];
    batchRun($db,function()use($db,$service,$write,$command,$identities,$after):void{
        $write->invoke($service,$command,$identities);
        ClawPilotNativeEmailWriteScope::authority($db,$command,$identities);
        foreach(batchRows($db,'clawpilot_email_identities','email_id') as $row){
            if($row['pipeline_id']==='legacy'){batchNeed($row['capabilities_json']===null,'Legacy null matrix must remain unchanged');continue;}
            batchNeed($row['capabilities_json']===ClawPilotNativeEmailAuthorityContract::canonical($after),'Every selected identity must have exact after bytes');
        }
        foreach(batchRows($db,'clawpilot_email_write_permissions','email_id') as $row)
            batchNeed($row['source_kind']==='authority'&&$row['operation_id']===$command['operationId']
                &&$row['command_hash']===ClawPilotNativeEmailAuthorityContract::digest($command),'Every upsert retains exact complete command evidence');
    });$checks++;
    if($count>=51){
        batchRun($db,function()use($db,$service,$write,$command,$identities):void{
            $forged=$identities;$last=count($forged)-2;$forged[$last]['capabilities_json'].=' ';
            $held=false;try{$write->invoke($service,$command,$forged);}catch(ClawPilotNativeEmailTransactionRefused $error){
                $held=$error->holdCode==='authority_write_not_confirmed';}
            batchNeed($held,'Late exact-byte CAS mismatch must hold, even after earlier batches were written');
        });$checks++;
        batchRun($db,function()use($db,$command,$identities):void{
            $last=count($identities)-2;$id=$identities[$last]['email_id'];
            $statement=$db->prepare("INSERT INTO clawpilot_email_write_permissions VALUES(?,'managed','{}','publication',?,?)
                ON DUPLICATE KEY UPDATE capabilities_json='{}'");$a=str_repeat('a',64);$statement->bind_param('sss',$id,$a,$a);$statement->execute();$statement->close();
            $held=false;try{ClawPilotNativeEmailWriteScope::authority($db,$command,$identities);}
            catch(ClawPilotNativeEmailTransactionRefused $error){$held=$error->holdCode==='write_scope_preimage';}
            batchNeed($held,'Corrupt independent permission preimage must refuse before batch upserts');
        });$checks++;
    }
}
foreach(['clawpilot_email_write_permissions','clawpilot_email_identities','clawpilot_email_write_scopes'] as $table)$db->query('DELETE FROM '.$table);
batchRun($db,function()use($db,&$checks):void{
    $before=['view'=>[],'list'=>[],'export'=>[],'edit'=>[],'delete'=>[]];
    $after=$before;foreach(['view','list','export'] as $surface)$after[$surface]=['reader'];
    $db->query("INSERT INTO clawpilot_email_identities VALUES('new-root-email','gi1234567','local-root','new-root','workspace','1',NULL)");
    $identities=batchRows($db,'clawpilot_email_identities','email_id');
    $command=['operationId'=>str_repeat('e',64),'bindings'=>[['before'=>['pipeline_id'=>'new-root','readers_json'=>'[]'],
        'after'=>['pipeline_id'=>'new-root','readers_json'=>json_encode(['reader'],JSON_THROW_ON_ERROR),'capability_policy_json'=>'{}']]],
        'capabilities'=>[['emailId'=>'new-root-email','pipelineId'=>'new-root','before'=>$before,'after'=>$after]]];
    $GLOBALS['sugar_config']['clawpilot_managed_email_write_scope']=false;
    try{
        $held=false;try{ClawPilotNativeEmailWriteScope::authority($db,$command,$identities);}
        catch(ClawPilotNativeEmailTransactionRefused $error){$held=$error->holdCode==='managed_write_scope_not_enabled';}
        batchNeed($held,'Generic new reader must hold if exact managed writer scope is disabled');
        batchNeed(batchRows($db,'clawpilot_email_write_scopes','pipeline_id')===[],'Refused grant must not enroll a scope');$checks++;
    }finally{$GLOBALS['sugar_config']['clawpilot_managed_email_write_scope']=true;}
    ClawPilotNativeEmailWriteScope::authority($db,$command,$identities);
    $scopes=batchRows($db,'clawpilot_email_write_scopes','pipeline_id');
    batchNeed(count($scopes)===1&&$scopes[0]['pipeline_id']==='new-root','New root reader without role or identity arrays must enroll exact scope');
    $rows=batchRows($db,'clawpilot_email_write_permissions','email_id');
    batchNeed(count($rows)===1&&$rows[0]['capabilities_json']===ClawPilotNativeEmailAuthorityContract::canonical($after),
        'Generic new reader receives exact reads and no write capability');$checks++;
});
fwrite(STDOUT,'NATIVE_WRITE_BATCH_SQL_PASSED=checks='.$checks.'; actual MariaDB, exact production DDL/helpers; every mutation rolled back; not ACL or production proof.'."\n");
