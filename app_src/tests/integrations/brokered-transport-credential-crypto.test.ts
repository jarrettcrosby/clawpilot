import assert from 'node:assert/strict'
import test from 'node:test'
import {
  brokeredTransportCredentialCommandRequestHash,
  brokeredTransportCredentialIdentifierLastFour,
  decryptBrokeredTransportCredential,
  encryptBrokeredTransportCredential,
  normalizeBrokeredTransportEnvironment,
  normalizeBrokeredTransportCredential,
  wwexSpeedshipBillingAccountFingerprint,
} from '../../lib/integrations/brokeredTransportCredentialCrypto.ts'

const organizationId = '11111111-1111-4111-8111-111111111111'

test('Worldwide Express credentials are normalized, encrypted, and organization-bound', () => {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = 'transport-test-key-that-is-at-least-thirty-two-bytes'
  const credential = normalizeBrokeredTransportCredential('wwex_speedship', {
    authKind: 'oauth_client_credentials',
    clientId: 'replacement-client-1234',
    clientSecret: 'replacement-secret-value',
    audience: 'staging-wwex-apig',
  })
  const encrypted = encryptBrokeredTransportCredential(
    credential,
    organizationId,
    'wwex_speedship',
    'sandbox',
  )
  assert.deepEqual(
    decryptBrokeredTransportCredential(
      encrypted,
      organizationId,
      'wwex_speedship',
      'sandbox',
    ),
    credential,
  )
  assert.equal(
    brokeredTransportCredentialIdentifierLastFour('wwex_speedship', credential),
    '1234',
  )
  assert.throws(
    () => decryptBrokeredTransportCredential(
      encrypted,
      '22222222-2222-4222-8222-222222222222',
      'wwex_speedship',
      'sandbox',
    ),
    /could not be decrypted/,
  )
})

test('R+L credentials are production-only and expose only identifier metadata', () => {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = 'transport-test-key-that-is-at-least-thirty-two-bytes'
  const credential = normalizeBrokeredTransportCredential('rl_carriers', {
    authKind: 'api_key',
    apiKey: 'replacement-rl-key-9876',
  })
  assert.throws(
    () => normalizeBrokeredTransportEnvironment('rl_carriers', 'sandbox'),
    /has not supplied a sandbox/,
  )
  assert.equal(
    brokeredTransportCredentialIdentifierLastFour('rl_carriers', credential),
    '9876',
  )
  assert.throws(
    () => normalizeBrokeredTransportCredential('rl_carriers', {
      authKind: 'api_key',
      apiKey: 'replacement-rl-key-9876',
      baseUrl: 'https://attacker.example',
    }),
    /field baseUrl is not supported/,
  )
  for (const invalidApiKey of [12345678, true, { value: 'api-key' }]) {
    assert.throws(
      () => normalizeBrokeredTransportCredential('rl_carriers', {
        authKind: 'api_key',
        apiKey: invalidApiKey,
      }),
      /printable ASCII/,
    )
  }
})

test('credential fields reject non-string values instead of coercing them', () => {
  const base = {
    authKind: 'oauth_client_credentials',
    clientId: 'replacement-client-1234',
    clientSecret: 'replacement-secret-value',
    audience: 'staging-wwex-apig',
  }
  for (const field of ['clientId', 'clientSecret', 'audience']) {
    for (const invalid of [12345678, true, { value: 'credential' }]) {
      assert.throws(
        () => normalizeBrokeredTransportCredential('wwex_speedship', {
          ...base,
          [field]: invalid,
        }),
        /printable ASCII/,
      )
    }
  }
})

test('Worldwide Express billing account evidence is server-keyed and organization-bound', () => {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = 'transport-test-key-that-is-at-least-thirty-two-bytes'
  const accountNumber = 'WWEX-ACCOUNT-7788'
  const fingerprint = wwexSpeedshipBillingAccountFingerprint(
    organizationId,
    'sandbox',
    accountNumber,
  )
  assert.match(fingerprint, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(fingerprint, /7788|WWEX|ACCOUNT/)
  assert.notEqual(
    fingerprint,
    wwexSpeedshipBillingAccountFingerprint(
      '22222222-2222-4222-8222-222222222222',
      'sandbox',
      accountNumber,
    ),
  )
})

test('credential command request hashes are stable, keyed, and scope-bound', () => {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = 'transport-test-key-that-is-at-least-thirty-two-bytes'
  const credential = {
    authKind: 'oauth_client_credentials' as const,
    clientId: 'credential-command-client-1234',
    clientSecret: 'credential-command-secret-value',
    audience: 'staging-wwex-apig',
  }
  const hash = brokeredTransportCredentialCommandRequestHash(
    organizationId,
    'wwex_speedship',
    'sandbox',
    'Worldwide Express sandbox',
    credential,
  )
  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.equal(
    hash,
    brokeredTransportCredentialCommandRequestHash(
      organizationId,
      'wwex_speedship',
      'sandbox',
      '  Worldwide   Express sandbox  ',
      credential,
    ),
  )
  assert.doesNotMatch(hash, /1234|secret|credential/i)
  assert.notEqual(
    hash,
    brokeredTransportCredentialCommandRequestHash(
      organizationId,
      'wwex_speedship',
      'sandbox',
      'Worldwide Express sandbox',
      { ...credential, clientSecret: 'different-command-secret-value' },
    ),
  )
  assert.notEqual(
    hash,
    brokeredTransportCredentialCommandRequestHash(
      '22222222-2222-4222-8222-222222222222',
      'wwex_speedship',
      'sandbox',
      'Worldwide Express sandbox',
      credential,
    ),
  )
})
