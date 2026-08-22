import { createHash } from 'node:crypto'
import {
  assertCarrierRateTestArtifactCapability,
  carrierSandboxRateSelectionRequestHash,
  resolveCarrierOneOffVoidRuntime,
  resolveCarrierProductionShippingRuntime,
  resolveCarrierSandboxShippingRuntime,
  sanitizedCarrierIntegrationError,
} from '@/lib/integrations/carrierIntegrations'
import {
  CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
  CarrierSandboxLabelError,
  carrierSandboxLabelLifecycleMode,
  createCarrierSandboxLabel,
  voidCarrierSandboxLabel,
  type CarrierLabelOutputFormat,
} from '@/lib/integrations/carrierSandboxLabel'
import {
  CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
  CarrierOneOffGroupError,
  executeCarrierOneOffGroupShipment,
  executeCarrierOneOffGroupVoid,
  prepareCarrierOneOffGroupRequest,
  prepareCarrierOneOffGroupVoidRequest,
  type CarrierOneOffGroupRuntime,
  type CarrierOneOffGroupShipmentFixture,
} from '@/lib/integrations/carrierOneOffGroupShipment'
import {
  carrierWholeShipmentRateAddressFingerprints,
  prepareCarrierWholeShipmentRateRequest,
} from '@/lib/integrations/carrierWholeShipmentRateFoundation'
import type { CarrierShippingDiagnosticParcel } from '@/lib/integrations/carrierShippingDiagnosticRate'
import {
  buildCarrierSandboxRateFixture,
  carrierSandboxPartyFingerprint,
  carrierSandboxRateRequestEvidence,
  normalizeCarrierSandboxParty,
  type CarrierSandboxParty,
} from '@/lib/integrations/carrierSandboxRate'
import {
  carrierRateTestLabelFingerprint,
  closeCarrierRateTestSampleLabelInPostgres,
  finalizeCarrierRateTestLabelAttemptFailureInPostgres,
  finalizeCarrierRateTestLabelCreateInPostgres,
  finalizeCarrierRateTestLabelVoidInPostgres,
  listCarrierRateTestLabelAttemptsInPostgres,
  listCarrierRateTestLabelsInPostgres,
  prepareCarrierRateTestLabelCreateInPostgres,
  prepareCarrierRateTestLabelVoidInPostgres,
  queueCarrierRateTestLabelPrintInPostgres,
  readCarrierRateTestCreateContextInPostgres,
  readCarrierRateTestLabelProviderContextInPostgres,
  reconcileCarrierRateTestLabelAttemptInPostgres,
  replayCarrierRateTestLabelVoidInPostgres,
  type CarrierRateTestCreateContext,
  type CarrierRateTestLabelProviderContext,
  type CarrierRateTestSelectedRate,
} from '@/lib/persistence/carrierRateTestLabels'
import { OperationsRequestError } from '@/lib/persistence/operations'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function strictBase64Bytes(value: string) {
  const encoded = String(value || '').replace(/\s+/g, '')
  const unpadded = encoded.replace(/=+$/, '')
  if (
    !encoded
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || encoded.length % 4 === 1
    || (encoded.includes('=') && encoded.length % 4 !== 0)
  ) return null
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  const bytes = Buffer.from(padded, 'base64')
  return (
    bytes.length > 0
    && bytes.toString('base64').replace(/=+$/, '') === unpadded
  ) ? bytes : null
}

function contentHash(value: Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function carrierActionError(error: unknown) {
  if (error instanceof OperationsRequestError) return error
  if (error instanceof CarrierSandboxLabelError) {
    return new OperationsRequestError(error.code, error.message, error.status)
  }
  if (error instanceof CarrierOneOffGroupError) {
    return new OperationsRequestError(error.code, error.message, error.status)
  }
  const sanitized = sanitizedCarrierIntegrationError(error)
  return new OperationsRequestError(
    sanitized.code,
    sanitized.message,
    sanitized.status,
  )
}

function failureDetail(error: unknown) {
  if (error instanceof OperationsRequestError) {
    return {
      state: 'failed' as const,
      code: error.code,
      providerReference: null,
      response: {},
    }
  }
  if (error instanceof CarrierSandboxLabelError) {
    return {
      state: error.uncertain ? 'unknown' as const : 'failed' as const,
      code: error.code,
      providerReference: null,
      response: error.redactedResponse || {},
    }
  }
  if (error instanceof CarrierOneOffGroupError) {
    return {
      state: error.uncertain ? 'unknown' as const : 'failed' as const,
      code: error.code,
      providerReference: null,
      response: error.redactedResponse,
    }
  }
  const sanitized = sanitizedCarrierIntegrationError(error)
  return {
    state: 'failed' as const,
    code: sanitized.code,
    providerReference: null,
    response: {},
  }
}

async function finalizePreparedFailure(input: {
  organizationId: string
  actorEmail: string
  attemptGlobalId: string
  error: unknown
}) {
  const detail = failureDetail(input.error)
  try {
    await finalizeCarrierRateTestLabelAttemptFailureInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: input.attemptGlobalId,
      state: detail.state,
      errorCode: detail.code,
      providerReference: detail.providerReference,
      redactedResponse: detail.response,
    })
  } catch {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_RECONCILIATION_REQUIRED',
      'The carrier action failed, but its durable attempt could not be finalized; reconcile before retrying',
      503,
    )
  }
}

function selectionMismatch(): never {
  throw new OperationsRequestError(
    'CARRIER_RATE_TEST_SELECTION_MISMATCH',
    'Select one exact rate returned by the current account rating result',
    409,
  )
}

