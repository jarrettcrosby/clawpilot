<?php
declare(strict_types=1);
// This patcher is intentionally confined to the isolated /app tmpfs fixture.
if (PHP_SAPI !== 'cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION') !== '1'
    || trim((string) file_get_contents('/app/VERSION')) !== '8.10.1'
    || !is_file('/fixture/remediation-read-scope.php')) {
    throw new RuntimeException('Explicit disposable native remediation fixture required');
}
$directory = '/app/public/legacy/';
$hashes = [
    'Api/V8/Service/ModuleService.php' => '0d3e32008510813545ea6070a7e7598894739fa5ba0d103819bc58bd14f7dff9',
    'Api/V8/Service/RelationshipService.php' => 'db1e68343fa672d69684ed5edc5146ba36dd97817fcf6ad4cd78e6384b1b0a68',
    'modules/Emails/EmailUIAjax.php' => '9cc91df15be0bc9bb1c4b0a8d6cc47b143688869ea0c9ec47f3276a3f1e2818e',
    'modules/Emails/Email.php' => '0b0d3fb797f81d70c382a91b9abf5111446abef38c89e7982174757f7a6d066e',
    'include/SugarFolders/SugarFolders.php' => '218f6ac5d58264c7ebe023300e17271fbb8459793bee50bb1a6114c5d1bc298e',
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
    if ($file === 'modules/Emails/EmailUIAjax.php') {
        $source = replaceExactlyOnce($source, 'use SuiteCRM\\Utility\\SuiteValidator;',
            "use SuiteCRM\\Utility\\SuiteValidator;\nrequire_once __DIR__ . '/../../custom/ClawPilotNativeEmailScope.php';");
        $source = replaceExactlyOnce($source, "    switch (\$_REQUEST['emailUIAction']) {", <<<'PHP'
    // Authorize every native UID before serialization or any batch mutation.
    try {
        clawpilot_candidate_email_ajax_read($_REQUEST);
        clawpilot_candidate_email_ajax_edit($_REQUEST);
    } catch (\SuiteCRM\Exception\AccessDeniedException $denied) {
        http_response_code(403);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Access denied']);
        return;
    }

    switch ($_REQUEST['emailUIAction']) {
PHP);
    } elseif ($file === 'modules/Emails/Email.php') {
        $source = replaceExactlyOnce($source, "require_once __DIR__ . '/EmailFromValidator.php';",
            "require_once __DIR__ . '/EmailFromValidator.php';\nrequire_once __DIR__ . '/../../custom/ClawPilotNativeEmailScope.php';");
        $source = replaceExactlyOnce($source, '        $additionalWhereClause = $this->_generateSearchImportWhereClause();',
            '        $additionalWhereClause = clawpilot_candidate_email_where(BeanFactory::newBean(\'Emails\'), $this->_generateSearchImportWhereClause());');
        $source = replaceExactlyOnce($source, <<<'PHP'
        while ($a = $this->db->fetchByAssoc($rs)) {
            $temp = array();
PHP, <<<'PHP'
        while ($a = $this->db->fetchByAssoc($rs)) {
            clawpilot_candidate_require_email_reads([(string) $a['id']]);
            $temp = array();
PHP);
    } elseif ($file === 'include/SugarFolders/SugarFolders.php') {
        $source = replaceExactlyOnce($source, "require_once __DIR__ . '/SugarFolderEmptyException.php';",
            "require_once __DIR__ . '/SugarFolderEmptyException.php';\nrequire_once __DIR__ . '/../../custom/ClawPilotNativeEmailScope.php';");
        // Each target query already selects/counts Emails. Add predicates before
        // grouping, paging and counts; do not rewrite arbitrary or other-module SQL.
        $source = replaceExactlyOnce($source, <<<'PHP'
            "AND eear.deleted=0 " .
            "GROUP BY id";
PHP, <<<'PHP'
            "AND eear.deleted=0 " .
            clawpilot_candidate_email_sql_and() .
            "GROUP BY id";
PHP);
        $source = replaceExactlyOnce($source, '        return $query . $ret;',
            '        return $query . $ret . clawpilot_candidate_email_sql_and();');
        $source = replaceExactlyOnce($source, '            $r = $this->db->limitQuery($query . $order, $start, $pageSize);',
            '            $query .= clawpilot_candidate_email_sql_and();'."\n".
            '            $r = $this->db->limitQuery($query . $order, $start, $pageSize);');
        $source = replaceExactlyOnce($source, <<<'PHP'
            " WHERE folder_id = " . $this->db->quoted($folderId) . " AND folders_rel.deleted = 0 AND emails.deleted = 0";
PHP, <<<'PHP'
            " WHERE folder_id = " . $this->db->quoted($folderId) . " AND folders_rel.deleted = 0 AND emails.deleted = 0";
        $query .= clawpilot_candidate_email_sql_and();
PHP);
        $source = replaceExactlyOnce($source, <<<'PHP'
            "AND fr.polymorphic_id = emails.id AND emails.status = 'unread' AND emails.deleted = 0";
PHP, <<<'PHP'
            "AND fr.polymorphic_id = emails.id AND emails.status = 'unread' AND emails.deleted = 0";
        $query .= clawpilot_candidate_email_sql_and();
PHP);
        $source = replaceExactlyOnce($source, <<<'PHP'
        while ($a = $this->db->fetchByAssoc($r)) {
            $temp = array();
PHP, <<<'PHP'
        while ($a = $this->db->fetchByAssoc($r)) {
            clawpilot_candidate_require_email_reads([(string) $a['id']]);
            $temp = array();
PHP);
    } else {
        $source = replaceExactlyOnce($source, 'namespace Api\\V8\\Service;',
            "namespace Api\\V8\\Service;\nrequire_once __DIR__ . '/../../../custom/ClawPilotNativeEmailScope.php';");
    }
    if ($file === 'Api/V8/Service/ModuleService.php') {
        $source = replaceExactlyOnce($source, '        // negative numbers are validated in params',
            '        $where = \\clawpilot_candidate_email_where($bean, $where);'."\n\n".'        // negative numbers are validated in params');
        $source = replaceExactlyOnce($source, '            $beanArray[] = $bean;',
            '            if ($module === \'Emails\' && (!$bean->ACLAccess(\'view\') || !$bean->ACLAccess(\'list\'))) continue;'."\n".'            $beanArray[] = $bean;');
    } elseif ($file === 'Api/V8/Service/RelationshipService.php') {
        $source = replaceExactlyOnce($source, '        $relatedBeans = $sourceBean->$linkFieldName->getBeans($linkParams);',
            '        $relatedType = $this->beanManager->getLinkedFieldBean($sourceBean, $linkFieldName);'."\n".
            '        $linkParams[\'where\'] = \\clawpilot_candidate_email_where($relatedType, $linkParams[\'where\']);'."\n\n".
            '        $relatedBeans = $sourceBean->$linkFieldName->getBeans($linkParams);');
        $source = replaceExactlyOnce($source, <<<'PHP'
            if (!$firstRelatedBean->ACLAccess('view') || !$firstRelatedBean->ACLAccess('list')) {
PHP, <<<'PHP'
            // Email links authorize the actual selected target below. Preserve
            // the stock unrelated-module path instead of changing its policy.
            if ($sourceBean->module_name !== 'Emails' && $firstRelatedBean->module_name !== 'Emails'
                && (!$firstRelatedBean->ACLAccess('view') || !$firstRelatedBean->ACLAccess('list'))) {
PHP);
        $source = replaceExactlyOnce($source, <<<'PHP'
        $relatedBean = array_shift($relatedBean);
        $this->beanManager->deleteRelationshipSafe($sourceBean, $relatedBean, $linkFieldName);
PHP, <<<'PHP'
        $relatedBean = array_shift($relatedBean);
        \clawpilot_candidate_require_email_unlink($sourceBean, $relatedBean);
        $this->beanManager->deleteRelationshipSafe($sourceBean, $relatedBean, $linkFieldName);
PHP);
    }
    $prepared[$path] = $source;
}
// Validate every input before changing any. All destinations are disposable.
copy('/fixture/remediation-read-scope.php', '/app/public/legacy/custom/ClawPilotNativeEmailScope.php');
foreach ($prepared as $path => $source) file_put_contents($path, $source);
fwrite(STDOUT, 'CLAWPILOT_NATIVE_REMEDIATION_PATCH='.json_encode(array_map(
    static fn (string $source): string => hash('sha256', $source), $prepared), JSON_THROW_ON_ERROR)."\n");
