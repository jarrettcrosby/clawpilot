<?php
declare(strict_types=1);

// Real installed SuiteCRM 8.10.1 + its MariaDB schema only. No native class,
// method, DB manager, ACL controller or relationship implementation is mocked.
if (PHP_SAPI !== 'cli' || trim((string) file_get_contents('/app/VERSION')) !== '8.10.1') {
    throw new RuntimeException('The pinned installed SuiteCRM 8.10.1 fixture is required');
}
if (!chdir('/app/public/legacy') || !is_file('config.php')) {
    throw new RuntimeException('An installed disposable SuiteCRM legacy runtime is required');
}
define('sugarEntry', true);
require_once 'include/entryPoint.php';
require_once 'modules/ACLActions/ACLAction.php';
require_once 'modules/ACLRoles/ACLRole.php';
require_once 'modules/SecurityGroups/SecurityGroup.php';
require_once 'modules/DynamicFields/DynamicField.php';
require_once 'modules/DynamicFields/FieldCases.php';
require_once 'include/SugarObjects/VardefManager.php';
require_once 'include/export_utils.php';
require_once 'include/ListView/ListViewData.php';
require_once '/source/email-audience/EmailAudience.php';

$checks = 0;
function must(bool $value, string $message): void
{
    if (!$value) throw new RuntimeException($message);
}
function check(string $name, callable $run): void
{
    $run();
    $GLOBALS['checks']++;
    fwrite(STDOUT, "PASS {$name}\n");
}
function rows(string $sql): array
{
    $db = DBManagerFactory::getInstance();
    $result = $db->query($sql, true);
    $rows = [];
    while ($row = $db->fetchByAssoc($result, false)) $rows[] = $row;
    return $rows;
}
function quote(string $value): string { return DBManagerFactory::getInstance()->quote($value); }
function native(string $module)
{
    $bean = BeanFactory::newBean($module);
    must($bean instanceof SugarBean, "Real {$module} bean is required");
    return $bean;
}
function fresh(string $module, string $id)
{
    $bean = native($module);
    must((bool) $bean->retrieve($id, false), "Cannot retrieve real {$module} fixture");
    return $bean;
}
function selectUser($user): void
{
    $GLOBALS['current_user'] = $user;
    $_SESSION = [];
    ACLAction::getUserActions((string) $user->id, true);
}
function linkBeans($bean, string $link, array $ids): void
{
    must($bean->load_relationship($link), 'Actual relationship '.$link.' must load');
    foreach ($ids as $id) $bean->{$link}->add($id);
}
function linkedIds($bean, string $link): array
{
    must($bean->load_relationship($link), 'Actual relationship '.$link.' must load');
    $ids = array_values($bean->{$link}->get());
    sort($ids, SORT_STRING);
    return $ids;
}
function ensureGlobalId(): void
{
    $bean = native('Emails');
    $dynamic = new DynamicField('Emails');
    $dynamic->setup($bean);
    if (!$dynamic->getFieldWidget('Emails', 'global_id_c')) {
        $field = get_widget('varchar');
        $field->name = 'global_id';
        $field->label = 'LBL_GLOBAL_ID';
        $field->vname = 'LBL_GLOBAL_ID';
        $field->label_value = 'Fixture Global ID';
        $field->len = '32';
        $field->required = false;
        $field->audited = false;
        $field->reportable = true;
        $field->save($dynamic);
    }
    VardefManager::clearVardef('Emails', 'Email');
    unset($GLOBALS['dictionary']['Email']);
    VardefManager::refreshVardefs('Emails', 'Email');
    $GLOBALS['reload_vardefs'] = true;
    $fresh = native('Emails');
    unset($GLOBALS['reload_vardefs']);
    must(isset($fresh->field_defs['global_id_c']), 'Native DynamicField Global ID must load');
}
function v8Service(): array
{
    $manager = new Api\V8\BeanDecorator\BeanManager(DBManagerFactory::getInstance(), []);
    $validator = new Api\V8\Factory\ValidatorFactory(Symfony\Component\Validator\Validation::createValidator());
    $service = new Api\V8\Service\ModuleService($manager,
        new Api\V8\JsonApi\Helper\AttributeObjectHelper($manager),
        new Api\V8\JsonApi\Helper\RelationshipObjectHelper(new Api\V8\Helper\VarDefHelper()),
        new Api\V8\JsonApi\Helper\PaginationObjectHelper());
    return [$service, $manager, $validator];
}
function actualV8Record(string $id): array
{
    [$service, $manager, $validator] = v8Service();
    $params = new Api\V8\Param\GetModuleParams($validator, $manager);
    $params->configure(['moduleName' => 'Emails', 'id' => $id]);
    return json_decode(json_encode($service->getRecord($params, '/Api/V8/module/Emails/'.$id), JSON_THROW_ON_ERROR), true, 32, JSON_THROW_ON_ERROR);
}
function actualV8List(string $id): array
{
    [$service, $manager, $validator] = v8Service();
    $params = new Api\V8\Param\GetModulesParams($validator, $manager);
    $params->configure(['moduleName' => 'Emails', 'page' => ['size' => '25', 'number' => '1'],
        'filter' => ['id' => ['eq' => $id], 'deleted' => ['eq' => '0']]]);
    $request = Slim\Http\Request::createFromEnvironment(Slim\Http\Environment::mock([
        'REQUEST_METHOD' => 'GET', 'REQUEST_URI' => '/Api/V8/module/Emails',
    ]));
    $document = json_decode(json_encode($service->getRecords($params, $request), JSON_THROW_ON_ERROR), true, 32, JSON_THROW_ON_ERROR);
    $ids = array_column($document['data'] ?? [], 'id');
    sort($ids, SORT_STRING);
    return $ids;
}
function actualUiList(string $id): array
{
    if (!ACLController::checkAccess('Emails', 'list', true)) return [];
    $request = $_REQUEST;
    try {
        $_REQUEST['module'] = 'Emails'; $_REQUEST['action'] = 'ListView';
        $list = new ListViewData();
        $list->additionalDetails = false;
        $data = $list->getListViewData(native('Emails'), "emails.id='".quote($id)."'", 0, 25,
            ['id' => ['name' => 'id'], 'name' => ['name' => 'name'], 'date_entered' => ['name' => 'date_entered']],
            ['skipOrderSave' => true, 'overrideOrder' => true, 'orderBy' => 'id', 'sortOrder' => 'ASC']);
        $ids = array_column($data['data'], 'ID'); sort($ids, SORT_STRING);
        return $ids;
    } finally { $_REQUEST = $request; }
}
function emailFixture(string $name, string $globalId, string $ownerId, ?string $parentId = null, bool $parentRequestContext = false)
{
    $email = native('Emails');
    $email->name = $name;
    $email->global_id_c = $globalId;
    $email->type = 'archived';
    $email->status = 'read';
    $email->assigned_user_id = $ownerId;
    $email->date_sent_received = '2026-10-28 09:00:00';
    $email->parent_type = $parentId ? 'Accounts' : '';
    $email->parent_id = $parentId ?: '';
    $email->description = "First plain line\nSecond plain line";
    $email->description_html = '';
    $email->from_addr_name = 'Fixture Sender <sender@example.test>';
    $email->to_addrs_names = 'First Recipient <first+alias@example.test>, second@example.test';
    $email->cc_addrs_names = 'Elodie Example <elodie@example.test>';
    $email->bcc_addrs_names = 'Hidden Recipient <hidden@example.test>';
    // The stock inherit_parent hook reads request context, not just bean fields.
    // Keep the V8-like scalar-field path separate from a real UI parent context.
    $previousRequest = $_REQUEST;
    try {
        if ($parentRequestContext) {
            must($parentId !== null, 'Parent request context needs an exact synthetic Account');
            $_REQUEST['parent_type'] = 'Accounts'; $_REQUEST['parent_id'] = $parentId;
        }
        $email->save(false);
    } finally { $_REQUEST = $previousRequest; }
    return fresh('Emails', (string) $email->id);
}
function userFixture(string $label, string $status = 'Active')
{
    $user = native('Users');
    $user->user_name = 'fixture-'.$label; $user->last_name = 'Fixture '.$label;
    $user->status = $status; $user->employee_status = 'Active';
    $user->email1 = $label.'@fixture.example.test';
    $user->is_admin = 0; $user->is_group = 0; $user->portal_only = 0;
    $user->receive_notifications = 0;
    $post = $_POST;
    try { $_POST['ut'] = 'on'; $user->save(false); }
    finally { $_POST = $post; }
    $user = fresh('Users', (string) $user->id);
    must($user->status === $status, 'Synthetic native principal must retain its exact requested status');
    return $user;
}

