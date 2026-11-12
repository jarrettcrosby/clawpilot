<?php
declare(strict_types=1);

// This test has no caller-supplied target. It runs only inside the isolated
// upgrade harness and uses its already-seeded synthetic accounts and contacts.
const ROOT = '/app/public/legacy';
const PORT = 8100;

function need(bool $ok, string $message): void
{
    if (!$ok) throw new RuntimeException($message);
}

need(getenv('CLAWPILOT_UPGRADE_OAUTH_FIXTURE') === '1'
    && file_get_contents('/app/VERSION') === "8.10.2\n"
    && is_file('/tmp/rehearsal-record.json'), 'Isolated 8.10.2 upgrade fixture required');

if (PHP_SAPI === 'cli-server') {
    if (($_SERVER['REMOTE_ADDR'] ?? '') !== '127.0.0.1'
        || ($_SERVER['HTTP_HOST'] ?? '') !== '127.0.0.1:'.PORT
        || !in_array(parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH),
            ['/Api/access_token', '/Api/V8/custom/clawpilot-email-shared'], true)) {
        http_response_code(404);
        exit;
    }
    $_SERVER['SCRIPT_NAME'] = $_SERVER['PHP_SELF'] = '/Api/index.php';
    $_SERVER['SCRIPT_FILENAME'] = ROOT.'/Api/index.php';
    require ROOT.'/Api/Core/app.php';
    $app->run();
    return;
}

need(PHP_SAPI === 'cli' && chdir(ROOT), 'Synthetic fixture CLI required');
define('sugarEntry', true);
require 'include/entryPoint.php';
require_once 'modules/ACLActions/ACLAction.php';
require_once 'modules/DynamicFields/DynamicField.php';
require_once 'modules/DynamicFields/FieldCases.php';

function rows(string $sql): array
{
    $db = DBManagerFactory::getInstance();
    $result = $db->query($sql, true);
    $rows = [];
    while ($row = $db->fetchByAssoc($result, false)) $rows[] = $row;
    return $rows;
}

function post(string $path, string $body, string $type, ?string $token = null): array
{
    $ch = curl_init('http://127.0.0.1:'.PORT.$path);
    $headers = ['Accept: application/vnd.api+json', 'Content-Type: '.$type];
    if ($token !== null) $headers[] = 'Authorization: Bearer '.$token;
    $response = '';
    $cache = '';
    curl_setopt_array($ch, [CURLOPT_POST=>true, CURLOPT_POSTFIELDS=>$body, CURLOPT_HTTPHEADER=>$headers,
        CURLOPT_PROXY=>'', CURLOPT_CONNECTTIMEOUT=>2, CURLOPT_TIMEOUT=>15, CURLOPT_PROTOCOLS=>CURLPROTO_HTTP,
        CURLOPT_FOLLOWLOCATION=>false, CURLOPT_WRITEFUNCTION=>static function ($curl, string $chunk) use (&$response): int {
            if (strlen($response) + strlen($chunk) > 65536) return 0;
            $response .= $chunk;
            return strlen($chunk);
        }, CURLOPT_HEADERFUNCTION=>static function ($curl, string $line) use (&$cache): int {
            if (stripos($line, 'cache-control:') === 0) $cache = trim(substr($line, 14));
            return strlen($line);
        }]);
    try {
        need(curl_exec($ch) !== false, 'Fixture-only loopback request failed');
        return [(int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE), json_decode($response, true), $cache];
    } finally { curl_close($ch); }
}

function historyCount(string $accountId, string $emailId): int
{
    $previous = $GLOBALS['app'] ?? null;
    try {
        $account = BeanFactory::getBean('Accounts', $accountId);
        need($account instanceof Account && $account->id === $accountId, 'Account history seed required');
        $GLOBALS['app'] = (object)['controller'=>(object)['bean'=>$account]];
        $query = get_emails_by_assign_or_link(['link'=>'contacts']);
        need(isset($query['select'], $query['from'], $query['join'], $query['where']), 'Stock Account history query required');
        return count(array_filter(array_column(rows($query['select'].$query['from'].$query['join'].$query['where']), 'id'),
            static fn (string $value): bool => $value === $emailId));
    } finally {
        if ($previous === null) unset($GLOBALS['app']);
        else $GLOBALS['app'] = $previous;
    }
}

