'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import IntegrationSetupJourney, {
  type IntegrationSetupStep,
  type IntegrationSetupStepState,
} from '@/components/settings/IntegrationSetupJourney'
import ShopifyCustomerRatePolicyPanel
  from '@/components/settings/ShopifyCustomerRatePolicyPanel'
import {
  CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS,
} from '@/lib/integrations/carrierCheckoutRate'
import type {
  CommerceStoreSyncControl,
  CommerceStoreSyncDesiredState,
  CommerceStoreSyncPendingCommand,
} from '@/lib/operations/commerceStoreSync'
import {
  CommerceStoreSyncHttpError,
  commerceStoreSyncControlMatchesCommand,
  commerceStoreSyncPendingResolution,
} from '@/lib/operations/commerceStoreSync'

type Provider = 'ups_rest' | 'fedex_rest'
type PlanRateObjective =
  | 'landed_price'
  | 'package_count'
  | 'unused_cube'
type PlanRateOptimization = {
  version: 'shopify-checkout-plan-rate-objective-v2'
  maxCandidates: number
  objectivePriority: PlanRateObjective[]
  handlingCostMinorPerPackage: number
  handlingCostCurrency: string
}
type CheckoutRateWarmPolicy = {
  version: 'shopify-checkout-rate-warm-v1'
  enabled: boolean
  mode: 'hosted_ajax'
  zoneScope: 'all_saved_rate_zones'
  concurrency: number
  debounceMs: number
  minIntervalMs: number
  supportedCountries: ['US']
  staleCartAbort: true
}
type CheckoutAudienceMode =
  | 'off'
  | 'restricted_customers'
  | 'all_eligible'
type CheckoutAudiencePolicy = {
  version: 'shopify-checkout-audience-v1'
  mode: CheckoutAudienceMode
}
type ActivationState =
  | 'missing'
  | 'disabled'
  | 'shadow'
  | 'read_only'
  | 'active'
  | 'frozen'

const DEFAULT_PLAN_RATE_OPTIMIZATION: PlanRateOptimization = {
  version: 'shopify-checkout-plan-rate-objective-v2',
  maxCandidates: 4,
  objectivePriority: [
    'landed_price',
    'package_count',
    'unused_cube',
  ],
  handlingCostMinorPerPackage: 0,
  handlingCostCurrency: 'USD',
}

const DEFAULT_CHECKOUT_RATE_WARM: CheckoutRateWarmPolicy = {
  version: 'shopify-checkout-rate-warm-v1',
  enabled: false,
  mode: 'hosted_ajax',
  zoneScope: 'all_saved_rate_zones',
  concurrency: 2,
  debounceMs: 350,
  minIntervalMs: 1_000,
  supportedCountries: ['US'],
  staleCartAbort: true,
}

const DEFAULT_CHECKOUT_AUDIENCE: CheckoutAudiencePolicy = {
  version: 'shopify-checkout-audience-v1',
  mode: 'restricted_customers',
}

const OBJECTIVE_PRESETS: Array<{
  value: string
  label: string
}> = [
  {
    value: 'landed_price,package_count,unused_cube',
    label: 'Lowest landed price, then fewer packages, then cube',
  },
  {
    value: 'landed_price,unused_cube,package_count',
    label: 'Lowest landed price, then cube, then fewer packages',
  },
  {
    value: 'package_count,landed_price,unused_cube',
    label: 'Fewest packages, then landed price, then cube',
  },
  {
    value: 'package_count,unused_cube,landed_price',
    label: 'Fewest packages, then cube, then landed price',
  },
  {
    value: 'unused_cube,landed_price,package_count',
    label: 'Best cube use, then landed price, then fewer packages',
  },
  {
    value: 'unused_cube,package_count,landed_price',
    label: 'Best cube use, then fewer packages, then landed price',
  },
]

type SetupPayload = {
  ok?: boolean
  error?: string
  code?: string
  setup?: ShopifyCarrierServiceSetup
}

type ShopifyCarrierServiceSetup = {
  storeSync: CommerceStoreSyncControl
  account: {
    globalId: string
    configGlobalId: string
    configRowVersion: number
    environment: 'sandbox' | 'production'
    status: 'active' | 'disabled' | 'error'
    receiptIntakeEnabled: boolean
    configured: boolean
    credentialVersion: number
    verificationStatus: 'unverified' | 'verified' | 'failed'
    configuration: Record<string, unknown>
  }
  config: {
    globalId: string
    serviceGid: string | null
    registrationState:
      | 'unconfigured'
      | 'shadow_simulated'
      | 'registered'
      | 'disabled'
      | 'error'
    credentialGeneration: number
    activationRevision: number
    callbackTokenVersion: number
    policyRevision: number
    policyHash: string
    planRateOptimization: PlanRateOptimization
    checkoutRateWarm: CheckoutRateWarmPolicy
    shadowCheckoutAudience: CheckoutAudiencePolicy
    rowVersion: number
    ready: boolean
    checkoutBrandNameOverride: string | null
    registeredServiceName: string | null
    warehouseGlobalId: string
    materials: Array<{
      materialGlobalId: string
      expectedRowVersion: number
    }>
    carriers: Array<{
      provider: Provider
      carrierAccountGlobalId: string
    }>
  } | null
  rateWarmReadiness: {
    deliveryCustomizationDurable: boolean
    activationAllowed: boolean
    reason: string
  }
  checkoutAudience: {
    state:
      | 'shadow_off'
      | 'shadow_restricted_ready'
      | 'shadow_all_eligible_ready'
      | 'shadow_customer_required'
      | 'active_default_ready_provider_overrides_blocked'
      | 'inactive'
    defaultPolicy: 'show_all' | 'hide_all'
    mode: CheckoutAudienceMode
    policyCount: number
    unexpiredShadowPolicyCount: number
    shadowAllowedCustomerCount: number
    expiredShadowPolicyCount: number
    blockedPolicyCount: number
    enforcedPolicyCount: number
    earliestShadowExpiresAt: string | null
    shadowBinaryTestReady: boolean
    providerEnforcementState:
      | 'shadow_simulated'
      | 'active_blocked'
      | 'inactive_blocked'
    providerEnforcementAvailable: false
    providerWritesPerformed: 0
    providerEnforcementRequirement: string
  }
  shadowSimulation: {
    globalId: string
    operation: 'create' | 'delete'
    activationRevision: number
    configRowVersion: number
    requestHash: string
    completedAt: string | null
  } | null
  nameAlignment: {
    serviceGid: string
    desiredName: string
    appliedName: string | null
    aligned: boolean
    simulation: {
      globalId: string
      operation: 'update'
      activationRevision: number
      configRowVersion: number
      requestHash: string
      completedAt: string | null
    } | null
  } | null
  namePreference: {
    providerStoreEntityName: string
    overrideName: string | null
    effectiveName: string
    providerVerifiedAt: string | null
    source:
      | 'administrator_override'
      | 'provider_verified_shop_name'
  }
  mutationAuthorizations: Array<{
    globalId: string
    configRowVersion: number
    operation: 'create' | 'update' | 'delete'
    requestHash: string
    accountEnvironment: 'sandbox' | 'production'
    status:
      | 'authorized'
      | 'expired'
      | 'claimed'
      | 'succeeded'
      | 'failed'
      | 'unknown'
      | 'confirmed_applied'
      | 'confirmed_not_applied'
    reconciliationRequired: boolean
    authorizedAt: string
    expiresAt: string
    attempt: null | {
      globalId: string
      leaseExpiresAt: string
      claimedAt: string
    }
    outcome: null | {
      globalId: string
      state: 'succeeded' | 'failed' | 'unknown'
      providerReference: string | null
      errorCode: string | null
      providerWriteCount: 0 | 1 | null
      completedAt: string
    }
    resolution: null | {
      globalId: string
      disposition: 'confirmed_applied' | 'confirmed_not_applied'
      providerReference: string | null
      resolvedAt: string
    }
  }>
  reference: {
    activation: {
      state: ActivationState
      revision: number | null
      reason: string | null
      updatedAt: string | null
    }
    warehouses: Array<{
      globalId: string
      name: string
      status: 'active' | 'inactive'
    }>
    materials: Array<{
      globalId: string
      code: string
      name: string
      materialType: 'carton' | 'poly_mailer' | 'padded_mailer'
      rowVersion: number
      status: 'draft' | 'active'
      ratedOuterDimensionsMm: {
        length: number | null
        width: number | null
        height: number | null
      }
      ratedOuterDimensionEvidenceType: string | null
      ratedOuterDimensionEvidenceReference: string | null
      tareWeightGrams: number | null
      maxWeightGrams: number | null
      stock: Array<{
        warehouseGlobalId: string
        available: boolean
        onHandQuantity: number | null
      }>
    }>
    carrierAccounts: Array<{
      globalId: string
      provider: Provider
      environment: 'mock' | 'sandbox' | 'production'
      displayName: string
      accountNumberLastFour: string
      accountStatus: 'needs_configuration' | 'active' | 'disabled'
      integrationStatus: 'active' | 'disabled' | 'error'
      verificationStatus: 'unverified' | 'verified' | 'failed'
      allowSenderBilling: boolean
      allowedCapabilities: string[] | null
      matchingWarehouseGlobalIds: string[]
      readinessIssues: string[]
    }>
    evidence: {
      totalReceipts: number
      succeededReceipts: number
      failedReceipts: number
      processingReceipts: number
      lastReceivedAt: string | null
      lastSucceededAt: string | null
      latest: Array<{
        globalId: string
        status: 'processing' | 'succeeded' | 'failed'
        packageCount: number
        offerCount: number
        errorCode: string | null
        providerWriteCount: number
        receivedAt: string
      }>
    }
  }
  callbackUrl: string | null
  canActivate: boolean
  canManage: boolean
  boundaries: {
    checkoutCustomerFieldsPersisted: false
    providerWritesDuringCallback: 0
    inventoryReservedDuringCallback: false
    crmMutatedDuringCallback: false
    postagePurchasedDuringCallback: false
    labelsCreatedDuringCallback: false
    shadowProviderRegistrationWrites: 0
    oneTimeProviderMutationConfirmationRequired: true
    globalOperationsModeChangedForRegistration: false
    wholeShipmentCarrierCalls: true
    oneServiceForEveryPackage: true
  }
}

