<?php
declare(strict_types=1);

// Only route the internal disposable fixture to the real stock V8 bootstrap.
// SuiteCRM itself performs all OAuth authentication and dispatch.
if(PHP_SAPI!=='cli-server'||getenv('CLAWPILOT_NATIVE_FIXTURE_SHARED_EMAIL_ONLY')!=='1'
    ||($_SERVER['REMOTE_ADDR']??'')!=='127.0.0.1'||($_SERVER['HTTP_HOST']??'')!=='127.0.0.1:8099'
    ||trim((string)file_get_contents('/app/VERSION'))!=='8.10.1'
    ||!str_starts_with((string)parse_url($_SERVER['REQUEST_URI']??'',PHP_URL_PATH),'/Api/')){
    http_response_code(404);exit;
}
$_SERVER['SCRIPT_NAME']='/Api/index.php';
$_SERVER['PHP_SELF']='/Api/index.php';
$_SERVER['SCRIPT_FILENAME']='/app/public/legacy/Api/index.php';
require '/app/public/legacy/Api/Core/app.php';
$app->run();
