<?php
declare(strict_types=1);

const CLAWPILOT_IMAGE_PRODUCT_MODULE = 'AOS_Products';
const CLAWPILOT_IMAGE_PRODUCT_FIELD = 'clawpilot_image_c';
const CLAWPILOT_IMAGE_FORWARD_ROLE = 'ClawPilot Product Image Media Writer';
const CLAWPILOT_IMAGE_REVERSE_ROLE = 'ClawPilot Product Image Reader';
const CLAWPILOT_IMAGE_FORWARD_DESCRIPTION = 'Managed by ClawPilot: native Product image media writer.';
const CLAWPILOT_IMAGE_REVERSE_DESCRIPTION = 'Managed by ClawPilot: Product image read principal.';
const CLAWPILOT_IMAGE_ROLE_ACTIONS = [
    'access',
    'view',
    'list',
    'edit',
    'delete',
    'import',
    'export',
    'massupdate',
];

final class ClawPilotImagePrincipalConfigurationException extends RuntimeException
{
}

final class ClawPilotImagePrincipalInvariantException extends RuntimeException
{
}

function image_principal_configuration_failure(string $message): never
{
    throw new ClawPilotImagePrincipalConfigurationException($message);
}

function image_principal_invariant_failure(string $message): never
{
    throw new ClawPilotImagePrincipalInvariantException($message);
}

/** @return string|false */
function image_principal_env(string $name)
{
    return getenv($name);
}

function image_principal_flag(string $name): bool
{
    $raw = image_principal_env($name);
    if ($raw === false) {
        return false;
    }
    $value = trim($raw);
    if ($value !== '0' && $value !== '1') {
        image_principal_configuration_failure("{$name} must equal exactly 0 or 1");
    }
    return $value === '1';
}

/** @param list<string> $names */
function image_principal_group_requested(array $names, bool $enabled): bool
{
    if ($enabled) {
        return true;
    }
    foreach ($names as $name) {
        if (image_principal_env($name) !== false) {
            return true;
        }
    }
    return false;
}

function image_principal_required_username(string $name): string
{
    $raw = image_principal_env($name);
    $value = $raw === false ? '' : trim($raw);
    if (
        $value === ''
        || strlen($value) > 60
        || preg_match('/[\x00-\x1F\x7F]/', $value) === 1
        || preg_match('/^[A-Za-z0-9][A-Za-z0-9._@+\-]*$/D', $value) !== 1
    ) {
        image_principal_configuration_failure("{$name} is missing or invalid");
    }
    return $value;
}

function image_principal_required_secret(string $name, int $minimum): string
{
    $raw = image_principal_env($name);
    $value = $raw === false ? '' : $raw;
    if (
        strlen($value) < $minimum
        || strlen($value) > 4096
        || preg_match('/[\x00-\x1F\x7F]/', $value) === 1
    ) {
        image_principal_configuration_failure(
            "{$name} must contain between {$minimum} and 4096 characters without control characters"
        );
    }
    return $value;
}

function image_principal_required_client_id(string $name): string
{
    $raw = image_principal_env($name);
    $value = $raw === false ? '' : trim($raw);
    if (
        preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/Di',
            $value
        ) !== 1
    ) {
        image_principal_configuration_failure("{$name} must be a UUID");
    }
    return $value;
}

function image_principal_comparable_credential(string $name, string $value): string
{
    if (str_ends_with($name, '_USERNAME') || str_ends_with($name, '_USER')) {
        return strtolower(trim($value));
    }
    if (str_ends_with($name, '_CLIENT_ID')) {
        return strtolower(trim($value));
    }
    return $value;
}

/**
 * @return array{
 *   forward: null|array{username: string, password: string},
 *   reverse: null|array{username: string, password: string, clientId: string, clientSecret: string}
 * }
 */
