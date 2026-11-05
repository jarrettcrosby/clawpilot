<?php
declare(strict_types=1);
// Read-only, before ANY normal entrypoint bootstrap/config/OAuth writes.
require_once __DIR__.'/install-native-email-runtime.php';

function cp_native_email_startup_check(string $appRoot,string $runtimeState,string $scopeState,string $initialState,string $sourceRoot=__DIR__): string
{
    foreach([$runtimeState,$scopeState,$initialState] as $path)cp_scope_path($path,true);
    // A retained initial state can never fall back to ordinary setup. Only a
    // protected historical PG origin plus a fresh complete native inspection
    // can release the exact image/volume into its no-setup enrolled branch.
    if(file_exists($initialState)){
        require_once __DIR__.'/native-email-enrolled-startup.php';
        cp_scope_require($appRoot===CP_INITIAL_CLI_APP&&$runtimeState===CP_INITIAL_CLI_RUNTIME
            &&$scopeState===CP_INITIAL_CLI_SCOPE&&$initialState===CP_INITIAL_CLI_STATE
            &&realpath($sourceRoot)===realpath(__DIR__),'Enrolled startup requires the canonical fixed paths');
        return cp_native_email_enrolled_startup();
    }
    $runtime=file_exists($runtimeState);
    if($runtime){
        $check=cp_runtime_check(cp_runtime_context($appRoot,$runtimeState,$sourceRoot));
        cp_scope_require($check['status']==='applied','Native Email runtime package requires exact recovery before startup');
    }
    if(file_exists($scopeState)){
        $check=cp_scope_check(cp_scope_context($appRoot,$scopeState));
        cp_scope_require($check['status']==='applied','Native Email scope patch requires exact recovery before startup');
    }
    $enabled=getenv('CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED')==='1'||getenv('CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED')==='1';
    cp_scope_require(!$enabled,'Native Email activation requires the separately verified initial startup release');
    return $runtime?'runtime':'legacy';
}

if(PHP_SAPI==='cli'&&realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    try{cp_scope_require(count($argv)===1,'Startup check takes no bypass arguments');
        fwrite(STDOUT,cp_native_email_startup_check('/var/lib/suitecrm/app',
            '/var/lib/suitecrm/clawpilot-native-email-runtime-v1',
            '/var/lib/suitecrm/clawpilot-native-email-scope-v1',
            '/var/lib/suitecrm/clawpilot-native-email-initial-enrollment-v1')."\n");
    }catch(Throwable $e){fwrite(STDERR,'Native Email startup held: '.$e->getMessage()."\n");exit(1);}
}
