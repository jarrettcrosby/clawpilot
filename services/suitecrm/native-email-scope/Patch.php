<?php
declare(strict_types=1);
// Exact transform shared by the disposable fixture and the opt-in offline installer.
// Output pins are from the native-future-history-2026-10-30-r2 acceptance receipt.
function clawpilot_native_scope_input_hashes(): array
{
    return [
    'Api/V8/Service/ModuleService.php' => '0d3e32008510813545ea6070a7e7598894739fa5ba0d103819bc58bd14f7dff9',
    'Api/V8/Service/RelationshipService.php' => 'db1e68343fa672d69684ed5edc5146ba36dd97817fcf6ad4cd78e6384b1b0a68',
    'modules/Emails/EmailUIAjax.php' => '9cc91df15be0bc9bb1c4b0a8d6cc47b143688869ea0c9ec47f3276a3f1e2818e',
    'modules/Emails/Email.php' => '0b0d3fb797f81d70c382a91b9abf5111446abef38c89e7982174757f7a6d066e',
    'include/SugarFolders/SugarFolders.php' => '218f6ac5d58264c7ebe023300e17271fbb8459793bee50bb1a6114c5d1bc298e',
    'modules/SecurityGroups/SecurityGroup.php' => '00d612b04975cabce25ad7f441af0d6529a04bfe854bea1efbd42b916083ff76',
];
}
function clawpilot_native_scope_output_hashes(): array
{
    return [
        'Api/V8/Service/ModuleService.php' => 'd782d797c21cc5d481d71b8293caa3c7533e25243568c89fae06e11b52bfca41',
        'Api/V8/Service/RelationshipService.php' => '090e532de833e4c6c8d18b83901665b79e39141506a217923b7c4f4228ae3587',
        'modules/Emails/EmailUIAjax.php' => 'fc4ae1c13879933904f1cc6885d2867daab2002cf9fc81cad69217f8e352e70d',
        'modules/Emails/Email.php' => 'ecf478158789089a3c9eefc81ec715a4195915a9444d0f7b17db78ac2d32f766',
        'include/SugarFolders/SugarFolders.php' => '1a382a05b92b6a1dbba0a48a27f72c731cb16a3153f743c4756f8693a5e086d6',
        'modules/SecurityGroups/SecurityGroup.php' => 'da20649972446f5810ae293fc3434649df7086796917e4f9684ec9e3140aad65',
    ];
}

