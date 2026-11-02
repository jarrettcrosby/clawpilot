<?php
declare(strict_types=1);
// Pure PHP contract/installer fixture. No SuiteCRM bootstrap, database or network.
// Usage: php scripts/fixtures/suitecrm-record-lifecycle-contract.php
require_once __DIR__.'/../../services/suitecrm/record-lifecycle/RecordLifecycle.php';
require_once __DIR__.'/../../services/suitecrm/install-record-lifecycle.php';

function lifecycle_fixture_need(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
function lifecycle_fixture_refuses(callable $call): void
{
    $refused = false;
    try { $call(); } catch (Throwable $error) { $refused = true; }
    lifecycle_fixture_need($refused, 'Invalid lifecycle operation was not refused');
}
$account = ['module'=>'Accounts','nativeId'=>'native-suburbia','globalId'=>'ga6i0qmt2qudss'];
$bpo = ['module'=>'Accounts','nativeId'=>'native-bpo','globalId'=>'gagmco24va588e'];
$contact = ['module'=>'Contacts','nativeId'=>'native-contact','globalId'=>'gc1234567'];
$command = ['version'=>1,'records'=>[$account,$bpo,$contact]];
lifecycle_fixture_need(ClawPilotRecordLifecycle::command($command) === $command['records'], 'Exact identities were changed');
$hundred = [];
for ($index = 0; $index < 100; $index++) {
    $hundred[] = ['module'=>'Accounts','nativeId'=>'native-'.$index,'globalId'=>'ga'.str_pad((string)$index,7,'0',STR_PAD_LEFT)];
}
lifecycle_fixture_need(count(ClawPilotRecordLifecycle::command(['version'=>1,'records'=>$hundred])) === 100, 'Full bound was rejected');
foreach ([null, [], ['version'=>1,'records'=>[]], ['version'=>'1','records'=>[$account]],
    ['version'=>1,'records'=>[$account],'extra'=>true], ['version'=>1,'records'=>array_merge($hundred,[$account])],
    ['version'=>1,'records'=>[$account,$account]], ['version'=>1,'records'=>[$account,array_replace($account,['nativeId'=>'NATIVE-SUBURBIA'])]],
    ['version'=>1,'records'=>[array_replace($account,['module'=>'Users'])]],
    ['version'=>1,'records'=>[array_replace($account,['globalId'=>'gc1234567'])]],
    ['version'=>1,'records'=>[array_replace($contact,['nativeId'=>"x' OR 1=1"])]]
] as $bad) lifecycle_fixture_refuses(static fn() => ClawPilotRecordLifecycle::command($bad));

$temporary = sys_get_temp_dir().'/clawpilot-lifecycle-contract-'.bin2hex(random_bytes(12));
lifecycle_fixture_need(mkdir($temporary,0700), 'Cannot create exact temporary fixture root');
$source = realpath(__DIR__.'/../../services/suitecrm/record-lifecycle');
$routePath = $temporary.'/custom/application/Ext/Api/V8/Config/routes.php';
try {
    $empty = $temporary.'/standalone';
    lifecycle_fixture_need(mkdir($empty,0700), 'Cannot create standalone fixture');
    $standalone = $empty.'/custom/application/Ext/Api/V8/Config/routes.php';
    lifecycle_fixture_need(install_clawpilot_record_lifecycle($source,$empty)['changedFiles'] === 3
        && !file_exists($empty.'/custom'), 'Standalone check must remain read-only');
    lifecycle_fixture_need(install_clawpilot_record_lifecycle($source,$empty,true)['changedFiles'] === 3
        && file_get_contents($standalone) === CLAWPILOT_RECORD_LIFECYCLE_ROUTER.CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK,
        'Standalone installation must not require Email routes');
    lifecycle_fixture_need(install_clawpilot_record_lifecycle($source,$empty,true)['changedFiles'] === 0,
        'Standalone installation must be idempotent');
    lifecycle_fixture_need(mkdir(dirname($routePath),0755,true), 'Cannot create fixture router directory');
    $original = "<?php\n// ClawPilot managed native Email audience proof v1.\n// Existing managed route bytes must survive.\n";
    file_put_contents($routePath,$original);
    $check = install_clawpilot_record_lifecycle($source,$temporary);
    lifecycle_fixture_need($check['status'] === 'ready' && $check['changedFiles'] === 3
        && file_get_contents($routePath) === $original && !file_exists($temporary.'/custom/include'), 'Read-only check mutated the tree');
    $applied = install_clawpilot_record_lifecycle($source,$temporary,true);
    lifecycle_fixture_need($applied['status'] === 'installed' && $applied['changedFiles'] === 3
        && file_get_contents($routePath) === $original.CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK, 'Managed routes were overwritten');
    lifecycle_fixture_need(install_clawpilot_record_lifecycle($source,$temporary,true)['changedFiles'] === 0, 'Installer is not idempotent');
    // Existing Email bootstrapping rewrites only its managed aggregate route.
    file_put_contents($routePath,$original);
    lifecycle_fixture_need(install_clawpilot_record_lifecycle($source,$temporary,true)['changedFiles'] === 1
        && file_get_contents($routePath) === $original.CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK, 'A repeated boot lost the lifecycle include');
    file_put_contents($routePath,"<?php\n// Unmanaged router\n");
    lifecycle_fixture_refuses(static fn() => install_clawpilot_record_lifecycle($source,$temporary,true));
    file_put_contents($routePath,$original);
    $helper = $temporary.'/custom/include/ClawPilot/RecordLifecycle.php';
    $helperContents = file_get_contents($helper);
    file_put_contents($helper,"<?php\n// Unmanaged helper\n");
    lifecycle_fixture_refuses(static fn() => install_clawpilot_record_lifecycle($source,$temporary,true));
    file_put_contents($helper,$helperContents);
    unlink($helper);
    symlink($routePath,$helper);
    lifecycle_fixture_refuses(static fn() => install_clawpilot_record_lifecycle($source,$temporary,true));
    unlink($helper);
    lifecycle_fixture_need(file_get_contents($routePath) === $original, 'Refused symlink operation changed its target');
    fwrite(STDOUT,"PASS lifecycle PHP exact-command validation and read-only/idempotent/owned-path installer contracts\n");
} finally {
    // Only this fixture's fresh random directory is eligible for removal.
    $entries = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($temporary, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($entries as $entry) {
        $path = $entry->getPathname();
        if ($entry->isDir() && !$entry->isLink()) rmdir($path); else unlink($path);
    }
    rmdir($temporary);
}
