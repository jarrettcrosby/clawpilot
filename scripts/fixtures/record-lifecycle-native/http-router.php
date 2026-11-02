<?php
declare(strict_types=1);
// No authentication adapters: all requests pass through stock OAuth middleware.
if (PHP_SAPI !== 'cli-server' || getenv('CLAWPILOT_RECORD_LIFECYCLE_NATIVE_TEST') !== '1'
    || ($_SERVER['REMOTE_ADDR'] ?? '') !== '127.0.0.1' || ($_SERVER['HTTP_HOST'] ?? '') !== '127.0.0.1:8099') {
    http_response_code(403); exit;
}
$controlPath='/tmp/record-lifecycle-control.json';
if (is_link($controlPath) || !is_file($controlPath) || filesize($controlPath)>4096 || (fileperms($controlPath)&0777)!==0600) {
    http_response_code(503); exit;
}
$control=json_decode((string)file_get_contents($controlPath),true,8,JSON_THROW_ON_ERROR);
putenv('SUITECRM_CLIENT_ID='.$control['allowed']['id']);
putenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED='.($control['enabled']?'1':'0'));
$path=parse_url($_SERVER['REQUEST_URI'] ?? '',PHP_URL_PATH);
if (!is_string($path) || !str_starts_with($path,'/Api/')) { http_response_code(404); exit; }
chdir('/app/public/legacy');
$_SERVER['SCRIPT_NAME']='/Api/index.php';
$_SERVER['PHP_SELF']='/Api/index.php';
$_SERVER['SCRIPT_FILENAME']='/app/public/legacy/Api/index.php';
require '/app/public/legacy/Api/Core/app.php';
$app->run();
