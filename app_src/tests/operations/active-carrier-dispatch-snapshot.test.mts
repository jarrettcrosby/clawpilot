import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import * as dispatchSnapshot from '../../lib/operations/activeCarrierDispatchSnapshot.ts'
import type {
  ActiveCarrierDispatchAddressSnapshot,
  ActiveCarrierDispatchSnapshotInput,
} from '../../lib/operations/activeCarrierDispatchSnapshot.ts'

const {
  ActiveCarrierDispatchSnapshotError,
  createActiveCarrierDispatchRerateBinding,
  createActiveCarrierDispatchSnapshot,
} = dispatchSnapshot

const fingerprintA = 'a'.repeat(64)
const fingerprintB = 'b'.repeat(64)
const fingerprintC = 'c'.repeat(64)
const fingerprintD = 'd'.repeat(64)
const fingerprintE = 'e'.repeat(64)

function originFingerprint(
  origin: ActiveCarrierDispatchAddressSnapshot,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      line1: origin.line1.toLowerCase(),
      line2: origin.line2?.toLowerCase() || null,
      city: origin.city.toLowerCase(),
      region: origin.region?.toLowerCase() || null,
      postalCode: origin.postalCode.toLowerCase().replace(/[\s-]/gu, ''),
      countryCode: origin.countryCode,
    }), 'utf8')
    .digest('hex')
}

function withDispatchBinding(
  input: ActiveCarrierDispatchSnapshotInput,
): ActiveCarrierDispatchSnapshotInput {
  return {
    ...input,
    selectedRateEvidence: {
      ...input.selectedRateEvidence,
      dispatchBinding: createActiveCarrierDispatchRerateBinding({
        organization: input.organization,
        order: input.order,
        plan: input.plan,
        warehouse: input.warehouse,
        origin: input.origin,
        destination: input.destination,
        billing: input.billing,
        packages: input.packages,
      }),
    },
  }
}

function validInput(): ActiveCarrierDispatchSnapshotInput {
  const origin: ActiveCarrierDispatchAddressSnapshot = {
    contactName: 'AG Alchemy Shipping',
    companyName: 'AG Alchemy, LLC',
    phone: '+1 402 555 0100',
    email: 'warehouse@example.com',
    line1: '7009 S 108th St',
    line2: null,
    line3: null,
    city: 'La Vista',
    region: 'NE',
    postalCode: '68128',
    countryCode: 'US',
    residential: false,
  }
  return withDispatchBinding({
    snapshotAt: '2026-07-31T12:00:00.000Z',
    environment: 'production',
    organization: {
      id: '11111111-1111-4111-8111-111111111111',
      globalId: 'ga0000001',
    },
    order: {
      id: '22222222-2222-4222-8222-222222222222',
      globalId: 'gor0000001',
    },
    plan: {
      id: '33333333-3333-4333-8333-333333333333',
      globalId: 'gfp0000001',
    },
    warehouse: {
      id: '44444444-4444-4444-8444-444444444444',
      globalId: 'gwh0000001',
    },
    carrierAttempt: {
      id: '99999999-9999-4999-8999-999999999999',
      globalId: 'gaca0000001',
      attemptNumber: 1,
    },
    provider: 'ups_rest',
    integrationAccount: {
      id: '55555555-5555-4555-8555-555555555555',
      globalId: 'gia0000001',
    },
    carrierAccount: {
      id: '66666666-6666-4666-8666-666666666666',
      globalId: 'gac0000001',
      configurationRevision: 4,
      accountNumberFingerprint: fingerprintA,
      registeredOriginFingerprint: originFingerprint(origin),
      allowedBillingRelationships: [
        'sender',
        'recipient',
        'third_party',
      ],
    },
    credential: {
      revision: 7,
      fingerprint: fingerprintB,
    },
    billing: {
      relationship: 'sender',
      payerAccountNumberFingerprint: fingerprintA,
      payerCountryCode: 'US',
      payerPostalCode: '68128',
    },
    origin,
    destination: {
      contactName: 'Warehouse Warehouse',
      companyName: null,
      phone: '+1 714 555 0100',
      email: 'jarrett+warehouse@episcs.com',
      line1: '16691 Gothard St',
      line2: 'Suite Q',
      line3: null,
      city: 'Huntington Beach',
      region: 'CA',
      postalCode: '92647',
      countryCode: 'US',
      residential: true,
    },
    selectedRateEvidence: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      globalId: 'gars0000001',
      rerateRun: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        globalId: 'gafr0000001',
      },
      rerateInputHash: fingerprintC,
      rerateResultHash: fingerprintD,
      reratePurpose: 'fulfillment_execution',
      ratePurpose: 'cartonization_shipment_rate',
      status: 'succeeded',
      environment: 'production',
      provider: 'ups_rest',
      providerReference: 'ups-rate-000001',
      requestHash: fingerprintE,
      integrationAccountId: '55555555-5555-4555-8555-555555555555',
      carrierAccountId: '66666666-6666-4666-8666-666666666666',
      accountNumberFingerprint: fingerprintA,
      credentialRevision: 7,
      credentialFingerprint: fingerprintB,
      adapterVersion: 'ups-rest-rate-v1',
      completedAt: '2026-07-31T11:59:00.000Z',
      expiresAt: '2026-07-31T12:05:00.000Z',
      amountMinor: 1_962,
      currency: 'USD',
      service: {
        code: '03',
        name: 'UPS Ground',
      },
    },
    packages: [
      {
        packageId: '77777777-7777-4777-8777-777777777777',
        packageGlobalId: 'gpa0000001',
        packageNumber: 1,
        dimensionsMm: { length: 279, width: 229, height: 178 },
        weightGrams: 4_536,
      },
      {
        packageId: '88888888-8888-4888-8888-888888888888',
        packageGlobalId: 'gpa0000002',
        packageNumber: 2,
        dimensionsMm: { length: 432, width: 279, height: 178 },
        weightGrams: 9_072,
      },
    ],
    adapterVersion: 'ups-rest-shipment-v1',
  } as unknown as ActiveCarrierDispatchSnapshotInput)
}

