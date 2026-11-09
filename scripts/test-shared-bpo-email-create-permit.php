<?php
declare(strict_types=1);

require_once __DIR__.'/../services/suitecrm/email-audience/SharedBpoEmailCreatePermit.php';

function permitTest(bool $result, string $label): void
{
    if (!$result) throw new RuntimeException('Fixture check failed: '.$label);
}

function permitHeld(callable $fn, string $reason): void
{
    try { $fn(); } catch (ClawPilotNativeEmailTransactionRefused $error) {
        permitTest($error->holdCode === 'shared_bpo_email_create_permit_'.$reason, 'expected hold '.$reason);
        return;
    }
    throw new RuntimeException('Expected a hold: '.$reason);
}

$now = 1700000000;
$key = openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>3072]);
$otherKey = openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>3072]);
$smallKey = openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>2048]);
permitTest($key instanceof OpenSSLAsymmetricKey && $otherKey instanceof OpenSSLAsymmetricKey
    && $smallKey instanceof OpenSSLAsymmetricKey, 'offline fixture keys');
$pub = openssl_pkey_get_details($key)['key'];
$otherPub = openssl_pkey_get_details($otherKey)['key'];
$smallPub = openssl_pkey_get_details($smallKey)['key'];
$sign = static function(array $proof) use ($key): array {
    permitTest(openssl_sign(ClawPilotNativeEmailAuthorityContract::canonical($proof), $signature, $key, OPENSSL_ALGO_SHA256),
        'offline signature generation');
    return ['proof'=>$proof,'signature'=>base64_encode($signature)];
};

$projection = [
    'suiteCrmId'=>'cc000000-0000-4000-8000-000000000019',
    'attributes'=>['global_id_c'=>'gi123456789abc','name'=>'Synthetic, exact fixture',
        'date_sent_received'=>'2026-11-09T00:00:00Z','type'=>'archived','status'=>'read','parent_type'=>'Accounts',
        'parent_id'=>'fixture-account','assigned_user_id'=>'fixture-author','description'=>"Synthetic text.\nSecond line.",
        'description_html'=>'','from_addr_name'=>'author@example.invalid'],
    'accounts'=>['fixture-account','fixture-other-account'],
    'contacts'=>['fixture-contact'],
    'contactAccounts'=>[['contactId'=>'fixture-contact','accountId'=>'fixture-account']],
    'previousManaged'=>['accounts'=>[],'contacts'=>[]],
    'expectedBeforeFingerprint'=>null,
];
$scope = [
    'action'=>'create-missing','keyId'=>'fixture-operator','workspaceId'=>'c6c49765-9bf6-4223-9261-7553499f5d92',
    'pipelineId'=>'587c8746-ecf6-40ae-8c50-e456f99ad555','lane'=>'failed',
    'localId'=>'bb000000-0000-4000-8000-000000000019','nativeId'=>$projection['suiteCrmId'],
    'globalId'=>$projection['attributes']['global_id_c'],
    'projectionFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($projection),
];
foreach (['releaseFingerprint','appDeploymentFingerprint','nativeDeploymentFingerprint','appOriginFingerprint',
    'nativeOriginFingerprint','inventoryFingerprint','slotFingerprint','policyStateFingerprint','nonce'] as $field) {
    $scope[$field] = hash('sha256','fixture-'.$field);
}
$proof = ['version'=>1,'purpose'=>'clawpilot-shared-bpo-email-create-v1','scope'=>$scope,
    'issuedAt'=>$now,'expiresAt'=>$now+60];
$envelope = $sign($proof);
$permit = ClawPilotSharedBpoEmailCreatePermit::verify($envelope,$scope,$projection,$pub,$now);
$binding = $permit->journalBinding();
permitTest($binding['nativeId'] === $scope['nativeId'] && $binding['globalId'] === $scope['globalId']
    && $binding['nonce'] === $scope['nonce'], 'exact journal binding');
$permit->assertCurrent(array_reverse($scope,true),array_reverse($projection,true),$now+59);
permitHeld(fn()=>$permit->assertCurrent($scope,$projection,$now+60), 'clock');
permitHeld(fn()=>serialize($permit), 'serialization');

