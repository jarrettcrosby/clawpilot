<?php
declare(strict_types=1);
// Offline runtime FILE package only. No bootstrap, SQL, config, keys or flags.
// The default check creates no state. Native/PG initial enrollment is separate.
require_once __DIR__.'/install-native-email-scope.php';

const CP_RUNTIME_PACKAGE = 'clawpilot-native-email-runtime-v1';
const CP_RUNTIME_ROUTE_BLOCK = "\n// BEGIN ClawPilot native Email runtime routes v1\nrequire_once 'custom/include/ClawPilot/publication-routes.php';\nrequire_once 'custom/include/ClawPilot/authority-routes.php';\n// END ClawPilot native Email runtime routes v1\n";
const CP_RUNTIME_LIFECYCLE_BLOCK = "\n// BEGIN ClawPilot record lifecycle route v1\nrequire_once 'custom/include/ClawPilot/record-lifecycle-routes.php';\n// END ClawPilot record lifecycle route v1\n";

function cp_runtime_targets(): array
{
    $files=[];
    foreach (['EmailAudience','NativeEmailAuthorityContract','NativeEmailAuthorityDelta','NativeEmailAuthorityProof',
        'NativeEmailAuthorityTransition','NativeEmailCapabilityContract','NativeEmailIdentityLink','NativeEmailProjection',
        'NativeEmailRuntime','NativeEmailTransaction','NativeEmailWriteScope','NativeEmailPublisher',
        'NativeEmailInitialPolicyDelta','NativeEmailInitialInstallationLineage','NativeEmailInitialEnrollment'] as $name) {
        $files['email-audience/'.$name.'.php']='custom/include/ClawPilot/'.$name.'.php';
    }
    foreach (['publication-routes.php','authority-routes.php','publication-schema.sql','authority-transition-schema.sql',
        'initial-enrollment-schema.sql'] as $name) $files['email-audience/'.$name]='custom/include/ClawPilot/'.$name;
    $files['native-email-scope/Patch.php']='custom/include/native-email-scope/Patch.php';
    $files['record-lifecycle/RecordLifecycle.php']='custom/include/ClawPilot/RecordLifecycle.php';
    $files['record-lifecycle/routes.php']='custom/include/ClawPilot/record-lifecycle-routes.php';
    return $files;
}