function clawpilot_native_scope_replace_once(string $source, string $from, string $to): string
{
    if (substr_count($source, $from) !== 1) throw new RuntimeException('Pinned native patch context changed');
    return str_replace($from, $to, $source);
}
function clawpilot_native_scope_render(array $originals): array
{
$prepared = [];
foreach (clawpilot_native_scope_input_hashes() as $file => $hash) {
    $source = $originals[$file] ?? null;
    if (!is_string($source) || !hash_equals($hash, hash('sha256', $source))) throw new RuntimeException('Pinned native service checksum changed');
    if ($file === 'modules/Emails/EmailUIAjax.php') {
        $source = clawpilot_native_scope_replace_once($source, 'use SuiteCRM\\Utility\\SuiteValidator;',
            "use SuiteCRM\\Utility\\SuiteValidator;\nrequire_once __DIR__ . '/../../custom/ClawPilotNativeEmailScope.php';");
        $source = clawpilot_native_scope_replace_once($source, "    switch (\$_REQUEST['emailUIAction']) {", <<<'PHP'
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
        $source = clawpilot_native_scope_replace_once($source, "require_once __DIR__ . '/EmailFromValidator.php';",
            "require_once __DIR__ . '/EmailFromValidator.php';\nrequire_once __DIR__ . '/../../custom/ClawPilotNativeEmailScope.php';");
        $source = clawpilot_native_scope_replace_once($source, "class Email extends Basic\n{", <<<'PHP'
class Email extends Basic
{
    // Refresh request-local native actions before any Email ACL or query path;
    // an existing cookie must not retain pre-correction default-all authority.
    public function ACLAccess($view, $is_owner = 'not_set', $in_group = 'not_set')
    {
        clawpilot_candidate_refresh_email_acl();
        $nativeAllowed = parent::ACLAccess($view, $is_owner, $in_group);
        return clawpilot_candidate_email_write_access($this, (string) $view, (bool) $nativeAllowed);
    }

    public function buildAccessWhere($view, $user = null)
    {
        clawpilot_candidate_refresh_email_acl();
        return parent::buildAccessWhere($view, $user);
    }
PHP);
        $source = clawpilot_native_scope_replace_once($source, '        $additionalWhereClause = $this->_generateSearchImportWhereClause();',
            '        $additionalWhereClause = clawpilot_candidate_email_where(BeanFactory::newBean(\'Emails\'), $this->_generateSearchImportWhereClause());');
        $source = clawpilot_native_scope_replace_once($source, <<<'PHP'
        while ($a = $this->db->fetchByAssoc($rs)) {
            $temp = array();
PHP, <<<'PHP'
        while ($a = $this->db->fetchByAssoc($rs)) {
            clawpilot_candidate_require_email_reads([(string) $a['id']]);
            $temp = array();
PHP);
    } elseif ($file === 'include/SugarFolders/SugarFolders.php') {
        $source = clawpilot_native_scope_replace_once($source, "require_once __DIR__ . '/SugarFolderEmptyException.php';",
            "require_once __DIR__ . '/SugarFolderEmptyException.php';\nrequire_once __DIR__ . '/../../custom/ClawPilotNativeEmailScope.php';");
        // Each target query already selects/counts Emails. Add predicates before
        // grouping, paging and counts; do not rewrite arbitrary or other-module SQL.
        $source = clawpilot_native_scope_replace_once($source, <<<'PHP'
            "AND eear.deleted=0 " .
            "GROUP BY id";
PHP, <<<'PHP'
            "AND eear.deleted=0 " .
            clawpilot_candidate_email_sql_and() .
            "GROUP BY id";
PHP);
        $source = clawpilot_native_scope_replace_once($source, '        return $query . $ret;',
            '        return $query . $ret . clawpilot_candidate_email_sql_and();');
        $source = clawpilot_native_scope_replace_once($source, '            $r = $this->db->limitQuery($query . $order, $start, $pageSize);',
            '            $query .= clawpilot_candidate_email_sql_and();'."\n".
            '            $r = $this->db->limitQuery($query . $order, $start, $pageSize);');
        $source = clawpilot_native_scope_replace_once($source, <<<'PHP'
            " WHERE folder_id = " . $this->db->quoted($folderId) . " AND folders_rel.deleted = 0 AND emails.deleted = 0";
PHP, <<<'PHP'
            " WHERE folder_id = " . $this->db->quoted($folderId) . " AND folders_rel.deleted = 0 AND emails.deleted = 0";
        $query .= clawpilot_candidate_email_sql_and();
PHP);
        $source = clawpilot_native_scope_replace_once($source, <<<'PHP'
            "AND fr.polymorphic_id = emails.id AND emails.status = 'unread' AND emails.deleted = 0";
PHP, <<<'PHP'
            "AND fr.polymorphic_id = emails.id AND emails.status = 'unread' AND emails.deleted = 0";
        $query .= clawpilot_candidate_email_sql_and();
PHP);
        $source = clawpilot_native_scope_replace_once($source, <<<'PHP'
        while ($a = $this->db->fetchByAssoc($r)) {
            $temp = array();
PHP, <<<'PHP'
        while ($a = $this->db->fetchByAssoc($r)) {
            clawpilot_candidate_require_email_reads([(string) $a['id']]);
            $temp = array();
PHP);
    } elseif ($file === 'modules/SecurityGroups/SecurityGroup.php') {
        $source = clawpilot_native_scope_replace_once($source, <<<'PHP'
        $db = DBManagerFactory::getInstance();
        $quotedId = $db->quote($id);
PHP, <<<'PHP'
        $db = DBManagerFactory::getInstance();
        // Only a live fenced Email scan can reuse prepared SQL bytecode.
        // The helper executes a fresh native count query on EVERY call; it
        // returns NULL for ordinary requests and strict-rights semantics.
        if ($module === 'Emails' && class_exists('ClawPilotNativeEmailWriteReadFrame', false)) {
            $fencedAccess = ClawPilotNativeEmailWriteReadFrame::groupAccess(
                $db->database, $module, (string) $id, (string) $current_user->id, (string) $action
            );
            if ($fencedAccess !== null) {
                return $fencedAccess;
            }
        }
        $quotedId = $db->quote($id);
PHP);
    } else {
        $source = clawpilot_native_scope_replace_once($source, 'namespace Api\\V8\\Service;',
            "namespace Api\\V8\\Service;\nrequire_once __DIR__ . '/../../../custom/ClawPilotNativeEmailScope.php';");
    }
    if ($file === 'Api/V8/Service/ModuleService.php') {
        $source = clawpilot_native_scope_replace_once($source, '        // negative numbers are validated in params',
            '        $where = \\clawpilot_candidate_email_where($bean, $where);'."\n\n".'        // negative numbers are validated in params');
        $source = clawpilot_native_scope_replace_once($source, '            $beanArray[] = $bean;',
            '            if ($module === \'Emails\' && (!$bean->ACLAccess(\'view\') || !$bean->ACLAccess(\'list\'))) continue;'."\n".'            $beanArray[] = $bean;');
    } elseif ($file === 'Api/V8/Service/RelationshipService.php') {
        $source = clawpilot_native_scope_replace_once($source, '        $relatedBeans = $sourceBean->$linkFieldName->getBeans($linkParams);',
            '        $relatedType = $this->beanManager->getLinkedFieldBean($sourceBean, $linkFieldName);'."\n".
            '        $linkParams[\'where\'] = \\clawpilot_candidate_email_where($relatedType, $linkParams[\'where\']);'."\n\n".
            '        $relatedBeans = $sourceBean->$linkFieldName->getBeans($linkParams);');
        $source = clawpilot_native_scope_replace_once($source, <<<'PHP'
            if (!$firstRelatedBean->ACLAccess('view') || !$firstRelatedBean->ACLAccess('list')) {
PHP, <<<'PHP'
            // Email links authorize the actual selected target below. Preserve
            // the stock unrelated-module path instead of changing its policy.
            if ($sourceBean->module_name !== 'Emails' && $firstRelatedBean->module_name !== 'Emails'
                && (!$firstRelatedBean->ACLAccess('view') || !$firstRelatedBean->ACLAccess('list'))) {
PHP);
        $source = clawpilot_native_scope_replace_once($source, <<<'PHP'
        $relatedBean = array_shift($relatedBean);
        $this->beanManager->deleteRelationshipSafe($sourceBean, $relatedBean, $linkFieldName);
PHP, <<<'PHP'
        $relatedBean = array_shift($relatedBean);
        \clawpilot_candidate_require_email_unlink($sourceBean, $relatedBean);
        $this->beanManager->deleteRelationshipSafe($sourceBean, $relatedBean, $linkFieldName);
PHP);
    }
    $prepared[$file] = $source;
}

foreach (clawpilot_native_scope_output_hashes() as $path => $hash) {
    if (!hash_equals($hash, hash('sha256', $prepared[$path]))) throw new RuntimeException('Reviewed native patch output changed: '.$path.':'.hash('sha256',$prepared[$path]));
}
return $prepared;
}