function exactSelectedRate(
  context: CarrierRateTestCreateContext,
  requested: CarrierRateTestSelectedRate,
) {
  const rates = Array.isArray(context.redactedResponse.rates)
    ? context.redactedResponse.rates
    : []
  for (const value of rates) {
    const rate = record(value)
    const canonical: CarrierRateTestSelectedRate = {
      serviceCode: typeof rate.serviceCode === 'string' ? rate.serviceCode : '',
      serviceName: typeof rate.serviceName === 'string' ? rate.serviceName : '',
      rateType: rate.rateType === null
        ? null
        : typeof rate.rateType === 'string'
          ? rate.rateType
          : null,
      amount: typeof rate.amount === 'string' ? rate.amount : '',
      currency: typeof rate.currency === 'string' ? rate.currency : '',
    }
    if (
      canonical.serviceCode === requested.serviceCode
      && canonical.serviceName === requested.serviceName
      && canonical.rateType === requested.rateType
      && canonical.amount === requested.amount
      && canonical.currency === requested.currency
    ) {
      return canonical
    }
  }
  return selectionMismatch()
}

export function carrierProductionDiagnosticConfirmation(input: {
  provider: 'ups_rest' | 'fedex_rest'
  carrierAccountGlobalId: string
  selectedRate: CarrierRateTestSelectedRate
}) {
  const provider = input.provider === 'ups_rest' ? 'UPS' : 'FEDEX'
  return [
    'BUY REAL POSTAGE',
    provider,
    input.carrierAccountGlobalId,
    input.selectedRate.serviceCode,
    `${input.selectedRate.currency} ${input.selectedRate.amount}`,
  ].join(' | ')
}

function assertFreshProductionRate(context: CarrierRateTestCreateContext) {
  const ageMs = Date.now() - Date.parse(context.completedAt)
  if (!Number.isFinite(ageMs) || ageMs < -60_000 || ageMs > 10 * 60 * 1000) {
    throw new OperationsRequestError(
      'CARRIER_PRODUCTION_RATE_EXPIRED',
      'Run a new LIVE rate before buying real postage; production diagnostic rates expire after ten minutes',
      409,
    )
  }
}

function stableAttemptCorrelationKey(input: {
  organizationId: string
  idempotencyKey: string
  action: 'create' | 'void'
}) {
  return createHash('sha256')
    .update([
      'carrier-shipping-diagnostic-v1',
      input.organizationId,
      input.action,
      input.idempotencyKey,
    ].join(':'))
    .digest('hex')
}

function productionBillingSnapshot(runtime: {
  integrationGlobalId: string
  carrierAccountGlobalId: string
  carrierAccountDisplayName?: string
  accountNumberLastFour?: string
  accountNumberFingerprint?: string
  credentialFingerprint?: string
  registeredAddressFingerprint?: string
  senderName?: string
}) {
  return {
    mode: 'explicit_shipping_account_diagnostic',
    integrationAccountGlobalId: runtime.integrationGlobalId,
    carrierAccountGlobalId: runtime.carrierAccountGlobalId,
    carrierAccountDisplayName: runtime.carrierAccountDisplayName || null,
    accountNumberLastFour: runtime.accountNumberLastFour || null,
    accountNumberFingerprint: runtime.accountNumberFingerprint || null,
    credentialFingerprint: runtime.credentialFingerprint || null,
    registeredAddressFingerprint: runtime.registeredAddressFingerprint || null,
    senderName: runtime.senderName || null,
    billingRelationship: 'sender',
  }
}

function persistedShipmentEvidence(context: CarrierRateTestCreateContext) {
  return record(record(context.redactedRequest).shipment)
}

function assertDestinationMatchesRate(
  context: CarrierRateTestCreateContext,
  destinationFingerprint: string,
) {
  if (
    persistedShipmentEvidence(context).destinationFingerprint
    !== destinationFingerprint
  ) {
    selectionMismatch()
  }
}

function selectionMode(
  value: unknown,
): 'explicit' | 'single_active_account' {
  if (value === 'explicit' || value === 'single_active_account') return value
  throw new OperationsRequestError(
    'CARRIER_RATE_TEST_CONTEXT_CHANGED',
    'The stored rating context is incomplete; run a new sandbox rate',
    409,
  )
}

function assertRuntimeMatches(input: {
  runtime: Awaited<ReturnType<typeof resolveCarrierSandboxShippingRuntime>>
  expected: {
    provider: 'ups_rest' | 'fedex_rest'
    integrationAccountId: string
    integrationGlobalId: string
    carrierAccountId: string
    carrierAccountGlobalId: string
    credentialVersion: number
    billingRelationship?: 'sender' | 'recipient' | 'third_party'
  }
  enforceCredentialVersion?: boolean
}) {
  const { runtime, expected } = input
  if (
    runtime.provider !== expected.provider
    || runtime.integrationAccountId !== expected.integrationAccountId
    || runtime.integrationGlobalId !== expected.integrationGlobalId
    || runtime.carrierAccountId !== expected.carrierAccountId
    || runtime.carrierAccountGlobalId !== expected.carrierAccountGlobalId
    || (
      input.enforceCredentialVersion !== false
      && runtime.credentialVersion !== expected.credentialVersion
    )
    || (
      expected.billingRelationship
      && runtime.billingRelationship !== expected.billingRelationship
    )
  ) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_CONTEXT_CHANGED',
      'The carrier credential or billing account changed; run a new sandbox rate before continuing',
      409,
    )
  }
}