function expectCode(invoke: () => unknown, expectedCode: string): void {
  assert.throws(invoke, (error: unknown) => {
    assert.ok(error instanceof ActiveCarrierDispatchSnapshotError)
    assert.equal(error.code, expectedCode)
    return true
  })
}

test('seals every production dispatch authority into one deeply immutable snapshot', () => {
  const mutableDimensions = { length: 279, width: 229, height: 178 }
  const baselineInput = validInput()
  const input: ActiveCarrierDispatchSnapshotInput = {
    ...baselineInput,
    packages: [{
      ...baselineInput.packages[0],
      dimensionsMm: mutableDimensions,
    }, baselineInput.packages[1]],
  }
  const snapshot = createActiveCarrierDispatchSnapshot(input)

  assert.equal(snapshot.schemaVersion, 1)
  assert.equal(snapshot.operation, 'create_multi_package_shipment')
  assert.equal(snapshot.snapshotAt, '2026-07-31T12:00:00.000Z')
  assert.equal(snapshot.environment, 'production')
  assert.equal(snapshot.organization.globalId, 'ga0000001')
  assert.equal(snapshot.order.globalId, 'gor0000001')
  assert.equal(snapshot.plan.globalId, 'gfp0000001')
  assert.equal(snapshot.warehouse.globalId, 'gwh0000001')
  assert.equal(snapshot.carrierAttempt.globalId, 'gaca0000001')
  assert.equal(snapshot.integrationAccount.globalId, 'gia0000001')
  assert.equal(snapshot.carrierAccount.globalId, 'gac0000001')
  assert.equal(snapshot.carrierAccount.configurationRevision, 4)
  assert.equal(snapshot.credential.revision, 7)
  assert.equal(snapshot.billing.relationship, 'sender')
  assert.equal(snapshot.selectedRateEvidence.globalId, 'gars0000001')
  assert.equal(snapshot.selectedRateEvidence.rerateRun.globalId, 'gafr0000001')
  assert.equal(snapshot.selectedRateEvidence.providerReference, 'ups-rate-000001')
  assert.equal(snapshot.service.code, '03')
  assert.equal(snapshot.selectedAmountMinor, 1_962)
  assert.equal(snapshot.currency, 'USD')
  assert.equal(snapshot.packageCount, 2)
  assert.deepEqual(snapshot.packages.map((entry) => entry.packageNumber), [1, 2])
  assert.equal(snapshot.snapshotHashAlgorithm, 'sha256')
  assert.match(snapshot.dispatchRequestFingerprint, /^[a-f0-9]{64}$/u)
  assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/u)
  assert.match(
    snapshot.providerIdempotencyIdentity,
    /^clawpilot:ups_rest:gaca0000001:[a-f0-9]{32}$/u,
  )
  assert.equal(
    'hashActiveCarrierDispatchSnapshotEvidence' in dispatchSnapshot,
    false,
  )

  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.carrierAttempt))
  assert.ok(Object.isFrozen(snapshot.carrierAccount))
  assert.ok(Object.isFrozen(
    snapshot.carrierAccount.allowedBillingRelationships,
  ))
  assert.ok(Object.isFrozen(snapshot.credential))
  assert.ok(Object.isFrozen(snapshot.billing))
  assert.ok(Object.isFrozen(snapshot.origin))
  assert.ok(Object.isFrozen(snapshot.destination))
  assert.ok(Object.isFrozen(snapshot.selectedRateEvidence))
  assert.ok(Object.isFrozen(snapshot.selectedRateEvidence.rerateRun))
  assert.ok(Object.isFrozen(snapshot.service))
  assert.ok(Object.isFrozen(snapshot.packages))
  assert.ok(Object.isFrozen(snapshot.packages[0]))
  assert.ok(Object.isFrozen(snapshot.packages[0].dimensionsMm))

  mutableDimensions.length = 999
  assert.equal(snapshot.packages[0].dimensionsMm.length, 279)
})

