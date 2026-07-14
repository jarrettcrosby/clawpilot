<?php
declare(strict_types=1);

function required_env(string $name): string {
    $value = trim((string) getenv($name));
    if ($value === '') {
        fwrite(STDERR, $name . " is required\n");
        exit(1);
    }
    return $value;
}

$clientId = required_env('SUITECRM_CLIENT_ID');
$clientSecret = required_env('SUITECRM_CLIENT_SECRET');
if (!preg_match('/^[0-9a-f-]{36}$/i', $clientId) || strlen($clientSecret) < 32) {
    fwrite(STDERR, "SuiteCRM API credentials are invalid\n");
    exit(1);
}

$pdo = new PDO(
    sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', required_env('SUITECRM_DB_HOST'), required_env('SUITECRM_DB_PORT'), required_env('SUITECRM_DB_NAME')),
    required_env('SUITECRM_DB_USER'),
    required_env('SUITECRM_DB_PASSWORD'),
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION],
);
$admin = $pdo->prepare('SELECT id FROM users WHERE user_name = ? AND deleted = 0 AND status = ? LIMIT 1');
$admin->execute([required_env('SUITECRM_ADMIN_USER'), 'Active']);
$adminId = $admin->fetchColumn();
if (!$adminId) {
    fwrite(STDERR, "SuiteCRM admin user was not found\n");
    exit(1);
}

$statement = $pdo->prepare(
    'INSERT INTO oauth2clients (
       id, name, date_entered, date_modified, modified_user_id, created_by, description,
       deleted, secret, redirect_url, is_confidential, allowed_grant_type,
       duration_value, duration_amount, duration_unit, assigned_user_id
     ) VALUES (?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?, ?, 0, ?, ?, 1, ?, 3600, 1, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), date_modified = UTC_TIMESTAMP(), modified_user_id = VALUES(modified_user_id),
       deleted = 0, secret = VALUES(secret), is_confidential = 1,
       allowed_grant_type = VALUES(allowed_grant_type), duration_value = VALUES(duration_value),
       duration_amount = VALUES(duration_amount), duration_unit = VALUES(duration_unit),
       assigned_user_id = VALUES(assigned_user_id)'
);
$statement->execute([
    $clientId,
    'ClawPilot API Client',
    $adminId,
    $adminId,
    'Managed by the ClawPilot SuiteCRM service bootstrap.',
    hash('sha256', $clientSecret),
    '',
    'client_credentials',
    'hour',
    $adminId,
]);

fwrite(STDOUT, "SuiteCRM API client is ready\n");
