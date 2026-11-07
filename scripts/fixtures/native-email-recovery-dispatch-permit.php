<?php
declare(strict_types=1);

// Pure verifier test. No database, native startup, filesystem writes or I/O
// beyond loading the verifier and returning the bounded result. Optional
// explicit source path allows running inside the already pinned PHP image.
if (PHP_SAPI !== 'cli' || count($argv) > 3 || (count($argv)===3 && $argv[2]!=='--wire')) exit(2);
require_once ($argv[1] ?? dirname(__DIR__, 2).'/services/suitecrm/email-audience/NativeEmailRecoveryDispatchPermit.php');

const NOW = 1730000000;
const FENCE = '12345678-9012-4abc-8012-123456789abc';
const OWNER = '12345678-9012-4abc-8012-123456789abd';

function permitCheck(bool $ok, string $case): void { if (!$ok) throw new RuntimeException($case); }
function permitKey(int $bits): array
{
    $key = openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>$bits]);
    permitCheck($key instanceof OpenSSLAsymmetricKey, 'key_generation');
    $details = openssl_pkey_get_details($key);
    permitCheck(is_array($details) && is_string($details['key'] ?? null), 'public_key_export');
    return [$key, $details['key']];
}
function signedPermit(array $proof, OpenSSLAsymmetricKey $key): array
{
    $canonical = $proof; ksort($canonical, SORT_STRING);
    permitCheck(openssl_sign(json_encode($canonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
        $bytes, $key, OPENSSL_ALGO_SHA256), 'test_sign');
    return ['signature'=>base64_encode($bytes),'proof'=>array_reverse($proof, true)];
}
function expectPermitRefusal(string $reason, callable $action): void
{
    try { $action(); }
    catch (ClawPilotNativeEmailTransactionRefused $error) {
        permitCheck($error->holdCode === 'native_recovery_dispatch_permit_'.$reason, 'unexpected_refusal_'.$reason);
        permitCheck($error->diagnostic === null, 'no_private_diagnostic');
        return;
    }
    throw new RuntimeException('accepted_'.$reason);
}

try {
    if (($argv[2]??null)==='--wire') {
        $bytes=stream_get_contents(STDIN,32769);
        permitCheck(is_string($bytes)&&strlen($bytes)<=32768,'wire_bound');
        $vectors=json_decode($bytes,true,24,JSON_THROW_ON_ERROR);
        permitCheck(is_array($vectors)&&array_is_list($vectors)&&count($vectors)===3,'wire_shape');
        foreach($vectors as $index=>$vector){
            permitCheck(is_array($vector)&&count($vector)===3&&isset($vector['envelope'],$vector['trusted'],$vector['now']),'wire_vector');
            $expected=['prepare','publish','resolve'][$index];
            $t=$vector['trusted'];permitCheck($t['action']===$expected,'wire_action');
            ClawPilotNativeEmailRecoveryDispatchPermit::verify($vector['envelope'],$t,$vector['now'])
                ->assertActionCurrent($expected,$t['operationId'],$t['commandHash'],$vector['now']);
        }
        fwrite(STDOUT,"PASS Node-issued private dispatch permits verified in PHP\n");
        exit(0);
    }
    [$key, $pem] = permitKey(3072);
    [$wrongKey, $wrongPem] = permitKey(3072);
    [$shortKey, $shortPem] = permitKey(2048);
    $P = ClawPilotNativeEmailRecoveryDispatchPermit::class;
    $proof = ['version'=>1,'purpose'=>'clawpilot-native-email-recovery-dispatch-v1','keyId'=>'fixture.issuer-1',
        'action'=>'publish','operationId'=>str_repeat('a',64),'requestFingerprint'=>str_repeat('b',64),'commandHash'=>str_repeat('c',64),
        'approvalHash'=>str_repeat('d',64),'targetFingerprint'=>str_repeat('e',64),'fenceEpoch'=>FENCE,'leaseOwner'=>OWNER,
        'leaseFence'=>4,'issuedAt'=>NOW,'expiresAt'=>NOW+30];
    $scope = array_intersect_key($proof, array_flip(['action','operationId','requestFingerprint','commandHash','targetFingerprint','fenceEpoch']));
    $trusted = [...$scope,'keyId'=>$proof['keyId'],'publicKeyPem'=>$pem];
    $envelope = signedPermit($proof, $key);
    $permit = $P::verify($envelope,$trusted,NOW);
    $permit->assertCurrent($scope,NOW+29);
    $permit->assertActionCurrent('publish',$scope['operationId'],$scope['commandHash'],NOW+29);
    foreach (['prepare','resolve'] as $action) {
        $next = [...$proof,'action'=>$action];
        if ($action === 'prepare') $next = [...$next,'leaseOwner'=>null,'leaseFence'=>null];
        $P::verify(signedPermit($next,$key),[...$trusted,'action'=>$action],NOW)
            ->assertActionCurrent($action,$scope['operationId'],$scope['commandHash'],NOW);
    }

    expectPermitRefusal('clock', fn()=>$P::verify($envelope,$trusted,NOW-1));
    expectPermitRefusal('clock', fn()=>$permit->assertCurrent($scope,NOW+30));
    expectPermitRefusal('clock', fn()=>$P::verify(signedPermit([...$proof,'expiresAt'=>NOW+31],$key),$trusted,NOW));
    expectPermitRefusal('lease', fn()=>$P::verify(signedPermit([...$proof,'leaseOwner'=>null,'leaseFence'=>null],$key),$trusted,NOW));
    expectPermitRefusal('lease', fn()=>$P::verify(signedPermit([...$proof,'leaseFence'=>9007199254740992],$key),$trusted,NOW));
    expectPermitRefusal('lease', fn()=>$P::verify(signedPermit([...$proof,'action'=>'prepare'],$key),[...$trusted,'action'=>'prepare'],NOW));
    expectPermitRefusal('domain', fn()=>$P::verify(signedPermit([...$proof,'purpose'=>'other-purpose'],$key),$trusted,NOW));
    expectPermitRefusal('domain', fn()=>$P::verify($envelope,[...$trusted,'keyId'=>'wrong-key-id'],NOW));
    expectPermitRefusal('scope', fn()=>$P::verify($envelope,[...$trusted,'action'=>'resolve'],NOW));
    expectPermitRefusal('scope', fn()=>$P::verify($envelope,[...$trusted,'fenceEpoch'=>OWNER],NOW));
    expectPermitRefusal('scope', fn()=>$permit->assertCurrent([...$scope,'requestFingerprint'=>str_repeat('0',64)],NOW));
    expectPermitRefusal('scope', fn()=>$permit->assertCurrent([...$scope,'targetFingerprint'=>str_repeat('0',64)],NOW));
    expectPermitRefusal('scope', fn()=>$permit->assertActionCurrent('publish',$scope['operationId'],str_repeat('0',64),NOW));
    expectPermitRefusal('scope', fn()=>$permit->assertActionCurrent('resolve',$scope['operationId'],$scope['commandHash'],NOW));
    expectPermitRefusal('signature', fn()=>$P::verify($envelope,[...$trusted,'publicKeyPem'=>$wrongPem],NOW));
    expectPermitRefusal('signature', fn()=>$P::verify(signedPermit($proof,$wrongKey),$trusted,NOW));
    expectPermitRefusal('signature', fn()=>$P::verify([...$envelope,'proof'=>[...$proof,'approvalHash'=>str_repeat('0',64)]],$trusted,NOW));
    expectPermitRefusal('signature', fn()=>$P::verify([...$envelope,'signature'=>$envelope['signature']."\n"],$trusted,NOW));
    expectPermitRefusal('key', fn()=>$P::verify($envelope,[...$trusted,'publicKeyPem'=>$shortPem],NOW));
    permitCheck(openssl_pkey_export($shortKey,$private), 'private_key_export');
    expectPermitRefusal('key', fn()=>$P::verify($envelope,[...$trusted,'publicKeyPem'=>$private],NOW));
    expectPermitRefusal('shape', fn()=>$P::verify([...$envelope,'unexpected'=>'value'],$trusted,NOW));
    expectPermitRefusal('shape', fn()=>$P::verify(signedPermit([...$proof,'unexpected'=>'value'],$key),$trusted,NOW));
    expectPermitRefusal('shape', fn()=>$P::verify($envelope,[...$trusted,'unexpected'=>'value'],NOW));
    expectPermitRefusal('serialization', fn()=>serialize($permit));
    $name = $P;
    expectPermitRefusal('serialization', fn()=>unserialize('O:'.strlen($name).':"'.$name.'":0:{}'));
    fwrite(STDOUT,"PASS private native recovery dispatch permit verification\n");
} catch (Throwable $error) {
    $message = $error instanceof RuntimeException ? $error->getMessage() : '';
    fwrite(STDERR, 'Permit verification fixture failed: '.(preg_match('/\A[a-z_]+\z/',$message) === 1 ? $message : 'unexpected_error')."\n");
    exit(1);
}
