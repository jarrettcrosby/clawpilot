<?php
declare(strict_types=1);

// Routing only: the real native OAuth middleware and legacy login/controller
// remain responsible for authentication and authorization. No session is forged.
if (PHP_SAPI !== 'cli-server' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1'
    || trim((string) file_get_contents('/app/VERSION')) !== '8.10.1'
    || ($_SERVER['REMOTE_ADDR'] ?? '') !== '127.0.0.1'
    || ($_SERVER['HTTP_HOST'] ?? '') !== '127.0.0.1:8099') {
    http_response_code(403);
    exit;
}
$path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
chdir('/app/public/legacy');
if (is_string($path) && str_starts_with($path, '/Api/')) {
    // Test configuration only, written by the guarded CLI publication fixture
    // after all earlier HTTP stages. Authentication remains native middleware.
    $publicationControl='/tmp/native-publisher-http-control.json';
    if (is_file($publicationControl)) {
        if (is_link($publicationControl) || (fileperms($publicationControl)&0777)!==0600
            || filesize($publicationControl)>512) { http_response_code(503); exit; }
        $control=json_decode((string)file_get_contents($publicationControl),true);
        if (!is_array($control) || array_keys($control)!==['enabled','clientId'] || !is_bool($control['enabled'])
            || !is_string($control['clientId']) || preg_match('/^[a-f0-9-]{36}$/D',$control['clientId'])!==1) {
            http_response_code(503); exit;
        }
        putenv('CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED='.($control['enabled']?'1':'0'));
        putenv('SUITECRM_CLIENT_ID='.$control['clientId']);
    } else {
        putenv('CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED');
        putenv('SUITECRM_CLIENT_ID');
    }
    $authorityControl='/tmp/native-authority-http-control.json';
    if(is_file($authorityControl)) {
        if(is_link($authorityControl) || (fileperms($authorityControl)&0777)!==0600 || filesize($authorityControl)>12000){http_response_code(503);exit;}
        $control=json_decode((string)file_get_contents($authorityControl),true);
        if(!is_array($control) || array_keys($control)!==['enabled','clientId','keyId','instanceId','publicKey']
            || !is_bool($control['enabled']) || !is_string($control['clientId'])
            || preg_match('/^[a-f0-9-]{36}$/D',$control['clientId'])!==1
            || !is_string($control['keyId']) || !is_string($control['instanceId']) || !is_string($control['publicKey'])){http_response_code(503);exit;}
        putenv('CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED='.($control['enabled']?'1':'0'));
        putenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='.$control['clientId']);
        putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID='.$control['keyId']);
        putenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID='.$control['instanceId']);
        putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='.$control['publicKey']);
    }else foreach(['CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED','SUITECRM_NATIVE_AUTHORITY_CLIENT_ID',
        'SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID','SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID','SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY'] as $key)putenv($key);
    $_SERVER['SCRIPT_NAME'] = '/Api/index.php';
    $_SERVER['PHP_SELF'] = '/Api/index.php';
    $_SERVER['SCRIPT_FILENAME'] = '/app/public/legacy/Api/index.php';
    require '/app/public/legacy/Api/Core/app.php';
    $app->run();
    return;
}
if ($path === '/index.php') {
    $_SERVER['SCRIPT_NAME'] = '/index.php';
    $_SERVER['PHP_SELF'] = '/index.php';
    $_SERVER['SCRIPT_FILENAME'] = '/app/public/legacy/index.php';
    require '/app/public/legacy/index.php';
    return;
}
http_response_code(404);
