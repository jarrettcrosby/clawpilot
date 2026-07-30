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
  mutationAuthorizations: Array<{
    globalId: string
    operation: 'create' | 'delete'
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
  const [confirmWrite, setConfirmWrite] = useState(false)
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
      (
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
