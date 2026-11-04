<?php
declare(strict_types=1);

// Synthetic only. No runtime route/installer, permissions, or existing fixture
// files are changed. Run after the installed remediation/lifecycle stages.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1') throw new RuntimeException('Opt-in fixture required');
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/fixture/managed-email-lifecycle-helper.php';
require '/source/email-audience/NativeEmailTransaction.php';

function deltaInsert(mysqli $db,array $row): void
{
    $keys = array_keys($row); sort($keys,SORT_STRING);
    must($keys === ['created_by','date_modified','deleted','id','modified_user_id','module','record_id','securitygroup_id'],'Exact native link columns required');
    $values = array_map(static fn($value) => $value === null ? 'NULL' : "'".$db->real_escape_string((string)$value)."'",$row);
    must($db->query('INSERT INTO securitygroups_records (`'.implode('`,`',array_keys($row)).'`) VALUES ('.implode(',',$values).')') === true
        && $db->affected_rows === 1,'Exactly one native link insertion required');
}
/** SQL column order is not identity; all column names, NULLs and values are. */
function deltaRowMatches(array $actual,array $expected): bool
{
    if(count($actual)!==count($expected) || array_diff_key($actual,$expected)) return false;
    foreach($expected as $key=>$value) {
        if($value===null) {if($actual[$key]!==null) return false;}
        elseif(!is_scalar($actual[$key]) || (string)$actual[$key]!==$value) return false;
    }
    return true;
}
function deltaState(?mysqli $observer = null): string
{
    $state = [];
    foreach (ClawPilotNativeEmailTransaction::policyTables() as $table) {
        $order = $table === 'config' ? 'category,name,value' : 'id';
        $state[$table] = lifecycleRows('SELECT * FROM '.$table.' ORDER BY '.$order,$observer);
    }
    foreach (['emails'=>'id','emails_text'=>'email_id','emails_cstm'=>'id_c','emails_beans'=>'id',
        'emails_email_addr_rel'=>'id','email_addresses'=>'id','email_addr_bean_rel'=>'id'] as $table=>$order) {
        $state[$table] = lifecycleRows('SELECT * FROM '.$table.' ORDER BY '.$order,$observer);
    }
    return lifecycleDigest($state);
}
function deltaRefusal(mysqli $db,mysqli $observer,array $profile,string $expected,callable $run): void
{
    $before = deltaState($observer); $fence = ClawPilotNativeEmailTransaction::begin($db,$profile); $refused = false;
    try { $run($fence); }
    catch (ClawPilotNativeEmailTransactionRefused $error) { $refused = $error->holdCode === $expected; }
    finally { unset($fence); }
    must($refused,'Expected exact delta refusal: '.$expected);
    must((int)lifecycleRows('SELECT @@in_transaction AS active')[0]['active'] === 0 && deltaState($observer) === $before,
        'Refused delta must roll back all native rows and end its transaction');
}
function deltaReads($user,string $id): bool
{
    $previousUser = $GLOBALS['current_user']; $previousSession = $_SESSION;
    try {
        selectUser($user); $email = fresh('Emails',$id);
        return $email->ACLAccess('view') && $email->ACLAccess('list') && $email->ACLAccess('export');
    } finally { $GLOBALS['current_user']=$previousUser; $_SESSION=$previousSession; }
}
/** Delete only a just-created, verified synthetic probe row. */
function deltaRemoveProbe(mysqli $db,array $row): void
{
    $actual = lifecycleRows('SELECT * FROM securitygroups_records WHERE id='.lifecycleQ($row['id']));
    must(count($actual) === 1 && deltaRowMatches($actual[0],$row),'Only the exact synthetic probe row may be removed');
    must($db->query('DELETE FROM securitygroups_records WHERE id='.lifecycleQ($row['id'])) === true && $db->affected_rows === 1,
        'Exact synthetic probe cleanup required');
}

