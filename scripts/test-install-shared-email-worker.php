<?php
declare(strict_types=1);

require_once __DIR__.'/../services/suitecrm/install-shared-email-worker.php';

function sharedInstallCheck(bool $ok): void { if(!$ok)throw new RuntimeException('Shared worker installer test failed'); }
$source=realpath(__DIR__.'/../services/suitecrm/email-audience');
$root=sys_get_temp_dir().'/cp-shared-route-'.bin2hex(random_bytes(12));
$route=$root.'/custom/application/Ext/Api/V8/Config/routes.php';
sharedInstallCheck(mkdir(dirname($route),0700,true));
try {
    $legacy=file_get_contents($source.'/routes.php');
    foreach ([$legacy,$legacy.CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK] as $known) {
        sharedInstallCheck(file_put_contents($route,$known)===strlen($known));
        cp_install_shared_email_worker($source,$root);
        sharedInstallCheck(file_get_contents($route)===$known.CP_SHARED_EMAIL_ROUTE_BLOCK);
        cp_install_shared_email_worker($source,$root);
        sharedInstallCheck(file_get_contents($route)===$known.CP_SHARED_EMAIL_ROUTE_BLOCK);
    }
    $unmanaged="<?php\n// Unmanaged fixture route\n";
    file_put_contents($route,$unmanaged);
    $held=false;
    try {cp_install_shared_email_worker($source,$root);}catch(RuntimeException $error){$held=true;}
    sharedInstallCheck($held&&file_get_contents($route)===$unmanaged);
    fwrite(STDOUT,"Shared worker route: known router, lifecycle preservation, idempotent install and unmanaged-router refusal passed.\n");
} finally {
    if(is_file($route))unlink($route);
    for($p=dirname($route);str_starts_with($p,$root.'/');$p=dirname($p))rmdir($p);
    rmdir($root);
}
