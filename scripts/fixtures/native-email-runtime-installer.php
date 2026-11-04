<?php
declare(strict_types=1);
// Disposable Linux/root filesystem only; synthetic PHP/SQL package contents.
if(PHP_SAPI!=='cli'||getenv('CLAWPILOT_RUNTIME_INSTALLER_TEST')!=='1')throw new RuntimeException('Explicit disposable runtime installer fixture required');
require '/source/install-native-email-runtime.php';
require '/source/native-email-startup-check.php';
$checks=0;
function runtime_check(string $name,callable $fn):void{$fn();$GLOBALS['checks']++;fwrite(STDOUT,'PASS '.$name."\n");}
function runtime_refuses(callable $fn,string $message):void{
    try{$fn();}catch(Throwable $e){cp_scope_require(str_contains($e->getMessage(),$message),'Unexpected runtime refusal: '.$e->getMessage());return;}
    throw new RuntimeException('Expected runtime installer refusal');
}
function runtime_tree(bool $lifecycle=true):array{
    $base='/tmp/clawpilot-runtime-installer-'.bin2hex(random_bytes(8));
    cp_scope_require(mkdir($base,0700)&&mkdir($base.'/source',0700)&&mkdir($base.'/app',0700),'Cannot prepare disposable root');
    file_put_contents($base.'/app/VERSION',"8.10.1\n");
    cp_scope_require(mkdir($base.'/app/public/legacy',0755,true),'Cannot prepare legacy root');
    foreach(cp_runtime_targets() as $source=>$target){$path=$base.'/source/'.$source;
        if(!is_dir(dirname($path)))cp_scope_require(mkdir(dirname($path),0755,true),'Cannot prepare source parents');
        file_put_contents($path,str_ends_with($source,'.php')?"<?php\n// Synthetic ".$source."\n":"-- Synthetic ".$source."\n");}
    $router="<?php\n// ClawPilot managed native Email audience proof v1.\n";
    file_put_contents($base.'/source/email-audience/routes.php',$router);
    $route=$base.'/app/public/legacy/custom/application/Ext/Api/V8/Config/routes.php';
    cp_scope_require(mkdir(dirname($route),0755,true),'Cannot prepare router parent');
    file_put_contents($route,$router.($lifecycle?CP_RUNTIME_LIFECYCLE_BLOCK:''));
    return cp_runtime_context($base.'/app',$base.'/protected-runtime',$base.'/source');
}
try{
    putenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED');
    putenv('CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED');putenv('CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED');cp_scope_quiescent(true);
    runtime_check('read-only check creates no state or helper directories and retains both lifecycle choices',function():void{
        foreach([true,false] as $enabled){$c=runtime_tree($enabled);$before=cp_runtime_snapshot($c['legacy'],$c['route']);
            $check=cp_runtime_check($c);cp_scope_require($check['status']==='ready'&&!file_exists($c['stateRoot']),'Check wrote state');
            cp_scope_require(cp_runtime_snapshot($c['legacy'],$c['route'])===$before&&!is_dir($c['legacy'].'/custom/include'),'Read-only check touched application');
            cp_scope_require(str_ends_with($c['outputs'][$c['route']],CP_RUNTIME_LIFECYCLE_BLOCK)===$enabled,'Lifecycle choice lost');}
    });
    runtime_check('mutation requires exact package pin explicit quiescence and no other PHP process',function():void{
        $c=runtime_tree();runtime_refuses(fn()=>cp_runtime_apply($c,false,$c['packageHash']),'explicit --quiescent');
        runtime_refuses(fn()=>cp_runtime_apply($c,true,str_repeat('0',64)),'reviewed package approval');
        $p=proc_open([PHP_BINARY,'-r','fwrite(STDOUT,"ready\\n");fgets(STDIN);'],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);
        cp_scope_require(is_resource($p)&&trim((string)fgets($pipes[1]))==='ready','Other PHP process unavailable');
        try{runtime_refuses(fn()=>cp_runtime_apply($c,true,$c['packageHash']),'still running');}
        finally{fwrite($pipes[0],"exit\n");foreach($pipes as $pipe)fclose($pipe);proc_close($p);}
        cp_scope_require(!file_exists($c['stateRoot']),'Rejected apply created state');
    });
    runtime_check('approved package installs every dependency with router last and retains lifecycle source',function():void{
        $c=runtime_tree();$before=(string)file_get_contents($c['legacy'].'/'.$c['route']);$order=[];
        $result=cp_runtime_apply($c,true,$c['packageHash'],function(int $count)use($c,&$order):void{
            $states=cp_runtime_states($c,cp_runtime_load($c));$order[]=$states[$c['route']];
            if($count<count($c['outputs']))cp_scope_require($states[$c['route']]==='before','Router was exposed before all dependencies');});
        cp_scope_require($result['status']==='applied'&&end($order)==='after','Package did not finish');
        foreach($c['hashes'] as $relative=>$hash)cp_scope_require(hash_file('sha256',$c['legacy'].'/'.$relative)===$hash,'Installed source mismatch');
        cp_scope_require(str_contains($c['outputs'][$c['route']],CP_RUNTIME_ROUTE_BLOCK)&&str_ends_with($c['outputs'][$c['route']],CP_RUNTIME_LIFECYCLE_BLOCK),'Aggregate routes missing');
        cp_scope_require(str_starts_with($before,$c['base']),'Original audience router changed');
        $journal=(string)file_get_contents($c['stateRoot'].'/manifest.json');
        cp_scope_require(cp_runtime_apply($c,true,$c['packageHash'])['status']==='applied'
            &&file_get_contents($c['stateRoot'].'/manifest.json')===$journal,'Idempotent apply rewrote journal');
    });
    runtime_check('interrupted package stays held and exact forward recovery performs no implicit adoption',function():void{
        $c=runtime_tree();runtime_refuses(fn()=>cp_runtime_apply($c,true,$c['packageHash'],static function(int $count):void{if($count===2)throw new RuntimeException('Injected interruption');}),'Injected interruption');
        $m=cp_runtime_load($c);cp_scope_require(cp_runtime_check($c)['status']==='recovery-required','Partial package not held');
        runtime_refuses(fn()=>cp_runtime_apply($c,true,$c['packageHash']),'explicit recovery');
        runtime_refuses(fn()=>cp_runtime_recover($c,true,$c['packageHash'],str_repeat('0',64)),'retained install identity');
        cp_scope_require(cp_runtime_recover($c,true,$c['packageHash'],$m['installId'])['status']==='applied','Exact recovery failed');
        $journal=file_get_contents($c['stateRoot'].'/manifest.json');
        cp_scope_require(cp_runtime_recover($c,true,$c['packageHash'],$m['installId'])['status']==='applied'
            &&file_get_contents($c['stateRoot'].'/manifest.json')===$journal,'Completed recovery rewrote evidence');
    });
    runtime_check('source operator backup metadata router and symlink drift all hold',function():void{
        foreach(['source','operator','backup','stage','router','symlink','version','version-symlink','version-hardlink'] as $case){$c=runtime_tree();
            if(in_array($case,['operator','backup','stage'],true)){
                runtime_refuses(fn()=>cp_runtime_apply($c,true,$c['packageHash'],static function(int $count):void{if($count===1)throw new RuntimeException('Injected interruption');}),'Injected interruption');
                $m=cp_runtime_load($c);
                if($case==='operator')file_put_contents($c['legacy'].'/'.array_key_first($c['outputs']),"<?php // operator\n");
                elseif($case==='backup')file_put_contents($c['stateRoot'].'/originals/'.(count($c['outputs'])-1).'.bin','changed');
                else file_put_contents($c['stateRoot'].'/staged/1.bin','changed');
                runtime_refuses(fn()=>cp_runtime_recover($c,true,$c['packageHash'],$m['installId']),$case==='operator'?'file drift':($case==='backup'?'original changed':'Staged runtime'));
            }else{
                if($case==='source')file_put_contents($c['legacy'].'/custom/application/Ext/Api/V8/Config/routes.php',"<?php // operator router\n");
                elseif($case==='router')file_put_contents($c['legacy'].'/'.$c['route'],$c['outputs'][$c['route']]);
                elseif($case==='symlink')symlink('/tmp',$c['legacy'].'/custom/include');
                elseif($case==='version-symlink'){
                    cp_scope_require(rename($c['appRoot'].'/VERSION',$c['appRoot'].'/VERSION.original')
                        &&symlink($c['appRoot'].'/VERSION.original',$c['appRoot'].'/VERSION'),'Cannot prepare linked version');
                }elseif($case==='version-hardlink')cp_scope_require(link($c['appRoot'].'/VERSION',$c['appRoot'].'/VERSION.link'),'Cannot prepare hard-linked version');
                else file_put_contents($c['appRoot'].'/VERSION',"8.10.2\n");
                runtime_refuses(fn()=>cp_runtime_check(cp_runtime_context($c['appRoot'],$c['stateRoot'],dirname($c['appRoot']).'/source')),
                    in_array($case,['symlink','version-symlink'],true)?'Symlinked':($case==='version-hardlink'?'single-link':($case==='version'?'8.10.1':'router requires review')));
            }
        }
    });
    runtime_check('startup is read-only and blocks incomplete journals initial holds and unverified activation flags',function():void{
        $c=runtime_tree();$base=dirname($c['appRoot']);$source=$base.'/source';
        $check=fn()=>cp_native_email_startup_check($c['appRoot'],$c['stateRoot'],$base.'/scope',$base.'/initial',$source);
        cp_scope_require($check()==='legacy'&&!file_exists($c['stateRoot']),'Legacy check changed state');
        cp_runtime_apply($c,true,$c['packageHash']);
        cp_scope_require($check()==='runtime','Reviewed installed package not recognized');
        foreach(['CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED','CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED'] as $flag){
            putenv($flag.'=1');try{runtime_refuses($check,'verified initial startup release');}finally{putenv($flag);}}
        cp_scope_require(mkdir($base.'/initial',0700),'Cannot create retained initial hold');
        runtime_refuses($check,'verified startup release');
        $d=runtime_tree();$parent=dirname($d['appRoot']);
        runtime_refuses(fn()=>cp_runtime_apply($d,true,$d['packageHash'],static function(int $count):void{if($count===1)throw new RuntimeException('Injected interruption');}),'Injected interruption');
        runtime_refuses(fn()=>cp_native_email_startup_check($d['appRoot'],$d['stateRoot'],$parent.'/scope',$parent.'/initial',$parent.'/source'),'recovery before startup');
    });
    fwrite(STDOUT,'NATIVE_RUNTIME_INSTALLER_PASSED='.$checks."; disposable filesystem only; no native database or production changes\n");
}catch(Throwable $e){fwrite(STDERR,'Native runtime installer fixture failed: '.$e->getMessage()."\n");exit(1);}
