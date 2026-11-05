<?php
declare(strict_types=1);

// Disposable synthetic proof only. This is NOT a production endpoint/profile.
// The policy digest detects observed drift; it does NOT fence stock native admin
// writes, filesystem changes, application-DB membership changes, or other writers.
final class LifecycleRefused extends RuntimeException {}

function lifecycleSql(string $sql)
{
    $result = DBManagerFactory::getInstance()->query($sql, false);
    if ($result === false || $result === null) throw new LifecycleRefused('Checked native SQL failed');
    return $result;
}
function lifecycleRows(string $sql, ?mysqli $observer = null): array
{
    $result = $observer === null ? lifecycleSql($sql) : $observer->query($sql);
    if (!$result instanceof mysqli_result) throw new LifecycleRefused('Native result set required');
    $resultRows = $result->fetch_all(MYSQLI_ASSOC);
    $result->free();
    return $resultRows;
}
function lifecycleQ(string $value): string { return "'".quote($value)."'"; }
function lifecycleDigest(array $value): string { return hash('sha256', json_encode($value, JSON_THROW_ON_ERROR)); }

function lifecycleRuntimeDigest(): string
{
    $manifest = json_decode((string) file_get_contents('/app/native-remediation-patch-hashes.json'), true, 32, JSON_THROW_ON_ERROR);
    $expected = [
        'Api/V8/Service/ModuleService.php'=>'d782d797c21cc5d481d71b8293caa3c7533e25243568c89fae06e11b52bfca41',
        'Api/V8/Service/RelationshipService.php'=>'090e532de833e4c6c8d18b83901665b79e39141506a217923b7c4f4228ae3587',
        'modules/Emails/EmailUIAjax.php'=>'fc4ae1c13879933904f1cc6885d2867daab2002cf9fc81cad69217f8e352e70d',
        'modules/Emails/Email.php'=>'ecf478158789089a3c9eefc81ec715a4195915a9444d0f7b17db78ac2d32f766',
        'include/SugarFolders/SugarFolders.php'=>'1a382a05b92b6a1dbba0a48a27f72c731cb16a3153f743c4756f8693a5e086d6',
        'modules/SecurityGroups/SecurityGroup.php'=>'da20649972446f5810ae293fc3434649df7086796917e4f9684ec9e3140aad65',
    ];
    $paths = array_map(static fn ($path) => '/app/public/legacy/'.$path, array_keys($expected));
    sort($paths, SORT_STRING); $actual = array_keys($manifest); sort($actual, SORT_STRING);
    must($actual === $paths, 'Exactly the six prepared candidate files must be attested');
    foreach ($expected as $relative => $hash) {
        $path='/app/public/legacy/'.$relative;
        must(is_string($manifest[$path]) && hash_equals($hash,$manifest[$path])
            && is_file($path) && !is_link($path) && hash_equals($hash,hash_file('sha256',$path)), 'Prepared native file drift');
    }
    return lifecycleDigest([$manifest, hash_file('sha256', '/fixture/remediation-read-scope.php')]);
}