(static function () use (&$checks): void {
try {
    $_REQUEST = []; lifecycleProfile(); lifecycleRuntimeDigest();
    $native = DBManagerFactory::getInstance();
    must($native instanceof MysqliManager && $native->database instanceof mysqli,'Native mysqli connection required');
    $db = $native->database;
    $observer = new mysqli('db','fixture','Synthetic-native-db-password-only','suitecrm_native_test',3306);
    $observer->set_charset('utf8mb4');
    must($observer->thread_id !== $db->thread_id,'Independent native observer required');
    $profile = ['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'];
    $adminId = rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0")[0]['id'];
    $targetId = rows("SELECT id FROM users WHERE user_name='fixture-installed-blank-status-unroled' AND deleted=0")[0]['id'];
    $admin = fresh('Users',$adminId); $target = fresh('Users',$targetId); selectUser($admin);
    $group = native('SecurityGroups'); $group->name = 'Synthetic exact-delta authorized group'; $group->noninheritable = 1; $group->save(false);
    linkBeans($group,'users',[$targetId]);
    lifecycleSql('UPDATE securitygroups_users SET noninheritable=1 WHERE securitygroup_id='.lifecycleQ((string)$group->id));
    $foreign = native('SecurityGroups'); $foreign->name = 'Synthetic exact-delta foreign group'; $foreign->noninheritable = 1; $foreign->save(false);
    $email = emailFixture('Synthetic exact-delta history','gi9020001',$adminId);
    $other = emailFixture('Synthetic exact-delta other Email','gi9020002',$adminId);
    $emailId = (string)$email->id; $otherId = (string)$other->id; $groupId = (string)$group->id; $foreignId = (string)$foreign->id;
    $make = static fn() => new ClawPilotNativeEmailGroupRecordInsert(create_guid(),$emailId,'gi9020001',$groupId,'2026-10-30 12:00:00',$adminId,$adminId);
    $historical = lifecycleEmailSnapshot($emailId);
    must(lifecycleGroups($emailId) === [] && !deltaReads($target,$emailId),'Fresh synthetic history must begin without an allowed group');

    check('typed Email delta refuses invalid IDs, Global IDs and non-canonical dates',function () use ($make,$emailId,$groupId,$adminId): void {
        foreach ([['not-a-guid','gi9020001','2026-10-30 12:00:00'],[create_guid(),'bad-global','2026-10-30 12:00:00'],
            [create_guid(),'gi9020001','2026-02-30 12:00:00'],[create_guid(),'gi9020001','2026-10-30T12:00:00Z']] as $values) {
            $refused = false;
            try { new ClawPilotNativeEmailGroupRecordInsert($values[0],$emailId,$values[1],$groupId,$values[2],$adminId,$adminId); }
            catch (ClawPilotNativeEmailTransactionRefused $error) { $refused = $error->holdCode === 'invalid_email_group_delta'; }
            must($refused,'Malformed typed delta must be refused');
        }
        $row=$make()->nativeRow();
        must(count($row) === 8 && array_key_exists('modified_user_id',$row) && $row['modified_user_id']===null
            && array_key_exists('created_by',$row) && $row['created_by']===null,'All eight stock columns, including NULL audit fields, are pinned');
    });
    check('one admitted exact link commits atomically and preserves every historical Email field',function () use ($db,$observer,$profile,$make,$historical,$emailId,$target): void {
        $delta = $make(); $fence = ClawPilotNativeEmailTransaction::begin($db,$profile);
        $full = $fence->policyFingerprint(); $immutable = $fence->immutablePolicyFingerprint();
        $fence->assertConnection($db); $fence->admitEmailGroupRecordInsert($delta);
        must(lifecycleRows('SELECT id FROM securitygroups_records WHERE id='.lifecycleQ($delta->linkId)) === [],'Admission must not write the row');
        deltaInsert($db,$delta->nativeRow()); $fence->assertEmailGroupRecordInsert();
        must(lifecycleRows('SELECT id FROM securitygroups_records WHERE id='.lifecycleQ($delta->linkId),$observer) === [],'Uncommitted group grant must remain invisible');
        $fence->commit();
        must(lifecycleEmailSnapshot($emailId,$observer) === $historical && deltaReads($target,$emailId),'History must remain byte-identical and become natively readable');
        $committed=lifecycleRows('SELECT * FROM securitygroups_records WHERE id='.lifecycleQ($delta->linkId),$observer);
        must(count($committed)===1 && deltaRowMatches($committed[0],$delta->nativeRow()),'Committed native link must match all eight stock columns');
        $again = ClawPilotNativeEmailTransaction::begin($db,$profile);
        must($again->policyFingerprint() !== $full && $again->immutablePolicyFingerprint() === $immutable,
            'Full manifest changes, but immutable binding pin must survive the exact record grant');
        $again->commit(); // unchanged existing link requires no delta admission
        deltaRemoveProbe($db,$delta->nativeRow());
        must(!deltaReads($target,$emailId),'Only the synthetic probe grant was removed');
    });
    check('new native Email and admitted group link commit together on the same connection',function () use ($db,$observer,$profile,$groupId,$adminId,$target): void {
        $fence = ClawPilotNativeEmailTransaction::begin($db,$profile);
        $email = emailFixture('Synthetic exact-delta future','gi9020003',$adminId); $id = (string)$email->id;
        $delta = new ClawPilotNativeEmailGroupRecordInsert(create_guid(),$id,'gi9020003',$groupId,'2026-10-30 12:00:00',$adminId,$adminId);
        $fence->admitEmailGroupRecordInsert($delta); deltaInsert($db,$delta->nativeRow());
        must(lifecycleEmailSnapshot($id,$observer)['emails'] === [],'Native content must remain invisible before commit');
        $fence->commit();
        must(count(lifecycleEmailSnapshot($id,$observer)['emails']) === 1 && deltaReads($target,$id),'Native content and exact grant must both be committed');
    });
    check('immutable default, late admission and second admission all refuse without retained writes',function () use ($db,$observer,$profile,$make): void {
        deltaRefusal($db,$observer,$profile,'policy_changed_inside_fence',function ($fence) use ($db,$make): void {
            deltaInsert($db,$make()->nativeRow()); $fence->commit();
        });
        deltaRefusal($db,$observer,$profile,'policy_changed_before_delta_admission',function ($fence) use ($db,$make): void {
            $delta=$make(); deltaInsert($db,$delta->nativeRow()); $fence->admitEmailGroupRecordInsert($delta);
        });
        deltaRefusal($db,$observer,$profile,'email_group_delta_already_admitted',function ($fence) use ($db,$make): void {
            $delta=$make(); $fence->admitEmailGroupRecordInsert($delta); deltaInsert($db,$delta->nativeRow()); $fence->admitEmailGroupRecordInsert($make());
        });
    });
    check('existing, deleted, foreign, wrong-module, duplicate and reused-ID links cannot be adopted',function () use ($db,$observer,$profile,$make,$foreignId,$otherId): void {
        foreach (['existing','deleted','foreign','module','duplicate','reused-id'] as $variant) {
            $delta=$make(); $row=$delta->nativeRow();
            if ($variant === 'deleted') $row['deleted']='1';
            if ($variant === 'foreign') $row['securitygroup_id']=$foreignId;
            if ($variant === 'module') $row['module']='Accounts';
            if ($variant === 'reused-id') $row['record_id']=$otherId;
            $probes=[$row]; if ($variant === 'duplicate') { $extra=$row; $extra['id']=create_guid(); $probes[]=$extra; }
            foreach ($probes as $probe) deltaInsert($db,$probe);
            try { deltaRefusal($db,$observer,$profile,'email_group_link_not_new',static fn($fence) => $fence->admitEmailGroupRecordInsert($delta)); }
            finally { foreach ($probes as $probe) deltaRemoveProbe($db,$probe); }
        }
    });
    check('commit requires exactly the admitted new native row, including ID, target, group, date, module, audit fields and deletion state',function () use ($db,$observer,$profile,$make,$foreignId,$otherId): void {
        foreach (['missing','id','record','group','date','module','modified_user_id','created_by','deleted','duplicate'] as $variant) {
            deltaRefusal($db,$observer,$profile,'email_group_link_readback_mismatch',function ($fence) use ($db,$make,$variant,$foreignId,$otherId): void {
                $delta=$make(); $fence->admitEmailGroupRecordInsert($delta); $row=$delta->nativeRow();
                if ($variant === 'id') $row['id']=create_guid();
                if ($variant === 'record') $row['record_id']=$otherId;
                if ($variant === 'group') $row['securitygroup_id']=$foreignId;
                if ($variant === 'date') $row['date_modified']='2026-10-30 12:00:01';
                if ($variant === 'module') $row['module']='Accounts';
                if ($variant === 'modified_user_id' || $variant === 'created_by') $row[$variant]='unexpected-audit-principal';
                if ($variant === 'deleted') $row['deleted']='1';
                if ($variant !== 'missing') deltaInsert($db,$row);
                if ($variant === 'duplicate') { $row['id']=create_guid(); deltaInsert($db,$row); }
                $fence->commit();
            });
        }
    });
    check('an admitted row cannot hide any unrelated native policy or record-group change',function () use ($db,$observer,$profile,$make,$otherId): void {
        foreach (['policy','other-link'] as $variant) deltaRefusal($db,$observer,$profile,'policy_changed_inside_fence',function ($fence) use ($db,$make,$otherId,$variant): void {
            $delta=$make(); $fence->admitEmailGroupRecordInsert($delta); deltaInsert($db,$delta->nativeRow());
            if ($variant === 'policy') lifecycleSql("UPDATE acl_actions SET aclaccess=75 WHERE category='Emails' AND name='view' AND deleted=0");
            else { $extra=$delta->nativeRow(); $extra['id']=create_guid(); $extra['record_id']=$otherId; deltaInsert($db,$extra); }
            $fence->commit();
        });
    });
    check('Email identity, Global ID uniqueness and ownership are checked before and after the grant',function () use ($db,$observer,$profile,$make,$emailId,$otherId,$targetId): void {
        foreach (['deleted','owner','duplicate-global'] as $variant) foreach (['before','after'] as $phase) {
            deltaRefusal($db,$observer,$profile,'email_identity_mismatch',function ($fence) use ($db,$make,$emailId,$otherId,$targetId,$variant,$phase): void {
                $delta=$make();
                if ($phase === 'after') { $fence->admitEmailGroupRecordInsert($delta); deltaInsert($db,$delta->nativeRow()); }
                if ($variant === 'deleted') lifecycleSql('UPDATE emails SET deleted=1 WHERE id='.lifecycleQ($emailId));
                elseif ($variant === 'owner') lifecycleSql('UPDATE emails SET assigned_user_id='.lifecycleQ($targetId).' WHERE id='.lifecycleQ($emailId));
                else lifecycleSql("UPDATE emails_cstm SET global_id_c='gi9020001' WHERE id_c=".lifecycleQ($otherId));
                if ($phase === 'before') $fence->admitEmailGroupRecordInsert($delta); else $fence->commit();
            });
        }
    });
    check('wrong connection and explicit rollback never retain an admitted grant',function () use ($db,$observer,$profile,$make): void {
        deltaRefusal($db,$observer,$profile,'transaction_connection_mismatch',function ($fence) use ($db,$observer,$make): void {
            $delta=$make(); $fence->admitEmailGroupRecordInsert($delta); deltaInsert($db,$delta->nativeRow()); $fence->assertConnection($observer);
        });
        $before=deltaState($observer); $fence=ClawPilotNativeEmailTransaction::begin($db,$profile); $delta=$make();
        $fence->admitEmailGroupRecordInsert($delta); deltaInsert($db,$delta->nativeRow()); $fence->rollback();
        must(deltaState($observer) === $before,'Explicit rollback must remove exactly the uncommitted grant');
    });
    check('the admitted delta does not bypass the original monotonic commit deadline',function () use ($db,$observer,$profile,$make): void {
        deltaRefusal($db,$observer,$profile,'commit_deadline_exceeded',function ($fence) use ($db,$make): void {
            $delta=$make(); $fence->admitEmailGroupRecordInsert($delta); deltaInsert($db,$delta->nativeRow()); usleep(5_100_000); $fence->commit();
        });
    });
    must(lifecycleEmailSnapshot($emailId,$observer) === $historical && lifecycleGroups($emailId) === [],'Original synthetic history must finish unchanged and ungranted');
    $observer->close();
    fwrite(STDOUT,'CLAWPILOT_NATIVE_EMAIL_GROUP_DELTA='.json_encode(['syntheticOnly'=>true,'productionApplied'=>false,'checks'=>$checks,
        'admissionBeforeWrite'=>true,'exactNativeRowReadback'=>true,'immutableDefaultPreserved'=>true,'immutableBindingPinStable'=>true,
        'excluded'=>['pipeline binding authorization','application database','filesystem policy','complete publication fidelity']],JSON_THROW_ON_ERROR)."\n");
    fwrite(STDOUT,"NATIVE_EMAIL_GROUP_DELTA_PASSED=checks={$checks}; exact pre-admitted native Email group insert only, no production publication approval.\n");
} catch (Throwable $error) {
    fwrite(STDERR,'Native Email group delta failed: '.($error instanceof ClawPilotNativeEmailTransactionRefused ? $error->holdCode : get_class($error))."\n");
    exit(1);
}
})();
