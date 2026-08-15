'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddBusinessRounded from '@mui/icons-material/AddBusinessRounded'
import EditLocationAltRounded from '@mui/icons-material/EditLocationAltRounded'
import PublishedWithChangesRounded from '@mui/icons-material/PublishedWithChangesRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'

type LocationMutation = 'locationAdd' | 'locationEdit' | 'locationActivate'

type AdministrationMapping = {
  globalId: string
  rowVersion: number
  warehouseGlobalId: string
}

type AdministrationWarehouse = {
  globalId: string
  code: string
  name: string
  rowVersion: number
  canAddToShopify: boolean
  addConfirmationStatement: string | null
  desiredLocation: {
    name: string
    address: {
      address1: string
      address2: string
      city: string
      provinceCode: string
      countryCode: string
      zip: string
    }
  } | null
}

type AdministrationProviderLocation = {
  id: string
  name: string
  isActive: boolean
  isFulfillmentService: boolean
  fulfillmentService: {
    serviceName: string
  } | null
  readOnly: boolean
  readOnlyReason: string | null
  mapping: AdministrationMapping | null
  allowedActions: LocationMutation[]
  editConfirmationStatement: string | null
  activateConfirmationStatement: string | null
}

type PendingAuthorization = {
  authorizationGlobalId: string
  attemptGlobalId: string | null
  action: LocationMutation
  status: 'prepared' | 'processing' | 'unknown'
  warehouseGlobalId: string
  providerLocationId: string | null
  idempotencyKey: string
}

type AdministrationState = {
  runtime: {
    available: boolean
    providerWritesEnabled: boolean
  }
  account: {
    displayName: string
    shopName: string
    shopDomain: string
    partnerDevelopment: true
  }
  providerLocations: AdministrationProviderLocation[]
  warehouses: AdministrationWarehouse[]
  pendingAuthorizations: PendingAuthorization[]
}

type AdministrationPayload = {
  ok?: boolean
  error?: string
  code?: string
  outcomeUncertain?: boolean
  providerMutationAttempted?: boolean
  state?: AdministrationState
  result?: {
    authorization?: {
      authorizationGlobalId?: string
      status?: string
      action?: LocationMutation
    }
    providerLocationId?: string | null
    mappingRequired?: boolean
    outcomeUncertain?: boolean
    reconcileRequired?: boolean
    confirmedApplied?: boolean
  }
}

type AdministrationIntent = {
  mutation: LocationMutation
  warehouse: AdministrationWarehouse
  mapping: AdministrationMapping | null
  providerLocation: AdministrationProviderLocation | null
  confirmationStatement: string
  reason: string
  idempotencyKey: string
}

class AdministrationRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly outcomeUncertain: boolean,
    readonly providerMutationAttempted: boolean,
  ) {
    super(message)
    this.name = 'AdministrationRequestError'
  }
}

function administrationIdempotencyKey() {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `shopify-location-admin:${suffix}`
}

function actionLabel(action: LocationMutation) {
  if (action === 'locationAdd') return 'Add to Shopify'
  if (action === 'locationEdit') return 'Update in Shopify'
  return 'Activate in Shopify'
}

function addressLabel(warehouse: AdministrationWarehouse) {
  const address = warehouse.desiredLocation?.address
  if (!address) return ''
  return [
    address.address1,
    address.address2,
    address.city,
    address.provinceCode,
    address.zip,
    address.countryCode,
  ].filter(Boolean).join(', ')
}

async function payload(response: Response) {
  try {
    return await response.json() as AdministrationPayload
  } catch {
    return {} as AdministrationPayload
  }
}