test('canonical normalization is deterministic and every bound authority changes the hash', () => {
  const baselineInput = validInput()
  const baseline = createActiveCarrierDispatchSnapshot(baselineInput)
  const reordered: ActiveCarrierDispatchSnapshotInput = {
    adapterVersion: baselineInput.adapterVersion,
    packages: baselineInput.packages,
    selectedRateEvidence: {
      ...baselineInput.selectedRateEvidence,
      completedAt: '2026-07-31T07:59:00-04:00',
      expiresAt: '2026-07-31T08:05:00-04:00',
      currency: 'usd',
      service: { name: '  UPS   Ground  ', code: '03' },
    },
    destination: baselineInput.destination,
    origin: {
      ...baselineInput.origin,
      line1: '  7009   S 108th St ',
      countryCode: 'us',
    },
    billing: {
      ...baselineInput.billing,
      payerCountryCode: 'us',
    },
    credential: baselineInput.credential,
    carrierAccount: {
      ...baselineInput.carrierAccount,
      allowedBillingRelationships: [
        'third_party',
        'recipient',
        'sender',
      ],
    },
    integrationAccount: baselineInput.integrationAccount,
    provider: baselineInput.provider,
    carrierAttempt: baselineInput.carrierAttempt,
    warehouse: baselineInput.warehouse,
    plan: baselineInput.plan,
    order: baselineInput.order,
    organization: baselineInput.organization,
    environment: baselineInput.environment,
    snapshotAt: '2026-07-31T08:00:00-04:00',
  }
  assert.equal(
    createActiveCarrierDispatchSnapshot(reordered).snapshotHash,
    baseline.snapshotHash,
  )

  const changedOrigin = {
    ...baselineInput.origin,
    line1: '7010 S 108th St',
  }
  const changedInputs: ActiveCarrierDispatchSnapshotInput[] = [
    {
      ...baselineInput,
      carrierAttempt: {
        id: '90909090-9090-4090-8090-909090909090',
        globalId: 'gaca0000002',
        attemptNumber: 2,
      },
    },
    {
      ...baselineInput,
      carrierAccount: {
        ...baselineInput.carrierAccount,
        configurationRevision: 5,
      },
    },
    {
      ...baselineInput,
      carrierAccount: {
        ...baselineInput.carrierAccount,
        allowedBillingRelationships: ['sender', 'recipient'],
      },
    },
    {
      ...baselineInput,
      origin: changedOrigin,
      carrierAccount: {
        ...baselineInput.carrierAccount,
        registeredOriginFingerprint: originFingerprint(changedOrigin),
      },
    },
    {
      ...baselineInput,
      selectedRateEvidence: {
        ...baselineInput.selectedRateEvidence,
        rerateResultHash: 'f'.repeat(64),
      },
    },
    {
      ...baselineInput,
      selectedRateEvidence: {
        ...baselineInput.selectedRateEvidence,
        id: 'abababab-abab-4aba-8aba-abababababab',
        globalId: 'gars0000002',
      },
    },
    {
      ...baselineInput,
      selectedRateEvidence: {
        ...baselineInput.selectedRateEvidence,
        rerateRun: {
          id: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
          globalId: 'gafr0000002',
        },
      },
    },
    {
      ...baselineInput,
      selectedRateEvidence: {
        ...baselineInput.selectedRateEvidence,
        requestHash: '0'.repeat(64),
      },
    },
    {
      ...baselineInput,
      selectedRateEvidence: {
        ...baselineInput.selectedRateEvidence,
        providerReference: 'ups-rate-000002',
      },
    },
    {
      ...baselineInput,
      selectedRateEvidence: {
        ...baselineInput.selectedRateEvidence,
        amountMinor: 1_963,
      },
    },
    {
      ...baselineInput,
      selectedRateEvidence: {
        ...baselineInput.selectedRateEvidence,
        expiresAt: '2026-07-31T12:06:00.000Z',
      },
    },
    {
      ...baselineInput,
      selectedRateEvidence: {
        ...baselineInput.selectedRateEvidence,
        currency: 'CAD',
      },
    },
    {
      ...baselineInput,
      selectedRateEvidence: {
        ...baselineInput.selectedRateEvidence,
        service: { code: '02', name: 'UPS 2nd Day Air' },
      },
    },
    {
      ...baselineInput,
      packages: [{
        ...baselineInput.packages[0],
        dimensionsMm: {
          ...baselineInput.packages[0].dimensionsMm,
          length: 280,
        },
      }, baselineInput.packages[1]],
    },
    {
      ...baselineInput,
      destination: {
        ...baselineInput.destination,
        postalCode: '92648',
      },
    },
    { ...baselineInput, adapterVersion: 'ups-rest-shipment-v2' },
  ]
  for (const input of changedInputs) {
    assert.notEqual(
      createActiveCarrierDispatchSnapshot(withDispatchBinding(input)).snapshotHash,
      baseline.snapshotHash,
    )
  }
})

