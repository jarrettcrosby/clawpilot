#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function read(path) {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function section(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing ${start}`)
  assert.notEqual(endIndex, -1, `missing ${end}`)
  return source.slice(startIndex, endIndex)
}

function assertOrdered(source, needles, label) {
  let cursor = -1
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1)
    assert.notEqual(next, -1, `${label} missing ${needle}`)
    assert.ok(next > cursor, `${label} has ${needle} out of order`)
    cursor = next
  }
}

const bootstrap = read('services/suitecrm/bootstrap-image-principals.php')
const entrypoint = read('services/suitecrm/entrypoint.sh')
const dockerfile = read('services/suitecrm/Dockerfile')
const runbook = read('docs/operations/suitecrm.md')

for (const contract of [
  "const CLAWPILOT_IMAGE_PRODUCT_MODULE = 'AOS_Products';",
  "const CLAWPILOT_IMAGE_PRODUCT_FIELD = 'clawpilot_image_c';",
  "const CLAWPILOT_IMAGE_FORWARD_ROLE = 'ClawPilot Product Image Media Writer';",
  "const CLAWPILOT_IMAGE_REVERSE_ROLE = 'ClawPilot Product Image Reader';",
]) {
  assert.ok(bootstrap.includes(contract), `missing stable contract ${contract}`)
}