try {
    need(($sugar_config['dbconfig']['db_name'] ?? '') === 'suitecrm_upgrade_fixture'
        && ($sugar_config['dbconfig']['db_host_name'] ?? '') === 'db', 'Synthetic database required');
    $seed = json_decode(file_get_contents('/tmp/rehearsal-record.json'), true, 8, JSON_THROW_ON_ERROR);
    foreach (['accounts', 'contacts'] as $key) {
        need(is_array($seed[$key] ?? null) && count($seed[$key]) === 2, 'Two synthetic associations required');
        foreach ($seed[$key] as $id) need(is_string($id) && preg_match('/\A[a-f0-9-]{36}\z/', $id) === 1, 'Invalid synthetic identity');
    }
    $admins = rows("SELECT id FROM users WHERE user_name='fixture-admin' AND status='Active' AND deleted=0 AND is_admin=1");
    need(count($admins) === 1, 'Stock fixture administrator required');
    $admin = BeanFactory::getBean('Users', $admins[0]['id']);
    $GLOBALS['current_user'] = $admin;
    $_SESSION = [];
    ACLAction::getUserActions((string)$admin->id, true);

    $email = BeanFactory::newBean('Emails');
    $dynamic = new DynamicField('Emails');
    $dynamic->setup($email);
    if (!$dynamic->getFieldWidget('Emails', 'global_id_c')) {
        need(getenv('CLAWPILOT_UPGRADE_OAUTH_FIELD_READY') !== '1', 'Synthetic Global ID field did not persist');
        $field = get_widget('varchar');
        $field->name = 'global_id';
        $field->label = $field->vname = 'LBL_GLOBAL_ID';
        $field->label_value = 'Fixture Global ID';
        $field->len = '32';
        $field->required = false;
        $field->audited = false;
        $field->reportable = true;
        $field->save($dynamic);
        VardefManager::clearVardef('Emails', 'Email');
        unset($GLOBALS['dictionary']['Email']);
        VardefManager::refreshVardefs('Emails', 'Email');
        // BeanFactory and DynamicField may retain the pre-create definitions in
        // this process. The actual OAuth web request also starts from a clean
        // runtime. Re-enter once after the fixture-only field has been saved.
        putenv('CLAWPILOT_UPGRADE_OAUTH_FIELD_READY=1');
        $readback = proc_open([PHP_BINARY, '-d', 'memory_limit=256M', '-d', 'display_errors=stderr', '-d',
            'error_reporting=22527', __FILE__], [0=>STDIN, 1=>STDOUT, 2=>STDERR], $pipes);
        need(is_resource($readback), 'Synthetic Global ID fresh readback could not start');
        exit(proc_close($readback));
    }
    need(($email->field_defs['global_id_c']['type'] ?? null) === 'varchar'
        && (int)($email->field_defs['global_id_c']['len'] ?? 0) >= 32, 'Synthetic Global ID must be loaded in the Email bean');

    $source = __DIR__.'/source/email-audience';
    require_once $source.'/NativeEmailProjection.php';
    $connection = DBManagerFactory::getInstance()->database;
    need($connection instanceof mysqli, 'Native MariaDB connection required');
    $connection->set_charset('utf8mb4');
    $_REQUEST = [];
    $tx = ClawPilotNativeEmailTransaction::begin($connection, ['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_upgrade_fixture']);
    try {
        need(strlen(ClawPilotNativeEmailRuntime::attestSharedWorkerSource($connection)) === 64, 'Upgraded stock profile required');
    } finally { $tx->rollback(); }
    fwrite(STDOUT, "PASS SuiteCRM 8.10.2 live stock Email worker attestation\n");

    $client = BeanFactory::newBean('OAuth2Clients');
    $client->name = 'Disposable 8.10.2 shared worker';
    $client->allowed_grant_type = 'client_credentials';
    $client->is_confidential = 1;
    $client->assigned_user_id = $admin->id;
    $secret = 'synthetic-only-'.bin2hex(random_bytes(24));
    $_REQUEST = ['new_secret'=>$secret, 'duration_amount'=>1, 'duration_unit'=>'hour'];
    try { need((bool)$client->save(false), 'Synthetic stock OAuth client required'); }
    finally { $_REQUEST = []; }

    $key = openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA, 'private_key_bits'=>2048]);
    need($key instanceof OpenSSLAsymmetricKey && openssl_pkey_export($key, $private), 'Synthetic signing key required');
    foreach (['private.key'=>$private, 'public.key'=>openssl_pkey_get_details($key)['key']] as $name=>$bytes) {
        $path = ROOT.'/Api/V8/OAuth2/'.$name;
        if (!is_file($path)) need(file_put_contents($path, $bytes, LOCK_EX) === strlen($bytes) && chmod($path, 0600), 'Synthetic key stage failed');
    }
    unset($key, $private, $bytes);
    if (empty($sugar_config['oauth2_encryption_key'])) {
        $override = ROOT.'/config_override.php';
        $base = is_file($override) ? file_get_contents($override) : "<?php\n";
        need(is_string($base) && str_starts_with(ltrim($base), '<?php'), 'Synthetic config required');
        $config = preg_replace('/\?>\s*$/', '', $base)."\n\$sugar_config['oauth2_encryption_key'] = "
            .var_export(bin2hex(random_bytes(32)), true).";\n";
        need(file_put_contents($override, $config, LOCK_EX) === strlen($config), 'Synthetic config stage failed');
    }

    $router = ROOT.'/custom/application/Ext/Api/V8/Config/routes.php';
    $directory = dirname($router);
    need((is_dir($directory) || mkdir($directory, 0755, true)) && !file_exists($router), 'Fresh synthetic custom route only');
    // The rehearsal image filesystem is read-only. This substitutes only the
    // include location; the PHP route and the worker code are otherwise exact.
    $route = str_replace("'/opt/clawpilot/email-audience/SharedBpoEmailWorker.php'", var_export($source.'/SharedBpoEmailWorker.php', true),
        file_get_contents($source.'/shared-worker-routes.php'), $replacements);
    need($replacements === 1 && file_put_contents($router, $route, LOCK_EX) === strlen($route), 'Fixture route stage failed');
    $templates = rows("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='emails_email_templates'") !== [];
    putenv('SUITECRM_CLIENT_ID='.$client->id);
    putenv('CLAWPILOT_SHARED_BPO_EMAIL_ENABLED=1');
    putenv('CLAWPILOT_SHARED_BPO_EMAIL_TEMPLATES='.($templates ? '1' : '0'));
    $listener = proc_open([PHP_BINARY, '-d', 'display_errors=0', '-S', '127.0.0.1:'.PORT, '-t', ROOT, __FILE__],
        [0=>['file','/dev/null','r'], 1=>['file','/tmp/upgrade-oauth-smoke.log','a'], 2=>['file','/tmp/upgrade-oauth-smoke.log','a']], $pipes);
    need(is_resource($listener), 'Fixture HTTP listener start failed');
    try {
        $ready = false;
        for ($i = 0; $i < 40; $i++) {
            $socket = @fsockopen('127.0.0.1', PORT, $errno, $error, 0.1);
            if (is_resource($socket)) { fclose($socket); $ready = true; break; }
            usleep(50000);
        }
        need($ready, 'Fixture HTTP listener unavailable');
        [$status, $token] = post('/Api/access_token', http_build_query(['grant_type'=>'client_credentials',
            'client_id'=>$client->id, 'client_secret'=>$secret]), 'application/x-www-form-urlencoded');
        need($status === 200 && is_string($token['access_token'] ?? null), 'Stock OAuth token was not issued, HTTP '.$status);
        $subject = 'Synthetic 8.10.2 OAuth shared Email';
        $global = 'gi9810201';
        $id = create_guid();
        $bindings = [];
        foreach ($seed['contacts'] as $i=>$contact) $bindings[] = ['contactId'=>$contact,'accountId'=>$seed['accounts'][$i]];
        $projection = ClawPilotNativeEmailProjection::validate(['suiteCrmId'=>$id, 'attributes'=>[
            'global_id_c'=>$global,'name'=>$subject,'date_sent_received'=>'2026-11-09T13:00:00Z','type'=>'archived','status'=>'read',
            'parent_type'=>'Accounts','parent_id'=>$seed['accounts'][0],'assigned_user_id'=>$admin->id,
            'description'=>'Synthetic isolated shared-email smoke.', 'description_html'=>'',
            'from_addr_name'=>'Fixture Sender <sender@example.test>',
            'to_addrs_names'=>'recipient@example.test <recipient@example.test>, second@example.test <second@example.test>',
            'cc_addrs_names'=>'copy@example.test <copy@example.test>, Distinct Copy <other@example.test>',
        ], 'accounts'=>$seed['accounts'], 'contacts'=>$seed['contacts'], 'contactAccounts'=>$bindings,
            'previousManaged'=>['accounts'=>[],'contacts'=>[]], 'expectedBeforeFingerprint'=>null]);
        $wire = json_encode(['version'=>1,'workspaceId'=>'c6c49765-9bf6-4223-9261-7553499f5d92',
            'pipelineId'=>'587c8746-ecf6-40ae-8c50-e456f99ad555','localId'=>create_guid(),
            'sourceRevision'=>hash('sha256','synthetic 8.10.2 OAuth retry'), 'projection'=>$projection], JSON_THROW_ON_ERROR);
        $path = '/Api/V8/custom/clawpilot-email-shared';
        $type = 'application/vnd.api+json';
        [$anonymous] = post($path, $wire, $type);
        need($anonymous === 401, 'Stock OAuth middleware did not deny anonymous request');
        [$status, $first, $cache] = post($path, $wire, $type, $token['access_token']);
        need($status === 200 && ($first['suiteCrmId'] ?? null) === $id && ($first['globalId'] ?? null) === $global
            && ($first['accounts'] ?? null) === $projection['accounts'] && ($first['contacts'] ?? null) === $projection['contacts']
            && $cache === 'private, no-store', 'Stock OAuth worker create did not succeed, HTTP '.$status.' '.($first['code'] ?? ''));
        [$status, $second] = post($path, $wire, $type, $token['access_token']);
        need($status === 200 && $second === $first, 'Exact OAuth retry must preserve the first receipt');
        need(rows("SELECT id_c FROM emails_cstm WHERE global_id_c='$global'") === [['id_c'=>$id]]
            && rows("SELECT id,parent_id FROM emails WHERE name='$subject' AND deleted=0") === [['id'=>$id,'parent_id'=>$seed['accounts'][0]]],
            'OAuth replay did not preserve exactly one native email and its primary account');
        need(rows("SELECT to_addrs,cc_addrs FROM emails_text WHERE email_id='$id' AND deleted=0")
            === [['to_addrs'=>'recipient@example.test, second@example.test',
                'cc_addrs'=>'copy@example.test, Distinct Copy <other@example.test>']],
            'Stock shared Email must preserve recipients and distinct display labels on both To and Cc');
        $links = [];
        foreach (['Accounts'=>'accounts','Contacts'=>'contacts'] as $module=>$list) {
            foreach ($projection[$list] as $related) $links[] = ['bean_module'=>$module,'bean_id'=>$related];
        }
        need(rows("SELECT bean_module,bean_id FROM emails_beans WHERE email_id='$id' AND deleted=0 ORDER BY bean_module,bean_id") === $links,
            'OAuth email did not keep its exact two accounts and two contacts');
        foreach ($projection['accounts'] as $account) need(historyCount($account, $id) === 1, 'Both stock Account histories must contain the same email once');
        fwrite(STDOUT, "PASS real OAuth create and exact retry: one native email, two account histories, two contacts\n");
    } finally {
        proc_terminate($listener);
        proc_close($listener);
        unlink($router);
    }
} catch (Throwable $error) {
    $diagnostic = $error instanceof ClawPilotNativeEmailTransactionRefused || $error instanceof ClawPilotNativeEmailProjectionRefused
        ? ' '.($error->diagnostic ?? '') : '';
    fwrite(STDERR, 'OAuth fixture held: '.$error->getMessage().$diagnostic."\n");
    exit(1);
}
