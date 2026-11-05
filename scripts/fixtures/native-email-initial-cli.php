<?php
declare(strict_types=1);
// Pure guards only. No SuiteCRM bootstrap, native SQL, receipt or install.
require_once __DIR__.'/../../services/suitecrm/native-email-initial-cli.php';
$checks=0;
function initialCliPureNeed(bool $value,string $message): void {if(!$value)throw new RuntimeException($message);}
function initialCliPureReject(callable $run,string $message): void {try{$run();}catch(Throwable $error){return;}throw new RuntimeException($message);}
$check=static function(string $name,callable $run)use(&$checks):void{$run();$checks++;fwrite(STDOUT,'PASS '.$name."\n");};
$op=str_repeat('a',64);$artifact=str_repeat('b',64);$plan=str_repeat('c',64);
$source=['--operation='.$op,'--artifact-sha256='.$artifact,'--quiescent'];
$check('default is source inspection and mutations require separate exact operation approval',static function()use($source,$op,$artifact,$plan):void{
    $parsed=cp_initial_cli_options($source);initialCliPureNeed($parsed['action']==='inspect-source'&&$parsed['approve-operation']===null,'Read-only default required');
    foreach(['execute','cancel-expired'] as $action){$args=array_merge([$action],$source,['--plan-sha256='.$plan]);
        initialCliPureReject(static fn()=>cp_initial_cli_options($args),'Mutations without separate approval must hold');
        initialCliPureNeed(cp_initial_cli_options(array_merge($args,['--approve-operation='.$op]))['action']===$action,'Explicit exact mutation selection required');}
    initialCliPureReject(static fn()=>cp_initial_cli_options(['execute','--operation='.$op,'--artifact-sha256='.$artifact,'--plan-sha256='.$plan,
        '--approve-operation='.$op]),'Quiescence must be explicit');
    foreach(['project','prepare'] as $action){$args=array_merge([$action],$source,['--plan-sha256='.$plan,'--with-installation-proof']);
        initialCliPureNeed(cp_initial_cli_options($args)['with-installation-proof']===true,'Only preparation may request the verified journal response');
        initialCliPureReject(static fn()=>cp_initial_cli_options(array_merge($args,['--with-installation-proof'])),'Duplicate proof selection must hold');}
    foreach(['inspect-source','execute','resolve','cancel-expired'] as $action){$args=array_merge([$action],$source,['--with-installation-proof']);
        if($action!=='inspect-source')$args[]='--plan-sha256='.$plan;
        if(in_array($action,['execute','cancel-expired'],true))$args[]='--approve-operation='.$op;
        initialCliPureReject(static fn()=>cp_initial_cli_options($args),'Proof wrapper must not change source or execution/terminal wire');}
});
$check('duplicate unknown arbitrary paths keys and self-asserted verified flags are not CLI inputs',static function()use($source,$plan):void{
    foreach(['--app-root=/tmp/other','--state-root=/tmp/other','--key=caller-key','--verified=true','--installation=true','--installation-journal-sha256='.str_repeat('f',64),
        '--quiescent','--operation='.str_repeat('d',64),'--artifact-sha256='.str_repeat('e',64),'--plan-sha256='.$plan] as $arg)
        initialCliPureReject(static fn()=>cp_initial_cli_options(array_merge($source,[$arg])),'Unknown/conflicting source input must hold');
    initialCliPureReject(static fn()=>cp_initial_cli_options(array_merge($source,['prepare','resolve','--plan-sha256='.$plan])),'Conflicting action must hold');
    initialCliPureNeed(CP_INITIAL_CLI_APP==='/var/lib/suitecrm/app'&&CP_INITIAL_CLI_STATE==='/var/lib/suitecrm/clawpilot-native-email-initial-enrollment-v1','Fixed roots required');
});
$check('canonical source bytes are deterministic and the source artifact includes its exact newline',static function():void{
    $a=['version'=>1,'purpose'=>'clawpilot-native-email-initial-source','defaults'=>[],'emails'=>[['globalId'=>'gi1000000']],
        'nativeRuntimeFingerprint'=>str_repeat('0',64),'nativePolicyFingerprint'=>str_repeat('1',64),'principalSuiteCrmUserIds'=>['1']];
    initialCliPureNeed(cp_initial_cli_canonical($a)===cp_initial_cli_canonical(array_reverse($a,true)),'Canonical order required');
    initialCliPureNeed(hash('sha256',cp_initial_cli_canonical($a)."\n")!==hash('sha256',cp_initial_cli_canonical($a)),'Exact source artifact bytes, not object-only hash');
    initialCliPureNeed(cp_initial_cli_canonical(['paths'=>['public/legacy/config_override.php'=>'x'],'list'=>[]])===
        '{"list":[],"paths":{"public/legacy/config_override.php":"x"}}','Private file artifacts have a separate canonical grammar from native wire plans');
});
$check('protected file guard refuses links modes oversized input and preserves exact bytes',static function():void{
    initialCliPureNeed(PHP_OS_FAMILY==='Linux'&&posix_geteuid()===0,'Run filesystem guard fixture as isolated Linux root');
    $root=sys_get_temp_dir().'/clawpilot-initial-cli-pure-'.bin2hex(random_bytes(12));initialCliPureNeed(mkdir($root,0700),'Exclusive fixture directory required');
    $path=$root.'/input.json';$link=$root.'/linked.json';$hard=$root.'/hard.json';
    try{$bytes="{\"syntheticOnly\":true}\n";initialCliPureNeed(file_put_contents($path,$bytes)===strlen($bytes)&&chmod($path,0600),'Private fixture input required');
        initialCliPureNeed(cp_initial_cli_protected_file($path,1024)['bytes']===$bytes,'Exact bytes required');
        initialCliPureNeed(symlink($path,$link),'Synthetic symlink required');initialCliPureReject(static fn()=>cp_initial_cli_protected_file($link,1024),'Symlink must hold');unlink($link);
        initialCliPureNeed(link($path,$hard),'Synthetic hardlink required');initialCliPureReject(static fn()=>cp_initial_cli_protected_file($path,1024),'Hardlink must hold');unlink($hard);
        chmod($path,0640);initialCliPureReject(static fn()=>cp_initial_cli_protected_file($path,1024),'Non-0600 file must hold');chmod($path,0600);
        initialCliPureReject(static fn()=>cp_initial_cli_protected_file($path,1),'Oversized input must hold');
    }finally{foreach([$link,$hard,$path] as $file)if(is_link($file)||file_exists($file))unlink($file);rmdir($root);}
});
$check('dedicated native identity and pinned RSA public key have no general-client fallback',static function():void{
    $artifact=['nativeInstanceId'=>'initial-cli-synthetic','serviceUserId'=>'1','oauthClientId'=>'synthetic-dedicated-client'];
    $env=['SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID','SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID','SUITECRM_NATIVE_AUTHORITY_CLIENT_ID',
        'SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID','SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY','SUITECRM_CLIENT_ID'];$original=[];
    foreach($env as $key)$original[$key]=getenv($key);
    try{$key=openssl_pkey_new(['private_key_bits'=>3072,'private_key_type'=>OPENSSL_KEYTYPE_RSA]);$details=openssl_pkey_get_details($key);
        putenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID='.$artifact['nativeInstanceId']);putenv('SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID=1');
        putenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='.$artifact['oauthClientId']);putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID=synthetic-cli-key');
        putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='.$details['key']);cp_initial_cli_identity($artifact);
        putenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID');putenv('SUITECRM_CLIENT_ID='.$artifact['oauthClientId']);
        initialCliPureReject(static fn()=>cp_initial_cli_identity($artifact),'General-client fallback must not work');
        putenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='.$artifact['oauthClientId']);$weak=openssl_pkey_new(['private_key_bits'=>2048,'private_key_type'=>OPENSSL_KEYTYPE_RSA]);
        putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='.openssl_pkey_get_details($weak)['key']);
        initialCliPureReject(static fn()=>cp_initial_cli_identity($artifact),'Weak public key must hold');
    }finally{foreach($original as $key=>$value)putenv($value===false?$key:$key.'='.$value);}
});
fwrite(STDOUT,'NATIVE_INITIAL_CLI_PURE_PASSED='.$checks."\nBOUNDARY: pure parser/filesystem/key guards only; no cold SuiteCRM bootstrap, cache/DB nonmutation, native execution or PG proof\n");