function createFixtureAndVerifyContext(input: {
  context: CarrierRateTestCreateContext
  destination: CarrierSandboxParty
  parcel?: CarrierShippingDiagnosticParcel
  runtime: Awaited<ReturnType<typeof resolveCarrierSandboxShippingRuntime>>
}) {
  const { context, runtime } = input
  const currentSnapshot = record(runtime.billingSelectionSnapshot)
  const storedSnapshot = record(context.billingSelectionSnapshot)
  selectionMode(currentSnapshot.selectionMode)
  const storedMode = selectionMode(storedSnapshot.selectionMode)
  if (
    context.billingRelationship !== 'sender'
    || runtime.billingRelationship !== 'sender'
    || storedSnapshot.carrierAccountGlobalId !== runtime.carrierAccountGlobalId
    || storedSnapshot.registeredAddressFingerprint
      !== currentSnapshot.registeredAddressFingerprint
  ) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_CONTEXT_CHANGED',
      'The carrier account or sender address changed; run a new sandbox rate before continuing',
      409,
    )
  }
  const senderName = typeof currentSnapshot.senderName === 'string'
    ? currentSnapshot.senderName
    : ''
  const registeredAddress = record(currentSnapshot.registeredAddress)
  const fixture = buildCarrierSandboxRateFixture({
    senderName,
    registeredAddress: {
      line1: String(registeredAddress.line1 || ''),
      line2: typeof registeredAddress.line2 === 'string'
        ? registeredAddress.line2
        : null,
      city: String(registeredAddress.city || ''),
      region: String(registeredAddress.region || ''),
      postalCode: String(registeredAddress.postalCode || ''),
      countryCode: String(registeredAddress.countryCode || ''),
    },
    destination: input.destination,
    ...(input.parcel ? { parcel: input.parcel } : {}),
  })
  const safeRateRequest = carrierSandboxRateRequestEvidence(
    context.provider,
    fixture,
  )
  const shipmentEvidence = persistedShipmentEvidence(context)
  const currentShipmentEvidence = record(safeRateRequest.redactedRequest.shipment)
  const currentSelectionHash = carrierSandboxRateSelectionRequestHash(
    safeRateRequest.requestHash,
    {
      account: {
        globalId: runtime.carrierAccountGlobalId,
        accountNumberFingerprint: runtime.accountNumberFingerprint,
      },
      relationship: runtime.billingRelationship,
      mode: storedMode,
    },
  )
  if (
    shipmentEvidence.originFingerprint
      !== currentShipmentEvidence.originFingerprint
    || shipmentEvidence.destinationFingerprint
      !== currentShipmentEvidence.destinationFingerprint
    || context.requestHash !== currentSelectionHash
  ) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_CONTEXT_CHANGED',
      'The stored rate no longer matches the current shipment and billing context; run a new sandbox rate',
      409,
    )
  }
  return fixture
}

async function resolveVerifiedLabelRuntime(input: {
  organizationId: string
  context: CarrierRateTestCreateContext
  destination: CarrierSandboxParty
  parcel?: CarrierShippingDiagnosticParcel
}) {
  const runtime = await resolveCarrierSandboxShippingRuntime({
    organizationId: input.organizationId,
    provider: input.context.provider,
    carrierAccountGlobalId: input.context.carrierAccountGlobalId,
    senderBillingOnly: true,
  })
  assertRuntimeMatches({ runtime, expected: input.context })
  return {
    runtime,
    shipmentFixture: createFixtureAndVerifyContext({
      context: input.context,
      destination: input.destination,
      parcel: input.parcel,
      runtime,
    }),
  }
}

function assertProductionRuntimeMatches(input: {
  runtime: Awaited<ReturnType<typeof resolveCarrierProductionShippingRuntime>>
  context: CarrierRateTestCreateContext
}) {
  const { runtime, context } = input
  const snapshot = record(context.billingSelectionSnapshot)
  if (
    context.environment !== 'production'
    || context.purpose !== 'shipping_account_diagnostic'
    || context.billingRelationship !== 'sender'
    || runtime.provider !== context.provider
    || runtime.integrationAccountId !== context.integrationAccountId
    || runtime.integrationGlobalId !== context.integrationGlobalId
    || runtime.carrierAccountId !== context.carrierAccountId
    || runtime.carrierAccountGlobalId !== context.carrierAccountGlobalId
    || runtime.credentialVersion !== context.credentialVersion
    || snapshot.integrationAccountGlobalId !== runtime.integrationGlobalId
    || snapshot.carrierAccountGlobalId !== runtime.carrierAccountGlobalId
    || snapshot.accountNumberFingerprint
      !== runtime.accountNumberFingerprint
    || snapshot.credentialFingerprint !== runtime.credentialFingerprint
    || snapshot.registeredAddressFingerprint
      !== runtime.registeredAddressFingerprint
    || snapshot.senderName !== runtime.senderName
  ) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_CONTEXT_CHANGED',
      'The LIVE credential, sender account, or registered address changed; run a new production rate',
      409,
    )
  }
}

