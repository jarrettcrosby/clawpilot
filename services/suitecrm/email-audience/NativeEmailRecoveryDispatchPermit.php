<?php
declare(strict_types=1);

require_once __DIR__.'/NativeEmailTransaction.php';

/** Exact private maintenance action proof. This class neither obtains a writer
 * fence nor trusts one described by a command. The caller supplies independently
 * pinned scope and the native database clock, rechecked under publication locks. */
final class ClawPilotNativeEmailRecoveryDispatchPermit
{
    private const PURPOSE = 'clawpilot-native-email-recovery-dispatch-v1';
    private const MAX_SAFE_INTEGER = 9007199254740991;
    private const SCOPE_KEYS = ['action','operationId','requestFingerprint','commandHash','targetFingerprint','fenceEpoch'];
    private const PROOF_KEYS = ['version','purpose','keyId','action','operationId','requestFingerprint','commandHash',
        'approvalHash','targetFingerprint','fenceEpoch','leaseOwner','leaseFence','issuedAt','expiresAt'];

    private function __construct(private readonly array $proof) {}

    public static function verify(array $envelope, array $trusted, int $now): self
    {
        self::keys($envelope, ['proof','signature']);
        self::keys($trusted, [...self::SCOPE_KEYS,'keyId','publicKeyPem']);
        $p = $envelope['proof'];
        self::keys($p, self::PROOF_KEYS);
        self::need($p['version'] === 1 && $p['purpose'] === self::PURPOSE
            && self::matches($p['keyId'], '/\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z/')
            && $p['keyId'] === $trusted['keyId'], 'domain');
        self::need(in_array($p['action'], ['prepare','publish','resolve'], true), 'scope');
        foreach (['operationId','requestFingerprint','commandHash','approvalHash','targetFingerprint'] as $key) {
            self::need(self::matches($p[$key], '/\A[a-f0-9]{64}\z/'), 'scope');
        }
        self::need(self::uuid($p['fenceEpoch']), 'scope');
        self::need($p['action'] === 'prepare'
            ? ($p['leaseOwner'] === null && $p['leaseFence'] === null)
            : (self::uuid($p['leaseOwner']) && self::epoch($p['leaseFence'])), 'lease');
        self::need(self::epoch($p['issuedAt']) && self::epoch($p['expiresAt'])
            && $p['expiresAt'] > $p['issuedAt'] && $p['expiresAt'] - $p['issuedAt'] <= 30, 'clock');

        // Retain only validated scalars, detached from caller-owned PHP references.
        $snapshot = [];
        foreach (self::PROOF_KEYS as $key) $snapshot[$key] = $p[$key];
        ksort($snapshot, SORT_STRING);
        $bytes = json_encode($snapshot, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $signature = $envelope['signature'];
        self::need(self::matches($signature, '/\A[A-Za-z0-9+\/]{512}\z/'), 'signature');
        $raw = base64_decode($signature, true);
        $key = self::publicKey($trusted['publicKeyPem']);
        self::need(is_string($raw) && strlen($raw) === 384 && base64_encode($raw) === $signature
            && preg_match('/\A[\x20-\x7e]+\z/', $bytes) === 1
            && @openssl_verify($bytes, $raw, $key, OPENSSL_ALGO_SHA256) === 1, 'signature');

        $permit = new self($snapshot);
        $permit->assertCurrent(array_intersect_key($trusted, array_flip(self::SCOPE_KEYS)), $now);
        return $permit;
    }

    /** Recheck every pinned action input against an independently read scope. */
    public function assertCurrent(array $scope, int $now): void
    {
        self::keys($scope, self::SCOPE_KEYS);
        foreach (self::SCOPE_KEYS as $key) self::need($scope[$key] === $this->proof[$key], 'scope');
        $this->assertClock($now);
    }

    /** Called by the publisher under locks after the private entrypoint has
     * verified the independent target, request fingerprint and fence epoch. */
    public function assertActionCurrent(string $action, string $operationId, string $commandHash, int $now): void
    {
        self::need($action === $this->proof['action'] && $operationId === $this->proof['operationId']
            && $commandHash === $this->proof['commandHash'], 'scope');
        $this->assertClock($now);
    }

    public function __serialize(): array { self::refuse('serialization'); }
    public function __unserialize(array $data): void { self::refuse('serialization'); }

    private function assertClock(int $now): void
    {
        self::need(self::epoch($now) && $this->proof['issuedAt'] <= $now && $now < $this->proof['expiresAt'], 'clock');
    }

    private static function publicKey(mixed $pem): OpenSSLAsymmetricKey
    {
        self::need(is_string($pem) && strlen($pem) <= 8192, 'key');
        $pem = str_replace("\r\n", "\n", $pem);
        self::need(preg_match('/\A-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+\/=\n]+)\n-----END PUBLIC KEY-----\n?\z/', $pem, $matches) === 1, 'key');
        $base64 = str_replace("\n", '', $matches[1]);
        $der = base64_decode($base64, true);
        // An RSA-3072 SubjectPublicKeyInfo has a two-byte outer DER length.
        // Pin the AlgorithmIdentifier to rsaEncryption + NULL, not RSA-PSS or
        // an OpenSSL algorithm selected by caller-supplied key metadata.
        self::need(is_string($der) && base64_encode($der) === $base64 && str_starts_with($der, "\x30\x82")
            && strlen($der) >= 19 && unpack('n', substr($der, 2, 2))[1] === strlen($der) - 4
            && substr($der, 4, 15) === "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00", 'key');
        $key = @openssl_pkey_get_public($pem);
        $details = $key === false ? false : openssl_pkey_get_details($key);
        self::need($key instanceof OpenSSLAsymmetricKey && is_array($details)
            && ($details['type'] ?? null) === OPENSSL_KEYTYPE_RSA && ($details['bits'] ?? null) === 3072, 'key');
        return $key;
    }

    private static function keys(mixed $object, array $expected): void
    {
        self::need(is_array($object), 'shape');
        $keys = array_keys($object);
        sort($keys, SORT_STRING);
        sort($expected, SORT_STRING);
        self::need($keys === $expected, 'shape');
    }

    private static function matches(mixed $value, string $pattern): bool
    { return is_string($value) && preg_match($pattern, $value) === 1; }

    private static function uuid(mixed $value): bool
    { return self::matches($value, '/\A[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z/'); }

    private static function epoch(mixed $value): bool
    { return is_int($value) && $value > 0 && $value <= self::MAX_SAFE_INTEGER; }

    private static function need(bool $ok, string $reason): void
    { if (!$ok) self::refuse($reason); }

    private static function refuse(string $reason): never
    { throw new ClawPilotNativeEmailTransactionRefused('native_recovery_dispatch_permit_'.$reason); }
}