test('derives one retry-stable provider identity from the immutable carrier attempt', () => {
  const input = validInput()
  const baseline = createActiveCarrierDispatchSnapshot(input)
  const retryWithRebuiltFacts = createActiveCarrierDispatchSnapshot(
    withDispatchBinding({
      ...input,
      origin: { ...input.origin },
      destination: { ...input.destination },
      packages: input.packages.map((entry) => ({
        ...entry,
        dimensionsMm: { ...entry.dimensionsMm },
      })),
    }),
  )
  assert.equal(
    retryWithRebuiltFacts.providerIdempotencyIdentity,
    baseline.providerIdempotencyIdentity,
  )

  const changedRequest = createActiveCarrierDispatchSnapshot(withDispatchBinding({
    ...input,
    destination: {
      ...input.destination,
      postalCode: '92648',
    },
  }))
  assert.notEqual(
    changedRequest.providerIdempotencyIdentity,
    baseline.providerIdempotencyIdentity,
  )
  assert.notEqual(changedRequest.snapshotHash, baseline.snapshotHash)

  const nextAttempt = createActiveCarrierDispatchSnapshot({
    ...input,
    carrierAttempt: {
      id: '90909090-9090-4090-8090-909090909090',
      globalId: 'gaca0000002',
      attemptNumber: 2,
    },
  })
  assert.notEqual(
    nextAttempt.providerIdempotencyIdentity,
    baseline.providerIdempotencyIdentity,
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      providerIdempotencyIdentity: 'caller-controlled-identity',
    } as ActiveCarrierDispatchSnapshotInput),
    'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
  )
})