function productionDiagnosticPrepared(input: {
  organizationId: string
  idempotencyKey: string
  context: CarrierRateTestCreateContext
  selectedRate: CarrierRateTestSelectedRate
  destination: CarrierSandboxParty
  destinationResidential: boolean
  parcel: CarrierShippingDiagnosticParcel
  shipFromPhone: string
  shipToPhone: string
  outputFormat: CarrierLabelOutputFormat
  runtime: Awaited<ReturnType<typeof resolveCarrierProductionShippingRuntime>>
  shipDate: string
}) {
  assertProductionRuntimeMatches({ runtime: input.runtime, context: input.context })
  const destination = {
    ...input.destination,
    residential: input.destinationResidential,
  }
  const ratePrepared = prepareCarrierWholeShipmentRateRequest({
    binding: {
      organizationId: input.runtime.organizationId,
      integrationAccountId: input.runtime.integrationAccountId,
      carrierAccountId: input.runtime.carrierAccountId,
      credentialRevision: input.runtime.credentialVersion,
      credentialFingerprint: input.runtime.credentialFingerprint,
      accountNumber: input.runtime.credential.accountNumber,
      accountNumberFingerprint: input.runtime.accountNumberFingerprint,
      provider: input.runtime.provider,
      environment: 'production',
    },
    origin: {
      name: input.runtime.senderName,
      phone: null,
      ...input.runtime.registeredAddress,
      countryCode: 'US',
      residential: null,
    },
    destination: {
      ...destination,
      residential: input.destinationResidential,
    },
    parcels: [{
      ...input.parcel,
      packageCode: input.runtime.provider === 'ups_rest'
        ? '02'
        : 'YOUR_PACKAGING',
    }],
    billing: {
      relationship: 'sender',
      payerAccountNumber: input.runtime.credential.accountNumber,
      payerAccountNumberFingerprint: input.runtime.accountNumberFingerprint,
      payerPostalCode: input.runtime.registeredAddress.postalCode,
      payerCountryCode: 'US',
    },
    expectedCurrency: 'USD',
    fedexPickupType: input.runtime.provider === 'fedex_rest'
      ? 'DROPOFF_AT_FEDEX_LOCATION'
      : null,
  })
  const fingerprints = carrierWholeShipmentRateAddressFingerprints({
    origin: {
      name: input.runtime.senderName,
      phone: null,
      ...input.runtime.registeredAddress,
      countryCode: 'US',
      residential: null,
    },
    destination: {
      ...destination,
      residential: input.destinationResidential,
    },
  })
  if (
    ratePrepared.requestHash !== input.context.requestHash
    || fingerprints.destinationFingerprint
      !== persistedShipmentEvidence(input.context).destinationFingerprint
  ) {
    selectionMismatch()
  }
  const shipmentFixture: CarrierOneOffGroupShipmentFixture = {
    origin: {
      name: input.runtime.senderName,
      line1: input.runtime.registeredAddress.line1,
      line2: input.runtime.registeredAddress.line2,
      city: input.runtime.registeredAddress.city,
      region: input.runtime.registeredAddress.region,
      postalCode: input.runtime.registeredAddress.postalCode,
      countryCode: 'US',
    },
    destination,
    parcels: [{
      ...input.parcel,
      packageKey: 'shipping-settings-diagnostic-package-1',
      packageNumber: 1,
    }],
  }
  const runtime: CarrierOneOffGroupRuntime = {
    provider: input.runtime.provider,
    environment: 'production',
    credential: input.runtime.credential,
    integrationAccountGlobalId: input.runtime.integrationGlobalId,
    carrierAccountGlobalId: input.runtime.carrierAccountGlobalId,
    credentialVersion: input.runtime.credentialVersion,
    credentialFingerprint: input.runtime.credentialFingerprint,
    accountNumberFingerprint: input.runtime.accountNumberFingerprint,
    billingRelationship: 'sender',
    billingSelectionSnapshot: productionBillingSnapshot(input.runtime),
  }
  const providerPrepared = prepareCarrierOneOffGroupRequest({
    runtime,
    serviceCode: input.selectedRate.serviceCode,
    shipmentFixture,
    outputFormat: input.outputFormat,
    shipFromPhone: input.shipFromPhone,
    shipToPhone: input.shipToPhone,
    shipDate: input.shipDate,
    attemptCorrelationKey: stableAttemptCorrelationKey({
      organizationId: input.organizationId,
      action: 'create',
      idempotencyKey: input.idempotencyKey,
    }),
  })
  return { runtime, providerPrepared }
}