/** Missing ordinary parents are admitted for read-only inspection, not created. */
function cp_runtime_path(string $root,string $relative): string
{
    cp_scope_path($root);
    cp_scope_require(is_dir($root) && preg_match('~^[A-Za-z0-9_./-]+$~D',$relative)===1
        && !str_starts_with($relative,'/') && preg_match('~(?:^|/)(?:\.|\.\.|)(?:/|$)~',$relative)!==1,'Invalid runtime package path');
    $path=$root;$parts=explode('/',$relative);
    foreach($parts as $index=>$part){$path.='/'.$part;clearstatcache(true,$path);
        cp_scope_require(!is_link($path),'Symlinked runtime package path');
        if(file_exists($path)&&$index<count($parts)-1)cp_scope_require(is_dir($path),'Runtime parent is not a directory');}
    return $path;
}
function cp_runtime_snapshot(string $root,string $relative): ?array
{
    $path=cp_runtime_path($root,$relative);
    return file_exists($path)?cp_scope_snapshot($path):null;
}
function cp_runtime_context(string $appRoot,string $stateRoot,string $sourceRoot=__DIR__): array
{
    cp_scope_path($appRoot);cp_scope_path($sourceRoot);cp_scope_path($stateRoot,true);
    cp_scope_require(is_dir($appRoot) && is_dir($sourceRoot)
        && !str_starts_with($stateRoot.'/',$appRoot.'/') && !str_starts_with($appRoot.'/',$stateRoot.'/'),
        'Protected runtime state must be outside the application tree');
    cp_scope_require(cp_scope_snapshot($appRoot.'/VERSION')!==null
        &&trim((string)file_get_contents($appRoot.'/VERSION'))==='8.10.1','Exact SuiteCRM 8.10.1 required');
    $legacy=$appRoot.'/public/legacy';cp_scope_path($legacy);
    $outputs=[];$sources=[];
    foreach(cp_runtime_targets() as $source=>$target){
        $path=cp_runtime_path($sourceRoot,$source);$stat=cp_scope_snapshot($path);
        cp_scope_require($stat!==null,'Runtime package source is missing');
        $bytes=(string)file_get_contents($path);
        if(str_ends_with($source,'.php'))token_get_all($bytes,TOKEN_PARSE);
        $outputs[$target]=$bytes;$sources[$source]=$stat['sha256'];
    }
    $basePath=cp_runtime_path($sourceRoot,'email-audience/routes.php');
    cp_scope_require(cp_scope_snapshot($basePath)!==null,'Managed audience router source is missing');
    $base=(string)file_get_contents($basePath);token_get_all($base,TOKEN_PARSE);
    $sources['email-audience/routes.php']=hash('sha256',$base);
    $route='custom/application/Ext/Api/V8/Config/routes.php';$current=cp_runtime_snapshot($legacy,$route);
    $currentBytes=$current===null?null:(string)file_get_contents($legacy.'/'.$route);
    $lifecycle=$currentBytes!==null&&str_ends_with($currentBytes,CP_RUNTIME_LIFECYCLE_BLOCK);
    // An existing lifecycle route is retained even if its feature flag is off.
    // A newly enabled opt-in is part of the approved package hash, never inferred.
    $lifecycle=$lifecycle||getenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED')==='1';
    $outputs[$route]=$base.CP_RUNTIME_ROUTE_BLOCK.($lifecycle?CP_RUNTIME_LIFECYCLE_BLOCK:'');
    token_get_all($outputs[$route],TOKEN_PARSE);
    $hashes=array_map(static fn(string $bytes):string=>hash('sha256',$bytes),$outputs);
    $packageHash=hash('sha256',json_encode([CP_RUNTIME_PACKAGE,$sources,$hashes],JSON_THROW_ON_ERROR));
    return compact('appRoot','legacy','stateRoot','outputs','sources','hashes','packageHash','base','route','lifecycle');
}
function cp_runtime_load(array $c): ?array
{
    if(!file_exists($c['stateRoot']))return null;
    cp_scope_protected_directory($c['stateRoot'],false);
    $path=$c['stateRoot'].'/manifest.json';$stat=cp_scope_snapshot($path);
    cp_scope_require($stat!==null&&$stat['uid']===0&&$stat['mode']===0600&&$stat['size']<=131072,
        'Unjournaled or unprotected runtime package state requires review');
    $m=json_decode((string)file_get_contents($path),true,32,JSON_THROW_ON_ERROR);
    cp_scope_require(is_array($m)&&array_keys($m)===['version','package','packageHash','appRoot','installId','phase','files']
        &&$m['version']===1&&$m['package']===CP_RUNTIME_PACKAGE&&$m['packageHash']===$c['packageHash']&&$m['appRoot']===$c['appRoot']
        &&preg_match('/^[a-f0-9]{64}$/D',$m['installId']??'')===1&&in_array($m['phase'],['prepared','applying','applied'],true)
        &&array_keys($m['files']??[])===array_keys($c['outputs']),'Runtime package journal/source identity changed');
    cp_scope_protected_directory($c['stateRoot'].'/originals',false);
    cp_scope_protected_directory($c['stateRoot'].'/staged',false);
    $index=0;
    foreach($m['files'] as $relative=>$row){
        cp_scope_require(array_keys($row)===['before','after']&&is_array($row['after'])
            &&($row['after']['sha256']??null)===$c['hashes'][$relative],'Runtime package manifest output changed');
        foreach([$row['before'],$row['after']] as $meta)if($meta!==null){
            cp_scope_require(is_array($meta)&&array_keys($meta)===['sha256','size','mode','uid','gid','mtime']
                &&preg_match('/^[a-f0-9]{64}$/D',$meta['sha256']??'')===1,'Runtime metadata identity changed');
            foreach(['size','mode','uid','gid','mtime'] as $field)cp_scope_require(is_int($meta[$field]??null)&&$meta[$field]>=0,'Invalid runtime metadata');
            cp_scope_require($meta['size']<=4194304&&$meta['mode']<=0777,'Unbounded runtime metadata');
        }
        if($row['before']!==null){$backup=cp_scope_snapshot($c['stateRoot'].'/originals/'.$index.'.bin');
            cp_scope_require($backup!==null&&$backup['uid']===0&&$backup['mode']===0600
                &&$backup['sha256']===$row['before']['sha256']&&$backup['size']===$row['before']['size'],
                'Exact retained runtime original changed');}
        $index++;
    }
    return $m;
}
function cp_runtime_states(array $c,array $m): array
{
    $states=[];
    foreach($m['files'] as $relative=>$row){$actual=cp_runtime_snapshot($c['legacy'],$relative);
        if(cp_scope_matches($actual,$row['after'],true))$states[$relative]='after';
        elseif(cp_scope_matches($actual,$row['before'],true))$states[$relative]='before';
        else throw new RuntimeException('Runtime package file drift requires review');}
    return $states;
}
function cp_runtime_check(array $c): array
{
    $m=cp_runtime_load($c);
    if($m!==null){$states=cp_runtime_states($c,$m);
        $status=$m['phase']==='applied'&&array_values(array_unique($states))===['after']?'applied':'recovery-required';
        return ['package'=>CP_RUNTIME_PACKAGE,'packageHash'=>$c['packageHash'],'status'=>$status,'installId'=>$m['installId'],'files'=>$states];}
    $preimages=[];
    foreach($c['outputs'] as $relative=>$bytes){$stat=cp_runtime_snapshot($c['legacy'],$relative);$preimages[$relative]=$stat;if($stat===null)continue;
        $current=(string)file_get_contents($c['legacy'].'/'.$relative);
        if($relative===$c['route'])cp_scope_require(in_array($current,[$c['base'],$c['base'].CP_RUNTIME_LIFECYCLE_BLOCK],true),
            'Unjournaled runtime or unmanaged aggregate router requires review');
        else cp_scope_require(hash('sha256',$current)===$c['hashes'][$relative],'Existing runtime helper differs from reviewed source');}
    return ['package'=>CP_RUNTIME_PACKAGE,'packageHash'=>$c['packageHash'],'status'=>'ready','fileCount'=>count($c['outputs']),'preimages'=>$preimages];
}
function cp_runtime_parent(array $c,string $relative): void
{
    $parts=explode('/',dirname($relative));$walk='';
    foreach($parts as $part){$walk.=($walk===''?'':'/').$part;$path=cp_runtime_path($c['legacy'],$walk);
        if(!file_exists($path))cp_scope_require(mkdir($path,0755),'Cannot create runtime helper directory');
        cp_scope_require(is_dir($path)&&!is_link($path),'Runtime helper parent changed');}
}
/** afterReplace is local failure injection only, not exposed through the CLI. */
function cp_runtime_apply(array $c,bool $quiescent,string $approval,?callable $afterReplace=null): array
{
    cp_scope_quiescent($quiescent);
    cp_scope_require(hash_equals($c['packageHash'],$approval),'Exact independently reviewed package approval required');
    $check=cp_runtime_check($c);if($check['status']==='applied')return $check;
    cp_scope_require($check['status']==='ready','Interrupted package requires explicit recovery');
    cp_scope_protected_directory($c['stateRoot'],true);
    cp_scope_require(stat($c['stateRoot'])['dev']===stat($c['legacy'])['dev'],'Runtime staging must share the application filesystem');
    $lock=fopen($c['stateRoot'].'/lock','x+b');cp_scope_require(is_resource($lock)&&chmod($c['stateRoot'].'/lock',0600)&&flock($lock,LOCK_EX|LOCK_NB),'Runtime package already locked');
    try{
        cp_scope_protected_directory($c['stateRoot'].'/originals',true);cp_scope_protected_directory($c['stateRoot'].'/staged',true);
        $files=[];$index=0;
        foreach($c['outputs'] as $relative=>$bytes){$before=cp_runtime_snapshot($c['legacy'],$relative);
            cp_scope_require(cp_scope_matches($before,$check['preimages'][$relative],true),'Runtime input changed after approval check');
            if($before!==null){$original=(string)file_get_contents($c['legacy'].'/'.$relative);
                cp_scope_require(hash('sha256',$original)===$before['sha256'],'Runtime original changed while reading');
                cp_scope_write($c['stateRoot'].'/originals/'.$index.'.bin',$original);}
            $after=$before??['sha256'=>'','size'=>0,'mode'=>0644,'uid'=>0,'gid'=>0,'mtime'=>time()];
            $after['sha256']=$c['hashes'][$relative];$after['size']=strlen($bytes);
            cp_scope_write($c['stateRoot'].'/staged/'.$index.'.bin',$bytes,$after);
            $files[$relative]=['before'=>$before,'after'=>$after];$index++;
        }
        cp_scope_sync_directory($c['stateRoot'].'/originals');cp_scope_sync_directory($c['stateRoot'].'/staged');
        $m=['version'=>1,'package'=>CP_RUNTIME_PACKAGE,'packageHash'=>$c['packageHash'],'appRoot'=>$c['appRoot'],
            'installId'=>bin2hex(random_bytes(32)),'phase'=>'prepared','files'=>$files];
        cp_scope_journal($c['stateRoot'],$m);
        return cp_runtime_replace($c,$m,$quiescent,$afterReplace);
    }finally{flock($lock,LOCK_UN);fclose($lock);}
}
function cp_runtime_replace(array $c,array $m,bool $quiescent,?callable $afterReplace): array
{
    cp_scope_quiescent($quiescent);$states=cp_runtime_states($c,$m);
    $index=0;
    foreach($m['files'] as $relative=>$row){if($states[$relative]==='before'){
        $stage=cp_scope_snapshot($c['stateRoot'].'/staged/'.$index.'.bin');
        cp_scope_require(cp_scope_matches($stage,$row['after'],true),'Staged runtime bytes or metadata changed');}
        $index++;}
    $m['phase']='applying';cp_scope_journal($c['stateRoot'],$m);$index=0;$replaced=0;
    // Aggregate router is last. Maintenance/quiescence is required regardless.
    foreach($m['files'] as $relative=>$row){if($states[$relative]==='before'){
        cp_runtime_parent($c,$relative);$target=cp_runtime_path($c['legacy'],$relative);
        cp_scope_require(cp_scope_matches(cp_runtime_snapshot($c['legacy'],$relative),$row['before'],true),'Runtime file changed before replacement');
        cp_scope_require(rename($c['stateRoot'].'/staged/'.$index.'.bin',$target),'Cannot publish runtime helper');
        cp_scope_sync_directory(dirname($target));
        cp_scope_require(cp_scope_matches(cp_runtime_snapshot($c['legacy'],$relative),$row['after'],true),'Runtime helper readback failed');
        $replaced++;if($afterReplace!==null)$afterReplace($replaced);}
        $index++;}
    cp_scope_require(array_values(array_unique(cp_runtime_states($c,$m)))===['after'],'Incomplete runtime package');
    $m['phase']='applied';cp_scope_journal($c['stateRoot'],$m);return cp_runtime_check($c);
}
function cp_runtime_recover(array $c,bool $quiescent,string $approval,string $installId): array
{
    cp_scope_quiescent($quiescent);
    cp_scope_require(hash_equals($c['packageHash'],$approval),'Exact package approval required');
    $m=cp_runtime_load($c);cp_scope_require($m!==null&&hash_equals($m['installId'],$installId),'Exact retained install identity required');
    if($m['phase']==='applied')return cp_runtime_check($c);
    $lockPath=$c['stateRoot'].'/lock';$stat=cp_scope_snapshot($lockPath);
    cp_scope_require($stat!==null&&$stat['uid']===0&&$stat['mode']===0600,'Unprotected runtime lock');
    $lock=fopen($lockPath,'r+b');cp_scope_require(is_resource($lock)&&flock($lock,LOCK_EX|LOCK_NB),'Runtime recovery already locked');
    try{$m=cp_runtime_load($c);cp_scope_require($m!==null&&hash_equals($m['installId'],$installId),'Runtime journal changed under recovery lock');
        if($m['phase']==='applied')return cp_runtime_check($c);
        return cp_runtime_replace($c,$m,$quiescent,null);}finally{flock($lock,LOCK_UN);fclose($lock);}
}