try {
    $db = DBManagerFactory::getInstance();
    must($db->dbType === 'mysql', 'Real MySQL/MariaDB manager is required');
    $admins = rows("SELECT id FROM users WHERE user_name='fixture-admin' AND status='Active' AND deleted=0");
    must(count($admins) === 1, 'Exactly the synthetic fixture administrator is required');
    $admin = fresh('Users', (string) $admins[0]['id']);
    must($admin->isAdmin(), 'Synthetic fixture administrator must be native administrator');
    selectUser($admin);
    ensureGlobalId();
    // Clone only the installed principal *classes*, never their production IDs,
    // labels, credentials or data. Blank status is intentionally not Inactive.
    $installedDenyRole = native('ACLRoles');
    $installedDenyRole->name = 'ClawPilot Fixture Installed Deny All'; $installedDenyRole->save(false);
    foreach (rows('SELECT id,category,name,acltype FROM acl_actions WHERE deleted=0') as $action) {
        if ($action['acltype'] === 'module' && in_array($action['category'], ['Emails','Accounts','Contacts'], true)) {
            $installedDenyRole->setAction($installedDenyRole->id, $action['id'], $action['name'] === 'access' ? ACL_ALLOW_DISABLED : ACL_ALLOW_NONE);
        }
    }
    $installedPrincipals = ['admin-owner' => $admin];
    foreach (['service-one','service-two'] as $label) {
        $user = userFixture('installed-'.$label);
        linkBeans($installedDenyRole, 'users', [(string) $user->id]);
        $installedPrincipals[$label] = $user;
    }
    $blank = userFixture('installed-blank-status-unroled', '');
    $installedPrincipals['blank-status-unroled'] = $blank;
    must(!rows("SELECT id FROM acl_roles_users WHERE user_id='".quote((string) $blank->id)."' AND deleted=0"), 'Blank-status clone must have no direct role');
    must(!rows("SELECT id FROM securitygroups_users WHERE user_id='".quote((string) $blank->id)."' AND deleted=0"), 'Blank-status clone must have no group');
    selectUser($admin);
    $installedEmail = emailFixture('ClawPilot Installed Principal Golden', 'gi3456789', (string) $admin->id);
    $installedId = (string) $installedEmail->id;
    must(!rows("SELECT id FROM securitygroups_records WHERE record_id='".quote($installedId)."' AND module='Emails' AND deleted=0"), 'First principal golden must have zero inherited SecurityGroups');
    $principalGolden = [];
    foreach ($installedPrincipals as $label => $user) {
        selectUser($user);
        $unsaved = native('Emails'); $unsaved->id = create_guid();
        $unsaved->assigned_user_id = $admin->id; $unsaved->created_by = $admin->id;
        $saved = fresh('Emails', $installedId);
        $surfaces = [];
        foreach (['view','list','export'] as $surface) {
            $surfaces[$surface] = ['unsaved' => $unsaved->ACLAccess($surface), 'saved' => $saved->ACLAccess($surface),
                'accessLevel' => (int) ACLAction::getUserAccessLevel((string) $user->id, 'Emails', $surface)];
        }
        $v8View = false; $v8List = [];
        try { $v8View = (actualV8Record($installedId)['data']['id'] ?? '') === $installedId; }
        catch (SuiteCRM\Exception\AccessDeniedException $denied) {}
        try { $v8List = actualV8List($installedId); }
        catch (SuiteCRM\Exception\AccessDeniedException $denied) {}
        $exportCsv = ACLController::checkAccess('Emails', 'export', true) ? export('Emails', $installedId) : '';
        $principalGolden[$label] = ['status' => $user->status, 'isAdmin' => $user->isAdmin(),
            'moduleAccess' => (int) ACLAction::getUserAccessLevel((string) $user->id, 'Emails', 'access'), 'surfaces' => $surfaces,
            'nativeUiListIds' => actualUiList($installedId), 'actualExportCsvContainsId' => str_contains($exportCsv, $installedId),
            'v8ServiceView' => $v8View, 'v8ServiceListIds' => $v8List];
    }
    $blankCanRead = array_reduce($principalGolden['blank-status-unroled']['surfaces'],
        static fn (bool $read, array $surface): bool => $read || $surface['unsaved'] || $surface['saved'], false);
    fwrite(STDOUT, 'CLAWPILOT_NATIVE_INSTALLED_PRINCIPALS_GOLDEN='.json_encode([
        'syntheticOnly' => true, 'emailId' => $installedId, 'securityGroupCount' => 0,
        'principals' => $principalGolden, 'pipelineOwnerOnlyAudienceCompatible' => !$blankCanRead,
        'blocker' => $blankCanRead ? 'Blank-status unroled native principal can read owner-only Email with zero SecurityGroups' : null,
    ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n");
    check('installed-profile synthetic principal clone exercises blank-status real read/UI list/export/V8 without exclusion', function () use ($principalGolden, $installedId): void {
        must($principalGolden['blank-status-unroled']['status'] === '', 'Blank status must not become Inactive');
        foreach (['admin-owner','blank-status-unroled'] as $label) {
            must($principalGolden[$label]['v8ServiceView'], 'Stock admin/default-all principal has real V8 direct read');
            must(in_array($installedId, $principalGolden[$label]['v8ServiceListIds'], true), 'Stock admin/default-all principal has real V8 list read');
            must(in_array($installedId, $principalGolden[$label]['nativeUiListIds'], true), 'Stock admin/default-all principal has real UI list read');
            must($principalGolden[$label]['actualExportCsvContainsId'], 'Stock admin/default-all principal has real export read');
        }
        foreach (['service-one','service-two'] as $label) {
            must($principalGolden[$label]['moduleAccess'] === ACL_ALLOW_DISABLED, 'Actual direct deny-all role must disable Email access');
            foreach ($principalGolden[$label]['surfaces'] as $surface) must(!$surface['unsaved'] && !$surface['saved'], 'Denied service clone cannot read');
            must(!$principalGolden[$label]['v8ServiceView'] && $principalGolden[$label]['v8ServiceListIds'] === []
                && $principalGolden[$label]['nativeUiListIds'] === [] && !$principalGolden[$label]['actualExportCsvContainsId'], 'Denied service clone remains denied across real read/list/export surfaces');
        }
    });
    selectUser($admin);
    $golden = emailFixture('ClawPilot Native Fixture Golden', 'gi1234567', (string) $admin->id);
    $v8Golden = actualV8Record((string) $golden->id);
    $goldenAttributes = [];
    foreach (['name','description','description_html','from_addr_name','to_addrs_names','cc_addrs_names','bcc_addrs_names','date_sent_received','global_id_c'] as $key) {
        $goldenAttributes[$key] = $golden->{$key};
    }
    fwrite(STDOUT, 'CLAWPILOT_NATIVE_EMAIL_GOLDEN='.json_encode([
        'version' => trim((string) file_get_contents('/app/VERSION')), 'php' => PHP_VERSION,
        'beanAttributes' => $goldenAttributes, 'v8Document' => $v8Golden,
        'cleanEmails' => ['quotedComma' => $golden->cleanEmails('"Last, First" <alias@example.test>'),
            'semicolon' => $golden->cleanEmails('first@example.test; second@example.test')],
        'sourceHashes' => array_combine(['Email','SugarBean','ACLAction','SecurityGroup'], array_map('hash_file',
            array_fill(0, 4, 'sha256'), ['modules/Emails/Email.php','data/SugarBean.php','modules/ACLActions/ACLAction.php','modules/SecurityGroups/SecurityGroup.php'])),
    ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n");
    check('actual Email save/retrieve and V8 serializer record native plain-body HTML normalization', function () use ($golden, $v8Golden): void {
        must($golden->description === "First plain line\nSecond plain line", 'Plain body must remain exact');
        must($golden->description_html === "First plain line<br />\nSecond plain line", 'Native Email fills nonempty HTML from the plain body');
        must($v8Golden['data']['id'] === $golden->id, 'Real V8 serializer keeps native ID');
        must($v8Golden['data']['attributes']['description_html'] === $golden->description_html, 'Real V8 readback uses actual native normalized HTML');
        foreach (['from_addr_name' => 'Fixture Sender ', 'to_addrs_names' => 'First Recipient , second@example.test',
            'cc_addrs_names' => 'Elodie Example ', 'bcc_addrs_names' => 'Hidden Recipient '] as $field => $expected) {
            must($v8Golden['data']['attributes'][$field] === $expected, 'Pinned V8 serializer strips angle-address text from '.$field);
            must($golden->{$field} !== $expected, 'Bean readback and V8 named-header readback are distinct surfaces');
        }
        must($v8Golden['data']['attributes']['date_sent_received'] === '2026-10-28T09:00:00+00:00', 'Pinned V8 serializes the SQL timestamp as ISO 8601');
        must($v8Golden['data']['attributes']['date_sent_received'] !== '2026-10-28 09:00:00', 'Strict request-string equality is not a valid native timestamp readback comparison');
        must($golden->cleanEmails('"Last, First" <alias@example.test>') === 'First <alias@example.test>', 'Pinned native cleanEmails comma normalization is captured');
        must($golden->cleanEmails('first@example.test; second@example.test') === 'first@example.test, second@example.test', 'Pinned native cleanEmails semicolon normalization is captured');
    });
    if (getenv('CLAWPILOT_NATIVE_FIXTURE_GOLDEN_ONLY') === '1') exit(0);

    $inheritance = [];
    foreach (['securitysuite_inherit_creator','securitysuite_inherit_assigned','securitysuite_inherit_parent'] as $flag) {
        $inheritance[$flag] = $GLOBALS['sugar_config'][$flag] ?? null;
        must($inheritance[$flag] === true, 'Fresh pinned installer must retain its stock true inheritance flag');
    }
    $hookFiles = array_values(array_filter([
        'custom/modules/logic_hooks.php', 'custom/modules/Emails/logic_hooks.php',
        'custom/modules/Accounts/logic_hooks.php','custom/modules/Contacts/logic_hooks.php',
        'custom/application/Ext/LogicHooks/logichooks.ext.php',
    ], 'is_file'));
    $hookHashes = [];
    foreach ($hookFiles as $path) $hookHashes[$path] = hash_file('sha256', $path);
    fwrite(STDOUT, 'CLAWPILOT_NATIVE_STOCK_PROFILE='.json_encode(['inheritance' => $inheritance,
        'generatedHookHashes' => $hookHashes], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n");

    $groupRole = native('ACLRoles'); $groupRole->name = 'ClawPilot Fixture Group Reader'; $groupRole->save(false);
    $denyRole = native('ACLRoles'); $denyRole->name = 'ClawPilot Fixture Denied Service'; $denyRole->save(false);
    foreach (rows('SELECT id,category,name,acltype FROM acl_actions WHERE deleted=0') as $action) {
        $groupAccess = ACL_ALLOW_NONE;
        if ($action['acltype'] === 'module' && in_array($action['category'], ['Emails','Accounts','Contacts'], true)) {
            $groupAccess = $action['name'] === 'access' ? ACL_ALLOW_ENABLED
                : (in_array($action['name'], ['view','list','export'], true) ? ACL_ALLOW_GROUP : ACL_ALLOW_NONE);
        } elseif ($action['name'] === 'access') $groupAccess = ACL_ALLOW_DISABLED;
        $groupRole->setAction($groupRole->id, $action['id'], $groupAccess);
        $denyRole->setAction($denyRole->id, $action['id'], $action['name'] === 'access' ? ACL_ALLOW_DISABLED : ACL_ALLOW_NONE);
    }
    $groups = [];
    foreach (['A','B'] as $key) {
        $group = native('SecurityGroups'); $group->name = 'ClawPilot Fixture Company '.$key; $group->save(false);
        linkBeans($group, 'aclroles', [(string) $groupRole->id]); $groups[$key] = $group;
    }
    $users = ['admin-owner' => $admin];
    foreach (['a-only','b-only','both','neither','deny-service','inactive-a'] as $key) {
        $user = userFixture($key, $key === 'inactive-a' ? 'Inactive' : 'Active');
        $role = $key === 'deny-service' ? $denyRole : $groupRole;
        linkBeans($role, 'users', [(string) $user->id]);
        foreach (['A' => ['a-only','both','inactive-a'], 'B' => ['b-only','both']] as $group => $members) {
            if (in_array($key, $members, true)) linkBeans($groups[$group], 'users', [(string) $user->id]);
        }
        $users[$key] = fresh('Users', (string) $user->id);
    }
    selectUser($admin);
    $accounts = []; $contacts = [];
    foreach (['A','B'] as $key) {
        $account = native('Accounts'); $account->name = 'ClawPilot Fixture Account '.$key;
        $account->assigned_user_id = $admin->id; $account->save(false);
        $groups[$key]->addGroupToRecord('Accounts', (string) $account->id, (string) $groups[$key]->id);
        $contact = native('Contacts'); $contact->last_name = 'ClawPilot Fixture Contact '.$key;
        $contact->account_id = $account->id; $contact->assigned_user_id = $admin->id; $contact->save(false);
        $accounts[$key] = $account; $contacts[$key] = $contact;
    }
    $scalarOnly = emailFixture('ClawPilot Scalar Parent Only', 'gi4567890', (string) $admin->id, (string) $accounts['A']->id);
    $scalarOnlyGroups = array_column(rows("SELECT securitygroup_id FROM securitygroups_records WHERE record_id='".quote((string) $scalarOnly->id)."' AND module='Emails' AND deleted=0 ORDER BY securitygroup_id"), 'securitygroup_id');
    $pending = native('Emails'); $pending->id = create_guid();
    $pending->assigned_user_id = $admin->id; $pending->created_by = $admin->id;
    $pending->parent_type = 'Accounts'; $pending->parent_id = $accounts['A']->id;
    $pendingReaders = []; $scalarReaders = [];
    foreach ($users as $key => $user) {
        selectUser($user);
        foreach (['view','list','export'] as $surface) {
            $pendingReaders[$key][$surface] = $pending->ACLAccess($surface);
            $scalarReaders[$key][$surface] = fresh('Emails', (string) $scalarOnly->id)->ACLAccess($surface);
        }
    }
    selectUser($admin);
    $email = emailFixture('ClawPilot Native Fixture Shared Email', 'gi2345678', (string) $admin->id, (string) $accounts['A']->id, true);
    $emailId = (string) $email->id;
    $accountIds = [(string) $accounts['A']->id, (string) $accounts['B']->id]; sort($accountIds, SORT_STRING);
    $contactIds = [(string) $contacts['A']->id, (string) $contacts['B']->id]; sort($contactIds, SORT_STRING);
    $nativeGroups = static fn (): array => array_column(rows("SELECT securitygroup_id FROM securitygroups_records WHERE record_id='".quote($emailId)."' AND module='Emails' AND deleted=0 ORDER BY securitygroup_id"), 'securitygroup_id');
    $evaluate = static function (string $phase) use ($users, $emailId): array {
        $matrix = [];
        foreach ($users as $key => $user) {
            selectUser($user); $bean = fresh('Emails', $emailId);
            $listQuery = $bean->create_new_list_query('emails.id', "emails.id='".quote($emailId)."'");
            $listGate = ACLController::checkAccess('Emails', 'list', true);
            $rawListIds = $listGate ? array_column(rows($listQuery), 'id') : [];
            $listIds = actualUiList($emailId);
            $exportGate = ACLController::checkAccess('Emails', 'export', true);
            $exportWhere = $bean->buildAccessWhere('export');
            $exportQuery = $bean->create_export_query('', "emails.id='".quote($emailId)."'".($exportWhere ? ' AND '.$exportWhere : ''));
            $exportIds = $exportGate ? array_column(rows($exportQuery), 'id') : [];
            $exportCsv = $exportGate ? export('Emails', $emailId) : '';
            $v8View = false; $v8ListIds = [];
            try { $v8View = (actualV8Record($emailId)['data']['id'] ?? '') === $emailId; }
            catch (SuiteCRM\Exception\AccessDeniedException $denied) {}
            try { $v8ListIds = actualV8List($emailId); }
            catch (SuiteCRM\Exception\AccessDeniedException $denied) {}
            $matrix[$key] = ['view' => $bean->ACLAccess('view'), 'list' => $bean->ACLAccess('list'),
                'export' => $bean->ACLAccess('export'), 'listGate' => $listGate, 'exportGate' => $exportGate,
                'listVisibleIds' => array_values(array_unique($listIds)), 'exportVisibleIds' => array_values(array_unique($exportIds)),
                'rawEmailBuilderVisibleIdsNotUiProof' => array_values(array_unique($rawListIds)),
                'actualExportCsvContainsId' => str_contains($exportCsv, $emailId),
                'v8ServiceView' => $v8View, 'v8ServiceListIds' => $v8ListIds,
                'nativeExportFilter' => $exportWhere, 'status' => $user->status];
        }
        fwrite(STDOUT, 'CLAWPILOT_NATIVE_ACL_MATRIX='.json_encode(['phase' => $phase, 'emailId' => $emailId,
            'principals' => $matrix], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n");
        return $matrix;
    };
    $beforeGroups = $nativeGroups();
    $before = $evaluate('saved-primary-A-before-relationships');
    fwrite(STDOUT, 'CLAWPILOT_NATIVE_INHERITANCE_COUNTERFACTUAL='.json_encode([
        'unsavedVerifierShape' => $pendingReaders, 'savedScalarParentOnly' => $scalarReaders,
        'scalarParentSecurityGroupIds' => $scalarOnlyGroups, 'savedParentRequestSecurityGroupIds' => $beforeGroups,
        'parentRequestContext' => ['parent_type' => 'Accounts', 'parent_id' => (string) $accounts['A']->id],
    ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n");
    selectUser($admin);
    linkBeans($email, 'accounts', $accountIds); linkBeans($email, 'contacts', $contactIds);
    $after = $evaluate('after-real-account-and-contact-relationship-adds');
    selectUser($admin);
    check('real one Email relates to two Accounts and two own-company Contacts without reparenting', function () use ($emailId, $accountIds, $contactIds, $contacts, $accounts): void {
        $bean = fresh('Emails', $emailId);
        must(linkedIds($bean, 'accounts') === $accountIds, 'Actual Account M:M links must be exact');
        must(linkedIds($bean, 'contacts') === $contactIds, 'Actual Contact M:M links must be exact');
        foreach (['A','B'] as $key) must(fresh('Contacts', (string) $contacts[$key]->id)->account_id === $accounts[$key]->id, 'Contact company must not change');
    });
    check('stock inherited primary-company audience is evaluated through separate real view/list/export surfaces', function () use ($before, $after, $emailId): void {
        foreach ([$before, $after] as $matrix) {
            foreach (['admin-owner','a-only','both','inactive-a'] as $key) {
                must($matrix[$key]['view'], "{$key} actual direct view must include inherited primary company");
                must(in_array($emailId, $matrix[$key]['listVisibleIds'], true), "{$key} actual list query must include primary-company Email");
                must(in_array($emailId, $matrix[$key]['exportVisibleIds'], true), "{$key} filtered export query must include primary-company Email");
                must($matrix[$key]['actualExportCsvContainsId'], "{$key} actual export helper must emit primary-company Email");
                must($matrix[$key]['v8ServiceView'], "{$key} real V8 direct read must include primary-company Email");
                must(in_array($emailId, $matrix[$key]['v8ServiceListIds'], true), "{$key} real V8 list must include primary-company Email");
            }
            foreach (['b-only','neither','deny-service'] as $key) {
                must(!$matrix[$key]['view'], "{$key} must not gain a direct read from Account labels alone");
                must(!in_array($emailId, $matrix[$key]['listVisibleIds'], true), "{$key} actual list must remain restricted");
                must(!$matrix[$key]['actualExportCsvContainsId'], "{$key} actual export helper must remain restricted");
                must(!$matrix[$key]['v8ServiceView'], "{$key} real V8 direct read must remain restricted");
                if ($key === 'deny-service') must($matrix[$key]['v8ServiceListIds'] === [], 'Denied service real V8 module gate must deny list');
                else must(in_array($emailId, $matrix[$key]['v8ServiceListIds'], true), 'Stock V8 raw Email list exposes this record despite direct group ACL denial; this is a compatibility blocker, not UI-list proof');
            }
        }
    });
    $linksBeforeReplay = [linkedIds(fresh('Emails', $emailId), 'accounts'), linkedIds(fresh('Emails', $emailId), 'contacts')];
    linkBeans(fresh('Emails', $emailId), 'accounts', $accountIds); linkBeans(fresh('Emails', $emailId), 'contacts', $contactIds);
    check('native relationship replay preserves exactly one bean and both distinct relationships', function () use ($emailId, $linksBeforeReplay): void {
        must(count(rows("SELECT id FROM emails WHERE id='".quote($emailId)."' AND deleted=0")) === 1, 'Replay must not duplicate Email');
        must([linkedIds(fresh('Emails', $emailId), 'accounts'), linkedIds(fresh('Emails', $emailId), 'contacts')] === $linksBeforeReplay, 'Native relationship replay must remain idempotent');
    });
    $command = ['version' => 1, 'phase' => 'before', 'suiteCrmId' => $emailId, 'globalId' => 'gi2345678',
        'assignedUserId' => (string) $admin->id, 'accounts' => $accountIds, 'contacts' => $contactIds,
        'audience' => ['policy' => 'pipeline-internal', 'ownerSuiteCrmId' => (string) $admin->id,
            'allowedSuiteCrmUserIds' => [(string) $admin->id], 'workspaceId' => create_guid(), 'pipelineId' => create_guid()]];
    $command['audience']['fingerprint'] = hash('sha256', json_encode($command['audience'], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    $databaseBeforeProof = rows("SELECT id,name,assigned_user_id,parent_id,parent_type FROM emails WHERE id='".quote($emailId)."'");
    check('current production verifier holds the actual generated-hook/inheritance profile before claiming compatibility', function () use ($command): void {
        $held = false;
        try { clawpilot_email_audience_proof($command, $command['audience']['ownerSuiteCrmId']); }
        catch (RuntimeException $error) { $held = $error->getMessage() === 'Native Email audience is unproven'; }
        must($held, 'Actual stock profile must be held, not called compatible');
    });
    check('held verifier preserves native rows, links, groups and generated stock hook files', function () use ($emailId, $databaseBeforeProof, $linksBeforeReplay, $beforeGroups, $nativeGroups, $hookHashes): void {
        must(rows("SELECT id,name,assigned_user_id,parent_id,parent_type FROM emails WHERE id='".quote($emailId)."'") === $databaseBeforeProof, 'Verifier cannot mutate Email');
        must([linkedIds(fresh('Emails', $emailId), 'accounts'), linkedIds(fresh('Emails', $emailId), 'contacts')] === $linksBeforeReplay, 'Verifier cannot mutate native links');
        must($nativeGroups() === $beforeGroups, 'Native group inheritance observed independently remains unchanged');
        foreach ($hookHashes as $path => $hash) must(hash_file('sha256', $path) === $hash, 'Stock generated hooks remain intact');
    });
    fwrite(STDOUT, "REAL_SUITECRM_ACCEPTANCE_PASSED=checks={$checks}; real beans/DB/ACL/UI list/V8 service/exports; installed audience is HELD, no HTTP OAuth, publisher, concurrency or production equivalence claimed.\n");
} catch (Throwable $error) {
    fwrite(STDERR, 'Native Email acceptance failed: '.get_class($error).': '.$error->getMessage()."\n");
    exit(1);
}
