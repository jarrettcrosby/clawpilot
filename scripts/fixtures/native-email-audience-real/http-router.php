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