function image_principal_configuration(): array
{
    $forwardNames = [
        'SUITECRM_MEDIA_USERNAME',
        'SUITECRM_MEDIA_PASSWORD',
    ];
    $reverseNames = [
        'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID',
        'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET',
        'SUITECRM_PRODUCT_IMAGE_READ_USERNAME',
        'SUITECRM_PRODUCT_IMAGE_READ_PASSWORD',
    ];
    $forwardRequested = image_principal_group_requested(
        $forwardNames,
        image_principal_flag('SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED')
    );
    $reverseRequested = image_principal_group_requested(
        $reverseNames,
        image_principal_flag('SUITECRM_PRODUCT_IMAGE_REVERSE_INGESTION_ENABLED')
    );

    $forward = null;
    if ($forwardRequested) {
        $forward = [
            'username' => image_principal_required_username('SUITECRM_MEDIA_USERNAME'),
            'password' => image_principal_required_secret('SUITECRM_MEDIA_PASSWORD', 16),
        ];
    }

    $reverse = null;
    if ($reverseRequested) {
        $reverse = [
            'clientId' => image_principal_required_client_id(
                'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID'
            ),
            'clientSecret' => image_principal_required_secret(
                'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET',
                32
            ),
            'username' => image_principal_required_username(
                'SUITECRM_PRODUCT_IMAGE_READ_USERNAME'
            ),
            'password' => image_principal_required_secret(
                'SUITECRM_PRODUCT_IMAGE_READ_PASSWORD',
                16
            ),
        ];
    }

    if ($forward === null && $reverse === null) {
        return ['forward' => null, 'reverse' => null];
    }

    $credentials = [];
    $baseCredentialNames = [
        'SUITECRM_ADMIN_USER',
        'SUITECRM_ADMIN_USERNAME',
        'SUITECRM_ADMIN_PASSWORD',
        'SUITECRM_CLIENT_ID',
        'SUITECRM_CLIENT_SECRET',
    ];
    foreach ($baseCredentialNames as $name) {
        $raw = image_principal_env($name);
        if ($raw !== false && $raw !== '') {
            $credentials[$name] = $raw;
        }
    }
    if ($forward !== null) {
        $credentials['SUITECRM_MEDIA_USERNAME'] = $forward['username'];
        $credentials['SUITECRM_MEDIA_PASSWORD'] = $forward['password'];
    }
    if ($reverse !== null) {
        $credentials['SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID'] = $reverse['clientId'];
        $credentials['SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET'] = $reverse['clientSecret'];
        $credentials['SUITECRM_PRODUCT_IMAGE_READ_USERNAME'] = $reverse['username'];
        $credentials['SUITECRM_PRODUCT_IMAGE_READ_PASSWORD'] = $reverse['password'];
    }

    $managedCredentialNames = array_fill_keys([
        'SUITECRM_MEDIA_USERNAME',
        'SUITECRM_MEDIA_PASSWORD',
        'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID',
        'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET',
        'SUITECRM_PRODUCT_IMAGE_READ_USERNAME',
        'SUITECRM_PRODUCT_IMAGE_READ_PASSWORD',
    ], true);
    $names = array_keys($credentials);
    for ($left = 0, $count = count($names); $left < $count; $left++) {
        for ($right = $left + 1; $right < $count; $right++) {
            $leftName = $names[$left];
            $rightName = $names[$right];
            if (
                !isset($managedCredentialNames[$leftName])
                && !isset($managedCredentialNames[$rightName])
            ) {
                continue;
            }
            $leftValue = image_principal_comparable_credential(
                $leftName,
                $credentials[$leftName]
            );
            $rightValue = image_principal_comparable_credential(
                $rightName,
                $credentials[$rightName]
            );
            if ($leftValue !== '' && hash_equals($leftValue, $rightValue)) {
                image_principal_configuration_failure(
                    "credential values must be distinct ({$leftName}, {$rightName})"
                );
            }
        }
    }

    return ['forward' => $forward, 'reverse' => $reverse];
}

function image_principal_required_database_value(string $name): string
{
    $raw = image_principal_env($name);
    $value = $raw === false ? '' : trim($raw);
    if ($value === '') {
        image_principal_configuration_failure("{$name} is required for image-principal bootstrap");
    }
    return $value;
}

