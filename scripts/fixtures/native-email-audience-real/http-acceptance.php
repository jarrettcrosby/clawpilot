<?php
declare(strict_types=1);

// Real HTTP OAuth + legacy cookie sessions, inside the disposable fixture only.
// This neither sends mail nor mutates a live provider. Request/response bodies,
// credentials, tokens, cookies and native session IDs are never printed.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1'
    || trim((string) file_get_contents('/app/VERSION')) !== '8.10.1') {
    throw new RuntimeException('Explicit disposable native HTTP fixture required');
}
define('CLAWPILOT_NATIVE_HELPERS_ONLY', true);
require '/fixture/acceptance.php';
const HTTP_FIXTURE_ORIGIN = 'http://127.0.0.1:8099';

function fixtureHttpClient(): CurlHandle
{
    $client = curl_init();
    must($client instanceof CurlHandle, 'Native HTTP curl runtime is required');
    curl_setopt_array($client, [CURLOPT_COOKIEFILE => '', CURLOPT_PROXY => '',
        CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 20, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP, CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP]);
    return $client;
}
function fixtureHttp(CurlHandle $client, string $path, ?array $post = null, ?string $token = null, ?string $method = null): array
{
    must(str_starts_with($path, '/') && !str_starts_with($path, '//'), 'Only local fixture request paths are allowed');
    $body = ''; $location = null;
    $headers = ['Accept: application/json', 'Referer: '.HTTP_FIXTURE_ORIGIN.'/index.php'];
    if ($token !== null) $headers[] = 'Authorization: Bearer '.$token;
    curl_setopt_array($client, [CURLOPT_URL => HTTP_FIXTURE_ORIGIN.$path,
        CURLOPT_HTTPHEADER => $headers, CURLOPT_CUSTOMREQUEST => $method ?? ($post === null ? 'GET' : 'POST'),
        CURLOPT_POSTFIELDS => $post === null ? null : http_build_query($post),
        CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$body): int {
            if (strlen($body) + strlen($chunk) > 4 * 1024 * 1024) return 0;
            $body .= $chunk;
            return strlen($chunk);
        },
        CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$location): int {
            if (stripos($line, 'Location:') === 0) $location = trim(substr($line, 9));
            return strlen($line);
        }]);
    $ok = curl_exec($client);
    must($ok !== false, 'Bounded local HTTP request failed (curl code '.curl_errno($client).')');
    if ($location !== null) {
        $parts = parse_url($location);
        must(is_array($parts) && !str_starts_with($location, '//')
            && (!isset($parts['host']) || (($parts['scheme'] ?? '') === 'http'
                && $parts['host'] === '127.0.0.1' && ($parts['port'] ?? 80) === 8099))
            && !isset($parts['user']) && !isset($parts['pass']), 'Native redirect left the isolated HTTP origin');
    }
    return ['status' => (int) curl_getinfo($client, CURLINFO_RESPONSE_CODE), 'body' => $body, 'location' => $location];
}
function fixtureDocument(array $response, string $label): array
{
    must($response['status'] === 200 && $response['location'] === null, $label.' must return HTTP 200 without redirect (received '.$response['status'].')');
    $document = json_decode($response['body'], true);
    must(is_array($document) && !isset($document['errors']), $label.' must return a native success JSON document');
    return $document;
}
function fixtureNoDisclosure(array $response, array $markers, string $label): void
{
    must(in_array($response['status'], [200, 400, 401, 403, 404], true) && $response['location'] === null,
        $label.' must deny or filter cleanly, not fail or redirect (received '.$response['status'].')');
    foreach ($markers as $marker) {
        must(!str_contains($response['body'], $marker), $label.' disclosed a forbidden content/header marker');
    }
}
function fixtureV8Denied(array $response, string $label): void
{
    $document = json_decode($response['body'], true);
    // Stock V8 controllers encode native AccessDeniedException as HTTP 400.
    // A random validation error, login failure or server error is not proof.
    must(in_array($response['status'], [400, 403], true)
        && is_array($document) && isset($document['errors'])
        && str_contains((string) ($document['errors']['detail'] ?? ''), '[AccessDeniedException]'),
        $label.' must return the real native access-denied error');
}
function fixtureUi(CurlHandle $client, string $action, array $parameters = []): array
{
    return fixtureHttp($client, '/index.php', array_merge([
        'module' => 'Emails', 'action' => 'EmailUIAjax', 'to_pdf' => 'true',
        'emailUIAction' => $action, 'mbox' => 'sugar::Emails', 'mailbox' => 'sugar::Emails',
        'ieId' => '', 'sugarEmail' => 'true', 'composeType' => 'reply',
    ], $parameters));
}
function fixtureAuthenticate(CurlHandle $client, string $username, string $password, string $clientId, string $clientSecret, string $label): string
{
    $grant = fixtureDocument(fixtureHttp($client, '/Api/access_token', [
        'grant_type' => 'password', 'client_id' => $clientId, 'client_secret' => $clientSecret,
        'username' => $username, 'password' => $password,
    ]), $label.' real OAuth password grant');
    must(is_string($grant['access_token'] ?? null) && $grant['access_token'] !== '', 'Native password grant must issue a token');
    $login = fixtureHttp($client, '/index.php?module=Users&action=Authenticate', [
        'module' => 'Users', 'action' => 'Authenticate', 'user_name' => $username,
        'username_password' => $password, 'login_language' => 'en_us',
    ]);
    must(in_array($login['status'], [302, 303], true) && is_string($login['location'])
        && !preg_match('/action=(Login|ChangePassword)/i', $login['location']), $label.' real native session login must succeed');
    return $grant['access_token'];
}
function fixtureSessionFingerprint(CurlHandle $client): string
{
    // Inspect only the local curl cookie jar; never inspect, alter or clear the
    // server session. The identity stays in memory and is never printed.
    $cookies = curl_getinfo($client, CURLINFO_COOKIELIST);
    must(is_array($cookies), 'Native HTTP cookie jar must be available');
    foreach ($cookies as $cookie) {
        $fields = explode("\t", $cookie);
        if (count($fields) === 7 && $fields[5] === session_name() && $fields[6] !== '') {
            return hash('sha256', $fields[6]);
        }
    }
    throw new RuntimeException('Authenticated native session cookie is required');
}
function fixtureMessageFingerprint(): string
{
    $tables = ['emails' => 'id', 'emails_text' => 'email_id', 'emails_cstm' => 'id_c',
        'emails_beans' => 'id', 'emails_email_addr_rel' => 'id', 'email_addresses' => 'id',
        'securitygroups_records' => 'id'];
    $data = [];
    foreach ($tables as $table => $key) $data[$table] = rows('SELECT * FROM '.$table.' ORDER BY '.$key);
    return hash('sha256', json_encode($data, JSON_THROW_ON_ERROR));
}

