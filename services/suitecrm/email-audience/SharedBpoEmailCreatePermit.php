<?php
declare(strict_types=1);

require_once __DIR__.'/NativeEmailAuthorityContract.php';
require_once __DIR__.'/NativeEmailProjection.php';

/** Verified evidence for one create-missing action, not a writer or replay gate.
 * The private writer must independently pin the scope and key, re-observe the
 * database and policy under its locks, and claim the journal binding atomically
 * with the create. An unknown outcome permits journal readback only. */
final class ClawPilotSharedBpoEmailCreatePermit
{
    private const PURPOSE = 'clawpilot-shared-bpo-email-create-v1';
    private const WORKSPACE = 'c6c49765-9bf6-4223-9261-7553499f5d92';
    private const PIPELINE = '587c8746-ecf6-40ae-8c50-e456f99ad555';
    private const HASH = '/\A[a-f0-9]{64}\z/';
    private const UUID = '/\A[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z/';
    private const GLOBAL = '/\Agi(?:[0-9]{7}|[0-9a-v]{12})\z/';
    private const HASH_KEYS = ['releaseFingerprint','appDeploymentFingerprint','nativeDeploymentFingerprint',
        'appOriginFingerprint','nativeOriginFingerprint','inventoryFingerprint','slotFingerprint',
        'projectionFingerprint','policyStateFingerprint','nonce'];
    private const SCOPE_KEYS = ['action','keyId','workspaceId','pipelineId','lane','localId','nativeId','globalId',...self::HASH_KEYS];

    private function __construct(private readonly array $scope, private readonly int $issuedAt,
        private readonly int $expiresAt, private readonly string $proofFingerprint) {}

    /** The trusted pins must not be taken from the envelope or the projection. */
    public static function verify(array $envelope, array $trustedScope, array $projection,
        string $publicKeyPem, int $now): self
    {
        self::keys($envelope, ['proof','signature']);
        $proof = $envelope['proof'];
        self::keys($proof, ['version','purpose','scope','issuedAt','expiresAt']);
        self::need($proof['version'] === 1 && $proof['purpose'] === self::PURPOSE, 'domain');
        $scope = self::scope($proof['scope']);
        self::need(self::epoch($proof['issuedAt']) && self::epoch($proof['expiresAt'])
            && $proof['expiresAt'] > $proof['issuedAt'] && $proof['expiresAt'] - $proof['issuedAt'] <= 60, 'clock');

        // Only validated scalars enter the signature input or the branded value.
        $canonicalProof = ['version'=>1,'purpose'=>self::PURPOSE,'scope'=>$scope,
            'issuedAt'=>$proof['issuedAt'],'expiresAt'=>$proof['expiresAt']];
        $signature = $envelope['signature'];
        self::need(self::matches($signature, '/\A[A-Za-z0-9+\/]{512}\z/'), 'signature');
        $raw = base64_decode($signature, true);
        self::need(is_string($raw) && strlen($raw) === 384 && base64_encode($raw) === $signature
            && @openssl_verify(ClawPilotNativeEmailAuthorityContract::canonical($canonicalProof), $raw,
                self::publicKey($publicKeyPem), OPENSSL_ALGO_SHA256) === 1, 'signature');
        $permit = new self($scope, $proof['issuedAt'], $proof['expiresAt'],
            ClawPilotNativeEmailAuthorityContract::digest(['proof'=>$canonicalProof,'signature'=>$signature]));
        $permit->assertCurrent($trustedScope, $projection, $now);
        return $permit;
    }

    /** Recheck the live pins and exact validated projection, using the native
     * database clock under the same locks that will protect the journal. */
    public function assertCurrent(array $trustedScope, array $projection, int $now): void
    {
        self::need(self::scope($trustedScope) === $this->scope, 'scope');
        self::need(self::epoch($now) && $this->issuedAt <= $now && $now < $this->expiresAt, 'clock');
        $attributes = $projection['attributes'] ?? null;
        self::need(($projection['suiteCrmId'] ?? null) === $this->scope['nativeId'] && is_array($attributes)
            && ($attributes['global_id_c'] ?? null) === $this->scope['globalId']
            && array_key_exists('expectedBeforeFingerprint', $projection) && $projection['expectedBeforeFingerprint'] === null,
            'projection_scope');
        $previous = $projection['previousManaged'] ?? null;
        self::keys($previous, ['accounts','contacts']);
        self::need($previous['accounts'] === [] && $previous['contacts'] === [], 'projection_scope');
        self::need(hash_equals($this->scope['projectionFingerprint'],
            ClawPilotNativeEmailAuthorityContract::digest($projection)), 'projection_digest');
        try {
            $validated = ClawPilotNativeEmailProjection::validate($projection);
        } catch (ClawPilotNativeEmailProjectionRefused $error) {
            self::refuse('projection_shape');
        }
        self::need(hash_equals($this->scope['projectionFingerprint'],
            ClawPilotNativeEmailAuthorityContract::digest($validated)), 'projection_digest');
    }