function image_principal_database(): PDO
{
    return new PDO(
        sprintf(
            'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
            image_principal_required_database_value('SUITECRM_DB_HOST'),
            image_principal_required_database_value('SUITECRM_DB_PORT'),
            image_principal_required_database_value('SUITECRM_DB_NAME')
        ),
        image_principal_required_database_value('SUITECRM_DB_USER'),
        (string) image_principal_env('SUITECRM_DB_PASSWORD'),
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
}

/** @return array<string, mixed> */
function image_principal_find_single_user(PDO $pdo, string $username): array
{
    $statement = $pdo->prepare(
        'SELECT id, user_name, status, employee_status, is_admin, deleted,
                user_hash, portal_only, is_group, external_auth_only,
                sugar_login, show_on_employees, receive_notifications,
                factor_auth, is_totp_enabled, totp_secret, description
           FROM users
          WHERE LOWER(user_name) = LOWER(?)'
    );
    $statement->execute([$username]);
    $rows = $statement->fetchAll();
    if (count($rows) > 1) {
        image_principal_invariant_failure('configured username resolves to multiple SuiteCRM users');
    }
    return $rows[0] ?? [];
}

/** @return object */
function image_principal_admin_user(PDO $pdo)
{
    $adminName = image_principal_required_username('SUITECRM_ADMIN_USER');
    $row = image_principal_find_single_user($pdo, $adminName);
    if (
        $row === []
        || (int) ($row['deleted'] ?? 1) !== 0
        || (string) ($row['status'] ?? '') !== 'Active'
        || (int) ($row['is_admin'] ?? 0) !== 1
    ) {
        image_principal_invariant_failure('configured SuiteCRM administrator is not active');
    }
    $admin = BeanFactory::getBean('Users', (string) $row['id']);
    if (!$admin || empty($admin->id)) {
        image_principal_invariant_failure('configured SuiteCRM administrator could not be loaded');
    }
    return $admin;
}

/** @return object */
function image_principal_ensure_user(
    PDO $pdo,
    object $admin,
    string $username,
    string $password,
    string $description,
    string $lastName
) {
    $row = image_principal_find_single_user($pdo, $username);
    if ($row !== [] && (int) ($row['deleted'] ?? 1) !== 0) {
        image_principal_invariant_failure('configured username belongs to a deleted SuiteCRM user');
    }
    if (
        $row !== []
        && !hash_equals($description, (string) ($row['description'] ?? ''))
    ) {
        image_principal_invariant_failure(
            'configured username belongs to an unmanaged SuiteCRM user'
        );
    }

    $created = $row === [];
    if ($created) {
        $user = BeanFactory::newBean('Users');
        if (!$user) {
            image_principal_invariant_failure('SuiteCRM Users module is unavailable');
        }
        $user->new_with_id = true;
        $user->id = create_guid();
        $user->user_hash = User::getPasswordHash($password);
    } else {
        $user = BeanFactory::getBean('Users', (string) $row['id']);
    }
    if (!$user || empty($user->id)) {
        image_principal_invariant_failure('SuiteCRM image service user could not be loaded');
    }

    $passwordDrifted = $created || !User::checkPassword(
        $password,
        (string) ($user->user_hash ?? '')
    );
    $user->user_name = $username;
    $user->first_name = 'ClawPilot';
    $user->last_name = $lastName;
    $user->title = 'ClawPilot service principal';
    $user->description = $description;
    $user->status = 'Active';
    $user->employee_status = 'Active';
    $user->is_admin = '0';
    $user->portal_only = '0';
    $user->is_group = '0';
    $user->external_auth_only = '0';
    $user->sugar_login = '1';
    $user->show_on_employees = '0';
    $user->receive_notifications = '0';
    if (isset($user->field_defs['factor_auth'])) {
        $user->factor_auth = '0';
    }
    if (isset($user->field_defs['is_totp_enabled'])) {
        $user->is_totp_enabled = '0';
    }
    if (isset($user->field_defs['totp_secret'])) {
        $user->totp_secret = '';
    }
    $user->modified_user_id = $admin->id;
    if ($created) {
        $user->created_by = $admin->id;
    }
    $savedId = $user->save(false);
    if (!$savedId && empty($user->id)) {
        image_principal_invariant_failure('SuiteCRM image service user could not be saved');
    }
    if ($passwordDrifted) {
        $user->setNewPassword($password, '0');
    }

    $row = image_principal_find_single_user($pdo, $username);
    if (
        $row === []
        || !hash_equals($username, (string) ($row['user_name'] ?? ''))
        || (int) ($row['deleted'] ?? 1) !== 0
        || (int) ($row['is_admin'] ?? 1) !== 0
        || (string) ($row['status'] ?? '') !== 'Active'
        || (string) ($row['employee_status'] ?? '') !== 'Active'
        || (int) ($row['portal_only'] ?? 1) !== 0
        || (int) ($row['is_group'] ?? 1) !== 0
        || (int) ($row['external_auth_only'] ?? 1) !== 0
        || (int) ($row['sugar_login'] ?? 0) !== 1
        || (int) ($row['show_on_employees'] ?? 1) !== 0
        || (int) ($row['receive_notifications'] ?? 1) !== 0
        || (int) ($row['factor_auth'] ?? 1) !== 0
        || (int) ($row['is_totp_enabled'] ?? 1) !== 0
        || (string) ($row['totp_secret'] ?? '') !== ''
        || !hash_equals($description, (string) ($row['description'] ?? ''))
        || !User::checkPassword($password, (string) ($row['user_hash'] ?? ''))
    ) {
        image_principal_invariant_failure('SuiteCRM image service user verification failed');
    }
    return BeanFactory::getBean('Users', (string) $row['id']);
}

/** @return object */
function image_principal_ensure_role(
    PDO $pdo,
    object $admin,
    string $name,
    string $description
) {
    $statement = $pdo->prepare(
        'SELECT id, description FROM acl_roles WHERE name = ? AND deleted = 0'
    );
    $statement->execute([$name]);
    $rows = $statement->fetchAll();
    if (count($rows) > 1) {
        image_principal_invariant_failure('managed image role is duplicated');
    }
    if (
        $rows !== []
        && !hash_equals($description, (string) ($rows[0]['description'] ?? ''))
    ) {
        image_principal_invariant_failure(
            'managed image role name belongs to an unmanaged SuiteCRM role'
        );
    }
    if ($rows === []) {
        $role = BeanFactory::newBean('ACLRoles');
        if (!$role) {
            image_principal_invariant_failure('SuiteCRM ACL Roles module is unavailable');
        }
        $role->new_with_id = true;
        $role->id = create_guid();
        $role->created_by = $admin->id;
    } else {
        $role = BeanFactory::getBean('ACLRoles', (string) $rows[0]['id']);
    }
    if (!$role || empty($role->id)) {
        image_principal_invariant_failure('managed image role could not be loaded');
    }
    $role->name = $name;
    $role->description = $description;
    $role->modified_user_id = $admin->id;
    $role->save(false);
    $verify = $pdo->prepare(
        'SELECT COUNT(*)
           FROM acl_roles
          WHERE id = ? AND name = ? AND description = ? AND deleted = 0'
    );
    $verify->execute([(string) $role->id, $name, $description]);
    if ((int) $verify->fetchColumn() !== 1) {
        image_principal_invariant_failure('managed image role verification failed');
    }
    return $role;
}

/** @param list<string> $allowedActions */
function image_principal_expected_access(
    string $category,
    string $aclType,
    string $action,
    array $allowedActions
): int {
    if ($aclType !== 'module') {
        return ACL_ALLOW_NONE;
    }
    if ($category !== CLAWPILOT_IMAGE_PRODUCT_MODULE) {
        return $action === 'access' ? ACL_ALLOW_DISABLED : ACL_ALLOW_NONE;
    }
    if ($action === 'access') {
        return ACL_ALLOW_ENABLED;
    }
    return in_array($action, $allowedActions, true)
        ? ACL_ALLOW_ALL
        : ACL_ALLOW_NONE;
}

/** @param list<string> $allowedActions */
function image_principal_assign_exact_acl(
    PDO $pdo,
    string $userId,
    string $roleId,
    array $allowedActions
): void {
    $otherRoleUsers = $pdo->prepare(
        'SELECT COUNT(*)
           FROM acl_roles_users
          WHERE role_id = ? AND user_id <> ? AND deleted = 0'
    );
    $otherRoleUsers->execute([$roleId, $userId]);
    if ((int) $otherRoleUsers->fetchColumn() !== 0) {
        image_principal_invariant_failure('managed image role is assigned to another user');
    }
    $roleGroups = $pdo->prepare(
        'SELECT COUNT(*) FROM securitygroups_acl_roles WHERE role_id = ? AND deleted = 0'
    );
    $roleGroups->execute([$roleId]);
    if ((int) $roleGroups->fetchColumn() !== 0) {
        image_principal_invariant_failure('managed image role is assigned to a Security Group');
    }

    $pdo->beginTransaction();
    try {
        $removeOtherRoles = $pdo->prepare(
            'UPDATE acl_roles_users
                SET deleted = 1, date_modified = UTC_TIMESTAMP()
              WHERE user_id = ? AND role_id <> ? AND deleted = 0'
        );
        $removeOtherRoles->execute([$userId, $roleId]);
        $removeGroups = $pdo->prepare(
            'UPDATE securitygroups_users
                SET deleted = 1, date_modified = UTC_TIMESTAMP()
              WHERE user_id = ? AND deleted = 0'
        );
        $removeGroups->execute([$userId]);
        $membership = $pdo->prepare(
            'INSERT INTO acl_roles_users (id, role_id, user_id, date_modified, deleted)
             VALUES (?, ?, ?, UTC_TIMESTAMP(), 0)
             ON DUPLICATE KEY UPDATE date_modified = UTC_TIMESTAMP(), deleted = 0'
        );
        $membership->execute([create_guid(), $roleId, $userId]);

        $actions = $pdo->query(
            'SELECT id, category, acltype, name
               FROM acl_actions
              WHERE deleted = 0
              ORDER BY category, acltype, name'
        )->fetchAll();
        if ($actions === []) {
            image_principal_invariant_failure('SuiteCRM ACL actions are unavailable');
        }
        $targetActions = [];
        $upsert = $pdo->prepare(
            'INSERT INTO acl_roles_actions
                (id, role_id, action_id, access_override, date_modified, deleted)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), 0)
             ON DUPLICATE KEY UPDATE
                access_override = VALUES(access_override),
                date_modified = UTC_TIMESTAMP(),
                deleted = 0'
        );
        foreach ($actions as $action) {
            $category = (string) $action['category'];
            $aclType = (string) $action['acltype'];
            $name = (string) $action['name'];
            if ($category === CLAWPILOT_IMAGE_PRODUCT_MODULE && $aclType === 'module') {
                if (isset($targetActions[$name])) {
                    image_principal_invariant_failure('AOS Products ACL action is duplicated');
                }
                $targetActions[$name] = true;
            }
            $upsert->execute([
                create_guid(),
                $roleId,
                (string) $action['id'],
                image_principal_expected_access(
                    $category,
                    $aclType,
                    $name,
                    $allowedActions
                ),
            ]);
        }
        foreach (CLAWPILOT_IMAGE_ROLE_ACTIONS as $requiredAction) {
            if (!isset($targetActions[$requiredAction])) {
                image_principal_invariant_failure(
                    "AOS Products ACL action {$requiredAction} is unavailable"
                );
            }
        }
        $removeStaleActions = $pdo->prepare(
            'UPDATE acl_roles_actions role_action
             LEFT JOIN acl_actions action_record
                    ON action_record.id = role_action.action_id
                SET role_action.deleted = 1,
                    role_action.date_modified = UTC_TIMESTAMP()
              WHERE role_action.role_id = ?
                AND role_action.deleted = 0
                AND (action_record.id IS NULL OR action_record.deleted = 1)'
        );
        $removeStaleActions->execute([$roleId]);
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
}

