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

const ENDPOINT =
  '/api/integrations/commerce/shopify/customer-rate-policies'
const CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/[1-9][0-9]*$/u
const SERVICE_CODE =
  /^clawpilot:[a-z0-9](?:[a-z0-9_-]{0,31}):[a-z0-9](?:[a-z0-9_-]{0,31})$/u
const MAX_SERVICE_CODES = 50
const DEFAULT_SHADOW_DURATION_MINUTES = 60
const MIN_SHADOW_DURATION_MINUTES = 15
const MAX_SHADOW_DURATION_MINUTES = 240

type ActivationState =
  | 'missing'
  | 'disabled'
  | 'shadow'
  | 'read_only'
  | 'active'
  | 'frozen'

type CustomerRatePolicyMode =
  | 'show_all'
  | 'hide_all'
  | 'include_only'
  | 'exclude'

type ShadowLifetimeMode = 'timed' | 'until_turned_off'

type CustomerRatePolicy = {
  globalId: string
  customerGid: string
  mode: CustomerRatePolicyMode
  serviceCodes: string[]
  status: string
  providerState: string
  lastErrorCode: string | null
  shadowLifetimeMode: ShadowLifetimeMode | null
  shadowDurationMinutes: number | null
  shadowExpiresAt: string | null
  shadowExpired: boolean
  rowVersion: number
  createdAt: string
  updatedAt: string
}

type ShopifyCustomer = {
  customerGid: string
  displayName: string
  maskedEmail: string | null
}

type AvailableService = {
  shopifyServiceCode: string
  serviceName: string
  provider: string
}

type CustomerRatePolicyEnforcement = {
  activationState: ActivationState
  providerWritesPerformed: number
  providerWriteAvailable: boolean
  state: 'shadow_simulated' | 'active_blocked' | 'inactive_blocked'
  defaultPolicy: 'hide_all' | 'show_all'
}

