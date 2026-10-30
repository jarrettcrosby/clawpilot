<?php
declare(strict_types=1);
// This caller remains confined to the isolated /app tmpfs fixture. Production
// installation uses a separate offline journaled CLI, never this fixture writer.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1'
    || trim((string) file_get_contents('/app/VERSION')) !== '8.10.1'
    || !is_file('/fixture/remediation-read-scope.php')) {
    throw new RuntimeException('Explicit disposable native remediation fixture required');
}
require '/source/native-email-scope/Patch.php';
$helper = '/source/native-email-scope/Scope.php';
if (!hash_equals(hash_file('sha256', '/fixture/remediation-read-scope.php'), hash_file('sha256', $helper))) {
    throw new RuntimeException('Shared native helper differs from accepted fixture bytes');
}
$directory = '/app/public/legacy/';
$originals = [];
foreach (clawpilot_native_scope_input_hashes() as $file => $hash) {
    $originals[$file] = file_get_contents($directory.$file);
}
$prepared = [];
foreach (clawpilot_native_scope_render($originals) as $file => $contents) $prepared[$directory.$file] = $contents;
// Validate every input before changing any. All destinations are disposable.
copy($helper, '/app/public/legacy/custom/ClawPilotNativeEmailScope.php');
foreach ($prepared as $path => $source) file_put_contents($path, $source);
$patchHashes = array_map(static fn (string $source): string => hash('sha256', $source), $prepared);
foreach ($patchHashes as $path => $hash) {
    if (!hash_equals($hash, hash_file('sha256', $path))) throw new RuntimeException('Disposable patch readback mismatch');
}
$manifest = json_encode($patchHashes, JSON_THROW_ON_ERROR)."\n";
if (file_put_contents('/app/native-remediation-patch-hashes.json', $manifest, LOCK_EX) !== strlen($manifest)) {
    throw new RuntimeException('Cannot record disposable patch hashes');
}
fwrite(STDOUT, 'CLAWPILOT_NATIVE_REMEDIATION_PATCH='.trim($manifest)."\n");