function lifecycleProfile(): void
{
    global $sugar_config;
    must(PHP_SAPI === 'cli' && getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') === '1'
        && realpath('.') === '/app/public/legacy'
        && ($sugar_config['dbconfig']['db_name'] ?? '') === 'suitecrm_native_test'
        && ($sugar_config['dbconfig']['db_host_name'] ?? '') === 'db'
        && ($sugar_config['dbconfig']['db_user_name'] ?? '') === 'fixture', 'Only the disposable native database is admitted');
    must(!($sugar_config['email_enable_auto_send_opt_in'] ?? false), 'Automatic opt-in mail must be disabled');
    must($_REQUEST === [], 'No UI request context or implicit parent/group selection is admitted');
    foreach (['securitysuite_inherit_creator','securitysuite_inherit_assigned','securitysuite_inherit_parent'] as $flag) {
        must(($sugar_config[$flag] ?? null) === true, 'Only the unchanged stock inheritance profile is admitted');
    }
    $pins = [
        'data/SugarBean.php' => '5edf1050ee0ad01c1de57f235ebae55bab2e5476f58d979ebfc8eb14fc155547',
        'modules/SecurityGroups/SecurityGroup.php' => 'da20649972446f5810ae293fc3434649df7086796917e4f9684ec9e3140aad65',
        'modules/ACLActions/ACLAction.php' => 'eee9139f7b88d3a3719754f835f2bb5e48af85cbcc51274c94a8bad3dcb67fbd',
        'modules/SecurityGroups/AssignGroups.php' => '6612368834eacd66a011b2b032645d86d5d269791c1b8d4985dc71ddc7767af6',
        'modules/AOW_WorkFlow/AOW_WorkFlow.php' => '4c7848085db5153a7a337aca7acfc63c198a5eb3da60421da045f510da2e4010',
        'include/utils/LogicHook.php' => 'f9ccbeacd358951cba447b1b746a476177b5d0e7b2d2e267d44294fa54184e38',
        'include/portability/SaveHandlers/BeanSaveHandlers.php' => '359b0068effdcea6917f2f5e096fb216265ede8931f3902fef7a0a3e472d88d2',
        'include/portability/SaveHandlers/BeanSaveHandlersManager.php' => '2af90844b6cec1d5e3154e32d3cecbaeb8a8ba9dc84c0f4e672fcab8dcd070b8',
        'include/portability/SaveHandlers/TypeSaveHandlers/BeanMultiRelateSaveHandler.php' => '8ff9df346b8dac93f78e081f53b66f6d620888e7ddd8be4a21252f950697b755',
        'include/portability/LineItems/BeanLineItemSaveHandler.php' => '254fe0532a4e17f1e12bdc0fba32214d34e9d9e38d2a9d9846c8cda2b7dffb9c',
        'lib/Search/ElasticSearch/ElasticSearchHooks.php' => '54e26d3da41b906e76e6dbcfb5a2e0dee79d69b3da56e49b1f98a43cfdba0aec',
        'lib/Search/ElasticSearch/ElasticSearchIndexer.php' => '607f7466df2884d2c673dfcc9daddb4a8e69d0bac45336a4c124ec930e58027b',
        'include/social/hooks.php' => 'af6dd8b8d773a5f1f8caf273391d9334b497c88a95470df26e4256ce03cd241e',
        'modules/AOP_Case_Updates/CaseUpdatesHook.php' => '3e9843dd66b23c051d22ed835dbf4ad9e3b5c222441aebba59e4e1339bbd1cd7',
    ];
    foreach ($pins as $path => $hash) must(hash_equals($hash, hash_file('sha256', $path)), 'Unreviewed native source: '.$path);
    must(hash_equals(hash_file('sha256', '/fixture/remediation-read-scope.php'), hash_file('sha256', 'custom/ClawPilotNativeEmailScope.php')),
        'The accepted local read-scope candidate must be installed');
    $expectedHooks = [
        'after_save' => [[1,'ElasticSearch Index Changes','lib/Search/ElasticSearch/ElasticSearchHooks.php','SuiteCRM\\Search\\ElasticSearch\\ElasticSearchHooks','beanSaved'],
            [30,'popup_select','modules/SecurityGroups/AssignGroups.php','AssignGroups','popup_select'],
            [99,'AOW_Workflow','modules/AOW_WorkFlow/AOW_WorkFlow.php','AOW_WorkFlow','run_bean_flows']],
        'after_delete' => [[1,'ElasticSearch Index Changes','lib/Search/ElasticSearch/ElasticSearchHooks.php','SuiteCRM\\Search\\ElasticSearch\\ElasticSearchHooks','beanDeleted']],
        'after_ui_footer' => [[10,'popup_onload','modules/SecurityGroups/AssignGroups.php','AssignGroups','popup_onload']],
        'after_ui_frame' => [[1,'Load Social JS','include/social/hooks.php','hooks','load_js'],
            [20,'mass_assign','modules/SecurityGroups/AssignGroups.php','AssignGroups','mass_assign']],
    ];
    $normalize = static function (array $hooks): array {
        foreach ($hooks as &$entries) { $entries = array_values($entries); usort($entries, static fn ($a,$b) => $a[0] <=> $b[0]); }
        unset($entries); ksort($hooks); return $hooks;
    };
    $hooks = LogicHook::initialize();
    must($normalize($hooks->getHooks('', true)) === $normalize($expectedHooks), 'Unknown application hooks must hold');
    must(\SuiteCRM\Search\ElasticSearch\ElasticSearchIndexer::isEnabled() === false, 'External indexing must be disabled');
    $moduleHooks = ['Emails' => ['after_save' => [[10,'Save email case updates','modules/AOP_Case_Updates/CaseUpdatesHook.php','CaseUpdatesHook','saveEmailUpdate']]], 'SecurityGroups' => []];
    foreach (['Emails','SecurityGroups'] as $module) {
        must($normalize($hooks->getHooks($module, true)) === $normalize($moduleHooks[$module])
            && !isset($GLOBALS['customBeanList'][$module]), 'Unknown module hooks/beans must hold');
        // Pinned stock setRegistry() also copies TYPE_BEFORE into the after
        // registry, then appends the multi-relate handler in its constructor.
        foreach (['before' => ['BeanLineItemSaveHandler'], 'after' => ['BeanLineItemSaveHandler','BeanMultiRelateSaveHandler']] as $phase => $classes) {
            $actual = array_map('get_class', BeanSaveHandlers::getInstance()->get($module, $phase));
            must($actual === $classes, 'Unknown '.$module.' '.$phase.' save handlers must hold: '.implode(',', $actual));
        }
    }
    must(lifecycleRows("SELECT id FROM aow_workflow WHERE deleted=0 AND status='Active'") === [], 'Active native workflows must hold');
    must(lifecycleRows('SELECT id FROM securitygroups_default WHERE deleted=0') === [], 'Default/inherited group rules must hold');
}