/** @param list<string> $allowedActions */
function image_principal_verify_exact_acl(
    PDO $pdo,
    string $userId,
    string $roleId,
    array $allowedActions
): void {
    $roleMemberships = $pdo->prepare(
        'SELECT role_id FROM acl_roles_users WHERE user_id = ? AND deleted = 0'
    );
    $roleMemberships->execute([$userId]);
    $rows = $roleMemberships->fetchAll();
    if (count($rows) !== 1 || !hash_equals($roleId, (string) $rows[0]['role_id'])) {
        image_principal_invariant_failure('image service user role membership is not exact');
    }
    $groupMemberships = $pdo->prepare(
        'SELECT COUNT(*) FROM securitygroups_users WHERE user_id = ? AND deleted = 0'
    );
    $groupMemberships->execute([$userId]);
    if ((int) $groupMemberships->fetchColumn() !== 0) {
        image_principal_invariant_failure('image service user has a Security Group membership');
    }
    $roleUsers = $pdo->prepare(
        'SELECT user_id FROM acl_roles_users WHERE role_id = ? AND deleted = 0'
    );
    $roleUsers->execute([$roleId]);
    $roleUserRows = $roleUsers->fetchAll();
    if (
        count($roleUserRows) !== 1
        || !hash_equals($userId, (string) $roleUserRows[0]['user_id'])
    ) {
        image_principal_invariant_failure(
            'managed image role user membership is not exact'
        );
    }
    $roleGroupMemberships = $pdo->prepare(
        'SELECT COUNT(*) FROM securitygroups_acl_roles WHERE role_id = ? AND deleted = 0'
    );
    $roleGroupMemberships->execute([$roleId]);
    if ((int) $roleGroupMemberships->fetchColumn() !== 0) {
        image_principal_invariant_failure(
            'managed image role has a Security Group assignment'
        );
    }

    $actions = $pdo->prepare(
        'SELECT action_record.category,
                action_record.acltype,
                action_record.name,
                role_action.access_override
           FROM acl_actions action_record
      LEFT JOIN acl_roles_actions role_action
             ON role_action.action_id = action_record.id
            AND role_action.role_id = ?
            AND role_action.deleted = 0
          WHERE action_record.deleted = 0'
    );
    $actions->execute([$roleId]);
    $targetActions = [];
    foreach ($actions->fetchAll() as $row) {
        if ($row['access_override'] === null) {
            image_principal_invariant_failure('managed image role is missing an ACL override');
        }
        $category = (string) $row['category'];
        $aclType = (string) $row['acltype'];
        $name = (string) $row['name'];
        $expected = image_principal_expected_access(
            $category,
            $aclType,
            $name,
            $allowedActions
        );
        if ((int) $row['access_override'] !== $expected) {
            image_principal_invariant_failure('managed image role ACL verification failed');
        }
        if ($category === CLAWPILOT_IMAGE_PRODUCT_MODULE && $aclType === 'module') {
            $targetActions[$name] = (int) $row['access_override'];
        }
    }
    foreach (CLAWPILOT_IMAGE_ROLE_ACTIONS as $requiredAction) {
        if (!array_key_exists($requiredAction, $targetActions)) {
            image_principal_invariant_failure('managed AOS Products ACL is incomplete');
        }
    }

    if (isset($_SESSION['ACL'][$userId])) {
        unset($_SESSION['ACL'][$userId]);
    }
    foreach ($targetActions as $name => $expected) {
        $effective = ACLAction::getUserAccessLevel(
            $userId,
            CLAWPILOT_IMAGE_PRODUCT_MODULE,
            $name,
            'module'
        );
        if ((int) $effective !== $expected) {
            image_principal_invariant_failure(
                'SuiteCRM effective AOS Products ACL verification failed'
            );
        }
    }
    if (isset($_SESSION['ACL'][$userId])) {
        unset($_SESSION['ACL'][$userId]);
    }
}

