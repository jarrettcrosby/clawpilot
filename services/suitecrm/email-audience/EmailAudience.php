<?php
declare(strict_types=1);
// ClawPilot managed native Email audience proof v1. Read-only; never grants access.
require_once 'modules/ACLActions/ACLAction.php';

function clawpilot_email_audience_refuse(): void
{
    throw new RuntimeException('Native Email audience is unproven');
}

/** @param mixed $value */
function clawpilot_email_audience_id($value): string
{
    if (!is_string($value) || !preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/iD', $value)) {
        clawpilot_email_audience_refuse();
    }
    return $value;
}

/** @param mixed $value @return list<string> */
function clawpilot_email_audience_ids($value, int $limit = 200): array
{
    if (!is_array($value) || !array_is_list($value) || count($value) > $limit) {
        clawpilot_email_audience_refuse();
    }
    $ids = array_map('clawpilot_email_audience_id', $value);
    if (count(array_unique($ids)) !== count($ids)) {
        clawpilot_email_audience_refuse();
    }
    sort($ids, SORT_STRING);
    return $ids;
}

/** @return list<array<string,mixed>> */
function clawpilot_email_audience_rows(string $sql): array
{
    $db = DBManagerFactory::getInstance();
    $result = $db->query($sql, true);
    if (!$result) {
        clawpilot_email_audience_refuse();
    }
    $rows = [];
    while ($row = $db->fetchByAssoc($result)) {
        $rows[] = $row;
    }
    return $rows;
}

/** Only the reviewed no-implicit-sharing profile is supported. Unknown profiles hold. */
function clawpilot_email_audience_profile(): void
{
    global $sugar_config;
    foreach (['securitysuite_inherit_creator', 'securitysuite_inherit_assigned', 'securitysuite_inherit_parent'] as $flag) {
        if (!array_key_exists($flag, $sugar_config)
            || !in_array($sugar_config[$flag], [false, 0, '0'], true)) {
            clawpilot_email_audience_refuse();
        }
    }
    foreach (['Emails', 'Accounts', 'Contacts'] as $module) {
        // Never silently treat operator ACL/save/relationship overrides as stock behavior.
        if (file_exists('custom/modules/' . $module . '/logic_hooks.php')
            || file_exists('custom/modules/' . $module . '/Ext/LogicHooks/logichooks.ext.php')
            || glob('custom/Extension/modules/' . $module . '/Ext/LogicHooks/*.php')
            || file_exists('custom/modules/' . $module . '/' . rtrim($module, 's') . '.php')
            || isset($GLOBALS['customBeanList'][$module])) {
            clawpilot_email_audience_refuse();
        }
    }
    if (file_exists('custom/modules/logic_hooks.php')
        || file_exists('custom/application/Ext/LogicHooks/logichooks.ext.php')
        || glob('custom/Extension/application/Ext/LogicHooks/*.php')) {
        clawpilot_email_audience_refuse();
    }
    if (clawpilot_email_audience_rows(
        "SELECT defaults.id FROM securitygroups_default defaults
         JOIN securitygroups groups_row ON groups_row.id = defaults.securitygroup_id
         WHERE defaults.deleted = 0 AND groups_row.deleted = 0
           AND defaults.module IN ('All', 'Emails') LIMIT 1"
    ) || clawpilot_email_audience_rows(
        "SELECT id FROM aow_workflow WHERE deleted = 0 AND status = 'Active' AND flow_module = 'Emails' LIMIT 1"
    )) {
        clawpilot_email_audience_refuse();
    }
}

