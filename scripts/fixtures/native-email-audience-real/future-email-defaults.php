<?php
declare(strict_types=1);

// Synthetic, rolled-back native policy experiment only. Changing native Email
// defaults expands the proposed live correction and requires separate approval.
// Reader groups MUST NOT automatically grant group edit/delete to future users.
if (getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1') throw new RuntimeException('Opt-in candidate required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY', true);
require '/fixture/acceptance.php';
require '/fixture/managed-email-lifecycle-helper.php';

function futureDefaultRows(): array
{
    return lifecycleRows("SELECT id,name,aclaccess FROM acl_actions WHERE deleted=0 AND category='Emails' AND acltype='module'
        AND name IN ('view','list','export','edit','delete') ORDER BY name,id");
}
function futureRequireDefaults(array $pinned): void
{
    if (futureDefaultRows() !== $pinned) throw new LifecycleRefused('Native Email default policy drift');
}
function futureDefaultsState(): string
{
    $state = [];
    foreach (['acl_actions'=>'id','acl_roles'=>'id','acl_roles_actions'=>'id','acl_roles_users'=>'id',
        'users'=>'id','user_preferences'=>'id','securitygroups'=>'id','securitygroups_users'=>'id',
        'securitygroups_acl_roles'=>'id','securitygroups_records'=>'id','emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c',
        'emails_beans'=>'id','emails_email_addr_rel'=>'id','email_addresses'=>'id','email_addr_bean_rel'=>'id'] as $table => $column) {
        $state[$table] = lifecycleRows('SELECT * FROM '.$table.' ORDER BY '.$column);
    }
    // Users custom fields are not installed in every pinned stock fixture.
    $hasCustomUsers=lifecycleRows("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users_cstm'");
    $state['users_cstm']=$hasCustomUsers ? lifecycleRows('SELECT * FROM users_cstm ORDER BY id_c') : null;
    return lifecycleDigest($state);
}
function futureReadSurfaces($user, string $id): array
{
    selectUser($user);
    $email = fresh('Emails', $id);
    $direct = false; $list = [];
    try { $direct = (actualV8Record($id)['data']['id'] ?? '') === $id; }
    catch (SuiteCRM\Exception\AccessDeniedException $denied) {}
    try { $list = actualV8List($id); }
    catch (SuiteCRM\Exception\AccessDeniedException $denied) {}
    $csv = ACLController::checkAccess('Emails', 'export', true) ? export('Emails', $id) : '';
    return ['view'=>$email->ACLAccess('view'),'list'=>$email->ACLAccess('list'),'export'=>$email->ACLAccess('export'),
        'v8Direct'=>$direct,'v8List'=>in_array($id,$list,true),'uiList'=>in_array($id,actualUiList($id),true),
        'exportCsv'=>str_contains($csv,$id)];
}
function futureAssertSurface(array $surfaces, bool $expected): void
{
    foreach ($surfaces as $name => $actual) must((bool)$actual === $expected, 'Unexpected future-user '.$name.' access');
}
function futureRequireReaders(string $emailId, array $allowed): void
{
    sort($allowed, SORT_STRING);
    $actual = [];
    $savedUser = $GLOBALS['current_user']; $savedSession = $_SESSION;
    try {
        foreach (lifecycleRows('SELECT id FROM users WHERE deleted=0 ORDER BY id') as $row) {
            selectUser(fresh('Users',$row['id']));
            $email = fresh('Emails',$emailId);
            if ($email->ACLAccess('view') || $email->ACLAccess('list') || $email->ACLAccess('export')) $actual[] = $row['id'];
        }
        sort($actual,SORT_STRING);
        if ($actual !== $allowed) throw new LifecycleRefused('Unexpected effective Email reader');
    } finally { $GLOBALS['current_user']=$savedUser; $_SESSION=$savedSession; }
}

$transaction = null;
try {
    $_REQUEST = [];
    lifecycleProfile();
    lifecycleRuntimeDigest();
    $adminRows = lifecycleRows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0 AND is_admin=1");
    must(count($adminRows) === 1, 'Exact fixture admin required');
    $adminId = $adminRows[0]['id']; $admin = fresh('Users',$adminId);
    selectUser($admin);
    $beforeState = futureDefaultsState();
    $beforeDefaults = futureDefaultRows();
    must(array_column($beforeDefaults,'name') === ['delete','edit','export','list','view'], 'Exactly five distinct native defaults required');
    foreach ($beforeDefaults as $row) must((int)$row['aclaccess'] === ACL_ALLOW_ALL, 'Expected untouched native default-all baseline');
    $otherDefaultsSql = "SELECT * FROM acl_actions WHERE NOT (deleted=0 AND category='Emails' AND acltype='module'
        AND name IN ('view','list','export','edit','delete')) ORDER BY id";
    $otherBefore = lifecycleRows($otherDefaultsSql);
    $transaction = lifecycleBegin();
    foreach ($beforeDefaults as $row) {
        $level = in_array($row['name'], ['view','list','export'],true) ? ACL_ALLOW_GROUP : ACL_ALLOW_OWNER;
        lifecycleSql('UPDATE acl_actions SET aclaccess='.(int)$level.' WHERE id='.lifecycleQ($row['id']).' AND deleted=0 AND aclaccess=90');
        must(DBManagerFactory::getInstance()->database->affected_rows === 1, 'Exact one-row default comparison required');
    }
    $pinned = futureDefaultRows();
    check('future-user candidate changes only three Email read defaults to group and two write defaults to owner', function () use ($pinned,$otherBefore,$otherDefaultsSql): void {
        must(array_map('intval',array_column($pinned,'aclaccess')) === [75,75,80,80,80], 'Exact read/write separation required');
        must(lifecycleRows($otherDefaultsSql) === $otherBefore, 'All other native default rows must remain byte-identical');
    });

    $futureUser = userFixture('future-unroled-read-defaults');
    $futureId = (string)$futureUser->id;
    must(lifecycleRows('SELECT id FROM acl_roles_users WHERE deleted=0 AND user_id='.lifecycleQ($futureId)) === [], 'Future user must have no assigned role');
    must(lifecycleRows('SELECT id FROM securitygroups_users WHERE deleted=0 AND user_id='.lifecycleQ($futureId)) === [], 'Future user must have no group');
    $own = emailFixture('Synthetic future authorized pipeline Email','gi9010001',$adminId);
    $foreign = emailFixture('Synthetic future foreign pipeline Email','gi9010002',$adminId);
    $ownId = (string)$own->id; $foreignId = (string)$foreign->id;
    $messageBefore = [lifecycleEmailSnapshot($ownId),lifecycleEmailSnapshot($foreignId)];
    check('newly created unroled native user cannot read either administrator-owned historical Email before a grant', function () use ($futureUser,$ownId,$foreignId,$pinned): void {
        futureRequireDefaults($pinned);
        foreach ([$ownId,$foreignId] as $id) futureAssertSurface(futureReadSurfaces($futureUser,$id),false);
    });

    selectUser($admin);
    $group = native('SecurityGroups'); $group->name = 'Synthetic future exact pipeline readers'; $group->noninheritable = 1; $group->save(false);
    linkBeans($group,'users',[$futureId]);
    $group->addGroupToRecord('Emails',$ownId,(string)$group->id);
    check('exact future pipeline grant permits only its Email and does not grant a viewer edit or delete', function () use ($futureUser,$ownId,$foreignId,$pinned): void {
        futureRequireDefaults($pinned);
        futureAssertSurface(futureReadSurfaces($futureUser,$ownId),true);
        futureAssertSurface(futureReadSurfaces($futureUser,$foreignId),false);
        selectUser($futureUser);
        foreach ([$ownId,$foreignId] as $id) {
            $email=fresh('Emails',$id);
            must(!$email->ACLAccess('edit') && !$email->ACLAccess('delete'), 'Read membership must not confer write access');
        }
    });
    check('administrator and explicit-deny service access remain unchanged under new defaults', function () use ($admin,$ownId,$foreignId,$group): void {
        foreach ([$ownId,$foreignId] as $id) {
            futureAssertSurface(futureReadSurfaces($admin,$id),true);
            selectUser($admin); $email=fresh('Emails',$id);
            must($email->ACLAccess('edit') && $email->ACLAccess('delete'), 'Admin write access must remain unchanged');
        }
        foreach (['service-one','service-two'] as $label) {
            $found=lifecycleRows('SELECT id FROM users WHERE deleted=0 AND user_name='.lifecycleQ('fixture-installed-'.$label));
            must(count($found)===1,'Exact explicit-deny synthetic service required');
            selectUser($admin); linkBeans($group,'users',[$found[0]['id']]);
            $service=fresh('Users',$found[0]['id']);
            foreach ([$ownId,$foreignId] as $id) futureAssertSurface(futureReadSurfaces($service,$id),false);
        }
    });

    check('an explicit ALL override still fails exact-reader admission instead of being certified by defaults', function () use ($admin,$adminId,$futureId,$futureUser,$foreignId): void {
        selectUser($admin);
        lifecycleSql('SAVEPOINT future_explicit_all');
        try {
            $role=native('ACLRoles'); $role->name='Synthetic conflicting explicit Email ALL'; $role->save(false);
            foreach (futureDefaultRows() as $action) if (in_array($action['name'],['view','list','export'],true)) {
                $role->setAction($role->id,$action['id'],ACL_ALLOW_ALL);
            }
            linkBeans($role,'users',[$futureId]);
            futureAssertSurface(futureReadSurfaces($futureUser,$foreignId),true);
            $held=false;
            try { futureRequireReaders($foreignId,[$adminId]); }
            catch (LifecycleRefused $error) { $held=$error->getMessage()==='Unexpected effective Email reader'; }
            must($held,'Defaults cannot override an explicitly permissive role');
        } finally { lifecycleSql('ROLLBACK TO SAVEPOINT future_explicit_all'); }
        selectUser($futureUser);
        futureAssertSurface(futureReadSurfaces($futureUser,$foreignId),false);
    });

    check('ordinary role repair preserves scoped defaults while default drift or delete-and-recreate is refused', function () use ($admin,$pinned): void {
        selectUser($admin);
        ACLAction::addActions('Emails');
        futureRequireDefaults($pinned);
        foreach (['value','recreate'] as $kind) {
            lifecycleSql('SAVEPOINT future_default_drift');
            try {
                $view=array_values(array_filter($pinned,static fn($row)=>$row['name']==='view'))[0];
                if ($kind==='value') lifecycleSql('UPDATE acl_actions SET aclaccess=90 WHERE id='.lifecycleQ($view['id']));
                else {
                    lifecycleSql('UPDATE acl_actions SET deleted=1 WHERE id='.lifecycleQ($view['id']));
                    ACLAction::addActions('Emails');
                    $replacement=array_values(array_filter(futureDefaultRows(),static fn($row)=>$row['name']==='view'));
                    must(count($replacement)===1 && $replacement[0]['id']!==$view['id'] && (int)$replacement[0]['aclaccess']===90,
                        'Stock recreation returns to ALL and must be detected, not silently accepted');
                }
                $held=false;
                try { futureRequireDefaults($pinned); }
                catch (LifecycleRefused $error) { $held=$error->getMessage()==='Native Email default policy drift'; }
                must($held,'Changed or recreated native defaults must fail the policy pin');
            } finally { lifecycleSql('ROLLBACK TO SAVEPOINT future_default_drift'); }
            futureRequireDefaults($pinned);
        }
    });
    must([lifecycleEmailSnapshot($ownId),lifecycleEmailSnapshot($foreignId)]===$messageBefore, 'Access correction must preserve Email content, ownership and native links');
    must(lifecycleRows($otherDefaultsSql)===$otherBefore,'Other defaults must remain identical after all checks');
    lifecycleEnd($transaction,false); $transaction=null;
    must(futureDefaultsState()===$beforeState,'Entire experiment must roll back every tracked default, principal, group, role and message row');
    fwrite(STDOUT,'CLAWPILOT_NATIVE_FUTURE_DEFAULTS='.json_encode([
        'syntheticOnly'=>true,'productionApplied'=>false,'rolledBack'=>true,'checks'=>$checks,
        'readDefaults'=>'group-or-owner','writeDefaults'=>'owner-only','futureReaderCannotEditGroupEmail'=>true,
        'nonEmailDefaultsUnchanged'=>true,'explicitAllStillRequiresHold'=>true,'recreatedDefaultsRequireHold'=>true,
        'excluded'=>['live approval','runtime enforcement of policy drift','mixed viewer/editor pipeline write policy','all native HTTP surfaces','delivery'],
    ],JSON_THROW_ON_ERROR)."\n");
    fwrite(STDOUT,"NATIVE_FUTURE_EMAIL_DEFAULTS_PASSED=checks={$checks}; synthetic 3 group-read + 2 owner-write defaults; exact pipeline grants; full rollback; no production approval.\n");
} catch (Throwable $error) {
    if ($transaction!==null) { try { lifecycleEnd($transaction,false); } catch (Throwable $rollbackError) { fwrite(STDERR,"Future-default rollback failed\n"); } }
    fwrite(STDERR,'Native future Email defaults failed: '.get_class($error).': '.$error->getMessage()."\n");
    exit(1);
}
