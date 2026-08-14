import { NextRequest, NextResponse } from 'next/server'
import { globalIdPattern } from '@/lib/globalIds.mjs'
import {
  CarrierIntegrationRequestError,
  createCarrierAccount,
  deleteCarrierAccount,
  disconnectCarrierCredential,
  getCarrierIntegrationsState,
  revealCarrierCredential,
  sanitizedCarrierIntegrationError,
  setCarrierAccountStatus,
  setCarrierIntegrationEnabled,
  setCarrierProductionLabelEnabled,
  testCarrierSandboxRate,
  testCarrierCredential,
  updateCarrierAccount,
  updateCarrierCredential,
} from '@/lib/integrations/carrierIntegrations'
import { carrierProductionLabelRuntimePolicy } from '@/lib/integrations/carrierProductionLabelRuntime'
import {
  closeCarrierRateTestSampleLabel,
  createCarrierRateTestLabel,
  listCarrierRateTestLabelAttempts,
  listCarrierRateTestLabels,
  printCarrierRateTestLabel,
  reconcileCarrierRateTestLabelAttempt,
  voidCarrierRateTestLabel,
} from '@/lib/integrations/carrierRateTestLabelActions'
import {
  carrierSandboxLabelLifecycleMode,
  carrierSandboxLabelOutputOptions,
  type CarrierLabelOutputFormat,
} from '@/lib/integrations/carrierSandboxLabel'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { listOperationsPrinterProfilesInPostgres } from '@/lib/persistence/operationPrinting'
import { OperationsRequestError } from '@/lib/persistence/operations'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole, type AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 32 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  const sanitized = sanitizedCarrierIntegrationError(error)
  return json({ ok: false, error: sanitized.message, code: sanitized.code }, sanitized.status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CarrierIntegrationRequestError(
      'Carrier integrations require Postgres storage',
      503,
      'CARRIER_POSTGRES_REQUIRED',
    )
  }
}

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new CarrierIntegrationRequestError(
      'Your organization is not configured',
      409,
      'CARRIER_ORGANIZATION_REQUIRED',
    )
  }
  return actor.organizationId
}

function requireManager(actor: AppUser) {
  if (!operationsCapabilities(actor).canManage) {
    throw new CarrierIntegrationRequestError(
      'Operations-management permission is required to manage carrier accounts',
      403,
      'CARRIER_MANAGER_REQUIRED',
    )
  }
}

function requireExecutor(actor: AppUser) {
  const capabilities = operationsCapabilities(actor)
  if (!capabilities.canManage || !capabilities.canExecute) {
    throw new CarrierIntegrationRequestError(
      'Operations-management and warehouse-execution permissions are required for sandbox label actions',
      403,
      'CARRIER_EXECUTE_REQUIRED',
    )
  }
}

function canRevealCredential(actor: AppUser) {
  const role = effectiveAuthorizationRole(actor)
  return role === 'owner' || role === 'admin'
}

