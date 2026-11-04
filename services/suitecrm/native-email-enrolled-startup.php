<?php
declare(strict_types=1);
// Root-only enrolled startup observation. No installer, signer, DDL, config,
// Email/permission writer, OAuth request or automatic recovery is called here.
require_once __DIR__.'/native-email-initial-cli.php';
require_once __DIR__.'/install-native-email-initial-state.php';
require_once __DIR__.'/email-audience/NativeEmailStartupOrigin.php';

const CP_NATIVE_STARTUP_CERTIFICATE='activation-origin.json';
const CP_NATIVE_STARTUP_APACHE_SITE_SHA256='401dfcf6adf777c051cff7a2515949e46fbf6a3b1f06b5dae54feed1503895dc';

function cp_native_startup_need(bool $condition,string $code): void
{if(!$condition)throw new RuntimeException('native_startup_'.$code);}

/** Pure retained-value binding only, never a startup capability/readiness
 * result. The private artifact is retained for bootstrap input pins, not for
 * replaying old Email content or the original capability matrix on restart. */
function cp_native_startup_artifact(array $artifact,array $proof,array $binding): array
{
    $replan=cp_initial_cli_artifact_shape($artifact);
    cp_native_startup_need(($proof['version']??null)===($replan?2:1)
        &&$artifact['operationId']===$proof['operationId']&&$artifact['nativeInstanceId']===$proof['nativeInstanceId']
        &&$artifact['appGeneration']===$proof['originGeneration']&&$artifact['appSourceFingerprint']===$proof['appSourceFingerprint']
        &&$artifact['serviceUserId']===$proof['serviceUserId']&&$artifact['oauthClientId']===$proof['oauthClientId'],'artifact_identity');
    cp_native_startup_need(is_string($artifact['database'])&&preg_match('/^[A-Za-z0-9_]{1,64}$/D',$artifact['database'])===1,'database');
    foreach(['cliSourceHash','imagePackageHash','sourceArtifactDigest'] as $key)cp_initial_cli_hash($artifact[$key]);
    cp_native_startup_need(hash_equals($artifact['cliSourceHash'],hash_file('sha256',__DIR__.'/native-email-initial-cli.php')),'cli_source_changed');
    cp_initial_cli_keys($artifact['bootstrapPins'],CP_INITIAL_CLI_BOOTSTRAP_LEAVES);
    foreach($artifact['bootstrapPins'] as $hash)if($hash!==null)cp_initial_cli_hash($hash);
    cp_native_startup_need($artifact['mappings']===null&&is_array($artifact['plan'])&&is_array($artifact['authorization'])
        &&is_string($artifact['preparedAt'])&&($artifact['authorization']['proof']['preparedAt']??null)===$artifact['preparedAt']
        &&ClawPilotNativeEmailStartupOrigin::digest($artifact['authorization'])===$proof['approvalHash']
        &&ClawPilotNativeEmailStartupOrigin::digest($artifact['plan'])===$proof['planHash'],'retained_origin_artifact');
    cp_initial_binding($binding);
    ClawPilotNativeEmailStartupOrigin::verifyArtifact($proof,$artifact,$binding);
    return $artifact;
}
/** Actual root installation FILE checks only. A/B pins remain distinct: the
 * immutable root journal is never rebound or adopted under B's operation. */
function cp_native_startup_files(array $artifact,array $proof): array
{
    $root=cp_initial_cli_installation_files($artifact);
    cp_native_startup_artifact($artifact,$proof,$root['binding']);$pins=$root['pins'];
    if($proof['version']===1)cp_native_startup_need($pins['sourceRuntimeFingerprint']===$proof['sourceRuntimeFingerprint']
        &&$pins['installationJournalFingerprint']===$proof['installationJournalFingerprint'],'installation_changed');
    else{$lineage=$artifact['plan']['installationLineage'];
        cp_native_startup_need($pins['sourceRuntimeFingerprint']===$lineage['rootStockRuntimeFingerprint']
            &&$pins['installationJournalFingerprint']===$lineage['rootInstallationJournalFingerprint'],'root_installation_changed');}
    return $root;
}

/** Exact image-managed Apache configuration. Enrolled restart cannot rewrite
 * ports/vhost/module configuration or fall through to normal setup writers. */