type PolicyPagination = {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

type CustomerSearch = {
  available?: boolean
  queried?: boolean
  query: string
  nextCursor: string | null
  hasNextPage: boolean
  errorCode?: string | null
  error?: string | null
}

type CustomerRatePolicyPayload = {
  ok?: boolean
  error?: string
  policies?: CustomerRatePolicy[]
  pagination?: PolicyPagination
  customers?: ShopifyCustomer[]
  customerSearch?: CustomerSearch
  availableServices?: AvailableService[]
  availableServicesTruncated?: boolean
  enforcement?: CustomerRatePolicyEnforcement
  summary?: {
    expiredSimulatedCount: number
    untilTurnedOffSimulatedCount: number
    earliestShadowExpiresAt: string | null
  }
  shadowPolicyLimits?: {
    defaultLifetimeMode: ShadowLifetimeMode
    supportedLifetimeModes: ShadowLifetimeMode[]
    defaultDurationMinutes: number
    minimumDurationMinutes: number
    maximumDurationMinutes: number
  }
  policy?: CustomerRatePolicy | null
  removed?: boolean
  customerGid?: string
}

type Props = {
  accountGlobalId: string
  activationState: ActivationState
  canManage: boolean
}

type ParsedServiceCodes = {
  values: string[]
  errors: string[]
}

const MODE_OPTIONS: Array<{
  value: CustomerRatePolicyMode
  label: string
  description: string
}> = [
  {
    value: 'show_all',
    label: 'Show all eligible ClawPilot services',
    description: 'This authenticated customer receives the complete eligible set.',
  },
  {
    value: 'include_only',
    label: 'Show only selected services',
    description: 'Every other ClawPilot service is hidden for this customer.',
  },
  {
    value: 'exclude',
    label: 'Hide selected services',
    description: 'The selected services are hidden; other eligible services remain.',
  },
  {
    value: 'hide_all',
    label: 'Hide every ClawPilot service',
    description: 'This authenticated customer receives no ClawPilot rate.',
  },
]

function modeLabel(mode: CustomerRatePolicyMode) {
  return MODE_OPTIONS.find((option) => option.value === mode)?.label || mode
}

function providerStateLabel(value: string) {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ''}${part.slice(1)}`)
    .join(' ')
}

function parseServiceCodes(value: string): ParsedServiceCodes {
  const normalized = value
    .split(/[,\n]+/u)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => part.startsWith('clawpilot:')
      ? part
      : `clawpilot:${part}`)
  const values = [...new Set(normalized)]
  const errors = values
    .filter((serviceCode) => !SERVICE_CODE.test(serviceCode))
    .map((serviceCode) => (
      `${serviceCode} must match clawpilot:<carrier>:<service> using lowercase letters, numbers, hyphens, or underscores.`
    ))
  if (values.length > MAX_SERVICE_CODES) {
    errors.push(
      `A customer policy can filter at most ${MAX_SERVICE_CODES} services.`,
    )
  }
  return { values, errors }
}

function recommendedMode(defaultPolicy: 'hide_all' | 'show_all'):
CustomerRatePolicyMode {
  return defaultPolicy === 'hide_all' ? 'show_all' : 'hide_all'
}

function requestWasAborted(value: unknown) {
  return value instanceof Error && value.name === 'AbortError'
}

async function responsePayload(response: Response) {
  try {
    return await response.json() as CustomerRatePolicyPayload
  } catch {
    return {} as CustomerRatePolicyPayload
  }
}

export default function ShopifyCustomerRatePolicyPanel({
  accountGlobalId,
  activationState,
  canManage,
}: Props) {
  const [policies, setPolicies] = useState<CustomerRatePolicy[]>([])
  const [pagination, setPagination] = useState<PolicyPagination>({
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
  })
  const [enforcement, setEnforcement] =
    useState<CustomerRatePolicyEnforcement | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [customerQuery, setCustomerQuery] = useState('')
  const [customerResults, setCustomerResults] = useState<ShopifyCustomer[]>([])
  const [customerSearch, setCustomerSearch] = useState<CustomerSearch>({
    available: true,
    queried: false,
    query: '',
    nextCursor: null,
    hasNextPage: false,
  })
  const [availableServices, setAvailableServices] =
    useState<AvailableService[]>([])
  const [availableServicesTruncated, setAvailableServicesTruncated] =
    useState(false)
  const [customerLabels, setCustomerLabels] = useState<
    Record<string, ShopifyCustomer>
  >({})

  const [customerGid, setCustomerGid] = useState('')
  const [selectedCustomer, setSelectedCustomer] =
    useState<ShopifyCustomer | null>(null)
  const [mode, setMode] = useState<CustomerRatePolicyMode>(
    activationState === 'active' ? 'hide_all' : 'show_all',
  )
  const [serviceCodeInput, setServiceCodeInput] = useState('')
  const [shadowLifetimeMode, setShadowLifetimeMode] =
    useState<ShadowLifetimeMode>('timed')
  const [shadowDurationInput, setShadowDurationInput] = useState(
    String(DEFAULT_SHADOW_DURATION_MINUTES),
  )
  const [shadowPolicyLimits, setShadowPolicyLimits] = useState({
    defaultLifetimeMode: 'timed' as ShadowLifetimeMode,
    supportedLifetimeModes: [
      'timed',
      'until_turned_off',
    ] as ShadowLifetimeMode[],
    defaultDurationMinutes: DEFAULT_SHADOW_DURATION_MINUTES,
    minimumDurationMinutes: MIN_SHADOW_DURATION_MINUTES,
    maximumDurationMinutes: MAX_SHADOW_DURATION_MINUTES,
  })
  const [editingPolicy, setEditingPolicy] =
    useState<CustomerRatePolicy | null>(null)
  const [pendingRemoval, setPendingRemoval] =
    useState<CustomerRatePolicy | null>(null)
  const policyListRequest = useRef<AbortController | null>(null)
  const customerSearchRequest = useRef<AbortController | null>(null)
  const exactPolicyRequest = useRef<AbortController | null>(null)
  const mutationRequest = useRef<AbortController | null>(null)

  const effectiveActivation = enforcement?.activationState || activationState
  const defaultPolicy = enforcement?.defaultPolicy
    || (effectiveActivation === 'active' ? 'show_all' : 'hide_all')
  const policyActionsAllowed = effectiveActivation === 'shadow'
    || effectiveActivation === 'active'
  const canChangePolicies = canManage && policyActionsAllowed
  const filteredMode = mode === 'include_only' || mode === 'exclude'
  const parsedServiceCodes = useMemo(
    () => parseServiceCodes(serviceCodeInput),
    [serviceCodeInput],
  )
  const exactCustomerGid = customerGid.trim()
  const customerGidError = exactCustomerGid.length > 0
    && !CUSTOMER_GID.test(exactCustomerGid)
  const shadowDurationMinutes = Number(shadowDurationInput)
  const shadowDurationError = effectiveActivation === 'shadow'
    && shadowLifetimeMode === 'timed' && (
    !Number.isSafeInteger(shadowDurationMinutes)
    || shadowDurationMinutes < shadowPolicyLimits.minimumDurationMinutes
    || shadowDurationMinutes > shadowPolicyLimits.maximumDurationMinutes
  )
  const saveDisabled = !canChangePolicies
    || Boolean(busy)
    || customerGidError
    || !exactCustomerGid
    || (filteredMode && parsedServiceCodes.values.length === 0)
    || parsedServiceCodes.errors.length > 0
    || shadowDurationError

  const resetEditor = useCallback((nextDefault = defaultPolicy) => {
    setCustomerGid('')
    setSelectedCustomer(null)
    setMode(recommendedMode(nextDefault))
    setServiceCodeInput('')
    setShadowLifetimeMode(shadowPolicyLimits.defaultLifetimeMode)
    setShadowDurationInput(String(
      shadowPolicyLimits.defaultDurationMinutes,
    ))
    setEditingPolicy(null)
  }, [
    defaultPolicy,
    shadowPolicyLimits.defaultDurationMinutes,
    shadowPolicyLimits.defaultLifetimeMode,
  ])

  const loadPolicies = useCallback(async (targetPage: number) => {
    policyListRequest.current?.abort()
    const controller = new AbortController()
    policyListRequest.current = controller
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({
        accountGlobalId,
        page: String(targetPage),
        pageSize: '25',
      })
      const response = await fetch(`${ENDPOINT}?${query.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      const payload = await responsePayload(response)
      if (
        controller.signal.aborted
        || policyListRequest.current !== controller
      ) return
      if (!response.ok || !payload.ok || !payload.policies) {
        throw new Error(
          payload.error || 'Shopify customer rate policies are unavailable',
        )
      }
      setPolicies(payload.policies)
      if (payload.pagination) setPagination(payload.pagination)
      if (payload.enforcement) setEnforcement(payload.enforcement)
      const limits = payload.shadowPolicyLimits
      if (limits) {
        setShadowPolicyLimits(limits)
      }
      setAvailableServices(payload.availableServices || [])
      setAvailableServicesTruncated(
        payload.availableServicesTruncated === true,
      )
    } catch (caught) {
      if (requestWasAborted(caught)) return
      setError(caught instanceof Error
        ? caught.message
        : 'Shopify customer rate policies are unavailable')
    } finally {
      if (policyListRequest.current === controller) {
        policyListRequest.current = null
        setLoading(false)
      }
    }
  }, [accountGlobalId])

  useEffect(() => {
    setPolicies([])
    setPagination({ page: 1, pageSize: 25, total: 0, totalPages: 1 })
    setEnforcement(null)
    setCustomerQuery('')
    setCustomerResults([])
    setCustomerSearch({
      available: true,
      queried: false,
      query: '',
      nextCursor: null,
      hasNextPage: false,
    })
    setAvailableServices([])
    setAvailableServicesTruncated(false)
    setCustomerLabels({})
    setPendingRemoval(null)
    setBusy('')
    setError('')
    setNotice('')
    resetEditor(activationState === 'active' ? 'show_all' : 'hide_all')
    void loadPolicies(1)
    return () => {
      policyListRequest.current?.abort()
      customerSearchRequest.current?.abort()
      exactPolicyRequest.current?.abort()
      mutationRequest.current?.abort()
    }
  }, [accountGlobalId, activationState, loadPolicies, resetEditor])

  const runCustomerSearch = async (append = false) => {
    const search = customerQuery.trim()
    if (!search) {
      customerSearchRequest.current?.abort()
      customerSearchRequest.current = null
      setBusy('')
      setCustomerResults([])
      setCustomerSearch({
        available: true,
        queried: false,
        query: '',
        nextCursor: null,
        hasNextPage: false,
      })
      return
    }
    customerSearchRequest.current?.abort()
    const controller = new AbortController()
    customerSearchRequest.current = controller
    setBusy('search')
    setError('')
    try {
      const body: Record<string, unknown> = {
        action: 'search',
        accountGlobalId,
        search,
        customerPageSize: 25,
      }
      if (append && customerSearch.nextCursor) {
        body.customerCursor = customerSearch.nextCursor
      }
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      const payload = await responsePayload(response)
      if (
        controller.signal.aborted
        || customerSearchRequest.current !== controller
      ) return
      if (
        !response.ok
        || !payload.ok
        || !payload.customers
        || !payload.customerSearch
      ) {
        throw new Error(payload.error || 'Shopify customer search failed')
      }
      const customers = payload.customers
      const nextCustomerSearch = payload.customerSearch
      setCustomerSearch(nextCustomerSearch)
      if (nextCustomerSearch.available === false) {
        setCustomerResults([])
        return
      }
      setCustomerLabels((current) => {
        const next = { ...current }
        for (const customer of customers) {
          next[customer.customerGid] = customer
        }
        return next
      })
      setCustomerResults((current) => append
        ? [
            ...current,
            ...customers.filter((candidate) => (
              !current.some((customer) => (
                customer.customerGid === candidate.customerGid
              ))
            )),
          ]
        : customers)
    } catch (caught) {
      if (requestWasAborted(caught)) return
      setError(caught instanceof Error
        ? caught.message
        : 'Shopify customer search failed')
    } finally {
      if (customerSearchRequest.current === controller) {
        customerSearchRequest.current = null
        setBusy('')
      }
    }
  }

  const populateEditor = (
    customer: ShopifyCustomer | null,
    existing: CustomerRatePolicy | null,
    targetCustomerGid: string,
  ) => {
    setSelectedCustomer(customer)
    setCustomerGid(targetCustomerGid)
    setEditingPolicy(existing)
    setMode(existing?.mode || recommendedMode(defaultPolicy))
    setServiceCodeInput(existing?.serviceCodes.join('\n') || '')
    setShadowLifetimeMode(
      existing?.shadowLifetimeMode
        || shadowPolicyLimits.defaultLifetimeMode,
    )
    setShadowDurationInput(String(
      existing?.shadowDurationMinutes
        ?? shadowPolicyLimits.defaultDurationMinutes,
    ))
    setNotice('')
  }

  const selectCustomer = async (customer: ShopifyCustomer) => {
    exactPolicyRequest.current?.abort()
    exactPolicyRequest.current = null
    const existing = policies.find(
      (policy) => policy.customerGid === customer.customerGid,
    )
    setCustomerLabels((current) => ({
      ...current,
      [customer.customerGid]: customer,
    }))
    if (existing) {
      setBusy('')
      populateEditor(customer, existing, customer.customerGid)
      return
    }

    const controller = new AbortController()
    exactPolicyRequest.current = controller
    setBusy('lookup')
    setError('')
    setNotice('')
    setSelectedCustomer(customer)
    setCustomerGid('')
    setEditingPolicy(null)
    try {
      const query = new URLSearchParams({
        accountGlobalId,
        customerGid: customer.customerGid,
      })
      const response = await fetch(`${ENDPOINT}?${query.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      const payload = await responsePayload(response)
      if (
        controller.signal.aborted
        || exactPolicyRequest.current !== controller
      ) return
      if (
        !response.ok
        || !payload.ok
        || !Object.prototype.hasOwnProperty.call(payload, 'policy')
      ) {
        throw new Error(
          payload.error || 'The exact customer policy could not be loaded',
        )
      }
      populateEditor(
        customer,
        payload.policy || null,
        customer.customerGid,
      )
    } catch (caught) {
      if (requestWasAborted(caught)) return
      setError(caught instanceof Error
        ? caught.message
        : 'The exact customer policy could not be loaded')
    } finally {
      if (exactPolicyRequest.current === controller) {
        exactPolicyRequest.current = null
        setBusy('')
      }
    }
  }

  const editPolicy = (policy: CustomerRatePolicy) => {
    populateEditor(
      customerLabels[policy.customerGid] || null,
      policy,
      policy.customerGid,
    )
    setPendingRemoval(null)
  }

  const savePolicy = async () => {
    if (saveDisabled) return
    mutationRequest.current?.abort()
    const controller = new AbortController()
    mutationRequest.current = controller
    setBusy('save')
    setError('')
    setNotice('')
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          action: 'upsert',
          accountGlobalId,
          customerGid: exactCustomerGid,
          mode,
          serviceCodes: filteredMode ? parsedServiceCodes.values : [],
          ...(effectiveActivation === 'shadow'
            ? {
                shadowLifetimeMode,
                ...(shadowLifetimeMode === 'timed'
                  ? { shadowDurationMinutes }
                  : {}),
              }
            : {}),
          ...(editingPolicy
            ? { expectedRowVersion: editingPolicy.rowVersion }
            : {}),
        }),
      })
      const payload = await responsePayload(response)
      if (
        controller.signal.aborted
        || mutationRequest.current !== controller
      ) return
      if (!response.ok || !payload.ok || !payload.policy) {
        throw new Error(payload.error || 'Customer rate policy was not saved')
      }
      if (payload.enforcement) setEnforcement(payload.enforcement)
      setNotice(
        payload.enforcement?.state === 'active_blocked'
          ? 'The customer policy was saved in ClawPilot. Shopify provider enforcement remains blocked and no live checkout option was changed.'
          : payload.policy.shadowLifetimeMode === 'until_turned_off'
            ? 'The customer policy was saved as a Shadow simulation with zero Shopify writes. It remains active until an administrator turns it off.'
            : `The customer policy was saved as a timed Shadow simulation with zero Shopify writes. It expires ${
              payload.policy.shadowExpiresAt
                ? new Date(payload.policy.shadowExpiresAt).toLocaleString()
                : 'at the configured fail-closed boundary'
            }.`,
      )
      resetEditor(payload.enforcement?.defaultPolicy || defaultPolicy)
      await loadPolicies(pagination.page)
    } catch (caught) {
      if (requestWasAborted(caught)) return
      setError(caught instanceof Error
        ? caught.message
        : 'Customer rate policy was not saved')
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null
        setBusy('')
      }
    }
  }

  const removePolicy = async () => {
    if (!pendingRemoval || !canChangePolicies) return
    mutationRequest.current?.abort()
    const controller = new AbortController()
    mutationRequest.current = controller
    setBusy('remove')
    setError('')
    setNotice('')
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          action: 'remove',
          accountGlobalId,
          customerGid: pendingRemoval.customerGid,
          expectedRowVersion: pendingRemoval.rowVersion,
        }),
      })
      const payload = await responsePayload(response)
      if (
        controller.signal.aborted
        || mutationRequest.current !== controller
      ) return
      if (!response.ok || !payload.ok || payload.removed !== true) {
        throw new Error(payload.error || 'Customer rate policy was not removed')
      }
      if (payload.enforcement) setEnforcement(payload.enforcement)
      const targetPage = policies.length === 1 && pagination.page > 1
        ? pagination.page - 1
        : pagination.page
      setPendingRemoval(null)
      if (editingPolicy?.customerGid === payload.customerGid) {
        resetEditor(payload.enforcement?.defaultPolicy || defaultPolicy)
      }
      setNotice(
        'The per-customer override was removed. This customer now receives the checkout default when authenticated.',
      )
      await loadPolicies(targetPage)
    } catch (caught) {
      if (requestWasAborted(caught)) return
      setError(caught instanceof Error
        ? caught.message
        : 'Customer rate policy was not removed')
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null
        setBusy('')
      }
    }
  }

  return (
    <Box
      component="section"
      aria-labelledby={`shopify-checkout-audience-${accountGlobalId}`}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1.25, p: 1.5 }}
    >
      <Stack spacing={1.5}>
        <Box>
          <Typography
            id={`shopify-checkout-audience-${accountGlobalId}`}
            variant="subtitle1"
            fontWeight={700}
          >
            Checkout audience
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Set the default ClawPilot-rate audience and authenticated-customer
            overrides without building a capped central customer cohort.
          </Typography>
        </Box>

        <Alert severity={effectiveActivation === 'active'
          ? 'success'
          : effectiveActivation === 'shadow'
            ? 'info'
            : 'warning'}>
          {effectiveActivation === 'shadow' ? (
            <>
              <strong>Shadow default · hide ClawPilot rates.</strong>{' '}
              Guests and authenticated customers without an explicit policy
              receive this default. A selected, signed-in Shopify customer is
              explicit local proof intent only: Shopify does not guarantee that
              a CarrierService callback contains Customer GID, so a callback
              without that identity fails closed with no ClawPilot rates.
            </>
          ) : effectiveActivation === 'active' ? (
            <>
              <strong>Active default · show all eligible ClawPilot rates.</strong>{' '}
              This default includes guest checkouts and authenticated customers
              without an override. A customer policy can hide all, include
              only, or exclude specific ClawPilot services.
            </>
          ) : (
            <>
              <strong>Checkout default unavailable.</strong>{' '}
              Operations mode is {providerStateLabel(effectiveActivation)}.
              Existing customer policies are review-only until the exact
              organization returns to Shadow or Active.
            </>
          )}
        </Alert>

        <Alert severity="warning">
          <Stack spacing={0.75}>
            <Typography variant="body2" fontWeight={700}>
              {!policyActionsAllowed
                ? 'Provider enforcement unavailable'
                : enforcement?.state === 'active_blocked'
                ? 'Provider enforcement blocked'
                : 'Provider enforcement simulated only'}
            </Typography>
            <Typography variant="body2">
              In Shadow, an administrator chooses either a 15–240 minute local
              test window or Until turned off. Both perform zero Shopify writes.
              Shopify can omit
              Customer GID from CarrierService callbacks, and its successful
              rate cache is customer-neutral. Saved-address warming is only a
              bounded, isolated allowlisted test-variant proof—not
              deterministic customer
              enforcement. An eligible, deployed, and provider-verified
              Delivery Customization is required before customer-specific
              visibility or per-service filtering can be called live.
            </Typography>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label={!policyActionsAllowed
                  ? `${providerStateLabel(effectiveActivation)} · changes disabled`
                  : enforcement?.state === 'active_blocked'
                  ? 'Active · Shopify write blocked'
                  : 'Shadow · simulated'}
              />
              <Chip
                size="small"
                variant="outlined"
                label={`${enforcement?.providerWritesPerformed || 0} Shopify writes`}
              />
              <Chip
                size="small"
                variant="outlined"
                label={enforcement?.providerWriteAvailable
                  ? 'Provider write available'
                  : 'Provider write unavailable'}
              />
            </Stack>
          </Stack>
        </Alert>

        {!canManage ? (
          <Alert severity="info">
            Owner or authorized administrator permission is required to save
            or remove customer checkout-rate policies.
          </Alert>
        ) : null}
        {!policyActionsAllowed ? (
          <Alert severity="warning">
            Customer policy changes are unavailable while Operations mode is{' '}
            <strong>{providerStateLabel(effectiveActivation)}</strong>. Add,
            edit, and remove actions require the exact organization to be in
            Shadow or Active. Existing policies remain visible for review.
          </Alert>
        ) : null}
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

        <Box>
          <Typography variant="subtitle2" fontWeight={700}>
            Find a Shopify customer
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Search Shopify by customer name, email, or exact Customer GID.
            Policies are stored one per Shopify customer, so ClawPilot imposes
            no customer-count cap. Search uses the raw value only for the
            provider request; ClawPilot returns masked email labels.
          </Typography>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ mt: 1 }}
          >
            <TextField
              size="small"
              fullWidth
              label="Customer name, email, or Shopify Customer GID"
              value={customerQuery}
              disabled={busy !== '' && busy !== 'search'}
              onChange={(event) => {
                customerSearchRequest.current?.abort()
                setCustomerQuery(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void runCustomerSearch(false)
                }
              }}
            />
            <Button
              variant="outlined"
              disabled={!customerQuery.trim() || Boolean(busy)}
              onClick={() => void runCustomerSearch(false)}
            >
              {busy === 'search' ? 'Searching…' : 'Search customers'}
            </Button>
          </Stack>
          {customerSearch.available === false ? (
            <Alert severity="warning" sx={{ mt: 1 }}>
              Shopify customer search is unavailable
              {customerSearch.error ? `: ${customerSearch.error}` : '.'}{' '}
              You can still enter an exact Shopify Customer GID below.
            </Alert>
          ) : null}
          {customerResults.length ? (
            <Stack spacing={0.75} sx={{ mt: 1 }}>
              {customerResults.map((customer) => (
                <Box
                  key={customer.customerGid}
                  sx={{
                    display: 'flex',
                    flexDirection: { xs: 'column', sm: 'row' },
                    alignItems: { xs: 'stretch', sm: 'center' },
                    justifyContent: 'space-between',
                    gap: 1,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                    px: 1,
                    py: 0.75,
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700}>
                      {customer.displayName || 'Unnamed Shopify customer'}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', overflowWrap: 'anywhere' }}
                    >
                      {customer.maskedEmail || 'No email'} ·{' '}
                      {customer.customerGid}
                    </Typography>
                  </Box>
                  <Button
                    size="small"
                    disabled={!canChangePolicies || Boolean(busy)}
                    onClick={() => void selectCustomer(customer)}
                  >
                    Select
                  </Button>
                </Box>
              ))}
              {customerSearch.hasNextPage ? (
                <Button
                  size="small"
                  disabled={Boolean(busy)}
                  onClick={() => void runCustomerSearch(true)}
                >
                  Load more Shopify customers
                </Button>
              ) : null}
            </Stack>
          ) : customerSearch.query && busy !== 'search' ? (
            <Typography variant="caption" color="text.secondary">
              No Shopify customers matched “{customerSearch.query}”.
            </Typography>
          ) : null}
        </Box>

        <Box>
          <Typography variant="subtitle2" fontWeight={700}>
            {editingPolicy ? 'Edit customer policy' : 'Add customer policy'}
          </Typography>
          {selectedCustomer ? (
            <Chip
              size="small"
              color="primary"
              variant="outlined"
              sx={{ mt: 0.75 }}
              label={`${selectedCustomer.displayName || 'Shopify customer'}${
                selectedCustomer.maskedEmail
                  ? ` · ${selectedCustomer.maskedEmail}`
                  : ''
              }`}
            />
          ) : null}
          <Stack spacing={1} sx={{ mt: 1 }}>
            <TextField
              size="small"
              fullWidth
              label="Shopify Customer GID"
              value={customerGid}
              error={customerGidError}
              disabled={!canChangePolicies || Boolean(busy)}
              placeholder="gid://shopify/Customer/1234567890"
              helperText={customerGidError
                ? 'Use the exact gid://shopify/Customer/<numeric-id> value.'
                : 'The Customer GID identifies the Shopify customer record; an email address is not accepted as the saved policy key.'}
              onChange={(event) => {
                setCustomerGid(event.target.value)
                setSelectedCustomer(null)
                setEditingPolicy(null)
              }}
            />
            <Alert severity="info">
              This local rule can match only when Shopify supplies the exact
              authenticated Customer GID. Shopify does not guarantee that fact
              in a CarrierService callback. A missing identity or an expired
              Shadow window fails closed. Guests receive the default; do not
              treat device-to-device behavior as deterministic customer
              enforcement until Delivery Customization is provider-verified.
            </Alert>
            {effectiveActivation === 'shadow' ? (
              <FormControl size="small" fullWidth>
                <InputLabel
                  id={`shopify-customer-policy-lifetime-${accountGlobalId}`}
                >
                  Shadow lifetime
                </InputLabel>
                <Select
                  labelId={`shopify-customer-policy-lifetime-${accountGlobalId}`}
                  label="Shadow lifetime"
                  value={shadowLifetimeMode}
                  disabled={!canChangePolicies || Boolean(busy)}
                  onChange={(event) => {
                    setShadowLifetimeMode(
                      event.target.value as ShadowLifetimeMode,
                    )
                  }}
                >
                  {shadowPolicyLimits.supportedLifetimeModes.includes('timed')
                    ? (
                      <MenuItem value="timed">Timed proof window</MenuItem>
                    )
                    : null}
                  {shadowPolicyLimits.supportedLifetimeModes.includes(
                    'until_turned_off',
                  ) ? (
                    <MenuItem value="until_turned_off">
                      Until turned off
                    </MenuItem>
                  ) : null}
                </Select>
              </FormControl>
            ) : null}
            {effectiveActivation === 'shadow'
              && shadowLifetimeMode === 'timed' ? (
              <TextField
                size="small"
                fullWidth
                type="number"
                label="Shadow proof duration (minutes)"
                value={shadowDurationInput}
                disabled={!canChangePolicies || Boolean(busy)}
                error={shadowDurationError}
                inputProps={{
                  min: shadowPolicyLimits.minimumDurationMinutes,
                  max: shadowPolicyLimits.maximumDurationMinutes,
                  step: 1,
                  inputMode: 'numeric',
                }}
                helperText={shadowDurationError
                  ? `Enter a whole number from ${
                    shadowPolicyLimits.minimumDurationMinutes
                  } to ${shadowPolicyLimits.maximumDurationMinutes}.`
                  : `Defaults to ${
                    shadowPolicyLimits.defaultDurationMinutes
                  } minutes. Saving or renewing starts a new bounded window; expiration fails closed.`}
                onChange={(event) => {
                  setShadowDurationInput(event.target.value)
                }}
              />
            ) : effectiveActivation === 'shadow' ? (
              <Alert severity="warning">
                Until turned off has no automatic expiry. The exact Customer
                GID and test-variant gates still apply, every Shopify write
                remains blocked, and an administrator must edit or remove this
                policy to turn it off. Shopify may reuse a previously
                successful rate response for up to 15 minutes after the policy
                changes, so disabling the policy is not an immediate cache
                purge.
              </Alert>
            ) : null}
            <FormControl size="small" fullWidth>
              <InputLabel id={`shopify-customer-policy-mode-${accountGlobalId}`}>
                Customer rate policy
              </InputLabel>
              <Select
                labelId={`shopify-customer-policy-mode-${accountGlobalId}`}
                label="Customer rate policy"
                value={mode}
                disabled={!canChangePolicies || Boolean(busy)}
                onChange={(event) => {
                  setMode(event.target.value as CustomerRatePolicyMode)
                }}
              >
                {MODE_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="caption" color="text.secondary">
              {MODE_OPTIONS.find((option) => option.value === mode)?.description}
            </Typography>
            {filteredMode && availableServices.length ? (
              <Box>
                <Typography variant="body2" fontWeight={700}>
                  Services from successful quotes
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Select stable Shopify service codes retained from successful
                  whole-shipment checkout quotes for this account.
                </Typography>
                <Stack sx={{ mt: 0.5 }}>
                  {availableServices.map((service) => (
                    <FormControlLabel
                      key={service.shopifyServiceCode}
                      disabled={!canChangePolicies || Boolean(busy)}
                      control={(
                        <Checkbox
                          size="small"
                          checked={parsedServiceCodes.values.includes(
                            service.shopifyServiceCode,
                          )}
                          onChange={(event) => {
                            const current = parsedServiceCodes.values
                            const next = event.target.checked
                              ? [...new Set([
                                  ...current,
                                  service.shopifyServiceCode,
                                ])]
                              : current.filter((serviceCode) => (
                                  serviceCode !== service.shopifyServiceCode
                                ))
                            setServiceCodeInput(next.join('\n'))
                          }}
                        />
                      )}
                      label={`${service.serviceName} · ${
                        providerStateLabel(service.provider)
                      } · ${service.shopifyServiceCode}`}
                    />
                  ))}
                </Stack>
              </Box>
            ) : null}
            {filteredMode && !availableServices.length ? (
              <Alert severity="info">
                No stable service suggestions are available yet. They appear
                after this account retains its first successful whole-shipment
                checkout quote; use advanced entry below if you already know
                the exact code.
              </Alert>
            ) : null}
            {filteredMode && availableServicesTruncated ? (
              <Alert severity="warning">
                The suggestion list is truncated to 100 retained services.
                Use advanced entry below for any valid code not shown.
              </Alert>
            ) : null}
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={3}
              label="Advanced ClawPilot service-code entry"
              value={serviceCodeInput}
              disabled={
                !canChangePolicies || !filteredMode || Boolean(busy)
              }
              error={filteredMode && parsedServiceCodes.errors.length > 0}
              placeholder={'clawpilot:ups:ground\nclawpilot:fedex:home_delivery'}
              helperText={filteredMode
                ? parsedServiceCodes.errors[0]
                  || 'Enter comma- or newline-separated codes. Values are trimmed, lowercased, de-duplicated, and normalized to clawpilot:<carrier>:<service>. Up to 50 services may be filtered per customer.'
                : 'Service codes are not used for Show all or Hide all.'}
              onChange={(event) => setServiceCodeInput(event.target.value)}
            />
            {filteredMode ? (
              <Typography variant="caption" color="text.secondary">
                Available stable codes appear in retained checkout evidence
                after the first successful whole-shipment quote. Examples:{' '}
                <code>clawpilot:ups:ground</code> and{' '}
                <code>clawpilot:fedex:home_delivery</code>.
              </Typography>
            ) : null}
            {filteredMode && parsedServiceCodes.values.length > 0
              && !parsedServiceCodes.errors.length ? (
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                  {parsedServiceCodes.values.map((serviceCode) => (
                    <Chip
                      key={serviceCode}
                      size="small"
                      variant="outlined"
                      label={serviceCode}
                    />
                  ))}
                </Stack>
              ) : null}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Button
                variant="contained"
                disabled={saveDisabled}
                onClick={() => void savePolicy()}
              >
                {busy === 'save'
                  ? 'Saving policy…'
                  : editingPolicy
                    ? 'Save customer policy'
                    : 'Add customer policy'}
              </Button>
              {(customerGid || editingPolicy) ? (
                <Button
                  variant="text"
                  disabled={Boolean(busy)}
                  onClick={() => resetEditor()}
                >
                  Cancel
                </Button>
              ) : null}
            </Stack>
          </Stack>
        </Box>

        <Box>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            justifyContent="space-between"
            spacing={1}
          >
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>
                Saved customer policies
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {pagination.total} saved override{pagination.total === 1 ? '' : 's'}.
                There is no customer-count cap.
              </Typography>
            </Box>
            {loading ? (
              <CircularProgress
                size={20}
                aria-label="Loading Shopify customer rate policies"
              />
            ) : null}
          </Stack>
          {!loading && policies.length === 0 ? (
            <Alert severity="info" sx={{ mt: 1 }}>
              No customer overrides are saved. Every checkout receives the
              current default policy.
            </Alert>
          ) : (
            <Stack spacing={1} sx={{ mt: 1 }}>
              {policies.map((policy) => {
                const customerLabel = customerLabels[policy.customerGid]
                return (
                  <Box
                  key={policy.globalId}
                  sx={{
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                    p: 1,
                  }}
                >
                  <Stack spacing={0.75}>
                    {customerLabel ? (
                      <Box>
                        <Typography variant="body2" fontWeight={700}>
                          {customerLabel.displayName || 'Shopify customer'}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block', overflowWrap: 'anywhere' }}
                        >
                          {customerLabel.maskedEmail
                            ? `${customerLabel.maskedEmail} · `
                            : ''}
                          {policy.customerGid}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          display="block"
                        >
                          Provider-fetched display label only; the exact GID is
                          the policy key, and this label is not persisted.
                        </Typography>
                      </Box>
                    ) : (
                      <Typography
                        variant="body2"
                        fontWeight={700}
                        sx={{ overflowWrap: 'anywhere' }}
                      >
                        {policy.customerGid}
                      </Typography>
                    )}
                    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                      <Chip
                        size="small"
                        color="primary"
                        variant="outlined"
                        label={modeLabel(policy.mode)}
                      />
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`Local · ${providerStateLabel(policy.status)}`}
                      />
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label={`Shopify · ${providerStateLabel(policy.providerState)}`}
                      />
                      {policy.shadowExpired ? (
                        <Chip
                          size="small"
                          color="error"
                          variant="outlined"
                          label="Shadow expired · fails closed"
                        />
                      ) : policy.shadowExpiresAt ? (
                        <Chip
                          size="small"
                          color="info"
                          variant="outlined"
                          label={`Shadow expires ${
                            new Date(policy.shadowExpiresAt).toLocaleString()
                          }`}
                        />
                      ) : policy.shadowLifetimeMode === 'until_turned_off' ? (
                        <Chip
                          size="small"
                          color="info"
                          variant="outlined"
                          label="Shadow · Until turned off"
                        />
                      ) : null}
                      {policy.lastErrorCode ? (
                        <Chip
                          size="small"
                          color="error"
                          variant="outlined"
                          label={policy.lastErrorCode}
                        />
                      ) : null}
                    </Stack>
                    {policy.serviceCodes.length ? (
                      <Typography variant="caption" color="text.secondary">
                        {policy.serviceCodes.join(', ')}
                      </Typography>
                    ) : null}
                    <Typography variant="caption" color="text.secondary">
                      Updated {new Date(policy.updatedAt).toLocaleString()} · row{' '}
                      {policy.rowVersion}
                    </Typography>
                    {pendingRemoval?.globalId === policy.globalId ? (
                      <Alert severity="warning">
                        <Stack spacing={1}>
                          <Typography variant="body2">
                            Remove this override? The authenticated customer
                            will receive the {defaultPolicy === 'hide_all'
                              ? 'Shadow hide-all'
                              : 'Active show-all'} default.
                          </Typography>
                          <Stack direction="row" spacing={1}>
                            <Button
                              size="small"
                              color="error"
                              variant="contained"
                              disabled={!canChangePolicies || busy === 'remove'}
                              onClick={() => void removePolicy()}
                            >
                              {busy === 'remove' ? 'Removing…' : 'Confirm remove'}
                            </Button>
                            <Button
                              size="small"
                              disabled={busy === 'remove'}
                              onClick={() => setPendingRemoval(null)}
                            >
                              Keep policy
                            </Button>
                          </Stack>
                        </Stack>
                      </Alert>
                    ) : (
                      <Stack direction="row" spacing={1}>
                        <Button
                          size="small"
                          disabled={!canChangePolicies || Boolean(busy)}
                          onClick={() => editPolicy(policy)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          disabled={!canChangePolicies || Boolean(busy)}
                          onClick={() => setPendingRemoval(policy)}
                        >
                          Remove
                        </Button>
                      </Stack>
                    )}
                  </Stack>
                  </Box>
                )
              })}
            </Stack>
          )}
          {pagination.totalPages > 1 ? (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              justifyContent="flex-end"
              sx={{ mt: 1 }}
            >
              <Button
                size="small"
                disabled={loading || pagination.page <= 1}
                onClick={() => void loadPolicies(pagination.page - 1)}
              >
                Previous
              </Button>
              <Typography variant="caption" color="text.secondary">
                Page {pagination.page} of {pagination.totalPages}
              </Typography>
              <Button
                size="small"
                disabled={loading || pagination.page >= pagination.totalPages}
                onClick={() => void loadPolicies(pagination.page + 1)}
              >
                Next
              </Button>
            </Stack>
          ) : null}
        </Box>
      </Stack>
    </Box>
  )
}
