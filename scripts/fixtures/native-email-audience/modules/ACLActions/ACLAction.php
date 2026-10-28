<?php
// Controlled ACL stub. This is not the SuiteCRM role aggregation implementation.
class ACLAction
{
    public static function getUserActions($userId, $refresh = false)
    {
        if ($refresh !== true) throw new RuntimeException('Native proof must refresh each principal');
        $GLOBALS['fixture']['evaluated'][] = $userId;
        return [];
    }
}
