<?php
declare(strict_types=1);

// Disposable fixture only. Two real PHP processes, two real native DBManager
// connections, and an external row lock force actual overlap. No publisher
// test hook, provider request, application route or production mutation.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1') throw new RuntimeException('Opt-in disposable fixture required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/source/email-audience/NativeEmailPublisher.php';

function raceInput(): array
{
    $path='/tmp/native-publisher-race.json';
    must(is_file($path) && !is_link($path) && (fileperms($path)&0777)===0600 && filesize($path)<=650000,'Private bounded synthetic handoff required');
    $input=json_decode((string)file_get_contents($path),true,48,JSON_THROW_ON_ERROR);
    must(is_array($input) && array_keys($input)===['command','profile','callerId','readers'],'Exact synthetic race handoff required');
    $command=$input['command'];
    must(is_array($command) && ($command['mode']??null)==='publish' && ($command['globalId']??null)==='gi8800005'
        && ($command['expectedRecordFingerprint']??null)===null && is_string($input['callerId']) && is_array($input['readers']),
        'Only the designated new synthetic Email may race');
    must($input['profile']===['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'],'Pinned native profile required');
    return $input;
}
function raceWrite(string $path,array $value): void
{
    $json=json_encode($value,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
    must(strlen($json)<=900000,'Bounded synthetic result required');
    must(file_put_contents($path.'.tmp',$json,LOCK_EX)===strlen($json) && chmod($path.'.tmp',0600) && rename($path.'.tmp',$path),
        'Private atomic fixture result required');
}
function raceRead(string $path): array
{
    must(is_file($path) && !is_link($path) && filesize($path)<=900000,'Bounded synthetic result required');
    $result=json_decode((string)file_get_contents($path),true,48,JSON_THROW_ON_ERROR);
    must(is_array($result),'Synthetic object required');
    return $result;
}
function raceRows(mysqli $db,string $sql): array
{
    $result=$db->query($sql); must($result instanceof mysqli_result,'Native result required');
    try{return $result->fetch_all(MYSQLI_ASSOC);}finally{$result->free();}
}
function raceQ(mysqli $db,string $value): string{return "'".$db->real_escape_string($value)."'";}
function raceSnapshot(mysqli $db,array $profile,string $id): array
{
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
    try{return ClawPilotNativeEmailProjection::snapshot($db,$tx,$id);}finally{$tx->rollback();}
}

(static function () use ($argv): void {
if (($argv[1]??'')==='--worker') {
    $mode=$argv[2]??''; $directory=$argv[3]??'';
    try {
        must(in_array($mode,['publish','resolve'],true) && preg_match('#^/tmp/clawpilot-native-race-[a-f0-9]{24}$#D',$directory)===1
            && is_dir($directory) && !is_link($directory),'Exact owned synthetic worker required');
        umask(0077); $_REQUEST=[]; $input=raceInput();
        $admin=fresh('Users',$input['callerId']); must($admin->isAdmin() && $admin->status==='Active','Fixture caller must remain admin');
        selectUser($admin);
        $db=DBManagerFactory::getInstance()->database;
        must($db instanceof mysqli,'Actual native connection required');
        if (session_status()===PHP_SESSION_ACTIVE) session_write_close();
        $barrier=fopen($directory.'/start.lock','rb'); must(is_resource($barrier),'Owned fixture barrier required');
        raceWrite($directory.'/ready-'.$mode.'.json',['connectionId'=>$db->thread_id,'pid'=>getmypid()]);
        must(flock($barrier,LOCK_SH),'Worker start signal required');
        flock($barrier,LOCK_UN); fclose($barrier);
        $publisher=new ClawPilotNativeEmailPublisher($db,$input['profile'],$input['callerId']);
        $result=$mode==='publish'?$publisher->publish($input['command']):$publisher->resolveOrCancel($input['command']);
        raceWrite($directory.'/result-'.$mode.'.json',$result);
        exit(0);
    } catch(Throwable $error) {
        // No raw SQL, policy rows, native secrets or traceback in worker output.
        fwrite(STDERR,'Synthetic race worker failed: '.($error instanceof ClawPilotNativeEmailTransactionRefused?$error->holdCode:get_class($error))."\n");
        exit(1);
    }
}

$directory=null; $barrier=null; $children=[]; $db=null; $holding=false; $failed=false;
try {
    $_REQUEST=[]; $input=raceInput(); $command=$input['command'];
    $admin=fresh('Users',$input['callerId']); selectUser($admin);
    $db=DBManagerFactory::getInstance()->database; must($db instanceof mysqli,'Actual native parent connection required');
    if (session_status()===PHP_SESSION_ACTIVE) session_write_close();
    $idSql=raceQ($db,$command['suiteCrmId']); $opSql=raceQ($db,$command['operationId']);
    must(raceRows($db,'SELECT id FROM emails WHERE id='.$idSql)===[]
        && raceRows($db,'SELECT operation_id FROM clawpilot_email_operations WHERE operation_id='.$opSql)===[],
        'Race may only use a fresh synthetic Email/operation');
    $directory='/tmp/clawpilot-native-race-'.bin2hex(random_bytes(12));
    must(mkdir($directory,0700),'Owned private fixture directory required');
    $barrier=fopen($directory.'/start.lock','x+b');
    must(is_resource($barrier) && chmod($directory.'/start.lock',0600) && flock($barrier,LOCK_EX),'Exclusive start barrier required');
    foreach(['publish','resolve'] as $mode) {
        $pipes=[];
        $process=proc_open([PHP_BINARY,'-d','memory_limit=128M',__FILE__,'--worker',$mode,$directory],
            [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);
        must(is_resource($process),'Independent native PHP worker required');
        fclose($pipes[0]); stream_set_blocking($pipes[1],false); stream_set_blocking($pipes[2],false);
        $children[$mode]=['process'=>$process,'pipes'=>$pipes,'exit'=>null];
    }
    $ready=[]; $deadline=microtime(true)+8.0;
    while(count($ready)!==2 && microtime(true)<$deadline) {
        foreach($children as $mode=>$child) if (!isset($ready[$mode]) && is_file($directory.'/ready-'.$mode.'.json'))
            $ready[$mode]=raceRead($directory.'/ready-'.$mode.'.json');
        if(count($ready)!==2)usleep(10000);
    }
    must(count($ready)===2 && $ready['publish']['connectionId']!==$ready['resolve']['connectionId']
        && $ready['publish']['connectionId']!==$db->thread_id && $ready['resolve']['connectionId']!==$db->thread_id
        && $ready['publish']['pid']!==$ready['resolve']['pid'],'Both independent workers must be ready before release');

    // Hold the first policy index row from OUTSIDE the publisher. Both children
    // must be observed running their actual full policy FOR UPDATE query before
    // releasing this lock. This is not a pair of sequential method calls.
    must($db->begin_transaction(),'External native lock transaction required'); $holding=true;
    must(count(raceRows($db,'SELECT id FROM acl_actions FORCE INDEX (PRIMARY) ORDER BY id LIMIT 1 FOR UPDATE'))===1,'Exact external policy row required');
    must(flock($barrier,LOCK_UN),'Simultaneous start signal required');
    $overlap=false; $deadline=microtime(true)+1.4;
    while(!$overlap && microtime(true)<$deadline) {
        $blocked=[];
        foreach(raceRows($db,'SHOW FULL PROCESSLIST') as $process) {
            foreach($ready as $mode=>$identity) if ((int)$process['Id']===(int)$identity['connectionId']
                && $process['Command']==='Query' && str_contains((string)$process['Info'],'FROM `acl_actions` FORCE INDEX (`PRIMARY`)')
                && str_contains((string)$process['Info'],'FOR UPDATE')) $blocked[$mode]=true;
        }
        $overlap=count($blocked)===2;
        if(!$overlap)usleep(10000);
    }
    must($db->rollback(),'External blocker must release without data changes'); $holding=false;
    must($overlap,'Both actual native transactions must overlap on the held policy row');

    $deadline=microtime(true)+10.0;
    do {
        $running=false;
        foreach($children as &$child) if ($child['exit']===null) {
            $status=proc_get_status($child['process']);
            if($status['running'])$running=true;else $child['exit']=$status['exitcode'];
        }
        unset($child);
        if($running)usleep(10000);
    } while($running && microtime(true)<$deadline);
    must(!$running,'Native race must finish within bounded fixture time');
    foreach($children as $mode=>&$child) {
        $stdout=stream_get_contents($child['pipes'][1],65536);$stderr=stream_get_contents($child['pipes'][2],65536);
        fclose($child['pipes'][1]);fclose($child['pipes'][2]);$child['pipes']=[];
        $exit=proc_close($child['process']);$child['process']=null;
        must(($child['exit']??$exit)===0 && is_file($directory.'/result-'.$mode.'.json'),'Both native racing operations must return a terminal receipt; '.$mode.' '.trim((string)$stderr));
    }
    unset($child);
    $publish=raceRead($directory.'/result-publish.json');$resolve=raceRead($directory.'/result-resolve.json');
    $hash=ClawPilotNativeEmailPublisher::digest($command);
    check('independent native publish and resolve overlap then agree on exactly one terminal outcome',function()use($publish,$resolve,$command,$hash,$db,$opSql):void{
        foreach([$publish,$resolve] as $receipt) must(($receipt['version']??null)===1 && ($receipt['operationId']??null)===$command['operationId']
            && ($receipt['commandHash']??null)===$hash && in_array($receipt['state']??null,['committed','cancelled'],true),'Exact terminal command receipt required');
        must($publish['state']===$resolve['state'] && $publish['result']===$resolve['result']
            && $publish['replayed']!==$resolve['replayed'],'One initial outcome and one identical replay required');
        $rows=raceRows($db,'SELECT * FROM clawpilot_email_operations WHERE operation_id='.$opSql);
        must(count($rows)===1 && $rows[0]['command_hash']===$hash && $rows[0]['state']===$publish['state']
            && $rows[0]['pipeline_id']===$command['pipelineId'] && $rows[0]['email_id']===$command['suiteCrmId'],'Exactly one immutable native operation required');
        $stored=$rows[0]['result_json']===null?null:json_decode($rows[0]['result_json'],true,48,JSON_THROW_ON_ERROR);
        must($stored===$publish['result'],'Durable native receipt must match both process responses');
    });
    check('race winner preserves exact readers/content or cancellation leaves no Email identity or grant',function()use($publish,$input,$command,$db,$idSql):void{
        if($publish['state']==='committed') {
            must($publish['result']['readerSuiteCrmUserIds']===$input['readers'],'Exact native reader enumeration required');
            $snapshot=raceSnapshot($db,$input['profile'],$command['suiteCrmId']);
            must($snapshot['fingerprint']===$publish['result']['recordFingerprint'],'Actual raw native snapshot must match the committed receipt');
            must(count(raceRows($db,'SELECT id FROM emails WHERE id='.$idSql.' AND deleted=0'))===1
                && count(raceRows($db,'SELECT email_id FROM clawpilot_email_identities WHERE email_id='.$idSql))===1
                && count(raceRows($db,"SELECT id FROM securitygroups_records WHERE module='Emails' AND record_id=".$idSql.' AND deleted=0'))===1,
                'Committed race must create exactly one native Email, identity and group link');
        } else {
            must($publish['result']===null,'Cancelled receipt cannot claim projection');
            foreach(['emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c','clawpilot_email_identities'=>'email_id','securitygroups_records'=>'record_id'] as $table=>$column)
                must(raceRows($db,'SELECT * FROM '.$table.' WHERE '.$column.'='.$idSql)===[],'Cancelled race may not leave native content/identity/grant');
        }
    });
    check('post-race retries and conflicting command cannot resurrect duplicate or rewrite outcome',function()use($publish,$input,$command,$db,$opSql):void{
        $publisher=new ClawPilotNativeEmailPublisher($db,$input['profile'],$input['callerId']);
        $before=raceRows($db,'SELECT * FROM clawpilot_email_operations WHERE operation_id='.$opSql);
        foreach([$publisher->publish($command),$publisher->resolveOrCancel($command)] as $again)
            must($again['state']===$publish['state'] && $again['result']===$publish['result'] && $again['replayed']===true,'Terminal race outcome must replay unchanged');
        $changed=$command;$changed['projection']['attributes']['name']='Conflicting synthetic race command';$refused=false;
        try{$publisher->publish($changed);}catch(ClawPilotNativeEmailTransactionRefused $error){$refused=$error->holdCode==='operation_conflict';}
        must($refused && raceRows($db,'SELECT * FROM clawpilot_email_operations WHERE operation_id='.$opSql)===$before,'Conflicting command cannot modify durable race outcome');
    });
    fwrite(STDOUT,'NATIVE_PUBLISHER_RACE_PASSED='.$GLOBALS['checks'].'; outcome='.$publish['state'].'; actual-overlap=2-native-processes' ."\n");
} catch(Throwable $error) {
    fwrite(STDERR,'Native publisher race failed: '.get_class($error).': '.$error->getMessage()."\n");
    $failed=true;
} finally {
    if($holding && $db instanceof mysqli){try{$db->rollback();}catch(Throwable $ignored){}}
    if(is_resource($barrier)){flock($barrier,LOCK_UN);fclose($barrier);}
    foreach($children as $child){
        if(is_resource($child['process'])){proc_terminate($child['process'],9);proc_close($child['process']);}
        foreach($child['pipes'] as $pipe)if(is_resource($pipe))fclose($pipe);
    }
    if(is_string($directory) && preg_match('#^/tmp/clawpilot-native-race-[a-f0-9]{24}$#D',$directory)===1){
        foreach(['start.lock','ready-publish.json','ready-resolve.json','result-publish.json','result-resolve.json'] as $name)
            foreach([$name,$name.'.tmp'] as $file)if(is_file($directory.'/'.$file))unlink($directory.'/'.$file);
        rmdir($directory);
    }
}
if($failed)exit(1);
})();