try {
    must(($sugar_config['dbconfig']['db_name'] ?? '') === 'suitecrm_native_test'
        && ($sugar_config['dbconfig']['db_host_name'] ?? '') === 'db', 'Only the isolated synthetic database may be prepared');
    $labels = ['admin' => 'fixture-admin', 'target' => 'fixture-installed-blank-status-unroled',
        'service-one' => 'fixture-installed-service-one', 'service-two' => 'fixture-installed-service-two'];
    $users = []; $passwords = []; $statusBefore = [];
    foreach ($labels as $label => $username) {
        $matches = rows("SELECT id,status FROM users WHERE user_name='".quote($username)."' AND deleted=0");
        must(count($matches) === 1, 'Exactly one synthetic HTTP '.$label.' principal is required');
        $users[$label] = fresh('Users', $matches[0]['id']);
        $statusBefore[$label] = $matches[0]['status'];
        $passwords[$label] = 'Synthetic-only-'.bin2hex(random_bytes(16));
        $users[$label]->setNewPassword($passwords[$label]);
    }
    must($statusBefore['target'] === '', 'HTTP target retains the reviewed native blank status');
    selectUser($users['admin']);
    $clientSecret = 'Synthetic-client-only-'.bin2hex(random_bytes(24));
    $oauth = native('OAuth2Clients');
    $oauth->name = 'Disposable native HTTP password-grant fixture';
    $oauth->allowed_grant_type = 'password'; $oauth->is_confidential = 1;
    $oauth->assigned_user_id = $users['admin']->id;
    $savedRequest = $_REQUEST;
    $_REQUEST = ['new_secret' => $clientSecret, 'duration_amount' => 1, 'duration_unit' => 'hour'];
    $oauth->save(false); $_REQUEST = $savedRequest;
    $privateKey = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_RSA, 'private_key_bits' => 2048]);
    must($privateKey !== false && openssl_pkey_export($privateKey, $privatePem), 'Disposable OAuth signing key generation failed');
    $publicKey = openssl_pkey_get_details($privateKey);
    must(is_array($publicKey), 'Disposable OAuth public key generation failed');
    foreach (['private.key' => $privatePem, 'public.key' => $publicKey['key']] as $file => $bytes) {
        $path = '/app/public/legacy/Api/V8/OAuth2/'.$file;
        must(file_put_contents($path, $bytes, LOCK_EX) === strlen($bytes) && chmod($path, 0600), 'Cannot stage disposable OAuth key');
    }
    unset($privatePem, $privateKey, $publicKey);
    $configPath = '/app/public/legacy/config_override.php';
    $config = is_file($configPath) ? file_get_contents($configPath) : "<?php\n";
    must(is_string($config) && str_starts_with(ltrim($config), '<?php'), 'Disposable configuration must be PHP');
    $config = preg_replace('/\?>\s*$/', '', $config);
    $config .= "\n// Disposable loopback HTTP fixture configuration.\n"
        .'$sugar_config[\'site_url\'] = '.var_export(HTTP_FIXTURE_ORIGIN, true).";\n"
        .'$sugar_config[\'trusted_hosts\'] = [\'^127\\\\.0\\\\.0\\\\.1$\'];'."\n"
        .'$sugar_config[\'oauth2_encryption_key\'] = '.var_export(bin2hex(random_bytes(32)), true).";\n";
    must(file_put_contents($configPath, $config, LOCK_EX) === strlen($config), 'Cannot configure isolated HTTP origin');

    $emails = []; $markers = [];
    foreach (['own' => 'gi5678901', 'foreign' => 'gi5678902'] as $label => $globalId) {
        $found = rows("SELECT e.id FROM emails e JOIN emails_cstm c ON c.id_c=e.id WHERE e.deleted=0 AND c.global_id_c='".quote($globalId)."'");
        must(count($found) === 1, 'Candidate synthetic '.$label.' Email is required');
        $email = fresh('Emails', $found[0]['id']);
        // Distinct synthetic bodies and each header detect leaks even if a route
        // strips IDs or subjects. These setup writes precede the read-only proof.
        $bodyMarker = 'HTTP-'.strtoupper($label).'-BODY-'.bin2hex(random_bytes(6));
        $email->description = $bodyMarker; $email->description_html = '<p>'.$bodyMarker.'</p>';
        $markers[$label] = [(string) $email->id, (string) $email->name, $bodyMarker];
        foreach (['from_addr_name' => 'from', 'to_addrs_names' => 'to', 'cc_addrs_names' => 'cc', 'bcc_addrs_names' => 'bcc'] as $field => $header) {
            $address = 'http-'.$label.'-'.$header.'-'.bin2hex(random_bytes(4)).'@fixture.example.test';
            $email->{$field} = $address; $markers[$label][] = $address;
        }
        $email->save(false); $emails[$label] = fresh('Emails', (string) $email->id);
    }
    $accountRows = rows("SELECT id FROM accounts WHERE name='Fixture accessible company with mixed Email links' AND deleted=0");
    must(count($accountRows) === 1, 'Candidate mixed-Email related Account is required');
    $accountId = $accountRows[0]['id'];
    require_once 'include/SugarFolders/SugarFolders.php';
    selectUser($users['target']);
    $folder = new SugarFolder();
    $folder->name = 'Disposable mixed own and foreign Email HTTP folder';
    $folder->folder_type = 'custom'; $folder->parent_folder = ''; $folder->assign_to_id = $users['target']->id;
    must((bool) $folder->save(false), 'Native synthetic mixed Email folder must save');
    foreach ($emails as $email) must((bool) $folder->addBean($email), 'Native synthetic Email folder link must save');
    $folderId = (string) $folder->id;
    $fingerprint = fixtureMessageFingerprint();
    $clients = []; $tokens = [];
    check('HTTP existing default-all session loses foreign Email access immediately after the permission correction without another login', static function () use (&$clients, &$tokens, $users, $labels, $passwords, $oauth, $clientSecret, $emails, $markers, $folderId, $fingerprint): void {
        $targetId = (string) $users['target']->id;
        $roleRows = rows("SELECT id FROM acl_roles WHERE name='Fixture scoped native Email permissions' AND deleted=0");
        $groupRows = rows("SELECT id FROM securitygroups WHERE name='Fixture authorized Suburbia workspace' AND deleted=0");
        must(count($roleRows) === 1 && count($groupRows) === 1, 'Exact synthetic correction role and group are required');
        $roleId = $roleRows[0]['id']; $groupId = $groupRows[0]['id'];
        $memberships = static function () use ($targetId): array {
            return [
                rows("SELECT role_id FROM acl_roles_users WHERE user_id='".quote($targetId)."' AND deleted=0 ORDER BY role_id"),
                rows("SELECT securitygroup_id FROM securitygroups_users WHERE user_id='".quote($targetId)."' AND deleted=0 ORDER BY securitygroup_id"),
            ];
        };
        $before = $memberships();
        must($before === [[['role_id' => $roleId]], [['securitygroup_id' => $groupId]]],
            'Historical correction fixture must have only its exact two reviewed memberships');
        selectUser($users['admin']);
        try {
            $role = fresh('ACLRoles', $roleId); $group = fresh('SecurityGroups', $groupId);
            must($role->load_relationship('users') && $group->load_relationship('users'), 'Native correction membership links must load');
            $role->users->delete($roleId, $targetId); $group->users->delete($groupId, $targetId);
            must($memberships() === [[], []], 'Only the synthetic target must return to its pre-correction unroled state');
            $clients['target'] = fixtureHttpClient();
            $tokens['target'] = fixtureAuthenticate($clients['target'], $labels['target'], $passwords['target'],
                (string) $oauth->id, $clientSecret, 'Existing unroled target');
            foreach ($emails as $scope => $email) {
                $direct = fixtureHttp($clients['target'], '/Api/V8/module/Emails/'.rawurlencode((string) $email->id), null, $tokens['target']);
                $document = fixtureDocument($direct, 'Pre-correction default-all '.$scope.' V8 read');
                must(($document['data']['id'] ?? '') === $email->id && str_contains($direct['body'], $markers[$scope][2]),
                    'Pre-correction token must actually read both exact Email bodies');
                $preview = fixtureUi($clients['target'], 'getSingleMessageFromSugar', ['uid' => (string) $email->id]);
                fixtureDocument($preview, 'Pre-correction default-all '.$scope.' legacy preview');
                must(str_contains($preview['body'], $markers[$scope][2]), 'Pre-correction session must actually read both Email bodies');
            }
            $search = fixtureUi($clients['target'], 'searchAdvanced', ['name' => 'Synthetic ', 'start' => '0', 'limit' => '20']);
            $document = fixtureDocument($search, 'Pre-correction default-all imported search');
            must((int) ($document['TotalCount'] ?? -1) === 2 && count($document['Email'] ?? []) === 2,
                'Pre-correction session must actually list and count both Emails');
            foreach ($emails as $email) must(str_contains($search['body'], (string) $email->id), 'Pre-correction search must contain both exact Email IDs');
            $existingSession = fixtureSessionFingerprint($clients['target']);
        } finally {
            // Restore only the exact native memberships even if priming fails.
            // This CLI principal reset cannot refresh the HTTP session's ACL.
            selectUser($users['admin']);
            linkBeans(fresh('ACLRoles', $roleId), 'users', [$targetId]);
            linkBeans(fresh('SecurityGroups', $groupId), 'users', [$targetId]);
            must($memberships() === $before, 'Historical correction must restore the exact original memberships');
        }
        // No Authenticate request, cookie reset, session-file edit or token
        // refresh is permitted after the native role/group correction.
        // Check legacy FIRST: an intervening OAuth/V8 request must not be able
        // to incidentally refresh stale legacy ACL state and mask this defect.
        $firstAfterCorrection = fixtureUi($clients['target'], 'getSingleMessageFromSugar', ['uid' => (string) $emails['foreign']->id]);
        fixtureNoDisclosure($firstAfterCorrection, array_slice($markers['foreign'], 1), 'First existing-session request after correction');
        $firstDenial = json_decode($firstAfterCorrection['body'], true);
        must($firstAfterCorrection['status'] === 403 && is_array($firstDenial) && ($firstDenial['error'] ?? null) === 'Access denied',
            'The first request in the existing native session must immediately deny the foreign Email');
        must(hash_equals($existingSession, fixtureSessionFingerprint($clients['target'])), 'First corrected request must retain the exact pre-correction native session');
        foreach ($emails as $scope => $email) {
            $direct = fixtureHttp($clients['target'], '/Api/V8/module/Emails/'.rawurlencode((string) $email->id), null, $tokens['target']);
            if ($scope === 'own') {
                $document = fixtureDocument($direct, 'Corrected existing-token authorized V8 read');
                must(($document['data']['id'] ?? '') === $email->id && str_contains($direct['body'], $markers['own'][2]),
                    'Corrected existing token must retain its authorized Email body');
            } else {
                fixtureNoDisclosure($direct, array_slice($markers['foreign'], 1), 'Corrected existing-token foreign V8 read');
                fixtureV8Denied($direct, 'Corrected existing-token foreign V8 read');
            }
            foreach (['getSingleMessageFromSugar', 'getMultipleMessagesFromSugar', 'composeEmail', 'getQuickCreateForm', 'getRelateForm', 'getEmail2DetailView'] as $action) {
                if ($scope === 'own' && $action === 'getEmail2DetailView') continue; // Pinned stock null DetailView defect, not permission proof.
                $uid = $action === 'getRelateForm' ? json_encode([$email->id], JSON_THROW_ON_ERROR) : (string) $email->id;
                $response = fixtureUi($clients['target'], $action, ['uid' => $uid, 'qc_module' => 'Tasks']);
                if ($scope === 'own') {
                    $document = fixtureDocument($response, 'Corrected existing-session own '.$action);
                    if ($action === 'getRelateForm') must(is_string($document['html'] ?? null) && strlen($document['html']) > 100,
                        'Corrected existing session must retain its authorized native relate form');
                    else must(str_contains($response['body'], $markers['own'][2]), 'Corrected existing session must retain its authorized Email body');
                } else {
                    fixtureNoDisclosure($response, array_slice($markers['foreign'], 1), 'Corrected existing-session foreign '.$action);
                    $denial = json_decode($response['body'], true);
                    must($response['status'] === 403 && is_array($denial) && ($denial['error'] ?? null) === 'Access denied',
                        'Corrected existing session must explicitly deny the foreign Email before rendering');
                }
            }
        }
        foreach (['searchAdvanced' => ['name' => 'Synthetic ', 'start' => '0', 'limit' => '20'],
            'getMessageListSugarFolders' => ['ieId' => $folderId, 'start' => '0', 'limit' => '20']] as $action => $parameters) {
            $response = fixtureUi($clients['target'], $action, $parameters);
            $document = fixtureDocument($response, 'Corrected existing-session '.$action);
            must((int) ($document['TotalCount'] ?? -1) === 1 && count($document['Email'] ?? []) === 1,
                'Corrected existing-session search/folder totals must immediately exclude the foreign Email');
            must(str_contains($response['body'], (string) $emails['own']->id), 'Corrected existing-session search/folder must retain its authorized Email');
            fixtureNoDisclosure($response, $markers['foreign'], 'Corrected existing-session '.$action);
            if ($action === 'getMessageListSugarFolders') must((int) ($document['UnreadCount'] ?? -1) === 0, 'Corrected existing-session unread count must exclude hidden rows');
        }
        must(hash_equals($existingSession, fixtureSessionFingerprint($clients['target'])), 'Permission correction must take effect in the same unchanged native login session');
        must(hash_equals($fingerprint, fixtureMessageFingerprint()), 'Existing-session permission correction must not rewrite Email data or record security groups');
    });
    foreach ($users as $label => $user) {
        // The target deliberately keeps its pre-correction login and token for
        // every remaining matrix check, including V8 list/related pagination.
        if (isset($clients[$label], $tokens[$label])) continue;
        $clients[$label] = fixtureHttpClient();
        $tokens[$label] = fixtureAuthenticate($clients[$label], $labels[$label], $passwords[$label],
            (string) $oauth->id, $clientSecret, $label);
    }
    check('HTTP uses real password grants and real legacy cookie logins for unchanged principal classes', static function (): void {});
    foreach ($users as $label => $user) {
        $allowed = $label === 'admin' ? ['own', 'foreign'] : ($label === 'target' ? ['own'] : []);
        foreach ($emails as $scope => $email) {
            $response = fixtureHttp($clients[$label], '/Api/V8/module/Emails/'.rawurlencode((string) $email->id), null, $tokens[$label]);
            if (in_array($scope, $allowed, true)) {
                $document = fixtureDocument($response, $label.' '.$scope.' direct V8');
                must(($document['data']['id'] ?? '') === $email->id && str_contains($response['body'], $markers[$scope][2]), 'Authorized direct V8 must retain the exact Email body');
            } else {
                fixtureNoDisclosure($response, array_slice($markers[$scope], 1), $label.' '.$scope.' direct V8');
                fixtureV8Denied($response, 'Unauthorized direct V8');
            }
        }
        foreach (['module' => '/Api/V8/module/Emails', 'related' => '/Api/V8/module/Accounts/'.$accountId.'/relationships/emails'] as $surface => $path) {
            $query = ['page' => ['size' => '1', 'number' => '1']];
            if ($surface === 'module') $query['filter'] = ['name' => ['like' => 'Synthetic %Email']];
            $response = fixtureHttp($clients[$label], $path.'?'.http_build_query($query), null, $tokens[$label]);
            if (!$allowed) {
                fixtureNoDisclosure($response, array_merge($markers['own'], $markers['foreign']), $label.' '.$surface.' V8 list');
                fixtureV8Denied($response, 'Denied service V8 list');
            } else {
                $document = fixtureDocument($response, $label.' '.$surface.' V8 list');
                must(count($document['data'] ?? []) === 1, 'Native V8 page must return exactly one authorized row');
                must((int) ($document['meta']['total-pages'] ?? -1) === count($allowed), 'Native V8 totals must exclude hidden Email rows');
                if ($surface === 'related') must((int) ($document['meta']['total-records'] ?? -1) === count($allowed), 'Related V8 record total must exclude hidden rows');
                if ($label === 'target') {
                    must(($document['data'][0]['id'] ?? '') === $emails['own']->id, 'Target V8 list must retain its own Email');
                    fixtureNoDisclosure($response, $markers['foreign'], 'Target '.$surface.' V8 list');
                }
            }
        }
        check($label.' authenticated HTTP V8 direct/list/related content and pagination', static function (): void {});
        foreach (['getSingleMessageFromSugar', 'getMultipleMessagesFromSugar', 'composeEmail', 'getQuickCreateForm', 'getEmail2DetailView', 'getRelateForm'] as $action) {
            foreach ($emails as $scope => $email) {
                // Stock 8.10.1 EmailUI.php assigns ->ss to a null DetailView
                // before constructing it. Do not repair that unrelated bug or
                // count a 500 as an authorized-render/permission acceptance.
                // The forbidden path is still required to deny before rendering.
                if ($action === 'getEmail2DetailView' && in_array($scope, $allowed, true)) continue;
                $uid = $action === 'getRelateForm' ? json_encode([$email->id], JSON_THROW_ON_ERROR) : (string) $email->id;
                $response = fixtureUi($clients[$label], $action, ['uid' => $uid, 'qc_module' => 'Tasks']);
                if (in_array($scope, $allowed, true)) {
                    $document = fixtureDocument($response, $label.' '.$scope.' '.$action);
                    if ($action === 'getRelateForm') {
                        must(is_string($document['html'] ?? null) && strlen($document['html']) > 100, 'Authorized native relate form must render');
                    } else {
                        must(str_contains($response['body'], $markers[$scope][2]), 'Authorized native '.$action.' must preserve its Email body');
                    }
                } else {
                    fixtureNoDisclosure($response, array_slice($markers[$scope], 1), $label.' '.$scope.' '.$action);
                    must($response['status'] === 403 || preg_match('/no.access|not.authorized|access.denied/i', $response['body']) === 1,
                        'Unauthorized native '.$action.' must produce explicit denial');
                }
            }
        }
        check($label.' real legacy UID routes: five allowed-render surfaces plus guarded detail denial', static function (): void {});
        if ($label === 'target') {
            $mixed = fixtureUi($clients[$label], 'getMultipleMessagesFromSugar', ['uid' => $emails['own']->id.','.$emails['foreign']->id]);
            fixtureNoDisclosure($mixed, $markers['foreign'], 'Mixed-UID legacy multi-message request');
            must($mixed['status'] === 403 || str_contains($mixed['body'], $markers['own'][2]),
                'Mixed-UID multi-message must explicitly deny or retain its authorized row');
            $mixedRelate = fixtureUi($clients[$label], 'getRelateForm', ['uid' => json_encode([$emails['own']->id, $emails['foreign']->id], JSON_THROW_ON_ERROR)]);
            fixtureNoDisclosure($mixedRelate, $markers['foreign'], 'Mixed-UID legacy relate-form request');
            must($mixedRelate['status'] === 403, 'Mixed-UID relate form must reject a hidden secondary Email');
        }
        foreach (['searchAdvanced' => ['name' => 'Synthetic ', 'start' => '0', 'limit' => '20'],
            'getMessageListSugarFolders' => ['ieId' => $folderId, 'start' => '0', 'limit' => '20']] as $action => $parameters) {
            $response = fixtureUi($clients[$label], $action, $parameters);
            if (!$allowed && $response['status'] === 403) {
                fixtureNoDisclosure($response, array_merge($markers['own'], $markers['foreign']), $label.' '.$action);
                continue;
            }
            $document = fixtureDocument($response, $label.' '.$action);
            must((int) ($document['TotalCount'] ?? -1) === count($allowed), 'Native '.$action.' count must exclude hidden Emails');
            must(count($document['Email'] ?? []) === count($allowed), 'Native '.$action.' must retain exactly the allowed Email rows');
            foreach ($emails as $scope => $email) {
                if (in_array($scope, $allowed, true)) must(str_contains($response['body'], (string) $email->id), 'Authorized native list Email disappeared');
                else fixtureNoDisclosure($response, $markers[$scope], $label.' '.$action);
            }
            if ($action === 'getMessageListSugarFolders') must((int) ($document['UnreadCount'] ?? -1) === 0, 'Native folder unread count must match read fixture rows');
        }
        check($label.' real imported-search and mixed-folder Email rows/counts', static function (): void {});
    }
    check('HTTP legacy relateEmails refuses a forbidden Email without changing rows or relationships', static function () use ($clients, $emails, $accountId, $markers, $fingerprint): void {
        $response = fixtureUi($clients['target'], 'relateEmails', ['uid' => (string) $emails['foreign']->id,
            'parent_type' => 'Accounts', 'parent_id' => $accountId]);
        fixtureNoDisclosure($response, array_slice($markers['foreign'], 1), 'Forbidden legacy relateEmails');
        must($response['status'] === 403, 'Forbidden legacy relateEmails must explicitly deny');
        must(hash_equals($fingerprint, fixtureMessageFingerprint()), 'Denied legacy relateEmails mutated Email data');
    });
    check('HTTP legacy saveQuickCreate rejects a foreign Email before creating or changing any target Task', static function () use ($clients, $users, $emails, $markers, $fingerprint): void {
        selectUser($users['target']);
        must(ACLController::checkAccess('Tasks', 'edit', true), 'Synthetic target must retain ordinary Task editing permission');
        // Capture every Task, including deleted rows: creation followed by soft
        // deletion, or an unexpected modification, cannot hide behind a count.
        $tasksBefore = rows('SELECT * FROM tasks ORDER BY id');
        $tasksFingerprint = hash('sha256', json_encode($tasksBefore, JSON_THROW_ON_ERROR));
        $response = fixtureUi($clients['target'], 'saveQuickCreate', [
            'sugarEmail' => 'true', 'uid' => (string) $emails['foreign']->id, 'qcmodule' => 'Tasks',
            'name' => 'Forbidden Email quick-create sentinel '.bin2hex(random_bytes(8)),
            'description' => 'This synthetic Task must never be created from a forbidden Email.',
            'status' => 'Not Started', 'priority' => 'Medium', 'assigned_user_id' => (string) $users['target']->id,
        ]);
        fixtureNoDisclosure($response, $markers['foreign'], 'Forbidden legacy saveQuickCreate');
        must($response['status'] === 403, 'Forbidden legacy saveQuickCreate must explicitly deny before target creation');
        $denial = json_decode($response['body'], true);
        must(is_array($denial) && ($denial['error'] ?? null) === 'Access denied', 'Quick-create rejection must be the native candidate source-Email guard');
        $tasksAfter = rows('SELECT * FROM tasks ORDER BY id');
        must(count($tasksAfter) === count($tasksBefore), 'Denied quick-create changed the target Task count');
        must(hash_equals($tasksFingerprint, hash('sha256', json_encode($tasksAfter, JSON_THROW_ON_ERROR))),
            'Denied quick-create changed an existing or deleted target Task');
        must(hash_equals($fingerprint, fixtureMessageFingerprint()), 'Denied quick-create changed Email data, headers, ownership or relationships');
    });
    check('HTTP V8 relationship deletion authorizes the exact requested Email, not its allowed sibling', static function () use ($clients, $tokens, $emails, $accountId, $fingerprint): void {
        $response = fixtureHttp($clients['target'], '/Api/V8/module/Accounts/'.$accountId.'/relationships/emails/'.$emails['foreign']->id,
            null, $tokens['target'], 'DELETE');
        fixtureV8Denied($response, 'Forbidden V8 exact relationship deletion');
        must(hash_equals($fingerprint, fixtureMessageFingerprint()), 'Denied V8 relationship deletion changed Email data or links');
        selectUser(fresh('Users', rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0")[0]['id']));
        $links = linkedIds(fresh('Accounts', $accountId), 'emails');
        must(in_array((string) $emails['own']->id, $links, true) && in_array((string) $emails['foreign']->id, $links, true),
            'Both allowed-first and forbidden-second native links must remain present');
    });
    check('HTTP reads preserve Email content, headers, relationships, ownership and native lifecycle', static function () use ($fingerprint, $users, $statusBefore): void {
        must(hash_equals($fingerprint, fixtureMessageFingerprint()), 'Native HTTP reads changed Email data or security relationships');
        foreach ($users as $label => $user) must(fresh('Users', (string) $user->id)->status === $statusBefore[$label], 'HTTP acceptance must not disable or change a principal status');
    });
    foreach ($clients as $client) curl_close($client);
    unset($tokens, $passwords, $clientSecret);
    fwrite(STDOUT, "NATIVE_HTTP_PROOF_BOUNDARY=allowed getEmail2DetailView rendering excluded: pinned stock null DetailView bug; forbidden requests must still deny before rendering; no browser layout or production acceptance.\n");
    fwrite(STDOUT, "NATIVE_HTTP_ACCEPTANCE_PASSED=checks={$checks}; real loopback OAuth and legacy sessions; synthetic only; no browser-layout or production proof.\n");
} catch (Throwable $error) {
    // Assertion messages never include HTTP bodies, tokens, cookies or passwords.
    fwrite(STDERR, 'Native HTTP acceptance failed: '.get_class($error).': '.$error->getMessage()."\n");
    exit(1);
}
