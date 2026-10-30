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