$changedSignature = $envelope;
$changedSignature['signature'][0] = $changedSignature['signature'][0] === 'A' ? 'B' : 'A';
permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify($changedSignature,$scope,$projection,$pub,$now), 'signature');
permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify($envelope,$scope,$projection,$otherPub,$now), 'signature');
permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify($envelope,$scope,$projection,$smallPub,$now), 'key');
permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify($envelope+['authorized'=>true],$scope,$projection,$pub,$now), 'shape');
foreach (['releaseFingerprint','appDeploymentFingerprint','nativeDeploymentFingerprint','appOriginFingerprint',
    'nativeOriginFingerprint','inventoryFingerprint','slotFingerprint','policyStateFingerprint','nonce','projectionFingerprint'] as $field) {
    $changed = array_replace($scope,[$field=>hash('sha256','different-'.$field)]);
    permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify($envelope,$changed,$projection,$pub,$now), 'scope');
}
foreach ([
    'workspaceId'=>'99000000-0000-4000-8000-000000000019',
    'pipelineId'=>'99000000-0000-4000-8000-000000000020',
    'action'=>'update-existing','lane'=>'unreviewed',
] as $field=>$value) {
    $changed = array_replace($scope,[$field=>$value]);
    permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify(
        $sign(array_replace($proof,['scope'=>$changed])),$changed,$projection,$pub,$now), 'scope');
}
foreach (['localId'=>'bb000000-0000-4000-8000-000000000020',
    'nativeId'=>'cc000000-0000-4000-8000-000000000020','globalId'=>'gi123456789abd','lane'=>'casey','keyId'=>'different'] as $field=>$value) {
    $changed = array_replace($scope,[$field=>$value]);
    permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify($envelope,$changed,$projection,$pub,$now), 'scope');
}
permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify(
    $sign(array_replace($proof,['expiresAt'=>$now+61])),$scope,$projection,$pub,$now), 'clock');
permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify($envelope,$scope,$projection,$pub,$now-1), 'clock');
permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify(
    $sign(array_replace($proof,['purpose'=>'unrelated'])),$scope,$projection,$pub,$now), 'domain');
permitHeld(fn()=>$permit->assertCurrent($scope,array_replace($projection,['expectedBeforeFingerprint'=>str_repeat('a',64)]),$now),
    'projection_scope');
permitHeld(fn()=>$permit->assertCurrent($scope,array_replace($projection,['previousManaged'=>['accounts'=>['legacy'],'contacts'=>[]]]),$now),
    'projection_scope');
$changed = $projection; $changed['attributes']['description'] = 'Changed payload';
permitHeld(fn()=>$permit->assertCurrent($scope,$changed,$now), 'projection_digest');
$changed = $projection; $changed['accounts'] = array_reverse($changed['accounts']);
permitHeld(fn()=>$permit->assertCurrent($scope,$changed,$now), 'projection_digest');
$unsortedScope = array_replace($scope,['projectionFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($changed)]);
permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify(
    $sign(array_replace($proof,['scope'=>$unsortedScope])),$unsortedScope,$changed,$pub,$now), 'projection_digest');
$changed = $projection; $changed['attributes']['status'] = 'draft';
$unsupportedScope = array_replace($scope,['projectionFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($changed)]);
permitHeld(fn()=>ClawPilotSharedBpoEmailCreatePermit::verify(
    $sign(array_replace($proof,['scope'=>$unsupportedScope])),$unsupportedScope,$changed,$pub,$now), 'projection_shape');

// Re-signing after expiry cannot make a new native create operation. A writer
// must use operation ID + nonce + Global ID under a transactional journal.
$freshScope = array_replace($scope,['nonce'=>hash('sha256','second fixture nonce')]);
$freshProof = array_replace($proof,['scope'=>$freshScope,'issuedAt'=>$now+60,'expiresAt'=>$now+120]);
$fresh = ClawPilotSharedBpoEmailCreatePermit::verify($sign($freshProof),$freshScope,$projection,$pub,$now+60)->journalBinding();
permitTest($fresh['operationId'] === $binding['operationId'] && $fresh['intentFingerprint'] === $binding['intentFingerprint']
    && $fresh['proofFingerprint'] !== $binding['proofFingerprint'] && $fresh['nonce'] !== $binding['nonce'], 'stable replay identity');

fwrite(STDOUT,"Shared BPO Email create permit passed: exact native scope, signature, projection, clock and stable replay binding.\n");
