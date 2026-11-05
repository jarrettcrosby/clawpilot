<?php
declare(strict_types=1);

// Run only in a disposable root PHP 8.3 Linux container, no server processes.
// The supplied stock root is read-only; every mutation is in a fresh /tmp tree.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_SCOPE_INSTALLER_TEST') !== '1') throw new RuntimeException('Explicit disposable installer test required');
require '/source/install-native-email-scope.php';
$stock = $argv[1] ?? '/stock';
$checks = 0;
function installer_check(string $name, callable $run): void { $run(); $GLOBALS['checks']++; fwrite(STDOUT, "PASS {$name}\n"); }
function installer_refuses(callable $run, string $message): void
{
    try { $run(); } catch (Throwable $error) {
        cp_scope_require(str_contains($error->getMessage(), $message), 'Unexpected installer refusal: '.$error->getMessage()); return;
    }
    throw new RuntimeException('Expected installer refusal');
}
function installer_tree(string $stock): array
{
    $base = '/tmp/clawpilot-scope-installer-'.bin2hex(random_bytes(8));
    cp_scope_require(mkdir($base, 0700), 'Cannot create disposable test root');
    $app = $base.'/app'; cp_scope_require(mkdir($app, 0700), 'Cannot create disposable app');
    cp_scope_require(copy($stock.'/VERSION', $app.'/VERSION'), 'Cannot copy stock version');
    foreach (clawpilot_native_scope_input_hashes() as $path => $hash) {
        $target = $app.'/public/legacy/'.$path;
        if (!is_dir(dirname($target))) cp_scope_require(mkdir(dirname($target), 0755, true), 'Cannot create disposable native directories');
        cp_scope_require(copy($stock.'/public/legacy/'.$path, $target) && chmod($target, 0644), 'Cannot copy stock native source');
    }
    cp_scope_require(mkdir($app.'/public/legacy/custom', 0755), 'Cannot create disposable custom directory');
    return cp_scope_context($app, $base.'/protected-state');
}
try {
    cp_scope_quiescent(true);
    $context = installer_tree($stock);
    $before = []; foreach (array_keys($context['outputs']) as $path) $before[$path] = cp_scope_snapshot($context['legacy'].'/'.$path);
    installer_check('default check renders exact accepted output pins without creating state or modifying files', function () use ($context,$before): void {
        cp_scope_require(cp_scope_check($context)['status'] === 'ready' && !file_exists($context['stateRoot']), 'Check must create no state');
        foreach ($before as $path=>$snapshot) cp_scope_require(cp_scope_snapshot($context['legacy'].'/'.$path) === $snapshot, 'Read-only check modified a native file');
    });
    installer_check('offline apply requires explicit acknowledgment and rejects an independently running PHP process', function () use ($context): void {
        installer_refuses(fn()=>cp_scope_apply($context,false), 'explicit --quiescent');
        $process = proc_open([PHP_BINARY,'-r','fwrite(STDOUT,"ready\\n"); fgets(STDIN);'], [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes);
        cp_scope_require(is_resource($process) && trim((string) fgets($pipes[1])) === 'ready', 'Independent PHP process must start');
        try { installer_refuses(fn()=>cp_scope_apply($context,true), 'still running'); }
        finally { fwrite($pipes[0], "exit\n"); fclose($pipes[0]); fclose($pipes[1]); fclose($pipes[2]); proc_close($process); }
        cp_scope_require(!file_exists($context['stateRoot']), 'Quiescence refusal must precede state creation');
    });
    installer_check('complete pinned installation preserves originals and metadata and is exactly idempotent', function () use ($context,$before): void {
        cp_scope_require(cp_scope_apply($context,true)['status'] === 'applied', 'Offline apply must complete');
        $manifest = cp_scope_load($context); $after = [];
        foreach ($manifest['files'] as $path=>$file) {
            cp_scope_require($file['before'] === $before[$path], 'Restore manifest lost exact original metadata');
            $after[$path] = cp_scope_snapshot($context['legacy'].'/'.$path);
        }
        $journal = file_get_contents($context['stateRoot'].'/manifest.json');
        cp_scope_require(cp_scope_apply($context,true)['status'] === 'applied' && file_get_contents($context['stateRoot'].'/manifest.json') === $journal, 'Idempotent apply rewrote its receipt');
        foreach ($after as $path=>$snapshot) cp_scope_require(cp_scope_snapshot($context['legacy'].'/'.$path) === $snapshot, 'Idempotent apply touched native bytes or metadata');
    });
    installer_check('restore requires exact install approval and restores originals plus prior helper absence', function () use ($context,$before): void {
        installer_refuses(fn()=>cp_scope_restore($context,true,''), 'explicit approval');
        $id = cp_scope_load($context)['installId'];
        cp_scope_require(cp_scope_restore($context,true,$id)['status'] === 'restored', 'Approved exact restore must complete');
        foreach ($before as $path=>$snapshot) cp_scope_require(cp_scope_snapshot($context['legacy'].'/'.$path) === $snapshot, 'Exact restore changed original presence/bytes/metadata');
        cp_scope_require(is_file($context['stateRoot'].'/manifest.json'), 'Restore must retain the audit manifest and originals');
    });
    installer_check('failure after first native replacement holds normal apply until explicitly approved exact recovery', function () use ($stock): void {
        $context = installer_tree($stock);
        installer_refuses(fn()=>cp_scope_apply($context,true,static function (int $count): void { if ($count === 1) throw new RuntimeException('Injected replacement interruption'); }), 'Injected replacement interruption');
        $manifest = cp_scope_load($context);
        cp_scope_require($manifest['phase'] === 'applying' && cp_scope_check($context)['status'] === 'recovery-required', 'Interrupted installation must remain held');
        installer_refuses(fn()=>cp_scope_apply($context,true), 'explicit recovery');
        cp_scope_require(cp_scope_restore($context,true,$manifest['installId'])['status'] === 'restored', 'Mixed exact before/after files must recover only on explicit approval');
    });
    installer_check('operator file drift blocks both idempotent apply and restore', function () use ($stock): void {
        $context = installer_tree($stock); cp_scope_apply($context,true); $id = cp_scope_load($context)['installId'];
        $path = $context['legacy'].'/'.array_key_first(clawpilot_native_scope_input_hashes());
        $changed = (string) file_get_contents($path)."\n// synthetic operator change\n"; file_put_contents($path,$changed);
        installer_refuses(fn()=>cp_scope_apply($context,true), 'Native file drift');
        installer_refuses(fn()=>cp_scope_restore($context,true,$id), 'Native file drift');
        cp_scope_require(file_get_contents($path) === $changed, 'A refusal overwrote operator changes');
    });
    installer_check('stock drift, unmanaged helper, symlink and wrong version refuse before state writes', function () use ($stock): void {
        foreach (['stock','helper','symlink','version'] as $case) {
            $context = installer_tree($stock); $first = $context['legacy'].'/'.array_key_first(clawpilot_native_scope_input_hashes());
            if ($case === 'stock') file_put_contents($first,"<?php // synthetic operator-owned bytes\n");
            elseif ($case === 'helper') file_put_contents($context['legacy'].'/'.CP_SCOPE_HELPER,"<?php // operator helper\n");
            elseif ($case === 'symlink') { rename($first,$first.'.original'); symlink($first.'.original',$first); }
            else file_put_contents($context['appRoot'].'/VERSION',"8.10.2\n");
            $reason = ['stock'=>'reviewed stock','helper'=>'adoption','symlink'=>'Symlinked','version'=>'8.10.1'][$case];
            installer_refuses(fn()=>cp_scope_check(cp_scope_context($context['appRoot'],$context['stateRoot'])), $reason);
            cp_scope_require(!file_exists($context['stateRoot']), 'Rejected input created installer state');
        }
    });
    fwrite(STDOUT,"NATIVE_SCOPE_INSTALLER_TEST_PASSED=checks={$checks}; disposable filesystem only; no production installation or native permissions changed.\n");
} catch (Throwable $error) {
    fwrite(STDERR,'Native scope installer test failed: '.$error->getMessage()."\n"); exit(1);
}