test('requires one ordered set of 1-50 unique packages under the selected service', () => {
  const input = validInput()
  expectCode(
    () => createActiveCarrierDispatchSnapshot({ ...input, packages: [] }),
    'OPERATIONS_ACTIVE_DISPATCH_PACKAGE_COUNT_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      packages: [...input.packages].reverse(),
    }),
    'OPERATIONS_ACTIVE_DISPATCH_PACKAGE_ORDER_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      packages: [input.packages[0], {
        ...input.packages[1],
        packageId: input.packages[0].packageId,
      }],
    }),
    'OPERATIONS_ACTIVE_DISPATCH_PACKAGE_IDENTITY_INVALID',
  )

  const fiftyPackages = Array.from({ length: 50 }, (_, index) => {
    const number = index + 1
    return {
      packageId:
        `${String(number).padStart(8, '0')}-0000-4000-8000-${String(number).padStart(12, '0')}`,
      packageGlobalId: `gpa${String(number).padStart(7, '0')}`,
      packageNumber: number,
      dimensionsMm: { length: 100, width: 100, height: 100 },
      weightGrams: 100,
    }
  })
  assert.equal(createActiveCarrierDispatchSnapshot(withDispatchBinding({
    ...input,
    packages: fiftyPackages,
  })).packageCount, 50)
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      packages: [...fiftyPackages, {
        packageId: '51515151-5151-4515-8515-515151515151',
        packageGlobalId: 'gpa0000051',
        packageNumber: 51,
        dimensionsMm: { length: 100, width: 100, height: 100 },
        weightGrams: 100,
      }],
    }),
    'OPERATIONS_ACTIVE_DISPATCH_PACKAGE_COUNT_INVALID',
  )

  const snapshot = createActiveCarrierDispatchSnapshot(input)
  assert.equal(snapshot.service.name, 'UPS Ground')
  assert.ok(snapshot.packages.every((entry) => !('service' in entry)))
})

test('fails closed on stale account, origin, billing, and production rerate evidence', () => {
  const input = validInput()
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      destination: { ...input.destination, postalCode: '92648' },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_BINDING_MISMATCH',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      packages: [{
        ...input.packages[0],
        weightGrams: input.packages[0].weightGrams + 1,
      }, input.packages[1]],
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_BINDING_MISMATCH',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      order: {
        id: '12121212-1212-4212-8212-121212121212',
        globalId: 'gor0000002',
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_BINDING_MISMATCH',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      billing: { ...input.billing, payerPostalCode: '68129' },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      billing: {
        relationship: 'recipient',
        payerAccountNumberFingerprint: fingerprintC,
        payerCountryCode: 'US',
        payerPostalCode: '00000',
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      snapshotAt: '2026-02-31T12:00:00Z',
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      environment: 'sandbox' as 'production',
    }),
    'OPERATIONS_ACTIVE_DISPATCH_PRODUCTION_REQUIRED',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      carrierAccount: {
        ...input.carrierAccount,
        configurationRevision: 0,
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      origin: { ...input.origin, line1: 'Not the registered origin' },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_CARRIER_ACCOUNT_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      carrierAccount: {
        ...input.carrierAccount,
        allowedBillingRelationships: ['recipient', 'third_party'],
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      carrierAccount: {
        ...input.carrierAccount,
        allowedBillingRelationships: ['sender', 'sender'],
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_BILLING_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      selectedRateEvidence: {
        ...input.selectedRateEvidence,
        status: 'failed',
      } as unknown as ActiveCarrierDispatchSnapshotInput['selectedRateEvidence'],
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      selectedRateEvidence: {
        ...input.selectedRateEvidence,
        environment: 'sandbox',
      } as unknown as ActiveCarrierDispatchSnapshotInput['selectedRateEvidence'],
    }),
    'OPERATIONS_ACTIVE_DISPATCH_PRODUCTION_REQUIRED',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      selectedRateEvidence: {
        ...input.selectedRateEvidence,
        provider: 'fedex_rest',
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      selectedRateEvidence: {
        ...input.selectedRateEvidence,
        carrierAccountId: '67676767-6767-4676-8676-676767676767',
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      selectedRateEvidence: {
        ...input.selectedRateEvidence,
        credentialRevision: 8,
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      selectedRateEvidence: {
        ...input.selectedRateEvidence,
        expiresAt: input.snapshotAt,
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_EXPIRED',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      selectedRateEvidence: {
        ...input.selectedRateEvidence,
        completedAt: '2026-07-31T12:01:00.000Z',
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_EXPIRED',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      selectedRateEvidence: {
        ...input.selectedRateEvidence,
        currency: 'US',
      },
    }),
    'OPERATIONS_ACTIVE_DISPATCH_RATE_EVIDENCE_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      credential: {
        ...input.credential,
        clientSecret: 'must-not-enter-the-snapshot',
      },
    } as ActiveCarrierDispatchSnapshotInput),
    'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
  )
  expectCode(
    () => createActiveCarrierDispatchSnapshot({
      ...input,
      selectedRateEvidence: {
        ...input.selectedRateEvidence,
        rawProviderResponse: { secret: true },
      },
    } as ActiveCarrierDispatchSnapshotInput),
    'OPERATIONS_ACTIVE_DISPATCH_SNAPSHOT_INVALID',
  )
})
