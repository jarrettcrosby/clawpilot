<?php
declare(strict_types=1);
// Synthetic principal classes and messages only. No live policy is loaded.
if (getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1') throw new RuntimeException('Opt-in candidate required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY', true);
require '/fixture/acceptance.php';

function emailReadSurfaces($user, string $id): array
{
    selectUser($user);
    $bean = fresh('Emails', $id);
    $direct = false; $listed = [];
    try { $direct = (actualV8Record($id)['data']['id'] ?? '') === $id; }
    catch (SuiteCRM\Exception\AccessDeniedException $denied) {}
    try { $listed = actualV8List($id); }
    catch (SuiteCRM\Exception\AccessDeniedException $denied) {}
    $csv = ACLController::checkAccess('Emails', 'export', true) ? export('Emails', $id) : '';
    return ['view' => $bean->ACLAccess('view'), 'list' => $bean->ACLAccess('list'),
        'export' => $bean->ACLAccess('export'), 'edit' => $bean->ACLAccess('edit'), 'delete' => $bean->ACLAccess('delete'),
        'uiList' => in_array($id, actualUiList($id), true), 'exportCsv' => str_contains($csv, $id),
        'v8Direct' => $direct, 'v8List' => in_array($id, $listed, true)];
}
function otherModuleAccess($user): array
{
    selectUser($user);
    $result = [];
    foreach (rows("SELECT category,name FROM acl_actions WHERE deleted=0 AND acltype='module' AND category<>'Emails' ORDER BY category,name") as $action) {
        $result[$action['category'].':'.$action['name']] = ACLAction::getUserAccessLevel((string) $user->id, $action['category'], $action['name']);
    }
    return $result;
}
function relatedEmailDocument(string $accountId, int $size = 25): array
{
    [, $manager, $validator] = v8Service();
    $params = new Api\V8\Param\GetRelationshipParams($validator, $manager);
    $params->configure(['moduleName' => 'Accounts', 'id' => $accountId, 'linkFieldName' => 'emails',
        'page' => ['size' => (string) $size, 'number' => '1']]);
    $service = new Api\V8\Service\RelationshipService($manager,
        new Api\V8\JsonApi\Helper\AttributeObjectHelper($manager), new Api\V8\JsonApi\Helper\PaginationObjectHelper());
    $request = Slim\Http\Request::createFromEnvironment(Slim\Http\Environment::mock([
        'REQUEST_METHOD' => 'GET', 'REQUEST_URI' => '/Api/V8/module/Accounts/'.$accountId.'/relationships/emails',
    ]));
    return json_decode(json_encode($service->getRelationship($params, $request), JSON_THROW_ON_ERROR), true, 32, JSON_THROW_ON_ERROR);
}

try {
    $adminId = rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0")[0]['id'];
    $targetId = rows("SELECT id FROM users WHERE user_name='fixture-installed-blank-status-unroled' AND deleted=0")[0]['id'];
    $admin = fresh('Users', $adminId); $target = fresh('Users', $targetId);
    $statusBefore = $target->status;
    $beforeOther = otherModuleAccess($target);
    selectUser($admin);
    $role = native('ACLRoles'); $role->name = 'Fixture scoped native Email permissions'; $role->save(false);
    foreach (rows("SELECT id,name FROM acl_actions WHERE deleted=0 AND acltype='module' AND category='Emails'") as $action) {
        // Narrow read/write existing Email records to native group/owner scope.
        // No other module, login flag, password or service role is changed.
        if ($action['name'] === 'access') $role->setAction($role->id, $action['id'], ACL_ALLOW_ENABLED);
        elseif (in_array($action['name'], ['view','list','export','edit','delete'], true)) {
            $role->setAction($role->id, $action['id'], ACL_ALLOW_GROUP);
        }
    }
    $group = native('SecurityGroups'); $group->name = 'Fixture authorized Suburbia workspace'; $group->save(false);
    linkBeans($role, 'users', [$targetId]); linkBeans($group, 'users', [$targetId]);
    $own = emailFixture('Synthetic authorized Suburbia Email', 'gi5678901', $adminId);
    $bpo = emailFixture('Synthetic private BPO Email', 'gi5678902', $adminId);
    $group->addGroupToRecord('Emails', (string) $own->id, (string) $group->id);
    $ownId = (string) $own->id; $bpoId = (string) $bpo->id;
    $nativeBefore = rows("SELECT id,name,assigned_user_id,created_by,deleted FROM emails WHERE id IN ('".quote($ownId)."','".quote($bpoId)."') ORDER BY id");
    $target = fresh('Users', $targetId);
    check('targeted Email-only role preserves all other module action levels and original user status', function () use ($target, $beforeOther, $statusBefore): void {
        must($target->status === $statusBefore && !$target->isAdmin(), 'Do not disable or elevate the user');
        must(otherModuleAccess($target) === $beforeOther, 'Non-Email permissions must remain identical');
    });
    $ownSurfaces = emailReadSurfaces($target, $ownId);
    $bpoSurfaces = emailReadSurfaces($target, $bpoId);
    check('scoped user retains own-workspace Email read/edit/export and cannot read/edit BPO Email', function () use ($ownSurfaces, $bpoSurfaces): void {
        foreach ($ownSurfaces as $surface => $allowed) must($allowed, 'Own-workspace surface lost: '.$surface);
        foreach ($bpoSurfaces as $surface => $allowed) must(!$allowed, 'BPO surface leaked: '.$surface);
    });
    check('owner remains able to read both workspaces without adding anyone to BPO', function () use ($admin, $ownId, $bpoId): void {
        foreach ([$ownId,$bpoId] as $id) foreach (emailReadSurfaces($admin, $id) as $surface => $allowed) {
            must($allowed, 'Owner access lost: '.$surface);
        }
        must(!rows("SELECT id FROM securitygroups_records WHERE record_id='".quote($bpoId)."' AND module='Emails' AND deleted=0"), 'BPO Email must retain zero inherited groups');
    });
    check('existing denied service principals remain denied after the candidate list correction', function () use ($ownId,$bpoId): void {
        foreach (['service-one','service-two'] as $label) {
            $id = rows("SELECT id FROM users WHERE user_name='fixture-installed-".quote($label)."' AND deleted=0")[0]['id'];
            foreach ([$ownId,$bpoId] as $emailId) foreach (emailReadSurfaces(fresh('Users',$id), $emailId) as $surface => $allowed) {
                must(!$allowed, 'Denied service gained '.$surface);
            }
        }
    });
    selectUser($admin);
    $account = native('Accounts'); $account->name = 'Fixture accessible company with mixed Email links';
    $account->assigned_user_id = $adminId; $account->save(false);
    linkBeans($account, 'emails', [$ownId,$bpoId]);
    selectUser($target);
    $related = relatedEmailDocument((string) $account->id, 1);
    check('related-Email API filters content and pagination totals before paging', function () use ($related,$ownId): void {
        must(array_column($related['data'] ?? [], 'id') === [$ownId], 'Only authorized related Email may appear');
        must((int) ($related['meta']['total-records'] ?? -1) === 1, 'Related API metadata cannot count the hidden BPO Email');
        must((int) ($related['meta']['total-pages'] ?? -1) === 1, 'Hidden Email cannot inflate pages');
    });
    check('group-only users denied by the stock V8 list now get the same result as native direct/UI access', function () use ($bpoId): void {
        foreach (['b-only','neither','inactive-a'] as $label) {
            $id = rows("SELECT id FROM users WHERE user_name='fixture-".quote($label)."' AND deleted=0")[0]['id'];
            $surfaces = emailReadSurfaces(fresh('Users',$id), $bpoId);
            must(!$surfaces['v8List'] && !$surfaces['v8Direct'] && !$surfaces['uiList'], 'Hidden owner-only Email must stay hidden for '.$label);
        }
    });
    selectUser($admin);
    // Rollback only the two synthetic memberships: demonstrate recoverability,
    // then restore the candidate. Never call this against an existing database.
    must($role->load_relationship('users') && $group->load_relationship('users'), 'Native links must load');
    $role->users->delete((string) $role->id, $targetId);
    $group->users->delete((string) $group->id, $targetId);
    check('removing the two candidate memberships restores the exact pre-change authority', function () use ($target,$beforeOther,$bpoId): void {
        must(otherModuleAccess($target) === $beforeOther, 'Rollback must preserve other module permissions');
        foreach (emailReadSurfaces($target, $bpoId) as $allowed) must($allowed, 'The original unroled default-all behavior should be reproduced, not deployed');
    });
    selectUser($admin);
    linkBeans($role, 'users', [$targetId]); linkBeans($group, 'users', [$targetId]);
    check('permission-only canary does not rewrite messages, ownership or native record lifecycle', function () use ($nativeBefore,$ownId,$bpoId): void {
        must(rows("SELECT id,name,assigned_user_id,created_by,deleted FROM emails WHERE id IN ('".quote($ownId)."','".quote($bpoId)."') ORDER BY id") === $nativeBefore, 'No message/ownership/lifecycle change is allowed');
    });
    fwrite(STDOUT, 'CLAWPILOT_NATIVE_REMEDIATION_MATRIX='.json_encode([
        'syntheticOnly' => true, 'ownWorkspace' => $ownSurfaces, 'foreignBpo' => $bpoSurfaces,
        'otherModulePermissionsUnchanged' => true, 'statusUnchanged' => true, 'productionApplied' => false,
    ], JSON_THROW_ON_ERROR)."\n");
    fwrite(STDOUT, "NATIVE_REMEDIATION_CANDIDATE_PASSED=checks={$checks}; synthetic native role/group + pinned V8 list/relationship correction; no live ACL, HTTP OAuth, production approval or publication acceptance.\n");
} catch (Throwable $error) {
    fwrite(STDERR, 'Native remediation candidate failed: '.get_class($error).': '.$error->getMessage()."\n");
    exit(1);
}