function requireCredentialViewer(actor: AppUser) {
  if (!canRevealCredential(actor)) {
    throw new CarrierIntegrationRequestError(
      'Organization owner or administrator access is required to reveal carrier credentials',
      403,
      'CARRIER_CREDENTIAL_REVEAL_FORBIDDEN',
    )
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CarrierIntegrationRequestError(
      'Carrier integration request is too large',
      413,
      'CARRIER_REQUEST_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new CarrierIntegrationRequestError(
      'Carrier integration request is too large',
      413,
      'CARRIER_REQUEST_TOO_LARGE',
    )
  }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new CarrierIntegrationRequestError(
      'Request body must be valid JSON',
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
}

function only(body: Record<string, unknown>, fields: string[]) {
  const unsupported = Object.keys(body).find((field) => !fields.includes(field))
  if (unsupported) {
    throw new CarrierIntegrationRequestError(
      `Unsupported carrier action field: ${unsupported}`,
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
}

function objectField(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CarrierIntegrationRequestError(
      `${label} must be an object`,
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  return value as Record<string, unknown>
}

function plainText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string') {
    throw new CarrierIntegrationRequestError(
      `${label} must be text`,
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new CarrierIntegrationRequestError(
      `${label} must be 1-${maximum} plain-text characters`,
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  return normalized
}

function globalReference(
  value: unknown,
  prefix: 'grq' | 'gsl' | 'gpr' | 'gsa',
  label: string,
) {
  const normalized = String(value || '').trim()
  if (!globalIdPattern(prefix).test(normalized)) {
    throw new CarrierIntegrationRequestError(
      `${label} is invalid`,
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  return normalized
}

function idempotencyKey(value: unknown) {
  const normalized = String(value || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(normalized)) {
    throw new CarrierIntegrationRequestError(
      'Idempotency key must be 8-200 safe characters',
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  return normalized
}

function labelOutputFormat(value: unknown): CarrierLabelOutputFormat {
  if (value === 'ZPL' || value === 'PDF' || value === 'PNG') return value
  throw new CarrierIntegrationRequestError(
    'Label output format must be ZPL, PDF, or PNG',
    400,
    'CARRIER_REQUEST_INVALID',
  )
}

function selectedRateInput(value: unknown) {
  const rate = objectField(value, 'Selected rate')
  only(rate, ['serviceCode', 'serviceName', 'rateType', 'amount', 'currency'])
  const rateType = rate.rateType === null
    ? null
    : plainText(rate.rateType, 'Selected rate type', 80)
  const amount = String(rate.amount || '').trim()
  const currency = String(rate.currency || '').trim().toUpperCase()
  if (!/^[0-9]+(?:[.][0-9]{1,6})?$/.test(amount)) {
    throw new CarrierIntegrationRequestError(
      'Selected rate amount is invalid',
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CarrierIntegrationRequestError(
      'Selected rate currency is invalid',
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  return {
    serviceCode: plainText(rate.serviceCode, 'Selected service code', 80),
    serviceName: plainText(rate.serviceName, 'Selected service name', 160),
    rateType,
    amount,
    currency,
  }
}

function destinationInput(value: unknown) {
  const destination = objectField(value, 'Destination')
  only(destination, ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'countryCode'])
  const line2 = destination.line2 === null || destination.line2 === ''
    ? null
    : plainText(destination.line2, 'Destination address line 2', 120)
  const region = String(destination.region || '').trim().toUpperCase()
  const postalCode = String(destination.postalCode || '').trim()
  const countryCode = String(destination.countryCode || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(region)) {
    throw new CarrierIntegrationRequestError(
      'Destination state must be a two-letter code',
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  if (!/^[0-9]{5}(?:-[0-9]{4})?$/.test(postalCode)) {
    throw new CarrierIntegrationRequestError(
      'Destination ZIP code is invalid',
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  if (countryCode !== 'US') {
    throw new CarrierIntegrationRequestError(
      'Sandbox label testing currently requires a US destination',
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
  return {
    name: plainText(destination.name, 'Destination name', 120),
    line1: plainText(destination.line1, 'Destination address line 1', 160),
    line2,
    city: plainText(destination.city, 'Destination city', 100),
    region,
    postalCode,
    countryCode: 'US' as const,
  }
}

function safeRateTestPrinter(
  printer: Awaited<ReturnType<typeof listOperationsPrinterProfilesInPostgres>>[number],
) {
  return {
    globalId: printer.globalId,
    warehouseGlobalId: printer.warehouseGlobalId,
    warehouseName: printer.warehouseName,
    code: printer.code,
    name: printer.name,
    connectionMode: printer.connectionMode,
    supportedFormats: printer.supportedFormats,
    supportedMedia: printer.supportedMedia,
    supportedDocumentTypes: printer.supportedDocumentTypes,
    localPrintAgentStatus: printer.localPrintAgentStatus,
    status: printer.status,
  }
}

function safeRateTestLabel(
  label: Awaited<ReturnType<typeof listCarrierRateTestLabels>>[number],
) {
  return {
    globalId: label.globalId,
    rateEvidenceGlobalId: label.rateEvidenceGlobalId,
    provider: label.provider,
    environment: label.environment,
    serviceCode: label.serviceCode,
    serviceName: label.serviceName,
    rateType: label.rateType,
    ratedAmount: label.ratedAmount,
    ratedCurrency: label.ratedCurrency,
    trackingNumber: label.trackingNumber,
    lifecycleMode: carrierSandboxLabelLifecycleMode(
      label.provider,
      label.trackingNumber,
    ),
    format: label.format,
    mediaSize: label.mediaSize,
    sourceKind: label.sourceKind,
    providerImageType: label.providerImageType,
    providerStockType: label.providerStockType,
    byteLength: label.byteLength,
    contentSha256: label.contentSha256,
    printArtifactGlobalId: label.printArtifactGlobalId,
    status: label.status,
    createdAt: label.createdAt,
    createdBy: label.createdBy,
    voidedAt: label.voidedAt,
    voidedBy: label.voidedBy,
  }
}

function safeRateTestPrintJob(
  job: Awaited<ReturnType<typeof printCarrierRateTestLabel>>,
) {
  return {
    globalId: job.globalId,
    artifactGlobalId: job.artifactGlobalId,
    sourceLabelGlobalId: job.sourceLabelGlobalId,
    status: job.status,
    format: job.format,
    media: job.media,
    printerGlobalId: job.printerGlobalId,
    printerName: job.printerName,
    warehouseGlobalId: job.warehouseGlobalId,
    warehouseName: job.warehouseName,
    routingReason: job.routingReason,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    deliveredAt: job.deliveredAt,
  }
}

function safeRateTestLabelAttempt(
  attempt: Awaited<ReturnType<typeof listCarrierRateTestLabelAttempts>>[number],
) {
  return {
    globalId: attempt.globalId,
    rateEvidenceGlobalId: attempt.rateEvidenceGlobalId,
    labelGlobalId: attempt.labelGlobalId,
    action: attempt.action,
    state: attempt.state,
    provider: attempt.provider,
    serviceCode: attempt.serviceCode,
    selectedRate: attempt.selectedRate,
    reason: attempt.reason,
    errorCode: attempt.errorCode,
    providerErrorCodes: attempt.providerErrorCodes,
    providerHttpStatus: attempt.providerHttpStatus,
    providerReference: attempt.providerReference,
    reconciliationOutcome: attempt.reconciliationOutcome,
    reconciliationReason: attempt.reconciliationReason,
    reconciledBy: attempt.reconciledBy,
    reconciledAt: attempt.reconciledAt,
    requestedAt: attempt.requestedAt,
    completedAt: attempt.completedAt,
    reconciliationEligible: attempt.reconciliationEligible,
  }
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    requireManager(actor)
    const organization = organizationId(actor)
    const capabilities = operationsCapabilities(actor)
    const [integrations, rateTestLabels, rateTestAttempts, printers] = await Promise.all([
      getCarrierIntegrationsState(organization),
      listCarrierRateTestLabels({ organizationId: organization }),
      listCarrierRateTestLabelAttempts({ organizationId: organization }),
      listOperationsPrinterProfilesInPostgres(organization),
    ])
    const productionLabelRuntime = carrierProductionLabelRuntimePolicy()
    return json({
      ok: true,
      canManage: true,
      canExecute: capabilities.canExecute,
      canRevealCredentials: canRevealCredential(actor),
      canReconcile: capabilities.canExecute && canRevealCredential(actor),
      productionLabelAuthorizationAllowed:
        productionLabelRuntime.allowed,
      productionLabelRuntimeLane: productionLabelRuntime.lane,
      integrations,
      rateTestLabels: rateTestLabels.map(safeRateTestLabel),
      rateTestAttempts: rateTestAttempts.map(safeRateTestLabelAttempt),
      rateTestPrinters: printers.map(safeRateTestPrinter),
      rateTestLabelOutputs: {
        ups_rest: carrierSandboxLabelOutputOptions('ups_rest'),
        fedex_rest: carrierSandboxLabelOutputOptions('fedex_rest'),
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    requireManager(actor)
    const organization = organizationId(actor)
    const body = await requestBody(req)
    const action = String(body.action || '').trim()
    if (action === 'reveal-credential') {
      only(body, ['action', 'provider', 'environment'])
      requireCredentialViewer(actor)
      const credential = await revealCarrierCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, canRevealCredentials: true, credential })
    }
    if (action === 'update-credential') {
      only(body, ['action', 'provider', 'environment', 'displayName', 'clientId', 'clientSecret'])
      const integrations = await updateCarrierCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        displayName: body.displayName,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'create-account') {
      only(body, [
        'action', 'provider', 'environment', 'displayName', 'senderName', 'accountNumber',
        'registeredAddress', 'allowSenderBilling', 'allowRecipientBilling',
        'allowThirdPartyBilling',
      ])
      const integrations = await createCarrierAccount({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        displayName: body.displayName,
        senderName: body.senderName,
        accountNumber: body.accountNumber,
        registeredAddress: body.registeredAddress,
        allowSenderBilling: body.allowSenderBilling,
        allowRecipientBilling: body.allowRecipientBilling,
        allowThirdPartyBilling: body.allowThirdPartyBilling,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'update-account') {
      only(body, [
        'action', 'provider', 'environment', 'carrierAccountGlobalId',
        'displayName', 'senderName', 'accountNumber', 'registeredAddress',
        'allowSenderBilling', 'allowRecipientBilling', 'allowThirdPartyBilling',
      ])
      const integrations = await updateCarrierAccount({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        carrierAccountGlobalId: body.carrierAccountGlobalId,
        displayName: body.displayName,
        senderName: body.senderName,
        accountNumber: body.accountNumber,
        registeredAddress: body.registeredAddress,
        allowSenderBilling: body.allowSenderBilling,
        allowRecipientBilling: body.allowRecipientBilling,
        allowThirdPartyBilling: body.allowThirdPartyBilling,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'set-account-status') {
      only(body, ['action', 'provider', 'environment', 'carrierAccountGlobalId', 'status'])
      const integrations = await setCarrierAccountStatus({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        carrierAccountGlobalId: body.carrierAccountGlobalId,
        status: body.status,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'delete-account') {
      only(body, ['action', 'provider', 'environment', 'carrierAccountGlobalId'])
      const integrations = await deleteCarrierAccount({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        carrierAccountGlobalId: body.carrierAccountGlobalId,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'test-connection') {
      only(body, ['action', 'provider', 'environment'])
      const integrations = await testCarrierCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'test-sandbox-rate') {
      only(body, [
        'action',
        'provider',
        'environment',
        'carrierAccountGlobalId',
        'destination',
        'parcel',
      ])
      const rateTest = await testCarrierSandboxRate({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        carrierAccountGlobalId: body.carrierAccountGlobalId,
        destination: body.destination,
        parcel: body.parcel,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, rateTest })
    }
    if (action === 'create-rate-test-label') {
      only(body, [
        'action',
        'rateEvidenceGlobalId',
        'selectedRate',
        'destination',
        'outputFormat',
        'reason',
        'idempotencyKey',
      ])
      requireExecutor(actor)
      const rateEvidenceGlobalId = globalReference(
        body.rateEvidenceGlobalId,
        'grq',
        'Rate evidence reference',
      )
      const selectedRate = selectedRateInput(body.selectedRate)
      const destination = destinationInput(body.destination)
      const rateTestLabel = await createCarrierRateTestLabel({
        organizationId: organization,
        actorEmail: actor.email,
        rateEvidenceGlobalId,
        selectedRate,
        destination,
        outputFormat: labelOutputFormat(body.outputFormat),
        reason: plainText(body.reason, 'Test-label reason', 500),
        idempotencyKey: idempotencyKey(body.idempotencyKey),
      })
      return json({
        ok: true,
        canManage: true,
        canExecute: true,
        rateTestLabel: safeRateTestLabel(rateTestLabel),
        rateTestLabels: (
          await listCarrierRateTestLabels({ organizationId: organization })
        ).map(safeRateTestLabel),
      })
    }
    if (action === 'print-rate-test-label') {
      only(body, ['action', 'labelGlobalId', 'preferredPrinterGlobalId', 'idempotencyKey'])
      requireExecutor(actor)
      const labelGlobalId = globalReference(body.labelGlobalId, 'gsl', 'Rate-test label reference')
      const preferredPrinterGlobalId = globalReference(
        body.preferredPrinterGlobalId,
        'gpr',
        'Printer reference',
      )
      const printers = await listOperationsPrinterProfilesInPostgres(organization)
      const printer = printers.find((entry) => entry.globalId === preferredPrinterGlobalId)
      if (
        !printer
        || printer.status !== 'online'
        || printer.connectionMode !== 'local_agent'
        || printer.localPrintAgentStatus !== 'active'
      ) {
        throw new CarrierIntegrationRequestError(
          'The selected printer is not an online local-agent printer for this organization',
          409,
          'CARRIER_RATE_TEST_PRINTER_UNAVAILABLE',
        )
      }
      const printJob = await printCarrierRateTestLabel({
        organizationId: organization,
        actorEmail: actor.email,
        labelGlobalId,
        warehouseId: printer.warehouseId,
        preferredPrinterGlobalId: printer.globalId,
        idempotencyKey: idempotencyKey(body.idempotencyKey),
      })
      return json({
        ok: true,
        canManage: true,
        canExecute: true,
        printJob: safeRateTestPrintJob(printJob),
      })
    }
    if (action === 'void-rate-test-label') {
      only(body, ['action', 'labelGlobalId', 'reason', 'idempotencyKey'])
      requireExecutor(actor)
      const rateTestLabel = await voidCarrierRateTestLabel({
        organizationId: organization,
        actorEmail: actor.email,
        labelGlobalId: globalReference(body.labelGlobalId, 'gsl', 'Rate-test label reference'),
        reason: plainText(body.reason, 'Void reason', 500),
        idempotencyKey: idempotencyKey(body.idempotencyKey),
      })
      return json({
        ok: true,
        canManage: true,
        canExecute: true,
        rateTestLabel: safeRateTestLabel(rateTestLabel),
        rateTestLabels: (
          await listCarrierRateTestLabels({ organizationId: organization })
        ).map(safeRateTestLabel),
      })
    }
    if (action === 'close-rate-test-sample-label') {
      only(body, ['action', 'labelGlobalId', 'reason', 'idempotencyKey'])
      requireExecutor(actor)
      requireCredentialViewer(actor)
      const rateTestLabel = await closeCarrierRateTestSampleLabel({
        organizationId: organization,
        actorEmail: actor.email,
        labelGlobalId: globalReference(
          body.labelGlobalId,
          'gsl',
          'Rate-test label reference',
        ),
        reason: plainText(body.reason, 'Sample-label close reason', 500),
        idempotencyKey: idempotencyKey(body.idempotencyKey),
      })
      const [rateTestLabels, rateTestAttempts] = await Promise.all([
        listCarrierRateTestLabels({ organizationId: organization }),
        listCarrierRateTestLabelAttempts({ organizationId: organization }),
      ])
      return json({
        ok: true,
        canManage: true,
        canExecute: true,
        canReconcile: true,
        rateTestLabel: safeRateTestLabel(rateTestLabel),
        rateTestLabels: rateTestLabels.map(safeRateTestLabel),
        rateTestAttempts: rateTestAttempts.map(safeRateTestLabelAttempt),
      })
    }
    if (action === 'reconcile-rate-test-attempt') {
      only(body, [
        'action',
        'attemptGlobalId',
        'outcome',
        'reason',
        'idempotencyKey',
      ])
      requireExecutor(actor)
      requireCredentialViewer(actor)
      const outcome = String(body.outcome || '').trim()
      if (
        outcome !== 'confirmed_no_active_label'
        && outcome !== 'confirmed_voided'
        && outcome !== 'confirmed_active'
      ) {
        throw new CarrierIntegrationRequestError(
          'Carrier reconciliation outcome is invalid',
          400,
          'CARRIER_REQUEST_INVALID',
        )
      }
      const attempt = await reconcileCarrierRateTestLabelAttempt({
        organizationId: organization,
        actorEmail: actor.email,
        attemptGlobalId: globalReference(
          body.attemptGlobalId,
          'gsa',
          'Carrier attempt reference',
        ),
        outcome,
        reason: plainText(body.reason, 'Reconciliation reason', 500),
        idempotencyKey: idempotencyKey(body.idempotencyKey),
      })
      const [rateTestLabels, rateTestAttempts] = await Promise.all([
        listCarrierRateTestLabels({ organizationId: organization }),
        listCarrierRateTestLabelAttempts({ organizationId: organization }),
      ])
      return json({
        ok: true,
        canManage: true,
        canExecute: true,
        canReconcile: true,
        rateTestAttempt: safeRateTestLabelAttempt(attempt),
        rateTestLabels: rateTestLabels.map(safeRateTestLabel),
        rateTestAttempts: rateTestAttempts.map(safeRateTestLabelAttempt),
      })
    }
    if (action === 'set-enabled') {
      only(body, ['action', 'provider', 'environment', 'enabled'])
      const integrations = await setCarrierIntegrationEnabled({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        enabled: body.enabled,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'set-production-label-enabled') {
      only(body, [
        'action', 'provider', 'enabled', 'reason', 'confirmation',
      ])
      requireCredentialViewer(actor)
      const capabilities = operationsCapabilities(actor)
      if (!capabilities.canActivate) {
        throw new CarrierIntegrationRequestError(
          'Operations activation permission is required to authorize live postage',
          403,
          'CARRIER_PRODUCTION_LABEL_AUTHORIZATION_FORBIDDEN',
        )
      }
      if (
        body.enabled === true
        && body.confirmation !== 'AUTHORIZE LIVE POSTAGE'
      ) {
        throw new CarrierIntegrationRequestError(
          'Type AUTHORIZE LIVE POSTAGE to enable production label purchase',
          400,
          'CARRIER_PRODUCTION_LABEL_CONFIRMATION_REQUIRED',
        )
      }
      const integrations = await setCarrierProductionLabelEnabled({
        organizationId: organization,
        provider: body.provider,
        enabled: body.enabled,
        reason: plainText(body.reason, 'Authorization reason', 500),
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'disconnect') {
      only(body, ['action', 'provider', 'environment'])
      const integrations = await disconnectCarrierCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    throw new CarrierIntegrationRequestError('Unsupported carrier action', 400, 'CARRIER_ACTION_INVALID')
  } catch (error) {
    return errorResponse(error)
  }
}
