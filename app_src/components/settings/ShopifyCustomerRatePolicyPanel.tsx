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
const MIN_SHADOW_TEST_SUBSIDY_REASON_LENGTH = 3
const MAX_SHADOW_TEST_SUBSIDY_REASON_LENGTH = 160

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

type ShadowTestChargeMode = 'carrier_rate' | 'zero_single_service'

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
  shadowTestChargeMode: ShadowTestChargeMode
  shadowTestServiceCode: string | null
  shadowTestSubsidyReason: string | null
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
  accountEnvironment: 'mock' | 'sandbox' | 'production'
  activationState: ActivationState
  rateSource: 'sandbox' | 'production'
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
  accountEnvironment,
  activationState,
  rateSource,
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
  const [mode, setMode] = useState<CustomerRatePolicyMode>('show_all')
  const [serviceCodeInput, setServiceCodeInput] = useState('')
  const [shadowLifetimeMode, setShadowLifetimeMode] =
    useState<ShadowLifetimeMode>('timed')
  const [shadowDurationInput, setShadowDurationInput] = useState(
    String(DEFAULT_SHADOW_DURATION_MINUTES),
  )
  const [shadowTestChargeMode, setShadowTestChargeMode] =
    useState<ShadowTestChargeMode>('carrier_rate')
  const [shadowTestServiceCode, setShadowTestServiceCode] = useState('')
  const [shadowTestSubsidyReason, setShadowTestSubsidyReason] = useState('')
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
  const defaultPolicy = 'hide_all' as const
  const policyActionsAllowed = effectiveActivation !== 'missing'
  const canChangePolicies = canManage && policyActionsAllowed
  const productionTestDesiredOnly = accountEnvironment === 'production'
    && rateSource === 'sandbox'
  const testLane = rateSource === 'sandbox'
    && accountEnvironment !== 'production'
  const filteredMode = mode === 'include_only' || mode === 'exclude'
  const parsedServiceCodes = useMemo(
    () => parseServiceCodes(serviceCodeInput),
    [serviceCodeInput],
  )
  const exactCustomerGid = customerGid.trim()
  const customerGidError = exactCustomerGid.length > 0
    && !CUSTOMER_GID.test(exactCustomerGid)
  const shadowDurationMinutes = Number(shadowDurationInput)
  const shadowDurationError = testLane
    && shadowLifetimeMode === 'timed' && (
    !Number.isSafeInteger(shadowDurationMinutes)
    || shadowDurationMinutes < shadowPolicyLimits.minimumDurationMinutes
    || shadowDurationMinutes > shadowPolicyLimits.maximumDurationMinutes
  )
  const zeroChargeTestEnabled = testLane
    && shadowTestChargeMode === 'zero_single_service'
  const normalizedShadowTestServiceCode = shadowTestServiceCode.trim()
  const normalizedShadowTestSubsidyReason = shadowTestSubsidyReason.trim()
  const selectedShadowTestService = availableServices.find((service) => (
    service.shopifyServiceCode === normalizedShadowTestServiceCode
  ))
  const savedShadowTestServiceIsStillExact = Boolean(
    editingPolicy?.shadowTestServiceCode
    && editingPolicy.shadowTestServiceCode === normalizedShadowTestServiceCode,
  )
  const shadowTestServiceError = zeroChargeTestEnabled && (
    !normalizedShadowTestServiceCode
    || !SERVICE_CODE.test(normalizedShadowTestServiceCode)
    || (!selectedShadowTestService && !savedShadowTestServiceIsStillExact)
  )
  const shadowTestSubsidyReasonError = zeroChargeTestEnabled && (
    !normalizedShadowTestSubsidyReason
    || normalizedShadowTestSubsidyReason.length
      < MIN_SHADOW_TEST_SUBSIDY_REASON_LENGTH
    || normalizedShadowTestSubsidyReason.length
      > MAX_SHADOW_TEST_SUBSIDY_REASON_LENGTH
  )
  const shadowTestServicePolicyConflict = zeroChargeTestEnabled && (
    mode === 'hide_all'
    || (mode === 'include_only'
      && !parsedServiceCodes.values.includes(normalizedShadowTestServiceCode))
    || (mode === 'exclude'
      && parsedServiceCodes.values.includes(normalizedShadowTestServiceCode))
  )
  const saveDisabled = !canChangePolicies
    || Boolean(busy)
    || customerGidError
    || !exactCustomerGid
    || (filteredMode && parsedServiceCodes.values.length === 0)
    || parsedServiceCodes.errors.length > 0
    || shadowDurationError
    || shadowTestServiceError
    || shadowTestSubsidyReasonError
    || shadowTestServicePolicyConflict

  const resetEditor = useCallback((nextDefault = defaultPolicy) => {
    setCustomerGid('')
    setSelectedCustomer(null)
    setMode(recommendedMode(nextDefault))
    setServiceCodeInput('')
    setShadowLifetimeMode(shadowPolicyLimits.defaultLifetimeMode)
    setShadowDurationInput(String(
      shadowPolicyLimits.defaultDurationMinutes,
    ))
    setShadowTestChargeMode('carrier_rate')
    setShadowTestServiceCode('')
    setShadowTestSubsidyReason('')
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
    resetEditor('hide_all')
    void loadPolicies(1)
    return () => {
      policyListRequest.current?.abort()
      customerSearchRequest.current?.abort()
      exactPolicyRequest.current?.abort()
      mutationRequest.current?.abort()
    }
  }, [accountGlobalId, activationState, loadPolicies, rateSource, resetEditor])

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
    setShadowTestChargeMode(
      existing?.shadowTestChargeMode || 'carrier_rate',
    )
    setShadowTestServiceCode(existing?.shadowTestServiceCode || '')
    setShadowTestSubsidyReason(existing?.shadowTestSubsidyReason || '')
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
          shadowTestChargeMode: testLane
            ? shadowTestChargeMode
            : 'carrier_rate',
          shadowTestServiceCode: zeroChargeTestEnabled
            ? normalizedShadowTestServiceCode
            : null,
          shadowTestSubsidyReason: zeroChargeTestEnabled
            ? normalizedShadowTestSubsidyReason
            : null,
          ...(testLane
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
      const shadowTestSubsidyNotice =
        payload.policy.shadowTestChargeMode === 'zero_single_service'
          ? ' One selected service is configured at $0 for the gated TEST checkout proof. Shopify may reuse that response for about 15 minutes, so keep the Test Product isolated and turn this subsidy off immediately after submitting the test order.'
          : ''
      setNotice(
        productionTestDesiredOnly
          ? 'The desired customer policy was saved locally with zero Shopify writes. TEST remains effectively blocked for this production Shopify store, so this policy does not create a proof window or a checkout subsidy.'
          : !testLane
          ? 'The desired customer policy was saved locally with zero Shopify writes. LIVE restricted serving remains blocked until customer-specific provider enforcement is verified.'
          : payload.policy.shadowLifetimeMode === 'until_turned_off'
            ? `The customer policy was saved as a TEST proof with zero Shopify writes. It remains active until an administrator turns it off.${shadowTestSubsidyNotice}`
            : `The customer policy was saved as a timed TEST proof with zero Shopify writes. It expires ${
              payload.policy.shadowExpiresAt
                ? new Date(payload.policy.shadowExpiresAt).toLocaleString()
                : 'at the configured fail-closed boundary'
            }.${shadowTestSubsidyNotice}`,
      )
      resetEditor(defaultPolicy)
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
        resetEditor(defaultPolicy)
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
            Configure exact authenticated-customer eligibility for the saved
            Restricted checkout audience without a capped central cohort.
          </Typography>
        </Box>

        <Alert severity={effectiveActivation === 'disabled'
          || effectiveActivation === 'frozen' ? 'warning' : 'info'}>
          <strong>Restricted default · no matching policy means no ClawPilot rates.</strong>{' '}
          Desired customer policies remain editable in every Advanced safety
          mode. {effectiveActivation === 'disabled'
            || effectiveActivation === 'frozen'
            ? `${providerStateLabel(effectiveActivation)} currently pauses the effective callback with an empty response; saved policy intent remains intact.`
            : 'The effective callback still fails closed whenever Shopify omits the exact authenticated Customer GID.'}
        </Alert>

        <Alert severity="warning">
          <Stack spacing={0.75}>
            <Typography variant="body2" fontWeight={700}>
              {productionTestDesiredOnly
                ? 'TEST desired only · production Shopify store remains empty'
                : testLane
                ? 'TEST carrier source · bounded proof only'
                : 'LIVE restricted serving requires verified provider enforcement'}
            </Typography>
            <Typography variant="body2">
              {productionTestDesiredOnly
                ? 'The desired customer policy remains editable with zero Shopify writes, but TEST cannot create an effective proof lane on a production Shopify store. New authenticated callbacks remain empty, no timed proof is started, and the $0 proof subsidy is unavailable.'
                : testLane
                ? 'The saved TEST source uses a 15–240 minute proof window or Until turned off and performs zero Shopify writes. Keep the proof cart isolated because Shopify can omit Customer GID and caches successful rates without customer identity for about 15 minutes.'
                : 'Desired LIVE policies are saved locally with zero Shopify writes, but a production store returns authenticated empty rates until an eligible Delivery Customization is durably provider-verified. Callback-only customer filtering is not safe for live serving because Shopify caches successful rates without customer identity.'}
            </Typography>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label={productionTestDesiredOnly
                  ? 'Restricted · TEST blocked'
                  : testLane
                  ? 'Restricted · TEST proof'
                  : 'Restricted · LIVE blocked'}
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
              in a CarrierService callback. A missing identity, expired TEST
              window, or desired-only effective block fails closed. Guests and customers without an exact policy
              receive no ClawPilot rates under Restricted; do not call this
              deterministic live enforcement until Delivery Customization is
              provider-verified.
            </Alert>
            {testLane ? (
              <FormControl size="small" fullWidth>
                <InputLabel
                  id={`shopify-customer-policy-lifetime-${accountGlobalId}`}
                >
                  TEST proof lifetime
                </InputLabel>
                <Select
                  labelId={`shopify-customer-policy-lifetime-${accountGlobalId}`}
                  label="TEST proof lifetime"
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
            {testLane
              && shadowLifetimeMode === 'timed' ? (
              <TextField
                size="small"
                fullWidth
                type="number"
                label="TEST proof duration (minutes)"
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
            ) : testLane ? (
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
            {testLane ? (
              <Box
                sx={{
                  border: 1,
                  borderColor: zeroChargeTestEnabled
                    ? 'warning.main'
                    : 'divider',
                  borderRadius: 1,
                  p: 1.25,
                }}
              >
                <Stack spacing={1}>
                  <FormControlLabel
                    disabled={!canChangePolicies || Boolean(busy)}
                    control={(
                      <Checkbox
                        checked={zeroChargeTestEnabled}
                        onChange={(event) => {
                          setShadowTestChargeMode(event.target.checked
                            ? 'zero_single_service'
                            : 'carrier_rate')
                        }}
                      />
                    )}
                    label="Return one selected service at $0 for this test"
                  />
                  <Alert severity="warning">
                    <strong>TEST proof-only subsidy.</strong> This changes the
                    checkout charge for exactly one stable service after the
                    selected Shopify Customer GID and mapped{' '}
                    <strong>Test Product</strong> pass ClawPilot&apos;s TEST
                    proof gates. Shopify&apos;s successful-rate cache is not partitioned
                    by customer, so an identical cart and destination using
                    that Test Product could receive the cached $0 rate for
                    about 15 minutes. Keep the product test-only, use a short
                    proof window, and turn this option off immediately after
                    the test order is submitted.
                  </Alert>
                  {zeroChargeTestEnabled ? (
                    <>
                      <FormControl
                        size="small"
                        fullWidth
                        error={shadowTestServiceError}
                      >
                        <InputLabel
                          id={`shopify-shadow-test-service-${accountGlobalId}`}
                        >
                          Exact $0 test service
                        </InputLabel>
                        <Select
                          labelId={`shopify-shadow-test-service-${accountGlobalId}`}
                          label="Exact $0 test service"
                          value={shadowTestServiceCode}
                          disabled={!canChangePolicies || Boolean(busy)}
                          onChange={(event) => {
                            setShadowTestServiceCode(event.target.value)
                          }}
                        >
                          <MenuItem value="" disabled>
                            Select one retained service
                          </MenuItem>
                          {availableServices.map((service) => (
                            <MenuItem
                              key={service.shopifyServiceCode}
                              value={service.shopifyServiceCode}
                            >
                              {service.serviceName} ·{' '}
                              {providerStateLabel(service.provider)} ·{' '}
                              {service.shopifyServiceCode}
                            </MenuItem>
                          ))}
                          {savedShadowTestServiceIsStillExact
                            && !selectedShadowTestService ? (
                              <MenuItem value={normalizedShadowTestServiceCode}>
                                Saved exact service ·{' '}
                                {normalizedShadowTestServiceCode}
                              </MenuItem>
                            ) : null}
                        </Select>
                        <Typography
                          variant="caption"
                          color={shadowTestServiceError
                            ? 'error.main'
                            : 'text.secondary'}
                          sx={{ mt: 0.5, mx: 1.75 }}
                        >
                          {shadowTestServiceError
                            ? 'Select one exact stable service retained from a successful whole-shipment quote.'
                            : 'Only this exact service code is returned with a $0 checkout charge; all other eligible services retain their carrier-derived amount.'}
                        </Typography>
                      </FormControl>
                      {!availableServices.length ? (
                        <Alert severity="info">
                          No stable service is available yet. Run and retain a
                          successful whole-shipment quote before enabling the
                          $0 test charge.
                        </Alert>
                      ) : null}
                      <TextField
                        size="small"
                        fullWidth
                        multiline
                        minRows={2}
                        label="$0 test subsidy reason"
                        value={shadowTestSubsidyReason}
                        disabled={!canChangePolicies || Boolean(busy)}
                        error={shadowTestSubsidyReasonError}
                        inputProps={{
                          maxLength: MAX_SHADOW_TEST_SUBSIDY_REASON_LENGTH,
                        }}
                        helperText={shadowTestSubsidyReasonError
                          ? `Enter a reason from ${
                            MIN_SHADOW_TEST_SUBSIDY_REASON_LENGTH
                          } to ${
                            MAX_SHADOW_TEST_SUBSIDY_REASON_LENGTH
                          } characters.`
                          : `${shadowTestSubsidyReason.length}/${
                            MAX_SHADOW_TEST_SUBSIDY_REASON_LENGTH
                          } characters. This reason is retained with the tenant policy for the checkout-test audit trail.`}
                        onChange={(event) => {
                          setShadowTestSubsidyReason(event.target.value)
                        }}
                      />
                      {shadowTestServicePolicyConflict ? (
                        <Alert severity="error">
                          The selected $0 service must remain visible under the
                          customer rate policy below. Use Show all, include the
                          service in Include only, or remove it from Exclude.
                        </Alert>
                      ) : null}
                    </>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      Off · every service keeps its carrier-derived checkout
                      amount.
                    </Typography>
                  )}
                </Stack>
              </Box>
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
                const shadowTestService = availableServices.find((service) => (
                  service.shopifyServiceCode === policy.shadowTestServiceCode
                ))
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
                          label="TEST proof expired · fails closed"
                        />
                      ) : policy.shadowExpiresAt ? (
                        <Chip
                          size="small"
                          color="info"
                          variant="outlined"
                          label={`TEST proof expires ${
                            new Date(policy.shadowExpiresAt).toLocaleString()
                          }`}
                        />
                      ) : policy.shadowLifetimeMode === 'until_turned_off' ? (
                        <Chip
                          size="small"
                          color="info"
                          variant="outlined"
                          label="TEST proof · Until turned off"
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
                      <Chip
                        size="small"
                        color={policy.shadowTestChargeMode
                          === 'zero_single_service'
                          ? 'warning'
                          : 'default'}
                        variant="outlined"
                        label={policy.shadowTestChargeMode
                          === 'zero_single_service'
                          ? `TEST proof subsidy · $0 · ${
                            shadowTestService?.serviceName
                              || policy.shadowTestServiceCode
                              || 'service unavailable'
                          }`
                          : 'TEST proof subsidy · Off'}
                      />
                    </Stack>
                    {policy.shadowTestChargeMode === 'zero_single_service' ? (
                      <Typography variant="caption" color="warning.main">
                        Test-only reason: {policy.shadowTestSubsidyReason
                          || 'No reason returned'} · Turn off after the test.
                      </Typography>
                    ) : null}
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
                            Remove this exact policy? Under Restricted, this
                            customer will receive no ClawPilot rates unless a
                            new exact policy is saved.
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