function lifecyclePolicyDigest(): string
{
    $policy = [];
    foreach (['users','acl_actions','acl_roles','acl_roles_actions','acl_roles_users','securitygroups',
        'securitygroups_users','securitygroups_acl_roles','securitygroups_default','aow_workflow'] as $table) {
        $policy[$table] = lifecycleRows('SELECT * FROM '.$table.' ORDER BY id');
    }
    return lifecycleDigest($policy);
}

/** Simulate every installed principal, including inactive users, before commit. */
function lifecycleAssertReaders(array $context, array $policy, string $emailId): void
{
    $savedUser = $GLOBALS['current_user']; $savedSession = $_SESSION;
    $members = json_decode($policy['members_json'], true, 32, JSON_THROW_ON_ERROR);
    must(is_array($members), 'Exact native principal set is required');
    sort($members, SORT_STRING);
    $actualMembers = array_column(lifecycleRows('SELECT user_id FROM securitygroups_users WHERE deleted=0 AND securitygroup_id='.
        lifecycleQ($policy['group_id']).' ORDER BY user_id'), 'user_id');
    must($members === $actualMembers, 'Native group membership must match the exact pipeline policy');
    $expected = array_values(array_unique(array_merge([$context['adminId']], $members)));
    sort($expected, SORT_STRING);
    $actual = ['view'=>[], 'list'=>[], 'export'=>[]];
    try {
        foreach (lifecycleRows('SELECT id FROM users WHERE deleted=0 ORDER BY id') as $user) {
            selectUser(fresh('Users', $user['id']));
            $email = fresh('Emails', $emailId);
            foreach (array_keys($actual) as $surface) if ($email->ACLAccess($surface)) $actual[$surface][] = $user['id'];
        }
        foreach ($actual as $surface => $ids) must($ids === $expected, 'Native effective '.$surface.' readers differ from exact pipeline policy');
    } finally {
        $GLOBALS['current_user'] = $savedUser; $_SESSION = $savedSession;
    }
}