function image_principal_ensure_reader_client(
    PDO $pdo,
    string $adminId,
    string $userId,
    string $clientId,
    string $clientSecret
): void {
    $secretHash = hash('sha256', $clientSecret);
    $existingClient = $pdo->prepare(
        'SELECT name, description, assigned_user_id
           FROM oauth2clients
          WHERE id = ?
          LIMIT 1'
    );
    $existingClient->execute([$clientId]);
    $existing = $existingClient->fetch();
    if (
        $existing
        && !hash_equals($userId, (string) ($existing['assigned_user_id'] ?? ''))
    ) {
        image_principal_invariant_failure(
            'read OAuth client ID is already assigned to another principal'
        );
    }
    if (
        $existing
        && (
            !hash_equals(
                'ClawPilot Product Image Reader',
                (string) ($existing['name'] ?? '')
            )
            || !hash_equals(
                'Managed by the ClawPilot SuiteCRM service bootstrap.',
                (string) ($existing['description'] ?? '')
            )
        )
    ) {
        image_principal_invariant_failure(
            'read OAuth client ID belongs to an unmanaged SuiteCRM client'
        );
    }
    $reusedSecret = $pdo->prepare(
        'SELECT COUNT(*) FROM oauth2clients WHERE secret = ? AND id <> ? AND deleted = 0'
    );
    $reusedSecret->execute([$secretHash, $clientId]);
    if ((int) $reusedSecret->fetchColumn() !== 0) {
        image_principal_invariant_failure('read OAuth client secret is already in use');
    }
    $otherClients = $pdo->prepare(
        'SELECT COUNT(*)
           FROM oauth2clients
          WHERE assigned_user_id = ? AND id <> ? AND deleted = 0'
    );
    $otherClients->execute([$userId, $clientId]);
    if ((int) $otherClients->fetchColumn() !== 0) {
        image_principal_invariant_failure('read image user is assigned to another OAuth client');
    }

    $statement = $pdo->prepare(
        'INSERT INTO oauth2clients (
           id, name, date_entered, date_modified, modified_user_id, created_by,
           description, deleted, secret, redirect_url, is_confidential,
           allowed_grant_type, duration_value, duration_amount, duration_unit,
           assigned_user_id
         ) VALUES (?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?, ?, 0, ?, ?, 1, ?, 3600, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           date_modified = UTC_TIMESTAMP(),
           modified_user_id = VALUES(modified_user_id),
           description = VALUES(description),
           deleted = 0,
           secret = VALUES(secret),
           redirect_url = VALUES(redirect_url),
           is_confidential = 1,
           allowed_grant_type = VALUES(allowed_grant_type),
           duration_value = VALUES(duration_value),
           duration_amount = VALUES(duration_amount),
           duration_unit = VALUES(duration_unit),
           assigned_user_id = VALUES(assigned_user_id)'
    );
    $statement->execute([
        $clientId,
        'ClawPilot Product Image Reader',
        $adminId,
        $adminId,
        'Managed by the ClawPilot SuiteCRM service bootstrap.',
        $secretHash,
        '',
        'client_credentials',
        'hour',
        $userId,
    ]);

    // Tokens issued before an ACL, principal, or secret repair must not survive boot.
    $invalidateTokens = $pdo->prepare(
        'UPDATE oauth2tokens
            SET token_is_revoked = 1, deleted = 1, date_modified = UTC_TIMESTAMP()
          WHERE client = ? AND deleted = 0'
    );
    $invalidateTokens->execute([$clientId]);

    $verify = $pdo->prepare(
        'SELECT secret, deleted, is_confidential, allowed_grant_type,
                duration_value, duration_amount, duration_unit, assigned_user_id
           FROM oauth2clients WHERE id = ?'
    );
    $verify->execute([$clientId]);
    $row = $verify->fetch();
    if (
        !$row
        || (int) $row['deleted'] !== 0
        || (int) $row['is_confidential'] !== 1
        || (string) $row['allowed_grant_type'] !== 'client_credentials'
        || (int) $row['duration_value'] !== 3600
        || (int) $row['duration_amount'] !== 1
        || (string) $row['duration_unit'] !== 'hour'
        || !hash_equals($userId, (string) $row['assigned_user_id'])
        || !hash_equals($secretHash, (string) $row['secret'])
    ) {
        image_principal_invariant_failure('read OAuth client verification failed');
    }
}

