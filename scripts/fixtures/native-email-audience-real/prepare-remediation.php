<?php
declare(strict_types=1);
// This patcher is intentionally confined to the isolated /app tmpfs fixture.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1'
    || trim((string) file_get_contents('/app/VERSION')) !== '8.10.1'
    || !is_file('/fixture/remediation-read-scope.php')) {
    throw new RuntimeException('Explicit disposable native remediation fixture required');
}
$directory = '/app/public/legacy/Api/V8/Service/';
$hashes = [
    'ModuleService.php' => '0d3e32008510813545ea6070a7e7598894739fa5ba0d103819bc58bd14f7dff9',
    'RelationshipService.php' => 'db1e68343fa672d69684ed5edc5146ba36dd97817fcf6ad4cd78e6384b1b0a68',
];
function replaceExactlyOnce(string $source, string $from, string $to): string
{
    if (substr_count($source, $from) !== 1) throw new RuntimeException('Pinned native patch context changed');
    return str_replace($from, $to, $source);
}
$prepared = [];
foreach ($hashes as $file => $hash) {
    $path = $directory.$file;
    if (!hash_equals($hash, hash_file('sha256', $path))) throw new RuntimeException('Pinned native service checksum changed');
    $source = file_get_contents($path);
    $source = replaceExactlyOnce($source, 'namespace Api\\V8\\Service;',
        "namespace Api\\V8\\Service;\nrequire_once __DIR__ . '/../../../custom/ClawPilotNativeEmailScope.php';");
    if ($file === 'ModuleService.php') {
        $source = replaceExactlyOnce($source, '        // negative numbers are validated in params',
            '        $where = \\clawpilot_candidate_email_where($bean, $where);'."\n\n".'        // negative numbers are validated in params');
        $source = replaceExactlyOnce($source, '            $beanArray[] = $bean;',
            '            if ($module === \'Emails\' && (!$bean->ACLAccess(\'view\') || !$bean->ACLAccess(\'list\'))) continue;'."\n".'            $beanArray[] = $bean;');
    } else {
        $source = replaceExactlyOnce($source, '        $relatedBeans = $sourceBean->$linkFieldName->getBeans($linkParams);',
            '        $relatedType = $this->beanManager->getLinkedFieldBean($sourceBean, $linkFieldName);'."\n".
            '        $linkParams[\'where\'] = \\clawpilot_candidate_email_where($relatedType, $linkParams[\'where\']);'."\n\n".
            '        $relatedBeans = $sourceBean->$linkFieldName->getBeans($linkParams);');
    }
    $prepared[$path] = $source;
}
// Validate both inputs before changing either. All destinations are disposable.
copy('/fixture/remediation-read-scope.php', '/app/public/legacy/custom/ClawPilotNativeEmailScope.php');
foreach ($prepared as $path => $source) file_put_contents($path, $source);
fwrite(STDOUT, 'CLAWPILOT_NATIVE_REMEDIATION_PATCH='.json_encode(array_map(
    static fn (string $source): string => hash('sha256', $source), $prepared), JSON_THROW_ON_ERROR)."\n");