function lifecycleResultDigest(array $command): string
{
    $result = [];
    foreach ($command['emails'] as $input) $result[$input['id']] = [lifecycleEmailSnapshot($input['id']), lifecycleGroups($input['id'])];
    return lifecycleDigest($result);
}
function lifecycleStateDigest(?mysqli $observer = null): string
{
    $state = [];
    foreach (['emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c','emails_beans'=>'id',
        'emails_email_addr_rel'=>'id','email_addresses'=>'id','email_addr_bean_rel'=>'id','securitygroups_records'=>'id',
        'securitygroups_users'=>'id','cp_fixture_email_policy'=>'pipeline_id','cp_fixture_email_map'=>'email_id',
        'cp_fixture_email_receipt'=>'operation_id'] as $table => $key) {
        $state[$table] = lifecycleRows('SELECT * FROM '.$table.' ORDER BY '.$key, $observer);
    }
    return lifecycleDigest($state);
}
function lifecycleEmailSnapshot(string $id, ?mysqli $observer = null): array
{
    $snapshot = [];
    foreach (['emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c','emails_beans'=>'email_id','emails_email_addr_rel'=>'email_id'] as $table => $column) {
        $data = lifecycleRows('SELECT * FROM '.$table.' WHERE '.$column.'='.lifecycleQ($id), $observer);
        usort($data, static fn ($a,$b) => strcmp(json_encode($a), json_encode($b)));
        $snapshot[$table] = $data;
    }
    return $snapshot;
}
function lifecycleBegin(): int
{
    $db = DBManagerFactory::getInstance();
    must($db instanceof MysqliManager && $db->database instanceof mysqli, 'Pinned mysqli connection required');
    must((int) lifecycleRows('SELECT @@in_transaction AS active')[0]['active'] === 0, 'Do not nest native transactions');
    lifecycleSql('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    lifecycleSql('START TRANSACTION');
    return (int) lifecycleRows('SELECT CONNECTION_ID() AS id')[0]['id'];
}
function lifecycleEnd(int $connection, bool $commit): void
{
    $state = lifecycleRows('SELECT CONNECTION_ID() AS id, @@in_transaction AS active')[0];
    must((int) $state['id'] === $connection && (int) $state['active'] === 1, 'Native transaction escaped or changed connection');
    lifecycleSql($commit ? 'COMMIT' : 'ROLLBACK');
    must((int) lifecycleRows('SELECT @@in_transaction AS active')[0]['active'] === 0, 'Native transaction must end');
}
function lifecycleGroups(string $emailId): array
{
    return array_column(lifecycleRows("SELECT securitygroup_id FROM securitygroups_records WHERE deleted=0 AND module='Emails' AND record_id=".
        lifecycleQ($emailId).' ORDER BY securitygroup_id'), 'securitygroup_id');
}

/** Trusted synthetic registry is the authority; subject/company labels are not. */
function lifecycleApply(array $context, array $command, ?callable $beforeCommit = null): string
{
    lifecycleProfile();
    must(($GLOBALS['current_user']->id ?? '') === $context['adminId'] && $GLOBALS['current_user']->isAdmin(), 'Pinned native writer required');
    if (!hash_equals($context['frozenRuntime'], lifecycleRuntimeDigest())) throw new LifecycleRefused('Frozen native runtime drift');
    if (!hash_equals($context['frozenPolicy'], lifecyclePolicyDigest())) throw new LifecycleRefused('Frozen native policy drift');
    $connection = lifecycleBegin();
    try {
        $policies = lifecycleRows('SELECT * FROM cp_fixture_email_policy WHERE workspace_id='.lifecycleQ($command['workspace']).
            ' AND pipeline_id='.lifecycleQ($command['pipeline']).' FOR UPDATE');
        if (count($policies) !== 1 || (int) $policies[0]['version'] !== $command['version']) throw new LifecycleRefused('Policy version/binding drift');
        $policy = $policies[0];
        $groupRow = lifecycleRows('SELECT id FROM securitygroups WHERE deleted=0 AND noninheritable=1 AND id='.lifecycleQ($policy['group_id']));
        if (count($groupRow) !== 1) throw new LifecycleRefused('Managed group identity/inheritance drift');
        $digest = lifecycleDigest($command);
        $receipts = lifecycleRows('SELECT * FROM cp_fixture_email_receipt WHERE operation_id='.lifecycleQ($command['operation']).' FOR UPDATE');
        $replayed = count($receipts) === 1;
        if ($replayed) {
            if (!hash_equals($receipts[0]['command_hash'], $digest)) throw new LifecycleRefused('Retry changed its command');
        }
        if (!in_array($command['mode'], ['repair','publish'], true) || !$command['emails']) throw new LifecycleRefused('Unsupported lifecycle command');
        foreach ($command['emails'] as $input) {
            $mapping = lifecycleRows('SELECT * FROM cp_fixture_email_map WHERE email_id='.lifecycleQ($input['id']).' FOR UPDATE');
            if (count($mapping) !== 1 || $mapping[0]['global_id'] !== $input['globalId']
                || $mapping[0]['workspace_id'] !== $command['workspace'] || $mapping[0]['pipeline_id'] !== $command['pipeline']) {
                throw new LifecycleRefused('Missing or different exact pipeline mapping');
            }
            $existing = lifecycleRows('SELECT id,assigned_user_id,created_by,deleted FROM emails WHERE id='.lifecycleQ($input['id']).' FOR UPDATE');
            $before = lifecycleEmailSnapshot($input['id']);
            $globalIds = array_column(lifecycleRows('SELECT id_c FROM emails_cstm WHERE global_id_c='.lifecycleQ($input['globalId']).' ORDER BY id_c'), 'id_c');
            if ($globalIds !== (($command['mode'] === 'repair' || $replayed) ? [$input['id']] : [])) {
                throw new LifecycleRefused('Duplicate or changed native Global ID');
            }
            $groups = lifecycleGroups($input['id']);
            if ($groups !== [] && $groups !== [$policy['group_id']]) throw new LifecycleRefused('Unknown or inherited Email group');
            if ($command['mode'] === 'repair' || $replayed) {
                if (count($existing) !== 1 || (int) $existing[0]['deleted'] !== 0
                    || $existing[0]['assigned_user_id'] !== $context['adminId'] || $existing[0]['created_by'] !== $context['adminId']
                    || ($before['emails_cstm'][0]['global_id_c'] ?? '') !== $input['globalId']) throw new LifecycleRefused('Historical identity/ownership drift');
                if ($command['mode'] === 'repair' && !hash_equals($input['expectedContentFingerprint'], lifecycleDigest($before))) {
                    throw new LifecycleRefused('Historical content fingerprint drift');
                }
            } else {
                if ($existing || $groups) throw new LifecycleRefused('Future publication must be new or an exact receipt retry');
                $email = native('Emails'); $email->id = $input['id']; $email->new_with_id = true;
                $email->global_id_c = $input['globalId']; $email->assigned_user_id = $context['adminId'];
                $email->type = 'archived'; $email->status = 'read'; $email->parent_type = ''; $email->parent_id = '';
                $email->name = $input['name']; $email->description = $input['body']; $email->description_html = '';
                $email->from_addr_name = 'sender@fixture.example.test'; $email->to_addrs_names = 'recipient@fixture.example.test';
                $email->date_sent_received = '2026-10-29 12:00:00';
                must($email->save(false) === $input['id'], 'Actual native Email save must preserve supplied identity');
                if (lifecycleGroups($input['id']) !== []) throw new LifecycleRefused('Native save introduced an inherited group');
                $saved = lifecycleEmailSnapshot($input['id']);
                must(($saved['emails_cstm'][0]['global_id_c'] ?? '') === $input['globalId']
                    && ($saved['emails_text'][0]['description'] ?? '') === $input['body'], 'Native raw identity/plain-body readback must match');
            }
            if ($replayed && $groups !== [$policy['group_id']]) throw new LifecycleRefused('Retry native group drift');
            if ($groups === []) fresh('SecurityGroups', $policy['group_id'])->addGroupToRecord('Emails', $input['id'], $policy['group_id']);
            must(lifecycleGroups($input['id']) === [$policy['group_id']], 'Exactly the verified pipeline group is required');
            if ($command['mode'] === 'repair') must(lifecycleEmailSnapshot($input['id']) === $before, 'Historical repair must not save/rewrite Email rows or relationships');
            lifecycleAssertReaders($context, $policy, $input['id']);
        }
        if (!hash_equals($context['frozenPolicy'], lifecyclePolicyDigest())) throw new LifecycleRefused('Observed native policy drift before commit');
        $resultHash = lifecycleResultDigest($command);
        if ($replayed && !hash_equals($receipts[0]['result_hash'], $resultHash)) throw new LifecycleRefused('Retry native record drift');
        if (!$replayed && $beforeCommit !== null) $beforeCommit();
        if (!$replayed) lifecycleSql('INSERT INTO cp_fixture_email_receipt(operation_id,command_hash,result_hash) VALUES ('.
            lifecycleQ($command['operation']).','.lifecycleQ($digest).','.lifecycleQ($resultHash).')');
        lifecycleEnd($connection, true);
        return $replayed ? 'replayed' : 'applied';
    } catch (Throwable $error) {
        lifecycleEnd($connection, false);
        throw $error;
    }
}
