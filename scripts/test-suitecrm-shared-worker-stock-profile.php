<?php
declare(strict_types=1);

require_once __DIR__.'/../services/suitecrm/email-audience/NativeEmailRuntime.php';

function stockProfileCheck(bool $condition): void
{
    if(!$condition)throw new RuntimeException('Unexpected shared worker stock profile');
}

$checkVersion=new ReflectionMethod(ClawPilotNativeEmailRuntime::class,'sharedWorkerStockUpgrade');
$origin=getcwd();
$root=sys_get_temp_dir().'/cp-shared-stock-'.bin2hex(random_bytes(12));
$legacy=$root.'/public/legacy';
$marker=$root.'/VERSION';
stockProfileCheck(mkdir($legacy,0700,true));
try {
    stockProfileCheck(chdir($legacy));
    foreach (["8.10.1\n"=>false,"8.10.2\n"=>true] as $bytes=>$upgraded) {
        stockProfileCheck(file_put_contents($marker,$bytes)===7 && $checkVersion->invoke(null)===$upgraded);
    }
    foreach (["8.10.3\n","8.10.2\r\n","8.10.2\nextra",null] as $bytes) {
        if($bytes===null)unlink($marker);else file_put_contents($marker,$bytes);
        try {
            $checkVersion->invoke(null);
            throw new RuntimeException('Unreviewed VERSION was accepted');
        } catch(ClawPilotNativeEmailTransactionRefused $error) {
            stockProfileCheck($error->holdCode==='native_runtime_profile_unproven'
                && $error->diagnostic==='shared_worker_stock_version');
        }
    }
    stockProfileCheck(file_put_contents($root.'/other-version',"8.10.2\n")===7);
    stockProfileCheck(symlink($root.'/other-version',$marker));
    try {
        $checkVersion->invoke(null);
        throw new RuntimeException('Symlinked VERSION was accepted');
    } catch(ClawPilotNativeEmailTransactionRefused $error) {
        stockProfileCheck($error->holdCode==='native_runtime_profile_unproven'
            && $error->diagnostic==='shared_worker_stock_version');
    }
    fwrite(STDOUT,"Shared worker stock profile: exact 8.10.1/8.10.2 releases, unknown and symlinked VERSION refusal passed.\n");
} finally {
    chdir($origin);
    if(is_link($marker)||is_file($marker))unlink($marker);
    if(is_file($root.'/other-version'))unlink($root.'/other-version');
    rmdir($legacy);
    rmdir($root.'/public');
    rmdir($root);
}