if(PHP_SAPI==='cli'&&realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    try{$op='check';$appRoot='/var/lib/suitecrm/app';$stateRoot='/var/lib/suitecrm/clawpilot-native-email-runtime-v1';
        $approval='';$install='';$quiescent=false;$seen=[];
        foreach(array_slice($argv,1) as $arg){$key=explode('=',$arg,2)[0];if(in_array($arg,['check','apply','recover'],true))$key='operation';
            cp_scope_require(!isset($seen[$key]),'Duplicate runtime installer argument');$seen[$key]=true;
            if($key==='operation')$op=$arg;elseif($arg==='--quiescent')$quiescent=true;
            elseif(str_starts_with($arg,'--app-root='))$appRoot=substr($arg,11);
            elseif(str_starts_with($arg,'--state-root='))$stateRoot=substr($arg,13);
            elseif(str_starts_with($arg,'--approve-package='))$approval=substr($arg,18);
            elseif(str_starts_with($arg,'--approve-install='))$install=substr($arg,18);
            else throw new RuntimeException('Unknown runtime installer argument');}
        cp_scope_require($op==='recover'||$install==='','Install approval is recovery-only');
        cp_scope_require($op!=='check'||(!$quiescent&&$approval===''),'Read-only check takes no mutation approval');
        $c=cp_runtime_context($appRoot,$stateRoot);
        $result=match($op){'apply'=>cp_runtime_apply($c,$quiescent,$approval),'recover'=>cp_runtime_recover($c,$quiescent,$approval,$install),default=>cp_runtime_check($c)};
        fwrite(STDOUT,json_encode($result,JSON_THROW_ON_ERROR|JSON_UNESCAPED_SLASHES)."\n");exit($result['status']==='recovery-required'?2:0);
    }catch(Throwable $e){fwrite(STDERR,'Native Email runtime package held: '.$e->getMessage()."\n");exit(1);}
}