/** @param array<string,mixed> $command @return array<string,mixed> */
function clawpilot_email_audience_proof(array $command, string $callerId): array
{
    if (array_keys($command) !== ['version', 'phase', 'suiteCrmId', 'globalId', 'assignedUserId', 'accounts', 'contacts', 'audience']
        || $command['version'] !== 1 || !in_array($command['phase'], ['before', 'after'], true)
        || !is_string($command['globalId']) || !preg_match('/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D', $command['globalId'])) {
        clawpilot_email_audience_refuse();
    }
    $emailId = clawpilot_email_audience_id($command['suiteCrmId']);
    $accountIds = clawpilot_email_audience_ids($command['accounts'], 25);
    $contactIds = clawpilot_email_audience_ids($command['contacts'], 25);
    if (!is_array($command['audience'])) {
        clawpilot_email_audience_refuse();
    }
    $audience = $command['audience'];
    $keys = array_keys($audience);
    sort($keys, SORT_STRING);
    if ($keys !== ['allowedSuiteCrmUserIds', 'fingerprint', 'ownerSuiteCrmId', 'pipelineId', 'policy', 'workspaceId']
        || $audience['policy'] !== 'pipeline-internal') {
        clawpilot_email_audience_refuse();
    }
    $ownerId = clawpilot_email_audience_id($audience['ownerSuiteCrmId']);
    $expectedReaders = clawpilot_email_audience_ids($audience['allowedSuiteCrmUserIds']);
    $fingerprint = hash('sha256', json_encode([
        'policy' => 'pipeline-internal', 'ownerSuiteCrmId' => $ownerId,
        'allowedSuiteCrmUserIds' => $expectedReaders,
        'workspaceId' => clawpilot_email_audience_id($audience['workspaceId']),
        'pipelineId' => clawpilot_email_audience_id($audience['pipelineId']),
    ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    if (!in_array($ownerId, $expectedReaders, true) || !is_string($audience['fingerprint'])
        || !hash_equals($fingerprint, $audience['fingerprint'])) {
        clawpilot_email_audience_refuse();
    }
    clawpilot_email_audience_profile();
    $db = DBManagerFactory::getInstance();
    $emailRows = clawpilot_email_audience_rows("SELECT id FROM emails WHERE id = '" . $db->quote($emailId) . "' AND deleted = 0");
    if (count($emailRows) > 1 || (!$emailRows && $command['phase'] === 'after')) {
        clawpilot_email_audience_refuse();
    }
    $email = $emailRows ? BeanFactory::getBean('Emails', $emailId) : BeanFactory::newBean('Emails');
    if (!$email || get_class($email) !== 'Email'
        || realpath((new ReflectionClass($email))->getFileName()) !== realpath('modules/Emails/Email.php')) {
        clawpilot_email_audience_refuse();
    }
    if ($emailRows && (string) $email->global_id_c !== $command['globalId']) {
        clawpilot_email_audience_refuse();
    }
    // Simulate only owner fields on an unsaved stock bean. No save()/relationship writes.
    if (!$emailRows) {
        $email->id = $emailId;
        $email->created_by = $callerId;
        $email->assigned_user_id = $command['assignedUserId'] === null
            ? $callerId : clawpilot_email_audience_id($command['assignedUserId']);
    } elseif ($command['assignedUserId'] !== null
        && (string) $email->assigned_user_id !== clawpilot_email_audience_id($command['assignedUserId'])) {
        clawpilot_email_audience_refuse();
    }
    // Include inactive principals too: changing a status is not itself proof
    // that every previously issued bearer token/session has been revoked.
    $users = clawpilot_email_audience_rows("SELECT id FROM users WHERE deleted = 0 ORDER BY id LIMIT 501");
    if (!$users || count($users) > 500) {
        clawpilot_email_audience_refuse();
    }
    $previousUser = $GLOBALS['current_user'] ?? null;
    $previousSession = $_SESSION ?? [];
    $readers = [];
    $administrators = [];
    try {
        foreach ($users as $row) {
            $userId = clawpilot_email_audience_id($row['id']);
            $user = BeanFactory::getBean('Users', $userId);
            if (!$user || get_class($user) !== 'User') {
                clawpilot_email_audience_refuse();
            }
            $GLOBALS['current_user'] = $user;
            $_SESSION = [];
            ACLAction::getUserActions($userId, true);
            // Any direct/list/export read surface makes this a reader. Deny-role
            // service principals are evaluated, not excluded by naming convention.
            if ($email->ACLAccess('view') || $email->ACLAccess('list') || $email->ACLAccess('export')) {
                $readers[] = $userId;
                if ($user->isAdmin()) {
                    $administrators[] = $userId;
                }
            }
        }
    } finally {
        $GLOBALS['current_user'] = $previousUser;
        $_SESSION = $previousSession;
    }
    sort($readers, SORT_STRING);
    sort($administrators, SORT_STRING);
    if ($readers !== $expectedReaders) {
        clawpilot_email_audience_refuse();
    }
    return [
        'version' => 1, 'suiteCrmId' => $emailId, 'phase' => $command['phase'],
        'complete' => true, 'noImplicitSharing' => true, 'fingerprint' => $fingerprint,
        'capturedAt' => gmdate('Y-m-d\TH:i:s\Z'),
        'readerSuiteCrmUserIds' => $readers, 'administratorSuiteCrmUserIds' => $administrators,
    ];
}
