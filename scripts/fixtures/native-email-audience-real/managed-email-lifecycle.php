<?php
declare(strict_types=1);

// A disposable, frozen-policy native rehearsal, NOT a production publisher.
// No cooperative application lock is represented as fencing native admins,
// independent DB writers, filesystem changes, or application-DB membership.
if (getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1') throw new RuntimeException('Opt-in candidate required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY', true);
require '/fixture/acceptance.php';
require '/fixture/managed-email-lifecycle-helper.php';

function lifecyclePrincipal(string $name)
{
    $found = lifecycleRows('SELECT id FROM users WHERE deleted=0 AND user_name='.lifecycleQ($name));
    must(count($found) === 1, 'Exactly one synthetic principal required');
    return fresh('Users', $found[0]['id']);
}
function lifecycleMap(array $input, string $workspace, string $pipeline, bool $archived = false): void
{
    lifecycleSql('INSERT INTO cp_fixture_email_map(email_id,global_id,workspace_id,pipeline_id,app_archived) VALUES ('.
        lifecycleQ($input['id']).','.lifecycleQ($input['globalId']).','.lifecycleQ($workspace).','.lifecycleQ($pipeline).','.($archived ? '1' : '0').')');
}
function lifecycleCommand(string $operation, string $mode, string $workspace, string $pipeline, array $emails, int $version = 1): array
{
    return ['operation'=>$operation,'mode'=>$mode,'workspace'=>$workspace,'pipeline'=>$pipeline,'version'=>$version,'emails'=>$emails];
}
function lifecycleRefusal(array $context, array $command, string $reason, ?callable $callback = null): void
{
    $before = lifecycleStateDigest(); $denied = false;
    try { lifecycleApply($context, $command, $callback); }
    catch (LifecycleRefused $error) { $denied = str_contains($error->getMessage(), $reason); }
    must($denied, 'Expected refusal: '.$reason);
    must(lifecycleStateDigest() === $before, 'Refusal must leave all tracked native and fixture rows identical');
}
function lifecycleSurfaces($user, string $emailId, bool $expected): void
{
    selectUser($user);
    $email = fresh('Emails', $emailId);
    foreach (['view','list','export'] as $surface) must((bool) $email->ACLAccess($surface) === $expected, 'Native '.$surface.' mismatch');
    $view = false; $list = [];
    try { $view = (actualV8Record($emailId)['data']['id'] ?? '') === $emailId; }
    catch (SuiteCRM\Exception\AccessDeniedException $error) {}
    try { $list = actualV8List($emailId); }
    catch (SuiteCRM\Exception\AccessDeniedException $error) {}
    $csv = ACLController::checkAccess('Emails', 'export', true) ? export('Emails', $emailId) : '';
    must($view === $expected && in_array($emailId, $list, true) === $expected
        && in_array($emailId, actualUiList($emailId), true) === $expected && str_contains($csv, $emailId) === $expected,
        'Actual native V8/UI-list/export result mismatch');
}

try {
    $_REQUEST = [];
    lifecycleProfile();
    $runtime = lifecycleRuntimeDigest();
    $admin = lifecyclePrincipal('fixture-admin');
    $target = lifecyclePrincipal('fixture-installed-blank-status-unroled');
    $service = lifecyclePrincipal('fixture-installed-service-one');
    $adminId = (string) $admin->id; $targetId = (string) $target->id;
    must($admin->isAdmin() && !$target->isAdmin(), 'Pinned synthetic principal classes required');
    selectUser($admin);
    // These credentials only exist inside the disposable fixture network.
    $observer = new mysqli('db', 'fixture', 'Synthetic-native-db-password-only', 'suitecrm_native_test', 3306);
    must(!$observer->connect_errno, 'Independent native observer connection required');
    $observer->set_charset('utf8mb4');
    $observer->query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
    $observer->autocommit(true);
    $writerId = (int) lifecycleRows('SELECT CONNECTION_ID() AS id')[0]['id'];
    $observerId = (int) lifecycleRows('SELECT CONNECTION_ID() AS id', $observer)[0]['id'];
    must($writerId !== $observerId, 'Transaction observer must use a separate MariaDB connection');

    // Trusted fixture-only registry; no operator labels are treated as identity.
    // DDL is completed BEFORE any transaction being tested.
    lifecycleSql('CREATE TABLE cp_fixture_email_policy (workspace_id VARCHAR(64) NOT NULL, pipeline_id VARCHAR(64) NOT NULL, group_id CHAR(36) NOT NULL, version INT NOT NULL, members_json TEXT NOT NULL, PRIMARY KEY(workspace_id,pipeline_id), UNIQUE KEY(group_id)) ENGINE=InnoDB');
    lifecycleSql('CREATE TABLE cp_fixture_email_map (email_id CHAR(36) PRIMARY KEY, global_id VARCHAR(32) NOT NULL UNIQUE, workspace_id VARCHAR(64) NOT NULL, pipeline_id VARCHAR(64) NOT NULL, app_archived TINYINT NOT NULL) ENGINE=InnoDB');
    lifecycleSql('CREATE TABLE cp_fixture_email_receipt (operation_id VARCHAR(64) PRIMARY KEY, command_hash CHAR(64) NOT NULL, result_hash CHAR(64) NOT NULL) ENGINE=InnoDB');
    $engines = lifecycleRows("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
    check('managed lifecycle uses only InnoDB and an actual independent MariaDB observer', function () use ($engines): void {
        must(count($engines) > 100, 'The actual installed native schema is required');
        foreach ($engines as $table) must($table['ENGINE'] === 'InnoDB', 'Nontransactional native table: '.$table['TABLE_NAME']);
        must(str_starts_with(lifecycleRows('SELECT VERSION() AS version')[0]['version'], '11.4.'), 'Pinned MariaDB version required');
    });

    $scopes = [
        'own'=>['workspace'=>'synthetic-suburbia','pipeline'=>'synthetic-suburbia-one','members'=>[$targetId]],
        'other'=>['workspace'=>'synthetic-suburbia','pipeline'=>'synthetic-suburbia-two','members'=>[]],
        'bpo'=>['workspace'=>'synthetic-bpo','pipeline'=>'synthetic-bpo-one','members'=>[]],
    ];
    check('exact pipeline groups and memberships are created together without inheritable access', function () use (&$scopes,$observer): void {
        foreach ($scopes as $key => &$scope) {
            $connection = lifecycleBegin();
            try {
                $group = native('SecurityGroups');
                $group->name = 'Synthetic managed Email pipeline '.$key;
                $group->description = 'Disposable exact-pipeline lifecycle proof';
                $group->noninheritable = 1;
                $group->save(false);
                $scope['group'] = (string) $group->id;
                must($scope['group'] !== '', 'Native managed group must be saved');
                linkBeans($group, 'users', $scope['members']);
                // Set only newly created synthetic link rows. Both native group
                // and membership prohibit creator/assigned-user inheritance.
                lifecycleSql('UPDATE securitygroups_users SET noninheritable=1 WHERE deleted=0 AND securitygroup_id='.lifecycleQ($scope['group']));
                lifecycleSql('INSERT INTO cp_fixture_email_policy(workspace_id,pipeline_id,group_id,version,members_json) VALUES ('.
                    lifecycleQ($scope['workspace']).','.lifecycleQ($scope['pipeline']).','.lifecycleQ($scope['group']).',1,'.lifecycleQ(json_encode($scope['members'], JSON_THROW_ON_ERROR)).')');
                must(lifecycleRows('SELECT id FROM securitygroups WHERE id='.lifecycleQ($scope['group']), $observer) === []
                    && lifecycleRows('SELECT group_id FROM cp_fixture_email_policy WHERE group_id='.lifecycleQ($scope['group']), $observer) === [],
                    'Uncommitted managed group and policy must be invisible to another connection');
                lifecycleEnd($connection, true);
                must(count(lifecycleRows('SELECT id FROM securitygroups WHERE id='.lifecycleQ($scope['group']), $observer)) === 1,
                    'Committed native group must become visible');
            } catch (Throwable $error) { lifecycleEnd($connection, false); throw $error; }
        }
        unset($scope);
    });

    $history = [];
    foreach (['own','archived','other','bpo'] as $offset => $key) {
        $scope = $scopes[$key === 'archived' ? 'own' : $key];
        $globalId = 'gi890000'.($offset + 1);
        $email = emailFixture('Synthetic lifecycle history '.$key, $globalId, $adminId);
        $input = ['id'=>(string) $email->id,'globalId'=>$globalId];
        $input['expectedContentFingerprint'] = lifecycleDigest(lifecycleEmailSnapshot($input['id']));
        must(lifecycleGroups($input['id']) === [], 'History begins without an inferred group');
        lifecycleMap($input, $scope['workspace'], $scope['pipeline'], $key === 'archived');
        $history[$key] = $input;
    }
    $future = [];
    foreach (['own','rollback','revoked','missingNative'] as $offset => $key) {
        $input = ['id'=>create_guid(),'globalId'=>'gi890001'.($offset + 1),
            'name'=>'Synthetic lifecycle future '.$key,'body'=>"Synthetic future body {$key}\nSecond line"];
        lifecycleMap($input, $scopes['own']['workspace'], $scopes['own']['pipeline']);
        $future[$key] = $input;
    }
    $context = ['adminId'=>$adminId,'frozenPolicy'=>lifecyclePolicyDigest(),'frozenRuntime'=>$runtime];
    $ownRepair = lifecycleCommand('repair-own-v1','repair',$scopes['own']['workspace'],$scopes['own']['pipeline'],[$history['own'],$history['archived']]);
    $historyBefore = [$history['own']['id']=>lifecycleEmailSnapshot($history['own']['id']),$history['archived']['id']=>lifecycleEmailSnapshot($history['archived']['id'])];
    $archiveBefore = lifecycleRows('SELECT * FROM cp_fixture_email_map ORDER BY email_id');
    check('existing-only historical repair preserves identity, contents, relationships and app archive state', function () use ($context,$ownRepair,$observer,$historyBefore,$archiveBefore): void {
        must(lifecycleApply($context, $ownRepair, function () use ($observer,$historyBefore): void {
            foreach ($historyBefore as $id => $snapshot) {
                must(lifecycleEmailSnapshot($id, $observer) === $snapshot, 'Committed history contents must remain unchanged');
                must(lifecycleRows("SELECT id FROM securitygroups_records WHERE module='Emails' AND deleted=0 AND record_id=".lifecycleQ($id), $observer) === [],
                    'Uncommitted permission repair must not be visible');
            }
        }) === 'applied', 'History must be repaired');
        foreach ($historyBefore as $id => $snapshot) must(lifecycleEmailSnapshot($id, $observer) === $snapshot, 'Committed history contents must be byte-identical');
        must(lifecycleRows('SELECT * FROM cp_fixture_email_map ORDER BY email_id') === $archiveBefore, 'App archive mapping must not change');
    });

    $publish = lifecycleCommand('publish-own-v1','publish',$scopes['own']['workspace'],$scopes['own']['pipeline'],[$future['own']]);
    check('future Email, body, exact group and receipt become visible only after one native commit', function () use ($context,$publish,$observer,$future,$admin,$target,$service): void {
        $id = $future['own']['id'];
        must(lifecycleApply($context, $publish, function () use ($observer,$id): void {
            must(count(lifecycleEmailSnapshot($id)['emails']) === 1 && count(lifecycleGroups($id)) === 1, 'Writer must see the complete candidate');
            foreach (lifecycleEmailSnapshot($id, $observer) as $tableRows) must($tableRows === [], 'Observer saw an uncommitted Email row/body');
            must(lifecycleRows("SELECT id FROM securitygroups_records WHERE module='Emails' AND record_id=".lifecycleQ($id), $observer) === [], 'Observer saw an uncommitted group');
            must(lifecycleRows("SELECT operation_id FROM cp_fixture_email_receipt WHERE operation_id='publish-own-v1'", $observer) === [], 'Observer saw an uncommitted receipt');
        }) === 'applied', 'Future native save must apply');
        must(count(lifecycleEmailSnapshot($id, $observer)['emails']) === 1
            && count(lifecycleRows("SELECT id FROM securitygroups_records WHERE module='Emails' AND deleted=0 AND record_id=".lifecycleQ($id), $observer)) === 1
            && count(lifecycleRows("SELECT operation_id FROM cp_fixture_email_receipt WHERE operation_id='publish-own-v1'", $observer)) === 1,
            'Committed Email/group/receipt must be visible to the independent observer');
        lifecycleSurfaces($target,$id,true); lifecycleSurfaces($admin,$id,true); lifecycleSurfaces($service,$id,false);
        selectUser($admin);
    });
    check('exact retries revalidate the current native rows/readers without duplicating anything', function () use ($context,$publish,$ownRepair): void {
        $before = lifecycleStateDigest();
        must(lifecycleApply($context,$publish) === 'replayed' && lifecycleApply($context,$ownRepair) === 'replayed', 'Both modes must accept exact retries');
        must(lifecycleStateDigest() === $before, 'Exact retry may not write duplicate rows or touch dates');
        $changed = $publish; $changed['emails'][0]['body'] .= ' changed';
        lifecycleRefusal($context,$changed,'Retry changed its command');
    });
    check('same-organization different-pipeline and BPO history remain hidden while own history works', function () use ($context,$scopes,$history,$admin,$target): void {
        foreach (['other','bpo'] as $key) {
            $scope = $scopes[$key];
            lifecycleApply($context,lifecycleCommand('repair-'.$key,'repair',$scope['workspace'],$scope['pipeline'],[$history[$key]]));
            lifecycleSurfaces($target,$history[$key]['id'],false); lifecycleSurfaces($admin,$history[$key]['id'],true);
            selectUser($admin);
        }
        foreach (['own','archived'] as $key) lifecycleSurfaces($target,$history[$key]['id'],true);
        selectUser($admin);
    });
    check('missing mapping/native history, wrong pipeline, stale version and fingerprint drift refuse without writes', function () use ($context,$scopes,$history,$future,$ownRepair,$publish): void {
        $missing = $publish; $missing['operation'] = 'missing-map'; $missing['emails'][0]['id'] = create_guid();
        lifecycleRefusal($context,$missing,'Missing or different exact pipeline mapping');
        $missingNative = lifecycleCommand('missing-native','repair',$scopes['own']['workspace'],$scopes['own']['pipeline'],[$future['missingNative']]);
        $missingNative['emails'][0]['expectedContentFingerprint'] = lifecycleDigest(lifecycleEmailSnapshot($future['missingNative']['id']));
        lifecycleRefusal($context,$missingNative,'Duplicate or changed native Global ID');
        $wrongPipeline = lifecycleCommand('wrong-pipeline','repair',$scopes['other']['workspace'],$scopes['other']['pipeline'],[$history['own']]);
        lifecycleRefusal($context,$wrongPipeline,'Missing or different exact pipeline mapping');
        $stale = $publish; $stale['version'] = 0;
        lifecycleRefusal($context,$stale,'Policy version/binding drift');
        $drift = $ownRepair; $drift['operation'] = 'content-drift'; $drift['emails'][0]['expectedContentFingerprint'] = str_repeat('0',64);
        lifecycleRefusal($context,$drift,'Historical content fingerprint drift');
    });
    check('unknown native groups and observed native policy drift hold the operation', function () use ($context,$ownRepair,$scopes,$history): void {
        $id = $history['own']['id'];
        $foreignGroup = $scopes['bpo']['group'];
        fresh('SecurityGroups',$foreignGroup)->addGroupToRecord('Emails',$id,$foreignGroup);
        $extra = lifecycleRows("SELECT id FROM securitygroups_records WHERE deleted=0 AND module='Emails' AND record_id=".lifecycleQ($id).' AND securitygroup_id='.lifecycleQ($foreignGroup));
        must(count($extra) === 1, 'Exactly the injected synthetic link must exist');
        $unknown = $ownRepair; $unknown['operation'] = 'unknown-group';
        lifecycleRefusal($context,$unknown,'Unknown or inherited Email group');
        lifecycleSql('DELETE FROM securitygroups_records WHERE id='.lifecycleQ($extra[0]['id']));
        $groupId = $scopes['own']['group'];
        $description = lifecycleRows('SELECT description FROM securitygroups WHERE id='.lifecycleQ($groupId))[0]['description'];
        lifecycleSql('UPDATE securitygroups SET description='.lifecycleQ('Synthetic observed policy drift').' WHERE id='.lifecycleQ($groupId));
        lifecycleRefusal($context,$ownRepair,'Frozen native policy drift');
        lifecycleSql('UPDATE securitygroups SET description='.lifecycleQ($description).' WHERE id='.lifecycleQ($groupId));
        must(hash_equals($context['frozenPolicy'],lifecyclePolicyDigest()), 'Synthetic drift must be fully restored');
    });
    check('failure after native Email/body/group writes rolls every tracked row back on MariaDB', function () use ($context,$scopes,$future,$observer): void {
        $command = lifecycleCommand('rollback-after-native-save','publish',$scopes['own']['workspace'],$scopes['own']['pipeline'],[$future['rollback']]);
        $id = $future['rollback']['id']; $before = lifecycleStateDigest($observer);
        lifecycleRefusal($context,$command,'Injected failure after native Email and group',function () use ($id,$observer): void {
            must(count(lifecycleEmailSnapshot($id)['emails']) === 1 && count(lifecycleGroups($id)) === 1, 'Fault must follow real native writes');
            foreach (lifecycleEmailSnapshot($id,$observer) as $tableRows) must($tableRows === [], 'Uncommitted failed rows leaked');
            throw new LifecycleRefused('Injected failure after native Email and group');
        });
        must(lifecycleStateDigest($observer) === $before, 'Independent connection must confirm full rollback, including addresses and relationships');
    });
    check('duplicate native Global ID refuses historical repair', function () use ($context,$adminId,$scopes): void {
        $first = emailFixture('Synthetic duplicate Global ID one','gi8900099',$adminId);
        $second = emailFixture('Synthetic duplicate Global ID two','gi8900099',$adminId);
        must($first->id !== $second->id, 'Native duplicate identity counterexample required');
        $input = ['id'=>(string)$first->id,'globalId'=>'gi8900099','expectedContentFingerprint'=>lifecycleDigest(lifecycleEmailSnapshot((string)$first->id))];
        lifecycleMap($input,$scopes['own']['workspace'],$scopes['own']['pipeline']);
        lifecycleRefusal($context,lifecycleCommand('duplicate-global','repair',$scopes['own']['workspace'],$scopes['own']['pipeline'],[$input]),'Duplicate or changed native Global ID');
    });
    check('versioned native membership revocation removes access to past and future messages without rewriting them', function () use (&$context,$scopes,$history,$future,$admin,$target,$targetId): void {
        $ids = [$history['own']['id'],$history['archived']['id'],$future['own']['id']];
        $before = []; foreach ($ids as $id) $before[$id] = lifecycleEmailSnapshot($id);
        $connection = lifecycleBegin();
        try {
            $policy = lifecycleRows('SELECT * FROM cp_fixture_email_policy WHERE group_id='.lifecycleQ($scopes['own']['group']).' FOR UPDATE')[0];
            must((int)$policy['version'] === 1, 'Revocation must compare the admitted policy version');
            $group = fresh('SecurityGroups',$policy['group_id']);
            must($group->load_relationship('users'), 'Native group membership link required');
            $group->users->delete($group->id,$targetId);
            lifecycleSql('UPDATE cp_fixture_email_policy SET version=2,members_json='.lifecycleQ('[]').' WHERE group_id='.lifecycleQ($policy['group_id']).' AND version=1');
            $policy['members_json'] = '[]'; $policy['version'] = 2;
            foreach ($ids as $id) lifecycleAssertReaders($context,$policy,$id);
            lifecycleEnd($connection,true);
        } catch (Throwable $error) { lifecycleEnd($connection,false); throw $error; }
        // This is an explicitly authorized synthetic policy transition. It does
        // not prove that uncooperative/native administrative writers are fenced.
        $context['frozenPolicy'] = lifecyclePolicyDigest();
        foreach ($ids as $id) {
            must(lifecycleEmailSnapshot($id) === $before[$id], 'Revocation may not rewrite any message');
            lifecycleSurfaces($target,$id,false); lifecycleSurfaces($admin,$id,true);
        }
        selectUser($admin);
        $stale = lifecycleCommand('post-revocation-stale','publish',$scopes['own']['workspace'],$scopes['own']['pipeline'],[$future['revoked']],1);
        lifecycleRefusal($context,$stale,'Policy version/binding drift');
        $current = $stale; $current['operation']='post-revocation-current'; $current['version']=2;
        must(lifecycleApply($context,$current) === 'applied', 'Future publication must follow the current exact policy version');
        lifecycleSurfaces($target,$future['revoked']['id'],false); lifecycleSurfaces($admin,$future['revoked']['id'],true);
        selectUser($admin);
    });

    $observer->close();
    fwrite(STDOUT,'CLAWPILOT_NATIVE_MANAGED_LIFECYCLE='.json_encode([
        'syntheticOnly'=>true,'productionApplied'=>false,'frozenPolicyOnly'=>true,'checks'=>$checks,
        'historicalContentPreserved'=>true,'newEmailAndGroupAtomic'=>true,'independentConnections'=>true,
        'allInstalledNativePrincipalsCheckedBeforeCommit'=>true,'exactRetryRevalidated'=>true,'rollbackAfterNativeSave'=>true,
        'exactPipelineRevocation'=>true,'transactionalTables'=>count($engines),'preparedRuntimeHash'=>$runtime,
        'excluded'=>['unfenced native policy concurrency','application database atomicity','production runtime/profile approval','external delivery'],
    ],JSON_THROW_ON_ERROR)."\n");
    fwrite(STDOUT,"NATIVE_MANAGED_EMAIL_LIFECYCLE_PASSED=checks={$checks}; synthetic native future/history/rollback/revocation under frozen policy only; no production approval or concurrent-policy fence.\n");
} catch (Throwable $error) {
    fwrite(STDERR,'Native managed Email lifecycle failed: '.get_class($error).': '.$error->getMessage()."\n");
    exit(1);
}