function cp_native_startup_apache(): void
{
    cp_native_startup_need((getenv('PORT')?:'8080')==='8080','port_profile');
    foreach(['/etc/apache2/ports.conf'=>hash('sha256',"Listen 8080\n"),
        '/etc/apache2/sites-available/000-default.conf'=>CP_NATIVE_STARTUP_APACHE_SITE_SHA256] as $path=>$hash){
        $meta=cp_scope_snapshot($path);cp_native_startup_need($meta!==null&&$meta['uid']===0&&$meta['gid']===0
            &&$meta['mode']===0644&&hash_equals($hash,$meta['sha256']),'apache_config_changed');
    }
    foreach(['conf','load'] as $suffix){
        $path='/etc/apache2/mods-enabled/mpm_prefork.'.$suffix;clearstatcache(true,$path);$meta=lstat($path);
        cp_native_startup_need(is_array($meta)&&is_link($path)&&$meta['uid']===0
            &&realpath($path)==='/etc/apache2/mods-available/mpm_prefork.'.$suffix,'apache_prefork_required');
    }
    foreach(['mpm_event','mpm_worker'] as $module)foreach(['conf','load'] as $suffix){
        $path='/etc/apache2/mods-enabled/'.$module.'.'.$suffix;clearstatcache(true,$path);
        cp_native_startup_need(!file_exists($path)&&!is_link($path),'apache_conflicting_mpm');
    }
}

function cp_native_email_enrolled_startup(): string
{
    cp_native_startup_need(PHP_SAPI==='cli'&&PHP_OS_FAMILY==='Linux'&&PHP_VERSION_ID===80336
        &&function_exists('posix_geteuid')&&posix_geteuid()===0,'root_runtime_required');
    cp_native_startup_need(getenv('CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED')==='1'
        &&getenv('CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED')==='1','activation_environment_required');
    cp_native_startup_apache();cp_scope_quiescent(true);
    cp_scope_protected_directory(CP_INITIAL_CLI_STATE,false);
    cp_scope_protected_directory(CP_INITIAL_CLI_STATE.'/operations',false);
    $path=CP_INITIAL_CLI_STATE.'/'.CP_NATIVE_STARTUP_CERTIFICATE;
    $certificate=cp_initial_private($path,262144);$envelope=json_decode($certificate,true,64,JSON_THROW_ON_ERROR);
    cp_native_startup_need(is_array($envelope)&&ClawPilotNativeEmailStartupOrigin::canonical($envelope)===$certificate,'certificate_canonical');
    $proof=ClawPilotNativeEmailStartupOrigin::verifyEnvelope($envelope,time());
    $dir=CP_INITIAL_CLI_STATE.'/operations/'.$proof['operationId'];cp_scope_protected_directory($dir,false);
    $inputPath=$dir.'/input.json';$input=cp_initial_private($inputPath);$inputHash=hash('sha256',$input);
    $artifact=json_decode($input,true,64,JSON_THROW_ON_ERROR);$root=cp_native_startup_files($artifact,$proof);$context=$root['context'];
    $lock=cp_initial_installer_lock($context);
    try{
        cp_native_startup_need(hash('sha256',cp_initial_private($path,262144))===hash('sha256',$certificate)
            &&hash('sha256',cp_initial_private($inputPath))===$inputHash,'protected_input_changed');
        // These checks MUST precede the first persisted config/entryPoint
        // include. They cover the nine retained bootstrap input leaves plus
        // the installed package/config journals, NOT the complete PHP include
        // closure or a filesystem-admin/supply-chain tamper boundary. The
        // reviewed image/app filesystem remains a precondition; the full
        // existing NativeRuntime compatibility attestation follows bootstrap.
        // No expected hash is learned from the current application files.
        cp_native_startup_files($artifact,$proof);
        cp_initial_cli_identity($artifact);cp_initial_cli_pins($artifact);
        $db=cp_initial_cli_cold_bootstrap($artifact);
        require_once __DIR__.'/email-audience/NativeEmailAuthorityTransition.php';
        $profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>$artifact['database']];
        $origin=ClawPilotNativeEmailStartupOriginAuthority::fromProtectedFile($db,$profile,$path,CP_INITIAL_CLI_APP,CP_INITIAL_CLI_STATE,__DIR__);
        $service=new ClawPilotNativeEmailAuthorityTransition($db,$profile,$proof['serviceUserId'],$proof['oauthClientId'],'','');
        // Token construction alone is NOT success. The same complete current
        // binding/identity/group/ACL inspection must finish and roll back.
        $snapshot=$service->inspectStartupOrigin($origin);
        cp_native_startup_need(($snapshot['version']??null)===1&&is_int($snapshot['generation']??null)
            &&$snapshot['generation']>=$proof['originGeneration'],'current_inspection_required');
        return 'enrolled';
    }finally{flock($lock,LOCK_UN);fclose($lock);}
}

if(PHP_SAPI==='cli'&&realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    try{cp_native_startup_need(count($argv)===1,'no_arguments');ini_set('display_errors','0');fwrite(STDOUT,cp_native_email_enrolled_startup()."\n");}
    catch(Throwable $error){fwrite(STDERR,"Native enrolled startup held; protected origin/current native checks require review\n");exit(1);}
}