export default function ShopifyLocationAdministrationPanel({
  accountGlobalId,
  onProviderLocationsChanged,
}: {
  accountGlobalId: string
  onProviderLocationsChanged: () => Promise<void> | void
}) {
  const [state, setState] = useState<AdministrationState | null>(null)
  const [available, setAvailable] = useState(false)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [intent, setIntent] = useState<AdministrationIntent | null>(null)
  const [typedConfirmation, setTypedConfirmation] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const loadState = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ accountGlobalId })
    const response = await fetch(
      `/api/integrations/commerce/shopify/location-administration?${query}`,
      { cache: 'no-store', signal },
    )
    const body = await payload(response)
    if (
      !response.ok
      || !body.state
      || body.state.runtime.available !== true
      || body.state.runtime.providerWritesEnabled !== true
    ) {
      // This proving lane is deliberately invisible outside its exact
      // development runtime, allowlist, account, and operator authority.
      setState(null)
      setAvailable(false)
      return null
    }
    setState(body.state)
    setAvailable(true)
    return body.state
  }, [accountGlobalId])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setState(null)
    setAvailable(false)
    setOpen(false)
    setIntent(null)
    setTypedConfirmation('')
    setNotice('')
    setError('')
    loadState(controller.signal)
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          return
        }
        setState(null)
        setAvailable(false)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [loadState])

  const warehousesByGlobalId = useMemo(() => new Map(
    (state?.warehouses || []).map((warehouse) => [
      warehouse.globalId,
      warehouse,
    ]),
  ), [state?.warehouses])

  const eligibleWarehouses = (state?.warehouses || []).filter(
    (warehouse) => warehouse.canAddToShopify === true,
  )

  function startAdd(warehouse: AdministrationWarehouse) {
    if (
      warehouse.canAddToShopify !== true
      || !warehouse.addConfirmationStatement
    ) return
    setError('')
    setNotice('')
    setTypedConfirmation('')
    setIntent({
      mutation: 'locationAdd',
      warehouse,
      mapping: null,
      providerLocation: null,
      confirmationStatement: warehouse.addConfirmationStatement,
      reason: 'Create this reviewed ClawPilot warehouse in the Shopify development store.',
      idempotencyKey: administrationIdempotencyKey(),
    })
  }

  function startLocationAction(
    location: AdministrationProviderLocation,
    mutation: 'locationEdit' | 'locationActivate',
  ) {
    if (!location.allowedActions.includes(mutation) || !location.mapping) {
      return
    }
    const warehouse = warehousesByGlobalId.get(
      location.mapping.warehouseGlobalId,
    )
    const confirmationStatement = mutation === 'locationEdit'
      ? location.editConfirmationStatement
      : location.activateConfirmationStatement
    if (
      !warehouse
      || !confirmationStatement
      || location.readOnly
      || location.isFulfillmentService
    ) return
    setError('')
    setNotice('')
    setTypedConfirmation('')
    setIntent({
      mutation,
      warehouse,
      mapping: location.mapping,
      providerLocation: location,
      confirmationStatement,
      reason: mutation === 'locationEdit'
        ? 'Align this Shopify development-store location with its mapped ClawPilot warehouse.'
        : 'Activate this reviewed Shopify development-store location for fulfillment.',
      idempotencyKey: administrationIdempotencyKey(),
    })
  }

  async function post(
    body: Record<string, unknown>,
    localIdempotencyKey: string,
  ) {
    const response = await fetch(
      '/api/integrations/commerce/shopify/location-administration',
      {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': localIdempotencyKey,
        },
        body: JSON.stringify(body),
      },
    )
    const result = await payload(response)
    if (!response.ok || !result.ok) {
      throw new AdministrationRequestError(
        result.error || 'The Shopify location request could not be completed.',
        result.code || 'SHOPIFY_LOCATION_ADMINISTRATION_FAILED',
        response.status,
        result.outcomeUncertain === true,
        result.providerMutationAttempted === true,
      )
    }
    return result
  }

  async function refreshAfterApplied(
    action: LocationMutation,
    providerLocationId: string | null,
  ) {
    let refreshFailed = false
    try {
      // Reload the provider discovery shown in the Phase A routing table
      // before refreshing this administration-only view.
      await onProviderLocationsChanged()
    } catch {
      refreshFailed = true
    }
    try {
      await loadState()
    } catch {
      refreshFailed = true
    }
    if (refreshFailed) {
      setNotice(
        action === 'locationAdd'
          ? 'Shopify confirmed the new location, but the location table could not reload. Refresh this page, then choose Map existing; no mapping was created automatically.'
          : 'Shopify confirmed the location update, but the location table could not reload. Refresh this page to see it.',
      )
      return
    }
    setNotice(
      action === 'locationAdd'
        ? providerLocationId
          ? 'Shopify created the location. In the location table, choose Map existing to connect it to ClawPilot; no mapping was created automatically.'
          : 'Shopify reported that the location was created without returning its ID. Refresh the page and verify Shopify before taking another action; no mapping was created automatically.'
        : 'The Shopify development-store location was updated.',
    )
  }

  async function executeAuthorization(input: {
    authorizationGlobalId: string
    idempotencyKey: string
    action: LocationMutation
  }) {
    let dispatchStarted = false
    try {
      dispatchStarted = true
      const executed = await post({
        action: 'execute',
        authorizationGlobalId: input.authorizationGlobalId,
      }, input.idempotencyKey)
      const result = executed.result
      const status = result?.authorization?.status
      if (
        result?.outcomeUncertain
        || status === 'unknown'
        || status === 'processing'
      ) {
        setIntent(null)
        setTypedConfirmation('')
        setNotice(
          'Shopify did not return a final outcome. Do not repeat this change; use Check Shopify result when it becomes available.',
        )
        await loadState().catch(() => null)
        return
      }
      if (status !== 'succeeded' && status !== 'reconciled') {
        setIntent(null)
        setTypedConfirmation('')
        setError('Shopify rejected the location change. No automatic retry was made.')
        await loadState().catch(() => null)
        return
      }
      setIntent(null)
      setTypedConfirmation('')
      await refreshAfterApplied(
        input.action,
        result?.providerLocationId || null,
      )
    } catch (caught) {
      const uncertain = dispatchStarted && (
        !(caught instanceof AdministrationRequestError)
        || caught.outcomeUncertain
        || caught.providerMutationAttempted
      )
      if (uncertain) {
        setIntent(null)
        setTypedConfirmation('')
        setNotice(
          'The Shopify outcome is unknown. Do not retry this change. Reload the saved attempt and use read-only reconciliation.',
        )
        await loadState().catch(() => null)
        return
      }
      setError(
        caught instanceof Error
          ? caught.message
          : 'The Shopify location request could not be completed.',
      )
    }
  }

  async function applyIntent() {
    if (
      !intent
      || busy
      || typedConfirmation !== intent.confirmationStatement
      || intent.reason.trim().length < 10
    ) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const prepareBody: Record<string, unknown> = {
        action: 'prepare',
        accountGlobalId,
        mutation: intent.mutation,
        warehouseGlobalId: intent.warehouse.globalId,
        expectedWarehouseRowVersion: intent.warehouse.rowVersion,
        reason: intent.reason.trim(),
        confirmationStatement: intent.confirmationStatement,
      }
      if (intent.mapping) {
        prepareBody.mappingGlobalId = intent.mapping.globalId
        prepareBody.expectedMappingRowVersion = intent.mapping.rowVersion
      }
      const prepared = await post(prepareBody, intent.idempotencyKey)
      const authorizationGlobalId =
        prepared.result?.authorization?.authorizationGlobalId
      if (!authorizationGlobalId) {
        throw new AdministrationRequestError(
          'Shopify location authorization was not returned.',
          'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
          502,
          false,
          false,
        )
      }
      await executeAuthorization({
        authorizationGlobalId,
        idempotencyKey: intent.idempotencyKey,
        action: intent.mutation,
      })
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The Shopify location request could not be prepared.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function resumePrepared(pending: PendingAuthorization) {
    if (busy || pending.status !== 'prepared') return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await executeAuthorization({
        authorizationGlobalId: pending.authorizationGlobalId,
        idempotencyKey: pending.idempotencyKey,
        action: pending.action,
      })
    } finally {
      setBusy(false)
    }
  }

  async function reconcile(pending: PendingAuthorization) {
    if (busy || pending.status !== 'unknown' || !pending.attemptGlobalId) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const reconciled = await post({
        action: 'reconcile',
        attemptGlobalId: pending.attemptGlobalId,
      }, pending.idempotencyKey)
      if (reconciled.result?.confirmedApplied !== true) {
        setNotice(
          'Shopify did not provide positive proof that the change applied. The attempt remains unknown and must not be retried.',
        )
        await loadState().catch(() => null)
        return
      }
      await refreshAfterApplied(
        pending.action,
        reconciled.result.providerLocationId || null,
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The Shopify result could not be reconciled.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (loading || !available || !state) return null

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<StorefrontRounded />}
        onClick={() => setOpen(true)}
        sx={{ minHeight: 36, flexShrink: 0 }}
      >
        Manage Shopify locations
      </Button>

      <Dialog
        open={open}
        onClose={busy ? undefined : () => setOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Shopify locations</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              spacing={1}
            >
              <Box>
                <Typography fontWeight={700}>{state.account.shopName}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {state.account.shopDomain}
                </Typography>
              </Box>
              <Chip size="small" label="Development store" color="info" />
            </Stack>

            {error ? <Alert severity="error">{error}</Alert> : null}
            {notice ? <Alert severity="info">{notice}</Alert> : null}

            {state.pendingAuthorizations.length ? (
              <Stack spacing={1}>
                <Typography variant="subtitle2">Saved changes</Typography>
                {state.pendingAuthorizations.map((pending) => (
                  <Stack
                    key={pending.authorizationGlobalId}
                    direction={{ xs: 'column', sm: 'row' }}
                    justifyContent="space-between"
                    alignItems={{ sm: 'center' }}
                    spacing={1}
                  >
                    <Box>
                      <Typography variant="body2" fontWeight={700}>
                        {actionLabel(pending.action)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {pending.status === 'prepared'
                          ? 'Prepared; Shopify has not been changed.'
                          : pending.status === 'processing'
                            ? 'Awaiting a final provider outcome. Do not retry.'
                            : 'Outcome unknown. Only a read-only check is allowed.'}
                      </Typography>
                    </Box>
                    {pending.status === 'prepared' ? (
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={busy}
                        onClick={() => { void resumePrepared(pending) }}
                      >
                        Apply prepared change
                      </Button>
                    ) : pending.status === 'unknown' ? (
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={busy || !pending.attemptGlobalId}
                        startIcon={<PublishedWithChangesRounded />}
                        onClick={() => { void reconcile(pending) }}
                      >
                        Check Shopify result
                      </Button>
                    ) : (
                      <Chip size="small" label="Processing" />
                    )}
                  </Stack>
                ))}
                <Divider />
              </Stack>
            ) : null}

            {eligibleWarehouses.length ? (
              <Stack spacing={1}>
                <Typography variant="subtitle2">
                  Add a ClawPilot warehouse to Shopify
                </Typography>
                {eligibleWarehouses.map((warehouse) => (
                  <Stack
                    key={warehouse.globalId}
                    direction={{ xs: 'column', sm: 'row' }}
                    justifyContent="space-between"
                    alignItems={{ sm: 'center' }}
                    spacing={1}
                  >
                    <Box>
                      <Typography variant="body2" fontWeight={700}>
                        {warehouse.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {warehouse.code} · {addressLabel(warehouse)}
                      </Typography>
                    </Box>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<AddBusinessRounded />}
                      disabled={busy}
                      onClick={() => startAdd(warehouse)}
                    >
                      Add to Shopify
                    </Button>
                  </Stack>
                ))}
                <Divider />
              </Stack>
            ) : null}

            <Stack spacing={1}>
              <Typography variant="subtitle2">Store locations</Typography>
              {state.providerLocations.map((location) => {
                const locationReadOnly = location.readOnly
                  || location.isFulfillmentService
                return (
                  <Stack
                    key={location.id}
                    direction={{ xs: 'column', sm: 'row' }}
                    justifyContent="space-between"
                    alignItems={{ sm: 'center' }}
                    spacing={1}
                  >
                    <Box>
                      <Stack
                        direction="row"
                        spacing={0.75}
                        alignItems="center"
                      >
                        <Typography variant="body2" fontWeight={700}>
                          {location.name}
                        </Typography>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={locationReadOnly
                            ? 'Fulfillment service · read only'
                            : location.isActive ? 'Active' : 'Inactive'}
                        />
                      </Stack>
                      {locationReadOnly ? (
                        <Typography variant="caption" color="text.secondary">
                          {location.fulfillmentService?.serviceName
                            || location.readOnlyReason
                            || 'Managed by another app'}
                        </Typography>
                      ) : null}
                    </Box>
                    {!locationReadOnly && location.allowedActions.length ? (
                      <Stack direction="row" spacing={0.75}>
                        {location.allowedActions.includes('locationEdit') ? (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<EditLocationAltRounded />}
                            disabled={busy}
                            onClick={() => startLocationAction(
                              location,
                              'locationEdit',
                            )}
                          >
                            Update in Shopify
                          </Button>
                        ) : null}
                        {location.allowedActions.includes('locationActivate')
                          ? (
                            <Button
                              size="small"
                              variant="outlined"
                              disabled={busy}
                              onClick={() => startLocationAction(
                                location,
                                'locationActivate',
                              )}
                            >
                              Activate in Shopify
                            </Button>
                          )
                          : null}
                      </Stack>
                    ) : null}
                  </Stack>
                )
              })}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(intent)}
        onClose={busy ? undefined : () => setIntent(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{intent ? actionLabel(intent.mutation) : ''}</DialogTitle>
        <DialogContent dividers>
          {intent ? (
            <Stack spacing={2}>
              {error ? <Alert severity="error">{error}</Alert> : null}
              <Box>
                <Typography variant="body2" fontWeight={700}>
                  {intent.providerLocation?.name || intent.warehouse.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {intent.warehouse.name} · {addressLabel(intent.warehouse)}
                </Typography>
              </Box>
              <TextField
                label="Reason"
                value={intent.reason}
                disabled={busy}
                multiline
                minRows={2}
                onChange={(event) => setIntent({
                  ...intent,
                  reason: event.target.value,
                })}
              />
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Type this exact authorization
                </Typography>
                <Typography
                  variant="body2"
                  component="code"
                  display="block"
                  sx={{ mt: 0.5, overflowWrap: 'anywhere' }}
                >
                  {intent.confirmationStatement}
                </Typography>
              </Box>
              <TextField
                label="Confirmation"
                value={typedConfirmation}
                disabled={busy}
                autoComplete="off"
                onChange={(event) => setTypedConfirmation(event.target.value)}
              />
              <Typography variant="caption" color="text.secondary">
                ClawPilot first preserves the exact warehouse, mapping, and
                Shopify location versions, then applies this one change.
              </Typography>
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setIntent(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={
              busy
              || !intent
              || typedConfirmation !== intent.confirmationStatement
              || intent.reason.trim().length < 10
            }
            startIcon={busy ? <CircularProgress size={15} /> : undefined}
            onClick={() => { void applyIntent() }}
          >
            {busy ? 'Applying…' : 'Authorize and apply'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
