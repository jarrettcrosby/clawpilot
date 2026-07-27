import { createHash } from 'node:crypto'
import {
  carrierSandboxRateSelectionRequestHash,
  resolveCarrierSandboxShippingRuntime,
  sanitizedCarrierIntegrationError,
} from '@/lib/integrations/carrierIntegrations'
import {
  CARRIER_SANDBOX_LABEL_ADAPTER_VERSION,
  CarrierSandboxLabelError,
  createCarrierSandboxLabel,
  voidCarrierSandboxLabel,
  type CarrierLabelOutputFormat,
} from '@/lib/integrations/carrierSandboxLabel'
import {
  buildCarrierSandboxRateFixture,
  carrierSandboxPartyFingerprint,
  carrierSandboxRateRequestEvidence,
  normalizeCarrierSandboxParty,
  type CarrierSandboxParty,
} from '@/lib/integrations/carrierSandboxRate'
import {
  carrierRateTestLabelFingerprint,
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
    'Select one exact rate returned by the current sandbox rating result',
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

export async function createCarrierRateTestLabel(input: {
  organizationId: string
  actorEmail: string
  rateEvidenceGlobalId: string
  selectedRate: CarrierRateTestSelectedRate
  destination: CarrierSandboxParty
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
  const destinationFingerprint = carrierSandboxPartyFingerprint(destination)
  assertDestinationMatchesRate(context, destinationFingerprint)
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
    runtime = await resolveCarrierSandboxShippingRuntime({
      organizationId: input.organizationId,
      provider: context.provider,
      carrierAccountGlobalId: context.carrierAccountGlobalId,
      senderBillingOnly: true,
    })
    assertRuntimeMatches({ runtime, expected: context })
    shipmentFixture = createFixtureAndVerifyContext({
      context,
      destination,
      runtime,
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

export async function printCarrierRateTestLabel(input: {
  organizationId: string
  actorEmail: string
  labelGlobalId: string
  warehouseId: string
  preferredPrinterGlobalId: string
  idempotencyKey: string
}) {
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