async function createCarrierProductionDiagnosticLabel(input: {
  organizationId: string
  actorEmail: string
  rateEvidenceGlobalId: string
  selectedRate: CarrierRateTestSelectedRate
  destination: CarrierSandboxParty
  destinationResidential: boolean
  parcel?: CarrierShippingDiagnosticParcel
  shipFromPhone: string
  shipToPhone: string
  outputFormat: CarrierLabelOutputFormat
  reason: string
  idempotencyKey: string
  operatorConfirmation: string
  productionAuthorizedByOwnerAdmin: boolean
  productionLivePostageAuthorized: boolean
  context: CarrierRateTestCreateContext
}) {
  if (!input.parcel) {
    throw new OperationsRequestError(
      'CARRIER_PRODUCTION_DIAGNOSTIC_PARCEL_REQUIRED',
      'Enter the exact LIVE diagnostic parcel before buying postage',
      400,
    )
  }
  if (!input.productionAuthorizedByOwnerAdmin) {
    throw new OperationsRequestError(
      'CARRIER_PRODUCTION_LABEL_AUTHORIZATION_FORBIDDEN',
      'Organization owner or administrator access is required to buy REAL POSTAGE',
      403,
    )
  }
  if (!input.productionLivePostageAuthorized) {
    throw new OperationsRequestError(
      'CARRIER_PRODUCTION_LABEL_AUTHORIZATION_FORBIDDEN',
      'Live-postage permission is required to buy REAL POSTAGE',
      403,
    )
  }
  assertFreshProductionRate(input.context)
  const expectedConfirmation = carrierProductionDiagnosticConfirmation({
    provider: input.context.provider,
    carrierAccountGlobalId: input.context.carrierAccountGlobalId,
    selectedRate: input.selectedRate,
  })
  if (input.operatorConfirmation !== expectedConfirmation) {
    throw new OperationsRequestError(
      'CARRIER_PRODUCTION_LABEL_CONFIRMATION_REQUIRED',
      `Type exactly: ${expectedConfirmation}`,
      400,
    )
  }
  const shipDate = new Date().toISOString().slice(0, 10)
  let runtime: Awaited<ReturnType<typeof resolveCarrierProductionShippingRuntime>>
  let preparedProvider: ReturnType<typeof productionDiagnosticPrepared>
  try {
    runtime = await resolveCarrierProductionShippingRuntime({
      organizationId: input.organizationId,
      provider: input.context.provider,
      integrationAccountGlobalId: input.context.integrationGlobalId,
      carrierAccountGlobalId: input.context.carrierAccountGlobalId,
    })
    preparedProvider = productionDiagnosticPrepared({
      ...input,
      parcel: input.parcel,
      runtime,
      shipDate,
    })
  } catch (error) {
    throw carrierActionError(error)
  }
  const destinationFingerprint = String(
    persistedShipmentEvidence(input.context).destinationFingerprint || '',
  )
  const attemptRequestHash = carrierRateTestLabelFingerprint({
    action: 'create',
    environment: 'production',
    rateEvidenceGlobalId: input.context.rateEvidenceGlobalId,
    rateRequestHash: input.context.requestHash,
    carrierAccountGlobalId: input.context.carrierAccountGlobalId,
    credentialVersion: input.context.credentialVersion,
    selectedRate: input.selectedRate,
    destinationFingerprint,
    outputFormat: input.outputFormat,
    providerPreparedRequestHash: preparedProvider.providerPrepared.requestHash,
    operatorConfirmation: input.operatorConfirmation,
    adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
    reason: input.reason,
  })
  const prepared = await prepareCarrierRateTestLabelCreateInPostgres({
    ...input.context,
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    attemptRequestHash,
    destinationFingerprint,
    selectedRate: input.selectedRate,
    outputFormat: input.outputFormat,
    adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
    preparedProviderEvidence: preparedProvider.providerPrepared.redactedRequest,
    operatorConfirmation: input.operatorConfirmation,
  })
  if (prepared.disposition === 'replayed') return prepared.label

  try {
    runtime = await resolveCarrierProductionShippingRuntime({
      organizationId: input.organizationId,
      provider: input.context.provider,
      integrationAccountGlobalId: input.context.integrationGlobalId,
      carrierAccountGlobalId: input.context.carrierAccountGlobalId,
    })
    const verified = productionDiagnosticPrepared({
      ...input,
      parcel: input.parcel,
      runtime,
      shipDate,
    })
    if (
      verified.providerPrepared.requestHash
        !== preparedProvider.providerPrepared.requestHash
    ) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_CONTEXT_CHANGED',
        'The LIVE provider request changed after authorization; run a new rate',
        409,
      )
    }
    preparedProvider = verified
  } catch (error) {
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }

  let result: Awaited<ReturnType<typeof executeCarrierOneOffGroupShipment>>
  try {
    result = await executeCarrierOneOffGroupShipment({
      runtime: preparedProvider.runtime,
      prepared: preparedProvider.providerPrepared,
    })
  } catch (error) {
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }
  const label = result.labels[0]
  if (
    result.environment !== 'production'
    || result.lifecycleMode !== 'carrier_void'
    || result.labels.length !== 1
    || !label
  ) {
    const error = new CarrierOneOffGroupError(
      'The production carrier returned an invalid diagnostic label result',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
      result.evidence.redactedResponse,
    )
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }
  const bytes = label.payloadEncoding === 'utf8'
    ? Buffer.from(label.labelPayload, 'utf8')
    : strictBase64Bytes(label.labelPayload)
  if (
    !bytes
    || bytes.byteLength !== label.labelByteLength
    || contentHash(bytes) !== label.labelContentSha256
  ) {
    const error = new CarrierOneOffGroupError(
      'The production carrier label failed decoded-byte integrity validation',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
      result.evidence.redactedResponse,
    )
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }
  try {
    return await finalizeCarrierRateTestLabelCreateInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      accountNumberFingerprint: runtime.accountNumberFingerprint,
      providerLabelId: result.providerShipmentId,
      trackingNumber: label.trackingNumber,
      format: label.format,
      mediaSize: 'label_4x6',
      sourceKind: 'provider_native',
      providerImageType: label.providerImageType as 'ZPL' | 'ZPLII' | 'PDF' | 'PNG',
      providerStockType: label.providerStockType as
        | 'HEIGHT_6_WIDTH_4' | 'STOCK_4X6' | 'PAPER_4X6',
      labelPayload: bytes,
      contentSha256: label.labelContentSha256,
      providerReference: result.evidence.providerReference,
      redactedProviderEvidence: {
        adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
        provider: result.provider,
        environment: result.environment,
        quotedCharge: result.quotedCharge,
        request: result.evidence.redactedRequest,
        response: result.evidence.redactedResponse,
      },
    })
  } catch {
    await finalizeCarrierRateTestLabelAttemptFailureInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      state: 'unknown',
      errorCode: 'CARRIER_RATE_TEST_FINALIZATION_UNKNOWN',
      providerReference: result.evidence.providerReference,
      redactedResponse: result.evidence.redactedResponse,
    }).catch(() => undefined)
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_RECONCILIATION_REQUIRED',
      'The carrier bought real postage, but ClawPilot could not finalize it; reconcile before any retry',
      503,
    )
  }
}

