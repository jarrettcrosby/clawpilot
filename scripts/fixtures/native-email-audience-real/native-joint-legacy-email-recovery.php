<?php
declare(strict_types=1);

// Disposable joined fixture only. Use the already-issued synthetic OAuth token
// without exporting it, minting another token, or installing a native route.
if (PHP_SAPI!=='cli' || count($argv)!==2 || posix_geteuid()!==0
    || getenv('CLAWPILOT_NATIVE_INITIAL_FIXTURE')!=='1'
    || getenv('CLAWPILOT_NATIVE_JOINT_LEGACY_RECOVERY')!=='1') {
    throw new RuntimeException('Explicit isolated joint legacy Email fixture required');
}
define('CP_JOINT_LIFECYCLE_INCLUDE_ONLY',true);
require __DIR__.'/native-joint-lifecycle.php';

try {
    $action=$argv[1];
    cp_joint_lifecycle_need(in_array($action,['prepare','publish','resolve'],true),'legacy_email_action');
    $body=stream_get_contents(STDIN,32769);
    cp_joint_lifecycle_need(is_string($body)&&strlen($body)>0&&strlen($body)<=32768,'legacy_email_body_bound');
    $command=json_decode($body,true,32,JSON_THROW_ON_ERROR);
    cp_joint_lifecycle_need(is_array($command)&&!array_is_list($command)
        && in_array($command['version']??null,[1,2],true)&&($command['mode']??null)==='publish'
        && array_key_exists('expectedRecordFingerprint',$command)&&$command['expectedRecordFingerprint']===null
        && ($command['suiteCrmId']??null)==='6d7bbd67-dde9-4e53-89fd-29a86017d23a'
        && ($command['globalId']??null)==='gi9799999'
        && ($command['projection']['attributes']['global_id_c']??null)==='gi9799999'
        && is_string($command['operationId']??null)&&preg_match('/^[a-f0-9]{64}$/D',$command['operationId'])===1,
        'legacy_email_exact_fixture_create');
    $state=cp_joint_lifecycle_control();
    $token=$state['accessToken']??null;
    cp_joint_lifecycle_need(($state['fixtureOnly']??false)===true&&is_string($token)&&strlen($token)>0&&strlen($token)<=8192
        && !str_contains($token,"\r")&&!str_contains($token,"\n")
        && ($command['projection']['attributes']['assigned_user_id']??null)===($state['adminId']??false),'legacy_email_exact_fixture_caller');
    $wire=cp_joint_lifecycle_request('http://127.0.0.1:8080','/legacy','/Api/V8/custom/clawpilot-email-publication/'.$action,$token,$body);
    cp_joint_lifecycle_need($wire['status']===200,'legacy_email_native_http_'.$wire['status']);
    $result=$wire['document'];
    cp_joint_lifecycle_need(is_array($result)&&!array_is_list($result),'legacy_email_native_reply_shape');
    fwrite(STDOUT,json_encode($result,JSON_THROW_ON_ERROR|JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE).PHP_EOL);
} catch (Throwable $error) {
    // Never print the command, OAuth token, native body, or an exception trace.
    $reason=$error->getMessage();
    if (!preg_match('/^joint_lifecycle_[a-z0-9_]{1,70}$/D',$reason)) $reason='joint_legacy_email_native_bridge_held';
    fwrite(STDERR,$reason.PHP_EOL);
    exit(1);
}
