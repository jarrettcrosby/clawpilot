<?php
declare(strict_types=1);

// Offline file installation only. No SuiteCRM bootstrap, DB, roles or groups.
// Deliberately NOT called by Dockerfile/entrypoint. The default operation reads.
require_once __DIR__.'/native-email-scope/Patch.php';
const CP_SCOPE_PACKAGE = 'native-email-scope-8.10.1-v1';
const CP_SCOPE_HELPER = 'custom/ClawPilotNativeEmailScope.php';
const CP_SCOPE_HELPER_HASH = 'ba26057190771c47cf18c829cf5fef09f93d6dde071b4856c62ca943704059a7';

function cp_scope_require(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
function cp_scope_path(string $path, bool $missingLeaf = false): void
{
    cp_scope_require(str_starts_with($path, '/') && !str_contains($path, "\0") && !preg_match('~/(?:\.|\.\.|)(?:/|$)~', $path), 'An exact absolute path is required');
    $parts = explode('/', substr($path, 1)); $current = '';
    foreach ($parts as $index => $part) {
        $current .= '/'.$part;
        clearstatcache(true, $current);
        cp_scope_require(!is_link($current), 'Symlinked paths are refused');
        if (!file_exists($current)) {
            cp_scope_require($missingLeaf && $index === count($parts)-1, 'A required path is missing');
        } elseif ($index < count($parts)-1) cp_scope_require(is_dir($current), 'A path parent is not a directory');
    }
}
function cp_scope_snapshot(string $path): ?array
{
    cp_scope_path($path, true);
    if (!file_exists($path)) return null;
    $stat = lstat($path);
    cp_scope_require(is_array($stat) && ($stat['mode'] & 0170000) === 0100000 && $stat['nlink'] === 1 && $stat['size'] <= 4*1024*1024, 'Only bounded ordinary single-link files are admitted');
    $bytes = file_get_contents($path);
    cp_scope_require(is_string($bytes) && strlen($bytes) === $stat['size'], 'Cannot read an exact file');
    return ['sha256'=>hash('sha256', $bytes), 'size'=>strlen($bytes), 'mode'=>$stat['mode'] & 0777,
        'uid'=>$stat['uid'], 'gid'=>$stat['gid'], 'mtime'=>$stat['mtime']];
}
function cp_scope_matches(?array $actual, ?array $expected, bool $mtime = false): bool
{
    if ($actual === null || $expected === null) return $actual === $expected;
    foreach (['sha256','size','mode','uid','gid'] as $key) if (($actual[$key] ?? null) !== ($expected[$key] ?? null)) return false;
    return !$mtime || $actual['mtime'] === $expected['mtime'];
}
function cp_scope_quiescent(bool $acknowledged): void
{
    cp_scope_require($acknowledged, 'Mutation requires explicit --quiescent acknowledgment');
    cp_scope_require(PHP_OS_FAMILY === 'Linux' && is_dir('/proc') && function_exists('posix_geteuid') && posix_geteuid() === 0,
        'Offline mutation requires root in the isolated Linux service environment');
    $processes = glob('/proc/[0-9]*');
    cp_scope_require(is_array($processes) && count($processes) > 0, 'Cannot inspect native process quiescence');
    foreach ($processes as $process) {
        if ((int) basename($process) === getmypid()) continue;
        $comm = @file_get_contents($process.'/comm'); $cmdline = @file_get_contents($process.'/cmdline');
        if (!is_dir($process)) continue; // A process exited during inspection.
        cp_scope_require(is_string($comm) && is_string($cmdline), 'Cannot attest another process');
        $arguments = array_filter(explode("\0", $cmdline));
        $names = array_merge([trim($comm)], array_map('basename', $arguments));
        foreach ($names as $name) {
            cp_scope_require(!preg_match('/^(?:php(?:[0-9.]*)?|php-fpm.*|apache2|httpd|supervisord|scheduler-loop\.sh|messenger-loop\.sh)$/iD', $name),
                'Native PHP, Apache, supervisor or background workers are still running');
        }
    }
}
function cp_scope_context(string $appRoot, string $stateRoot): array
{
    cp_scope_path($appRoot); cp_scope_path($stateRoot, true);
    cp_scope_require(is_dir($appRoot) && !str_starts_with($stateRoot.'/', $appRoot.'/') && !str_starts_with($appRoot.'/', $stateRoot.'/'),
        'Protected installer state must be outside the application tree');
    cp_scope_require(cp_scope_snapshot($appRoot.'/VERSION') !== null && trim((string) file_get_contents($appRoot.'/VERSION')) === '8.10.1', 'Exact SuiteCRM 8.10.1 is required');
    $legacy = $appRoot.'/public/legacy'; cp_scope_path($legacy);
    $helper = file_get_contents(__DIR__.'/native-email-scope/Scope.php');
    cp_scope_require(is_string($helper) && hash_equals(CP_SCOPE_HELPER_HASH, hash('sha256', $helper)), 'Reviewed helper bytes changed');
    $outputs = clawpilot_native_scope_output_hashes(); $outputs[CP_SCOPE_HELPER] = CP_SCOPE_HELPER_HASH;
    $packageHash = hash('sha256', json_encode([CP_SCOPE_PACKAGE, clawpilot_native_scope_input_hashes(), $outputs], JSON_THROW_ON_ERROR));
    return compact('appRoot','stateRoot','legacy','helper','outputs','packageHash');
}
function cp_scope_protected_directory(string $path, bool $create): void
{
    cp_scope_path($path, $create);
    if (!file_exists($path)) cp_scope_require(mkdir($path, 0700), 'Cannot create protected installer directory');
    clearstatcache(true, $path); $stat = lstat($path);
    cp_scope_require(is_array($stat) && is_dir($path) && $stat['uid'] === 0 && ($stat['mode'] & 0777) === 0700,
        'Installer directories must be root-owned mode 0700');
}
function cp_scope_write(string $path, string $bytes, ?array $metadata = null): void
{
    cp_scope_path($path, true);
    $handle = fopen($path, 'x+b');
    cp_scope_require(is_resource($handle), 'Cannot stage an exclusive installer file');
    try {
        cp_scope_require(chmod($path, 0600) && fwrite($handle, $bytes) === strlen($bytes) && fflush($handle) && fsync($handle), 'Cannot persist staged bytes');
    } finally { fclose($handle); }
    if ($metadata !== null) {
        cp_scope_require(chown($path, $metadata['uid']) && chgrp($path, $metadata['gid']) && chmod($path, $metadata['mode']), 'Cannot preserve exact file ownership/mode');
        if (isset($metadata['mtime'])) cp_scope_require(touch($path, $metadata['mtime']), 'Cannot restore original file time');
    }
}
function cp_scope_sync_directory(string $path): void
{
    $directory = fopen($path, 'r');
    cp_scope_require(is_resource($directory), 'Cannot open installer directory for sync');
    try { cp_scope_require(fsync($directory), 'Cannot persist directory entries'); }
    finally { fclose($directory); }
}
function cp_scope_journal(string $stateRoot, array $manifest): void
{
    $path = $stateRoot.'/manifest.json'; cp_scope_path($path, true);
    $temporary = $stateRoot.'/manifest-'.bin2hex(random_bytes(8)).'.tmp';
    cp_scope_write($temporary, json_encode($manifest, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n");
    cp_scope_require(rename($temporary, $path), 'Cannot publish installer journal');
    // Persist the directory entry before allowing any native file replacement.
    cp_scope_sync_directory($stateRoot);
}
function cp_scope_load(array $context): ?array
{
    if (!file_exists($context['stateRoot'])) return null;
    cp_scope_protected_directory($context['stateRoot'], false);
    $path = $context['stateRoot'].'/manifest.json'; $stat = cp_scope_snapshot($path);
    cp_scope_require($stat !== null && $stat['uid'] === 0 && $stat['mode'] === 0600 && $stat['size'] <= 65536,
        'Unjournaled or unprotected installer state requires manual review');
    $manifest = json_decode((string) file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
    cp_scope_require(is_array($manifest) && ($manifest['schema'] ?? null) === 1 && ($manifest['package'] ?? null) === CP_SCOPE_PACKAGE
        && ($manifest['packageHash'] ?? null) === $context['packageHash'] && ($manifest['appRoot'] ?? null) === $context['appRoot']
        && is_string($manifest['installId'] ?? null) && preg_match('/^[a-f0-9]{64}$/D', $manifest['installId']) === 1
        && in_array($manifest['phase'] ?? null, ['prepared','applying','applied','restoring','restored'], true)
        && array_keys($manifest['files'] ?? []) === array_keys($context['outputs']), 'Installer manifest identity or shape changed');
    cp_scope_protected_directory($context['stateRoot'].'/originals', false);
    $index = 0;
    foreach ($manifest['files'] as $path => $file) {
        $before = $file['before'] ?? null; $after = $file['after'] ?? null;
        cp_scope_require(is_array($after) && ($after['sha256'] ?? null) === $context['outputs'][$path], 'Manifest output identity changed');
        cp_scope_require($path === CP_SCOPE_HELPER ? $before === null : is_array($before)
            && ($before['sha256'] ?? null) === clawpilot_native_scope_input_hashes()[$path], 'Manifest original identity changed');
        foreach ([$after, $before] as $metadata) if ($metadata !== null) {
            foreach (['size','mode','uid','gid','mtime'] as $field) cp_scope_require(isset($metadata[$field]) && is_int($metadata[$field]) && $metadata[$field] >= 0, 'Invalid file metadata in manifest');
            cp_scope_require($metadata['mode'] <= 0777 && $metadata['size'] <= 4*1024*1024, 'Unbounded file metadata in manifest');
        }
        if ($before !== null) {
            $backup = cp_scope_snapshot($context['stateRoot'].'/originals/'.$index.'.php');
            cp_scope_require($backup !== null && $backup['uid'] === 0 && $backup['mode'] === 0600
                && $backup['sha256'] === $before['sha256'] && $backup['size'] === $before['size'], 'Exact original backup drifted');
        }
        $index++;
    }
    return $manifest;
}
function cp_scope_current(array $context, array $manifest): array
{
    $states = [];
    foreach ($manifest['files'] as $path => $file) {
        $current = cp_scope_snapshot($context['legacy'].'/'.$path);
        if (cp_scope_matches($current, $file['after'])) $states[$path] = 'after';
        elseif (cp_scope_matches($current, $file['before'], true)) $states[$path] = 'before';
        else throw new RuntimeException('Native file drift: exact recovery requires review');
    }
    return $states;
}
function cp_scope_check(array $context): array
{
    $manifest = cp_scope_load($context);
    if ($manifest !== null) {
        $states = cp_scope_current($context, $manifest);
        $complete = ($manifest['phase'] === 'applied' && count(array_unique($states)) === 1 && reset($states) === 'after')
            || ($manifest['phase'] === 'restored' && count(array_unique($states)) === 1 && reset($states) === 'before');
        return ['package'=>CP_SCOPE_PACKAGE,'status'=>$complete ? $manifest['phase'] : 'recovery-required','installId'=>$manifest['installId'],'files'=>$states];
    }
    $originals = [];
    foreach (clawpilot_native_scope_input_hashes() as $path => $hash) {
        $stat = cp_scope_snapshot($context['legacy'].'/'.$path);
        cp_scope_require($stat !== null && hash_equals($hash, $stat['sha256']), 'Native input differs from reviewed stock bytes');
        $originals[$path] = (string) file_get_contents($context['legacy'].'/'.$path);
    }
    cp_scope_require(cp_scope_snapshot($context['legacy'].'/'.CP_SCOPE_HELPER) === null, 'Unjournaled helper adoption is refused');
    $outputs = clawpilot_native_scope_render($originals); $outputs[CP_SCOPE_HELPER] = $context['helper'];
    foreach ($outputs as $bytes) token_get_all($bytes, TOKEN_PARSE); // Read-only syntax check, no temporary files.
    return ['package'=>CP_SCOPE_PACKAGE,'status'=>'ready','outputHashes'=>$context['outputs']];
}
function cp_scope_lint(string $path): void
{
    $process = proc_open([PHP_BINARY, '-l', $path], [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes);
    cp_scope_require(is_resource($process), 'Cannot start staged PHP lint');
    fclose($pipes[0]); $output = stream_get_contents($pipes[1]); $errors = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    cp_scope_require(proc_close($process) === 0, 'A staged PHP file failed lint');
}
/** afterReplace exists solely for controlled local failure injection; never CLI-exposed. */
function cp_scope_apply(array $context, bool $quiescent, ?callable $afterReplace = null): array
{
    cp_scope_quiescent($quiescent);
    $check = cp_scope_check($context);
    if ($check['status'] === 'applied') return $check;
    cp_scope_require($check['status'] === 'ready', 'Incomplete or restored installation requires explicit recovery/review');
    cp_scope_protected_directory($context['stateRoot'], true);
    $lockPath = $context['stateRoot'].'/lock'; cp_scope_path($lockPath, true);
    $lock = fopen($lockPath, 'c+b'); cp_scope_require(is_resource($lock) && chmod($lockPath, 0600) && flock($lock, LOCK_EX|LOCK_NB), 'Installer is already locked');
    try {
        cp_scope_require(!file_exists($context['stateRoot'].'/manifest.json'), 'Concurrent installer state appeared');
        cp_scope_protected_directory($context['stateRoot'].'/originals', true);
        cp_scope_protected_directory($context['stateRoot'].'/staged', true);
        cp_scope_require(stat($context['stateRoot'])['dev'] === stat($context['legacy'])['dev'], 'Staging and native files must share one filesystem');
        $originals = []; $files = []; $index = 0;
        foreach (clawpilot_native_scope_input_hashes() as $path => $hash) {
            $before = cp_scope_snapshot($context['legacy'].'/'.$path);
            cp_scope_require($before !== null && $before['sha256'] === $hash, 'Native input drift before staging');
            $originals[$path] = (string) file_get_contents($context['legacy'].'/'.$path);
            cp_scope_write($context['stateRoot'].'/originals/'.$index++.'.php', $originals[$path]);
            $files[$path] = ['before'=>$before];
        }
        $outputs = clawpilot_native_scope_render($originals); $outputs[CP_SCOPE_HELPER] = $context['helper'];
        cp_scope_require(cp_scope_snapshot($context['legacy'].'/'.CP_SCOPE_HELPER) === null, 'Helper appeared during staging');
        $parent = stat(dirname($context['legacy'].'/'.CP_SCOPE_HELPER)); $index = 0;
        foreach ($outputs as $path => $bytes) {
            $before = $files[$path]['before'] ?? null;
            $after = $before ?? ['mode'=>0644,'uid'=>$parent['uid'],'gid'=>$parent['gid'],'mtime'=>time()];
            $after['sha256'] = hash('sha256', $bytes); $after['size'] = strlen($bytes);
            $files[$path] = ['before'=>$before,'after'=>$after];
            $stage = $context['stateRoot'].'/staged/'.$index++.'.php';
            cp_scope_write($stage, $bytes, $after); cp_scope_lint($stage);
            cp_scope_require(cp_scope_matches(cp_scope_snapshot($stage), $after, true), 'Staged output verification failed');
        }
        cp_scope_sync_directory($context['stateRoot'].'/originals');
        cp_scope_sync_directory($context['stateRoot'].'/staged');
        $manifest = ['schema'=>1,'package'=>CP_SCOPE_PACKAGE,'packageHash'=>$context['packageHash'],
            'appRoot'=>$context['appRoot'],'installId'=>bin2hex(random_bytes(32)),'phase'=>'prepared','files'=>$files];
        cp_scope_journal($context['stateRoot'], $manifest);
        cp_scope_require(array_values(array_unique(cp_scope_current($context, $manifest))) === ['before'], 'Native files changed after staging');
        cp_scope_quiescent($quiescent);
        $manifest['phase'] = 'applying'; cp_scope_journal($context['stateRoot'], $manifest);
        $index = 0;
        foreach ($files as $path => $file) {
            $target = $context['legacy'].'/'.$path;
            cp_scope_require(cp_scope_matches(cp_scope_snapshot($target), $file['before'], true), 'Native file changed before replacement');
            cp_scope_require(rename($context['stateRoot'].'/staged/'.$index++.'.php', $target), 'Native replacement failed; recovery required');
            cp_scope_sync_directory(dirname($target));
            cp_scope_require(cp_scope_matches(cp_scope_snapshot($target), $file['after'], true), 'Native replacement readback failed');
            if ($afterReplace !== null) $afterReplace($index);
        }
        $manifest['phase'] = 'applied'; cp_scope_journal($context['stateRoot'], $manifest);
        return cp_scope_check($context);
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}
function cp_scope_restore(array $context, bool $quiescent, string $approval): array
{
    cp_scope_quiescent($quiescent);
    $manifest = cp_scope_load($context);
    cp_scope_require($manifest !== null && hash_equals($manifest['installId'], $approval), 'Restore requires explicit approval of the exact installId');
    $lockPath = $context['stateRoot'].'/lock'; cp_scope_path($lockPath);
    $lock = fopen($lockPath, 'r+b'); cp_scope_require(is_resource($lock) && flock($lock, LOCK_EX|LOCK_NB), 'Installer is already locked');
    try {
        $manifest = cp_scope_load($context); cp_scope_require(hash_equals($manifest['installId'], $approval), 'Restore manifest changed');
        $states = cp_scope_current($context, $manifest);
        if ($manifest['phase'] === 'restored') {
            cp_scope_require(array_values(array_unique($states)) === ['before'], 'Restored installation drifted');
            return cp_scope_check($context);
        }
        if ($manifest['phase'] === 'applied') cp_scope_require(array_values(array_unique($states)) === ['after'], 'Applied installation drifted; refusing a broad stock restore');
        $restoreRoot = $context['stateRoot'].'/restore-'.bin2hex(random_bytes(8)); cp_scope_protected_directory($restoreRoot, true);
        $index = 0;
        foreach ($manifest['files'] as $path => $file) {
            if ($file['before'] !== null) {
                $backup = $context['stateRoot'].'/originals/'.$index.'.php';
                $stat = cp_scope_snapshot($backup);
                cp_scope_require($stat !== null && $stat['uid'] === 0 && $stat['mode'] === 0600
                    && $stat['sha256'] === $file['before']['sha256'] && $stat['size'] === $file['before']['size'], 'Exact original backup is unavailable');
                $stage = $restoreRoot.'/'.$index.'.php'; cp_scope_write($stage, (string) file_get_contents($backup), $file['before']); cp_scope_lint($stage);
            }
            $index++;
        }
        cp_scope_quiescent($quiescent);
        cp_scope_require(cp_scope_current($context, $manifest) === $states, 'Native files changed during restore staging');
        $manifest['phase'] = 'restoring'; cp_scope_journal($context['stateRoot'], $manifest); $index = 0;
        foreach ($manifest['files'] as $path => $file) {
            $target = $context['legacy'].'/'.$path;
            $expected = $states[$path] === 'after' ? $file['after'] : $file['before'];
            cp_scope_require(cp_scope_matches(cp_scope_snapshot($target), $expected, $states[$path] === 'before'), 'Native file changed before exact restore');
            if ($file['before'] !== null) cp_scope_require(rename($restoreRoot.'/'.$index.'.php', $target), 'Exact original restore failed');
            elseif ($states[$path] === 'after') cp_scope_require(unlink($target), 'Cannot remove the exact newly installed helper');
            cp_scope_sync_directory(dirname($target));
            cp_scope_require(cp_scope_matches(cp_scope_snapshot($target), $file['before'], true), 'Exact restore readback failed');
            $index++;
        }
        $manifest['phase'] = 'restored'; cp_scope_journal($context['stateRoot'], $manifest);
        return cp_scope_check($context);
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        $operation = 'check'; $appRoot = '/var/lib/suitecrm/app'; $stateRoot = '/var/lib/suitecrm/clawpilot-native-email-scope-v1';
        $quiescent = false; $approval = ''; $seen = [];
        foreach (array_slice($argv, 1) as $argument) {
            $key = explode('=', $argument, 2)[0];
            if (in_array($argument, ['check','apply','restore'], true)) $key = 'operation';
            cp_scope_require(!isset($seen[$key]), 'Duplicate or conflicting installer argument'); $seen[$key] = true;
            if ($key === 'operation') $operation = $argument;
            elseif ($argument === '--quiescent') $quiescent = true;
            elseif (str_starts_with($argument, '--app-root=')) $appRoot = substr($argument, 11);
            elseif (str_starts_with($argument, '--state-root=')) $stateRoot = substr($argument, 13);
            elseif (str_starts_with($argument, '--approve-restore=')) $approval = substr($argument, 18);
            else throw new RuntimeException('Unknown installer argument');
        }
        cp_scope_require($operation === 'restore' || !isset($seen['--approve-restore']), 'Restore approval is valid only for an explicit restore operation');
        $context = cp_scope_context($appRoot, $stateRoot);
        $result = match ($operation) {
            'apply' => cp_scope_apply($context, $quiescent),
            'restore' => cp_scope_restore($context, $quiescent, $approval),
            default => cp_scope_check($context),
        };
        fwrite(STDOUT, json_encode($result, JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n");
        exit($result['status'] === 'recovery-required' ? 2 : 0);
    } catch (Throwable $error) {
        fwrite(STDERR, 'Native Email scope installer held: '.$error->getMessage()."\n"); exit(1);
    }
}