export async function createCarrierRateTestLabel(input: {
  organizationId: string
  actorEmail: string
  rateEvidenceGlobalId: string
  selectedRate: CarrierRateTestSelectedRate
  destination: CarrierSandboxParty
  destinationResidential?: boolean
  parcel?: CarrierShippingDiagnosticParcel
  shipFromPhone?: string
  shipToPhone?: string
  operatorConfirmation?: string
  productionAuthorizedByOwnerAdmin?: boolean
  productionLivePostageAuthorized?: boolean
  outputFormat: CarrierLabelOutputFormat
  reason: string
  idempotencyKey: string
}) {
  const context = await readCarrierRateTestCreateContextInPostgres({
    organizationId: input.organizationId,
    rateEvidenceGlobalId: input.rateEvidenceGlobalId,
  })
  const selectedRate = exactSelectedRate(context, input.selectedRate)
  const destination = normalizeCarrierSandboxParty(input.destination)
  if (context.environment === 'production') {
    return createCarrierProductionDiagnosticLabel({
      ...input,
      context,
      selectedRate,
      destination,
      destinationResidential: input.destinationResidential === true,
      parcel: input.parcel,
      shipFromPhone: input.shipFromPhone || '',
      shipToPhone: input.shipToPhone || '',
      operatorConfirmation: input.operatorConfirmation || '',
      productionAuthorizedByOwnerAdmin:
        input.productionAuthorizedByOwnerAdmin === true,
      productionLivePostageAuthorized:
        input.productionLivePostageAuthorized === true,
    })
  }
  const destinationFingerprint = carrierSandboxPartyFingerprint(destination)
  assertDestinationMatchesRate(context, destinationFingerprint)
  try {
    await resolveVerifiedLabelRuntime({
      organizationId: input.organizationId,
      context,
      destination,
      parcel: input.parcel,
    })
  } catch (error) {
    throw carrierActionError(error)
  }
  const attemptRequestHash = carrierRateTestLabelFingerprint({
    action: 'create',
    rateEvidenceGlobalId: context.rateEvidenceGlobalId,
    rateRequestHash: context.requestHash,
    carrierAccountGlobalId: context.carrierAccountGlobalId,
    credentialVersion: context.credentialVersion,
    selectedRate,
    destinationFingerprint,
    outputFormat: input.outputFormat,
    adapterVersion: CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
    operatorConfirmation: null,
    reason: input.reason,
  })
  const prepared = await prepareCarrierRateTestLabelCreateInPostgres({
    ...context,
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    attemptRequestHash,
    destinationFingerprint,
    selectedRate,
    outputFormat: input.outputFormat,
    adapterVersion: CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
  })
  if (prepared.disposition === 'replayed') return prepared.label

  let runtime: Awaited<ReturnType<typeof resolveCarrierSandboxShippingRuntime>>
  let shipmentFixture: ReturnType<typeof buildCarrierSandboxRateFixture>
  try {
    const verified = await resolveVerifiedLabelRuntime({
      organizationId: input.organizationId,
      context,
      destination,
      parcel: input.parcel,
    })
    runtime = verified.runtime
    shipmentFixture = verified.shipmentFixture
  } catch (error) {
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }

  let result: Awaited<ReturnType<typeof createCarrierSandboxLabel>>
  try {
    result = await createCarrierSandboxLabel({
      ...runtime,
      serviceCode: selectedRate.serviceCode,
      shipmentFixture,
      outputFormat: input.outputFormat,
    })
  } catch (error) {
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }

  const bytes = result.payloadEncoding === 'utf8'
    ? Buffer.from(result.labelPayload, 'utf8')
    : strictBase64Bytes(result.labelPayload)
  if (
    !bytes
    || bytes.byteLength !== result.labelByteLength
    || contentHash(bytes) !== result.labelContentSha256
  ) {
    const error = new CarrierSandboxLabelError(
      'The carrier label failed decoded-byte integrity validation',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }

  try {
    return await finalizeCarrierRateTestLabelCreateInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      accountNumberFingerprint: runtime.accountNumberFingerprint,
      providerLabelId: result.providerLabelId,
      trackingNumber: result.trackingNumber,
      format: result.format,
      mediaSize: result.mediaSize,
      sourceKind: result.sourceKind,
      providerImageType: result.providerImageType,
      providerStockType: result.providerStockType,
      labelPayload: bytes,
      contentSha256: result.labelContentSha256,
      providerReference: result.evidence.providerReference,
      redactedProviderEvidence: {
        adapterVersion: CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
        provider: result.provider,
        request: result.evidence.redactedRequest,
        response: result.evidence.redactedResponse,
      },
    })
  } catch {
    await finalizeCarrierRateTestLabelAttemptFailureInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      state: 'unknown',
      errorCode: 'CARRIER_RATE_TEST_FINALIZATION_UNKNOWN',
      providerReference: result.evidence.providerReference,
      redactedResponse: result.evidence.redactedResponse,
    }).catch(() => undefined)
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_RECONCILIATION_REQUIRED',
      'The carrier created a label, but ClawPilot could not finalize it; reconcile the attempt before retrying',
      503,
    )
  }
}