function image_principal_verify_no_oauth_client(PDO $pdo, string $userId): void
{
    $statement = $pdo->prepare(
        'SELECT COUNT(*) FROM oauth2clients WHERE assigned_user_id = ? AND deleted = 0'
    );
    $statement->execute([$userId]);
    if ((int) $statement->fetchColumn() !== 0) {
        image_principal_invariant_failure('forward image user must not own an OAuth client');
    }
}

function image_principal_verify_product_field(): void
{
    $product = BeanFactory::newBean(CLAWPILOT_IMAGE_PRODUCT_MODULE);
    $definition = $product && isset($product->field_defs[CLAWPILOT_IMAGE_PRODUCT_FIELD])
        && is_array($product->field_defs[CLAWPILOT_IMAGE_PRODUCT_FIELD])
        ? $product->field_defs[CLAWPILOT_IMAGE_PRODUCT_FIELD]
        : [];
    $metadata = $definition['metadata'] ?? [];
    if (is_string($metadata)) {
        $decoded = json_decode($metadata, true);
        $metadata = is_array($decoded) ? $decoded : [];
    }
    if (
        ($definition['type'] ?? '') !== 'image'
        || ($definition['source'] ?? '') !== 'non-db'
        || !is_array($metadata)
        || ($metadata['storage_type'] ?? '') !== 'private-images'
    ) {
        image_principal_invariant_failure('managed AOS Products image field is unavailable');
    }
}