type Props = {
  accountGlobalId: string
  displayName: string
}

function scopes(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stepState(
  complete: boolean,
  current: boolean,
  attention = false,
): IntegrationSetupStepState {
  if (complete) return 'complete'
  if (attention) return 'attention'
  return current ? 'current' : 'pending'
}

function materialReady(
  material: ShopifyCarrierServiceSetup['reference']['materials'][number],
  warehouseGlobalId: string,
) {
  return materialReadinessIssues(material, warehouseGlobalId).length === 0
}

function materialReadinessIssues(
  material: ShopifyCarrierServiceSetup['reference']['materials'][number],
  warehouseGlobalId: string,
) {
  const dimensions = material.ratedOuterDimensionsMm
  const stock = material.stock.find(
    (candidate) => candidate.warehouseGlobalId === warehouseGlobalId,
  )
  const issues: string[] = []

  if (material.status !== 'active') issues.push('activate material')
  if (
    dimensions.length === null
    || dimensions.width === null
    || dimensions.height === null
  ) {
    issues.push('add outside dimensions')
  }
  if (
    !material.ratedOuterDimensionEvidenceType
    || !material.ratedOuterDimensionEvidenceReference
  ) {
    issues.push('add dimension evidence')
  }
  if (material.tareWeightGrams === null) issues.push('add tare weight')
  if (material.maxWeightGrams === null) issues.push('add maximum weight')
  if (!warehouseGlobalId) {
    issues.push('select a ship-from warehouse')
  } else if (stock?.available !== true || (stock.onHandQuantity || 0) <= 0) {
    issues.push('add available stock at this warehouse')
  }

  return issues
}

function providerLabel(provider: Provider) {
  return provider === 'ups_rest' ? 'UPS' : 'FedEx'
}

export default function ShopifyCarrierServiceSetupPanel({
  accountGlobalId,
  displayName,
}: Props) {
  const [setup, setSetup] = useState<ShopifyCarrierServiceSetup | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [warehouseGlobalId, setWarehouseGlobalId] = useState('')
  const [materialGlobalIds, setMaterialGlobalIds] = useState<string[]>([])
  const [carrierAccountGlobalIds, setCarrierAccountGlobalIds] = useState<
    string[]
  >([])
  const [
    checkoutBrandNameOverride,
    setCheckoutBrandNameOverride,
  ] = useState('')
  const [planRateOptimization, setPlanRateOptimization] =
    useState<PlanRateOptimization>({
      ...DEFAULT_PLAN_RATE_OPTIMIZATION,
      objectivePriority: [
        ...DEFAULT_PLAN_RATE_OPTIMIZATION.objectivePriority,
      ],
    })
  const [checkoutRateWarm, setCheckoutRateWarm] =
    useState<CheckoutRateWarmPolicy>({
      ...DEFAULT_CHECKOUT_RATE_WARM,
      supportedCountries: ['US'],
    })
  const [shadowCheckoutAudience, setShadowCheckoutAudience] =
    useState<CheckoutAudiencePolicy>(DEFAULT_CHECKOUT_AUDIENCE)
  const [confirmWrite, setConfirmWrite] = useState(false)
  const [confirmNameAlignment, setConfirmNameAlignment] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmRecovery, setConfirmRecovery] = useState(false)
  const pendingStoreSyncCommand = useRef<
    CommerceStoreSyncPendingCommand | null
  >(null)

  const applySetup = useCallback((next: ShopifyCarrierServiceSetup) => {
    setSetup(next)
    setWarehouseGlobalId(
      next.config?.warehouseGlobalId
        || next.reference.warehouses.find(
          (warehouse) => warehouse.status === 'active',
        )?.globalId
        || '',
    )
    setMaterialGlobalIds(
      next.config?.materials.map((material) => material.materialGlobalId)
        || [],
    )
    setCarrierAccountGlobalIds(
      next.config?.carriers.map(
        (carrier) => carrier.carrierAccountGlobalId,
      ) || [],
    )
    setCheckoutBrandNameOverride(next.namePreference.overrideName || '')
    const nextPlanRateOptimization =
      next.config?.planRateOptimization ?? DEFAULT_PLAN_RATE_OPTIMIZATION
    setPlanRateOptimization({
      ...nextPlanRateOptimization,
      objectivePriority: [...nextPlanRateOptimization.objectivePriority],
    })
    const nextCheckoutRateWarm =
      next.config?.checkoutRateWarm ?? DEFAULT_CHECKOUT_RATE_WARM
    setCheckoutRateWarm({
      ...nextCheckoutRateWarm,
      supportedCountries: ['US'],
    })
    setShadowCheckoutAudience(
      next.config?.shadowCheckoutAudience ?? DEFAULT_CHECKOUT_AUDIENCE,
    )
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(
        `/api/integrations/commerce/shopify/carrier-service?accountGlobalId=${
          encodeURIComponent(accountGlobalId)
        }`,
        { cache: 'no-store' },
      )
      const payload = await response.json() as SetupPayload
      if (!response.ok || !payload.setup) {
        throw new Error(payload.error || 'Checkout-rating setup is unavailable')
      }
      applySetup(payload.setup)
      return payload.setup
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Checkout-rating setup is unavailable',
      )
      return null
    } finally {
      setLoading(false)
    }
  }, [accountGlobalId, applySetup])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (
    action: string,
    body: Record<string, unknown>,
    success: string,
  ) => {
    setBusy(action)
    setError('')
    setNotice('')
    try {
      const response = await fetch(
        '/api/integrations/commerce/shopify/carrier-service',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            accountGlobalId,
            ...body,
          }),
        },
      )
      const payload = await response.json() as SetupPayload
      if (!response.ok || !payload.setup) {
        throw new Error(payload.error || 'Checkout-rating action failed')
      }
      applySetup(payload.setup)
      setNotice(success)
      setConfirmWrite(false)
      setConfirmNameAlignment(false)
      setConfirmRemove(false)
      setConfirmRecovery(false)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Checkout-rating action failed',
      )
    } finally {
      setBusy('')
    }
  }

  const updateStoreSync = async (
    desiredState: CommerceStoreSyncDesiredState,
  ) => {
    if (
      !setup
      || (
        desiredState === setup.storeSync.desiredState
        && setup.storeSync.explicitChoice
      )
    ) return
    const retainedCommand = pendingStoreSyncCommand.current
    if (retainedCommand && retainedCommand.desiredState !== desiredState) {
      setError(
        'A prior Store sync response is uncertain. Retry that exact change or reload before issuing a different change.',
      )
      return
    }
    const command: CommerceStoreSyncPendingCommand = retainedCommand || {
      accountGlobalId,
      desiredState,
      expectedDesiredState: setup.storeSync.desiredState,
      expectedRevision: setup.storeSync.revision,
      reason: desiredState === setup.storeSync.desiredState
        ? `Confirmed ${desiredState} as an independent Store sync choice in Shopify setup`
        : `Changed Store sync from ${setup.storeSync.desiredState} to ${desiredState} in Shopify setup`,
      idempotencyKey: `store-sync:${crypto.randomUUID()}`,
    }
    pendingStoreSyncCommand.current = command
    setBusy('store-sync')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.idempotencyKey,
        },
        body: JSON.stringify({
          action: 'update-commerce-store-sync',
          accountGlobalId: command.accountGlobalId,
          desiredState: command.desiredState,
          expectedDesiredState: command.expectedDesiredState,
          expectedRevision: command.expectedRevision,
          reason: command.reason,
        }),
      })
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean
        code?: string
        error?: string
        result?: { control?: CommerceStoreSyncControl }
      }
      if (!response.ok) {
        throw new CommerceStoreSyncHttpError(
          response.status,
          payload.error || 'Store sync could not be updated',
          payload.code,
        )
      }
      if (!payload.result?.control) {
        throw new Error(payload.error || 'Store sync could not be updated')
      }
      if (!commerceStoreSyncControlMatchesCommand(
        payload.result.control,
        command,
      )) {
        throw new Error('Store sync returned a response for a different command')
      }
      pendingStoreSyncCommand.current = null
      setNotice(
        `Store sync is ${payload.result.control.effectiveState}. ${payload.result.control.effectiveReasonLabel}`,
      )
      await load()
    } catch (caught) {
      const refreshed = await load().catch(() => null)
      const refreshedControl = refreshed?.storeSync
      const resolution = commerceStoreSyncPendingResolution(
        refreshedControl,
        command,
        caught,
      )
      if (resolution === 'applied' && refreshedControl) {
        pendingStoreSyncCommand.current = null
        setNotice(
          `Store sync is ${refreshedControl.effectiveState}. ${refreshedControl.effectiveReasonLabel}`,
        )
        setError('')
      } else if (resolution === 'definitive_rejection') {
        pendingStoreSyncCommand.current = null
        setError(
          `${caught instanceof Error ? caught.message : 'Store sync could not be updated'} Current Store sync state was refreshed. Review it before trying again.`,
        )
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'Store sync could not be updated'} The exact command is retained for retry.`,
        )
      }
    } finally {
      setBusy('')
    }
  }

  const accountScopes = scopes(setup?.account.configuration.grantedScopes)
  const scopeReady = accountScopes.includes('write_shipping')
  const connectionReady = setup?.account.configured === true
    && setup.account.verificationStatus === 'verified'
    && setup.account.status !== 'error'
    && scopeReady
  const eligibleMaterials = useMemo(
    () => (setup?.reference.materials || []).filter(
      (material) => materialReady(material, warehouseGlobalId),
    ),
    [setup, warehouseGlobalId],
  )
  const selectedRateEnvironment = setup?.reference.activation.state
    === 'shadow'
    ? 'sandbox'
    : setup?.reference.activation.state === 'active'
      ? 'production'
      : null
  const callbackRateLaneExecutable = selectedRateEnvironment !== null
  const directRateCarriers = useMemo(
    () => (setup?.reference.carrierAccounts || []).filter(
      (carrier) => (
        carrier.environment === 'sandbox'
        || carrier.environment === 'production'
      ),
    ),
    [setup],
  )
  const selectedCarrierBindings = directRateCarriers
    .filter((carrier) => carrierAccountGlobalIds.includes(carrier.globalId))
    .map((carrier) => ({
      provider: carrier.provider,
      carrierAccountGlobalId: carrier.globalId,
    }))
    .sort((left, right) => (
      left.provider.localeCompare(right.provider)
      || left.carrierAccountGlobalId.localeCompare(
        right.carrierAccountGlobalId,
      )
    ))
  const selectedSandboxBindings = selectedCarrierBindings.filter(
    (binding) => directRateCarriers.some((carrier) => (
      carrier.globalId === binding.carrierAccountGlobalId
      && carrier.environment === 'sandbox'
    )),
  )
  const selectedProductionBindings = selectedCarrierBindings.filter(
    (binding) => directRateCarriers.some((carrier) => (
      carrier.globalId === binding.carrierAccountGlobalId
      && carrier.environment === 'production'
    )),
  )
  const selectedRuntimeBindings = selectedRateEnvironment === 'sandbox'
    ? selectedSandboxBindings
    : selectedRateEnvironment === 'production'
      ? selectedProductionBindings
      : []
  const carrierIssues = (
    carrier: (typeof directRateCarriers)[number],
  ) => [
    ...carrier.readinessIssues,
    ...(
      warehouseGlobalId
      && !carrier.matchingWarehouseGlobalIds.includes(warehouseGlobalId)
        ? ['origin_does_not_match_warehouse']
        : []
    ),
  ]
  const carrierIssueLabel = (issue: string) => ({
    account_not_active: 'account disabled',
    connection_not_active: 'connection disabled',
    credential_not_verified: 'credential not verified',
    sender_billing_not_allowed: 'sender billing off',
    sandbox_rate_not_authorized: 'TEST rating not authorized',
    production_rate_not_authorized: 'LIVE rating not authorized',
    origin_does_not_match_warehouse: 'origin differs from warehouse',
    environment_not_supported: 'environment unsupported',
  }[issue] || 'not rate-ready')
  const bindingsReady = Boolean(
    callbackRateLaneExecutable
    && warehouseGlobalId
    && materialGlobalIds.length >= 1
    && materialGlobalIds.length <= 8
    && materialGlobalIds.every((globalId) => (
      eligibleMaterials.some((material) => material.globalId === globalId)
    ))
    && selectedRuntimeBindings.length >= 1
    && selectedSandboxBindings.length
      <= CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS
    && selectedProductionBindings.length
      <= CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS
    && selectedRuntimeBindings.every((binding) => (
      directRateCarriers.some((carrier) => (
        carrier.globalId === binding.carrierAccountGlobalId
        && carrier.provider === binding.provider
        && carrierIssues(carrier).length === 0
      ))
    ))
  )
  const registered = setup?.config?.registrationState === 'registered'
  const activeRevisionBindingRequired = Boolean(
    registered
    && setup?.reference.activation.state === 'active'
    && setup.reference.activation.revision !== null
    && setup.config?.activationRevision
      !== setup.reference.activation.revision,
  )
  const callbackServingReady = Boolean(
    registered
    && setup?.config?.serviceGid
    && setup.config.ready === true
    && setup.callbackUrl
    && !activeRevisionBindingRequired
  )
  const planRatePolicyEditable =
    setup?.reference.activation.state === 'shadow' && !busy
  const rateWarmPolicyEditable =
    setup?.reference.activation.state === 'shadow' && !busy
  const nameAlignment = registered ? setup?.nameAlignment || null : null
  const savedCheckoutBrandNameOverride =
    setup?.namePreference.overrideName || ''
  const normalizedCheckoutBrandNameOverride =
    checkoutBrandNameOverride.trim()
  const namePreferenceChanged =
    normalizedCheckoutBrandNameOverride !== savedCheckoutBrandNameOverride
  const nameAlignmentSimulation = nameAlignment?.simulation || null
  const nameAlignmentAuthorization = setup?.mutationAuthorizations.find(
    (authorization) => (
      authorization.operation === 'update'
      && authorization.configRowVersion === setup?.config?.rowVersion
      && authorization.requestHash === nameAlignment?.simulation?.requestHash
      && (
        authorization.status === 'succeeded'
        || authorization.status === 'confirmed_applied'
      )
    ),
  ) || null
  const nameAlignmentComplete = Boolean(
    nameAlignment?.aligned && !namePreferenceChanged,
  )
  const expectedSimulationOperation = registered ? 'delete' : 'create'
  const exactShadowSimulation = setup?.shadowSimulation?.operation
    === expectedSimulationOperation
    ? setup.shadowSimulation
    : null
  const simulated = Boolean(exactShadowSimulation)
  const shadowRegistered = registered
    && setup?.reference.activation.state === 'shadow'
    && setup.config?.ready === true
  const reconciliationRequired = setup?.mutationAuthorizations.find(
    (authorization) => authorization.reconciliationRequired,
  ) || null
  const localRecoveryRequired = setup?.mutationAuthorizations.find(
    (authorization) => (
      authorization.configRowVersion === setup?.config?.rowVersion
      && (
        authorization.status === 'succeeded'
        || authorization.status === 'confirmed_applied'
      )
      && (
        (
          authorization.operation === 'create'
          && setup?.config?.registrationState !== 'registered'
        )
        || (
          authorization.operation === 'delete'
          && setup?.config?.registrationState !== 'disabled'
        )
        || (
          authorization.operation === 'update'
          && setup?.nameAlignment?.aligned !== true
        )
      )
    ),
  ) || null
  const recoveryRequired =
    reconciliationRequired || localRecoveryRequired
  const mutationInFlight = setup?.mutationAuthorizations.find(
    (authorization) => (
      Boolean(authorization.attempt)
      && !authorization.resolution
      && (
        authorization.status === 'claimed'
        || authorization.status === 'unknown'
      )
      && new Date(
        authorization.attempt?.leaseExpiresAt || 0,
      ).getTime() > Date.now()
    ),
  ) || null
  const evidenceComplete =
    (setup?.reference.evidence.succeededReceipts || 0) > 0
  const checkoutAudience = setup?.checkoutAudience || null
  const shadowAudienceServingReady = Boolean(
    checkoutAudience?.shadowBinaryTestReady,
  )
  const shadowAudienceConfigured = Boolean(
    setup?.reference.activation.state === 'shadow'
    && (
      checkoutAudience?.mode === 'off'
      || shadowAudienceServingReady
    ),
  )
  const activeAudienceReady =
    setup?.reference.activation.state === 'active'
    && callbackServingReady
  const checkoutAudienceReady =
    shadowAudienceConfigured || activeAudienceReady
  const rateWarmConfigured = Boolean(
    setup?.config?.checkoutRateWarm.enabled
    && setup.rateWarmReadiness.activationAllowed,
  )

  const saveConfig = () => run('save-config', {
    warehouseGlobalId,
    materials: materialGlobalIds.map((globalId) => {
      const material = setup?.reference.materials.find(
        (candidate) => candidate.globalId === globalId,
      )
      return {
        materialGlobalId: globalId,
        expectedRowVersion: material?.rowVersion,
      }
    }),
    carriers: selectedCarrierBindings,
    inventoryMaxAgeSeconds: 900,
    quoteTtlSeconds: 900,
    orderReconciliationWindowSeconds: 86400,
    planRateOptimization,
    checkoutRateWarm,
    shadowCheckoutAudience,
  }, 'The exact warehouse, package, carrier, and inventory policy was saved.')
  const savePlanRatePolicy = () => run('save-plan-rate-policy', {
    planRateOptimization,
  }, 'The tenant carton-plan and rate objective was saved without changing the registered Shopify service.')
  const saveRateWarmPolicy = () => run('save-rate-warm-policy', {
    checkoutRateWarm,
  }, 'The disabled saved-address rate cache-preparation policy was saved without changing the registered Shopify service.')
  const saveCheckoutAudience = () => run('save-checkout-audience', {
    shadowCheckoutAudience,
  }, 'The Shadow checkout audience was saved without changing the registered Shopify service or writing to Shopify.')

  if (loading && !setup) {
    return (
      <Box sx={{ py: 3, display: 'grid', placeItems: 'center' }}>
        <CircularProgress
          size={24}
          aria-label="Loading Shopify checkout-rating setup"
        />
      </Box>
    )
  }

  const configAction = (
    <Stack spacing={1.5}>
      <FormControl size="small" fullWidth>
        <InputLabel id={`shopify-checkout-warehouse-${accountGlobalId}`}>
          Ship-from warehouse
        </InputLabel>
        <Select
          labelId={`shopify-checkout-warehouse-${accountGlobalId}`}
          label="Ship-from warehouse"
          value={warehouseGlobalId}
          disabled={Boolean(registered) || Boolean(busy)}
          onChange={(event) => {
            setWarehouseGlobalId(event.target.value)
            setMaterialGlobalIds([])
          }}
        >
          {(setup?.reference.warehouses || []).map((warehouse) => (
            <MenuItem
              key={warehouse.globalId}
              value={warehouse.globalId}
              disabled={warehouse.status !== 'active'}
            >
              {warehouse.name}
              {warehouse.status !== 'active' ? ' (inactive)' : ''}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Box>
        <Typography variant="body2" fontWeight={700}>
          Rated package materials · select 1–8
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Only active, stocked materials with evidenced outside dimensions and
          weights can be selected.
        </Typography>
        <Stack sx={{ mt: 0.5 }}>
          {(setup?.reference.materials || []).map((material) => {
            const readinessIssues = materialReadinessIssues(
              material,
              warehouseGlobalId,
            )
            const ready = readinessIssues.length === 0
            return (
              <FormControlLabel
                key={material.globalId}
                disabled={!ready || Boolean(registered) || Boolean(busy)}
                control={(
                  <Checkbox
                    size="small"
                    checked={materialGlobalIds.includes(material.globalId)}
                    onChange={(event) => {
                      setMaterialGlobalIds((current) => event.target.checked
                        ? [...current, material.globalId].slice(0, 8)
                        : current.filter((value) => (
                          value !== material.globalId
                        )))
                    }}
                  />
                )}
                label={`${material.code} · ${material.name}${
                  ready ? ' — ready' : ` — needs ${readinessIssues.join(', ')}`
                }`}
              />
            )
          })}
        </Stack>
        <Button
          size="small"
          onClick={() => {
            window.location.hash = '#operations/packaging-materials'
          }}
        >
          Open Packaging Materials
        </Button>
      </Box>

      <Box>
        <Typography variant="body2" fontWeight={700}>
          Checkout rate sources
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Keep separate TEST and LIVE account groups on the same Shopify
          service. Each group supports 1–{CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS}{' '}
          active, verified direct UPS or FedEx accounts. Every account in the
          active group rates the same whole-shipment carton plan; Shopify
          receives the lowest eligible result for each carrier service.
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block">
          {selectedRateEnvironment === 'production'
            ? 'Active executes only the LIVE group. It never falls back to TEST and checkout rating does not buy postage or create labels.'
            : 'Shadow executes only the TEST group. The saved LIVE group remains available for an explicit Active transition.'}
        </Typography>
      </Box>
      {(['sandbox', 'production'] as const).map((environment) => {
        const selectedInEnvironment = environment === 'sandbox'
          ? selectedSandboxBindings
          : selectedProductionBindings
        return (
          <Box key={environment}>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="baseline"
            >
              <Typography variant="body2" fontWeight={700}>
                {environment === 'sandbox' ? 'TEST accounts' : 'LIVE accounts'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {selectedInEnvironment.length}/
                {CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS} selected
              </Typography>
            </Stack>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              {(['ups_rest', 'fedex_rest'] as const).map((provider) => {
                const accounts = directRateCarriers.filter(
                  (carrier) => (
                    carrier.provider === provider
                    && carrier.environment === environment
                  ),
                )
                return (
                  <Box key={`${environment}:${provider}`} sx={{ flex: 1 }}>
                    <Typography variant="caption" fontWeight={700}>
                      {providerLabel(provider)} · direct parcel
                    </Typography>
                    <Stack>
                      {accounts.length ? accounts.map((carrier) => {
                        const checked = carrierAccountGlobalIds.includes(
                          carrier.globalId,
                        )
                        const atLimit = selectedInEnvironment.length
                          >= CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS
                        const issues = carrierIssues(carrier)
                        return (
                          <FormControlLabel
                            key={carrier.globalId}
                            disabled={
                              Boolean(busy)
                              || (!checked && (atLimit || issues.length > 0))
                            }
                            control={(
                              <Checkbox
                                size="small"
                                checked={checked}
                                onChange={(event) => {
                                  setCarrierAccountGlobalIds((current) => (
                                    event.target.checked
                                      ? [...current, carrier.globalId]
                                      : current.filter(
                                          (globalId) => (
                                            globalId !== carrier.globalId
                                          ),
                                        )
                                  ))
                                }}
                              />
                            )}
                            label={`${carrier.displayName} · ••••${
                              carrier.accountNumberLastFour
                            }${issues.length
                              ? ` — ${issues.map(carrierIssueLabel).join(', ')}`
                              : ''}`}
                          />
                        )
                      }) : (
                        <Typography variant="caption" color="text.secondary">
                          No configured {environment === 'sandbox'
                            ? 'TEST'
                            : 'LIVE'} account
                        </Typography>
                      )}
                    </Stack>
                  </Box>
                )
              })}
            </Stack>
          </Box>
        )
      })}
      <Box>
        <Typography variant="caption" fontWeight={700}>
          Not checkout executable yet
        </Typography>
        <Stack>
          {[
            'USPS parcel — Credentials can be verified; the checkout rate adapter is not implemented.',
            'WWEX parcel — One-off sandbox rating works; the Shopify checkout callback is not connected.',
            'WWEX LTL — Account freight policy + item contents + chosen pallet plan must produce packed density, then freight class, then a quote; checkout execution is not connected.',
            'R+L LTL — Production quote client only; account freight policy, pallet-density classification, and checkout orchestration are not implemented.',
          ].map((capability) => (
            <FormControlLabel
              key={capability}
              disabled
              control={<Checkbox size="small" checked={false} />}
              label={capability}
            />
          ))}
        </Stack>
      </Box>
      <Box>
        <Typography variant="body2" fontWeight={700}>
          Whole-shipment carton and rate objective
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Every generated carton plan is rated as one complete shipment. The
          default minimizes landed price first, then package count, then unused
          cube. Stable IDs resolve an exact tie.
        </Typography>
        <Stack spacing={1} sx={{ mt: 1 }}>
          <FormControl size="small" fullWidth>
            <InputLabel id={`shopify-plan-objective-${accountGlobalId}`}>
              Optimization priority
            </InputLabel>
            <Select
              labelId={`shopify-plan-objective-${accountGlobalId}`}
              label="Optimization priority"
              value={planRateOptimization.objectivePriority.join(',')}
              disabled={!planRatePolicyEditable}
              onChange={(event) => setPlanRateOptimization((current) => ({
                ...current,
                objectivePriority: event.target.value.split(
                  ',',
                ) as PlanRateObjective[],
              }))}
            >
              {OBJECTIVE_PRESETS.map((preset) => (
                <MenuItem key={preset.value} value={preset.value}>
                  {preset.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField
              size="small"
              fullWidth
              type="number"
              label="Candidate plan limit"
              value={planRateOptimization.maxCandidates}
              disabled={!planRatePolicyEditable}
              inputProps={{ min: 1, max: 4, step: 1 }}
              helperText="Bounded to 1–4 deterministic feasible plans."
              onChange={(event) => setPlanRateOptimization((current) => ({
                ...current,
                maxCandidates: Math.min(
                  4,
                  Math.max(1, Number(event.target.value) || 1),
                ),
              }))}
            />
            <TextField
              size="small"
              fullWidth
              type="number"
              label="Handling cost per package (minor units)"
              value={planRateOptimization.handlingCostMinorPerPackage}
              disabled={!planRatePolicyEditable}
              inputProps={{ min: 0, max: 1_000_000, step: 1 }}
              helperText={`In ${planRateOptimization.handlingCostCurrency}; 100 minor units normally equals one major unit for two-decimal currencies.`}
              onChange={(event) => setPlanRateOptimization((current) => ({
                ...current,
                handlingCostMinorPerPackage: Math.min(
                  1_000_000,
                  Math.max(0, Number(event.target.value) || 0),
                ),
              }))}
            />
            <TextField
              size="small"
              fullWidth
              label="Handling cost currency (ISO 4217)"
              value={planRateOptimization.handlingCostCurrency}
              disabled={!planRatePolicyEditable}
              inputProps={{ minLength: 3, maxLength: 3 }}
              helperText="Must match the checkout cart currency."
              onChange={(event) => setPlanRateOptimization((current) => ({
                ...current,
                handlingCostCurrency: event.target.value
                  .trim()
                  .toUpperCase()
                  .slice(0, 3),
              }))}
            />
          </Stack>
          {setup?.config ? (
            <Typography variant="caption" color="text.secondary">
              Saved policy revision {setup.config.policyRevision} · hash{' '}
              {setup.config.policyHash.slice(0, 12)}…
            </Typography>
          ) : null}
          {registered ? (
            <Button
              size="small"
              variant="outlined"
              disabled={!planRatePolicyEditable}
              onClick={() => void savePlanRatePolicy()}
            >
              {busy === 'save-plan-rate-policy'
                ? 'Saving objective…'
                : 'Save rate objective only'}
            </Button>
          ) : null}
        </Stack>
      </Box>
      <Button
        variant="contained"
        disabled={!bindingsReady || Boolean(busy)}
        onClick={() => void saveConfig()}
      >
        {busy === 'save-config'
          ? 'Saving…'
          : registered
            ? 'Save checkout rate sources'
            : 'Save exact callback setup'}
      </Button>
    </Stack>
  )

  const rateWarmAction = (
    <Box>
      <Typography variant="body2" fontWeight={700}>
        Saved-address rate cache preparation
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Processes every distinct complete U.S. saved destination in the
        background to prime Shopify&apos;s checkout-rate cache.
        Carrier-relevant address fields are used only for Shopify&apos;s Ajax
        request; the browser emits aggregate counts only.
      </Typography>
      <Alert severity="info" sx={{ mt: 1 }}>
        {setup?.rateWarmReadiness.reason
          || 'A verified sandbox Shopify account in Operations Shadow is required.'}
      </Alert>
      <Alert severity="warning" sx={{ mt: 1 }}>
        {checkoutAudience?.mode === 'all_eligible'
          ? 'All-eligible Shadow cache preparation skips the customer allow-policy lookup only on a sandbox store. It still requires a signed-in customer to read saved addresses, and exact product mapping, inventory, packaging, and TEST carrier readiness remain fail-closed.'
          : checkoutAudience?.mode === 'off'
            ? 'Checkout rates are Off. Cache preparation is disabled and does not request a Shopify Admin token or read saved customer addresses.'
            : 'Restricted Shadow cache preparation requires a signed-in customer with an unexpired allow policy and the isolated allowlisted test item. Shopify does not guarantee Customer GID in CarrierService callbacks, and its successful-rate cache is customer-neutral; cache preparation is not deterministic customer enforcement.'}
      </Alert>
      <Stack spacing={1} sx={{ mt: 1 }}>
        <FormControlLabel
          control={(
            <Checkbox
              size="small"
              checked={checkoutRateWarm.enabled}
              disabled={
                !rateWarmPolicyEditable
                || setup?.rateWarmReadiness.activationAllowed !== true
              }
              onChange={(event) => setCheckoutRateWarm((current) => ({
                ...current,
                enabled: event.target.checked,
              }))}
            />
          )}
          label="Enable saved-address rate cache preparation"
        />
        <TextField
          size="small"
          fullWidth
          label="Storefront mode (v1)"
          value="Shopify hosted AJAX"
          disabled
          helperText="Version 1 warms rates through Shopify hosted Online Store AJAX endpoints."
        />
        <TextField
          size="small"
          fullWidth
          label="Saved-address scope"
          value={checkoutRateWarm.zoneScope}
          disabled
          helperText="Version 1 processes every distinct complete U.S. saved destination in the background; addresses are never silently truncated."
        />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField
            size="small"
            fullWidth
            type="number"
            label="Concurrency"
            value={checkoutRateWarm.concurrency}
            disabled={!rateWarmPolicyEditable}
            inputProps={{ min: 1, max: 8, step: 1 }}
            helperText="Bounded to 1–8 concurrent requests."
            onChange={(event) => setCheckoutRateWarm((current) => ({
              ...current,
              concurrency: Math.min(
                8,
                Math.max(1, Number(event.target.value) || 1),
              ),
            }))}
          />
          <TextField
            size="small"
            fullWidth
            type="number"
            label="Debounce (ms)"
            value={checkoutRateWarm.debounceMs}
            disabled={!rateWarmPolicyEditable}
            inputProps={{ min: 0, max: 5_000, step: 50 }}
            helperText="Bounded to 0–5,000 ms."
            onChange={(event) => setCheckoutRateWarm((current) => ({
              ...current,
              debounceMs: Math.min(
                5_000,
                Math.max(0, Number(event.target.value) || 0),
              ),
            }))}
          />
          <TextField
            size="small"
            fullWidth
            type="number"
            label="Minimum interval (ms)"
            value={checkoutRateWarm.minIntervalMs}
            disabled={!rateWarmPolicyEditable}
            inputProps={{ min: 250, max: 60_000, step: 250 }}
            helperText="Bounded to 250–60,000 ms."
            onChange={(event) => setCheckoutRateWarm((current) => ({
              ...current,
              minIntervalMs: Math.min(
                60_000,
                Math.max(250, Number(event.target.value) || 250),
              ),
            }))}
          />
        </Stack>
        <TextField
          size="small"
          fullWidth
          label="Supported country (v1)"
          value="United States (US)"
          disabled
          helperText="Version 1 supports United States destinations only."
        />
        <FormControlLabel
          control={(
            <Checkbox
              size="small"
              checked={checkoutRateWarm.staleCartAbort}
              disabled
            />
          )}
          label="Abort queued work when the cart changes (required)"
        />
        {setup?.config ? (
          <Typography variant="caption" color="text.secondary">
            Saved policy revision {setup.config.policyRevision}; changing this
            policy invalidates prior checkout cache and retry fences.
          </Typography>
        ) : null}
        {registered ? (
          <Button
            size="small"
            variant="outlined"
            disabled={!rateWarmPolicyEditable}
            onClick={() => void saveRateWarmPolicy()}
          >
            {busy === 'save-rate-warm-policy'
              ? 'Saving cache-preparation policy…'
              : 'Save cache-preparation policy only'}
          </Button>
        ) : null}
      </Stack>
    </Box>
  )

  const steps: IntegrationSetupStep[] = [
    {
      key: 'credential',
      label: 'Verify connection and checkout scope',
      description:
        'The installed Shopify app credential must be configured, verified, non-error, and grant write_shipping. Optional signed receipt intake is a separate control and is not required for CarrierService setup. The callback itself remains read, compute, rate, and persist only.',
      state: stepState(
        Boolean(connectionReady),
        true,
        Boolean(setup && !connectionReady),
      ),
      facts: [
        {
          label: 'Connection',
          value: setup?.account.verificationStatus || 'Unavailable',
        },
        {
          label: 'Store class',
          value: setup?.account.environment || 'Unavailable',
        },
        {
          label: 'write_shipping',
          value: scopeReady ? 'Granted' : 'Missing',
        },
        {
          label: 'Signed receipt intake (optional)',
          value: setup?.account.receiptIntakeEnabled
            ? 'Queued'
            : 'Held',
        },
      ],
    },
    {
      key: 'bindings',
      label: 'Choose warehouse, materials, and carrier accounts',
      description:
        `This exact revision controls inventory freshness, cartonization, and one whole-shipment request to each of up to ${CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS} selected direct parcel accounts.`,
      state: stepState(
        Boolean(setup?.config),
        Boolean(connectionReady),
        Boolean(connectionReady && !bindingsReady),
      ),
      action: configAction,
    },
    ...(setup?.config ? [{
      key: 'cart-rate-callback',
      label: 'Shopify cart-rate callback',
      description:
        'Shopify sends an HTTPS POST to this exact CarrierService endpoint while calculating cart and checkout shipping rates. This is not an event webhook, and no manual webhook topic subscriptions belong on this URL.',
      state: stepState(
        Boolean(
          registered
          && setup.config.serviceGid
          && setup.callbackUrl,
        ),
        Boolean(setup.callbackUrl),
        Boolean(!setup.callbackUrl),
      ),
      facts: [
        ...(setup.callbackUrl ? [{
          label: 'Exact POST callback URL',
          value: setup.callbackUrl,
          copyable: true,
        }] : []),
        {
          label: 'Shopify registration',
          value: registered
            ? `Registered · ${setup.config.serviceGid || 'ID unavailable'}`
            : setup.config.registrationState === 'shadow_simulated'
              ? 'Simulated · authorization still required'
              : 'Not registered',
        },
        {
          label: 'Required Shopify scope',
          value: 'write_shipping',
        },
      ],
      action: (
        <Alert severity={registered ? 'success' : 'info'}>
          {registered
            ? 'Shopify has this callback registered on the exact CarrierService shown above. Cart and checkout rate requests use POST automatically.'
            : 'ClawPilot registers this URL on a Shopify CarrierService only after the zero-write simulation and one-time authorization below. Do not add it as an orders, products, inventory, or app event webhook.'}
        </Alert>
      ),
    }] : []),
    ...(setup?.config ? [{
      key: 'carrier-service-name',
      label: registered
        ? 'Align the Shopify shipping-option name'
        : 'Confirm the Shopify shipping-option name',
      description: registered
        ? 'Use the verified Shopify store entity name by default, or save an optional administrator override. A changed name is applied in place to the exact registered Shopify resource.'
        : 'New CarrierServices use the verified Shopify store entity name by default. An owner or administrator may save an optional customer-facing override before the first registration.',
      state: registered
        ? stepState(
            nameAlignmentComplete,
            Boolean(nameAlignment && !nameAlignmentComplete),
            Boolean(!nameAlignment),
          )
        : stepState(!namePreferenceChanged, true),
      facts: [
        ...(registered ? [{
          label: 'Registered CarrierService',
          value: nameAlignment?.serviceGid
            || setup?.config?.serviceGid
            || 'Unavailable',
        }] : []),
        {
          label: registered ? 'Desired Shopify name' : 'Registration name',
          value: nameAlignment?.desiredName
            || setup?.namePreference.effectiveName
            || 'Unavailable',
        },
        ...(registered ? [{
          label: 'Provider-confirmed applied name',
          value: nameAlignment?.appliedName || 'Not yet confirmed',
        }] : []),
        ...(nameAlignmentSimulation ? [{
          label: 'Name-alignment simulation',
          value: nameAlignmentSimulation.globalId,
        }] : []),
        ...(nameAlignmentAuthorization ? [{
          label: 'Applied evidence',
          value: nameAlignmentAuthorization.globalId,
        }] : []),
      ],
      action: (
        <Stack spacing={1}>
          {registered ? (
            <Alert severity="info">
              The CarrierService ID, callback URL, active state, and Shopify
              shipping-profile assignments remain unchanged. This action
              changes only the merchant-facing CarrierService name.
            </Alert>
          ) : (
            <Alert severity="info">
              The verified Shopify store entity name is the default. Saving
              an override here changes only the future customer-facing
              CarrierService name.
            </Alert>
          )}
          <TextField
            size="small"
            fullWidth
            label="Optional administrator checkout name"
            value={checkoutBrandNameOverride}
            inputProps={{ maxLength: 120 }}
            placeholder={setup?.namePreference.providerStoreEntityName || ''}
            disabled={
              !setup?.canActivate
              || Boolean(recoveryRequired)
              || Boolean(mutationInFlight)
              || Boolean(busy)
            }
            helperText={
              `Leave blank to use the verified Shopify store name: ${
                setup?.namePreference.providerStoreEntityName || 'Unavailable'
              }. Clearing a saved override restores that default.`
            }
            onChange={(event) => {
              setCheckoutBrandNameOverride(event.target.value)
            }}
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button
              variant="outlined"
              disabled={
                !setup?.canActivate
                || !namePreferenceChanged
                || Boolean(recoveryRequired)
                || Boolean(mutationInFlight)
                || Boolean(busy)
              }
              onClick={() => void run(
                'save-name-preference',
                {
                  checkoutBrandNameOverride:
                    normalizedCheckoutBrandNameOverride || null,
                },
                registered
                  ? 'The checkout name preference was saved. Registered checkout callbacks are paused until a fresh exact name-alignment simulation is applied.'
                  : 'The checkout name preference was saved. A fresh exact registration simulation will use this name.',
              )}
            >
              {busy === 'save-name-preference'
                ? 'Saving checkout name…'
                : normalizedCheckoutBrandNameOverride
                  ? 'Save checkout-name override'
                  : 'Restore verified Shopify name'}
            </Button>
          </Stack>
          {namePreferenceChanged ? (
            <Alert severity="warning">
              Save this preference before simulating or applying the Shopify
              CarrierService. Saving invalidates any prior exact simulation.
            </Alert>
          ) : null}
          <Stack direction="row" spacing={0.75} flexWrap="wrap">
            <Chip
              size="small"
              variant="outlined"
              label={`Default · ${
                setup?.namePreference.providerStoreEntityName || 'Unavailable'
              }`}
            />
            <Chip
              size="small"
              color="primary"
              variant="outlined"
              label={`Effective · ${
                setup?.namePreference.effectiveName || 'Unavailable'
              }`}
            />
            <Chip
              size="small"
              variant="outlined"
              label={setup?.namePreference.source
                === 'administrator_override'
                ? 'Source · administrator override'
                : 'Source · verified Shopify store'}
            />
            {setup?.namePreference.providerVerifiedAt ? (
              <Chip
                size="small"
                variant="outlined"
                label={`Shopify verified · ${
                  new Date(
                    setup.namePreference.providerVerifiedAt,
                  ).toLocaleString()
                }`}
              />
            ) : null}
          </Stack>
          {registered && !nameAlignmentComplete ? (
            <Alert severity="warning">
              Checkout callbacks are fail-closed while the desired name and
              Shopify&apos;s provider-confirmed applied name differ. Run the
              exact Shadow simulation and one-time in-place alignment below.
            </Alert>
          ) : null}
          {registered
          && !nameAlignmentSimulation
          && !nameAlignmentComplete ? (
            <Button
              variant="outlined"
              disabled={
                !nameAlignment
                || namePreferenceChanged
                || setup?.reference.activation.state !== 'shadow'
                || !setup?.canActivate
                || Boolean(recoveryRequired)
                || Boolean(mutationInFlight)
                || Boolean(busy)
              }
              onClick={() => void run(
                'simulate-name-alignment',
                {},
                'The exact CarrierService name alignment was simulated in Shadow with zero Shopify writes.',
              )}
            >
              {busy === 'simulate-name-alignment'
                ? 'Simulating name alignment…'
                : 'Simulate exact name alignment'}
            </Button>
          ) : null}
          {registered
          && nameAlignmentSimulation
          && !nameAlignmentComplete ? (
            <>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={confirmNameAlignment}
                    disabled={!setup?.canActivate || Boolean(busy)}
                    onChange={(event) => {
                      setConfirmNameAlignment(event.target.checked)
                    }}
                  />
                )}
                label={`I authorize one in-place Shopify CarrierService name update to “${
                  nameAlignment?.desiredName || 'the verified store name'
                }”.`}
              />
              <Button
                variant="contained"
                color="warning"
                disabled={
                  !nameAlignment
                  || namePreferenceChanged
                  || setup?.reference.activation.state !== 'shadow'
                  || !setup?.canActivate
                  || !confirmNameAlignment
                  || Boolean(recoveryRequired)
                  || Boolean(mutationInFlight)
                  || Boolean(busy)
                }
                onClick={() => void run(
                  'align-registration-name',
                  {
                    confirmProviderWrite: true,
                    confirmProductionProviderWrite:
                      setup?.account.environment === 'production',
                    confirmationRequestId:
                      globalThis.crypto.randomUUID(),
                  },
                  'Shopify confirmed the in-place CarrierService name alignment. Its ID, callback, active state, and shipping-profile assignments were preserved.',
                )}
              >
                {busy === 'align-registration-name'
                  ? 'Aligning name once…'
                  : 'Authorize and align name once'}
              </Button>
            </>
          ) : null}
          {registered && nameAlignmentComplete ? (
            <Alert severity="success">
              Shopify&apos;s provider-confirmed applied name matches the
              current default or administrator override.
            </Alert>
          ) : null}
        </Stack>
      ),
    } satisfies IntegrationSetupStep] : []),
    {
      key: 'shadow',
      label: registered
        ? 'Simulate exact removal in Shadow'
        : 'Simulate registration in Shadow',
      description:
        'Shadow records immutable terminal evidence for this exact configuration row with zero credential decryption, zero Shopify network calls, and zero provider writes.',
      state: stepState(
        Boolean(simulated),
        Boolean(setup?.config && !simulated),
      ),
      facts: [
        {
          label: 'Operations mode',
          value: setup?.reference.activation.state || 'Unavailable',
        },
        ...(exactShadowSimulation ? [{
          label: 'Simulation evidence',
          value: exactShadowSimulation.globalId,
        }] : []),
      ],
      action: (
        <Button
          variant="outlined"
          disabled={
            !setup?.config
            || (
              !registered
              && setup.account.environment !== 'sandbox'
            )
            || setup.reference.activation.state !== 'shadow'
            || namePreferenceChanged
            || Boolean(busy)
            || Boolean(simulated)
          }
          onClick={() => void run(
            'simulate-registration',
            {},
            `Shadow ${registered ? 'removal' : 'registration'} simulation completed with zero provider writes.`,
          )}
        >
          {busy === 'simulate-registration'
            ? 'Simulating…'
            : registered
              ? 'Simulate exact removal'
              : 'Run zero-write simulation'}
        </Button>
      ),
    },
    {
      key: 'register',
      label: registered
        ? 'Authorize exact resource removal'
        : 'Authorize exact resource registration',
      description:
        'Keep global Operations in Shadow. After the exact zero-write simulation, an owner or authorized administrator may grant one short-lived, single-use Shopify provider mutation for only this CarrierService configuration row and exact Shadow revision.',
      state: stepState(
        false,
        Boolean(simulated),
        Boolean(recoveryRequired),
      ),
      facts: [],
      action: (
        <Stack spacing={1}>
          <Alert severity="warning">
            Current Operations mode:{' '}
            {setup?.reference.activation.state || 'unknown'}. Keep it in
            Shadow. Provider credentials remain encrypted and no Shopify
            network call can begin until the exact resource-scoped,
            single-use authorization is durably claimed.
          </Alert>
          {reconciliationRequired ? (
            <Alert severity="error">
              Attempt {reconciliationRequired.attempt?.globalId || 'unknown'}
              {' '}has an uncertain provider outcome. Do not retry. ClawPilot will query
              Shopify&apos;s complete CarrierService collection before permitting
              another mutation.
            </Alert>
          ) : null}
          {localRecoveryRequired ? (
            <Alert severity="warning">
              Shopify already returned applied provider evidence for attempt
              {' '}{localRecoveryRequired.attempt?.globalId || 'unknown'}, but
              the local configuration transition still needs to be completed.
              Recovery reuses that immutable evidence and makes no Shopify
              write.
            </Alert>
          ) : null}
          {mutationInFlight ? (
            <Alert severity="info">
              Attempt {mutationInFlight.attempt?.globalId || 'unknown'} is
              still inside its provider-call lease. New mutation and
              reconciliation controls remain closed until it records an
              outcome or the lease expires.
            </Alert>
          ) : null}
          {recoveryRequired ? (
            <Stack spacing={1}>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={confirmRecovery}
                    disabled={Boolean(busy)}
                    onChange={(event) => {
                      setConfirmRecovery(event.target.checked)
                    }}
                  />
                )}
                label={reconciliationRequired
                  ? 'I authorize one read-only Shopify provider-state check and exact local reconciliation.'
                  : 'I authorize completion of the exact local state transition from existing immutable provider evidence.'}
              />
              <Button
                variant="outlined"
                color="warning"
                disabled={
                  !confirmRecovery
                  || Boolean(busy)
                }
                onClick={() => void run(
                  'recover-mutation',
                  {
                    authorizationGlobalId: recoveryRequired.globalId,
                    confirmRecovery: true,
                    confirmReconciliation:
                      Boolean(reconciliationRequired),
                  },
                  reconciliationRequired
                    ? 'Shopify provider state was verified and the one-time mutation was reconciled.'
                    : 'The local CarrierService state was recovered from immutable provider evidence.',
                )}
              >
                {busy === 'recover-mutation'
                  ? 'Recovering…'
                  : reconciliationRequired
                    ? 'Verify Shopify and reconcile'
                    : 'Finish local recovery'}
              </Button>
            </Stack>
          ) : null}
          {!registered ? (
            <>
              {setup?.account.environment === 'production' ? (
                <Alert severity="warning">
                  New CarrierService registration is sandbox-only in this
                  development slice.
                </Alert>
              ) : null}
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={confirmWrite}
                    disabled={!setup?.canActivate || Boolean(busy)}
                    onChange={(event) => {
                      setConfirmWrite(event.target.checked)
                    }}
                  />
                )}
                label="I authorize exactly one sandbox Shopify CarrierService registration for this simulated configuration revision."
              />
              <Button
                variant="contained"
                color="warning"
                disabled={
                  !exactShadowSimulation
                  || setup?.reference.activation.state !== 'shadow'
                  || setup?.account.environment !== 'sandbox'
                  || namePreferenceChanged
                  || !setup?.canActivate
                  || !confirmWrite
                  || Boolean(recoveryRequired)
                  || Boolean(mutationInFlight)
                  || Boolean(busy)
                }
                onClick={() => void run(
                  'register',
                  {
                    confirmProviderWrite: true,
                    confirmationRequestId:
                      globalThis.crypto.randomUUID(),
                  },
                  'Shopify confirmed the sandbox CarrierService registration under the exact Shadow revision and one-time resource authorization.',
                )}
              >
                {busy === 'register'
                  ? 'Registering once…'
                  : 'Authorize and register once'}
              </Button>
            </>
          ) : (
            <>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={confirmRemove}
                    disabled={!setup?.canActivate || Boolean(busy)}
                    onChange={(event) => {
                      setConfirmRemove(event.target.checked)
                    }}
                  />
                )}
                label={setup?.account.environment === 'production'
                  ? 'I understand this removes the exact live production Shopify CarrierService once.'
                  : 'I authorize removal of this exact sandbox Shopify CarrierService once.'}
              />
              <Button
                variant="outlined"
                color="error"
                disabled={
                  !exactShadowSimulation
                  || setup?.reference.activation.state !== 'shadow'
                  || !setup?.canActivate
                  || !confirmRemove
                  || Boolean(recoveryRequired)
                  || Boolean(mutationInFlight)
                  || Boolean(busy)
                }
                onClick={() => void run(
                  'unregister',
                  {
                    confirmProviderWrite: true,
                    confirmProductionProviderWrite:
                      setup?.account.environment === 'production',
                    confirmationRequestId:
                      globalThis.crypto.randomUUID(),
                  },
                  'Shopify confirmed exact CarrierService removal under the Shadow revision and one-time resource authorization.',
                )}
              >
                {busy === 'unregister'
                  ? 'Removing once…'
                  : 'Authorize and remove once'}
              </Button>
            </>
          )}
          {setup?.mutationAuthorizations.length ? (
            <Stack direction="row" spacing={0.75} flexWrap="wrap">
              {setup.mutationAuthorizations.slice(0, 5).map(
                (authorization) => (
                  <Chip
                    key={authorization.globalId}
                    size="small"
                    color={
                      authorization.status === 'succeeded'
                        ? 'success'
                        : authorization.reconciliationRequired
                          ? 'error'
                          : 'default'
                    }
                    variant="outlined"
                    label={`${authorization.globalId} · ${
                      authorization.operation
                    } · ${authorization.status}`}
                  />
                ),
              )}
            </Stack>
          ) : null}
        </Stack>
      ),
    },
    {
      key: 'audience',
      label: setup?.reference.activation.state === 'shadow'
        ? 'Choose who receives checkout rates'
        : 'Confirm the checkout audience',
      description: setup?.reference.activation.state === 'shadow'
        ? 'The Shopify callback remains registered store-wide. Choose whether ClawPilot returns no rates, rates for selected test customers, or rates for every otherwise eligible checkout.'
        : setup?.reference.activation.state === 'active'
          ? 'Active defaults to the complete eligible customer-neutral service set for guests and authenticated customers. Customer-specific and per-service provider enforcement remains blocked.'
          : 'Checkout-audience changes require Operations Shadow or Active.',
      state: stepState(
        Boolean(setup?.config && checkoutAudienceReady),
        Boolean(setup?.config),
        Boolean(
          setup?.config
          && setup.reference.activation.state === 'shadow'
          && !shadowAudienceConfigured,
        ),
      ),
      facts: [
        {
          label: 'Shadow checkout rates',
          value: checkoutAudience?.mode === 'all_eligible'
            ? 'All eligible checkouts'
            : checkoutAudience?.mode === 'restricted_customers'
              ? 'Restricted customers'
              : 'Off',
        },
        {
          label: 'Saved customer policies',
          value: String(checkoutAudience?.policyCount || 0),
        },
        {
          label: 'Unexpired Shadow allow customers',
          value: String(
            checkoutAudience?.shadowAllowedCustomerCount || 0,
          ),
        },
        {
          label: 'Provider enforcement',
          value: checkoutAudience?.providerEnforcementAvailable
            ? 'Available'
            : 'Blocked',
        },
      ],
      action: setup ? (
        <Stack spacing={1}>
          <Alert severity="info">
            Shopify sends rate requests for the store, not for existing orders.
            This audience setting controls whether ClawPilot answers those
            requests. Product mapping, fresh inventory, factual packaging,
            destination, and sandbox carrier readiness still fail closed.
          </Alert>
          <FormControl size="small" fullWidth>
            <InputLabel id={`shopify-shadow-audience-${accountGlobalId}`}>
              Shadow checkout rates
            </InputLabel>
            <Select
              labelId={`shopify-shadow-audience-${accountGlobalId}`}
              label="Shadow checkout rates"
              value={shadowCheckoutAudience.mode}
              disabled={
                setup.reference.activation.state !== 'shadow'
                || !setup.canActivate
                || Boolean(busy)
              }
              onChange={(event) => setShadowCheckoutAudience({
                version: 'shopify-checkout-audience-v1',
                mode: event.target.value as CheckoutAudienceMode,
              })}
            >
              <MenuItem value="off">Off — return no ClawPilot rates</MenuItem>
              <MenuItem value="restricted_customers">
                Restricted customers — require an exact active policy
              </MenuItem>
              <MenuItem
                value="all_eligible"
                disabled={setup.account.environment !== 'sandbox'}
              >
                All eligible checkouts
                {setup.account.environment !== 'sandbox'
                  ? ' — sandbox store required'
                  : ''}
              </MenuItem>
            </Select>
          </FormControl>
          <Button
            size="small"
            variant="contained"
            disabled={
              !setup.config
              || setup.reference.activation.state !== 'shadow'
              || !setup.canActivate
              || Boolean(busy)
              || shadowCheckoutAudience.mode
                === setup.config.shadowCheckoutAudience.mode
            }
            onClick={saveCheckoutAudience}
          >
            {busy === 'save-checkout-audience'
              ? 'Saving checkout audience…'
              : 'Save checkout audience'}
          </Button>
          <Alert severity={shadowAudienceConfigured ? 'info' : 'warning'}>
            {setup.reference.activation.state === 'shadow'
              ? checkoutAudience?.mode === 'off'
                ? 'ClawPilot is connected but intentionally returns no checkout rates.'
                : checkoutAudience?.mode === 'all_eligible'
                  ? 'Guests and signed-in customers can receive the complete eligible sandbox service set. No Shopify/Faire writeback or production postage is enabled.'
                  : 'Only customers with an unexpired non-hide policy are admitted when Shopify supplies their Customer GID. Include-only and exclude selections remain saved intent and do not filter live services.'
              : setup.reference.activation.state === 'active'
                ? 'Active serves the complete eligible customer-neutral service set by default. Saved customer-specific and per-service policies are not live provider enforcement.'
                : 'Customer-rate policies are review-only in the current Operations mode.'}
          </Alert>
          {shadowCheckoutAudience.mode === 'restricted_customers' ? (
            <>
              <Alert severity="warning">
                {checkoutAudience?.providerEnforcementRequirement
                  || 'Customer-specific and per-service Shopify enforcement requires an eligible Delivery Customization delivered by a limited-visibility public app or a custom app on Shopify Plus, followed by provider activation and verification.'}
              </Alert>
              <ShopifyCustomerRatePolicyPanel
                accountGlobalId={accountGlobalId}
                activationState={setup.reference.activation.state}
                canManage={setup.canManage}
              />
            </>
          ) : null}
          <Button
            size="small"
            variant="outlined"
            disabled={loading || Boolean(busy)}
            onClick={() => void load()}
          >
            {loading
              ? 'Refreshing audience status…'
              : 'Refresh checkout-audience status'}
          </Button>
        </Stack>
      ) : null,
    },
    {
      key: 'rate-warm',
      label: 'Prepare saved-address rate cache',
      description:
        'Optional best-effort cache preparation follows customer selection. It never replaces the authoritative live checkout callback and does not prove customer-specific enforcement.',
      optional: true,
      state: stepState(
        rateWarmConfigured,
        Boolean(shadowRegistered && shadowAudienceServingReady),
        Boolean(
          setup?.config?.checkoutRateWarm.enabled
          && setup.rateWarmReadiness.activationAllowed !== true,
        ),
      ),
      facts: [
        {
          label: 'Audience prerequisite',
          value: checkoutAudience?.mode === 'off'
            ? 'Checkout rates are Off'
            : shadowAudienceServingReady
              ? 'Ready'
              : 'Select an allowed customer',
        },
        {
          label: 'Cache preparation',
          value: setup?.config?.checkoutRateWarm.enabled
            ? 'Enabled'
            : 'Disabled',
        },
      ],
      action: rateWarmAction,
    },
    {
      key: 'evidence',
      label: setup?.reference.activation.state === 'shadow'
        && checkoutAudience?.mode === 'off'
        ? 'Verify the checkout-rate kill switch'
        : 'Prove a live cart request',
      description: setup?.reference.activation.state === 'active'
        ? callbackServingReady
          ? 'Create any eligible cart. ClawPilot should retain a customer-neutral receipt, inventory-aware package plan, and whole-shipment carrier offers with zero callback provider writes.'
          : 'The Active CarrierService is not callback-ready at the current configuration and activation revision. Repair setup before attempting a live proof.'
        : setup?.reference.activation.state === 'shadow'
          ? checkoutAudience?.mode === 'off'
            ? 'Open an otherwise eligible Shopify cart and confirm ClawPilot returns no rates. The authenticated callback must return an empty 200 response without parsing the cart, creating a receipt, reading inventory, or calling a carrier.'
            : checkoutAudience?.mode === 'all_eligible'
              ? setup.account.environment === 'sandbox'
                ? 'Use any otherwise eligible sandbox-store cart. No customer allow policy or environment variant allowlist is required, but exact product mapping, fresh inventory, factual packaging, destination, and TEST carrier readiness still fail closed.'
                : 'All-eligible Shadow proof is unavailable because it requires a sandbox Shopify store connection.'
              : 'Use a signed-in Shopify customer covered by an unexpired Checkout audience allow policy and the isolated allowlisted test item. ClawPilot should retain a customer-neutral receipt, inventory-aware package plan, and whole-shipment carrier offers with zero callback provider writes.'
          : 'Set Operations to Shadow or Active and complete a callback-ready CarrierService before attempting checkout proof.',
      state: stepState(
        evidenceComplete,
        Boolean(
          (
            shadowRegistered
            && (
              checkoutAudience?.mode === 'off'
              || shadowAudienceServingReady
            )
          )
          || (
            activeAudienceReady
            && registered
            && setup?.config?.ready === true
          ),
        ),
        Boolean(
          shadowRegistered
          && setup?.reference.activation.state === 'shadow'
          && !shadowAudienceServingReady,
        ),
      ),
      facts: [
        {
          label: 'Successful callbacks',
          value: String(setup?.reference.evidence.succeededReceipts || 0),
        },
        {
          label: 'Failed callbacks',
          value: String(setup?.reference.evidence.failedReceipts || 0),
        },
        {
          label: 'Last callback',
          value: setup?.reference.evidence.lastReceivedAt
            ? new Date(
              setup.reference.evidence.lastReceivedAt,
            ).toLocaleString()
            : 'None yet',
        },
        {
          label: 'Provider writes per callback',
          value: '0 (database-enforced)',
        },
      ],
      action: setup?.reference.evidence.latest.length ? (
        <Stack direction="row" spacing={0.75} flexWrap="wrap">
          {setup.reference.evidence.latest.slice(0, 5).map((receipt) => (
            <Chip
              key={receipt.globalId}
              size="small"
              color={receipt.status === 'succeeded' ? 'success' : 'warning'}
              variant="outlined"
              label={`${receipt.globalId} · ${receipt.packageCount} packages · ${
                receipt.offerCount
              } offers · ${receipt.providerWriteCount} writes`}
            />
          ))}
        </Stack>
      ) : null,
    },
  ]

  const operatingActivation = setup?.reference.activation.state || 'missing'
  const checkoutRateSummary = operatingActivation === 'active'
    ? callbackServingReady
      ? 'All eligible · LIVE carrier-rate sources'
      : 'Not serving · CarrierService setup incomplete or stale'
    : operatingActivation === 'shadow'
      ? checkoutAudience?.mode === 'off'
        ? 'Off · authenticated empty-rate response'
        : !callbackServingReady
          ? 'Not serving · CarrierService setup incomplete or stale'
          : checkoutAudience?.mode === 'all_eligible'
            ? setup?.account.environment === 'sandbox'
              && shadowAudienceServingReady
              ? 'All eligible · TEST carrier-rate sources'
              : 'Not serving · All eligible requires a sandbox store'
            : shadowAudienceServingReady
              ? 'Restricted customers · TEST carrier-rate sources'
              : 'Not serving · allowed customer required'
      : 'Off'
  const orderExecutionSummary = operatingActivation === 'active'
    ? 'Live only for exact authorized store-write capabilities'
    : operatingActivation === 'shadow'
      ? 'Orders mirrored · per-order local Training available'
      : 'Local order execution unavailable'

  return (
    <Stack spacing={1.5}>
      {error ? (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert severity="success" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}
      {setup && !setup.canActivate ? (
        <Alert severity="info">
          Owner or authorized administrator permission is required to view the
          callback URL or change registration state.
        </Alert>
      ) : null}
      {activeRevisionBindingRequired ? (
        <Alert severity="error">
          <Stack spacing={1}>
            <Typography variant="body2">
              ClawPilot checkout rates are paused because this registered
              Shopify service is bound to an older Operations activation
              revision. Refreshing authority preserves the exact Shopify
              service, callback token, name, policy, warehouse, packages, and
              carriers; it performs no Shopify write.
            </Typography>
            <Box>
              <Button
                size="small"
                variant="contained"
                color="error"
                disabled={!setup?.canActivate || Boolean(busy)}
                onClick={() => void run(
                  'repair-activation-revision-binding',
                  {},
                  'Active checkout authority was refreshed locally with zero Shopify writes and no callback-token rotation.',
                )}
              >
                {busy === 'repair-activation-revision-binding'
                  ? 'Refreshing authority…'
                  : 'Refresh Active checkout authority'}
              </Button>
            </Box>
          </Stack>
        </Alert>
      ) : null}
      {setup ? (
        <Box
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: 1.5,
            p: 1.5,
          }}
        >
          <Stack spacing={1}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              gap={0.5}
            >
              <Box>
                <Typography variant="subtitle2">
                  Current operating profile
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Store sync is independently controlled here. Checkout rating
                  and order execution still use the effective legacy fences
                  shown below. Pausing stops new provider catalog, order,
                  image, and inventory mirroring; existing mirrored data
                  remains available.
                </Typography>
              </Box>
              <Chip
                size="small"
                variant="outlined"
                label={`Advanced safety · ${operatingActivation}`}
              />
            </Stack>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
                gap: 1,
              }}
            >
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Store sync
                </Typography>
                <Typography variant="body2" fontWeight={700}>
                  Desired {setup.storeSync.desiredState === 'running'
                    ? 'Running'
                    : 'Paused'} · Effective{' '}
                  {setup.storeSync.effectiveState === 'running'
                    ? 'Running'
                    : 'Paused'} ·{' '}
                  {setup.account.environment === 'sandbox'
                    ? 'sandbox store'
                    : 'production store'}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {setup.storeSync.effectiveReason}:{' '}
                  {setup.storeSync.effectiveReasonLabel}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {setup.storeSync.explicitChoice
                    ? 'Independent Store sync choice'
                    : 'Legacy-derived default; confirm it to make Store sync independent'}
                </Typography>
                <TextField
                  select
                  size="small"
                  label="Desired Store sync"
                  value={setup.storeSync.desiredState}
                  onChange={(event) => void updateStoreSync(
                    event.target.value as CommerceStoreSyncDesiredState,
                  )}
                  disabled={!setup.canActivate || Boolean(busy)}
                  inputProps={{
                    'aria-label': `${displayName} desired Store sync`,
                  }}
                  sx={{ mt: 1, minWidth: { xs: '100%', sm: 170 } }}
                >
                  <MenuItem value="running">Running</MenuItem>
                  <MenuItem value="paused">Paused</MenuItem>
                </TextField>
                {!setup.storeSync.explicitChoice && (
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={!setup.canActivate || Boolean(busy)}
                    onClick={() => void updateStoreSync(
                      setup.storeSync.desiredState,
                    )}
                    sx={{ mt: 1, width: { xs: '100%', sm: 'auto' } }}
                  >
                    Make independent
                  </Button>
                )}
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Checkout rates
                </Typography>
                <Typography variant="body2" fontWeight={700}>
                  {checkoutRateSummary}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Rating only; checkout rating never buys postage or creates a
                  label.
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Order execution
                </Typography>
                <Typography variant="body2" fontWeight={700}>
                  {orderExecutionSummary}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Training and live store writeback are separate order paths.
                </Typography>
              </Box>
            </Box>
          </Stack>
        </Box>
      ) : null}
      <IntegrationSetupJourney
        title={`${displayName} · live checkout shipping`}
        description="A revision-fenced setup from verified inventory and packages to one whole-shipment Shopify quote."
        steps={steps}
      />
    </Stack>
  )
}
