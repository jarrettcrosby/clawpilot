'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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

type Provider = 'ups_rest' | 'fedex_rest'
type ActivationState =
  | 'missing'
  | 'disabled'
  | 'shadow'
  | 'read_only'
  | 'active'
  | 'frozen'

type SetupPayload = {
  ok?: boolean
  error?: string
  code?: string
  setup?: ShopifyCarrierServiceSetup
}

type ShopifyCarrierServiceSetup = {
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
  const [carrierAccounts, setCarrierAccounts] = useState<
    Record<Provider, string>
  >({ ups_rest: '', fedex_rest: '' })
  const [
    checkoutBrandNameOverride,
    setCheckoutBrandNameOverride,
  ] = useState('')
  const [confirmWrite, setConfirmWrite] = useState(false)
  const [confirmNameAlignment, setConfirmNameAlignment] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmRecovery, setConfirmRecovery] = useState(false)

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
    setCarrierAccounts({
      ups_rest: next.config?.carriers.find(
        (carrier) => carrier.provider === 'ups_rest',
      )?.carrierAccountGlobalId || '',
      fedex_rest: next.config?.carriers.find(
        (carrier) => carrier.provider === 'fedex_rest',
      )?.carrierAccountGlobalId || '',
    })
    setCheckoutBrandNameOverride(next.namePreference.overrideName || '')
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
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Checkout-rating setup is unavailable',
      )
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
  const environmentCarriers = useMemo(
    () => (setup?.reference.carrierAccounts || []).filter(
      (carrier) => (
        carrier.environment === setup?.account.environment
        && carrier.accountStatus === 'active'
        && carrier.integrationStatus === 'active'
        && carrier.verificationStatus === 'verified'
      ),
    ),
    [setup],
  )
  const bindingsReady = Boolean(
    warehouseGlobalId
    && materialGlobalIds.length >= 1
    && materialGlobalIds.length <= 8
    && materialGlobalIds.every((globalId) => (
      eligibleMaterials.some((material) => material.globalId === globalId)
    ))
    && carrierAccounts.ups_rest
    && carrierAccounts.fedex_rest
  )
  const registered = setup?.config?.registrationState === 'registered'
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
    carriers: (['ups_rest', 'fedex_rest'] as const).map((provider) => ({
      provider,
      carrierAccountGlobalId: carrierAccounts[provider],
    })),
    inventoryMaxAgeSeconds: 900,
    quoteTtlSeconds: 900,
    orderReconciliationWindowSeconds: 86400,
  }, 'The exact warehouse, package, carrier, and inventory policy was saved.')

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

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        {(['ups_rest', 'fedex_rest'] as const).map((provider) => (
          <FormControl size="small" fullWidth key={provider}>
            <InputLabel id={`${provider}-${accountGlobalId}`}>
              {providerLabel(provider)} account
            </InputLabel>
            <Select
              labelId={`${provider}-${accountGlobalId}`}
              label={`${providerLabel(provider)} account`}
              value={carrierAccounts[provider]}
              disabled={Boolean(registered) || Boolean(busy)}
              onChange={(event) => setCarrierAccounts((current) => ({
                ...current,
                [provider]: event.target.value,
              }))}
            >
              {environmentCarriers
                .filter((carrier) => carrier.provider === provider)
                .map((carrier) => (
                  <MenuItem key={carrier.globalId} value={carrier.globalId}>
                    {carrier.displayName} · ••••{carrier.accountNumberLastFour}
                  </MenuItem>
                ))}
            </Select>
          </FormControl>
        ))}
      </Stack>
      <Button
        variant="contained"
        disabled={!bindingsReady || Boolean(busy) || Boolean(registered)}
        onClick={() => void saveConfig()}
      >
        {busy === 'save-config' ? 'Saving…' : 'Save exact callback setup'}
      </Button>
    </Stack>
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
        'This exact revision controls inventory freshness, cartonization, and a single whole-shipment request to each configured carrier.',
      state: stepState(
        Boolean(setup?.config),
        Boolean(connectionReady),
        Boolean(connectionReady && !bindingsReady),
      ),
      action: configAction,
    },
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
      facts: setup?.callbackUrl ? [{
        label: 'Callback URL',
        value: setup.callbackUrl,
        copyable: true,
      }] : [],
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
      key: 'evidence',
      label: 'Prove a live cart request',
      description:
        'Create a cart for Jarrett+warehouse@episcs.com. ClawPilot should retain a customer-neutral receipt, inventory-aware package plan, and whole-shipment carrier offers with zero provider writes.',
      state: stepState(
        evidenceComplete,
        Boolean(shadowRegistered),
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
      <IntegrationSetupJourney
        title={`${displayName} · live checkout shipping`}
        description="A revision-fenced setup from verified inventory and packages to one whole-shipment Shopify quote."
        steps={steps}
      />
    </Stack>
  )
}