try {
    $configuration = image_principal_configuration();
    if ($configuration['forward'] === null && $configuration['reverse'] === null) {
        fwrite(STDOUT, "SuiteCRM image service principals are not configured\n");
        exit(0);
    }

    if (!defined('sugarEntry')) {
        define('sugarEntry', true);
    }
    require_once 'include/entryPoint.php';
    require_once 'modules/ACLActions/ACLAction.php';
    require_once 'modules/ACLRoles/ACLRole.php';

    $pdo = image_principal_database();
    $admin = image_principal_admin_user($pdo);
    $GLOBALS['current_user'] = $admin;
    image_principal_verify_product_field();
    ACLAction::addActions(CLAWPILOT_IMAGE_PRODUCT_MODULE, 'module');

    if ($configuration['forward'] !== null) {
        $forward = image_principal_ensure_user(
            $pdo,
            $admin,
            $configuration['forward']['username'],
            $configuration['forward']['password'],
            CLAWPILOT_IMAGE_FORWARD_DESCRIPTION,
            'Product Image Media Writer'
        );
        $forwardRole = image_principal_ensure_role(
            $pdo,
            $admin,
            CLAWPILOT_IMAGE_FORWARD_ROLE,
            CLAWPILOT_IMAGE_FORWARD_DESCRIPTION
        );
        image_principal_assign_exact_acl(
            $pdo,
            (string) $forward->id,
            (string) $forwardRole->id,
            ['view', 'edit']
        );
        image_principal_verify_exact_acl(
            $pdo,
            (string) $forward->id,
            (string) $forwardRole->id,
            ['view', 'edit']
        );
        image_principal_verify_no_oauth_client($pdo, (string) $forward->id);
    }

    if ($configuration['reverse'] !== null) {
        $reverse = image_principal_ensure_user(
            $pdo,
            $admin,
            $configuration['reverse']['username'],
            $configuration['reverse']['password'],
            CLAWPILOT_IMAGE_REVERSE_DESCRIPTION,
            'Product Image Reader'
        );
        $reverseRole = image_principal_ensure_role(
            $pdo,
            $admin,
            CLAWPILOT_IMAGE_REVERSE_ROLE,
            CLAWPILOT_IMAGE_REVERSE_DESCRIPTION
        );
        image_principal_assign_exact_acl(
            $pdo,
            (string) $reverse->id,
            (string) $reverseRole->id,
            ['list', 'view']
        );
        image_principal_verify_exact_acl(
            $pdo,
            (string) $reverse->id,
            (string) $reverseRole->id,
            ['list', 'view']
        );
        image_principal_ensure_reader_client(
            $pdo,
            (string) $admin->id,
            (string) $reverse->id,
            $configuration['reverse']['clientId'],
            $configuration['reverse']['clientSecret']
        );
    }

    if (
        isset($forward, $reverse)
        && hash_equals((string) $forward->id, (string) $reverse->id)
    ) {
        image_principal_invariant_failure('forward and reverse image users are not separate');
    }

    fwrite(STDOUT, "SuiteCRM image service principals and exact ACLs are ready\n");
} catch (ClawPilotImagePrincipalConfigurationException $error) {
    fwrite(STDERR, "[suitecrm] image-principal configuration failed: {$error->getMessage()}\n");
    exit(1);
} catch (ClawPilotImagePrincipalInvariantException $error) {
    fwrite(STDERR, "[suitecrm] image-principal verification failed: {$error->getMessage()}\n");
    exit(1);
} catch (Throwable $error) {
    // Do not interpolate third-party exception messages: database/bean failures
    // can include query context and this bootstrap must never echo credentials.
    fwrite(STDERR, "[suitecrm] image-principal bootstrap failed before verification\n");
    exit(1);
}