const configuration = section(
  bootstrap,
  'function image_principal_configuration(): array',
  'function image_principal_required_database_value',
)
for (const variable of [
  'SUITECRM_MEDIA_USERNAME',
  'SUITECRM_MEDIA_PASSWORD',
  'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID',
  'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET',
  'SUITECRM_PRODUCT_IMAGE_READ_USERNAME',
  'SUITECRM_PRODUCT_IMAGE_READ_PASSWORD',
  'SUITECRM_ADMIN_USER',
  'SUITECRM_ADMIN_PASSWORD',
  'SUITECRM_CLIENT_ID',
  'SUITECRM_CLIENT_SECRET',
]) {
  assert.ok(configuration.includes(`'${variable}'`), `missing credential ${variable}`)
}
assert.match(
  configuration,
  /image_principal_group_requested\([\s\S]*SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED/,
  'the forward flag makes its credential group mandatory',
)
assert.match(
  configuration,
  /image_principal_group_requested\([\s\S]*SUITECRM_PRODUCT_IMAGE_REVERSE_INGESTION_ENABLED/,
  'the reverse flag makes its credential group mandatory',
)
assert.match(
  configuration,
  /hash_equals\(\$leftValue, \$rightValue\)/,
  'credential reuse is compared without timing-sensitive equality',
)
assert.match(
  configuration,
  /credential values must be distinct \(\{\$leftName\}, \{\$rightName\}\)/,
  'credential conflict errors identify variable names rather than values',
)

const bootstrapLock = section(
  bootstrap,
  'function image_principal_bootstrap_lock_name(): string',
  '/** @return array<string, mixed> */',
)
assert.match(
  bootstrapLock,
  /hash\('sha256', \$databaseName\)/,
  'the advisory-lock namespace is isolated by SuiteCRM database',
)
const acquireBootstrapLock = section(
  bootstrapLock,
  'function image_principal_acquire_bootstrap_lock(PDO $pdo): string',
  'function image_principal_release_bootstrap_lock(PDO $pdo, string $lockName): void',
)
assert.match(acquireBootstrapLock, /SELECT GET_LOCK\(\?, 120\)/)
assert.match(acquireBootstrapLock, /execute\(\[\$lockName\]\)/)
assert.match(acquireBootstrapLock, /fetchColumn\(\) !== 1/)
assert.match(acquireBootstrapLock, /bootstrap lock could not be acquired/)
const releaseBootstrapLock = bootstrapLock.slice(
  bootstrapLock.indexOf('function image_principal_release_bootstrap_lock'),
)
assert.match(releaseBootstrapLock, /SELECT RELEASE_LOCK\(\?\)/)
assert.match(releaseBootstrapLock, /execute\(\[\$lockName\]\)/)
assert.match(releaseBootstrapLock, /fetchColumn\(\) !== 1/)
assert.match(releaseBootstrapLock, /bootstrap lock could not be released/)

const user = section(
  bootstrap,
  'function image_principal_ensure_user(',
  'function image_principal_ensure_role(',
)
for (const exactUserProperty of [
  "$user->status = 'Active';",
  "$user->is_admin = '0';",
  "$user->portal_only = '0';",
  "$user->is_group = '0';",
  "$user->external_auth_only = '0';",
  "$user->sugar_login = '1';",
  "$user->show_on_employees = '0';",
  "$user->receive_notifications = '0';",
]) {
  assert.ok(user.includes(exactUserProperty), `missing user invariant ${exactUserProperty}`)
}
assert.match(user, /User::checkPassword\(\$password,/)
assert.match(user, /\$user->setNewPassword\(\$password, '0'\)/)
assert.match(
  user,
  /configured username belongs to an unmanaged SuiteCRM user/,
  'an existing human or unrelated service user must never be adopted',
)
for (const verifiedProperty of [
  'employee_status',
  'portal_only',
  'is_group',
  'external_auth_only',
  'sugar_login',
  'show_on_employees',
  'receive_notifications',
  'factor_auth',
  'is_totp_enabled',
  'totp_secret',
  'description',
]) {
  assert.ok(user.includes(`$row['${verifiedProperty}']`), `missing user verification ${verifiedProperty}`)
}

const role = section(
  bootstrap,
  'function image_principal_ensure_role(',
  'function image_principal_expected_access(',
)
assert.match(
  role,
  /managed image role name belongs to an unmanaged SuiteCRM role/,
  'an unrelated pre-existing ACL role must never be repurposed',
)

const expectedAccess = section(
  bootstrap,
  'function image_principal_expected_access(',
  'function image_principal_assign_exact_acl(',
)
assert.match(expectedAccess, /if \(\$aclType !== 'module'\)[\s\S]*return ACL_ALLOW_NONE;/)
assert.match(
  expectedAccess,
  /if \(\$category !== CLAWPILOT_IMAGE_PRODUCT_MODULE\)[\s\S]*ACL_ALLOW_DISABLED[\s\S]*ACL_ALLOW_NONE/,
  'every other module is disabled and its actions denied',
)
assert.match(expectedAccess, /if \(\$action === 'access'\)[\s\S]*ACL_ALLOW_ENABLED;/)
assert.match(expectedAccess, /in_array\(\$action, \$allowedActions, true\)[\s\S]*ACL_ALLOW_ALL[\s\S]*ACL_ALLOW_NONE/)

const assignment = section(
  bootstrap,
  'function image_principal_assign_exact_acl(',
  'function image_principal_verify_exact_acl(',
)
assertOrdered(assignment, [
  '$pdo->beginTransaction();',
  'SELECT id, status, deleted FROM users WHERE id = ? FOR UPDATE',
  'managed image user is not active under lock',
  'SELECT id, deleted FROM acl_roles WHERE id = ? FOR UPDATE',
  'managed image role is not active under lock',
  'WHERE role_id = ? AND user_id <> ? AND deleted = 0',
  'managed image role is assigned to another user',
  'FROM securitygroups_acl_roles',
  'managed image role is assigned to a Security Group',
  'FROM acl_roles_users',
  'ORDER BY deleted ASC, date_modified DESC, id',
  'UPDATE acl_roles_users',
  'UPDATE securitygroups_users',
  'INSERT INTO acl_roles_users',
  'FROM acl_roles_actions',
  'UPDATE acl_roles_actions',
  "SELECT id, category, acltype, name",
  'INSERT INTO acl_roles_actions',
  'image_principal_expected_access(',
  'AOS Products ACL action {$requiredAction} is unavailable',
], 'deny-by-default ACL convergence')
assert.doesNotMatch(
  assignment.slice(0, assignment.indexOf('$pdo->beginTransaction();')),
  /acl_roles_users|securitygroups_acl_roles/,
  'membership collision decisions must not occur before the transaction',
)
assert.match(
  assignment,
  /WHERE role_id = \? AND user_id <> \? AND deleted = 0[\s\S]*FOR UPDATE[\s\S]*execute\(\[\$roleId, \$userId\]\)/,
  'other-user role membership collisions are rechecked under a locking read',
)
assert.match(
  assignment,
  /FROM securitygroups_acl_roles[\s\S]*WHERE role_id = \? AND deleted = 0[\s\S]*FOR UPDATE[\s\S]*execute\(\[\$roleId\]\)/,
  'Security Group role collisions are rechecked under a locking read',
)
assert.match(
  assignment,
  /WHERE user_id = \? AND role_id = \?[\s\S]*LIMIT 1[\s\S]*FOR UPDATE/,
  'one canonical managed-role membership is selected under lock',
)
assert.match(
  assignment,
  /UPDATE acl_roles_users[\s\S]*WHERE user_id = \? AND deleted = 0/,
  'all prior active memberships are deactivated before restoring one canonical row',
)
assert.match(
  assignment,
  /UPDATE acl_roles_users[\s\S]*WHERE id = \?/,
  'the canonical managed-role membership is reused on repeat bootstrap',
)
assert.match(
  assignment,
  /\$restoreMembership->execute\(\[\$roleId, \$userId, \$membershipId\]\)/,
  'the selected membership row is restored with the exact managed identity',
)
assert.match(
  assignment,
  /\$insertMembership->execute\(\[create_guid\(\), \$roleId, \$userId\]\)/,
  'a missing managed membership is inserted with the exact managed identity',
)
assert.match(
  assignment,
  /SELECT id, action_id[\s\S]*FROM acl_roles_actions[\s\S]*ORDER BY deleted ASC, date_modified DESC, id[\s\S]*FOR UPDATE/,
  'one canonical row per managed ACL action is selected under lock',
)
assert.match(
  assignment,
  /UPDATE acl_roles_actions[\s\S]*WHERE role_id = \? AND deleted = 0/,
  'prior active ACL rows are deactivated before exact ACL restoration',
)
assert.match(
  assignment,
  /\$restoreAction->execute\(\[[\s\S]*\$roleId,[\s\S]*\$actionId,[\s\S]*\$accessOverride,[\s\S]*\$existingActionIds\[\$actionId\],[\s\S]*\]\)/,
  'the canonical ACL row is restored with the exact role, action, and override',
)
assert.match(
  assignment,
  /\$insertAction->execute\(\[[\s\S]*create_guid\(\),[\s\S]*\$roleId,[\s\S]*\$actionId,[\s\S]*\$accessOverride,[\s\S]*\]\)/,
  'a missing ACL row is inserted with the exact role, action, and override',
)
assert.match(
  assignment,
  /catch \(Throwable \$error\)[\s\S]*inTransaction\(\)[\s\S]*rollBack\(\)[\s\S]*throw \$error/,
  'any convergence failure rolls the entire ACL transaction back',
)
assert.doesNotMatch(
  assignment,
  /ON DUPLICATE KEY UPDATE/,
  'repeat safety does not depend on SuiteCRM composite unique indexes',
)

const verification = section(
  bootstrap,
  'function image_principal_verify_exact_acl(',
  'function image_principal_ensure_reader_client(',
)
assert.match(verification, /count\(\$rows\) !== 1/)
assert.match(verification, /securitygroups_users WHERE user_id = \? AND deleted = 0/)
assert.match(verification, /acl_roles_users WHERE role_id = \? AND deleted = 0/)
assert.match(verification, /managed image role user membership is not exact/)
assert.match(verification, /securitygroups_acl_roles WHERE role_id = \? AND deleted = 0/)
assert.match(verification, /managed image role has a Security Group assignment/)
assert.match(verification, /managed image role is missing an ACL override/)
assert.match(verification, /\$actionMembershipCounts\[\$actionId\][\s\S]*!== 1/)
assert.match(verification, /managed image role ACL action membership is not exact/)
assert.match(
  verification,
  /FROM acl_roles_actions role_action[\s\S]*LEFT JOIN acl_actions action_record[\s\S]*action_record\.id IS NULL OR action_record\.deleted <> 0/,
  'active mappings to missing or deleted ACL actions are rejected',
)
assert.match(verification, /managed image role has a stale ACL action mapping/)
assert.match(verification, /image_principal_expected_access\(/)
assert.match(verification, /managed image role ACL verification failed/)
assert.match(verification, /ACLAction::getUserAccessLevel\(/)
assert.match(verification, /SuiteCRM effective AOS Products ACL verification failed/)

const readerClient = section(
  bootstrap,
  'function image_principal_ensure_reader_client(',
  'function image_principal_verify_no_oauth_client(',
)
assert.match(readerClient, /hash\('sha256', \$clientSecret\)/)
assert.match(
  readerClient,
  /SELECT name, description, assigned_user_id[\s\S]*FROM oauth2clients[\s\S]*WHERE id = \?[\s\S]*LIMIT 1/,
)
assert.match(readerClient, /read OAuth client ID is already assigned to another principal/)
assert.match(
  readerClient,
  /read OAuth client ID belongs to an unmanaged SuiteCRM client/,
  'an unrelated pre-existing OAuth client must never be repurposed',
)
assert.match(readerClient, /secret = \? AND id <> \? AND deleted = 0/)
assert.match(readerClient, /assigned_user_id = \? AND id <> \? AND deleted = 0/)
assert.match(readerClient, /'client_credentials'/)
assert.match(readerClient, /UPDATE oauth2tokens[\s\S]*token_is_revoked = 1[\s\S]*deleted = 1[\s\S]*WHERE client = \?/)
assert.match(readerClient, /hash_equals\(\$secretHash, \(string\) \$row\['secret'\]\)/)

const execution = section(
  bootstrap,
  'try {\n    $configuration = image_principal_configuration();',
  '} catch (ClawPilotImagePrincipalConfigurationException',
)
assertOrdered(execution, [
  '$configuration = image_principal_configuration();',
  "require_once 'include/entryPoint.php';",
  '$pdo = image_principal_database();',
  '$bootstrapLockName = image_principal_acquire_bootstrap_lock($pdo);',
  'image_principal_verify_product_field();',
  "ACLAction::addActions(CLAWPILOT_IMAGE_PRODUCT_MODULE, 'module');",
  "['view', 'edit']",
  'image_principal_verify_no_oauth_client',
  "['list', 'view']",
  'image_principal_ensure_reader_client(',
  'forward and reverse image users are not separate',
  '$bootstrapFailure = $error;',
  'image_principal_release_bootstrap_lock($pdo, $bootstrapLockName);',
  'throw $bootstrapFailure;',
  'SuiteCRM image service principals and exact ACLs are ready',
], 'bootstrap execution and postconditions')
assert.match(
  execution,
  /catch \(Throwable \$releaseError\)[\s\S]*if \(\$bootstrapFailure === null\)[\s\S]*\$bootstrapFailure = \$releaseError/,
  'lock-release failures are surfaced without replacing an earlier bootstrap failure',
)

const genericCatchStart = bootstrap.lastIndexOf('} catch (Throwable $error) {')
assert.notEqual(genericCatchStart, -1, 'missing final generic failure boundary')
const genericCatch = bootstrap.slice(genericCatchStart)
assert.doesNotMatch(genericCatch, /getMessage|clientSecret|password|username|clientId/)
assert.match(genericCatch, /must never echo credentials/)

assert.match(
  dockerfile,
  /COPY bootstrap-image-principals\.php \/opt\/clawpilot\/bootstrap-image-principals\.php/,
)
assertOrdered(entrypoint, [
  'php /opt/clawpilot/bootstrap-client.php',
  'php /opt/clawpilot/bootstrap-global-id.php',
  'php /opt/clawpilot/bootstrap-image-principals.php',
  'php bin/console cache:clear --no-warmup',
], 'SuiteCRM entrypoint bootstrap ordering')

for (const documented of [
  'Supplying either credential in a principal group',
  'assigns each user exactly one dedicated direct ACL role',
  'removes Security Group memberships',
  'The reverse role enables AOS Products access with only list/view',
  'SuiteCRM uses `edit` as its create permission',
  'invalidates that client\'s previously issued tokens',
]) {
  assert.ok(runbook.includes(documented), `runbook is missing: ${documented}`)
}

console.log('SuiteCRM image service-principal bootstrap contract passed')
