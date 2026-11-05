<?php
// Controlled stock-bean-shaped ACL stub, not a pinned SuiteCRM runtime.
class Email
{
    public $id = 'native-email';
    public $global_id_c = 'gi1234567';
    public $created_by = 'native-owner';
    public $assigned_user_id = 'native-owner';
    public function ACLAccess($action)
    {
        $user = $GLOBALS['current_user'];
        return $user->isAdmin() || !empty($GLOBALS['fixture']['permissions'][$user->id][$action]);
    }
    public function save() { throw new RuntimeException('Audience proof cannot save'); }
}