    /** The native operation ID deliberately does not vary with release, nonce,
     * lane, approval, or source preimage. A re-signed request cannot mint a new
     * create operation for the same native ID. The journal must additionally
     * guard against a different native ID claiming the same collated Global ID. */
    public function journalBinding(): array
    {
        $intent = $this->scope;
        unset($intent['nonce']);
        return [
            'operationId'=>ClawPilotNativeEmailAuthorityContract::digest(
                [self::PURPOSE,$this->scope['nativeOriginFingerprint'],$this->scope['nativeId']]),
            'intentFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest([self::PURPOSE,$intent]),
            'proofFingerprint'=>$this->proofFingerprint,
            'nonce'=>$this->scope['nonce'],
            'nativeId'=>$this->scope['nativeId'],
            'globalId'=>$this->scope['globalId'],
        ];
    }

    public function projectionFingerprint(): string { return $this->scope['projectionFingerprint']; }

    private function __clone() {}
    public function __serialize(): array { self::refuse('serialization'); }
    public function __unserialize(array $data): void { self::refuse('serialization'); }

    private static function scope(mixed $value): array
    {
        self::keys($value, self::SCOPE_KEYS);
        self::need($value['action'] === 'create-missing' && $value['workspaceId'] === self::WORKSPACE
            && $value['pipelineId'] === self::PIPELINE && in_array($value['lane'], ['failed','historical','casey'], true)
            && self::matches($value['keyId'], '/\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z/')
            && self::matches($value['localId'], self::UUID) && self::matches($value['nativeId'], self::UUID)
            && self::matches($value['globalId'], self::GLOBAL), 'scope');
        foreach (self::HASH_KEYS as $key) self::need(self::matches($value[$key], self::HASH), 'scope');
        $pins = [];
        foreach (self::SCOPE_KEYS as $key) $pins[$key] = $value[$key];
        return $pins;
    }

    private static function publicKey(string $pem): OpenSSLAsymmetricKey
    {
        $pem = str_replace("\r\n", "\n", $pem);
        self::need(strlen($pem) <= 1024
            && preg_match('/\A-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+\/=\n]+)\n-----END PUBLIC KEY-----\n?\z/', $pem, $match) === 1, 'key');
        $base64 = str_replace("\n", '', $match[1]);
        $der = base64_decode($base64, true);
        // Require the rsaEncryption SPKI algorithm, not a caller-selected RSA-PSS key.
        self::need(is_string($der) && base64_encode($der) === $base64 && strlen($der) >= 19
            && str_starts_with($der, "\x30\x82") && unpack('n', substr($der, 2, 2))[1] === strlen($der) - 4
            && substr($der, 4, 15) === "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00", 'key');
        $key = @openssl_pkey_get_public($pem);
        $details = $key === false ? false : openssl_pkey_get_details($key);
        self::need($key instanceof OpenSSLAsymmetricKey && is_array($details)
            && ($details['type'] ?? null) === OPENSSL_KEYTYPE_RSA && ($details['bits'] ?? null) === 3072, 'key');
        return $key;
    }

    private static function keys(mixed $value, array $expected): void
    {
        self::need(is_array($value), 'shape');
        $keys = array_keys($value);
        sort($keys, SORT_STRING);
        sort($expected, SORT_STRING);
        self::need($keys === $expected, 'shape');
    }

    private static function matches(mixed $value, string $pattern): bool
    { return is_string($value) && preg_match($pattern, $value) === 1; }

    private static function epoch(mixed $value): bool
    { return is_int($value) && $value > 0 && $value <= 9007199254740991; }

    private static function need(bool $ok, string $reason): void { if (!$ok) self::refuse($reason); }
    private static function refuse(string $reason): never
    { throw new ClawPilotNativeEmailTransactionRefused('shared_bpo_email_create_permit_'.$reason); }
}