export async function voidCarrierRateTestLabel(input: {
  organizationId: string
  actorEmail: string
  labelGlobalId: string
  reason: string
  idempotencyKey: string
}) {
  const label = await readCarrierRateTestLabelProviderContextInPostgres({
    organizationId: input.organizationId,
    labelGlobalId: input.labelGlobalId,
  })
  if (label.environment === 'production') {
    return voidCarrierProductionDiagnosticLabel({ ...input, label })
  }
  try {
    await assertCarrierRateTestArtifactCapability({
      organizationId: input.organizationId,
      integrationAccountId: label.integrationAccountId,
      provider: label.provider,
    })
  } catch (error) {
    throw carrierActionError(error)
  }
  if (
    carrierSandboxLabelLifecycleMode(
      label.provider,
      label.trackingNumber,
    ) === 'close_sample'
  ) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_SAMPLE_CLOSE_REQUIRED',
      'UPS CIE returned printable sample media without an active carrier shipment. Use Close UPS sample; no carrier void call is required.',
      409,
    )
  }
  const attemptRequestHash = carrierRateTestLabelFingerprint({
    action: 'void',
    labelGlobalId: label.labelGlobalId,
    rateEvidenceGlobalId: label.rateEvidenceGlobalId,
    carrierAccountGlobalId: label.carrierAccountGlobalId,
    providerLabelId: label.providerLabelId,
    trackingNumber: label.trackingNumber,
    adapterVersion: CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
    reason: input.reason,
  })
  const replay = await replayCarrierRateTestLabelVoidInPostgres({
    organizationId: input.organizationId,
    labelGlobalId: label.labelGlobalId,
    idempotencyKey: input.idempotencyKey,
    attemptRequestHash,
  })
  if (replay) return replay
  let runtime: Awaited<ReturnType<typeof resolveCarrierSandboxShippingRuntime>>
  try {
    runtime = await resolveCarrierSandboxShippingRuntime({
      organizationId: input.organizationId,
      provider: label.provider,
      carrierAccountGlobalId: label.carrierAccountGlobalId,
      senderBillingOnly: true,
    })
    assertRuntimeMatches({
      runtime,
      expected: label,
      enforceCredentialVersion: false,
    })
    if (runtime.accountNumberFingerprint !== label.accountNumberFingerprint) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_CONTEXT_CHANGED',
        'The carrier account number changed; reconcile the test label before voiding',
        409,
      )
    }
  } catch (error) {
    throw carrierActionError(error)
  }
  const prepared = await prepareCarrierRateTestLabelVoidInPostgres({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    label,
    credentialVersion: runtime.credentialVersion,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    attemptRequestHash,
    adapterVersion: CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
  })
  if (prepared.disposition === 'replayed') return prepared.label

  let result: Awaited<ReturnType<typeof voidCarrierSandboxLabel>>
  try {
    result = await voidCarrierSandboxLabel({
      ...runtime,
      trackingNumber: label.trackingNumber,
      providerReference: label.providerLabelId,
    })
  } catch (error) {
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }

  try {
    return await finalizeCarrierRateTestLabelVoidInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      providerReference: result.evidence.providerReference,
      redactedResponse: result.evidence.redactedResponse,
    })
  } catch {
    await finalizeCarrierRateTestLabelAttemptFailureInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      state: 'unknown',
      errorCode: 'CARRIER_RATE_TEST_VOID_FINALIZATION_UNKNOWN',
      providerReference: result.evidence.providerReference,
      redactedResponse: result.evidence.redactedResponse,
    }).catch(() => undefined)
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_RECONCILIATION_REQUIRED',
      'The carrier voided the label, but ClawPilot could not finalize it; reconcile before retrying',
      503,
    )
  }
}

async function voidCarrierProductionDiagnosticLabel(input: {
  organizationId: string
  actorEmail: string
  labelGlobalId: string
  reason: string
  idempotencyKey: string
  label: CarrierRateTestLabelProviderContext
}) {
  const buildPrepared = async () => {
    const resolved = await resolveCarrierOneOffVoidRuntime({
      organizationId: input.organizationId,
      provider: input.label.provider,
      environment: 'production',
      integrationAccountGlobalId: input.label.integrationGlobalId,
      carrierAccountGlobalId: input.label.carrierAccountGlobalId,
    })
    if (
      resolved.environment !== 'production'
      || resolved.integrationAccountId !== input.label.integrationAccountId
      || resolved.integrationGlobalId !== input.label.integrationGlobalId
      || resolved.carrierAccountId !== input.label.carrierAccountId
      || resolved.carrierAccountGlobalId !== input.label.carrierAccountGlobalId
      || resolved.accountNumberFingerprint
        !== input.label.accountNumberFingerprint
    ) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_CONTEXT_CHANGED',
        'The original production sender account is unavailable; reconcile before retrying the void',
        409,
      )
    }
    const runtime: CarrierOneOffGroupRuntime = {
      provider: resolved.provider,
      environment: 'production',
      credential: resolved.credential,
      integrationAccountGlobalId: resolved.integrationGlobalId,
      carrierAccountGlobalId: resolved.carrierAccountGlobalId,
      credentialVersion: resolved.credentialVersion,
      credentialFingerprint: resolved.credentialFingerprint,
      accountNumberFingerprint: resolved.accountNumberFingerprint,
      billingRelationship: 'sender',
      billingSelectionSnapshot: resolved.billingSelectionSnapshot,
    }
    const providerPrepared = prepareCarrierOneOffGroupVoidRequest({
      runtime,
      masterTrackingNumber: input.label.trackingNumber,
      providerShipmentId: input.label.providerLabelId,
      packageTrackingNumbers: [input.label.trackingNumber],
      attemptCorrelationKey: stableAttemptCorrelationKey({
        organizationId: input.organizationId,
        action: 'void',
        idempotencyKey: input.idempotencyKey,
      }),
    })
    return { runtime, providerPrepared }
  }
  let provider: Awaited<ReturnType<typeof buildPrepared>>
  try {
    provider = await buildPrepared()
  } catch (error) {
    throw carrierActionError(error)
  }
  const attemptRequestHash = carrierRateTestLabelFingerprint({
    action: 'void',
    environment: 'production',
    labelGlobalId: input.label.labelGlobalId,
    rateEvidenceGlobalId: input.label.rateEvidenceGlobalId,
    carrierAccountGlobalId: input.label.carrierAccountGlobalId,
    providerLabelId: input.label.providerLabelId,
    trackingNumber: input.label.trackingNumber,
    providerPreparedRequestHash: provider.providerPrepared.requestHash,
    adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
    reason: input.reason,
  })
  const replay = await replayCarrierRateTestLabelVoidInPostgres({
    organizationId: input.organizationId,
    labelGlobalId: input.label.labelGlobalId,
    idempotencyKey: input.idempotencyKey,
    attemptRequestHash,
  })
  if (replay) return replay
  const prepared = await prepareCarrierRateTestLabelVoidInPostgres({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    label: input.label,
    credentialVersion: provider.runtime.credentialVersion,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    attemptRequestHash,
    adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
    preparedProviderEvidence: provider.providerPrepared.redactedRequest,
  })
  if (prepared.disposition === 'replayed') return prepared.label
  try {
    const verified = await buildPrepared()
    if (
      verified.providerPrepared.requestHash
        !== provider.providerPrepared.requestHash
    ) {
      throw new OperationsRequestError(
        'CARRIER_RATE_TEST_CONTEXT_CHANGED',
        'The production void request changed after it was prepared',
        409,
      )
    }
    provider = verified
  } catch (error) {
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }
  let result: Awaited<ReturnType<typeof executeCarrierOneOffGroupVoid>>
  try {
    result = await executeCarrierOneOffGroupVoid({
      runtime: provider.runtime,
      prepared: provider.providerPrepared,
    })
  } catch (error) {
    await finalizePreparedFailure({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      error,
    })
    throw carrierActionError(error)
  }
  try {
    return await finalizeCarrierRateTestLabelVoidInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      providerReference: result.evidence.providerReference,
      redactedResponse: result.evidence.redactedResponse,
    })
  } catch {
    await finalizeCarrierRateTestLabelAttemptFailureInPostgres({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      attemptGlobalId: prepared.attemptGlobalId,
      state: 'unknown',
      errorCode: 'CARRIER_RATE_TEST_VOID_FINALIZATION_UNKNOWN',
      providerReference: result.evidence.providerReference,
      redactedResponse: result.evidence.redactedResponse,
    }).catch(() => undefined)
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_RECONCILIATION_REQUIRED',
      'The carrier voided the real postage, but ClawPilot could not finalize it; reconcile before retrying',
      503,
    )
  }
}

