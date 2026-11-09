<?php
declare(strict_types=1);

require_once __DIR__.'/install-record-lifecycle.php';

const CP_SHARED_EMAIL_ROUTE_BLOCK = "\n// BEGIN ClawPilot shared Email worker route v1\nrequire_once '/opt/clawpilot/email-audience/shared-worker-routes.php';\n// END ClawPilot shared Email worker route v1\n";

/** Runs only before stock SuiteCRM serves traffic. No SQL, user, ACL, group,
 * role, cache, or service changes. Refuse unknown router bytes. */
function cp_install_shared_email_worker(string $sourceRoot,string $legacyRoot): void
{
    $need=static function(bool $ok): void {if(!$ok)throw new RuntimeException('Shared Email worker route requires review');};
    $need(realpath($legacyRoot)===$legacyRoot&&is_dir($legacyRoot)&&!is_link($legacyRoot)
        &&realpath($sourceRoot)===$sourceRoot&&is_dir($sourceRoot));
    $path=clawpilot_record_lifecycle_install_path($legacyRoot,'custom/application/Ext/Api/V8/Config/routes.php');
    $old=clawpilot_record_lifecycle_install_read($path);
    $source=clawpilot_record_lifecycle_install_read($sourceRoot.'/routes.php');
    $route=clawpilot_record_lifecycle_install_read($sourceRoot.'/shared-worker-routes.php');
    $worker=clawpilot_record_lifecycle_install_read($sourceRoot.'/SharedBpoEmailWorker.php');
    $need(is_string($old)&&is_string($source)&&is_string($route)&&is_string($worker)
        &&str_contains($route,'ClawPilot shared stock Email worker route v1.'));
    $variants=[$source,$source.CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK];
    foreach($variants as $base) if($old===$base.CP_SHARED_EMAIL_ROUTE_BLOCK)return;
    $need(in_array($old,$variants,true));
    $next=$old.CP_SHARED_EMAIL_ROUTE_BLOCK;
    foreach([$next,$route,$worker] as $php)token_get_all($php,TOKEN_PARSE);
    $temp=tempnam(dirname($path),'.cp-shared-email-');
    $need(is_string($temp));
    try {
        $need(file_put_contents($temp,$next,LOCK_EX)===strlen($next)&&chmod($temp,0644)
            &&clawpilot_record_lifecycle_install_read($path)===$old&&rename($temp,$path));
    } finally {if(is_file($temp))unlink($temp);}
}

if(PHP_SAPI==='cli'&&realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    try {
        if(count($argv)!==2)throw new RuntimeException('One fixed stock legacy root required');
        cp_install_shared_email_worker(__DIR__.'/email-audience',$argv[1]);
        fwrite(STDOUT,"Stock shared Email worker route installed; no permissions changed\n");
    } catch(Throwable $error){fwrite(STDERR,"Stock shared Email worker route installation held\n");exit(1);}
}
