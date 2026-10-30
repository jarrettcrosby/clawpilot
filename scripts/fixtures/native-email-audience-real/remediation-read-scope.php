<?php
declare(strict_types=1);
// Experimental native-read correction. Only installed into the disposable
// acceptance container; no production installer or verifier allow-list uses it.
function clawpilot_candidate_email_where(SugarBean $bean, string $where): string
{
    if ($bean->module_name !== 'Emails') return $where;
    if (!$bean->ACLAccess('view') || !$bean->ACLAccess('list')) {
        throw new SuiteCRM\Exception\AccessDeniedException();
    }
    $conditions = $where === '' ? [] : ['('.$where.')'];
    foreach (['view', 'list'] as $surface) {
        $scope = trim((string) $bean->buildAccessWhere($surface));
        if ($scope !== '') $conditions[] = '('.$scope.')';
    }
    return implode(' AND ', array_unique($conditions));
}

/** Suffix for pinned native SQL that already has a WHERE and an emails table. */
function clawpilot_candidate_email_sql_and(): string
{
    $scope = clawpilot_candidate_email_where(BeanFactory::newBean('Emails'), '');
    return $scope === '' ? '' : ' AND ('.$scope.') ';
}

/** Authorize the complete native batch before any part can be serialized. */
function clawpilot_candidate_require_email_reads(array $ids): void
{
    clawpilot_candidate_require_email_access($ids, false);
}

/** Edit additionally requires readable native records; preflight the entire batch. */
function clawpilot_candidate_require_email_edits(array $ids): void
{
    clawpilot_candidate_require_email_access($ids, true);
}

function clawpilot_candidate_require_email_access(array $ids, bool $requireEdit): void
{
    if ($ids === []) throw new SuiteCRM\Exception\AccessDeniedException();
    foreach ($ids as $id) {
        if (!is_string($id) || $id === '') throw new SuiteCRM\Exception\AccessDeniedException();
        // Use a fresh bean rather than a caller-populated or cached owner shape.
        $bean = BeanFactory::newBean('Emails');
        if (!$bean instanceof SugarBean || !$bean->retrieve($id, false)
            || (string) $bean->id !== $id || !$bean->ACLAccess('view') || !$bean->ACLAccess('list')
            || ($requireEdit && !$bean->ACLAccess('edit'))) {
            throw new SuiteCRM\Exception\AccessDeniedException();
        }
    }
}

/** Check the selected relationship endpoint, never an arbitrary first sibling. */
function clawpilot_candidate_require_email_unlink(SugarBean $source, SugarBean $related): void
{
    if ($source->module_name !== 'Emails' && $related->module_name !== 'Emails') return;
    if (!$source->ACLAccess('view') || !$source->ACLAccess('list') || !$source->ACLAccess('edit')
        || !$related->ACLAccess('view') || !$related->ACLAccess('list')
        || ($related->module_name === 'Emails' && !$related->ACLAccess('edit'))) {
        throw new SuiteCRM\Exception\AccessDeniedException();
    }
}

/** Authorize native Email edits before the legacy action creates or saves beans. */
function clawpilot_candidate_email_ajax_edit(array $request): void
{
    $action = $request['emailUIAction'] ?? '';
    if ($action === 'saveQuickCreate' && ($request['sugarEmail'] ?? null) == 'true') {
        // Stock saveQuickCreate creates the related bean before retrieving uid.
        // This guard runs before its switch, so a denied/malformed native ID
        // cannot create the target, change the Email, or add any relationships.
        clawpilot_candidate_require_email_edits([$request['uid'] ?? null]);
        return;
    }
    if ($action !== 'relateEmails'
        || empty($request['uid']) || empty($request['parent_id']) || empty($request['parent_type'])) return;
    $delimiter = $GLOBALS['app_strings']['LBL_EMAIL_DELIMITER'] ?? null;
    if (!is_string($request['uid']) || !is_string($delimiter) || $delimiter === '') {
        throw new SuiteCRM\Exception\AccessDeniedException();
    }
    clawpilot_candidate_require_email_edits(explode($delimiter, $request['uid']));
}

/** Only the pinned EmailUIAjax commands that read imported native Email IDs. */
function clawpilot_candidate_email_ajax_read(array $request): void
{
    $action = $request['emailUIAction'] ?? '';
    $uid = $request['uid'] ?? null;
    $ids = null;
    switch ($action) {
        case 'composeEmail':
            // Match the native branch; the other branch uses an IMAP/POP UID.
            if (($request['sugarEmail'] ?? null) == 'true') $ids = [$uid];
            break;
        case 'getQuickCreateForm':
            if (!empty($request['sugarEmail'])) $ids = [$uid];
            break;
        case 'getEmail2DetailView':
        case 'getSingleMessageFromSugar':
            $ids = [$uid];
            break;
        case 'getMultipleMessagesFromSugar':
            if (!is_string($uid)) throw new SuiteCRM\Exception\AccessDeniedException();
            $ids = explode(',', $uid);
            break;
        case 'getRelateForm':
            if (!is_string($uid)) throw new SuiteCRM\Exception\AccessDeniedException();
            $ids = json_decode(from_html($uid), true);
            if (!is_array($ids) || !array_is_list($ids)) throw new SuiteCRM\Exception\AccessDeniedException();
            break;
        case 'searchAdvanced':
        case 'getMessageListSugarFolders':
            // Match the row-query module gate before the legacy action begins.
            // The pinned query builders separately apply the scope before counts.
            clawpilot_candidate_email_where(BeanFactory::newBean('Emails'), '');
            break;
    }
    if ($ids !== null) clawpilot_candidate_require_email_reads($ids);
}