export async function closeCarrierRateTestSampleLabel(input: {
  organizationId: string
  actorEmail: string
  labelGlobalId: string
  reason: string
  idempotencyKey: string
}) {
  const label = await readCarrierRateTestLabelProviderContextInPostgres({
    organizationId: input.organizationId,
    labelGlobalId: input.labelGlobalId,
  })
  if (label.environment !== 'sandbox') {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_SAMPLE_CLOSE_UNAVAILABLE',
      'LIVE production postage can only be retired by a true provider void',
      409,
    )
  }
  try {
    await assertCarrierRateTestArtifactCapability({
      organizationId: input.organizationId,
      integrationAccountId: label.integrationAccountId,
      provider: label.provider,
    })
  } catch (error) {
    throw carrierActionError(error)
  }
  if (
    carrierSandboxLabelLifecycleMode(
      label.provider,
      label.trackingNumber,
    ) !== 'close_sample'
  ) {
    throw new OperationsRequestError(
      'CARRIER_RATE_TEST_SAMPLE_CLOSE_UNAVAILABLE',
      'This label has a carrier-side lifecycle and must use the provider void action',
      409,
    )
  }
  const attemptRequestHash = carrierRateTestLabelFingerprint({
    action: 'close_sample',
    labelGlobalId: label.labelGlobalId,
    rateEvidenceGlobalId: label.rateEvidenceGlobalId,
    carrierAccountGlobalId: label.carrierAccountGlobalId,
    providerLabelId: label.providerLabelId,
    trackingNumber: label.trackingNumber,
    adapterVersion: CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
    reason: input.reason,
  })
  return closeCarrierRateTestSampleLabelInPostgres({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    label,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    attemptRequestHash,
    adapterVersion: CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
  })
}

export async function printCarrierRateTestLabel(input: {
  organizationId: string
  actorEmail: string
  labelGlobalId: string
  warehouseId: string
  preferredPrinterGlobalId: string
  idempotencyKey: string
}) {
  const label = await readCarrierRateTestLabelProviderContextInPostgres({
    organizationId: input.organizationId,
    labelGlobalId: input.labelGlobalId,
  })
  if (label.environment === 'sandbox') {
    try {
      await assertCarrierRateTestArtifactCapability({
        organizationId: input.organizationId,
        integrationAccountId: label.integrationAccountId,
        provider: label.provider,
      })
    } catch (error) {
      throw carrierActionError(error)
    }
  }
  return queueCarrierRateTestLabelPrintInPostgres(input)
}

export async function listCarrierRateTestLabels(input: {
  organizationId: string
  rateEvidenceGlobalId?: string | null
}) {
  return listCarrierRateTestLabelsInPostgres({
    organizationId: input.organizationId,
    rateEvidenceGlobalId: input.rateEvidenceGlobalId || undefined,
  })
}

export async function listCarrierRateTestLabelAttempts(input: {
  organizationId: string
}) {
  return listCarrierRateTestLabelAttemptsInPostgres(input)
}

export async function reconcileCarrierRateTestLabelAttempt(input: {
  organizationId: string
  actorEmail: string
  attemptGlobalId: string
  outcome:
    | 'confirmed_no_active_label'
    | 'confirmed_voided'
    | 'confirmed_active'
  reason: string
  idempotencyKey: string
}) {
  return reconcileCarrierRateTestLabelAttemptInPostgres(input)
}
